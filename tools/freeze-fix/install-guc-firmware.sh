#!/usr/bin/env bash
# ============================================================================
#  freeze-fix / install-guc-firmware.sh —— 更新 Intel Meteor Lake GuC 固件
#
#  为什么需要它：
#    内核会打印这样一行警告（本机实测）：
#      i915 0000:00:02.0: [drm] GT0: GuC firmware i915/mtl_guc_70.bin (70.53.0)
#      is recommended, but only i915/mtl_guc_70.bin (70.36.0) was found
#    固件比驱动期望的旧，就会出现本机反复遇到的：
#      i915 ... GT0: GUC: TLB invalidation response timed out for seqno NNNNN
#    → mutter 随即定格（「挂起」）。这是 Meteor Lake + 旧 GuC 的已知症状，
#    换上新固件是根因级修法（看门狗只是兜底，不能替代它）。
#
#  Ubuntu 的 linux-firmware 包不提供 70.53.0，所以直接从上游 linux-firmware 取。
#
#  用法：
#    sudo bash tools/freeze-fix/install-guc-firmware.sh            # 下载 + 安装
#    sudo bash tools/freeze-fix/install-guc-firmware.sh --check    # 只看现状（无需 root）
#  装完需要重启（i915 只在加载时读固件）：sudo reboot
#  重启后确认：journalctl -k -b | grep 'GuC firmware.*version'
# ============================================================================
set -uo pipefail

FW_NAME=mtl_guc_70.bin
FW_DIR=/lib/firmware/i915
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE_DIR="${HOME:-/root}/.cache/dsh-whale-firmware"
URLS=(
  "https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git/plain/i915/${FW_NAME}"
  "https://raw.githubusercontent.com/torvalds/linux-firmware/master/i915/${FW_NAME}"
)

say() { printf '  %s\n' "$*"; }

# ---------------------------------------------------------------- 平台判定
# 本脚本专治 **Intel Meteor Lake（MTL）核显**的 GuC 固件过旧问题。
# 本仓库由两台机器共同完善：一台 Intel MTL + Ubuntu 24.04（GNOME/Wayland），
# 一台 Legion + RTX 5070 + Ubuntu 22.04（X11）。跑之前必须先确认平台，
# 否则会在 NVIDIA 机器上做无意义（甚至有害）的固件替换。
gpu_vendors() {
  lspci -nn 2>/dev/null | grep -iE 'vga|3d|display' \
    | grep -oE '\[(8086|10de|1002):[0-9a-f]{4}\]' | sed 's/\[//;s/\]//' \
    | cut -d: -f1 | sort -u | tr '\n' ' '
}
has_intel_gpu()  { lspci -nn 2>/dev/null | grep -iE 'vga|3d|display' | grep -q '\[8086:'; }
# i915 驱动是否在管着 Intel 核显（新平台可能改用 xe 驱动）
i915_active() { ls -d /sys/bus/pci/drivers/i915/*/ 2>/dev/null | grep -q .; }
# 从内核日志读 i915 实际加载的固件家族前缀：mtl_ = Meteor Lake，tgl_/adlp_ 等为其它代次
i915_fw_family() {
  journalctl -k -b --no-pager 2>/dev/null \
    | grep -oE 'i915/[a-z0-9]+_(guc|huc)' | sed 's|i915/||;s|_.*||' | sort -u | tr '\n' ' '
}
platform_summary() {
  say "显卡厂商代码: $(gpu_vendors)（8086=Intel, 10de=NVIDIA, 1002=AMD）"
  say "i915 驱动占用: $(i915_active && echo 是 || echo 否)"
  say "i915 固件家族: $(i915_fw_family)"
}

show_current() {
  say '── 内核期望 vs 实际加载 ──'
  journalctl -k -b --no-pager 2>/dev/null \
    | grep -a "GuC firmware" | sed 's/^/    /' || say '（本次启动没有 GuC 相关日志）'
  say '── 本地固件文件 ──'
  ls -la "${FW_DIR}/${FW_NAME}"* 2>/dev/null | sed 's/^/    /' || say "（${FW_DIR}/${FW_NAME} 不存在）"
}

if [[ "${1:-}" == "--check" ]]; then
  show_current
  echo
  say '── 平台判定 ──'
  platform_summary
  exit 0
fi

# 不适用的平台：直接退出，绝不去动 /lib/firmware
if ! has_intel_gpu; then
  echo "⏭  本机没有 Intel 显卡（显卡厂商代码: $(gpu_vendors)）→ 跳过。"
  echo "   本脚本只针对 Intel Meteor Lake 的 GuC 固件；NVIDIA/AMD 机器不适用。"
  exit 0
fi
if ! i915_active; then
  echo "⏭  有 Intel 显卡，但 i915 驱动没在管它（可能用 xe 驱动）→ 跳过。"
  exit 0
fi
fwfam="$(i915_fw_family)"
case " $fwfam " in
  *" mtl "*)
    : ;;   # Meteor Lake：正是本脚本的目标平台
  *)
    echo "⏭  本机 i915 加载的固件家族是 [${fwfam:-未知}]，不是 mtl（Meteor Lake）→ 跳过。"
    echo "   mtl_guc_70.bin 只适用于 Meteor Lake；其它代次请用对应的 <gen>_guc_*.bin。"
    exit 0 ;;
esac

[[ $EUID -eq 0 ]] || { echo "需要 root：sudo bash $0"; exit 1; }

echo "===== [1] 准备固件 ====="
mkdir -p "$CACHE_DIR"
CACHE="$CACHE_DIR/$FW_NAME"
if [[ ! -s "$CACHE" ]]; then
  ok=0
  for u in "${URLS[@]}"; do
    echo "  下载：$u"
    if curl -fsSL --retry 3 --connect-timeout 20 -o "$CACHE.part" "$u"; then
      mv -f "$CACHE.part" "$CACHE"; ok=1; echo "  ✅ 已缓存 $CACHE"; break
    fi
    echo "  ✗ 失败，换下一个源"
  done
  [[ $ok -eq 1 ]] || { echo "❌ 所有源都下载失败（检查网络/代理）"; exit 1; }
else
  echo "  ✅ 用缓存 $CACHE"
fi
ls -la "$CACHE" | sed 's/^/    /'

echo
echo "===== [2] 安装到 ${FW_DIR} ====="
# 先备份原文件（Ubuntu 是 .zst 压缩的，我们放未压缩版；加载器优先未压缩名）
for f in "${FW_DIR}/${FW_NAME}" "${FW_DIR}/${FW_NAME}.zst" "${FW_DIR}/${FW_NAME}.xz"; do
  [[ -e "$f" && ! -e "$f.bak-dsh" ]] && { cp -a "$f" "$f.bak-dsh"; echo "  已备份 $f → $f.bak-dsh"; }
done
install -m 0644 "$CACHE" "${FW_DIR}/${FW_NAME}"
echo "  ✅ 已安装 $(ls -la "${FW_DIR}/${FW_NAME}" | awk '{print $5" 字节"}')"

echo
echo "===== [3] 刷新 initramfs（Ubuntu 的 initramfs 里也带 i915 固件） ====="
if command -v update-initramfs >/dev/null 2>&1; then
  update-initramfs -u 2>&1 | tail -3 | sed 's/^/    /'
else
  echo "  （无 update-initramfs，跳过）"
fi

echo
echo "===== [4] 现状（重启前仍显示旧版本，属正常） ====="
show_current

cat <<'TIP'

  ── 接下来 ──
  ① 重启让 i915 重新加载固件：sudo reboot
  ② 重启后确认版本已更新（应显示 70.53.0 或更高，且不再有 "is recommended" 警告）：
       journalctl -k -b | grep 'GuC firmware.*version'
  ③ 若想看 TLB 超时是否消失：
       journalctl -k -b | grep -c 'TLB invalidation response timed out'
  ④ 回滚（万一有问题）：
       sudo cp -a /lib/firmware/i915/mtl_guc_70.bin.bak-dsh /lib/firmware/i915/mtl_guc_70.bin.zst
       sudo rm -f /lib/firmware/i915/mtl_guc_70.bin && sudo update-initramfs -u
TIP
