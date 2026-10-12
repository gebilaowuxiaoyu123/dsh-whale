#!/usr/bin/env bash
# Build DSH whale widget for Linux (AppImage + deb, amd64).
# Run on Ubuntu 22.04 / 24.04. Requires Node.js 20/22 LTS.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node。请先安装 Node.js 20/22 LTS，例如："
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
  exit 1
fi

echo "node: $(node -v), npm: $(npm -v)"

npm install

# 国内网络可先设置镜像再构建：
#   export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
#   export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npx electron-builder --linux

echo "==== 构建完成 ===="
ls -lh dist/*.AppImage dist/*.deb 2>/dev/null || true
