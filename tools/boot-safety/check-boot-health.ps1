# 双系统引导体检 —— 只读，绝不改动任何东西
# ============================================================================
# 为什么需要它
# ------------
# 这台机器（HUAWEI VGHH-XX / Intel Meteor Lake）是 Windows + Ubuntu 双系统。
# 2026-10-03 在 Ubuntu 会话里 i915 GPU 挂死 → 画面定格只剩光标 → 强制关机 →
# 下次开机 Windows 自动修复重建 ESP、GRUB 入口被抢走。
#
# 关键坑：这类事故**只看 Windows 事件日志是查不出来的**。崩的是 Ubuntu 会话时，
# Windows 上一次关机依然是「干净」的，所以既不会有 6008（意外关机）也不会有
# 41（内核掉电）—— 必须去查 ESP 上的引导文件、UEFI 启动项和 BCD。
#
# 用法（查 ESP / 读 BCD 需要管理员；其余不需要）
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\boot-safety\check-boot-health.ps1
#   ... -Days 7 -ExpectedEspSerial DAA2-C912
#
# 退出码：0 = 没发现可疑项；1 = 有可疑项（见最后的「结论」）
# ============================================================================
[CmdletBinding()]
param(
  [int]$Days = 7,
  [string]$ExpectedEspSerial = ''
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$script:Problems = New-Object System.Collections.Generic.List[string]
function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Good($m) { Write-Host "  [ok]   $m" -ForegroundColor Green }
function Bad($m) { Write-Host "  [!!]   $m" -ForegroundColor Red; $script:Problems.Add($m) }
function Warn($m) { Write-Host "  [??]   $m" -ForegroundColor Yellow }
function Info($m) { Write-Host "         $m" }

$isAdmin = $false
try {
  $isAdmin = (New-Object Security.Principal.WindowsPrincipal(
      [Security.Principal.WindowsIdentity]::GetCurrent()
    )).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }

# ---------------------------------------------------------------------------
# bcdedit 输出解析
# ---------------------------------------------------------------------------
# 坑：中文 Windows 上 bcdedit 把 **键名** 也本地化了 —— `identifier` 显示成 `标识符`，
# `displayorder` 仍然是英文，而 `device`/`path`/`description` 也仍是英文（很不对称）。
# 所以这里统一把已知的本地化键名归一化，再按 `键  值` 两列以上空白来切分。
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
    # displayorder 的第二行起是「裸 GUID」行
    if ($cur -and $t -match '^\s*(\{[0-9a-fA-F\-]+\})\s*$') { $cur.order += $Matches[1] }
  }
  if ($cur) { $entries += $cur }
  return $entries
}

function Get-BcdEntry($entries, [string]$id) {
  if (-not $entries) { return $null }
  return ($entries | Where-Object { $_.id -eq $id } | Select-Object -First 1)
}

# ---------- 0. 环境 ----------
Section '0. 环境'
$cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
Info "机型      : $($cs.Manufacturer) $($cs.Model)"
Info "操作系统  : $($os.Caption) build $($os.BuildNumber)"
Info "管理员    : $isAdmin   （读 ESP / BCD 需要管理员，否则相关项会显示「未知」）"
try { Info "安全启动  : $(if (Confirm-SecureBootUEFI) { '已开启' } else { '已关闭' })" }
catch { Warn '安全启动状态读不到（多半是权限不足）' }

$espAll = @(Get-CimInstance Win32_Volume -ErrorAction SilentlyContinue |
  Where-Object { $_.FileSystem -eq 'FAT32' -and $_.Capacity -le 600MB -and $_.DeviceID -like '\\?\Volume*' })
if ($espAll.Count -gt 0) {
  $sz = [math]::Round((($espAll | Measure-Object -Property Capacity -Sum).Sum) / 1MB)
  Good "固件类型 = UEFI（存在 $sz MB 的 FAT32 ESP，双系统引导条目都在它上面）"
}
else { Bad '没找到 FAT32 ESP —— 可能不是 UEFI 启动，GRUB/ESP 的排查思路完全不同' }

# ---------- 1. Windows 自己的开关机是否干净 ----------
Section "1. Windows 开关机记录（最近 $Days 天）"
$uptime = (Get-Date) - $os.LastBootUpTime
Info "上次启动  : $($os.LastBootUpTime)   （已运行 $($uptime.ToString('d\d\ hh\:mm\:ss'))）"

$ids = 41, 6008, 6005, 6006, 1074, 1001
$evts = Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = $ids; StartTime = (Get-Date).AddDays(-$Days) } -MaxEvents 200 -ErrorAction SilentlyContinue
if (-not $evts) { Warn '读不到 System 日志（权限不足？）' }
else {
  $dirty = @($evts | Where-Object { $_.Id -eq 41 -or $_.Id -eq 6008 })
  $boots = @($evts | Where-Object { $_.Id -eq 6005 })
  $stops = @($evts | Where-Object { $_.Id -eq 6006 })
  Info ("开机 {0} 次 / 干净关机 {1} 次 / 异常掉电标记 {2} 个" -f $boots.Count, $stops.Count, $dirty.Count)
  if ($dirty.Count -eq 0) {
    Good 'Windows 侧没有意外掉电记录（41/6008 都没有）'
    Info '但这只说明「Windows 自己没崩」：崩的是 Ubuntu 会话时这里同样干净 —— 所以必须看第 3/4 节的引导证据。'
  }
  else { foreach ($d in $dirty) { Bad "Windows 侧有意外掉电：$($d.TimeCreated) 事件 $($d.Id)" } }
  $evts | Sort-Object TimeCreated -Descending | Select-Object -First 12 | ForEach-Object {
    $m = ($_.Message -replace "`r?`n", ' ')
    Info ("  {0}  {1,5}  {2}" -f $_.TimeCreated.ToString('MM-dd HH:mm'), $_.Id, $m.Substring(0, [Math]::Min(70, $m.Length)))
  }
}

# ---------- 2. EFI 分区（ESP） ----------
Section '2. EFI 分区（ESP）'
$esp = $espAll | Where-Object { $_.SystemVolume } | Select-Object -First 1
if (-not $esp) { $esp = $espAll | Sort-Object Capacity | Select-Object -First 1 }

if (-not $esp) { Bad '找不到 ESP —— 双系统引导必然有问题' }
else {
  $h8 = '{0:X8}' -f [uint32]$esp.SerialNumber
  $espUuid = "$($h8.Substring(0, 4))-$($h8.Substring(4, 4))"
  $espRoot = "$($esp.DeviceID)\"
  Info ("ESP       : {0}  {1}  ({2} MB)" -f $esp.Label, $espRoot, [math]::Round($esp.Capacity / 1MB))
  Info "ESP UUID  : $espUuid"
  if ($ExpectedEspSerial) {
    $want = ($ExpectedEspSerial -replace '[^0-9A-Fa-f]', '').ToUpper()
    $got = ($espUuid -replace '[^0-9A-Fa-f]', '').ToUpper()
    if ($want -eq $got) { Good "ESP UUID 与期望一致（$espUuid）" }
    else {
      Bad "ESP UUID 与期望不一致：现在 $espUuid，期望 $ExpectedEspSerial —— Linux 侧 /etc/fstab 里若还是旧值，/boot/efi 会挂不上，之后 update-grub 会把引导写进空目录（很危险）"
    }
  }
  else { Info '（可用 -ExpectedEspSerial 传入 Linux 侧 /etc/fstab 里写的 UUID 做核对）' }

  if (-not $isAdmin) { Warn '不是管理员，跳过 ESP 文件检查（请用管理员重跑）' }
  else {
    $need = @(
      'EFI\ubuntu\shimx64.efi',
      'EFI\ubuntu\grubx64.efi',
      'EFI\ubuntu\grub.cfg',
      'EFI\Microsoft\Boot\bootmgfw.efi',
      'EFI\BOOT\BOOTX64.EFI'
    )
    $hash = @{}
    foreach ($rel in $need) {
      $full = "$espRoot$rel"
      if (Test-Path -LiteralPath $full) {
        $i = Get-Item -LiteralPath $full
        $hash[$rel] = (Get-FileHash -LiteralPath $full -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash
        Info ("  {0,-34} {1,9} B  改于 {2}" -f $rel, $i.Length, $i.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
      }
      else { $hash[$rel] = $null }
    }
    if (-not $hash['EFI\ubuntu\shimx64.efi'] -or -not $hash['EFI\ubuntu\grubx64.efi']) {
      Bad 'ESP 上没有 ubuntu 的 shim/grub —— GRUB 被清掉了（需要在 Ubuntu 里重装 grub-efi）'
    }
    else { Good 'ESP 上 ubuntu 的 shim + grub 都在' }

    $fb = $hash['EFI\BOOT\BOOTX64.EFI']
    if ($fb -and $fb -eq $hash['EFI\ubuntu\shimx64.efi']) {
      Good '回退引导 \EFI\BOOT\BOOTX64.EFI == ubuntu 的 shim（没被 Windows 抢走）'
    }
    elseif ($fb -and $fb -eq $hash['EFI\Microsoft\Boot\bootmgfw.efi']) {
      Bad '回退引导 \EFI\BOOT\BOOTX64.EFI 已被 Windows 的 bootmgfw.efi 覆盖 —— 拔盘/换启动顺序时会直接进 Windows'
    }
    elseif ($fb) { Warn '回退引导既不是 shim 也不是 bootmgfw' }
    else { Bad 'ESP 上没有 \EFI\BOOT\BOOTX64.EFI 这个回退引导文件' }
  }
}

# ---------- 3. BCD ----------
Section '3. BCD（Windows 引导数据）'
$all = Get-BcdEntries 'all'
if (-not $all) { Warn '读 BCD 失败（需要管理员，或 bcdedit 不可用）' }
else {
  $bm = Get-BcdEntry $all '{bootmgr}'
  if (-not $bm) { Warn 'BCD 里没有 {bootmgr}' }
  else {
    Info "bootmgr 描述 : $($bm.kv['description'])"
    Info "bootmgr 路径 : $($bm.kv['path'])"
    if ($bm.kv['path'] -eq '\EFI\Microsoft\Boot\bootmgfw.efi') { Good 'bootmgr 指向 Windows 自己的 bootmgfw.efi（正常）' }
    elseif ($bm.kv['path'] -match 'ubuntu') {
      Bad "bootmgr 的 path 指向了 ubuntu（$($bm.kv['path'])）—— 名字叫「Windows Boot Manager」却去加载 GRUB。这是自动修复/引导修复工具留下的篡改，会让 UEFI 菜单里两个同名项含义错乱"
    }
    else { Warn "bootmgr 的 path 有点不寻常：$($bm.kv['path'])" }
  }
  $cur = Get-BcdEntry $all '{current}'
  if ($cur) {
    Info "Windows   : $($cur.kv['description'])  osdevice=$($cur.kv['osdevice'])  recoveryenabled=$($cur.kv['recoveryenabled'])  bootstatuspolicy=$($cur.kv['bootstatuspolicy'])"
    if ($cur.kv['recoveryenabled'] -and $cur.kv['recoveryenabled'] -ne 'No') {
      Warn 'recoveryenabled != No：连续启动失败会自动进 WinRE —— 而 WinRE 的「启动修复」正是重建 ESP、抢走 GRUB 的那个动作'
    }
  }
}

# ---------- 4. UEFI 启动顺序 ----------
Section '4. UEFI 启动顺序'
$firm = Get-BcdEntries 'firmware'
if (-not $firm) { Warn '读固件启动项失败（需要管理员）' }
else {
  $fwb = Get-BcdEntry $firm '{fwbootmgr}'
  if (-not $fwb) { Warn 'BCD 里没有 {fwbootmgr}（可能不是 UEFI 启动）' }
  else {
    $i = 0
    $first = ''
    foreach ($g in $fwb.order) {
      $i++
      $b = Get-BcdEntry $firm $g
      $d = if ($b) { (($b.kv['description'], $b.kv['path']) | Where-Object { $_ }) -join '  ' } else { '(固件项，BCD 里没有细节)' }
      Info ("  {0}. {1,-38} {2}" -f $i, $g, $d)
      if ($i -eq 1) { $first = $d }
    }
    if ($first -match 'ubuntu') { Good 'UEFI 第一启动项是 ubuntu（开机先出 GRUB 菜单）' }
    else { Bad "UEFI 第一启动项不是 ubuntu（是「$first」）—— 开机默认进 Windows，GRUB 只能手动选；Windows 自动修复会把它挤到后面" }
  }
}

# ---------- 5. 电源 / 崩溃恢复 ----------
Section '5. 电源与崩溃恢复（决定异常关机后会不会触发自动修复）'
$hb = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled -ErrorAction SilentlyContinue).HiberbootEnabled
if ($hb -eq 0) { Good '快速启动已关闭（HiberbootEnabled=0）—— 关机不再变休眠，双系统切换不脏挂载' }
else { Bad "快速启动还开着（HiberbootEnabled=$hb）—— 关机其实进休眠，双系统切换时 NTFS 可能脏挂载" }
$ar = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl' -Name AutoReboot -ErrorAction SilentlyContinue).AutoReboot
if ($ar -eq 0) { Good '崩溃后自动重启已关闭（AutoReboot=0）—— 蓝屏会停在屏上，代码看得清' }
else { Bad "崩溃后自动重启还开着（AutoReboot=$ar）—— 蓝屏一闪就重启，取证困难" }

# ---------- 结论 ----------
Section '结论'
if ($script:Problems.Count -eq 0) {
  Write-Host '  √ 没发现可疑项。' -ForegroundColor Green
  exit 0
}
Write-Host "  × 发现 $($script:Problems.Count) 个可疑项：" -ForegroundColor Red
foreach ($p in $script:Problems) { Write-Host "    - $p" -ForegroundColor Red }
Write-Host "`n  Windows 侧修复：管理员运行 tools\boot-safety\fix-windows-boot-safety.ps1" -ForegroundColor Yellow
Write-Host "  Ubuntu  侧修复：sudo bash tools/freeze-fix/apply-all.sh（含 fstab 的 ESP UUID 修正）" -ForegroundColor Yellow
exit 1
