<#
.SYNOPSIS
  一键安装 / 更新 Coopanion 桌宠（Live2D 桌面伴侣 Coo，内置「DeepSeek 大肥鱼」形象）

.DESCRIPTION
  Coopanion（https://github.com/Pal-AI-Lab/Coopanion）采用 AGPL-3.0-or-later 许可，
  属强 copyleft。因此按本仓库既有惯例放在 third-party/ 下 —— 该目录已被根 .gitignore
  忽略，不进入版本库（既不污染本仓库许可，也不把别人的代码当自己的提交）。
  本脚本负责把源码、子模块、依赖与构建产物准备好，可重复运行。

.PARAMETER Update
  已存在时拉取最新代码（含子模块）并重新安装依赖、重新构建。

.PARAMETER Run
  安装完成后直接启动桌宠。

.PARAMETER Dir
  安装目录，默认 <仓库根>\third-party\Coopanion。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\setup-coopanion.ps1 -Run

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\setup-coopanion.ps1 -Update -Run

.NOTES
  运行要求：Windows 10/11 x64、Node.js >= 22、pnpm、可访问 GitHub 与 npm 源。
#>
[CmdletBinding()]
param(
  [switch]$Update,
  [switch]$Run,
  [string]$Dir
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Dir) { $Dir = Join-Path $repoRoot 'third-party\Coopanion' }
$Dir = [System.IO.Path]::GetFullPath($Dir)

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }

Step '检查环境'
foreach ($cmd in 'git', 'node', 'pnpm') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "缺少 $cmd，请先安装（Node.js >= 22 与 pnpm）"
  }
}
Ok ("git  " + (git --version))
Ok ("node " + (node --version))
Ok ("pnpm " + (pnpm --version))

$pkg = Join-Path $Dir 'package.json'
if (-not (Test-Path $pkg)) {
  Step "克隆 Coopanion 到 $Dir"
  New-Item -ItemType Directory -Path (Split-Path -Parent $Dir) -Force | Out-Null
  git clone --depth 1 https://github.com/Pal-AI-Lab/Coopanion.git $Dir
  Ok '源码已克隆'
}
elseif ($Update) {
  Step '更新源码（含子模块）'
  git -C $Dir pull --ff-only
  Ok '源码已更新'
}
else {
  Warn "已存在：$Dir（如需更新请加 -Update）"
}

Step '初始化子模块 vendor/cortico（Cortico 框架）'
git -C $Dir submodule update --init --depth 1 vendor/cortico
Ok '子模块就绪'

Step '安装依赖（pnpm install）'
# Electron 二进制约 100MB+，默认走国内镜像加速；如需官方源可先清空该环境变量
if (-not $env:ELECTRON_MIRROR) { $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/' }
pnpm --dir $Dir install
Ok '依赖安装完成'

Step '确保 Electron 二进制就位'
# pnpm 10+ 默认**阻止依赖的 postinstall 脚本**（安全特性），electron 的下载脚本不会自动跑，
# 直接启动会报 "Electron failed to install correctly"。这里手动跑一次 install.js。
# 注意：`pnpm rebuild electron` 同样受该策略限制，直接执行 install.js 最可靠。
$elDir = Join-Path $Dir 'node_modules\electron'
$elExe = Join-Path $elDir 'dist\electron.exe'
if (-not (Test-Path $elExe)) {
  if (-not $env:ELECTRON_MIRROR) { $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/' }
  $installJs = Join-Path $elDir 'install.js'
  if (-not (Test-Path $installJs)) { throw "找不到 $installJs —— 先跑一次 pnpm install" }
  Warn 'Electron 二进制缺失，正在下载（走镜像）...'
  Push-Location $elDir
  try { node install.js } finally { Pop-Location }
  if (-not (Test-Path $elExe)) { throw "Electron 二进制仍缺失：$elExe" }
}
Ok 'Electron 二进制就绪'

Step '构建（tsx scripts/stage.ts）'
pnpm --dir $Dir run build:cortico
Ok '构建完成'

Step '完成'
Write-Host "  安装位置 : $Dir"
Write-Host "  启动命令 : pnpm --dir `"$Dir`" start"
Write-Host "  数据目录 : $Dir\data（记忆/设置/日志都在这里，重装不丢）"
Write-Host "  退出方式 : 右键托盘图标 -> 退出（关设置窗口不会退出程序）"

if ($Run) {
  Step '启动 Coopanion'
  $exe = Join-Path $Dir 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path $exe)) { throw "找不到 electron：$exe（先跑一次 pnpm install）" }
  Start-Process -FilePath $exe -ArgumentList '.' -WorkingDirectory $Dir
  Ok '已启动 —— 桌宠出现在屏幕底边，托盘区有它的图标'
}
