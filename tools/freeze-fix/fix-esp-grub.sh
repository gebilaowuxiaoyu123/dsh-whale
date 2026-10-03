#!/usr/bin/env bash
# ============================================================================
#  freeze-fix / fix-esp-grub.sh —— 修复被 Windows 自动修复破坏的引导（需要 root）
#
#  本次（2026-10-03）实际发生的事：
#    · 屏幕冻结 → 长按电源键强制关机
#    · 下次开机 firmware 判定上次异常 → 进 Windows 自动修复
#    · Windows 自动修复**重建了 EFI 系统分区**：nvme0n1p1 变成新的
#      UUID=DAA2-C912（LABEL=SYSTEM），而 /etc/fstab 里还写着旧的
#      UUID=2AC8-E406 → /boot/efi 从此**挂不上**
#      （开机日志：Timed out waiting for device dev-disk-by\x2duuid-2AC8-E406.device）
#    · 并新增了一条**名字叫 "Windows Boot Manager"、却指向 \EFI\ubuntu\grubx64.efi**
#      的引导项（Boot0002），用它替换原来的 ubuntu 项 —— 于是 GRUB 的入口"看起来消失了"
#
#  本脚本做 4 件事：
#    ① 把 fstab 里的 ESP UUID 纠正为实际值（恢复 /boot/efi 可挂载）
#    ② 挂载 ESP 并核对 \EFI\ubuntu\ 下的引导器是否完好，缺了就重装 GRUB
#    ③ 删除被篡改的引导项，重建干净的 ubuntu 项，并把 ubuntu 排到 BootOrder 最前
#    ④ 打开 os-prober，让 GRUB 菜单里同时出现 Windows（双系统可切换）
#
#  用法：
#    sudo bash tools/freeze-fix/fix-esp-grub.sh --check    # 只诊断，不改动（建议先跑）
#    sudo bash tools/freeze-fix/fix-esp-grub.sh            # 执行修复
# ============================================================================
set -uo pipefail
MODE_LOCAL="apply"; [[ "${1:-}" == "--check" ]] && MODE_LOCAL="check"
# --check 是纯只读诊断，允许普通用户先跑一遍看看情况；真正动手才要 root。
if [[ "$MODE_LOCAL" != "check" ]]; then
  [[ $EUID -eq 0 ]] || { echo "需要 root：sudo bash $0 $*"; exit 1; }
fi

MODE="apply"; [[ "${1:-}" == "--check" ]] && MODE="check"
R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; D=$'\033[2m'; N=$'\033[0m'
ok(){ echo "  ${G}✅${N} $*"; }; bad(){ echo "  ${R}❌${N} $*"; }
warn(){ echo "  ${Y}⚠️${N} $*"; }; info(){ echo "  ${D}·${N} $*"; }
hdr(){ echo; echo "${C}───── $* ─────${N}"; }
CHANGED=0

for c in efibootmgr lsblk mountpoint update-grub; do
  command -v "$c" >/dev/null || { echo "缺少命令 $c：sudo apt install efibootmgr grub-efi-amd64-bin"; exit 1; }
done
[[ -d /sys/firmware/efi ]] || { bad "不是 UEFI 启动的会话，本脚本不适用"; exit 1; }

hdr "1. 探测 ESP 分区"
# --list 必须有：不加会得到 "├─/dev/nvme0n1p1" 这种带树形前缀的“路径”，
# 拿它再查 UUID 会得到空字符串，进而把空的 UUID 写进 fstab（危险！）。
ESP_PART=$(lsblk --list --noheadings -p -o NAME,PARTTYPENAME | awk '/EFI System/{print $1; exit}')
[[ -z "$ESP_PART" ]] && { bad "找不到 EFI System 分区"; exit 1; }
ESP_UUID=$(lsblk --list --noheadings -p -o UUID "$ESP_PART" | tr -d ' \n')
ESP_LABEL=$(lsblk --list --noheadings -p -o LABEL "$ESP_PART" | tr -d ' \n')
DISK=$(lsblk --list --noheadings -p -o PKNAME "$ESP_PART" | tr -d ' \n')
PARTNUM=$(cat "/sys/class/block/$(basename "$ESP_PART")/partition" 2>/dev/null)
# 安全闸：UUID 或磁盘名读不到就绝不动 fstab
[[ -n "$ESP_UUID" ]] || { bad "读不到 $ESP_PART 的 UUID（需要 root 读块设备），已中止以防写坏 fstab"; exit 1; }
[[ -n "$DISK" ]] || { bad "读不到 ESP 所属磁盘，已中止"; exit 1; }
ok "ESP = $ESP_PART  UUID=$ESP_UUID  LABEL=${ESP_LABEL:-无}  磁盘=$DISK 分区号=$PARTNUM"
# 备份 fstab
FBACK="/etc/fstab.bak.$(date +%Y%m%d%H%M%S)"

hdr "2. 纠正 fstab 里的 ESP UUID"
FSTAB_LINE=$(grep -nE '^\s*UUID=\S+\s+/boot/efi' /etc/fstab || true)
if [[ -z "$FSTAB_LINE" ]]; then
  bad "fstab 里没有 /boot/efi 条目，需要新增"
  if [[ "$MODE" == "apply" ]]; then
    cp -a /etc/fstab "$FBACK"
    printf 'UUID=%s  /boot/efi       vfat    defaults      0       1\n' "$ESP_UUID" >> /etc/fstab
    ok "已追加 /boot/efi 条目（备份：$FBACK）"; CHANGED=1
  fi
else
  CUR=$(echo "$FSTAB_LINE" | sed -E 's/^[0-9]+:\s*UUID=([^ ]+).*/\1/')
  echo "   fstab 当前: UUID=$CUR"
  echo "   实际 ESP  : UUID=$ESP_UUID"
  if [[ "$CUR" == "$ESP_UUID" ]]; then
    ok "一致，无需修改"
  else
    bad "不一致 → /boot/efi 挂不上（这正是本次 GRUB 出问题的直接原因）"
    if [[ "$MODE" == "apply" ]]; then
      cp -a /etc/fstab "$FBACK"
      sed -i -E "0,/^(\s*UUID=)$CUR(\s+\/boot\/efi)/s//\1$ESP_UUID\2/" /etc/fstab
      CHANGED=1
      ok "已改为 UUID=$ESP_UUID（备份：$FBACK）"
      grep -nE '/boot/efi' /etc/fstab | sed 's/^/      /'
    fi
  fi
fi

hdr "3. 挂载 ESP 并核对引导器"
MOUNTPOINT=/boot/efi
mkdir -p "$MOUNTPOINT"
if mountpoint -q "$MOUNTPOINT"; then
  ok "已挂载"
else
  if [[ "$MODE" == "apply" ]]; then
    if systemctl daemon-reload >/dev/null 2>&1; then :; fi
    if mount "$MOUNTPOINT" 2>/dev/null || mount -a 2>/dev/null; then
      mountpoint -q "$MOUNTPOINT" && ok "挂载成功" || bad "挂载失败，请手动：sudo mount $ESP_PART $MOUNTPOINT"
    else
      bad "挂载失败，尝试用实际分区直接挂"
      mount "$ESP_PART" "$MOUNTPOINT" 2>/dev/null && ok "已按 $ESP_PART 挂载" || bad "仍失败"
    fi
  else
    warn "未挂载（--check 模式不挂载）"
  fi
fi

if mountpoint -q "$MOUNTPOINT"; then
  echo "   ESP 内容："; ls -1 "$MOUNTPOINT/EFI" 2>/dev/null | sed 's/^/      /'
  GRUB_EFI="$MOUNTPOINT/EFI/ubuntu/grubx64.efi"
  SHIM_EFI="$MOUNTPOINT/EFI/ubuntu/shimx64.efi"
  if [[ -f "$GRUB_EFI" ]]; then ok "GRUB 引导器存在：EFI/ubuntu/grubx64.efi"
  else
    bad "EFI/ubuntu/grubx64.efi 缺失 → 需要重装 GRUB"
    if [[ "$MODE" == "apply" ]]; then
      echo "      执行 grub-install …"
      grub-install --target=x86_64-efi --efi-directory="$MOUNTPOINT" \
                   --bootloader-id=ubuntu --recheck 2>&1 | tail -5 | sed 's/^/      /'
      [[ -f "$GRUB_EFI" ]] && { ok "重装成功"; CHANGED=1; } || bad "重装失败，请检查上面输出"
    fi
  fi
  [[ -f "$SHIM_EFI" ]] && ok "shim 也在（Secure Boot 兼容）" || info "无 shim（Secure Boot 关闭时正常）"
  [[ -f "$MOUNTPOINT/EFI/Microsoft/Boot/bootmgfw.efi" ]] && ok "Windows 引导器完好（EFI/Microsoft）" \
    || warn "ESP 上没有 Windows 引导器 —— 若你还要用 Windows，请确认它在别的 ESP 上"
fi

hdr "4. 清理被篡改的引导项（名字是 Windows、指向 ubuntu）"
BOGUS=()
while read -r line; do
  [[ -z "$line" ]] && continue
  num=$(echo "$line" | awk '{print $1}')
  if echo "$line" | grep -qi 'Windows Boot Manager' && echo "$line" | grep -qi 'ubuntu'; then
    BOGUS+=("$num")
    bad "发现被篡改项 $num：$line"
  fi
done < <(efibootmgr -v 2>/dev/null | grep -E '^Boot[0-9A-Fa-f]{4}')
if [[ ${#BOGUS[@]} -eq 0 ]]; then
  ok "没有被篡改的引导项"
else
  info "这些项是「Windows 自动修复拿来替换 ubuntu 项」的产物，GRUB 实际仍在，删除它们不影响启动"
  if [[ "$MODE" == "apply" ]]; then
    for n in "${BOGUS[@]}"; do
      efibootmgr -b "$n" -B >/dev/null 2>&1 && ok "已删除 $n" || bad "删除 $n 失败"
      CHANGED=1
    done
  fi
fi

hdr "5. 确保存在干净的 ubuntu 引导项"
UBU=$(efibootmgr -v 2>/dev/null | awk '/^Boot[0-9A-Fa-f]{4}.*ubuntu.*(shimx64|grubx64)\.efi/{gsub(/Boot|\*/,"",$1); print $1; exit}')
if [[ -n "$UBU" ]]; then
  ok "ubuntu 项存在：$UBU"
else
  warn "没有 ubuntu 引导项，将新建"
  if [[ "$MODE" == "apply" ]]; then
    TARGET='\EFI\ubuntu\shimx64.efi'
    [[ -f "$MOUNTPOINT/EFI/ubuntu/shimx64.efi" ]] || TARGET='\EFI\ubuntu\grubx64.efi'
    efibootmgr -c -d "$DISK" -p "$PARTNUM" -L ubuntu -l "$TARGET" >/dev/null 2>&1 \
      && { ok "已创建 ubuntu → $TARGET"; UBU=$(efibootmgr -v | awk '/ubuntu/{gsub(/Boot|\*/,"",$1);print $1;exit}'); CHANGED=1; } \
      || bad "创建失败"
  fi
fi

hdr "6. 把 ubuntu 排到启动顺序最前（防止再被 Windows 抢走）"
if [[ -n "$UBU" ]]; then
  ORDER=$(efibootmgr 2>/dev/null | awk '/^BootOrder:/{print $2}')
  echo "   当前 BootOrder: $ORDER"
  if [[ "$ORDER" == "$UBU"* ]]; then
    ok "ubuntu ($UBU) 已在最前"
  else
    NEW=$(echo "$ORDER" | tr ',' '\n' | grep -v "^$UBU$" | tr '\n' ',' | sed 's/,$//')
    NEW="$UBU,$NEW"
    if [[ "$MODE" == "apply" ]]; then
      efibootmgr -o "$NEW" >/dev/null 2>&1 && { ok "已设为：$NEW"; CHANGED=1; } || bad "设置失败"
    else
      warn "需要改为：$NEW"
    fi
  fi
fi

hdr "7. 让 GRUB 菜单包含 Windows（双系统）"
GRUBF=/etc/default/grub
if grep -q '^GRUB_DISABLE_OS_PROBER=false' "$GRUBF"; then
  ok "os-prober 已启用"
else
  warn "os-prober 未启用（GRUB 菜单里可能看不到 Windows）"
  if [[ "$MODE" == "apply" ]]; then
    cp -a "$GRUBF" "$GRUBF.bak.$(date +%Y%m%d%H%M%S)"
    sed -i 's/^#\?GRUB_DISABLE_OS_PROBER=.*/GRUB_DISABLE_OS_PROBER=false/' "$GRUBF"
    grep -q '^GRUB_DISABLE_OS_PROBER' "$GRUBF" || echo 'GRUB_DISABLE_OS_PROBER=false' >> "$GRUBF"
    CHANGED=1; ok "已启用 os-prober"
  fi
fi
if grep -qE '^GRUB_TIMEOUT_STYLE=hidden' "$GRUBF"; then
  warn "GRUB_TIMEOUT_STYLE=hidden（开机看不到菜单）"
  if [[ "$MODE" == "apply" ]]; then
    sed -i 's/^GRUB_TIMEOUT_STYLE=hidden/GRUB_TIMEOUT_STYLE=menu/' "$GRUBF"
    sed -i 's/^GRUB_TIMEOUT=0/GRUB_TIMEOUT=5/' "$GRUBF"
    ok "已改为显示菜单、超时 5 秒（按住 Shift 也能唤出）"; CHANGED=1
  fi
fi

hdr "8. 重新生成 grub.cfg"
if [[ "$MODE" == "apply" && $CHANGED -eq 1 ]]; then
  update-grub 2>&1 | tail -8 | sed 's/^/      /'
  [[ -f /boot/grub/grub.cfg ]] && ok "grub.cfg 已生成（$(stat -c%s /boot/grub/grub.cfg) 字节）" || bad "grub.cfg 未生成"
else
  [[ "$MODE" == "check" ]] && info "--check 模式：未改动任何东西" || info "无需改动"
fi

hdr "9. 检查 Windows「快速启动」这个隐形杀手"
cat <<'EOT'
      强制关机之所以会让 Windows 自动修复抢走引导，根源是 Windows 的
      「快速启动(Fast Startup)」+「自动修复」组合。请在 **Windows 侧**关掉：
        · 控制面板 → 电源选项 → 选择电源按钮功能 → 更改当前不可用的设置
          → 取消勾选「启用快速启动」
        · 管理员 PowerShell：powercfg /h off      （顺带解决休眠导致的 NTFS 脏挂载）
        · 系统属性 → 高级 → 启动和故障恢复 → 设置 → 取消「自动重新启动」
      并建议在 BIOS 里把 ubuntu 放到 Windows Boot Manager 之前。
EOT

echo
if [[ "$MODE" == "check" ]]; then
  echo "${Y}===== --check 完成：以上为诊断结果，未做任何修改 =====${N}"
  echo "  执行修复： sudo bash tools/freeze-fix/fix-esp-grub.sh"
else
  echo "${G}===== 修复完成 ====="
  [[ -f "$FBACK" ]] && echo "  fstab 备份：$FBACK"
  echo "  自检：bash tools/freeze-fix/diagnose.sh   （第 6 节应全绿）"
  echo "  建议重启一次确认：sudo reboot"
fi
