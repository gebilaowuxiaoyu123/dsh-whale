#!/usr/bin/env bash
# 鼠标跟随透明度（X11 版）——预制件，未在 Linux 实机验证
#
# 与 Windows 版 tools/desktop-mouse-fade.ps1 同思路：鼠标不在目标窗口上时把它调成"离开时的不透明度"，
# 移入时恢复成"悬停时的不透明度"，两个状态之间平滑过渡。
# 实现手段：EWMH 的 _NET_WM_WINDOW_OPACITY（需要合成器：picom / KWin / Mutter / xfwm4 合成模式）。
#
# 依赖：xdotool（取鼠标位置、窗口几何、移动窗口）、xprop（X11 自带）
# 用法：./mouse-fade-x11.sh [--status] [--restore] [--window <窗口id>]
# 配置：默认读 tools/mouse-fade.config.json（和 Windows 版共用同一份）
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="$REPO/tools/mouse-fade.config.json"
AWAIT_TARGET="${AWAIT_TARGET:-Pogget}"     # 目标窗口的标题关键字（xdotool search --name）

OPACITY_AWAY=0.35
OPACITY_OVER=1.0
FADE_MS=450
POLL_MS=100

if [ -f "$CFG" ]; then
  OPACITY_AWAY=$(grep -o '"OpacityAway"[^,}]*' "$CFG" | grep -o '[0-9.]*$' || echo "$OPACITY_AWAY")
  OPACITY_OVER=$(grep -o '"OpacityOver"[^,}]*' "$CFG" | grep -o '[0-9.]*$' || echo "$OPACITY_OVER")
  FADE_MS=$(grep -o '"FadeMs"[^,}]*' "$CFG" | grep -o '[0-9]*' || echo "$FADE_MS")
fi

command -v xdotool >/dev/null || { echo "缺 xdotool：sudo apt install xdotool"; exit 1; }
command -v xprop   >/dev/null || { echo "缺 xprop：sudo apt install x11-utils"; exit 1; }
if ! xprop -root _NET_SUPPORTING_WM_CHECK >/dev/null 2>&1; then
  echo "警告：看起来没有窗口管理器/合成器，透明度很可能不生效"
fi

to_alpha() {  # 0..1 → 0xRRGGBBAA 里的 AA（0x00-0xFF 大写）
  local v
  v=$(awk -v f="$1" 'BEGIN{printf "%02X", (f*255+0.5)}')
  echo "$v"
}

set_opacity() {  # 窗口id alpha(00-FF)
  xprop -id "$1" -f _NET_WM_WINDOW_OPACITY 32c -set _NET_WM_WINDOW_OPACITY "0x${2}${2}${2}${2}" >/dev/null 2>&1
}

find_window() {
  xdotool search --name "$AWAIT_TARGET" 2>/dev/null | tail -n 1
}

status() {
  local w; w=$(find_window)
  echo "配置: 离开=$OPACITY_AWAY 悬停=$OPACITY_OVER 过渡=${FADE_MS}ms（$CFG）"
  if [ -z "$w" ]; then echo "目标窗口：没找到（关键字 $AWAIT_TARGET）"; return; fi
  echo "目标窗口: $w  $(xdotool getwindowname "$w" 2>/dev/null)"
  xdotool getwindowgeometry --shell "$w" | tr '\n' ' '; echo
  xprop -id "$w" _NET_WM_WINDOW_OPACITY 2>/dev/null || echo "（当前未设置透明度）"
}

restore() {
  local w; w=$(find_window)
  [ -z "$w" ] && { echo "没找到窗口"; return; }
  xprop -id "$w" -remove _NET_WM_WINDOW_OPACITY >/dev/null 2>&1
  echo "已还原为不透明：$w"
}

floats() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.4f", a+b}'; }

main() {
  echo "鼠标跟随透明度（X11 预制件）。Ctrl+C 退出。目标关键字：$AWAIT_TARGET"
  local win="" cur=255 tgt=255 awayA overA step inloop gap
  awayA=$((16#$(to_alpha "$OPACITY_AWAY")))
  overA=$((16#$(to_alpha "$OPACITY_OVER")))
  step=$((255 * 8 / (FADE_MS > 0 ? FADE_MS : 1) ))
  [ "$step" -lt 1 ] && step=1
  gap=$((POLL_MS / 1000)); [ "$gap" -lt 1 ] && gap=1
  while true; do
    if [ -z "$win" ] || ! xdotool getwindowname "$win" >/dev/null 2>&1; then
      win=$(find_window)
      [ -z "$win" ] && { sleep 2; continue; }
      echo "接管窗口 $win $(xdotool getwindowname "$win" 2>/dev/null)"
      eval "$(xdotool getwindowgeometry --shell "$win")"   # X / Y / WIDTH / HEIGHT
      cur=255; set_opacity "$win" FF
    fi
    local mx my
    eval "$(xdotool getmouselocation --shell)"            # X / Y / WINDOW
    eval "$(xdotool getwindowgeometry --shell "$win")"
    if [ "$mx" -ge "$X" ] && [ "$mx" -lt $((X + WIDTH)) ] && [ "$my" -ge "$Y" ] && [ "$my" -lt $((Y + HEIGHT)) ]; then
      tgt=$overA
    else
      tgt=$awayA
    fi
    if [ "$cur" -ne "$tgt" ]; then
      if [ "$cur" -lt "$tgt" ]; then
        cur=$((cur + step)); [ "$cur" -gt "$tgt" ] && cur=$tgt
      else
        cur=$((cur - step)); [ "$cur" -lt "$tgt" ] && cur=$tgt
      fi
      set_opacity "$win" "$(printf '%02X' "$cur")"
      sleep 0.008     # ~120Hz 采样，和 Windows 版观感对齐
    else
      sleep "$gap"
    fi
  done
}

case "${1:---run}" in
  --status)  status ;;
  --restore) restore ;;
  --run|"")  main ;;
  *) echo "用法: $0 [--run|--status|--restore]"; exit 1 ;;
esac
