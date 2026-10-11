#!/usr/bin/env bash
# ============================================================================
#  freeze-fix / diagnose.sh —— 「屏幕冻结、只剩鼠标能动」取证脚本（无需 root）
#
#  背景（已在本机 2026-10-03 复现并定位）：
#    ① i915/MTL GPU 挂死：GuC TLB invalidation timeout → Fence expiration
#       → GPU HANG → Resetting chip for stopped heartbeat（两天 59 次）
#    ② GPU reset 之后 mutter 无法恢复：org.gnome.Mutter.DisplayConfig 的
#       D-Bus 调用超时（gsd-power 报「已到超时限制」）
#    ③ 合成器不再出帧 → 屏幕定格，只剩硬件光标能滑（光标是独立 plane）
#    ④ 用户只能强制关机 → Windows 自动修复接管 → 重建 ESP、篡改引导项
#
#  所以「冻结」本身不是桌宠 bug，但桌宠的持续 GPU 负载是诱因之一。
# ============================================================================
set -uo pipefail
R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; D=$'\033[2m'; N=$'\033[0m'
hdr(){ echo; echo "${C}══════ $* ══════${N}"; }
ok(){ echo "  ${G}✅${N} $*"; }
bad(){ echo "  ${R}❌${N} $*"; }
warn(){ echo "  ${Y}⚠️${N} $*"; }
info(){ echo "  ${D}·${N} $*"; }

# ---- 平台识别：本仓库由两台机器共同完善 ----
#   Intel MTL + Ubuntu 24.04（GNOME/Wayland） / NVIDIA Legion + Ubuntu 22.04（X11）
# 诊断项很多是 i915 专属的，非 Intel 机器上不能拿来当结论。
is_intel_gpu(){  lspci -nn 2>/dev/null | grep -iE 'vga|3d|display' | grep -q '\[8086:'; }
is_nvidia_gpu(){ lspci -nn 2>/dev/null | grep -iE 'vga|3d|display' | grep -q '\[10de:'; }
gpu_vendors(){
  lspci -nn 2>/dev/null | grep -iE 'vga|3d|display' \
    | grep -oE '\[(8086|10de|1002):[0-9a-f]{4}\]' | sed 's/\[//;s/\]//' \
    | cut -d: -f1 | sort -u | tr '\n' ' '
}
i915_active(){ ls -d /sys/bus/pci/drivers/i915/*/ >/dev/null 2>&1; }
# GPU 异常关键字：i915 与 NVRM 合并，两台机器共用同一套统计口径
GPU_PAT='GPU HANG|Resetting chip for stopped heartbeat|GUC: TLB invalidation response timed out|NVRM: Xid|GPU has fallen off the bus'
GPU_PAT_SHORT='GPU HANG|Resetting chip|TLB invalidation response timed out|NVRM: Xid|fallen off the bus'

hdr "1. 环境"
echo "  kernel    : $(uname -r)"
echo "  启动参数  : $(cat /proc/cmdline)"
echo "  会话类型  : ${XDG_SESSION_TYPE:-?}  桌面: ${XDG_CURRENT_DESKTOP:-?}"
echo "  显卡厂商  : $(gpu_vendors)  ${D}(8086=Intel, 10de=NVIDIA, 1002=AMD)${N}"
if is_intel_gpu && i915_active; then
  info "i915 固件家族: $(journalctl -k -b --no-pager 2>/dev/null | grep -oE 'i915/[a-z0-9]+_(guc|huc)' | sed 's|i915/||;s|_.*||' | sort -u | tr '\n' ' ')"
  grep -q 'i915.enable_psr=0' /proc/cmdline && ok "已禁用 PSR（关键稳定项）" \
    || warn "PSR 未禁用 —— MTL 上「冻结只剩光标」的头号诱因，建议跑 i915-stabilize.sh"
  grep -q 'i915.enable_dc=0' /proc/cmdline && ok "已禁用 DC states" \
    || warn "DC states 未禁用（次要诱因）"
else
  info "本机没有由 i915 接管的 Intel 核显 → 跳过 PSR/DC 检查（这两项只对 i915 有意义）"
fi
if is_nvidia_gpu; then
  if command -v nvidia-smi >/dev/null 2>&1; then
    ok "NVIDIA 驱动 $(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)（$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)）"
  else
    warn "检测到 NVIDIA 显卡但没有 nvidia-smi（驱动可能没装好）"
  fi
fi
echo "  sysrq     : $(cat /proc/sys/kernel/sysrq 2>/dev/null) ${D}(1=全开，紧急时可用 Alt+SysRq+S,U,B 安全重启)${N}"

hdr "2. GPU 挂死事件统计"
if ! command -v journalctl >/dev/null; then bad "没有 journalctl"; exit 1; fi
cnt_all=$(journalctl -k --no-pager 2>/dev/null | grep -cE "$GPU_PAT" || true)
echo "  全部记录（内核日志范围内）: ${R}${cnt_all}${N} 次"
for b in 0 -1 -2 -3 -4; do
  c=$(journalctl -b $b -k --no-pager 2>/dev/null | grep -cE "$GPU_PAT_SHORT" || true)
  [[ "$c" != "0" ]] && echo "  boot $b : $c 次"
done
echo
info "最近 5 条 GPU 错误（含时间戳）："
journalctl --no-pager 2>/dev/null | grep -E "$GPU_PAT" | tail -5 | cut -c1-150 | sed 's/^/      /'

hdr "3. 冻结的直接证据：mutter 无响应"
c=$(journalctl --no-pager 2>/dev/null | grep -cE "Mutter.DisplayConfig.*超时|Mutter.DisplayConfig.*[Tt]imed out" || true)
[[ "$c" != "0" ]] && bad "发现 $c 次 mutter D-Bus 超时 —— 这就是「冻结只剩光标」的直接原因" \
  || ok "无 mutter 超时记录"
journalctl --no-pager 2>/dev/null | grep -E "Mutter.DisplayConfig" | tail -3 | cut -c1-150 | sed 's/^/      /'

hdr "4. GPU 进程崩溃（Chromium/Electron 系）"
journalctl --no-pager --since '-3 days' 2>/dev/null \
  | grep -E 'GPU process exited unexpectedly' \
  | awk '{for(i=5;i<=NF;i++){if($i ~ /\.desktop|\[/){print $1" "$2" "$3" "$i; break}}}' \
  | sort | uniq -c | sort -rn | head -8 | sed 's/^/      /'

hdr "5. 持续负载源（当前）"
ps -eo pcpu,pmem,rss,etime,comm --sort=-pcpu 2>/dev/null | head -9 \
  | awk 'NR==1{printf "      %6s %6s %8s %10s  %s\n","CPU%","MEM%","RSS(KB)","ELAPSED","COMMAND";next}{printf "      %6s %6s %8s %10s  %s\n",$1,$2,$3,$4,$5}'

hdr "6. 引导 / ESP 健康度"
# 注意：必须用 --list，否则 lsblk 会输出 ├─ 这类树形前缀，拼出来的路径是无效的
# （这个坑本脚本早期版本真踩过：UUID 读成空字符串，误报"不一致"）
esp_part=$(lsblk --list --noheadings -p -o NAME,PARTTYPENAME 2>/dev/null | awk '/EFI System/{print $1; exit}')
if [[ -n "$esp_part" ]]; then
  esp_uuid=$(lsblk --list --noheadings -p -o UUID "$esp_part" 2>/dev/null | tr -d ' \n')
  ok "ESP 分区：$esp_part  UUID=$esp_uuid"
  # 只取以 UUID= 开头的行，否则会把 fstab 注释里的旧 UUID 当成现役配置
  fstab_uuid=$(awk '/^[[:space:]]*UUID=/ && $2=="/boot/efi"{print $1}' /etc/fstab 2>/dev/null | sed 's/UUID=//' | tr -d ' ')
  if [[ -n "$fstab_uuid" && "$fstab_uuid" != "$esp_uuid" ]]; then
    bad "fstab 里的 ESP UUID ($fstab_uuid) 与实际 ($esp_uuid) 不一致 → /boot/efi 挂不上！"
    info "这通常是 Windows 自动修复重建了 ESP 分区（本次卡死后强制关机所致）"
    info "修复：sudo bash tools/freeze-fix/fix-esp-grub.sh"
  else
    mountpoint -q /boot/efi && ok "/boot/efi 已挂载" || warn "/boot/efi 未挂载（但 UUID 一致，可 mount -a 试）"
  fi
else
  bad "找不到 EFI System 分区"
fi
echo
info "efibootmgr 引导项："
if command -v efibootmgr >/dev/null; then
  efibootmgr -v 2>/dev/null | sed -n '1,12p' | sed 's/^/      /'
  if efibootmgr -v 2>/dev/null | grep -q 'Windows Boot Manager.*ubuntu'; then
    bad "有引导项：名字叫 Windows Boot Manager、却指向 \\EFI\\ubuntu —— 被 Windows 篡改过"
    info "修复：sudo bash tools/freeze-fix/fix-esp-grub.sh"
  fi
else
  warn "未安装 efibootmgr（sudo apt install efibootmgr）"
fi

hdr "7. 结论与建议"
cat <<'EOT'
      若上面出现「mutter D-Bus 超时」+「GPU HANG」，即为本次冻结的确切成因，处理顺序：
        1) sudo bash tools/freeze-fix/i915-stabilize.sh     # 加内核稳定参数（治本，需重启）
        2) sudo bash tools/freeze-fix/gpu-watchdog.sh       # 装看门狗：GPU 挂死自动救回会话
        3) sudo bash tools/freeze-fix/fix-esp-grub.sh       # 修 ESP 挂载 + 恢复 GRUB 引导项
      紧急自救（不必再强制关机）：Ctrl+Alt+F3 切到 TTY 登录，然后
        sudo systemctl restart gdm        # 只结束图形会话，干净得多
      或：Alt+SysRq+S 然后 Alt+SysRq+U 然后 Alt+SysRq+B（需 kernel.sysrq=1）
EOT
echo
