#!/usr/bin/env bash
# 安装 / 更新 GNOME Shell 扩展版小鲸鱼（dsh-whale@local）
# 用法: ./install.sh   （复制到 ~/.local/share/gnome-shell/extensions/）
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
UUID="dsh-whale@local"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
mkdir -p "$DEST"
cp -f "$SRC/metadata.json" "$SRC/extension.js" "$DEST/"
mkdir -p "$DEST/assets"
cp -f "$SRC/assets/dshw.png" "$DEST/assets/"
echo "已安装到 $DEST"
echo "启用：gnome-extensions enable $UUID"
echo "⚠️ 新扩展需【注销后重新登录】(GNOME Wayland) 才会被加载。"
echo "    启用后如报错，查看：journalctl --user -b -f -o cat | grep dsh-whale"
