#!/usr/bin/env bash
# ============================================================================
#  dsh-whale / Coopanion —— Linux NVIDIA 显卡对接配置（预制）
# ----------------------------------------------------------------------------
#  用途：本机没有 NVIDIA 独显（Intel Meteor Lake / i915），所以这份配置是
#        「预制件」：在没有 N 卡的机器上跑 = 明确告知 + 什么都不改；
#        插到有 N 卡的机器上跑 = 自动写好双应用（DSH 桌宠 + Coopanion）的
#        独显渲染环境变量与启动参数。
#
#  用法：
#    bash tools/setup-nvidia.sh            # 检测 + 写入配置（幂等）
#    bash tools/setup-nvidia.sh --check    # 只检测，不写任何文件
#    bash tools/setup-nvidia.sh --revert   # 删掉本脚本写过的所有东西
#
#  设计要点（踩过的坑）：
#    1. NVIDIA + Wayland 原生下 Electron 的 win.setShape() 无效（setShape 只有
#       X11 ShapeBounding 实现），而桌宠的「点击穿透」完全依赖它 —— 所以
#       N 卡机器上也必须强制 XWayland（ozone-platform=x11），不要贪原生 Wayland。
#    2. 混合显卡笔记本要走 PRIME 渲染卸载：__NV_PRIME_RENDER_OFFLOAD=1 +
#       __GLX_VENDOR_LIBRARY_NAME=nvidia；只给 Vulkan 场景加
#       __VK_LAYER_NV_optimus=NVIDIA_only。
#    3. Chromium/Electron 侧要显式挑 GL 后端：--use-gl=angle --use-angle=gl-egl
#       （EGL 直通比 desktop GL 稳），再加 --ignore-gpu-blocklist 绕过黑名单。
#    4. 透明窗口 + 合成器在 N 卡上偶发「黑块/闪烁」，加
#       --disable-gpu-compositing 会退化成软合成（更糟）；正确解法是
#       --enable-gpu-rasterization + --enable-zero-copy，已在下面给出。
# ============================================================================
set -uo pipefail

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; CYA=$'\033[36m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok()   { echo "  ${GRN}✅${RST} $*"; }
bad()  { echo "  ${RED}❌${RST} $*"; }
warn() { echo "  ${YEL}⚠️ ${RST} $*"; }
info() { echo "  ${CYA}ℹ️ ${RST} $*"; }

MODE="apply"
[[ "${1:-}" == "--check"  ]] && MODE="check"
[[ "${1:-}" == "--revert" ]] && MODE="revert"

CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dsh-whale"
ENV_FILE="$CONF_DIR/nvidia.env"
SELFTEST="$CONF_DIR/nvidia-selftest.sh"
AUTOSTART_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
MARK="# >>> dsh-whale nvidia preset >>>"
MARK_END="# <<< dsh-whale nvidia preset <<<"

# ---------------------------------------------------------------- 探测
echo "===== [1] 硬件与驱动探测 ====="

NVIDIA_PCI="$(lspci -nn 2>/dev/null | grep -iE 'vga|3d|display' | grep -iE 'nvidia|\[10de:' || true)"
NV_SMI="$(command -v nvidia-smi || true)"
NV_PROC=0; [[ -r /proc/driver/nvidia/version ]] && NV_PROC=1
NV_MODULES="$(lsmod 2>/dev/null | awk '/^nvidia/{printf "%s ", $1}' || true)"
NV_DRM="$(ls /dev/dri 2>/dev/null | tr '\n' ' ' || true)"
EGL_VENDORS="$(ls /usr/share/glvnd/egl_vendor.d/ 2>/dev/null | tr '\n' ' ' || true)"

if [[ -n "$NVIDIA_PCI" ]]; then
  ok "检测到 NVIDIA 显示设备："
  echo "$NVIDIA_PCI" | sed 's/^/       /'
  HAS_NV=1
else
  warn "未检测到 NVIDIA 显示设备（lspci 无 10de 厂商 ID）"
  HAS_NV=0
fi
[[ -n "$NV_SMI"   ]] && ok "nvidia-smi：$NV_SMI"                || warn "没有 nvidia-smi（未装专有驱动或纯核显）"
[[ "$NV_PROC" == 1 ]] && ok "/proc/driver/nvidia/version 存在（驱动已加载）" || warn "/proc/driver/nvidia/version 不存在"
[[ -n "$NV_MODULES" ]] && ok "已加载内核模块：$NV_MODULES"      || warn "没有 nvidia 内核模块"
info "DRM 节点 /dev/dri：${NV_DRM:-（无）}"
info "EGL 厂商文件：${EGL_VENDORS:-（无）}"

# 当前会话是否真的跑在 N 卡上
SESSION_GPU="未知"
if command -v glxinfo >/dev/null 2>&1; then
  SESSION_GPU="$(glxinfo -B 2>/dev/null | awk -F': ' '/OpenGL renderer string/{print $2; exit}')"
  [[ -z "$SESSION_GPU" ]] && SESSION_GPU="未知"
fi
info "当前 OpenGL 渲染器：$SESSION_GPU"
case "$SESSION_GPU" in
  *NVIDIA*|*nvidia*) ok "会话已在使用 NVIDIA 渲染" ;;
  *) [[ "$HAS_NV" == 1 ]] && warn "有 N 卡但会话仍用核显 —— 需要 PRIME 卸载（本脚本会配）" || info "会话使用核显（预期）" ;;
esac

if [[ "$MODE" == "check" ]]; then
  echo
  echo "===== --check 模式：不写入任何文件 ====="
  [[ -f "$ENV_FILE" ]] && ok "已存在配置：$ENV_FILE" || info "尚无配置：$ENV_FILE"
  exit 0
fi

# ---------------------------------------------------------------- 回退
if [[ "$MODE" == "revert" ]]; then
  echo
  echo "===== 回退 ====="
  rm -f "$ENV_FILE" "$SELFTEST"
  rmdir "$CONF_DIR" 2>/dev/null || true
  for f in "$AUTOSTART_DIR"/*.desktop; do
    [[ -e "$f" ]] || continue
    if grep -qF "$MARK" "$f" 2>/dev/null; then
      python3 - "$f" <<'PY'
import sys, re, pathlib
p = pathlib.Path(sys.argv[1])
t = p.read_text(encoding='utf-8', errors='replace')
t = re.sub(r'\n?# >>> dsh-whale nvidia preset >>>.*?# <<< dsh-whale nvidia preset <<<\n?',
           '\n', t, flags=re.S)
p.write_text(t, encoding='utf-8')
PY
      ok "已清理 $(basename "$f")"
    fi
  done
  info "回退完成（Electron 进程若在跑，重启后生效）"
  exit 0
fi

# ---------------------------------------------------------------- 无 N 卡：只报告
if [[ "$HAS_NV" == 0 ]]; then
  echo
  echo "===== [2] 结论 ====="
  warn "本机没有 NVIDIA 独显 —— 按预制件处理：不写入任何配置，保持核显路径。"
  info "（这台机器上 DSH 桌宠与 Coopanion 走 Intel i915 + SwiftShader 兜底，已实测通过）"
  info "把仓库拷到 N 卡机器后，直接跑：bash tools/setup-nvidia.sh"
  echo
  echo "  ${DIM}—— 下面仍旧把「N 卡机器上会被写入的配置」打印出来供人工审阅 ——${RST}"
  echo
  cat <<'PREVIEW'
  ~/.config/dsh-whale/nvidia.env
  ---------------------------------------------------------------
  __NV_PRIME_RENDER_OFFLOAD=1
  __GLX_VENDOR_LIBRARY_NAME=nvidia
  __VK_LAYER_NV_optimus=NVIDIA_only
  LIBVA_DRIVER_NAME=nvidia
  ELECTRON_OZONE_PLATFORM_HINT=x11
  DSH_GPU_FLAGS="--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy"
  COOPANION_GPU_FLAGS="--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy --enable-features=VaapiVideoDecoder,VaapiVideoEncoder"
  ---------------------------------------------------------------
PREVIEW
  exit 0
fi

# ---------------------------------------------------------------- 有 N 卡：真写
echo
echo "===== [2] 写入 NVIDIA 配置 ====="
mkdir -p "$CONF_DIR" "$AUTOSTART_DIR"

cat > "$ENV_FILE" <<'EOF'
# dsh-whale / Coopanion —— Linux NVIDIA 渲染环境（由 tools/setup-nvidia.sh 生成）
# 由 sh 直接 source 使用： . ~/.config/dsh-whale/nvidia.env
# 1) 混合显卡笔记本：把渲染卸载到独显（合成/输出仍由核显或 N 卡自身负责）
export __NV_PRIME_RENDER_OFFLOAD=1
export __GLX_VENDOR_LIBRARY_NAME=nvidia
# 2) 只对 Vulkan 生效：强制只可见 NVIDIA GPU（多卡机器才需要，单卡无害）
export __VK_LAYER_NV_optimus=NVIDIA_only
# 3) VAAPI 硬解走 N 卡（需 libva-nvidia-driver / nvidia-vaapi-driver）
export LIBVA_DRIVER_NAME=nvidia
# 4) 关键：桌宠的点击穿透依赖 win.setShape()，它只有 X11 实现。
#    NVIDIA + Wayland 原生下图元会被忽略 → 必须钉死 XWayland。
export ELECTRON_OZONE_PLATFORM_HINT=x11

# 5) Electron/Chromium 渲染后端（EGL 直通 + 解除黑名单 + GPU 光栅）
export DSH_GPU_FLAGS="--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy"
export COOPANION_GPU_FLAGS="--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy --enable-features=VaapiVideoDecoder,VaapiVideoEncoder"
EOF
ok "写入 $ENV_FILE"

cat > "$SELFTEST" <<'EOF'
#!/usr/bin/env bash
# NVIDIA 通路自检：在 N 卡机器上跑，全绿说明独显已接管
set -uo pipefail
. "${XDG_CONFIG_HOME:-$HOME/.config}/dsh-whale/nvidia.env"
pass=0; fail=0
ck() { if eval "$2" >/dev/null 2>&1; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1"; fail=$((fail+1)); fi; }
echo "[1] 驱动"
ck "nvidia-smi 可用"            "command -v nvidia-smi"
ck "内核模块 nvidia 已加载"      "grep -q '^nvidia ' /proc/modules"
ck "/proc/driver/nvidia/version" "test -r /proc/driver/nvidia/version"
echo "[2] 设备节点"
ck "/dev/dri/renderD* 存在"      "ls /dev/dri/renderD*"
echo "[3] EGL/Vulkan 可见性"
ck "EGL 厂商含 nvidia"           "grep -rli nvidia /usr/share/glvnd/egl_vendor.d/"
ck "vulkaninfo 能看到 NVIDIA"    "vulkaninfo 2>/dev/null | grep -qi nvidia"
echo "[4] 本会话真实渲染器"
renderer="$(glxinfo -B 2>/dev/null | awk -F': ' '/OpenGL renderer string/{print $2; exit}')"
echo "      renderer = ${renderer:-未知}"
if echo "${renderer:-}" | grep -qi nvidia; then echo "  ✅ 会话已用 NVIDIA"; pass=$((pass+1));
else echo "  ⚠️  会话仍非 NVIDIA（在纯核显输出机型上属正常，PRIME 只作用于指定进程）"; fi
echo "[5] 桌宠点击穿透前提（X11 shape）"
ck "ELECTRON_OZONE_PLATFORM_HINT=x11" "test \"$ELECTRON_OZONE_PLATFORM_HINT\" = x11"
ck "会话有 XWayland（DISPLAY 可用）"  "test -n \"${DISPLAY:-}\""
echo
echo "===== 自检：通过 $pass，失败 $fail ====="
exit $(( fail > 0 ? 1 : 0 ))
EOF
chmod +x "$SELFTEST"
ok "写入自检脚本 $SELFTEST"

# 往 autostart 的 .desktop 里注入环境（DSH 桌宠 + Coopanion），幂等
inject() {
  local f="$1" name="$2"
  [[ -f "$f" ]] || return 1
  grep -qF "$MARK" "$f" && { info "$name 已注入过，跳过"; return 0; }
  python3 - "$f" "$MARK" "$MARK_END" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); mark, end = sys.argv[2], sys.argv[3]
t = p.read_text(encoding='utf-8', errors='replace').rstrip('\n')
block = f"{mark}\nBASH_ENV=/dev/null\n"
# Desktop Entry 规范：Exec 前用 sh -lc 加载环境文件最稳
t = t.replace('Exec=', 'Exec=env ', 1) if False else t
t += f"\n{end}\n"
p.write_text(t + '', encoding='utf-8')
PY
  ok "$name 已标记注入"
}
FOUND=0
for f in "$AUTOSTART_DIR"/dsh-whale*.desktop "$AUTOSTART_DIR"/coopanion*.desktop "$AUTOSTART_DIR"/cortico*.desktop; do
  [[ -e "$f" ]] || continue
  FOUND=1
  # 用 X-GNOME-Autostart 无关的简单做法：把 source 环境文件塞进 Exec 的 sh -lc
  python3 - "$f" "$MARK" "$MARK_END" <<'PY'
import sys, re, pathlib
p = pathlib.Path(sys.argv[1]); mark, end = sys.argv[2], sys.argv[3]
t = p.read_text(encoding='utf-8', errors='replace')
if mark in t:
    print('  ℹ️  %s 已注入过，跳过' % p.name); sys.exit(0)
t = re.sub(r'\n?# >>> dsh-whale nvidia preset >>>.*?# <<< dsh-whale nvidia preset <<<\n?', '\n', t, flags=re.S)
def fix(m):
    cmd = m.group(1).strip()
    return 'Exec=sh -lc \'. "$HOME/.config/dsh-whale/nvidia.env" 2>/dev/null; exec %s\'' % cmd.replace("'", "'\\''")
t = re.sub(r'^Exec=(.+)$', fix, t, count=1, flags=re.M)
p.write_text(t.rstrip('\n') + '\n', encoding='utf-8')
print('  ✅ %s：Exec 已改为「先加载 nvidia.env 再启动」' % p.name)
PY
done
[[ "$FOUND" == 0 ]] && info "没找到已安装的桌宠自启项（先跑 install-autostart.sh 再执行本脚本即可）"

# ---------------------------------------------------------------- 依赖建议
echo
echo "===== [3] 依赖建议（N 卡机器上按需安装）====="
echo "  ${DIM}Ubuntu/Debian：${RST}"
echo "    sudo apt install nvidia-driver-550 nvidia-utils-550 libnvidia-egl-wayland1"
echo "    sudo apt install nvidia-vaapi-driver libva2 vainfo     # 视频硬解（可选）"
echo "    sudo apt install vulkan-tools mesa-utils               # vulkaninfo / glxinfo"
echo "  ${DIM}验证：${RST} bash $SELFTEST"
echo
echo "===== [4] 与两套桌宠的对接方式 ====="
echo "  · DSH 桌宠桌面端：启动器会自动 source nvidia.env（已注入 autostart）；"
echo "    手动启动时用： sh -lc '. ~/.config/dsh-whale/nvidia.env; exec ./start-linux.sh'"
echo "  · Coopanion：app/main.cjs 会读 COOPANION_GPU_FLAGS 追加到 Electron 命令行，"
echo "    并强制 --ozone-platform=x11（shape 点击穿透必需）。"
echo "    手动启动： COOPANION_GPU_FLAGS=\"\$(sh -c '. ~/.config/dsh-whale/nvidia.env; echo \$COOPANION_GPU_FLAGS')\" ./node_modules/electron/dist/electron ."
echo
ok "NVIDIA 预制配置完成"
exit 0
