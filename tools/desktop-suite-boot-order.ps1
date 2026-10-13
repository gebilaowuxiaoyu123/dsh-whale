<#
  desktop-suite-boot-order.ps1 —— 开机分级启动器（错峰 + 固定顺序 + 缺插件自动跳过）

  为什么要它：五个插件原来各自抢占自启（计划任务 + 注册表 Run + 启动文件夹同时开火），
  开机瞬间 CPU/GPU 峰值叠在一起，桌面会明显卡一下。本脚本把它们排成一条队：
      ① dsh 小鲸鱼 → ② lived2d 小鲸鱼(Coopanion) → ③ 动态壁纸(Lively+MiSide+守护) → ④ Pogget → ⑤ XSpace → ⑥ 鼠标跟随助手
  每一步都"等上一步的进程真的起来了 + 再空一段间隔"才放行下一步，所有时间戳写日志，事后可核对。

  辅助包定位（重要）：
  - 脚本本身在 tools/（随仓库走，别的设备也能用）；
  - 每台机器的配置在 desktop-suite/_runtime/boot-order/config.json —— 这个目录被 .gitignore 排除，
    所以别的系统拉仓库时不会带上你的机器配置，而是按本机情况生成自己的（缺哪个插件就跳过哪一步）。

  用法：
    .\desktop-suite-boot-order.ps1             # 看现状：各步插件在不在、当前自启项、上次启动耗时
    .\desktop-suite-boot-order.ps1 -DryRun     # 只按顺序打印计划（不动任何程序）
    .\desktop-suite-boot-order.ps1 -Run        # 真正按顺序启动（开机自启用它）
    .\desktop-suite-boot-order.ps1 -Install    # 接管自启：备份现有自启项后，改为只由本启动器拉起
    .\desktop-suite-boot-order.ps1 -Restore    # 还原：把自启项都还回去
#>
[CmdletBinding()]
param(
    [switch]$Run,
    [switch]$DryRun,
    [switch]$Install,
    [switch]$Restore,
    [switch]$Status,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
if (-not ($Run -or $DryRun -or $Install -or $Restore -or $Status -or $Uninstall)) { $Status = $true }

$RepoRoot   = Split-Path $PSScriptRoot -Parent
$SuiteDir   = Join-Path $RepoRoot 'desktop-suite'
$CfgDir     = Join-Path $SuiteDir '_runtime\boot-order'
$CfgPath    = Join-Path $CfgDir 'config.json'
$LogFile    = Join-Path $CfgDir 'boot-order.log'
$BackupPath = Join-Path $CfgDir 'autostart-backup.json'
$StartupDir = [Environment]::GetFolderPath('Startup')
$MyVbs      = Join-Path $StartupDir 'dsh-boot-order.vbs'
$HelperVbs  = Join-Path $StartupDir 'dsh-mouse-fade.vbs'
$GuardVbs   = Join-Path $StartupDir 'wallpaper-power-guard.vbs'
$RunKey     = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'

function Write-Log([string]$m) {
    try {
        if (-not (Test-Path $CfgDir)) { New-Item -ItemType Directory -Force -Path $CfgDir | Out-Null }
        if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 256KB) { Remove-Item $LogFile -Force }
        Add-Content -Path $LogFile -Value ("{0:HH:mm:ss.fff}  {1}" -f (Get-Date), $m) -Encoding UTF8
    } catch { }
    Write-Host ("  " + $m)
}

# 五步顺序 + 第六步助手；GapSec = 这一步完成后额外空多久再走下一步
$DefaultStages = @(
    [pscustomobject]@{ Step=1; Name='dsh 小鲸鱼（桌面挂件）';      Plugin='dsh-whale\dsh-whale-desktop'; Kind='task';   Target='DSH Whale Desktop Widget'; Match='dsh-whale-desktop'; WaitSec=30; GapSec=6 },
    [pscustomobject]@{ Step=2; Name='lived2d 小鲸鱼（Coopanion）'; Plugin='coopanion';                    Kind='exe';    Target='node_modules\electron\dist\electron.exe'; Match='coopanion'; Args='"<dir>" --background'; WaitSec=35; GapSec=6 },
    [pscustomobject]@{ Step=3; Name='动态壁纸（Lively + MiSide + 守护）'; Plugin='miside-wallpaper';     Kind='lively'; Target=''; Match='MisideStartWallpaper'; WaitSec=45; GapSec=8 },
    [pscustomobject]@{ Step=4; Name='Pogget（桌面收纳）';          Plugin='pogget';                       Kind='exe';    Target='Pogget.exe'; Match='Pogget'; Args=''; WaitSec=25; GapSec=6 },
    [pscustomobject]@{ Step=5; Name='XSpace（竞赛通知栏）';        Plugin='xspace';                       Kind='exe';    Target='XSpaceWidget\bin\Debug\net9.0-windows\win-x64\XSpaceWidget.exe'; Match='XSpaceWidget'; Args=''; WaitSec=25; GapSec=4 },
    [pscustomobject]@{ Step=6; Name='鼠标跟随透明度助手';          Plugin='';                             Kind='helper'; Target=''; Match='desktop-mouse-fade'; WaitSec=10; GapSec=0 }
)

function Get-Config {
    if (Test-Path $CfgPath) {
        try {
            $j = Get-Content $CfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($j.Stages -and @($j.Stages).Count -gt 0) { return $j }
        } catch { Write-Log "配置读取失败，用默认顺序：$($_.Exception.Message)" }
    }
    $cfg = [pscustomobject]@{ Enabled = $true; Stages = $DefaultStages }
    try {
        if (-not (Test-Path $CfgDir)) { New-Item -ItemType Directory -Force -Path $CfgDir | Out-Null }
        ($cfg | ConvertTo-Json -Depth 6) | Set-Content $CfgPath -Encoding UTF8
    } catch { }
    return $cfg
}

function Get-StagePath($s) {
    if ($s.Kind -eq 'helper') { return (Join-Path $RepoRoot 'tools\desktop-mouse-fade.ps1') }
    if ([string]::IsNullOrWhiteSpace($s.Plugin)) { return '' }
    return (Join-Path $SuiteDir $s.Plugin)
}

function Test-StageReady($s) {
    $base = Get-StagePath $s
    if (-not $base -or -not (Test-Path -LiteralPath $base)) { return $false }
    if ($s.Kind -eq 'lively') {
        return (Test-Path (Join-Path $env:LOCALAPPDATA 'Programs\Lively Wallpaper\Lively.exe'))
    }
    if ($s.Kind -eq 'helper') { return (Test-Path -LiteralPath $base) }
    return $true
}

function Start-Stage($s) {
    $base = Get-StagePath $s
    switch ($s.Kind) {
        'task' {
            $t = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -eq $s.Target } | Select-Object -First 1
            if (-not $t) { throw "找不到计划任务 $($s.Target)" }
            if ($t.State -eq 'Disabled') { Enable-ScheduledTask -TaskName $t.TaskName | Out-Null }
            Start-ScheduledTask -TaskName $t.TaskName
        }
        'exe' {
            $exe = Join-Path $base $s.Target
            if (-not (Test-Path -LiteralPath $exe)) { throw "找不到 $exe" }
            $a = $s.Args -replace '<dir>', $base
            $cmd = '"' + $exe + '"' + $(if ($a) { ' ' + $a } else { '' })
            Start-ViaWsh -CmdLine $cmd -WorkDir $base -Tag 'exe'
        }
        'lively' {
            $lv = Join-Path $env:LOCALAPPDATA 'Programs\Lively Wallpaper\Lively.exe'
            if (-not (Test-Path -LiteralPath $lv)) { throw "找不到 Lively.exe" }
            # 走 explorer 启动 = 用普通用户令牌（就算从提权终端/任务里跑也不会把 Lively 抬成管理员）
            & explorer.exe $lv
            Start-Sleep -Milliseconds 500
            if (Test-Path -LiteralPath $GuardVbs) { & wscript.exe $GuardVbs }   # 壁纸守护（覆盖/电池时冻结壁纸）
        }
        'helper' {
            $cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $base + '" -Run'
            Start-ViaWsh -CmdLine $cmd -WorkDir '' -Tag 'helper'
        }
    }
}

function Start-ViaWsh([string]$CmdLine, [string]$WorkDir, [string]$Tag) {
    # 生成并执行一个 vbs 启动器。两个坑（都踩过）：
    #   1) vbs 文件**不能启动后立刻删** —— wscript 还没打开它就被删了，会弹“无法找到脚本文件”且进程起不来；
    #      所以写到固定路径（_runtime 下），覆盖写、不删。
    #   2) VBScript 字符串里的双引号要翻倍：s.Run """<exe>"" ""<dir>"" --background", 0, False
    if (-not (Test-Path $CfgDir)) { New-Item -ItemType Directory -Force -Path $CfgDir | Out-Null }
    $vbs = Join-Path $CfgDir ('launch-' + $Tag + '.vbs')
    $lines = @('Set s = CreateObject("WScript.Shell")')
    if ($WorkDir) { $lines += 's.CurrentDirectory = "' + $WorkDir + '"' }
    $lines += ('s.Run "' + ($CmdLine -replace '"', '""') + '", 0, False')
    Set-Content -Path $vbs -Value ($lines -join "`r`n") -Encoding ASCII
    & wscript.exe $vbs
}

function Wait-Stage($s) {
    if (-not $s.Match) { return $true }
    $deadline = (Get-Date).AddSeconds([int]$s.WaitSec)
    while ((Get-Date) -lt $deadline) {
        $p = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -and $_.CommandLine -like "*$($s.Match)*" } | Select-Object -First 1
        if ($p) { return $true }
        Start-Sleep -Milliseconds 400
    }
    return $false
}

function Invoke-Boot {
    $cfg = Get-Config
    if (-not $cfg.Enabled) { Write-Log '启动器已禁用（config.json 里 Enabled=false），本次不做事'; return }
    Write-Log '===== 分级启动开始 ====='
    $t0 = Get-Date
    foreach ($s in ($cfg.Stages | Sort-Object Step)) {
        if (-not (Test-StageReady $s)) {
            Write-Log "[$($s.Step)] 跳过：本机没有这个插件（$($s.Plugin)）"
            continue
        }
        $ts = Get-Date
        try { Start-Stage $s; Write-Log ("[$($s.Step)] {0} — 已拉起（用时 {1:0.0}s）" -f $s.Name, ((Get-Date) - $ts).TotalSeconds) }
        catch { Write-Log ("[$($s.Step)] {0} — 启动失败：{1}" -f $s.Name, $_.Exception.Message); continue }
        $ok = Wait-Stage $s
        Write-Log ("[$($s.Step)] {0} — {1}（累计 {2:0.0}s）" -f $s.Name, $(if ($ok) { '进程已就绪' } else { '等超时，继续下一步' }), ((Get-Date) - $t0).TotalSeconds)
        if ([int]$s.GapSec -gt 0) { Start-Sleep -Seconds ([int]$s.GapSec) }
    }
    Write-Log ("===== 全部完成，总耗时 {0:0.0}s =====" -f ((Get-Date) - $t0).TotalSeconds)
}

function Show-Status {
    $cfg = Get-Config
    "仓库: $RepoRoot"
    "配置: $CfgPath"
    "日志: $LogFile"
    ""
    "顺序计划（GapSec = 这一步后额外间隔）："
    foreach ($s in ($cfg.Stages | Sort-Object Step)) {
        $ready = Test-StageReady $s
        "  [$($s.Step)] $($s.Name)  插件=$($s.Plugin)  等待=$($s.WaitSec)s  间隔=$($s.GapSec)s  $(if ($ready) { '✓ 本机存在' } else { '· 跳过（没有）' })"
    }
    ""
    "当前自启项："
    $t = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -eq 'DSH Whale Desktop Widget' }
    if ($t) { "  计划任务 DSH Whale Desktop Widget = $($t.State)" } else { "  计划任务：未找到" }
    foreach ($k in @('electron.app.Electron', 'XSpaceWidget', 'MyCoolApp', 'Lively')) {
        $v = (Get-ItemProperty -Path $RunKey -Name $k -ErrorAction SilentlyContinue).$k
        if ($v) { "  HKCU Run $k = $v" }
    }
    foreach ($f in @($MyVbs, $HelperVbs, $GuardVbs)) {
        "  启动文件夹 $(Split-Path $f -Leaf) = $(if (Test-Path $f) { '存在' } else { '不在' })"
    }
    if (Test-Path $BackupPath) { "  自启备份: $BackupPath" }
    if (Test-Path $LogFile) { ""; "上次启动日志（最后 12 行）："; Get-Content $LogFile -Tail 12 -Encoding UTF8 | ForEach-Object { "  $_" } }
}

function Install-Takeover {
    if (-not (Test-Path $CfgDir)) { New-Item -ItemType Directory -Force -Path $CfgDir | Out-Null }
    $backup = [ordered]@{ Created = (Get-Date).ToString('s'); RunKeys = @{}; TaskDisabled = $false; StartupFiles = @() }
    # 1) 备份 HKCU Run
    foreach ($k in @('electron.app.Electron', 'XSpaceWidget', 'MyCoolApp')) {
        $v = (Get-ItemProperty -Path $RunKey -Name $k -ErrorAction SilentlyContinue).$k
        if ($v) { $backup.RunKeys[$k] = $v; Remove-ItemProperty -Path $RunKey -Name $k -Force }
    }
    # 2) 计划任务：禁用它的登录触发（启动器按需 Start-ScheduledTask 拉起）
    $t = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -eq 'DSH Whale Desktop Widget' }
    if ($t) {
        try { Export-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath | Set-Content (Join-Path $CfgDir 'task-DSH-Whale-Desktop-Widget.xml') -Encoding UTF8 } catch { }
        Disable-ScheduledTask -TaskName $t.TaskName | Out-Null
        $backup.TaskDisabled = $true
    }
    # 3) 助手自启也交给启动器（最后一步），先备份再移除；壁纸守护保持原样（它很轻，且第 3 步也会确保它在跑）
    if (Test-Path $HelperVbs) {
        $backup.StartupFiles += @{ Name = 'dsh-mouse-fade.vbs'; Content = (Get-Content $HelperVbs -Raw -Encoding ASCII) }
        Remove-Item $HelperVbs -Force
    }
    ($backup | ConvertTo-Json -Depth 6) | Set-Content $BackupPath -Encoding UTF8
    # 4) 自己的自启（启动文件夹里的一个 vbs）
    $cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'desktop-suite-boot-order.ps1') + '" -Run'
    Set-Content -Path $MyVbs -Value ('CreateObject("WScript.Shell").Run "' + ($cmd -replace '"', '""') + '", 0, False') -Encoding ASCII
    Write-Host "已接管自启："
    Write-Host "  已备份到 $BackupPath"
    Write-Host "  已移除 HKCU Run: $($backup.RunKeys.Keys -join ', ')"
    Write-Host "  已禁用计划任务的登录触发（启动器会按需拉起）"
    Write-Host "  已装自己的自启: $MyVbs"
}

function Restore-Autostart {
    if (-not (Test-Path $BackupPath)) { throw "没有备份：$BackupPath" }
    $b = Get-Content $BackupPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($k in $b.RunKeys.PSObject.Properties.Name) { Set-ItemProperty -Path $RunKey -Name $k -Value $b.RunKeys.$k }
    if ($b.TaskDisabled) {
        $t = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -eq 'DSH Whale Desktop Widget' }
        if ($t) { Enable-ScheduledTask -TaskName $t.TaskName | Out-Null }
    }
    foreach ($f in @($b.StartupFiles)) { Set-Content -Path (Join-Path $StartupDir $f.Name) -Value $f.Content -Encoding ASCII }
    if (Test-Path $MyVbs) { Remove-Item $MyVbs -Force }
    Write-Host "已还原自启项（Run 值 / 计划任务 / 启动文件夹），并移除启动器的自启。"
}

if ($Uninstall) { Restore-Autostart }
elseif ($Install) { Install-Takeover }
elseif ($Run) { Invoke-Boot }
elseif ($DryRun) {
    $cfg = Get-Config
    "按顺序将执行（DryRun，不动任何程序）："
    foreach ($s in ($cfg.Stages | Sort-Object Step)) {
        "  [$($s.Step)] $($s.Name)  $(if (Test-StageReady $s) { '会启动' } else { '跳过（缺插件）' })  等 $($s.WaitSec)s + 空 $($s.GapSec)s"
    }
}
else { Show-Status }
