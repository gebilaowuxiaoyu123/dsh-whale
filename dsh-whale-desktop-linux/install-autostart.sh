#!/usr/bin/env bash
# 设置开机自启（XDG autostart）。用法：./install-autostart.sh <可执行文件绝对路径>
# 例：./install-autostart.sh "/home/$USER/opt/dsh-whale-widget-1.0.0-x64.AppImage"
set -e
EXE="${1:?用法: $0 <可执行文件绝对路径>}"
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/dsh-whale-widget.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=DSH Whale Widget
Comment=DeepSeek 余额小鲸鱼桌面挂件
Exec=env APPIMAGE_EXTRACT_AND_RUN=1 "$EXE" --ozone-platform=x11
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
echo "已写入 $HOME/.config/autostart/dsh-whale-widget.desktop"
echo "下次登录时自动启动。若要立即生效：systemctl --user restart ... 或直接注销重登。"
