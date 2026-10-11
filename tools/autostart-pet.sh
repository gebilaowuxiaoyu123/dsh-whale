#!/usr/bin/env bash
# ============================================================================
#  autostart-pet.sh —— 开机自启的稳妥入口（供 ~/.config/autostart/*.desktop 调用）
#
#  为什么不直接写 `petctl.sh live2d start`：
#    开机阶段图形会话还在起，直接拉 Electron 桌宠很容易死掉，而已有的失败是
#    **静默**的（GNOME 不会重试也不会提示），外观上就是「自启没生效」。
#    本脚本做三件事，把这种“静默失败”变成“等一等、再试几次、并且留下日志”：
#      ① 等图形会话真正就绪（会话总线在、mutter 能应答、DISPLAY 可用）
#      ② 调用 petctl 启动，失败则退避重试（最多 4 次）
#      ③ 全程写日志到 $XDG_STATE_HOME/dsh-whale/logs/autostart.log
#
#  用法（在 .desktop 的 Exec 里）：
#    $HOME/dsh-whale/tools/autostart-pet.sh live2d
#    $HOME/dsh-whale/tools/autostart-pet.sh dsh
#  手动测试：
#    bash tools/autostart-pet.sh live2d --now    # 跳过等待，立刻起
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-live2d}"
NOW="${2:-}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/dsh-whale"
LOG="$STATE_DIR/logs/autostart.log"
mkdir -p "$(dirname "$LOG")"

log() { echo "$(date '+%F %T') [$TARGET] $*" >>"$LOG"; echo "$(date '+%F %T') [$TARGET] $*"; }

log "===== 自启开始（DISPLAY=${DISPLAY:-无} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-无}）====="

# ---- ① 等图形会话就绪 --------------------------------------------------------
wait_ready() {
  local i
  for i in $(seq 1 30); do
    # 会话总线出现
    if [[ ! -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus" ]]; then sleep 2; continue; fi
    # mutter 能应答（说明合成器已就绪；这正是 GPU 挂死时卡住的那个接口）
    # 通知服务（gnome-shell 接管 org.freedesktop.Notifications）也要等：
    # 登录初期它还没接管时启动桌宠，日志里会刷
    #   libnotify-WARNING **: Failed to connect to proxy
    #   notify_notification_show: The name org.freedesktop.Notifications was not provided
    # 最多多等 20 秒；仍等不到就不阻塞启动。
    if [[ $i -le 10 ]] && command -v busctl >/dev/null 2>&1; then
      if ! timeout 3 busctl --user status org.freedesktop.Notifications >/dev/null 2>&1; then
        sleep 2
        continue
      fi
    fi
    if command -v busctl >/dev/null 2>&1; then
      if timeout 5 busctl --user call org.gnome.Mutter.DisplayConfig \
           /org/gnome/Mutter/DisplayConfig org.gnome.Mutter.DisplayConfig \
           GetCurrentState >/dev/null 2>&1; then
        log "图形会话已就绪（等待 ${i} 轮）"
        return 0
      fi
    else
      # 没有 busctl 就退化为「等 12 秒」
      [[ $i -ge 6 ]] && { log "无 busctl，按固定等待继续"; return 0; }
    fi
    sleep 2
  done
  log "警告：等不到 mutter 应答（GPU 有问题？），仍继续尝试启动"
  return 0
}

if [[ "$NOW" != "--now" ]]; then wait_ready; fi

# ---- ② 启动并退避重试 --------------------------------------------------------
RETRY_DELAYS=(3 6 12)
attempt=0
while :; do
  attempt=$((attempt + 1))
  out="$(bash "$HERE/petctl.sh" "$TARGET" start 2>&1)"
  rc=$?
  log "第 $attempt 次启动：$out"
  if [[ $rc -eq 0 ]] && ! echo "$out" | grep -q '=error'; then
    log "启动成功 ✅"
    exit 0
  fi

  # 已经因为同名实例在跑而被跳过，也算成功
  if echo "$out" | grep -q 'already-running'; then
    log "已在运行，无需再启 ✅"
    exit 0
  fi

  if [[ $attempt -gt ${#RETRY_DELAYS[@]} ]]; then
    log "重试 $attempt 次仍失败 ❌（手动排查：bash $HERE/petctl.sh $TARGET start）"
    exit 1
  fi
  local_delay="${RETRY_DELAYS[$((attempt - 1))]}"
  log "失败，${local_delay}s 后重试…"
  sleep "$local_delay"
done
