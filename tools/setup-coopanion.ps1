<#
.SYNOPSIS
  一键安装 / 更新 Coopanion 桌宠（Live2D 桌面伴侣 Coo，内置「DeepSeek 大肥鱼」形象）

.DESCRIPTION
  Coopanion（https://github.com/Pal-AI-Lab/Coopanion）采用 AGPL-3.0-or-later 许可，
  属强 copyleft。因此按本仓库既有惯例放在 third-party/ 下 —— 该目录已被根 .gitignore
  忽略，不进入版本库（既不污染本仓库许可，也不把别人的代码当自己的提交）。
  本脚本负责把源码、子模块、依赖与构建产物准备好，并把本仓库的桌宠改造补丁打上去，
  可重复运行。

  改造补丁（patches\coopanion\0001-dsh-pet-features.patch）做了四件事：
    1. 聊天气泡的输入框左边加一个小齿轮，一按就打开本地调试界面（控制台）；
    2. 走动模式多一个「随刷新率」：屏幕刷新率高就走得快，低就走得慢，步频跟着速度走；
    3. 命令行开关 `--set-autostart=on|off`，以及未打包运行时也能用托盘里的开机自启；
    4. `--background` 启动（开机自启用的）只显示桌宠和托盘，不弹调试界面。
  另有两个自检脚本：tools\coopanion-sync-roam-test.mjs（走动数学）、
  tools\coopanion-feature-test.mjs（补丁与构建产物是否到位）。

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

# 上游源码钉在该 tag 上：补丁 patches\coopanion\0001-dsh-pet-features.patch 就是针对它生成的，
# 源码漂移（上游重构过 web/pet-core.js 的拆分）会让补丁整段打不上，所以这里必须钉死。
$CoopanionTag = 'v0.1.20'
# v0.1.20 需要新版 Cortico（Translation / LanguageTable / LANGUAGE_NAMES 等新 API）。
# 上游 tarball 不含子模块，而父仓库的 gitlink 未必跟得上，所以这里把 commit 也钉死。
$CorticoCommit = 'f9449842a8ed93cfc0e3fd5a554e00c2aa5973f5'

$pkg = Join-Path $Dir 'package.json'
if (-not (Test-Path $pkg)) {
  Step "克隆 Coopanion 到 $Dir"
  New-Item -ItemType Directory -Path (Split-Path -Parent $Dir) -Force | Out-Null
  git clone --depth 1 --branch $CoopanionTag https://github.com/Pal-AI-Lab/Coopanion.git $Dir
  if ($LASTEXITCODE -ne 0) { throw "git clone $CoopanionTag 失败（网络？先解决网络再重试）" }
  Ok "源码已克隆（$CoopanionTag）"
}
elseif ($Update) {
  Step "更新源码到 $CoopanionTag（含子模块）"
  git -C $Dir fetch --depth 1 origin tag $CoopanionTag
  if ($LASTEXITCODE -ne 0) { throw "git fetch $CoopanionTag 失败（网络？）—— 不要在旧源码上继续打补丁" }
  git -C $Dir checkout -f $CoopanionTag
  if ($LASTEXITCODE -ne 0) { throw "git checkout $CoopanionTag 失败" }
  Ok "源码已更新到 $CoopanionTag"
}
else {
  Warn "已存在：$Dir（如需更新请加 -Update）"
}

# 版本硬校验：源码漂了补丁就整段打不上，这里宁可早失败也不要在错版本上继续
$wantVer = $CoopanionTag.TrimStart('v')
$haveVer = (Get-Content $pkg -Raw | ConvertFrom-Json).version
if ($haveVer -ne $wantVer) {
  throw "源码版本是 $haveVer，需要 $wantVer（补丁是照着那个版本生成的）—— 跑一次 -Update 再来"
}
Ok "源码版本 = $haveVer"

Step '初始化子模块 vendor/cortico（Cortico 框架）'
git -C $Dir submodule update --init --depth 1 vendor/cortico
if ($LASTEXITCODE -ne 0) { throw 'vendor/cortico 子模块拉取失败' }
$corticoDir = Join-Path $Dir 'vendor\cortico'
git -C $corticoDir fetch --depth 1 origin $CorticoCommit
if ($LASTEXITCODE -ne 0) { throw "vendor/cortico 的 $CorticoCommit 拉不下来" }
git -C $corticoDir checkout -q --detach $CorticoCommit
if ($LASTEXITCODE -ne 0) { throw "vendor/cortico 切不到 $CorticoCommit" }
if (-not (git -C $corticoDir rev-parse HEAD).Trim().StartsWith($CorticoCommit.Substring(0, 7))) {
  throw "vendor/cortico 现在不在 $CorticoCommit 上"
}
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

Step '应用本仓库的桌宠改造补丁'
$patch = Join-Path $repoRoot 'patches\coopanion\0001-dsh-pet-features.patch'
if (-not (Test-Path $patch)) {
  Warn "没找到补丁：$patch（跳过）"
}
else {
  # 幂等：已经打过的直接跳过；能干净打上的才打；两者都不是就说明上游源码变了，只报警不硬来
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  git -C $Dir apply --reverse --check $patch 2>$null | Out-Null
  $already = ($LASTEXITCODE -eq 0)
  if (-not $already) { git -C $Dir apply --check $patch 2>$null | Out-Null; $clean = ($LASTEXITCODE -eq 0) }
  else { $clean = $false }
  if ($already) { Ok '补丁已经应用过了' }
  elseif ($clean) { git -C $Dir apply $patch; Ok '补丁已应用（调试入口按钮 / 随刷新率走动 / 开机自启不弹窗 / 置顶开关 / 一键同步 Key / 测试刷新率）' }
  else {
    # 不在没打上补丁的源码上继续构建：那样会得到一个“看起来装好了、其实没有功能”的产物
    throw '补丁打不上 —— 上游源码可能已经变了。源码必须与补丁对应的版本一致（见脚本顶部的 $CoopanionTag），先 -Update 再重试'
  }
  $ErrorActionPreference = $eap
}

Step '构建（tsx scripts/stage.ts）'
# 这一步把 console/ 覆盖到 build/cortico，并重打包控制台页面与桌宠面板；
# 「随刷新率」这个新走动模式在控制台「习惯」页里，必须重新构建才会出现。
pnpm --dir $Dir run build:cortico
Ok '构建完成'

Step '完成'
Write-Host "  安装位置 : $Dir"
Write-Host "  启动命令 : pnpm --dir `"$Dir`" start"
Write-Host "  数据目录 : $Dir\data（记忆/设置/日志都在这里，重装不丢）"
Write-Host "  退出方式 : 右键托盘图标 -> 退出（关设置窗口不会退出程序）"
Write-Host "  调试界面 : http://127.0.0.1:17788/  或右键桌宠 -> 菜单里的设置"
Write-Host "  开机自启 : powershell -ExecutionPolicy Bypass -File tools\coopanion-autostart.ps1"

if ($Run) {
  Step '启动 Coopanion'
  $exe = Join-Path $Dir 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path $exe)) { throw "找不到 electron：$exe（先跑一次 pnpm install）" }
  Start-Process -FilePath $exe -ArgumentList '.' -WorkingDirectory $Dir
  Ok '已启动 —— 桌宠出现在屏幕底边，托盘区有它的图标'
}
