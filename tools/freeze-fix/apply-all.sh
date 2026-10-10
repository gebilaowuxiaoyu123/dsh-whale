#!/usr/bin/env bash
# ============================================================================
#  freeze-fix / apply-all.sh —— 一条命令跑完全部系统修复（需要 root）
#
#  为什么有这个脚本：
#    分三条命令手动跑很容易踩路径坑（在自己家目录下执行 → "没有那个文件或目录"）。
#    这里用脚本自身所在目录做基准，不管你当前在哪个目录都能跑。
#
#  用法（复制这一整行，路径是绝对的）：
#    sudo bash ~/dsh-whale/tools/freeze-fix/apply-all.sh
#
#  可选：
#    sudo bash .../apply-all.sh --check    只体检，不改任何东西
#    sudo bash .../apply-all.sh --only=esp 只跑其中一步（esp | i915 | watchdog）
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; B=$'\033[1m'; N=$'\033[0m'

ONLY=""; MODE="apply"
for a in "$@"; do
  case "$a" in
    --check)      MODE="check" ;;
    --only=*)     ONLY="${a#--only=}" ;;
    -h|--help)    sed -n '2,20p' "$0"; exit 0 ;;
  esac
done

if [[ "$MODE" != "check" && $EUID -ne 0 ]]; then
  echo "${R}需要 root。请复制这一整行：${N}"
  echo "  ${B}sudo bash $HERE/apply-all.sh${N}"
  exit 1
fi

echo "${C}${B}"
echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║  dsh-whale 系统修复：屏幕定格 / GPU 挂死 / GRUB 被 Windows 抢走       ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"
echo "${N}"
echo "  工作目录 : $HERE"
echo "  模式     : ${MODE}${ONLY:+  只跑=$ONLY}"
echo "  用户     : ${SUDO_USER:-$(id -un)}"

run_step() {
  local id="$1" title="$2" script="$3"
  shift 3
  [[ -n "$ONLY" && "$ONLY" != "$id" ]] && return 0
  echo
  echo "${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  echo "${B}[$id] $title${N}"
  echo "${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  if [[ ! -f "$HERE/$script" ]]; then
    echo "  ${R}❌ 找不到 $HERE/$script${N}"; return 1
  fi
  bash "$HERE/$script" "$@"
  local rc=$?
  # rc=0 也可能是「平台不适用，脚本自己跳过了」（如 NVIDIA 机器上的 i915 步骤），
  # 跳过信息已在上面输出，这里不再判断成败。
  [[ $rc -eq 0 ]] && echo "  ${G}✅ [$id] 完成${N}" || echo "  ${Y}⚠️  [$id] 退出码 $rc${N}"
  return 0
}

if [[ "$MODE" == "check" ]]; then
  echo
  echo "${B}===== ① 体检（只读，不改动）=====${N}"
  bash "$HERE/diagnose.sh" 2>&1 | tail -40
  echo
  echo "${B}===== ② 引导修复预演（--check，不改动）=====${N}"
  bash "$HERE/fix-esp-grub.sh" --check 2>&1 | head -30
  echo
  echo "${G}${B}体检结束，未做任何修改。${N}"
  echo "  执行修复： sudo bash $HERE/apply-all.sh"
  exit 0
fi

run_step i915     "① 加 i915 稳定参数（PSR/DC/FBC 关闭，治本，需重启）"  i915-stabilize.sh
run_step watchdog "② 安装 GPU 看门狗（挂死自动救回会话，从此不必强制关机）" gpu-watchdog.sh
run_step esp      "③ 修复 ESP 挂载 与 GRUB 引导项（被 Windows 自动修复破坏）" fix-esp-grub.sh

echo
echo "${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo "${G}${B}全部步骤执行完毕${N}"
echo "${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
cat <<EOT

  接下来：
    1) 重启让内核参数生效：            sudo reboot
    2) 重启后确认已生效：
         bash $HERE/diagnose.sh        # 第 1 节应显示「已禁用 PSR / DC states」
         grep -o 'i915[^ ]*' /proc/cmdline
    3) 看门狗状态：
         sudo bash $HERE/gpu-watchdog.sh --status

  以后万一又出现「屏幕定格、只有鼠标能动」：
     不要再长按电源键！按顺序试：
       a) Ctrl+Alt+F3 切到文字终端登录 → sudo systemctl restart gdm
       b) 或 Alt+SysRq+S 然后 Alt+SysRq+U 然后 Alt+SysRq+B（安全落盘+重挂+重启）
     看门狗正常情况下会自动帮你做完 (a)，你不用动手。

  Windows 侧务必关掉「快速启动」和「自动重新启动」，否则关机/异常仍可能
  再次触发 Windows 自动修复来抢引导。已在 Windows 侧脚本化（管理员）：

    powershell -NoProfile -ExecutionPolicy Bypass -File ..\boot-safety\check-boot-health.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File ..\boot-safety\fix-windows-boot-safety.ps1

  体检/修复的意义与证据见仓库根目录 docs/dualboot-boot-safety.md。
EOT
