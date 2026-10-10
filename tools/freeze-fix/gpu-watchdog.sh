#!/usr/bin/env bash
# ============================================================================
#  freeze-fix / gpu-watchdog.sh —— GPU 挂死看门狗（需要 root 安装为系统服务）
#
#  为什么需要它：
#    本机 GPU 挂死后 mutter 恢复不了（DisplayConfig D-Bus 超时），屏幕定格、只剩光标。
#    原来的处理方式是强制关机 —— 而强制关机正是「Windows 自动修复接管、重建 ESP、
#    篡改 GRUB 引导项」的起因。看门狗的目标：**让这种情况不再需要强制关机**。
#
#  判定逻辑（K 线双条件，避免误杀）：
#    A) 内核里出现 GPU 挂死标志：GPU HANG / Resetting chip for stopped heartbeat /
#       GUC: TLB invalidation response timed out
#    B) 之后 20 秒内，mutter 对 D-Bus 的 GetCurrentState 调用无响应（超时）
#    两条同时成立 → 认定「已冻结」，执行恢复动作。
#
#  恢复动作（可在 /etc/default/gpu-watchdog 里改）：
#    ACTION=gdm        （默认）干净重启图形会话：systemctl restart gdm
#                       → 你重新登录即可，比强制关机安全得多
#    ACTION=log        只记录，不动手（想先观察一段时间时用）
#    ACTION=reboot     systemctl reboot -f（会话恢复失败时的兜底，仍比硬断电干净）
#    ESCALATE=yes      gdm 重启后仍起不来时：再重启一次 gdm；两次都不行才 reboot -f
#                      （默认 yes。**绝不因为「用户会话不见了」就重启整机** —— 见 gdm_alive 注释）
#
#  多厂商：两个触发关键字集都监听（本仓库两台机器共用 ——
#    Intel MTL + Wayland / NVIDIA Legion + X11）。判定始终是「内核异常 + mutter 真冻结」
#    双条件，单个厂商的良性日志（如 Xid 13）不会单独触发恢复。
#
#  用法：
#    sudo bash tools/freeze-fix/gpu-watchdog.sh            # 安装 + 启动
#    sudo bash tools/freeze-fix/gpu-watchdog.sh --status   # 查看状态与历史
#    sudo bash tools/freeze-fix/gpu-watchdog.sh --test      # 干跑一次判定（不执行恢复）
#    sudo bash tools/freeze-fix/gpu-watchdog.sh --uninstall
# ============================================================================
set -uo pipefail
[[ $EUID -eq 0 ]] || { echo "需要 root：sudo bash $0 $*"; exit 1; }

SVC_NAME=gpu-watchdog
BIN=/usr/local/bin/${SVC_NAME}.sh
CONF=/etc/default/${SVC_NAME}
UNIT=/etc/systemd/system/${SVC_NAME}.service
LOG=/var/log/${SVC_NAME}.log

case "${1:-}" in
  --status)
    echo "===== 服务状态 ====="; systemctl --no-pager status ${SVC_NAME}.service 2>&1 | head -14
    echo; echo "===== 配置 ====="; cat "$CONF" 2>/dev/null || echo "(未安装)"
    echo; echo "===== 触发历史 ====="
    [[ -f "$LOG" ]] && grep -E 'TRIGGER|RECOVER|ESCALATE' "$LOG" | tail -20 || echo "(无)"
    exit 0 ;;
  --test)
    echo "===== 干跑判定（不会执行恢复动作） ====="
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u wukai 2>/dev/null || echo 1000)/bus"
    export DBUS_SESSION_BUS_ADDRESS
    echo "-- 1) mutter 响应性探测 --"
    if timeout 8 busctl --address="$DBUS_SESSION_BUS_ADDRESS" call \
         org.gnome.Mutter.DisplayConfig /org/gnome/Mutter/DisplayConfig \
         org.gnome.Mutter.DisplayConfig GetCurrentState >/dev/null 2>&1; then
      echo "   ✅ mutter 正常响应（当前未冻结）"
    else
      echo "   ❌ mutter 无响应 —— 若此刻同时有 GPU HANG 日志，就是冻结态"
    fi
    echo "-- 2) 最近 GPU 挂死日志 --"
    journalctl -k --no-pager 2>/dev/null | grep -E 'GPU HANG|Resetting chip for stopped heartbeat|TLB invalidation response timed out' | tail -3 | cut -c1-140
    exit 0 ;;
  --uninstall)
    systemctl disable --now ${SVC_NAME}.service 2>/dev/null
    rm -f "$UNIT" "$BIN"
    systemctl daemon-reload
    echo "✅ 已卸载（保留 $CONF 与 $LOG 便于回溯；要彻底删除：sudo rm -f $CONF $LOG）"
    exit 0 ;;
esac

echo "===== [1] 安装看门狗脚本 $BIN ====="
cat > "$BIN" <<'SCRIPT'
#!/usr/bin/env bash
# GPU 挂死看门狗 —— 由 tools/freeze-fix/gpu-watchdog.sh 安装
set -uo pipefail
CONF=/etc/default/gpu-watchdog
# shellcheck disable=SC1090
[[ -f "$CONF" ]] && . "$CONF"
ACTION="${ACTION:-gdm}"
ESCALATE="${ESCALATE:-yes}"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-8}"
GRACE="${GRACE:-20}"
USER_NAME="${USER_NAME:-wukai}"
LOG="${LOG:-/var/log/gpu-watchdog.log}"
# 同一次挂死会连发多条内核日志（seqno 递增），冷却期内不重复恢复，避免连环重启
RECOVER_COOLDOWN="${RECOVER_COOLDOWN:-180}"
LAST_RECOVER=0

log(){ echo "$(date '+%F %T') $*" | tee -a "$LOG" >/dev/null; echo "$(date '+%F %T') $*"; }

# 平台识别：本仓库两台机器共用（Intel MTL + Wayland / NVIDIA Legion + X11），
# 启动时把厂商打出来，日志一眼能看出这台该盯哪类关键字。
detect_platform(){
  local v
  v=$(lspci -nn 2>/dev/null | grep -iE 'vga|3d|display' \
      | grep -oE '\[(8086|10de|1002):[0-9a-f]{4}\]' | sed 's/\[//;s/\]//' \
      | cut -d: -f1 | sort -u | tr '\n' ' ')
  echo "${v:-未知}"
}

user_uid(){ id -u "$USER_NAME" 2>/dev/null || echo 1000; }
user_bus(){ echo "unix:path=/run/user/$(user_uid)/bus"; }

# mutter 是否还活着（能应答 D-Bus）
mutter_alive(){
  local addr; addr=$(user_bus)
  [[ -S "/run/user/$(user_uid)/bus" ]] || return 1
  timeout "$PROBE_TIMEOUT" busctl --address="$addr" call \
    org.gnome.Mutter.DisplayConfig /org/gnome/Mutter/DisplayConfig \
    org.gnome.Mutter.DisplayConfig GetCurrentState >/dev/null 2>&1
}

# gdm 自身是否还活着。
# **restart gdm 之后绝不能再用 mutter_alive 判断**：restart gdm 会把用户会话一起
# 销毁，用户总线上的 org.gnome.Mutter.DisplayConfig 必然不应答，于是「60s 后仍不健康」
# 永远成立 → 100% 走到 systemctl reboot -f。本机此前反复「莫名奇妙关机」就是这么来的。
gdm_alive(){
  systemctl is-active --quiet gdm 2>/dev/null || return 1
  pgrep -f '/usr/bin/gnome-shell' >/dev/null 2>&1
}

notify_user(){
  local addr; addr=$(user_bus)
  [[ -S "/run/user/$(user_uid)/bus" ]] || return 0
  timeout 5 busctl --address="$addr" call org.freedesktop.Notifications \
    /org/freedesktop/Notifications org.freedesktop.Notifications Notify \
    susssasa{sv}i "GPU 看门狗" 0 "" "检测到 GPU 挂死，正在恢复图形会话…" \
    '[]' '{}' 5000 >/dev/null 2>&1 || true
}

recover(){
  case "$ACTION" in
    log)
      log "RECOVER(跳过) ACTION=log，仅记录不动作" ;;
    reboot)
      log "RECOVER 执行 systemctl reboot -f"
      sync; systemctl reboot -f ;;
    gdm|*)
      log "RECOVER 执行 systemctl restart gdm（干净重启图形会话）"
      notify_user
      sync
      systemctl restart gdm ;;
  esac
}

log "===== 看门狗启动 ACTION=$ACTION ESCALATE=$ESCALATE GRACE=${GRACE}s ====="
log "平台：显卡厂商代码 = $(detect_platform)（8086=Intel / 10de=NVIDIA / 1002=AMD）"
log "监听内核日志：i915(GPU HANG / Resetting chip / TLB invalidation timeout) 与 NVRM(GPU has fallen off the bus / Xid)"

# -k 内核日志；-f 跟随；-n0 只看新行；--output=cat 去掉前缀
journalctl -k -f -n 0 --output=cat 2>/dev/null | while IFS= read -r line; do
  case "$line" in
    # Intel i915：TLB 超时 / 心跳停止复位 / GPU HANG
    # NVIDIA：GPU 掉总线 / NVRM Xid（Xid 本身可能是良性的，靠下面的 mutter 冻结门槛过滤）
    *"GPU HANG"*|*"Resetting chip for stopped heartbeat"*|*"TLB invalidation response timed out"*|*"GPU has fallen off the bus"*|*"NVRM: Xid"*)
      log "TRIGGER 捕获 GPU 异常：$(echo "$line" | cut -c1-120)"
      sleep "$GRACE"
      if mutter_alive; then
        log "OK 过了 ${GRACE}s mutter 仍健康 → 判定为可自愈，不动手"
        continue
      fi
      log "FROZEN mutter 无响应（DisplayConfig 探测超时）→ 确认冻结"
      now=$(date +%s)
      if (( now - LAST_RECOVER < RECOVER_COOLDOWN )); then
        log "SKIP 距上次恢复仅 $((now - LAST_RECOVER))s（同一轮挂死的后续日志），不重复动作"
        continue
      fi
      LAST_RECOVER=$now
      recover
      if [[ "$ESCALATE" == "yes" && "$ACTION" != "log" && "$ACTION" != "reboot" ]]; then
        sleep 60
        if gdm_alive; then
          log "OK gdm 已拉起（登录界面已重建）→ 不做整机重启，重新登录即可"
        else
          log "ESCALATE gdm 重启后 60s 仍未拉起 → 再重启一次 gdm（仍不动整机）"
          systemctl restart gdm
          sleep 30
          if gdm_alive; then
            log "OK 第二次重启 gdm 后已拉起 → 不做整机重启"
          else
            log "ESCALATE-2 gdm 两次都起不来（图形栈真挂了）→ 最后手段 systemctl reboot -f"
            sync; systemctl reboot -f
          fi
        fi
      fi
      ;;
  esac
done
SCRIPT
chmod +x "$BIN"
echo "  ✅ $BIN"

echo
echo "===== [2] 写入配置 $CONF ====="
if [[ ! -f "$CONF" ]]; then
  cat > "$CONF" <<EOF
# GPU 挂死看门狗配置
# ACTION: gdm(默认，干净重启图形会话) | log(只记录) | reboot(强制重启系统)
ACTION=gdm
# ESCALATE=yes: 重启 gdm 后 60s 仍不健康 → 自动 systemctl reboot -f
ESCALATE=yes
# 出现 GPU 异常后等待多少秒再判定是否真的冻结
GRACE=20
# mutter D-Bus 探测超时（秒）
PROBE_TIMEOUT=8
# 桌面用户名（用于探测其会话总线）
USER_NAME=${SUDO_USER:-wukai}
EOF
  echo "  ✅ 已生成默认配置"
else
  echo "  ℹ️  已存在，保留你的设置（要改请编辑 $CONF）"
fi
grep -vE '^\s*#|^\s*$' "$CONF" | sed 's/^/      /'

echo
echo "===== [3] 安装 systemd 服务 ====="
cat > "$UNIT" <<EOF
[Unit]
Description=GPU 挂死看门狗（i915 GPU HANG / TLB 超时 · NVRM Xid + mutter 无响应 → 自动恢复图形会话）
Documentation=file://$(cd "$(dirname "$0")" && pwd)/README.md
After=multi-user.target network.target
Wants=multi-user.target

[Service]
Type=simple
ExecStart=$BIN
Restart=always
RestartSec=5
Nice=-5
# 只读系统 + 一个日志文件
ReadWritePaths=/var/log
StandardOutput=journal
StandardError=journal
SyslogIdentifier=gpu-watchdog

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now ${SVC_NAME}.service 2>&1 | tail -2
sleep 2
systemctl --no-pager status ${SVC_NAME}.service 2>&1 | head -8

cat <<EOT

===== 完成 =====
  ✅ 服务已安装并启动：${SVC_NAME}.service
  📄 日志：journalctl -u ${SVC_NAME} -f      或   tail -f $LOG
  🔧 配置：$CONF（改完 systemctl restart ${SVC_NAME}）

  行为：GPU 挂死 + mutter 无响应 → 自动 systemctl restart gdm（你重新登录即可），
        不再需要长按电源键强制关机 —— 从而不会再触发 Windows 自动修复抢引导。

  对比检查：sudo bash tools/freeze-fix/gpu-watchdog.sh --status
  卸载：    sudo bash tools/freeze-fix/gpu-watchdog.sh --uninstall
EOT
