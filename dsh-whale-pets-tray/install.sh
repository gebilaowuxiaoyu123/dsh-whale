#!/usr/bin/env bash
# ============================================================================
#  dsh-whale-pets-tray / install.sh —— 安装 GNOME 顶栏桌宠控制图标
#
#  用法：
#    bash dsh-whale-pets-tray/install.sh            # 安装并启用
#    bash dsh-whale-pets-tray/install.sh --uninstall
#    bash dsh-whale-pets-tray/install.sh --status
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="dsh-whale-pets@local"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; N=$'\033[0m'

case "${1:-}" in
  --uninstall)
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rf "$DEST"
    echo "${G}✅ 已卸载 $UUID${N}"
    exit 0 ;;
  --status)
    echo "  安装位置: $DEST $([ -d "$DEST" ] && echo '（存在）' || echo '（不存在）')"
    echo "  扩展列表: $(gnome-extensions list 2>/dev/null | grep -c "$UUID") 个匹配"
    echo "  启用状态: $(gnome-extensions info "$UUID" 2>/dev/null | awk -F': ' '/State/{print $2}')"
    echo "  Shell 版本: $(gnome-shell --version 2>/dev/null)"
    exit 0 ;;
esac

command -v gnome-extensions >/dev/null || { echo "${R}找不到 gnome-extensions（这是 GNOME 桌面专用的）${N}"; exit 1; }
echo "  目标: $DEST"
mkdir -p "$DEST"
cp -f "$HERE/extension.js" "$HERE/metadata.json" "$DEST/"
[[ -f "$HERE/stylesheet.css" ]] && cp -f "$HERE/stylesheet.css" "$DEST/"
[[ -f "$HERE/README.md" ]] && cp -f "$HERE/README.md" "$DEST/"
echo "${G}✅ 文件已复制${N}"

# 语法自检（GNOME Shell 的 ESM 扩展没法用 node --check 完整校验，这里只查常见笔误）
if command -v gjs >/dev/null 2>&1; then
  if gjs -c "imports.gi" >/dev/null 2>&1; then :; fi
fi

if gnome-extensions list 2>/dev/null | grep -q "^$UUID$"; then
  gnome-extensions enable "$UUID" 2>/dev/null || true
  sleep 1
  state="$(gnome-extensions info "$UUID" 2>/dev/null | awk -F': ' '/State/{print $2}')"
  echo "  启用状态: ${state:-未知}"
  case "$state" in
    ENABLED|ACTIVE) echo "${G}✅ 已启用，顶栏右侧应该出现 🐋 图标${N}" ;;
    *)
      cat <<EOF
${Y}⚠️  已安装但未激活。注销重新登录后再试（Wayland 下不能原地重启 Shell）。${N}
   重登后自检： bash $HERE/install.sh --status
EOF
      ;;
  esac
elif [[ -f "$DEST/metadata.json" ]]; then
  # 关键认知：GNOME Shell 只在**启动时**扫描扩展目录，`gnome-extensions list`
  # 走的是 Shell 的 D-Bus 接口 → 新装的扩展在重新登录前根本不会出现在列表里。
  # 这不是安装失败，所以不能报错退出（早期版本在这里误报 ❌，浪费时间）。
  cat <<EOF
${G}✅ 文件已安装到 $DEST${N}
${Y}⏭  需要**注销并重新登录**（Wayland 会话无法原地重启 GNOME Shell）。${N}
   重登后执行：
     gnome-extensions enable $UUID
     bash $HERE/install.sh --status
   看有没有加载成功：
     journalctl -f -o cat /usr/bin/gnome-shell | grep -i dsh
EOF
else
  echo "${R}❌ 安装不完整：$DEST/metadata.json 不存在${N}"
  exit 1
fi

cat <<EOF

  用法：点顶栏 🐋 → 看到两个桌宠状态（● 运行中 / ○ 已停）→ 点条目即「开 / 关」
  另含：🔄 刷新状态、🐋 打开鲸鱼娘装扮页（会把 Live2D 桌宠拉起来再开控制台）
  卸妆：bash $HERE/install.sh --uninstall
EOF
