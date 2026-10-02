<#
.SYNOPSIS
  登记 / 撤销 Coopanion 桌宠的开机自启（登录后自动起来，但不打开调试界面）

.DESCRIPTION
  自启条目由 Coopanion 自己写入（app/main.cjs 里的开机自启开关），本脚本只是替你把那个
  开关拨一下。所以它跟托盘菜单里的「开机自动启动」是**同一个条目**，不会出现两份、
  也不会互相打架 —— 从托盘关掉，这里也就跟着关掉了。

  命令行里带的 --background 是关键：开机启动时只出现桌宠和托盘图标，控制台（也就是
  调试界面）不会自己弹出来。手动双击启动仍然照旧。

  Windows 上是 HKCU\...\CurrentVersion\Run 里的一条启动项。

.PARAMETER Action
  install（默认）登记自启 / uninstall 撤销自启 / status 只看当前状态

.PARAMETER Dir
  Coopanion 安装目录，默认 <仓库根>\third-party\Coopanion

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\coopanion-autostart.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\coopanion-autostart.ps1 status

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\coopanion-autostart.ps1 uninstall

.NOTES
  前提：先跑过 tools\setup-coopanion.ps1（需要 node_modules\electron 已就位）。
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'uninstall', 'status')][string]$Action = 'install',
  [string]$Dir
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Dir) { $Dir = Join-Path $repoRoot 'third-party\Coopanion' }
$Dir = [System.IO.Path]::GetFullPath($Dir)

$exe = Join-Path $Dir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) { throw "找不到 Electron：$exe`n先跑 tools\setup-coopanion.ps1 把桌宠装好。" }

$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

function Show-Entry {
  $run = Get-ItemProperty -Path $RunKey -ErrorAction SilentlyContinue
  $hits = @($run.PSObject.Properties | Where-Object { $_.Value -like "*$Dir*" })
  if ($hits.Count -eq 0) {
    Write-Host '  当前没有 Coopanion 的启动项' -ForegroundColor Yellow
    return
  }
  foreach ($h in $hits) {
    Write-Host "  自启条目：$($h.Name)" -ForegroundColor Green
    Write-Host "    $($h.Value)"
  }
}

switch ($Action) {
  'status' { Show-Entry }

  'install' {
    # 直接问 Coopanion 自己：同一个开关，托盘的勾选状态也跟着变
    & $exe $Dir --set-autostart=on
    Write-Host ''
    Write-Host '下次登录会自动起来：只显示桌宠和托盘图标，不会打开调试界面。' -ForegroundColor Cyan
    Write-Host '（想改主意：右键托盘图标 -> 开机自动启动，或者跑本脚本的 uninstall）'
    Show-Entry
  }

  'uninstall' {
    & $exe $Dir --set-autostart=off
    Write-Host ''
    Show-Entry
  }
}
