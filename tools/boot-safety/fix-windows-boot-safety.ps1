# Windows 侧双系统保障措施（需要管理员）
# ============================================================================
# 只做「让 Windows 不再主动破坏双系统引导」这一类事，不碰 GRUB 本身：
#   1. 备份 BCD（bcdedit /export）—— 出问题能一键回滚
#   2. 关掉快速启动（HiberbootEnabled=0）—— 关机不再变休眠，双系统切换不脏挂载
#   3. 关掉崩溃后自动重启（AutoReboot=0）—— 蓝屏停在屏上，取证可读
#   4. 复原被篡改的 {bootmgr}.path —— 「Windows Boot Manager」必须指向 Windows 自己的
#      bootmgfw.efi，而不是 \EFI\ubuntu\grubx64.efi（Windows 自动修复 / 引导修复工具会这么干）
#   5. 把 ubuntu 顶回 UEFI 第一启动项 —— 自动修复会把它挤到后面，导致「开机直接进 Windows」
#
# 用法（管理员 PowerShell）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\boot-safety\fix-windows-boot-safety.ps1 -Check
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\boot-safety\fix-windows-boot-safety.ps1
#
# 退出码：0 = 已就绪；2 = 需要管理员；3 = 有步骤失败
# ============================================================================
[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$SkipBcdPath,
  [switch]$SkipFirmwareOrder,
  [string]$UbuntuGuid = '',
  [string]$BackupDir = (Join-Path $env:USERPROFILE 'dsh-whale-backups')
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Good($m) { Write-Host "  [ok]   $m" -ForegroundColor Green }
function Bad($m) { Write-Host "  [!!]   $m" -ForegroundColor Red }
function Warn($m) { Write-Host "  [??]   $m" -ForegroundColor Yellow }
function Info($m) { Write-Host "         $m" }

# --- bcdedit 解析（同 check-boot-health.ps1：中文 Windows 上 identifier 显示为 标识符）---
function ConvertFrom-BcdKey([string]$k) {
  switch ($k) {
    '标识符' { 'identifier' }
    '描述' { 'description' }
    '设备' { 'device' }
    '路径' { 'path' }
    '显示顺序' { 'displayorder' }
    default { $k }
  }
}
function Get-BcdEntries([string]$enumArg) {
  $raw = & bcdedit /enum $enumArg 2>&1 | Out-String
  if ($raw -match '拒绝访问|Access is denied|Access denied') { return $null }
  $entries = @()
  $cur = $null
  foreach ($ln in ($raw -split "`r?`n")) {
    $t = $ln.TrimEnd()
    if ($t -match '^\s*-{4,}\s*$') { if ($cur) { $entries += $cur; $cur = $null }; continue }
    if ($t.Trim() -eq '') { continue }
    if ($t -match '^(\S+?)\s{2,}(.+?)\s*$') {
      $k = ConvertFrom-BcdKey $Matches[1]
      $v = $Matches[2].Trim()
      if ($k -eq 'identifier') { if ($cur) { $entries += $cur }; $cur = @{ id = $v; order = @(); kv = @{} }; continue }
      if (-not $cur) { continue }
      if ($k -eq 'displayorder') { $cur.order += $v; continue }
      $cur.kv[$k] = $v
      continue
    }
    if ($cur -and $t -match '^\s*(\{[0-9a-fA-F\-]+\})\s*$') { $cur.order += $Matches[1] }
  }
  if ($cur) { $entries += $cur }
  return $entries
}
function Get-BcdEntry($entries, [string]$id) {
  if (-not $entries) { return $null }
  return ($entries | Where-Object { $_.id -eq $id } | Select-Object -First 1)
}

$isAdmin = (New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
  )).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host '=================================================' -ForegroundColor Cyan
Write-Host '  Windows 侧双系统保障措施' -ForegroundColor Cyan
if ($Check) { Write-Host '  模式：只看不改（-Check）' -ForegroundColor Yellow }
Write-Host '=================================================' -ForegroundColor Cyan
if (-not $isAdmin) {
  Bad '需要管理员权限。请用「以管理员身份运行」的 PowerShell 重跑：'
  Info 'powershell -NoProfile -ExecutionPolicy Bypass -File tools\boot-safety\fix-windows-boot-safety.ps1'
  exit 2
}

$script:failed = 0
$script:pending = 0
function Step($what, [scriptblock]$act) {
  try { & $act; Good $what }
  catch { Bad "$what —— $($_.Exception.Message)"; $script:failed++ }
}

# ---------- 0. 备份 BCD ----------
Section '0. 备份 BCD'
if ($Check) { Info "将会导出到 $BackupDir\BCD-<时间戳>.bin" }
else {
  Step '导出 BCD 备份' {
    if (-not (Test-Path -LiteralPath $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }
    $bak = Join-Path $BackupDir ("BCD-{0}.bin" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    $out = & bcdedit /export "$bak" 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $bak)) { throw ($out.Trim()) }
    Info "回滚：bcdedit /import `"$bak`""
  }
}

# ---------- 1. 快速启动 ----------
Section '1. 快速启动（HiberbootEnabled）'
$powKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power'
$hb = (Get-ItemProperty $powKey -Name HiberbootEnabled -ErrorAction SilentlyContinue).HiberbootEnabled
Info "当前 HiberbootEnabled = $hb （1 = 快速启动开着）"
if ($hb -eq 0) { Good '已经是关闭状态' }
elseif ($Check) { Warn '需要改成 0'; $script:pending++ }
else {
  Step '关闭快速启动' {
    Set-ItemProperty $powKey -Name HiberbootEnabled -Value 0 -Type DWord -Force
    if ((Get-ItemProperty $powKey -Name HiberbootEnabled).HiberbootEnabled -ne 0) { throw '写入后仍是原值' }
  }
  Info '（更彻底可 powercfg /h off：会连 hiberfil.sys 一起删掉，但也就不再支持休眠）'
}

# ---------- 2. 崩溃后自动重启 ----------
Section '2. 崩溃后自动重启（AutoReboot）'
$ccKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl'
$ar = (Get-ItemProperty $ccKey -Name AutoReboot -ErrorAction SilentlyContinue).AutoReboot
Info "当前 AutoReboot = $ar （1 = 蓝屏后自动重启）"
if ($ar -eq 0) { Good '已经是关闭状态' }
elseif ($Check) { Warn '需要改成 0'; $script:pending++ }
else {
  Step '关闭崩溃后自动重启' {
    Set-ItemProperty $ccKey -Name AutoReboot -Value 0 -Type DWord -Force
    if ((Get-ItemProperty $ccKey -Name AutoReboot).AutoReboot -ne 0) { throw '写入后仍是原值' }
  }
}

# ---------- 3. {bootmgr}.path ----------
Section '3. BCD：{bootmgr} 指向哪个引导程序'
$wantPath = '\EFI\Microsoft\Boot\bootmgfw.efi'
$bm = Get-BcdEntry (Get-BcdEntries 'all') '{bootmgr}'
if (-not $bm) { Bad '读不到 {bootmgr}（bcdedit 失败？）'; $script:failed++ }
else {
  Info "当前 path = $($bm.kv['path'])"
  if ($bm.kv['path'] -eq $wantPath) { Good '已指向 Windows 自己的 bootmgfw.efi' }
  elseif ($SkipBcdPath) { Warn "-SkipBcdPath：跳过；正确值应为 $wantPath" }
  elseif ($Check) { Warn "需要改成 $wantPath"; $script:pending++ }
  else {
    Step "把 {bootmgr}.path 复原为 $wantPath" {
      $out = & bcdedit /set '{bootmgr}' path "$wantPath" 2>&1 | Out-String
      if ($LASTEXITCODE -ne 0) { throw ($out.Trim()) }
      $now = (Get-BcdEntry (Get-BcdEntries 'all') '{bootmgr}').kv['path']
      if ($now -ne $wantPath) { throw "写入后仍是 $now" }
    }
    Info '只影响「Windows Boot Manager」这个名字对应的加载器；ubuntu 启动项不受影响。'
  }
}

# ---------- 4. UEFI 启动顺序 ----------
Section '4. UEFI 启动顺序：ubuntu 是否第一'
if ($SkipFirmwareOrder) { Warn '-SkipFirmwareOrder：跳过' }
else {
  $firm = Get-BcdEntries 'firmware'
  $fwb = Get-BcdEntry $firm '{fwbootmgr}'
  if (-not $fwb) { Bad '读不到 {fwbootmgr}（不是 UEFI 启动？）——双系统顺序只能进 BIOS 手动设'; $script:failed++ }
  else {
    $guid = $UbuntuGuid
    if (-not $guid -and $firm) {
      $u = $firm | Where-Object { $_.kv['description'] -eq 'ubuntu' } | Select-Object -First 1
      if ($u) { $guid = $u.id }
    }
    Info "当前顺序：$($fwb.order -join ' , ')"
    if (-not $guid) {
      Warn '固件启动项里找不到 description=ubuntu 的条目 —— 先在 Ubuntu 里 grub-install / efibootmgr 重建，再回来跑本脚本'
    }
    elseif ($fwb.order.Count -gt 0 -and $fwb.order[0] -eq $guid) { Good "ubuntu（$guid）已经是第一启动项" }
    elseif ($Check) { Warn "需要把 $guid 顶到最前"; $script:pending++ }
    else {
      Step "把 ubuntu（$guid）顶为第一启动项" {
        $out = & bcdedit /set '{fwbootmgr}' displayorder "$guid" /addfirst 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { throw ($out.Trim()) }
        $now = @((Get-BcdEntry (Get-BcdEntries 'firmware') '{fwbootmgr}').order)
        if ($now.Count -eq 0 -or $now[0] -ne $guid) { throw "写入后第一项是 $($now[0])" }
      }
    }
  }
}

# ---------- 收尾 ----------
Section '收尾'
if ($script:failed -gt 0) { Write-Host "  × 有 $($script:failed) 个步骤失败，请看上面红字。" -ForegroundColor Red; exit 3 }
if ($Check) {
  if ($script:pending -gt 0) {
    Write-Host "  ! 只看不改模式：有 $($script:pending) 项需要处理（去掉 -Check 重跑即可）。" -ForegroundColor Yellow
    exit 1
  }
  Write-Host '  √ 只看不改模式：Windows 侧已就绪，没有需要处理的项目。' -ForegroundColor Green
  exit 0
}
Write-Host '  √ Windows 侧已就绪。' -ForegroundColor Green
Write-Host "`n  还要去 Ubuntu 侧做两件事（否则下次 GPU 挂死还会重演）：" -ForegroundColor Yellow
Write-Host '    1) git pull && sudo bash tools/freeze-fix/apply-all.sh   # i915 稳定化 + GPU 看门狗 + 修 fstab/引导' -ForegroundColor Yellow
Write-Host '    2) 确认 /etc/fstab 里 /boot/efi 的 UUID == 当前 ESP 的 UUID（check-boot-health.ps1 会打印）' -ForegroundColor Yellow
Write-Host "`n  复核：powershell -NoProfile -File tools\boot-safety\check-boot-health.ps1" -ForegroundColor Yellow
exit 0
