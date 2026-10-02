#!/usr/bin/env bash
# 登记 / 撤销 Coopanion 桌宠的开机自启（登录后自动起来，但不打开调试界面）
#
# 自启条目由 Coopanion 自己写入（app/main.cjs 里的开机自启开关），本脚本只是替你把那个
# 开关拨一下。所以它跟托盘菜单里的「开机自动启动」是同一个条目，不会出现两份。
#
# Linux 上写的是 XDG 自启条目 ~/.config/autostart/coopanion.desktop，命令行带 --background：
# 开机启动时只出现桌宠和托盘图标，控制台（调试界面）不会自己弹出来。
#
# 用法：
#   ./tools/coopanion-autostart.sh             # 登记自启（默认）
#   ./tools/coopanion-autostart.sh status      # 只看当前状态
#   ./tools/coopanion-autostart.sh uninstall   # 撤销自启
#
# 环境变量：
#   COOPANION_DIR   Coopanion 安装目录，默认 <仓库根>/third-party/Coopanion
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$HERE")"
DIR="${COOPANION_DIR:-$REPO_ROOT/third-party/Coopanion}"
ACTION="${1:-install}"
ENTRY="$HOME/.config/autostart/coopanion.desktop"

EXE="$DIR/node_modules/electron/dist/electron"
if [ ! -x "$EXE" ]; then
  echo "找不到 Electron：$EXE" >&2
  echo "先跑 tools/setup-coopanion.sh 把桌宠装好。" >&2
  exit 1
fi

show_entry() {
  if [ -f "$ENTRY" ]; then
    echo "  自启条目：$ENTRY"
    sed 's/^/    /' "$ENTRY"
  else
    echo "  当前没有 Coopanion 的自启条目"
  fi
}

case "$ACTION" in
  install)
    "$EXE" "$DIR" --set-autostart=on
    echo
    echo "下次登录会自动起来：只显示桌宠和托盘图标，不会打开调试界面。"
    echo "（想改主意：托盘菜单里的「开机自动启动」，或者跑本脚本的 uninstall）"
    show_entry
    ;;
  uninstall)
    "$EXE" "$DIR" --set-autostart=off
    echo
    show_entry
    ;;
  status)
    show_entry
    ;;
  *)
    echo "用法：$0 [install|uninstall|status]" >&2
    exit 2
    ;;
esac
