#!/usr/bin/env bash
# Start the widget from source (dev mode)
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node。请先安装 Node.js 20/22 LTS。"
  exit 1
fi
npx electron .
