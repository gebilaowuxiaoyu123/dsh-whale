<#
.SYNOPSIS
  桌面渲染体检 —— 「卡顿 / 黑框白框 / 整屏黑一下再慢慢恢复」先跑这个看事实

.DESCRIPTION
  这三类现象能确定的原因就那么几个。本脚本只**读**不写，把判定所需的事实一次打出来：

    1. 屏幕现在到底跑多少 Hz（掉到 60 就说明是显示模式被改了，不是显卡不够）
    2. 谁在吃显卡（按进程汇总 GPU 引擎占用率，从高到低）
    3. DWM 的 MPO（多平面覆盖）现在是开还是关
    4. 有没有「显示驱动重置」(TDR)：有 = 驱动崩过；没有 = 更像 DWM 合成层面的问题
    5. HAGS（硬件加速 GPU 计划）状态
    6. 我们自己的两个挂件（Coopanion 桌宠 / DSH 挂件）当前的档位

.PARAMETER Top
  显卡占用榜打印前几名，默认 10

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\desktop-render-report.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\desktop-render-report.ps1 -Top 5

.NOTES
  读 System 日志（驱动重置那节）需要管理员；其余不加也不影响。
  背景与对策见 docs\desktop-rendering-perf.md。
#>
[CmdletBinding()]
param([int]$Top = 10)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $repoRoot) { $repoRoot = (Get-Location).Path }

function Write-Section([string]$Title) {
  Write-Host ''
  Write-Host "=== $Title ===" -ForegroundColor Cyan
}

# ---------------------------------------------------------------- 1. 显示模式
Write-Section '屏幕（当前显示模式）'
$vc = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue)
$shown = $false
foreach ($v in $vc) {
  $w = $v.CurrentHorizontalResolution
  $h = $v.CurrentVerticalResolution
  $hz = $v.CurrentRefreshRate
  if (-not $w) { continue }
  $shown = $true
  $note = ''
  if ($hz -and $hz -le 61) { $note = '   ← 注意：只有 ' + $hz + 'Hz（高刷屏应显示 120/144）' }
  Write-Host ("  {0,-30} {1}x{2} @ {3}Hz{4}" -f $v.Name, $w, $h, $hz, $note)
}
if (-not $shown) { Write-Host '  读不到显示模式（驱动没报）' }

# ---------------------------------------------------------------- 2. 谁在吃显卡
Write-Section ("谁在吃显卡（GPU 引擎占用，按进程汇总，前 " + $Top + "）")
$samples = @()
try {
  $samples = @((Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction Stop).CounterSamples |
    Where-Object { $_.CookedValue -ge 0.2 })
} catch {
  Write-Host "  取不到 GPU 计数器：$($_.Exception.Message)"
}
if ($samples.Count -gt 0) {
  $byPid = @{}
  foreach ($s in $samples) {
    if ($s.InstanceName -match 'pid_(\d+)_.*engtype_(\w+)') {
      $id = [int]$matches[1]
      $eng = $matches[2].ToLower()
      if (-not $byPid.ContainsKey($id)) { $byPid[$id] = @{ Three = 0.0; Total = 0.0 } }
      $byPid[$id].Total += [double]$s.CookedValue
      if ($eng -eq '3d') { $byPid[$id].Three += [double]$s.CookedValue }
    }
  }
  $rows = foreach ($k in $byPid.Keys) {
    $p = Get-Process -Id $k -ErrorAction SilentlyContinue
    $name = $p.ProcessName
    if (-not $name) { $name = '(已退出)' }
    [pscustomobject]@{
      pid   = $k
      name  = $name
      gpu3d = [math]::Round($byPid[$k].Three, 1)
      total = [math]::Round($byPid[$k].Total, 1)
    }
  }
  $rows | Sort-Object total -Descending | Select-Object -First $Top |
    Format-Table -AutoSize | Out-String | Write-Host
  $sum = [math]::Round((($byPid.Values | ForEach-Object { $_.Total }) | Measure-Object -Sum).Sum, 1)
  Write-Host ("  所有进程合计 = {0}%   （占大头的那一个就是卡顿的来源）" -f $sum)
  $top1 = $rows | Sort-Object total -Descending | Select-Object -First 1
  if ($top1) { Write-Host ("  第一名：{0} (pid {1}) = {2}%" -f $top1.name, $top1.pid, $top1.total) }
}

# ---------------------------------------------------------------- 3. MPO / HAGS
Write-Section 'DWM 覆盖平面（MPO）与硬件加速 GPU 计划（HAGS）'
$mpo = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\Dwm' -Name OverlayTestMode -ErrorAction SilentlyContinue).OverlayTestMode
if ($null -eq $mpo) {
  Write-Host '  OverlayTestMode = (未设置) → MPO 开着（Windows 默认）'
  Write-Host '     分层/透明窗口多的机器上，MPO 是「黑框白框、闪一下」的老来源'
} elseif ($mpo -eq 5) {
  Write-Host '  OverlayTestMode = 5 → MPO 已关'
} else {
  Write-Host ("  OverlayTestMode = {0}" -f $mpo)
}
$hags = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers' -Name HwSchMode -ErrorAction SilentlyContinue).HwSchMode
$hagsText = '(未设置 = 驱动默认)'
if ($hags -eq 2) { $hagsText = '2 = 开' } elseif ($hags -eq 1) { $hagsText = '1 = 关' }
Write-Host ("  HwSchMode = {0}" -f $hagsText)
Write-Host '  关 MPO：New-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\Dwm" -Name OverlayTestMode -PropertyType DWord -Value 5 -Force   （重启或重启 DWM 生效）'
Write-Host '  撤销：  Remove-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\Dwm" -Name OverlayTestMode'

# ---------------------------------------------------------------- 4. 驱动重置
Write-Section '显示驱动重置（TDR）与显示相关事件'
$found = $false
try {
  $ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 4101, 4102 } -MaxEvents 5 -ErrorAction Stop)
  foreach ($e in $ev) {
    $found = $true
    Write-Host ("  {0}  Id={1}  {2}" -f $e.TimeCreated, $e.Id, (($e.Message -split "`r?`n")[0]))
  }
} catch {
  # 没事件就是这个分支
}
if (-not $found) {
  Write-Host '  没查到 4101/4102（无权限也会落到这里）'
  Write-Host '  → 「整屏黑一下再逐步恢复」多半是 DWM 合成重置，不是显卡驱动崩'
}
try {
  $ev2 = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Display' } -MaxEvents 5 -ErrorAction Stop)
  foreach ($e in $ev2) { Write-Host ("  [Display] {0}  Id={1}" -f $e.TimeCreated, $e.Id) }
} catch { }

# ---------------------------------------------------------------- 5. 我们的挂件
Write-Section '我们自己的两个挂件（档位）'
$petCfg = Join-Path $repoRoot 'desktop-suite\coopanion\build\data\home\companion\config.json'
if (Test-Path $petCfg) {
  try {
    $j = Get-Content $petCfg -Raw -Encoding UTF8 | ConvertFrom-Json
    $w = $j.worlds.'desktop-pet'
    if ($w) {
      $fr = $w.window.frameRate
      if ($null -eq $fr) { $fr = '(默认 60)' }
      $lk = $w.window.lockFrameRate
      if ($null -eq $lk) { $lk = '(默认 关)' }
      Write-Host '  Coopanion 桌宠：'
      Write-Host ("    frameRate = {0} / lockFrameRate = {1} / hideWhenFullscreen = {2} / alwaysOnTop = {3} / roam = {4}" -f `
          $fr, $lk, $w.window.hideWhenFullscreen, $w.window.alwaysOnTop, $w.roam)
      Write-Host '    （控制台「习惯」页可改：全屏时自动隐藏 / 置顶显示 / 帧率 / 走动）'
    }
  } catch {
    Write-Host "  读不出来：$($_.Exception.Message)"
  }
} else {
  Write-Host '  没找到 Coopanion 配置（先跑 tools\setup-coopanion.ps1）'
}
$winCfg = Join-Path $env:USERPROFILE '.dsh\.dshw-window.json'
if (Test-Path $winCfg) {
  $aot = '(读不出来)'
  try {
    $wj = Get-Content $winCfg -Raw -Encoding UTF8 | ConvertFrom-Json
    $aot = [string]$wj.alwaysOnTop
  } catch { }
  Write-Host ("  DSH 挂件：alwaysOnTop = {0}   （托盘菜单「置顶显示」可切）" -f $aot)
} else {
  Write-Host '  DSH 挂件：还没写过窗口配置（默认不置顶）'
}

# ---------------------------------------------------------------- 6. 怎么读
Write-Section '怎么读这份报告'
Write-Host '  · 屏幕那节不是面板该有的 Hz：先去「设置 → 系统 → 显示 → 高级显示」把刷新率调回来'
Write-Host '  · 某个非系统进程占了 30% 以上：它挤掉了别的东西的合成带宽，先关它再对比（动态壁纸是大户）'
Write-Host '  · 未设置 MPO + 有黑框白框/闪屏：设成 5，重启生效；还不好就删掉那个值复原'
Write-Host '  · 出现 4101：驱动真的崩过 —— 换驱动版本 / 关 HAGS / 别超频'
Write-Host ''
Write-Host '  背景、实测数据与对策见 docs\desktop-rendering-perf.md'
