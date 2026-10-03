#!/usr/bin/env bash
# ============================================================================
#  dsh-petctl —— 两只桌宠的统一控制器
# ----------------------------------------------------------------------------
#  管理对象：
#    · dsh     DSH 余额小鲸鱼桌面挂件（Electron，AppImage）
#    · live2d  Live2D 鲸鱼娘桌宠（Coopanion / Cortico 桌宠）
#
#  用法：
#    dsh-petctl status                     # 机器可读状态（key=value）
#    dsh-petctl dsh    start|stop|restart|toggle
#    dsh-petctl live2d start|stop|restart|toggle
#    dsh-petctl autostart on|off|status    # 两只一起；也可 autostart dsh on
#    dsh-petctl balance                    # 读本地服务的余额（dsh 在跑才有）
#    dsh-petctl gpu status|mitigate|pausedump
#    dsh-petctl install                    # 装到 ~/.local/bin + 建桌面/自启入口
#
#  设计说明：
#    1. 所有子命令都是幂等的，状态由 pidfile + pgrep 双重判定（pidfile 可能过期）。
#    2. 启动一律 setsid 起新进程组，停止用 进程组信号，避免留下 --pet-host 之类的孤儿。
#    3. XWayland 是硬要求：桌宠的点击穿透依赖只有 X11 才有的 setShape()。
#       两个应用都强制 ELECTRON_OZONE_PLATFORM_HINT=x11 + --ozone-platform=x11。
# ============================================================================
set -uo pipefail

CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dsh-whale"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/dsh-whale"
CONF="$CONF_DIR/petctl.conf"
AUTOSTART_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$STATE_DIR" "$STATE_DIR/logs"

# ---------------------------------------------------------------- 定位仓库
[ -r "$CONF" ] && . "$CONF"
if [ -z "${REPO_ROOT:-}" ]; then
  self="$(readlink -f "${BASH_SOURCE[0]}")"
  cand="$(dirname "$(dirname "$self")")"
  if [ -d "$cand/dsh-whale-desktop-linux" ]; then REPO_ROOT="$cand"; fi
fi
REPO_ROOT="${REPO_ROOT:-$HOME/dsh-whale}"
COOP_DIR="${COOP_DIR:-$REPO_ROOT/third-party/Coopanion}"

DSH_LOG="$STATE_DIR/logs/dsh.log"
L2D_LOG="$STATE_DIR/logs/live2d.log"
DSH_PID="$STATE_DIR/dsh.pid"
L2D_PID="$STATE_DIR/live2d.pid"

# ---------------------------------------------------------------- 查找可执行
find_appimage() {
  # 多个候选时取**最新修改**的那份（开发时是新构建，日常是 ~/Applications 的安装副本）
  local c newest="" newest_t=0 t
  for c in "$REPO_ROOT/dsh-whale-desktop-linux/dist"/*.AppImage \
           "$HOME/Applications"/*dsh-whale*.AppImage \
           "$HOME/Applications"/*dsh*widget*.AppImage; do
    [ -x "$c" ] || continue
    t="$(stat -c %Y "$c" 2>/dev/null || echo 0)"
    if [ "$t" -gt "$newest_t" ]; then newest="$c"; newest_t="$t"; fi
  done
  [ -n "$newest" ] && { echo "$newest"; return 0; }
  return 1
}
APPIMAGE="$(find_appimage || true)"
ELECTRON_BIN="$COOP_DIR/node_modules/electron/dist/electron"

# ---------------------------------------------------------------- 状态判定
# 进程在不在：优先看进程组还活着，其次按命令行模式匹配
alive_group() {
  local pf="$1" pg
  pg="$(cat "$pf" 2>/dev/null || true)"
  [ -n "$pg" ] || return 1
  kill -0 "-$pg" 2>/dev/null
}
find_dsh_pids() {
  pgrep -f 'appimage_extracted_.*/dsh-whale-desktop-linux|dsh-whale-widget-[0-9.]+-x86_64\.AppImage' 2>/dev/null
}
find_l2d_pids() {
  pgrep -f "${COOP_DIR//\//\\/}/node_modules/electron/dist/electron|--pet-host|--pet-url" 2>/dev/null
}
dsh_running()   { alive_group "$DSH_PID" || [ -n "$(find_dsh_pids)" ]; }
l2d_running()   { alive_group "$L2D_PID" || [ -n "$(find_l2d_pids)" ]; }

# ============================================================================
#  启动 / 停止
# ============================================================================
start_dsh() {
  if dsh_running; then
    # 有窗口但进程在 → 让它 visible
    echo "dsh=already-running"
    return 0
  fi
  if [ -z "$APPIMAGE" ]; then echo "dsh=error:AppImage-not-found" >&2; return 1; fi
  # AppImage 自带 --no-sandbox / --ozone-platform 由 main.js 自己重启补上，这里只兜底
  # APPIMAGE_EXTRACT_AND_RUN=1：本机没有 FUSE，必须解包运行（否则 AppImage 直接报错退出）
  setsid nohup env APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGE" --no-sandbox >>"$DSH_LOG" 2>&1 &
  echo $! > "$DSH_PID"
  echo "dsh=starting pid=$!"
}

start_live2d() {
  if l2d_running; then echo "live2d=already-running"; return 0; fi
  if [ ! -x "$ELECTRON_BIN" ]; then
    echo "live2d=error:electron-not-installed（先跑 tools/setup-coopanion.sh）" >&2
    return 1
  fi
  # 环境变量让子 Electron（--pet-host）也走 XWayland；主进程另行补命令行参数
  setsid nohup env ELECTRON_OZONE_PLATFORM_HINT=x11 \
    "$ELECTRON_BIN" "$COOP_DIR" \
    >>"$L2D_LOG" 2>&1 &
  echo $! > "$L2D_PID"
  echo "live2d=starting pid=$!"
}

stop_dsh() {
  local pids
  pids="$(find_dsh_pids)"
  if [ -n "$pids" ]; then
    kill -TERM $pids 2>/dev/null
    sleep 2
    pids="$(find_dsh_pids)"
    [ -n "$pids" ] && kill -KILL $pids 2>/dev/null
  fi
  rm -f "$DSH_PID"
  echo "dsh=stopped"
}

stop_live2d() {
  local pids
  pids="$(find_l2d_pids)"
  if [ -n "$pids" ]; then
    kill -TERM $pids 2>/dev/null
    sleep 3
    pids="$(find_l2d_pids)"
    [ -n "$pids" ] && kill -KILL $pids 2>/dev/null
  fi
  # Coopanion 有时会留下独立的 core 进程
  pkill -f "cortico-world" 2>/dev/null || true
  rm -f "$L2D_PID"
  echo "live2d=stopped"
}

# ============================================================================
#  自启（XDG autostart）
# ============================================================================
autostart_file() { echo "$AUTOSTART_DIR/dsh-whale-$1.desktop"; }

write_autostart() {
  local which="$1" f name exec comment icon
  f="$(autostart_file "$which")"
  if [ "$which" = "dsh" ]; then
    name="DSH 小鲸鱼（开机自启）"
    exec="$REPO_ROOT/tools/petctl.sh dsh start"
    comment="DeepSeek 余额小鲸鱼桌面挂件"
    icon="$REPO_ROOT/dsh-whale-desktop-linux/assets/whale.png"
  else
    name="Live2D 鲸鱼娘（开机自启）"
    exec="$REPO_ROOT/tools/petctl.sh live2d start"
    comment="Coopanion Live2D 鲸鱼娘桌宠"
    icon="$REPO_ROOT/third-party/Coopanion/console/assets/icon.png"
  fi
  mkdir -p "$AUTOSTART_DIR"
  cat > "$f" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=$name
Comment=$comment
Exec=$exec
Icon=$icon
Terminal=false
X-GNOME-Autostart-enabled=true
StartupNotify=false
# 延迟启动：等 GNOME Shell / 合成器就绪，避免开机时抢资源导致 GPU 异常
X-GNOME-Autostart-Delay=$([ "$which" = dsh ] && echo 8 || echo 15)
EOF
  echo "$which-autostart=on（$f）"
}

remove_autostart() {
  rm -f "$(autostart_file "$1")"
  echo "$1-autostart=off"
}

autostart_state() {
  [ -f "$(autostart_file "$1")" ] && echo on || echo off
}

# ============================================================================
#  GPU 健康（i915 GPU hang 是本机「画面冻死只剩鼠标」的确认根因）
# ============================================================================
gpu_hang_count() {
  # 本 boot 内 GPU HANG / hangcheck 次数
  # 注意：grep -c 无匹配时会同时「输出 0」并「退出码 1」，写成 `|| echo 0` 会多打一行 0
  local n
  n="$(journalctl -b --no-pager 2>/dev/null \
    | grep -icE 'GPU HANG|stopped heartbeat|TLB invalidation response timed out')"
  echo "${n:-0}"
}
gpu_last_hang() {
  journalctl -b --no-pager 2>/dev/null \
    | grep -E 'GPU HANG|stopped heartbeat' | tail -1 \
    | sed -E 's/^([A-Za-z0-9]+ [0-9]+ [0-9:]+).*/\1/' || true
}
gpu_errstate() {
  # 内核保存的 GPU error state（存在即说明本 boot 出过 GPU 错误）
  local c found=no
  for c in /sys/class/drm/card*/error; do
    [ -r "$c" ] || continue
    if [ -s "$c" ]; then found="yes:$(basename "$(dirname "$c")")"; fi
  done
  echo "$found"
}

gpu_cmd() {
  case "${1:-status}" in
    status)
      echo "gpu_hang_count=$(gpu_hang_count)"
      echo "gpu_last_hang=$(gpu_last_hang)"
      echo "gpu_error_state=$(gpu_errstate)"
      if [ "$(gpu_hang_count)" -gt 0 ] 2>/dev/null; then
        echo "gpu_health=degraded"
      else
        echo "gpu_health=ok"
      fi
      ;;
    mitigate)
      cat <<'MIT'
本机 GPU hang 的已知缓解手段（需要 sudo，逐条执行后再观察）：

  # 1) 关掉 PSR / PSR2（Meteor Lake 上最常见的 hang 源）
  sudo sed -i 's/^GRUB_CMDLINE_LINUX_DEFAULT="/GRUB_CMDLINE_LINUX_DEFAULT="i915.enable_psr=0 i915.enable_psr2_sel_fetch=0 /' /etc/default/grub
  # 2) 关 Display C-states 与 FBC（另一组已知 hang 源）
  sudo sed -i 's/^GRUB_CMDLINE_LINUX_DEFAULT="/GRUB_CMDLINE_LINUX_DEFAULT="i915.enable_dc=0 i915.enable_fbc=0 /' /etc/default/grub
  # 3) 让心跳检测更容易触发恢复（默认 60s）
  echo 10 | sudo tee /sys/module/i915/parameters/hangcheck_period_ms 2>/dev/null || true

  sudo update-grub && sudo reboot

验证（重启后）：
  cat /proc/cmdline | tr ' ' '\n' | grep i915
  dsh-petctl gpu status        # gpu_hang_count 应为 0

注意：以上会牺牲一点续航（PSR/FBC/DC 都是省电特性），但换来图形稳定。
若仍 hang，请把 /sys/class/drm/card*/error 与 journalctl -b | grep i915 的内容留档上报内核 issue。
MIT
      ;;
    pausedump)
      echo "--- /proc/cmdline ---"; cat /proc/cmdline
      echo "--- i915 参数 ---"
      for f in /sys/module/i915/parameters/enable_psr \
               /sys/module/i915/parameters/enable_psr2_sel_fetch \
               /sys/module/i915/parameters/enable_dc \
               /sys/module/i915/parameters/enable_fbc \
               /sys/module/i915/parameters/enable_hangcheck; do
        [ -r "$f" ] && echo "$(basename "$f") = $(cat "$f")"
      done
      echo "--- 最近 GPU 事件 ---"
      journalctl -b --no-pager 2>/dev/null \
        | grep -iE 'i915|GPU HANG|drm' | tail -20
      ;;
    *) echo "用法：dsh-petctl gpu status|mitigate|pausedump" >&2; return 2 ;;
  esac
}

# ============================================================================
#  install：装到 ~/.local/bin，建桌面入口 + 自启项
# ============================================================================
install_cmd() {
  mkdir -p "$CONF_DIR" "$BIN_DIR" "$APPLICATIONS_DIR" "$STATE_DIR/logs"
  cat > "$CONF" <<EOF
# dsh-petctl 配置（install 时生成）
REPO_ROOT="$REPO_ROOT"
COOP_DIR="$COOP_DIR"
EOF
  # 自身软链到 PATH
  ln -sf "$REPO_ROOT/tools/petctl.sh" "$BIN_DIR/dsh-petctl"
  chmod +x "$REPO_ROOT/tools/petctl.sh"
  echo "已安装：$BIN_DIR/dsh-petctl -> $REPO_ROOT/tools/petctl.sh"

  # ---- Live2D 的桌面入口（开始菜单）----
  cat > "$APPLICATIONS_DIR/dsh-whale-live2d.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Live2D 鲸鱼娘
GenericName=桌面宠物
Comment=Coopanion Live2D 鲸鱼娘桌宠（DeepSeek 大肥鱼形象）
Exec=$REPO_ROOT/tools/petctl.sh live2d toggle
Icon=$COOP_DIR/console/assets/icon.png
Terminal=false
Categories=Utility;
Keywords=pet;live2d;desktop;whale;
StartupNotify=false
EOF
  echo "已建开始菜单项：Live2D 鲸鱼娘"

  # ---- DSH 余额挂件的桌面入口（开始菜单）----
  # 图标优先用 AppImage 解包时的 png，其次仓库 assets
  local dsh_icon="$REPO_ROOT/dsh-whale-desktop-linux/assets/whale.png"
  cat > "$APPLICATIONS_DIR/dsh-whale.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=DSH 小鲸鱼
GenericName=桌面挂件
Comment=DeepSeek 余额小鲸鱼桌面挂件（Electron 桌面版）
Exec=$REPO_ROOT/tools/petctl.sh dsh toggle
Icon=$dsh_icon
Terminal=false
Categories=Utility;
Keywords=deepseek;whale;balance;pet;
StartupNotify=false
EOF
  echo "已建开始菜单项：DSH 小鲸鱼 → petctl dsh toggle"

  # ---- 清理旧方案残留（旧 GNOME 扩展版入口）----
  local legacy="$APPLICATIONS_DIR/dsh-whale-widget.desktop"
  if [ -f "$legacy" ]; then
    rm -f "$legacy" && echo "已删除旧入口：$legacy"
  fi
  # 旧自启项名字与本工具不同，留着会让 dsh 开机启动两遍
  local legacy_auto="$AUTOSTART_DIR/dsh-whale-widget.desktop"
  if [ -f "$legacy_auto" ]; then
    local was_on=no
    grep -q 'X-GNOME-Autostart-enabled=true' "$legacy_auto" 2>/dev/null && was_on=yes
    rm -f "$legacy_auto" && echo "已删除旧自启项：$legacy_auto"
    if [ "$was_on" = yes ]; then
      write_autostart dsh >/dev/null && echo "已迁移为：$(autostart_file dsh)"
    fi
  fi
  if [ -f "$BIN_DIR/dsh-whale-widget" ]; then
    mv "$BIN_DIR/dsh-whale-widget" "$BIN_DIR/dsh-whale-widget.legacy-disabled" 2>/dev/null \
      && echo "已停用旧脚本：$BIN_DIR/dsh-whale-widget（改名为 .legacy-disabled，未删除以便回退）"
  fi
  # 旧 GNOME 扩展：禁用（源仍在仓库里，便于回退）
  if command -v gnome-extensions >/dev/null 2>&1; then
    if gnome-extensions list 2>/dev/null | grep -q '^dsh-whale@local$'; then
      gnome-extensions disable dsh-whale@local >/dev/null 2>&1 || true
      echo "已禁用旧 GNOME 扩展：dsh-whale@local"
    fi
  fi
  command -v update-desktop-database >/dev/null 2>&1 && \
    update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
  exit 0
}

# ============================================================================
#  主命令分发
# ============================================================================
cmd="${1:-status}"; shift || true

case "$cmd" in
  status)
    if dsh_running; then echo "dsh=running"; else echo "dsh=stopped"; fi
    if l2d_running; then echo "live2d=running"; else echo "live2d=stopped"; fi
    echo "dsh_autostart=$(autostart_state dsh)"
    echo "live2d_autostart=$(autostart_state live2d)"
    echo "gpu_health=$( [ "$(gpu_hang_count)" -gt 0 ] 2>/dev/null && echo degraded || echo ok)"
    echo "gpu_hang_count=$(gpu_hang_count)"
    ;;
  balance)
    # 本地服务端口可能因占用而回退（3090..3098）
    for p in 3090 3091 3092 3093 3094 3095 3096 3097 3098; do
      out="$(curl -s --max-time 2 "http://127.0.0.1:$p/dsh-whale/balance.json" 2>/dev/null)"
      if [ -n "$out" ]; then echo "$out"; exit 0; fi
    done
    echo '{"error":"本地服务未响应（dsh 挂件没在跑？）"}'
    exit 1
    ;;
  dsh)
    case "${1:-toggle}" in
      start)   start_dsh ;;
      stop)    stop_dsh ;;
      restart) stop_dsh >/dev/null; sleep 1; start_dsh ;;
      toggle)  if dsh_running; then stop_dsh; else start_dsh; fi ;;
      *) echo "用法：dsh-petctl dsh start|stop|restart|toggle" >&2; exit 2 ;;
    esac
    ;;
  live2d)
    case "${1:-toggle}" in
      start)   start_live2d ;;
      stop)    stop_live2d ;;
      restart) stop_live2d >/dev/null; sleep 2; start_live2d ;;
      toggle)  if l2d_running; then stop_live2d; else start_live2d; fi ;;
      *) echo "用法：dsh-petctl live2d start|stop|restart|toggle" >&2; exit 2 ;;
    esac
    ;;
  autostart)
    # autostart on|off|status  或  autostart dsh on
    case "${1:-status}" in
      on|off)
        for w in dsh live2d; do
          if [ "$1" = on ]; then write_autostart "$w" >/dev/null; else remove_autostart "$w" >/dev/null; fi
        done
        echo "dsh_autostart=$(autostart_state dsh)"
        echo "live2d_autostart=$(autostart_state live2d)"
        ;;
      dsh|live2d)
        case "${2:-status}" in
          on)     write_autostart "$1" ;;
          off)    remove_autostart "$1" ;;
          status) echo "$1_autostart=$(autostart_state "$1")" ;;
          *) echo "用法：dsh-petctl autostart $1 on|off|status" >&2; exit 2 ;;
        esac
        ;;
      status)
        echo "dsh_autostart=$(autostart_state dsh)"
        echo "live2d_autostart=$(autostart_state live2d)"
        ;;
      *) echo "用法：dsh-petctl autostart [dsh|live2d] on|off|status" >&2; exit 2 ;;
    esac
    ;;
  gpu)   gpu_cmd "${1:-status}" ;;
  pause)
    # 一键省 GPU：两只都停（用户手动恢复）
    stop_live2d >/dev/null; stop_dsh >/dev/null
    echo "两只桌宠已暂停（dsh-petctl resume 恢复）"
    ;;
  resume)
    start_live2d >/dev/null; start_dsh >/dev/null
    echo "两只桌宠已恢复"
    ;;
  install) install_cmd ;;
  *)
    cat <<USAGE
dsh-petctl —— DSH 小鲸鱼 + Live2D 鲸鱼娘 统一控制器

  status                              状态（key=value，脚本友好）
  balance                             读余额（需 dsh 挂件在跑）
  dsh    start|stop|restart|toggle    控制 DSH 余额挂件
  live2d start|stop|restart|toggle    控制 Live2D 鲸鱼娘
  autostart [dsh|live2d] on|off|status 开机自启
  pause | resume                      一键暂停/恢复两只（省 GPU）
  gpu    status|mitigate|pausedump    GPU hang 诊断与缓解
  install                             安装到 ~/.local/bin 并建桌面入口
USAGE
    exit 2
    ;;
esac
