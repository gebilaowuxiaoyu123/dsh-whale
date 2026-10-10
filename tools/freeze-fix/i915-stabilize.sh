#!/usr/bin/env bash
# ============================================================================
#  freeze-fix / i915-stabilize.sh —— 治本：给 i915 加稳定参数（需要 root）
#
#  针对症状：屏幕定格、只剩鼠标能动（GPU 挂死后 mutter 无法恢复）
#  依据（本机 2026-10-03 日志）：
#     i915: *ERROR* GT0: GUC: TLB invalidation response timed out for seqno N
#     i915: GPU HANG: ecode 12:0:00000000
#     i915: GT0: Resetting chip for stopped heartbeat on rcs0
#     gsd-power: Error setting 'PowerSaveMode' on org.gnome.Mutter.DisplayConfig: 已到超时限制
#
#  写入的内核参数：
#    i915.enable_psr=0   ★ 头号诱因。PSR/PSR2 面板自刷新出错时，硬件停止取帧，
#                          合成器以为还在刷新 → 画面定格、光标（独立 plane）仍能动。
#    i915.enable_dc=0     关闭显示 DC 省电状态，MTL 上「退出 DC 失败」也会导致同样症状。
#    i915.enable_fbc=0    关闭帧缓冲压缩，排除 FBC 相关的取帧异常。
#    i915.reset=1         GPU 挂死时做引擎级复位（默认行为，显式写出便于核对）。
#
#  用法：
#    sudo bash tools/freeze-fix/i915-stabilize.sh              # 标准（推荐）
#    sudo bash tools/freeze-fix/i915-stabilize.sh --aggressive # 追加 i915.enable_guc=2
#    sudo bash tools/freeze-fix/i915-stabilize.sh --revert     # 撤销以上全部
#    sudo bash tools/freeze-fix/i915-stabilize.sh --check      # 只看现状
# ============================================================================
set -uo pipefail

MODE="apply"
case "${1:-}" in
  --revert) MODE="revert" ;;
  --check)  MODE="check"  ;;
  --aggressive) MODE="aggressive" ;;
  "") ;;
  *) echo "未知参数：$1"; exit 1 ;;
esac

GRUB=/etc/default/grub
MARK="# freeze-fix: i915 稳定性参数"
BASE='i915.enable_psr=0 i915.enable_dc=0 i915.enable_fbc=0 i915.reset=1'
AGGR='i915.enable_guc=2'

# ---------------------------------------------------------------- 平台守卫
# 本仓库两台机器共用（Intel MTL + Wayland / NVIDIA Legion + X11）。
# i915 内核参数只在「Intel 核显由 i915 驱动接管」时有意义：NVIDIA-only 机器写进
# GRUB 只是噪音，而且 --check 的「PSR 未禁用」警告会误导排查方向。
# 注意：**--revert 不做守卫** —— 万一哪台机器需要清理旧参数，必须允许执行。
gpu_vendors() {
  lspci -nn 2>/dev/null | grep -iE 'vga|3d|display' \
    | grep -oE '\[(8086|10de|1002):[0-9a-f]{4}\]' | sed 's/\[//;s/\]//' \
    | cut -d: -f1 | sort -u | tr '\n' ' '
}
if [[ "$MODE" != "revert" ]]; then
  if ! lspci -nn 2>/dev/null | grep -iE 'vga|3d|display' | grep -q '\[8086:'; then
    echo "⏭  本机没有 Intel 显卡（显卡厂商代码: $(gpu_vendors)）→ 跳过 i915 稳定性参数。"
    echo "   PSR/DC/FBC 这些参数只对 i915 有意义；NVIDIA 机器请往 nvidia/NVRM 方向排查。"
    exit 0
  fi
  if ! ls -d /sys/bus/pci/drivers/i915/*/ >/dev/null 2>&1; then
    echo "⏭  有 Intel 显卡，但 i915 驱动未接管它（可能用 xe 驱动）→ 跳过。"
    exit 0
  fi
  fwfam=$(journalctl -k -b --no-pager 2>/dev/null \
    | grep -oE 'i915/[a-z0-9]+_(guc|huc)' | sed 's|i915/||;s|_.*||' | sort -u | tr '\n' ' ')
  if [[ "$MODE" != "check" ]]; then
    echo "  平台: Intel 核显（i915 已接管，固件家族 [${fwfam:-未知}]）"
  else
    echo "  平台: Intel 核显（i915 已接管，固件家族 [${fwfam:-未知}]，本机对照用）"
  fi
fi

# root 检查放在平台判定之后：--check 是只读的，不需要 root；
# 「平台不适用」也应先于「需要 root」告知用户，不让人白跑 sudo。
if [[ "$MODE" != "check" ]]; then
  [[ $EUID -eq 0 ]] || { echo "需要 root：sudo bash $0 $*"; exit 1; }
fi

echo "===== 现状 ====="
echo "  kernel : $(uname -r)"
echo "  当前参数: $(cat /proc/cmdline)"
grep -q 'i915.enable_psr=0' /proc/cmdline && echo "  ✅ PSR 已禁用" || echo "  ⚠️  PSR 未禁用"

if [[ "$MODE" == "check" ]]; then exit 0; fi

if [[ "$MODE" == "revert" ]]; then
  echo; echo "===== 撤销 ====="
  grep -qF "$MARK" "$GRUB" || { echo "  未发现 freeze-fix 写入的内容，无需撤销"; exit 0; }
  cp -a "$GRUB" "$GRUB.bak.$(date +%Y%m%d%H%M%S)"
  python3 - "$GRUB" "$MARK" <<'PY'
import sys, re, pathlib
p = pathlib.Path(sys.argv[1]); mark = sys.argv[2]
t = p.read_text()
t = re.sub(r'\n?' + re.escape(mark) + r'\n.*\n', '\n', t)
p.write_text(t)
PY
  rm -f /etc/sysctl.d/99-freeze-fix-sysrq.conf
  echo "  ✅ 已还原 $GRUB，删除 sysrq 配置"
  echo; echo "执行以下命令使其生效："
  echo "  sudo update-grub && sudo update-initramfs -u -k all && sudo reboot"
  exit 0
fi

echo
echo "===== 写入内核参数 ====="
cp -a "$GRUB" "$GRUB.bak.$(date +%Y%m%d%H%M%S)"
WANT="$BASE"; [[ "$MODE" == "aggressive" ]] && WANT="$BASE $AGGR"

python3 - "$GRUB" "$MARK" "$WANT" <<'PY'
import sys, re, pathlib
p, mark, want = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
t = p.read_text()
# 清掉旧的 freeze-fix 段（幂等）
t = re.sub(r'\n?' + re.escape(mark) + r'\n.*\n', '\n', t)
m = re.search(r'^GRUB_CMDLINE_LINUX_DEFAULT=(.*)$', t, re.M)
if not m:
    t += '\nGRUB_CMDLINE_LINUX_DEFAULT=""\n'
    m = re.search(r'^GRUB_CMDLINE_LINUX_DEFAULT=(.*)$', t, re.M)
cur = m.group(1).strip().strip('"')
# 去掉可能已存在的冲突项，避免重复
for k in ('i915.enable_psr', 'i915.enable_dc', 'i915.enable_fbc', 'i915.reset', 'i915.enable_guc'):
    cur = re.sub(r'\s*' + re.escape(k) + r'=\S+', '', cur)
new = (cur + ' ' + want).strip()
line = f'GRUB_CMDLINE_LINUX_DEFAULT="{new}"'
t = t[:m.start()] + line + t[m.end():]
t = t.rstrip('\n') + f'\n{mark}\n# 详见 tools/freeze-fix/README.md（症状：屏幕定格只剩鼠标能动）\n'
p.write_text(t)
print('  GRUB_CMDLINE_LINUX_DEFAULT = "%s"' % new)
PY

echo
echo "===== 开启 SysRq（紧急时能安全重启，避免再被 Windows 自动修复抢走引导） ====="
cat > /etc/sysctl.d/99-freeze-fix-sysrq.conf <<'EOF'
# freeze-fix: 允许 SysRq，冻结时可用 Alt+SysRq+S(落盘) U(只读重挂) B(重启)
kernel.sysrq = 1
EOF
sysctl -q -p /etc/sysctl.d/99-freeze-fix-sysrq.conf 2>/dev/null || sysctl -w kernel.sysrq=1
echo "  kernel.sysrq = $(cat /proc/sys/kernel/sysrq)"

echo
echo "===== 检查 linux-firmware（GuC 固件 bug 的正解是升级固件） ====="
if command -v apt-get >/dev/null; then
  cur=$(dpkg-query -W -f='${Version}' linux-firmware 2>/dev/null || echo '未安装')
  echo "  当前 linux-firmware: $cur"
  echo "  建议（有网络时）：sudo apt update && sudo apt install --only-upgrade linux-firmware linux-image-generic"
  echo "  升级后重启即可生效；这一步能真正修掉 mtl_guc_70.bin 的 TLB 失效超时。"
fi

echo
echo "===== 应用 ====="
update-grub 2>&1 | tail -3
[[ -d /etc/initramfs-tools ]] && update-initramfs -u -k all 2>&1 | tail -2

cat <<'EOT'

===== 完成 =====
  ✅ 内核参数已写入 /etc/default/grub
  ✅ SysRq 已开启
  ⏭  需要重启才生效：sudo reboot

  重启后自检：
    bash tools/freeze-fix/diagnose.sh          # 应显示「已禁用 PSR / DC states」
    grep -o 'i915[^ ]*' /proc/cmdline

  撤销：
    sudo bash tools/freeze-fix/i915-stabilize.sh --revert
EOT
