<#
  desktop-suite-relocate-data.ps1 —— 把桌面插件套件的「使用数据」全部收进本仓库

  做法：把外面的数据目录**移动**到 desktop-suite\_runtime\ 下，再在原位置放一个目录联接（Junction）。
        联接对程序完全透明 —— 程序照旧读写原路径，实际落在仓库里。
        这样以后调试桌面插件只需要看这个工作文件夹，而且换设备时由本脚本一键重建。

  用法：
    .\desktop-suite-relocate-data.ps1            # 看现状（默认 -Status）
    .\desktop-suite-relocate-data.ps1 -Apply     # 执行迁移（会先停掉相关程序，完事再拉起来）
    .\desktop-suite-relocate-data.ps1 -Rollback  # 反悔：拆掉联接，把数据搬回原处

  注意：
  - 只处理「使用数据」，不碰任何程序安装目录。
  - 迁移是"移动"（同盘瞬间完成）+ 联接，不是复制；数据本身不会丢。
  - desktop-suite\_runtime\ 已被 .gitignore 排除，不会进版本库（里面可能有密钥/缓存）。
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$Rollback,
    [switch]$Status,
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
if (-not ($Apply -or $Rollback -or $Status)) { $Status = $true }

$RepoRoot = Split-Path $PSScriptRoot -Parent
$Runtime  = Join-Path $RepoRoot 'desktop-suite\_runtime'
$LocalLow = Join-Path $env:USERPROFILE 'AppData\LocalLow'

# 顺序很重要：先停 Lively 引擎，再停它拉起来的壁纸进程
$MAP = @(
    [pscustomobject]@{
        Name    = 'Lively 数据目录（壁纸引擎的库与配置）'
        Outside = "$env:LOCALAPPDATA\Lively Wallpaper"
        Inside  = (Join-Path $Runtime 'lively')
        Stop    = @('Lively', 'Lively.Watchdog')
        Match   = ''
        Restart = 'lively'
    },
    [pscustomobject]@{
        Name    = '壁纸 Unity 运行数据（配置 + 日志）'
        Outside = (Join-Path $LocalLow 'MisideStart\MisideStartWallpaper')
        Inside  = (Join-Path $Runtime 'miside-unity\MisideStartWallpaper')
        Stop    = @('MisideStartWallpaper')
        Match   = ''
        Restart = ''
    },
    [pscustomobject]@{
        Name    = '桌宠 Electron 用户数据（窗口位置/缓存等）'
        Outside = "$env:APPDATA\desktop-suite"
        Inside  = (Join-Path $Runtime 'electron-appdata\desktop-suite')
        Stop    = @()
        Match   = 'dsh-whale-desktop'      # 只停桌宠那个 Electron，不动 Coopanion
        Restart = 'widget'
    }
)

function Get-EntryState($e) {
    $exists   = Test-Path -LiteralPath $e.Outside
    $isLink   = $false
    $target   = ''
    if ($exists) {
        $it = Get-Item -LiteralPath $e.Outside -Force
        if ($it.LinkType) { $isLink = $true; $target = @($it.Target)[0] }
    }
    $inExists = Test-Path -LiteralPath $e.Inside
    $files = 0; $mb = 0
    if ($exists -and -not $isLink) {
        $f = Get-ChildItem -Recurse -File -Force -ErrorAction SilentlyContinue -LiteralPath $e.Outside
        $files = $f.Count; $mb = [Math]::Round((($f | Measure-Object Length -Sum).Sum) / 1MB, 1)
    }
    elseif ($inExists) {
        $f = Get-ChildItem -Recurse -File -Force -ErrorAction SilentlyContinue -LiteralPath $e.Inside
        $files = $f.Count; $mb = [Math]::Round((($f | Measure-Object Length -Sum).Sum) / 1MB, 1)
    }
    [pscustomobject]@{
        Name = $e.Name; Outside = $e.Outside; Inside = $e.Inside
        State = $(if (-not $exists) { '外部不存在' }
                 elseif ($isLink) { '已是联接' }
                 else { '在外面（未迁移）' })
        LinkTarget = $target; Files = $files; MB = $mb
    }
}

function Show-Status {
    "仓库: $RepoRoot"
    "数据区: $Runtime"
    ""
    foreach ($e in $MAP) {
        $s = Get-EntryState $e
        $flag = switch ($s.State) { '已是联接' { '✓' } '在外面（未迁移）' { '→ 待迁移' } default { '·' } }
        "$flag  $($s.Name)"
        "      外部: $($s.Outside)"
        "      仓库: $($s.Inside)"
        "      状态: $($s.State)$(if ($s.LinkTarget) { "  → $($s.LinkTarget)" })  文件=$($s.Files)  $($s.MB)MB"
    }
}

function Stop-Related($e) {
    $killed = 0
    if ($e.Match) {
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -like "*$($e.Match)*" } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ }
    }
    foreach ($n in @($e.Stop)) {
        Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; $killed++ }
    }
    if ($killed) { Start-Sleep -Milliseconds 1200 }
    return $killed
}

function Invoke-Apply {
    New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
    foreach ($e in $MAP) {
        $s = Get-EntryState $e
        "== $($e.Name)"
        if ($s.State -eq '已是联接') { "   已就位，跳过"; continue }
        if ($s.State -eq '外部不存在') {
            New-Item -ItemType Directory -Force -Path $e.Inside | Out-Null
            New-Item -ItemType Junction -Path $e.Outside -Target $e.Inside | Out-Null
            "   外部本来就没有 → 已建好空目录 + 联接"
            continue
        }
        $k = Stop-Related $e
        "   已停相关进程 $k 个"
        New-Item -ItemType Directory -Force -Path (Split-Path $e.Inside -Parent) | Out-Null
        if (Test-Path -LiteralPath $e.Inside) {
            $old = Get-ChildItem -Recurse -File -Force -ErrorAction SilentlyContinue -LiteralPath $e.Inside
            if ($old.Count -gt 0) { "   ✗ 仓库内已有数据（$($old.Count) 个文件），为避免混淆，跳过这一项"; continue }
            Remove-Item -LiteralPath $e.Inside -Force -Recurse
        }
        Move-Item -LiteralPath $e.Outside -Destination $e.Inside -Force
        New-Item -ItemType Junction -Path $e.Outside -Target $e.Inside | Out-Null
        "   已移动 $($s.Files) 个文件 / $($s.MB)MB 到仓库，并在原位置建好联接"
    }
    if (-not $NoRestart) { Restart-Apps }
}

function Restart-Apps {
    ""
    "== 重新拉起被停掉的程序"
    # 桌宠：走它自己的计划任务
    $task = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like '*DSH Whale*' } | Select-Object -First 1
    if ($task) {
        Start-ScheduledTask -TaskName $task.TaskName -ErrorAction SilentlyContinue
        "   桌宠: 已触发计划任务 `"$($task.TaskName)`""
    } else {
        "   桌宠: 没找到计划任务，请手动启动（desktop-suite\dsh-whale\dsh-whale-desktop\start-widget.ps1）"
    }
    # Lively：走 explorer 启动 = 用普通用户令牌（从提权终端也能降权启动）
    $lively = Join-Path $env:LOCALAPPDATA 'Programs\Lively Wallpaper\Lively.exe'
    if (Test-Path -LiteralPath $lively) {
        & explorer.exe $lively
        "   Lively: 已拉起（它会自动恢复上次的动态壁纸）"
    }
    # 鼠标跟随助手
    $helperVbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'dsh-mouse-fade.vbs'
    if (Test-Path -LiteralPath $helperVbs) { & wscript.exe $helperVbs; "   助手: 已按开机自启方式拉起" }
}

function Invoke-Rollback {
    foreach ($e in $MAP) {
        $s = Get-EntryState $e
        "== $($e.Name)"
        if ($s.State -ne '已是联接') { "   当前不是联接，跳过"; continue }
        if (-not (Test-Path -LiteralPath $e.Inside)) { "   ✗ 仓库里没有数据，跳过"; continue }
        $k = Stop-Related $e
        Remove-Item -LiteralPath $e.Outside -Force        # 只删联接本身，不删目标
        Move-Item -LiteralPath $e.Inside -Destination $e.Outside -Force
        "   已撤掉联接并把数据搬回 $($e.Outside)（停掉 $k 个进程）"
    }
    if (-not $NoRestart) { Restart-Apps }
}

if ($Apply)    { Invoke-Apply }
elseif ($Rollback) { Invoke-Rollback }
else           { Show-Status }
