#!/usr/bin/env bash
# 一键安装 / 更新 Coopanion 桌宠（Linux 版）
#
# Coopanion（https://github.com/Pal-AI-Lab/Coopanion）是 AGPL-3.0-or-later，属强 copyleft。
# 因此按本仓库既有惯例放在 third-party/ 下 —— 该目录已被根 .gitignore 忽略，不进入版本库。
# 本脚本把源码、子模块、依赖、构建产物准备好，并把本仓库的桌宠改造补丁打上去，可重复运行。
#
# 用法：
#   ./tools/setup-coopanion.sh              # 安装（已存在则只补齐）
#   ./tools/setup-coopanion.sh -u           # 更新源码后重装、重构建
#   ./tools/setup-coopanion.sh -r           # 装完直接启动
#   ./tools/setup-coopanion.sh -u -r
#
# 环境变量：
#   COOPANION_DIR    安装目录，默认 <仓库根>/third-party/Coopanion
#   ELECTRON_MIRROR  Electron 二进制镜像，默认 https://npmmirror.com/mirrors/electron/
#
# 运行要求：Linux x64、Node.js >= 22、pnpm、git，能访问 GitHub 与 npm 源。
#
# 桌面环境注意：
#   * 需要 X11（Wayland 会话下走 XWayland）。Coopanion 启动时自己加 `--ozone-platform=x11`，
#     因为 Wayland 不允许窗口自己摆位置、也不能常驻置顶，而桌宠正是靠这两点活着。
#   * 没有可用 GPU 的机器（虚拟机、部分驱动）靠 SwiftShader 软件渲染，应用已自带该开关；
#     小鲸鱼是用 WebGL 画的，没有它就只有声音没有身体。
#   * 托盘图标要有 StatusNotifier/AppIndicator 宿主（GNOME 需装 AppIndicator 扩展）。
#     没有托盘也能用：右键桌宠本身有菜单，暂停/设置/退出都在里面。
set -euo pipefail

UPDATE=0
RUN=0
DIR=""

usage() {
  sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    -u|--update) UPDATE=1 ;;
    -r|--run) RUN=1 ;;
    -d|--dir) shift; DIR="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1（-h 看用法）" >&2; exit 2 ;;
  esac
  shift
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$HERE")"
[ -n "$DIR" ] || DIR="${COOPANION_DIR:-$REPO_ROOT/third-party/Coopanion}"
mkdir -p "$(dirname "$DIR")"
DIR="$(cd "$(dirname "$DIR")" && pwd)/$(basename "$DIR")"

PATCH="$REPO_ROOT/patches/coopanion/0001-dsh-pet-features.patch"
# 补丁是针对这个 tag 生成的，源码漂移会让它整段打不上，所以钉死。
COOPANION_TAG='v0.1.20'
# v0.1.20 需要新版 Cortico（Translation / LanguageTable 等新 API），commit 一并钉死。
CORTICO_COMMIT='f9449842a8ed93cfc0e3fd5a554e00c2aa5973f5'

step() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf '  [OK] %s\n' "$1"; }
warn() { printf '  [!]  %s\n' "$1"; }

step '检查环境'
for cmd in git node pnpm; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "缺少 $cmd，请先安装（Node.js >= 22 与 pnpm）" >&2; exit 1; }
done
ok "git  $(git --version)"
ok "node $(node --version)"
ok "pnpm $(pnpm --version)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || warn "Coopanion 要求 Node >= 22，当前是 $(node --version)"

if [ ! -f "$DIR/package.json" ]; then
  step "克隆 Coopanion 到 $DIR"
  git clone --depth 1 --branch "$COOPANION_TAG" https://github.com/Pal-AI-Lab/Coopanion.git "$DIR"
  ok "源码已克隆（$COOPANION_TAG）"
elif [ "$UPDATE" = 1 ]; then
  step "更新源码到 $COOPANION_TAG（含子模块）"
  git -C "$DIR" fetch --depth 1 origin tag "$COOPANION_TAG"
  git -C "$DIR" checkout -f "$COOPANION_TAG"
  ok "源码已更新到 $COOPANION_TAG"
else
  warn "已存在：$DIR（如需更新请加 -u）"
fi

step '初始化子模块 vendor/cortico（Cortico 框架）'
git -C "$DIR" submodule update --init --depth 1 vendor/cortico
git -C "$DIR/vendor/cortico" fetch --depth 1 origin "$CORTICO_COMMIT" \
  && git -C "$DIR/vendor/cortico" checkout -q --detach "$CORTICO_COMMIT"
ok '子模块就绪'

step '安装依赖（pnpm install）'
# Electron 二进制上百 MB，默认走国内镜像；要官方源就把 ELECTRON_MIRROR 设成空再跑
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
pnpm --dir "$DIR" install
ok '依赖安装完成'

step '确保 Electron 二进制就位'
# pnpm 10+ 默认**阻止依赖的 postinstall 脚本**（安全特性），electron 的下载脚本不会自动跑，
# 直接启动会报 "Electron failed to install correctly"。这里手动跑一次 install.js。
# 注意：`pnpm rebuild electron` 同样受该策略限制，直接执行 install.js 最可靠。
if [ ! -x "$DIR/node_modules/electron/dist/electron" ]; then
  INSTALL_JS="$DIR/node_modules/electron/install.js"
  [ -f "$INSTALL_JS" ] || { echo "找不到 $INSTALL_JS —— 先跑一次 pnpm install" >&2; exit 1; }
  warn 'Electron 二进制缺失，正在下载（走镜像）...'
  ( cd "$DIR/node_modules/electron" && node install.js )
  [ -x "$DIR/node_modules/electron/dist/electron" ] || { echo 'Electron 二进制仍缺失' >&2; exit 1; }
fi
ok 'Electron 二进制就绪'

step '应用本仓库的桌宠改造补丁'
if [ ! -f "$PATCH" ]; then
  warn "没找到补丁：$PATCH（跳过）"
elif git -C "$DIR" apply --reverse --check "$PATCH" >/dev/null 2>&1; then
  ok '补丁已经应用过了'
elif git -C "$DIR" apply --check "$PATCH" >/dev/null 2>&1; then
  git -C "$DIR" apply "$PATCH"
  ok '补丁已应用（调试入口按钮 / 随刷新率走动 / 开机自启不弹窗）'
else
  warn '补丁打不上 —— 上游源码可能已经变了'
  warn "请看 docs/coopanion-integration.md，必要时用 -u 更新后重试，或手动改 ${PATCH} 里的对应文件"
fi

step '构建（pnpm run build:cortico）'
# 这一步把 console/ 覆盖到 build/cortico，并重打包控制台页面与桌宠面板；
# 「随刷新率」这个新走动模式在控制台「习惯」页里，必须重新构建才会出现。
pnpm --dir "$DIR" run build:cortico
ok '构建完成'

step '完成'
echo "  安装位置 : $DIR"
echo "  启动命令 : pnpm --dir \"$DIR\" start"
echo "  数据目录 : $DIR/build/data（记忆/设置/日志都在这里，重装不丢）"
echo "  退出方式 : 右键托盘图标 -> 退出（关设置窗口不会退出程序）"
echo "  调试界面 : http://127.0.0.1:17788/  或右键桌宠 -> 菜单里的设置"
echo "  开机自启 : ./tools/coopanion-autostart.sh"

if [ "$RUN" = 1 ]; then
  step '启动 Coopanion'
  EXE="$DIR/node_modules/electron/dist/electron"
  [ -x "$EXE" ] || { echo "找不到 electron：$EXE（先跑一次 pnpm install）" >&2; exit 1; }
  ( cd "$DIR" && "$EXE" . >/dev/null 2>&1 & )
  ok '已启动 —— 桌宠出现在屏幕底边，托盘区有它的图标'
fi
