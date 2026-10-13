#!/usr/bin/env bash
# 桌面插件 Linux 版「开机分级启动」——预制件（未在 Linux 实机验证，首次用请先 --dry-run）
# 逻辑与 Windows 版 tools/desktop-suite-boot-order.ps1 一致：
#   按顺序启动 → 等上一步进程真的出现 → 再空一段间隔 → 下一步；缺插件自动跳过；全过程写时间戳日志
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITE="$REPO/desktop-suite"
RUNTIME="$SUITE/_runtime/boot-order"
LOG="$RUNTIME/boot-order.log"
AUTOSTART_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
MY_DESKTOP="$AUTOSTART_DIR/dsh-boot-order.desktop"

# 顺序表：名称 | 插件目录(相对 desktop-suite) | 启动命令(相对插件目录) | 就绪判定关键字(pgrep -f) | 等就绪秒 | 额外间隔秒
# 说明：动态壁纸（MiSide Unity）是 Windows 产物，Linux 上换用原生壁纸方案，因此这里不含壁纸一段。
STAGES=(
  "dsh 小鲸鱼桌面版|dsh-whale/dsh-whale-desktop-linux|./start-linux.sh|dsh-whale-widget|30|6"
  "Coopanion 桌宠|coopanion|node_modules/electron/dist/electron .|coopanion|35|6"
  "XSpace 竞赛通知栏|xspace|XSpaceWidget/bin/Debug/net9.0-windows/win-x64/XSpaceWidget.exe|XSpaceWidget|20|4"
  "Pogget 桌面容器|pogget|Pogget.exe|Pogget|20|4"
  "鼠标跟随透明度助手|..|../linux/mouse-fade-x11.sh|mouse-fade-x11|5|0"
)

log() {
  mkdir -p "$RUNTIME" 2>/dev/null || true
  printf '%s  %s\n' "$(date '+%H:%M:%S.%3N')" "$1" | tee -a "$LOG" 2>/dev/null || printf '  %s\n' "$1"
}

ready() {  # 参数：关键字
  pgrep -f "$1" >/dev/null 2>&1
}

wait_ready() {  # 参数：关键字 超时秒
  local key="$1" limit="$2" i=0
  while [ "$i" -lt $((limit * 5)) ]; do
    ready "$key" && return 0
    sleep 0.2
    i=$((i + 1))
  done
  return 1
}

run_stages() {
  local dry="$1"
  log "===== 分级启动开始（$([ "$dry" = 1 ] && echo "dry-run" || echo "run")）====="
  local t0 step=0 name dir cmd key wsec gap base exe
  t0=$(date +%s)
  for row in "${STAGES[@]}"; do
    step=$((step + 1))
    IFS='|' read -r name dir cmd key wsec gap <<< "$row"
    base="$SUITE/$dir"
    exe="$base/$cmd"
    if [ ! -e "$base" ] || { [ "$dir" != ".." ] && [ ! -e "$exe" ]; }; then
      log "[$step] 跳过：本机没有这个插件（$dir）"
      continue
    fi
    if [ "$dry" = 1 ]; then
      log "[$step] $name —— 会启动（等 ${wsec}s + 空 ${gap}s）"
      continue
    fi
    log "[$step] $name —— 启动：$cmd"
    ( cd "$base" && setsid nohup bash -c "$cmd" >/dev/null 2>&1 & ) || log "[$step] 启动失败"
    if wait_ready "$key" "$wsec"; then
      log "[$step] $name —— 进程已就绪（累计 $(( $(date +%s) - t0 ))s）"
    else
      log "[$step] $name —— 等超时，继续下一步"
    fi
    [ "$gap" -gt 0 ] && sleep "$gap"
  done
  log "===== 全部完成，总耗时 $(( $(date +%s) - t0 ))s ====="
}

status() {
  echo "仓库: $REPO"
  echo "顺序计划："
  local step=0 name dir cmd key wsec gap
  for row in "${STAGES[@]}"; do
    step=$((step + 1))
    IFS='|' read -r name dir cmd key wsec gap <<< "$row"
    if [ -e "$SUITE/$dir" ]; then printf '  [%s] %-22s ✓ 本机存在  等%ss + 空%ss\n' "$step" "$name" "$wsec" "$gap"
    else printf '  [%s] %-22s · 跳过（没有 %s）\n' "$step" "$name" "$dir"; fi
  done
  echo "自启：$( [ -f "$MY_DESKTOP" ] && echo "已装 $MY_DESKTOP" || echo "未装" )"
  [ -f "$LOG" ] && { echo "上次启动日志（末 12 行）："; tail -n 12 "$LOG"; }
}

install_autostart() {
  mkdir -p "$AUTOSTART_DIR"
  sed "s#__REPO__#$REPO#g" "$REPO/linux/presets/dsh-boot-order.desktop" > "$MY_DESKTOP"
  echo "已装 XDG 自启：$MY_DESKTOP"
  echo "（顺序由脚本内部保证，不依赖 desktop 文件排序）"
}

uninstall_autostart() {
  rm -f "$MY_DESKTOP" && echo "已移除：$MY_DESKTOP"
}

case "${1:---status}" in
  --run)       run_stages 0 ;;
  --dry-run)   run_stages 1 ;;
  --status|"") status ;;
  --install)   install_autostart ;;
  --uninstall) uninstall_autostart ;;
  *) echo "用法: $0 [--status|--run|--dry-run|--install|--uninstall]"; exit 1 ;;
esac
