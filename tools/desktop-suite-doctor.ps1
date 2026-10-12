<#
.SYNOPSIS
  desktop-suite 体检 / 接线 / 还原 —— 换设备、或者搬完目录之后跑这个

.DESCRIPTION
  desktop-suite 是「每个插件一个包」的集散地，第三方程序本体不入库，靠脚本自动拉或离线包放回去。
  本脚本负责三件事：

    status（默认）  逐个插件报：包在不在 / 程序在不在跑 / 自启等六处引用指得对不对；
                    并读进程 PEB 的 CurrentDirectory，报出"谁的当前目录落在某个包目录里"
                    （那会让目录改名/删除报"正由另一进程使用"）。
    wire           把六处引用对齐到**本机实际存在**的插件（不存在的直接跳过 —— 这就是
                   "别的设备优先匹配电脑已有的插件、只处理相应部分"）。
    restore        用离线包把第三方包放回去（-PoggetZip / -WallpaperZip）；
                   Coopanion 请用 tools\setup-coopanion.ps1（自动 clone + 钉版本 + 打魔改补丁）。

.PARAMETER Action
  status / wire / restore

.PARAMETER SuiteDir
  desktop-suite 目录，默认 <仓库根>\desktop-suite

.PARAMETER PoggetZip
  Pogget 离线包（zip），restore 时解到 desktop-suite\pogget\

.PARAMETER WallpaperZip
  MiSide 壁纸离线包（zip），restore 时解到 desktop-suite\miside-wallpaper\

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\desktop-suite-doctor.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\desktop-suite-doctor.ps1 -Action wire

.NOTES
  中文脚本，保留 UTF-8 BOM。写注册表/改 vbs/改 Lively 库都只需要当前用户权限。
#>
[CmdletBinding()]
param(
  [ValidateSet('status', 'wire', 'restore')][string]$Action = 'status',
  [string]$SuiteDir,
  [string]$PoggetZip,
  [string]$WallpaperZip
)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $SuiteDir) { $SuiteDir = Join-Path $repoRoot 'desktop-suite' }
$SuiteDir = [System.IO.Path]::GetFullPath($SuiteDir)
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$startupDir = [Environment]::GetFolderPath('Startup')
$liveDir = Join-Path $env:LOCALAPPDATA 'Lively Wallpaper'
$liveInfo = Join-Path $liveDir 'Library\wallpapers\misidestart_miside\LivelyInfo.json'
$guardVbs = Join-Path $startupDir 'wallpaper-power-guard.vbs'
$Latin1 = [System.Text.Encoding]::GetEncoding(28591)   # Lively 的 JSON 里混了 GBK 字节，必须按字节处理

function P([string]$rel) { Join-Path $SuiteDir $rel }
function Run-Value([string]$name) {
  try { return (Get-ItemProperty -Path $runKey -Name $name -ErrorAction Stop).$name } catch { return $null }
}
function Set-Run-Value([string]$name, [string]$value) { Set-ItemProperty -Path $runKey -Name $name -Value $value }
function Procs-Matching([string]$pattern) {
  , @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like $pattern })
}
function Read-JsonBytes([string]$path) {
  if (-not (Test-Path $path)) { return $null }
  return $Latin1.GetString([System.IO.File]::ReadAllBytes($path))
}
function Write-JsonBytes([string]$path, [string]$text) {
  [System.IO.File]::WriteAllBytes($path, $Latin1.GetBytes($text))
}

# ── 进程 CurrentDirectory（PEB）—— 用来定位"挡着目录改名"的进程 ─────────────────
if (-not ('PCwd' -as [type])) {
  Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public class PCwd {
  [StructLayout(LayoutKind.Sequential)] public struct PBI { public IntPtr A; public IntPtr Peb; public IntPtr B; public IntPtr C; public IntPtr Pid; public IntPtr D; }
  [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI p, int l, out int r);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, int s, out IntPtr r);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  public static string Get(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid); if (h == IntPtr.Zero) return null;
    try { PBI p = new PBI(); int r;
      if (NtQueryInformationProcess(h, 0, ref p, Marshal.SizeOf(p), out r) != 0) return null;
      byte[] b = new byte[16]; IntPtr rd;
      if (!ReadProcessMemory(h, new IntPtr(p.Peb.ToInt64() + 0x20), b, 8, out rd)) return null;
      long pp = BitConverter.ToInt64(b, 0);
      if (!ReadProcessMemory(h, new IntPtr(pp + 0x38), b, 16, out rd)) return null;
      int len = BitConverter.ToUInt16(b, 0); long bp = BitConverter.ToInt64(b, 8);
      if (len == 0 || bp == 0 || len > 2048) return null;
      byte[] s = new byte[len];
      if (!ReadProcessMemory(h, new IntPtr(bp), s, len, out rd)) return null;
      return Encoding.Unicode.GetString(s);
    } catch { return null; } finally { CloseHandle(h); }
  }
}
'@ -ErrorAction SilentlyContinue
}

$rows = @()

# ── ① DSH 小鲸鱼（Windows 挂件）──────────────────────────────────────────────
$wDir = P 'dsh-whale\dsh-whale-desktop'
$wRun = Run-Value 'DSH Whale Desktop'
$task = Get-ScheduledTask -TaskName 'DSH Whale Desktop Widget' -ErrorAction SilentlyContinue
$taskOk = $false
if ($task) { $taskOk = (($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' ') -like "*dsh-whale-desktop*" }
$rows += [pscustomobject]@{
  插件 = 'DSH 小鲸鱼挂件'; 包 = (Test-Path (Join-Path $wDir 'main.js'))
  运行 = ((Procs-Matching '*dsh-whale-desktop*').Count -gt 0)
  接线 = $taskOk; 说明 = $(if ($task) { "计划任务 → $(($task.Actions | ForEach-Object { $_.Arguments }) -join ' ')" } else { '没有计划任务（install-autostart.ps1 可登记）' })
}

# ── ② Coopanion ──────────────────────────────────────────────────────────────
$cDir = P 'coopanion'
$cElectron = Join-Path $cDir 'node_modules\electron\dist\electron.exe'
$cRun = Run-Value 'electron.app.Electron'
$cRunOk = $false
if ($cRun -and $cElectron) { $cRunOk = ($cRun -like "*$cElectron*") -and ($cRun -like "*$cDir*") }
$rows += [pscustomobject]@{
  插件 = 'Coopanion 桌宠'; 包 = (Test-Path (Join-Path $cDir 'package.json'))
  运行 = ((Procs-Matching '*coopanion*').Count -gt 0)
  接线 = $cRunOk; 说明 = $(if (-not (Test-Path $cElectron)) { '缺 node_modules\electron（tools\setup-coopanion.ps1 还原）' } elseif ($cRunOk) { '自启指向正确' } else { "自启 = $cRun" })
}

# ── ③ XSpace ────────────────────────────────────────────────────────────────
$xExe = P 'xspace\XSpaceWidget\bin\Debug\net9.0-windows\win-x64\XSpaceWidget.exe'
$xRun = Run-Value 'XSpaceWidget'
$xRunOk = $false
if ($xRun -and (Test-Path $xExe)) { $xRunOk = $xRun -like "*$xExe*" }
$rows += [pscustomobject]@{
  插件 = 'XSpace 桌面栏'; 包 = (Test-Path (Join-Path $SuiteDir 'xspace\XSpaceWidget\XSpaceWidget.csproj'))
  运行 = ((Get-Process XSpaceWidget -ErrorAction SilentlyContinue).Count -gt 0)
  接线 = $xRunOk; 说明 = $(if (-not (Test-Path $xExe)) { '没有构建产物：cd xspace\XSpaceWidget; dotnet build' } elseif ($xRunOk) { '自启指向正确' } else { "自启 = $xRun" })
}

# ── ④ Pogget ────────────────────────────────────────────────────────────────
$pExe = P 'pogget\Pogget.exe'
$pRun = Run-Value 'MyCoolApp'
$pRunOk = $false
if ($pRun -and (Test-Path $pExe)) { $pRunOk = $pRun -like "*$pExe*" }
$rows += [pscustomobject]@{
  插件 = 'Pogget 桌面容器'; 包 = (Test-Path $pExe)
  运行 = ((Get-Process Pogget -ErrorAction SilentlyContinue).Count -gt 0)
  接线 = $pRunOk; 说明 = $(if (-not (Test-Path $pExe)) { '包不在：用离线包 -PoggetZip 还原' } elseif ($pRunOk) { '自启指向正确' } else { "自启 = $pRun" })
}

# ── ⑤ MiSide 壁纸 + 守护 ─────────────────────────────────────────────────────
$wpExe = P 'miside-wallpaper\MisideStartWallpaper.exe'
$guardPs1 = P 'miside-wallpaper\wallpaper-power-guard.ps1'
$liveTxt = Read-JsonBytes $liveInfo
$wpEsc = $wpExe.Replace('\', '\\')      # Lively 的 JSON 里路径是转义过的（C:\\Users\\...）
$liveOk = $false
if ($liveTxt -and (Test-Path $wpExe)) { $liveOk = ($liveTxt -like "*$wpEsc*") -or ($liveTxt -like "*$wpExe*") }
$vbsOk = $false
if (Test-Path $guardVbs) { $vbsOk = ((Get-Content $guardVbs -Raw) -like "*$guardPs1*") }
$guardRunning = (@(Procs-Matching '*wallpaper-power-guard*').Count -gt 0)
$rows += [pscustomobject]@{
  插件 = 'MiSide 壁纸+守护'; 包 = (Test-Path $wpExe)
  运行 = ((Get-Process MisideStartWallpaper -ErrorAction SilentlyContinue).Count -gt 0)
  接线 = ($liveOk -and $vbsOk); 说明 = "Lively库=$liveOk / 启动vbs=$vbsOk / 守护在跑=$guardRunning"
}

# ── ⑥ XNoteWidget（只报包在不在，不接线）──────────────────────────────────────
$rows += [pscustomobject]@{
  插件 = 'XNoteWidget 工程'; 包 = (Test-Path (Join-Path $SuiteDir 'xspace-notes\XNoteWidget'))
  运行 = $false; 接线 = $true; 说明 = '源码入库，用 dotnet build 构建（不参与自启）'
}

Write-Host ''
Write-Host '=== desktop-suite 体检 ===' -ForegroundColor Cyan
Write-Host ("  suite 目录 = $SuiteDir")
if (-not (Test-Path $SuiteDir)) { Write-Host '  目录不存在：先 clone 仓库（desktop-suite/ 在仓库里）' -ForegroundColor Yellow }
$rows | Format-Table -AutoSize | Out-String | Write-Host

Write-Host '=== 谁的当前目录落在某个包里（会让目录改不了名/删不掉）===' -ForegroundColor Cyan
$stuck = 0
foreach ($pr in (Get-Process -ErrorAction SilentlyContinue)) {
  if ($pr.Id -eq $PID) { continue }
  $c = $null; try { $c = [PCwd]::Get($pr.Id) } catch { }
  if ($c -and $c.StartsWith($SuiteDir, [StringComparison]::OrdinalIgnoreCase)) { $stuck++; Write-Host "  $($pr.ProcessName) (pid $($pr.Id))  cwd = $c" }
}
if ($stuck -eq 0) { Write-Host '  没有 ✓' }

if ($Action -eq 'restore') {
  Write-Host ''
  Write-Host '=== 还原（只处理"本机有离线包"的那部分）===' -ForegroundColor Cyan
  if ($PoggetZip) {
    $dst = P 'pogget'; New-Item -ItemType Directory -Force -Path $dst | Out-Null
    Expand-Archive -Path $PoggetZip -DestinationPath $dst -Force
    Write-Host "  Pogget：已解包到 $dst"
  }
  if ($WallpaperZip) {
    $dst = P 'miside-wallpaper'; New-Item -ItemType Directory -Force -Path $dst | Out-Null
    Expand-Archive -Path $WallpaperZip -DestinationPath $dst -Force
    Write-Host "  MiSide 壁纸：已解包到 $dst"
  }
  if (-not $PoggetZip -and -not $WallpaperZip) {
    Write-Host '  没给离线包（-PoggetZip / -WallpaperZip）；Coopanion 请用 tools\setup-coopanion.ps1' -ForegroundColor Yellow
  }
}

if ($Action -eq 'wire') {
  Write-Host ''
  Write-Host '=== 接线（只对本机已存在的插件动手）===' -ForegroundColor Cyan
  # ② Coopanion 自启
  if ((Test-Path $cElectron) -and (Test-Path (Join-Path $cDir 'package.json'))) {
    $v = "`"$cElectron`" `"$cDir`" --background"
    Set-Run-Value 'electron.app.Electron' $v
    Write-Host "  已写 HKCU Run\electron.app.Electron = $v"
  } else { Write-Host '  Coopanion 包/依赖不在，跳过（先跑 tools\setup-coopanion.ps1）' }
  # ③ XSpace 自启
  if (Test-Path $xExe) { Set-Run-Value 'XSpaceWidget' "`"$xExe`""; Write-Host "  已写 HKCU Run\XSpaceWidget = `"$xExe`""" }
  else { Write-Host '  XSpace 没有构建产物，跳过（dotnet build 之后再来）' }
  # ④ Pogget 自启
  if (Test-Path $pExe) { Set-Run-Value 'MyCoolApp' "`"$pExe`""; Write-Host "  已写 HKCU Run\MyCoolApp = `"$pExe`"""; if (-not (Get-Process Pogget -ErrorAction SilentlyContinue)) { Start-Process -FilePath $pExe -WorkingDirectory (Split-Path $pExe) ; Write-Host '  已启动 Pogget' } }
  else { Write-Host '  Pogget 包不在，跳过' }
  # ⑤ 壁纸：Lively 库 + 启动 vbs + 守护
  if ((Test-Path $wpExe) -and (Test-Path $liveInfo)) {
    $t = Read-JsonBytes $liveInfo
    if (($t -notlike "*$wpEsc*") -and ($t -notlike "*$wpExe*")) {
      $oldDir = ($t -split '"FileName"\s*:\s*"')[1]
      if ($oldDir) {
        $oldPath = ($oldDir -split '"')[0]
        $t2 = $t.Replace($oldPath, ($wpExe -replace '\\', '\\'))
        Write-JsonBytes $liveInfo $t2
        Write-Host '  已改 Lively 库 LivelyInfo.json 的 FileName（按字节替换）'
      }
    } else { Write-Host '  Lively 库指向已正确' }
  } else { Write-Host '  壁纸包或 Lively 库不在，跳过' }
  if ((Test-Path $guardPs1) -and (Test-Path $startupDir)) {
    $vbs = "' Starts the wallpaper power guard hidden (no console window).`r`n" +
           "' Remove this file to disable the power saving behaviour.`r`n" +
           "' Add the parameter -AllowOnBattery after the script path to keep the wallpaper`r`n" +
           "' animating while the laptop is unplugged.`r`n" +
           "CreateObject(`"WScript.Shell`").Run `"powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"`"$guardPs1`"`"`", 0, False`r`n"
    [System.IO.File]::WriteAllBytes($guardVbs, $Latin1.GetBytes($vbs))
    Write-Host "  已重写启动文件夹 wallpaper-power-guard.vbs → $guardPs1"
    if (@(Procs-Matching '*wallpaper-power-guard*').Count -eq 0) {
      Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$guardVbs`"" ; Write-Host '  已启动壁纸守护'
    }
  }
  # ① DSH 挂件：自启交给它自己的脚本（计划任务），这里只提示
  if (Test-Path (Join-Path $wDir 'install-autostart.ps1')) {
    Write-Host "  DSH 挂件自启：powershell -File `"$(Join-Path $wDir 'install-autostart.ps1')`"（需要时再跑）"
  }
}

Write-Host ''
Write-Host '=== 结论 ===' -ForegroundColor Cyan
$bad = @($rows | Where-Object { $_.包 -and (-not $_.接线) })
if ($bad.Count -eq 0) { Write-Host '  本机已装插件的接线全部正确 ✓' -ForegroundColor Green }
else { Write-Host ("  有 {0} 个插件接线需要修：{1}`n  跑一次：powershell -ExecutionPolicy Bypass -File tools\desktop-suite-doctor.ps1 -Action wire" -f $bad.Count, (($bad | ForEach-Object { $_.插件 }) -join '、')) -ForegroundColor Yellow }
Write-Host '  详细还原步骤见 docs\desktop-suite-clone.md'
