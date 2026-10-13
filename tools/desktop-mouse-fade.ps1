<#
  desktop-mouse-fade.ps1 —— 桌面插件「鼠标跟随透明度」外部助手（Windows）

  作用：程序常驻，盯着鼠标位置。某一栏/某个组件窗口上没鼠标时把它调成"离开时的透明值"，
        鼠标移到它上面时恢复成"悬停时的透明值"，两个状态之间按设定时长平滑过渡。

  为什么 Pogget 要用外部助手：
    Pogget 是第三方闭源软件，它的配置（.pogget_config\DesktopContainer.vina）里没有透明度项，
    UI Automation 也只能读到 1 个自绘容器（探不到任何设置控件），
    所以无法在它自己的设置界面里加开关——这个开关由本助手承载。
    （XSpace 是我们自己的源码，它是在设置窗口里原生实现的，不依赖本助手。）

  用法：
    .\desktop-mouse-fade.ps1               # 打开设置界面（双击脚本时的默认动作）
    .\desktop-mouse-fade.ps1 -Settings     # 同上
    .\desktop-mouse-fade.ps1 -Run          # 常驻运行（隐藏窗口，开机自启用这个）
    .\desktop-mouse-fade.ps1 -Install      # 装开机自启（开始菜单启动文件夹里的一个 vbs）
    .\desktop-mouse-fade.ps1 -Uninstall    # 卸掉开机自启
    .\desktop-mouse-fade.ps1 -Status       # 看目标窗口 + 当前不透明度
    .\desktop-mouse-fade.ps1 -Restore      # 全部还原：不透明 + 撤掉 LAYERED 样式

  配置文件：脚本同目录 mouse-fade.config.json（不存在则用默认值，-Settings 保存时写出）
  日志：    %LOCALAPPDATA%\dsh-whale\mouse-fade.log
#>
[CmdletBinding()]
param(
    [switch]$Run,
    [switch]$Settings,
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$Status,
    [switch]$Restore,
    [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot 'mouse-fade.config.json' }
# 日志也放进仓库（desktop-suite\_runtime\mouse-fade），外面不留使用数据
$LogDir  = Join-Path (Split-Path $PSScriptRoot -Parent) 'desktop-suite\_runtime\mouse-fade'
$LogFile = Join-Path $LogDir 'mouse-fade.log'
$StartupVbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'dsh-mouse-fade.vbs'

function Write-Log([string]$msg) {
    try {
        if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
        # 日志别无限长大
        if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 512KB) { Remove-Item $LogFile -Force }
        Add-Content -Path $LogFile -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $msg) -Encoding UTF8
    } catch { }
}

# ================== Win32 ==================
# 同一个 PowerShell 会话里重复调用（-Status / -Settings）时类型已存在，要跳过，否则 Add-Type 会报错
if (-not ('MouseFadeNative' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class MouseFadeNative {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
    [DllImport("user32.dll")] public static extern bool GetLayeredWindowAttributes(IntPtr h, out uint key, out byte alpha, out uint flags);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    /// 让本进程按真实（物理）像素工作。
    /// 否则在高缩放（如 200%）下系统会把 GetWindowRect / SetWindowPos 的坐标虚拟化，
    /// 导致「上浮 16px」在高 DPI 上实际变成 32 物理像素，而且和 XSpace 里的逻辑像素对不上。
    public static bool MakeDpiAware() {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true; } catch { }   // PER_MONITOR_AWARE_V2
        try { return SetProcessDPIAware(); } catch { return false; }
    }

    public const int  GWL_EXSTYLE  = -20;
    public const long WS_EX_LAYERED = 0x80000L;
    public const uint LWA_ALPHA    = 0x2;
    // 改完扩展样式必须让它重算边框，否则 SetLayeredWindowAttributes 不生效
    const uint SWP_NOMOVE = 0x2, SWP_NOSIZE = 0x1, SWP_NOZORDER = 0x4, SWP_FRAMECHANGED = 0x20, SWP_NOACTIVATE = 0x10;

    public static int[] RectOf(IntPtr h) {
        RECT r;
        if (!GetWindowRect(h, out r)) return null;
        return new int[] { r.L, r.T, r.R, r.B };
    }
    /// 左键是不是按着（用户正在拖窗口时不要去改它的位置）
    public static bool LeftButtonDown() {
        return (GetAsyncKeyState(0x01) & 0x8000) != 0;
    }
    /// 只移动窗口纵向位置（横向、尺寸、z 序都不动）。
    /// 用同步调用：异步（SWP_ASYNCWINDOWPOS）会偶发丢包，实测“沉回原位”那一帧会丢、
    /// 导致窗口停在上浮位置且被误当成新基准（每悬停一次就往上漂 16px）。
    /// 阻塞风险靠"不在持锁时调用"来避免（见 MouseFader.Step）。
    public static void MoveY(IntPtr h, int x, int y) {
        SetWindowPos(h, IntPtr.Zero, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    }

    public static bool IsLayered(IntPtr h) {
        return (GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64() & WS_EX_LAYERED) != 0;
    }
    public static void EnsureLayered(IntPtr h) {
        if (IsLayered(h)) return;
        SetWindowLongPtr(h, GWL_EXSTYLE, new IntPtr(GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64() | WS_EX_LAYERED));
        SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
    }
    public static void DropLayered(IntPtr h) {
        if (!IsLayered(h)) return;
        SetWindowLongPtr(h, GWL_EXSTYLE, new IntPtr(GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64() & ~WS_EX_LAYERED));
        SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
    }
    public static void SetAlpha(IntPtr h, int a) {
        if (a < 0) a = 0; if (a > 255) a = 255;
        SetLayeredWindowAttributes(h, 0, (byte)a, LWA_ALPHA);
    }
    public static int GetAlpha(IntPtr h) {
        uint k; byte a; uint f;
        return GetLayeredWindowAttributes(h, out k, out a, out f) ? a : -1;
    }
    // 某个进程的可见顶层窗口，按 z 序（最上面在前）
    public static List<IntPtr> TopWindows(uint pid) {
        var list = new List<IntPtr>();
        EnumProc cb = (h, p) => {
            uint wpid;
            GetWindowThreadProcessId(h, out wpid);
            if (wpid == pid && IsWindowVisible(h)) {
                RECT r;
                if (GetWindowRect(h, out r) && (r.R - r.L) > 20 && (r.B - r.T) > 20) list.Add(h);
            }
            return true;
        };
        EnumWindows(cb, IntPtr.Zero);
        return list;
    }
    public static bool InRect(IntPtr h, POINT pt) {
        RECT r;
        if (!GetWindowRect(h, out r)) return false;
        return pt.X >= r.L && pt.X < r.R && pt.Y >= r.T && pt.Y < r.B;
    }
    public static string TitleOf(IntPtr h) {
        var sb = new System.Text.StringBuilder(256);
        GetWindowTextW(h, sb, 256);
        var c = new System.Text.StringBuilder(256);
        GetClassNameW(h, c, 256);
        return "[" + c + "] " + sb;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
}

/// 高精度淡变引擎。
/// 之前是用 PowerShell 循环每帧算一次，受 Start-Sleep 精度（约 15.6ms）和脚本引擎抖动影响，
/// 帧长会忽长忽短，看起来就没有 XSpace（WPF 在 120Hz 刷新上做 DoubleAnimation）那么顺。
/// 现在换成：C# 后台线程 + 1ms 定时器精度，按时间基准算 CubicEase(EaseOut) 进度
/// （和 WPF 的 CubicEase 曲线完全一致），采样上限约 140Hz，并且只在“整数值真的变了”时才写窗口，
/// 省掉大量无谓的 DWM 合成。PowerShell 只负责：什么时候把目标下发下来。
public class MouseFader {
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);
    [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint ms);

    class Item {
        public IntPtr H; public int X;
        public double A0, A1, A;
        public double Y0, Y1, Y;
        public int Dur; public long T0;
        public bool Active;
        public int SettleLeft;                 // 动画结束后还需补投几次最终值
        public int LastA = -1, LastY = int.MinValue;
        public long LastWrite;
        public int Frames; public double SumMs, MaxMs; public long PrevFrame;
    }

    static readonly object gate = new object();
    static readonly System.Collections.Generic.Dictionary<IntPtr, Item> items =
        new System.Collections.Generic.Dictionary<IntPtr, Item>();
    static System.Threading.Thread th;
    static volatile bool running;
    const int WriteMinGapMs = 7;      // 写窗口的频率上限，约 140Hz
    static bool timerRaised;

    // 注意：PowerShell 5.1 的 Add-Type 编译目标是 .NET Framework，
    // 没有 Environment.TickCount64（那是 .NET Core 3.0+ 才有），所以用 Stopwatch 计时
    static readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
    static long Now() { return clock.ElapsedMilliseconds; }

    public static void Start() {
        if (running) return;
        running = true;
        th = new System.Threading.Thread(Loop);
        th.IsBackground = true;
        th.Priority = System.Threading.ThreadPriority.AboveNormal;
        th.Start();
    }
    public static void Stop() { running = false; }

    /// 下发目标：alpha 0..255，y 为目标上边距，durMs 是过渡时长
    public static void Set(IntPtr h, int x, double alpha, double y, int durMs) {
        lock (gate) {
            Item it;
            if (!items.TryGetValue(h, out it)) { it = new Item(); it.H = h; it.A = alpha; it.Y = y; items[h] = it; }
            it.X = x;
            it.A0 = it.A; it.Y0 = it.Y;
            it.A1 = alpha; it.Y1 = y;
            it.Dur = durMs < 1 ? 1 : durMs;
            it.T0 = Now();
            it.Active = true;
            it.SettleLeft = 0;
            it.LastWrite = 0;
            it.Frames = 0; it.SumMs = 0; it.MaxMs = 0; it.PrevFrame = 0;
        }
    }
    public static void Clear() { lock (gate) { items.Clear(); } }
    public static int  LastY(IntPtr h)  { lock (gate) { Item it; return items.TryGetValue(h, out it) ? it.LastY : int.MinValue; } }
    public static bool IsActive(IntPtr h) { lock (gate) { Item it; return items.TryGetValue(h, out it) && it.Active; } }
    public static bool AnyActive() { lock (gate) { foreach (Item it in items.Values) if (it.Active) return true; } return false; }
    /// 上一次过渡的性能统计（帧数 / 平均帧间隔 / 最大帧间隔），用于核对流畅度
    public static string Stats(IntPtr h) {
        lock (gate) {
            Item it;
            if (!items.TryGetValue(h, out it) || it.Frames < 2) return "";
            return string.Format("frames={0} avgGap={1:0.00}ms maxGap={2:0.0}ms", it.Frames, it.SumMs / (it.Frames - 1), it.MaxMs);
        }
    }

    static void Loop() {
        while (running) {
            bool busy = Step();      // 不在外层加锁：Step 内部自己加锁，写窗口放在锁外做
            if (busy) {
                if (!timerRaised) { timeBeginPeriod(1); timerRaised = true; }
                System.Threading.Thread.Sleep(1);          // 1ms 定时器精度 → 采样误差 1~2ms
            } else {
                if (timerRaised) { timeEndPeriod(1); timerRaised = false; }
                System.Threading.Thread.Sleep(8);          // 空闲就把定时器精度还回去，不常驻耗电
            }
        }
        if (timerRaised) { timeEndPeriod(1); timerRaised = false; }
    }

    static readonly System.Collections.Generic.List<Item> pend = new System.Collections.Generic.List<Item>();
    static readonly System.Collections.Generic.List<int> pendA = new System.Collections.Generic.List<int>();
    static readonly System.Collections.Generic.List<int> pendY = new System.Collections.Generic.List<int>();
    static readonly System.Collections.Generic.List<bool> pendMove = new System.Collections.Generic.List<bool>();

    static bool Step() {
        bool busyFlag = false;
        lock (gate) {
            pend.Clear(); pendA.Clear(); pendY.Clear(); pendMove.Clear();
            foreach (Item it in items.Values) {
                if (!it.Active) {
                    // 动画结束后再补投几次最终值：最后那一帧（尤其是"沉回原位"）必须落地
                    if (it.SettleLeft > 0) {
                        it.SettleLeft--;
                        busyFlag = true;
                        pend.Add(it); pendA.Add((int)Math.Round(it.A1)); pendY.Add((int)Math.Round(it.Y1)); pendMove.Add(true);
                    }
                    continue;
                }
                busyFlag = true;
                long now = Now();
                double t = (now - it.T0) / (double)it.Dur;
                bool done = t >= 1.0;
                if (done) { t = 1.0; it.Active = false; it.SettleLeft = 24; }
                double p = 1.0 - Math.Pow(1.0 - t, 3);   // 与 WPF CubicEase / EaseOut 完全同一条曲线
                it.A = it.A0 + (it.A1 - it.A0) * p;
                it.Y = it.Y0 + (it.Y1 - it.Y0) * p;
                if (!done && now - it.LastWrite < WriteMinGapMs) continue;
                it.LastWrite = now;
                int a = (int)Math.Round(it.A);
                int y = (int)Math.Round(it.Y);
                bool needA = a != it.LastA;
                bool needY = y != it.LastY;
                if (!needA && !needY) continue;
                if (needA) it.LastA = a;
                if (needY) it.LastY = y;
                pend.Add(it); pendA.Add(needA ? a : -1); pendY.Add(y); pendMove.Add(needY);
                if (it.PrevFrame != 0) { double d = now - it.PrevFrame; it.SumMs += d; if (d > it.MaxMs) it.MaxMs = d; }
                it.PrevFrame = now;
                it.Frames++;
            }
            if (pend.Count == 0) return busyFlag;
        }
        // 真正写窗口放在锁外：跨进程 SetWindowPos 有阻塞可能，绝不能持锁做，
        // 否则 PowerShell 侧取锁时会被一起卡住（之前那次“助手假死”就是这么来的）。
        bool drag = MouseFadeNative.LeftButtonDown();
        for (int i = 0; i < pend.Count; i++) {
            Item it = pend[i];
            if (pendA[i] >= 0) MouseFadeNative.SetAlpha(it.H, pendA[i]);
            if (pendMove[i] && !drag) MouseFadeNative.MoveY(it.H, it.X, pendY[i]);
        }
        return busyFlag;
    }
}
'@
}

[void][MouseFadeNative]::MakeDpiAware()

# ================== 配置 ==================
function Get-DefaultConfig {
    [pscustomobject]@{
        Enabled     = $true
        Processes   = @('Pogget')
        OpacityAway = 0.35
        OpacityOver = 1.0
        FadeMs      = 450
        LiftPx      = 16      # 悬停上浮多少物理像素（200% 缩放时 16 ≈ XSpace 的 8 逻辑像素）；0 = 不上浮
    }
}

function Get-Config {
    $cfg = Get-DefaultConfig
    if (Test-Path $ConfigPath) {
        try {
            $j = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($name in @($cfg.PSObject.Properties.Name)) {
                $v = $j.$name
                if ($null -ne $v) {
                    if ($name -eq 'Processes') { $cfg.Processes = @($v) } else { $cfg.$name = $v }
                }
            }
        } catch { Write-Log "配置读取失败，用默认值：$($_.Exception.Message)" }
    }
    # 兜底
    if (-not $cfg.Processes -or $cfg.Processes.Count -eq 0) { $cfg.Processes = @('Pogget') }
    $cfg.OpacityAway = [Math]::Max(0.05, [Math]::Min(1.0, [double]$cfg.OpacityAway))
    $cfg.OpacityOver = [Math]::Max(0.05, [Math]::Min(1.0, [double]$cfg.OpacityOver))
    $cfg.FadeMs      = [Math]::Max(0,   [Math]::Min(5000, [int]$cfg.FadeMs))
    $cfg.LiftPx      = [Math]::Max(0,   [Math]::Min(60,   [int]$cfg.LiftPx))
    return $cfg
}

function Save-Config($cfg) {
    $out = [ordered]@{
        Enabled     = [bool]$cfg.Enabled
        Processes   = @($cfg.Processes)
        OpacityAway = [double]$cfg.OpacityAway
        OpacityOver = [double]$cfg.OpacityOver
        FadeMs      = [int]$cfg.FadeMs
        LiftPx      = [int]$cfg.LiftPx
    }
    ($out | ConvertTo-Json -Depth 5) | Set-Content -Path $ConfigPath -Encoding UTF8
    Write-Log "配置已保存：$ConfigPath"
}

# ================== 目标窗口扫描 ==================
function Get-TargetWindows($cfg) {
    $wins = New-Object System.Collections.ArrayList
    foreach ($name in @($cfg.Processes)) {
        foreach ($p in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
            foreach ($h in [MouseFadeNative]::TopWindows([uint32]$p.Id)) { [void]$wins.Add($h) }
        }
    }
    return , @($wins)
}

function Restore-All($cfg, $restMap = $null) {
    $n = 0
    try { [MouseFader]::Clear() } catch { }
    foreach ($h in (Get-TargetWindows $cfg)) {
        if ($restMap -and $restMap.ContainsKey($h)) {
            $r = [MouseFadeNative]::RectOf($h)
            if ($r) { [MouseFadeNative]::MoveY($h, $r[0], [int]$restMap[$h]) }   # 先沉回静止位置
        }
        [MouseFadeNative]::SetAlpha($h, 255)
        [MouseFadeNative]::DropLayered($h)
        $n++
    }
    Write-Log "已还原 $n 个窗口"
    return $n
}

# ================== 常驻主循环 ==================
function Invoke-Daemon {
    Write-Log "===== 助手启动（pid $PID）====="
    $alpha = @{}      # hwnd -> 当前 0..255
    $target = @{}     # hwnd -> 目标 0..255
    $addedLayered = @{}
    $restTop = @{}    # hwnd -> 静止时的上边距（悬浮位移的基准）
    $applied = @{}    # hwnd -> 已下发给动画引擎的目标（"alpha/y"），没变就不重新启动动画
    $logged = @{}     # hwnd -> 本次过渡是否已经打过性能统计
    $targetY = @{}    # hwnd -> 目标上边距
    $lift = 0
    $lastCfgRead = [DateTime]::MinValue
    $cfg = Get-Config
    $lastState = ''
    $restoredOnExit = $false
    [MouseFader]::Start()

    try {
        while ($true) {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()

            # 每秒重新读一次配置 → 改设置界面后无需重启
            if (((Get-Date) - $lastCfgRead).TotalMilliseconds -gt 1000) {
                $cfg = Get-Config
                $lastCfgRead = Get-Date
                if (-not $cfg.Enabled) {
                    if ($alpha.Count -gt 0) { Restore-All $cfg $restTop | Out-Null; $alpha.Clear(); $target.Clear(); $addedLayered.Clear(); $restTop.Clear(); $applied.Clear(); $logged.Clear() }
                }
            }

            if ($cfg.Enabled) {
                $wins = Get-TargetWindows $cfg

                # 清理已消失的窗口
                foreach ($h in @($alpha.Keys)) {
                    if ($wins -notcontains $h) {
                        [MouseFader]::Clear()
                        $alpha.Remove($h); $target.Remove($h); $addedLayered.Remove($h)
                        $restTop.Remove($h); $applied.Remove($h); $logged.Remove($h)
                    }
                }

                $pt = New-Object MouseFadeNative+POINT
                [void][MouseFadeNative]::GetCursorPos([ref]$pt)

                # z 序从上往下找第一个"鼠标在它上面"的窗口，只有它是"悬停"，其余都算"离开"
                $hover = [IntPtr]::Zero
                foreach ($h in $wins) {
                    if ([MouseFadeNative]::InRect($h, $pt)) { $hover = $h; break }
                }

                $awayPx   = [int][Math]::Round($cfg.OpacityAway * 255)
                $overPx   = [int][Math]::Round($cfg.OpacityOver * 255)
                $lift     = [int]$cfg.LiftPx

                foreach ($h in $wins) {
                    $rect = [MouseFadeNative]::RectOf($h)
                    if (-not $rect) { continue }
                    if (-not $alpha.ContainsKey($h)) {
                        $wasLayered = [MouseFadeNative]::IsLayered($h)
                        [MouseFadeNative]::EnsureLayered($h)
                        $addedLayered[$h] = -not $wasLayered
                        $cur = [MouseFadeNative]::GetAlpha($h)
                        if ($cur -lt 0) { $cur = 255 }
                        $alpha[$h] = $cur
                        $target[$h] = $overPx
                        $restTop[$h] = $rect[1]
                        $applied[$h] = ''
                        $logged[$h] = $true
                        Write-Log ("接管窗口 0x{0:X} {1}（原本 layered={2}，静止 Y={3}）" -f $h.ToInt64(), [MouseFadeNative]::TitleOf($h), $wasLayered, $rect[1])
                    }
                    else {
                        # 只在动画完全停稳时才判断"窗口是不是被别人挪了"：
                        # SetWindowPos 现在是异步投递，窗口实际位置会落后于我们上次写入的值，
                        # 动画途中比较会出现假差值，导致静止基准被越改越偏（实测表现为沉不回原位）。
                        if (-not [MouseFader]::IsActive($h)) {
                            $myY = [MouseFader]::LastY($h)
                            if ($myY -ne [int]::MinValue -and [Math]::Abs($rect[1] - $myY) -gt 3) {
                                # 用户拖动 / 程序自己挪过 → 把当前位置认作新基准，避免和它抢位置
                                $restTop[$h] = $rect[1] + $(if ($h -eq $hover) { $lift } else { 0 })
                                $applied[$h] = ''
                            }
                            elseif ($h -ne $hover) {
                                $restTop[$h] = $rect[1]   # 鼠标不在上面且已沉到底 → 当前位置就是静止位置
                            }
                        }
                    }
                    $target[$h] = if ($h -eq $hover) { $overPx } else { $awayPx }
                    $targetY[$h] = [double]$restTop[$h] - $(if ($h -eq $hover) { $lift } else { 0 })
                }

                # 状态变化日志（便于验证效果）
                $stateNow = if ($hover -eq [IntPtr]::Zero) { '全离开' } else { '悬停 0x' + $hover.ToInt64().ToString('X') }
                if ($stateNow -ne $lastState) {
                    $lastState = $stateNow
                    Write-Log ("鼠标状态：{0}（不透明度 悬停 {1} / 离开 {2}，上浮 {3}px，过渡 {4}ms）" -f $stateNow, $cfg.OpacityOver, $cfg.OpacityAway, $cfg.LiftPx, $cfg.FadeMs)
                }

                # 把“目标变了”下发给 C# 动画引擎（同一目标不重复下发，动画才能一次走完不被重启）
                foreach ($h in @($alpha.Keys)) {
                    $key = "$($target[$h])/$([Math]::Round([double]$targetY[$h], 2))"
                    if ($applied[$h] -ne $key) {
                        $applied[$h] = $key
                        $r3 = [MouseFadeNative]::RectOf($h)
                        if ($r3) { [MouseFader]::Set($h, $r3[0], [double]$target[$h], [double]$targetY[$h], [int]$cfg.FadeMs) }
                    }
                }

                # 过渡结束后打一条性能统计（帧数/平均帧间隔/最大帧间隔），方便核对是否和 XSpace 一样顺
                foreach ($h in @($alpha.Keys)) {
                    if ([MouseFader]::IsActive($h)) { $logged[$h] = $false }
                    elseif ($logged[$h] -eq $false) {
                        $logged[$h] = $true
                        $st = [MouseFader]::Stats($h)
                        if ($st) { Write-Log ("淡变完成 0x{0:X}  {1}" -f $h.ToInt64(), $st) }
                    }
                }
            }

            # 策略循环不用那么勤：窗口枚举/状态判断降到 ~8Hz，逐帧插值由 C# 引擎负责，CPU 占用大幅下降
            $sleep = 120 - [int]$sw.Elapsed.TotalMilliseconds
            if ($sleep -lt 10) { $sleep = 10 }
            Start-Sleep -Milliseconds $sleep
        }
    } finally {
        try { [MouseFader]::Stop() } catch { }
        if (-not $restoredOnExit) {
            try { Restore-All (Get-Config) $restTop | Out-Null; Write-Log "助手退出，已还原窗口" } catch { }
        }
    }
}

# ================== 设置界面 ==================
function Show-Settings {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()

    $cfg = Get-Config
    $f = New-Object System.Windows.Forms.Form
    $f.Text = '桌面插件 · 鼠标跟随透明度'
    $f.Size = New-Object System.Drawing.Size(440, 330)
    $f.StartPosition = 'CenterScreen'
    $f.FormBorderStyle = 'FixedDialog'
    $f.MaximizeBox = $false
    $f.MinimizeBox = $false

    $y = 14
    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Text = '鼠标不在窗口上时变透明，移入时恢复；两个状态之间平滑过渡。'
    $lbl.Location = New-Object System.Drawing.Point(14, $y); $lbl.Size = New-Object System.Drawing.Size(400, 34)
    $f.Controls.Add($lbl); $y += 40

    $chk = New-Object System.Windows.Forms.CheckBox
    $chk.Text = '启用：鼠标悬停上浮、离开下沉变透明'
    $chk.Location = New-Object System.Drawing.Point(16, $y); $chk.Size = New-Object System.Drawing.Size(380, 24)
    $chk.Checked = [bool]$cfg.Enabled
    $f.Controls.Add($chk); $y += 34

    function Add-NumRow($form, [ref]$yRef, [string]$text, [double]$val, [double]$min, [double]$max, [double]$step, [int]$dec) {
        $l = New-Object System.Windows.Forms.Label
        $l.Text = $text; $l.Location = New-Object System.Drawing.Point(16, ($yRef.Value + 3)); $l.Size = New-Object System.Drawing.Size(120, 22)
        $form.Controls.Add($l)
        $n = New-Object System.Windows.Forms.NumericUpDown
        $n.Location = New-Object System.Drawing.Point(140, $yRef.Value); $n.Size = New-Object System.Drawing.Size(90, 24)
        $n.Minimum = [decimal]$min; $n.Maximum = [decimal]$max; $n.Increment = [decimal]$step
        $n.DecimalPlaces = $dec; $n.Value = [decimal]$val
        $form.Controls.Add($n)
        $yRef.Value = $yRef.Value + 32
        return $n
    }

    $numAway = Add-NumRow $f ([ref]$y) '离开时的不透明度' $cfg.OpacityAway 0.05 1.0 0.05 2
    $numOver = Add-NumRow $f ([ref]$y) '悬停时的不透明度' $cfg.OpacityOver 0.05 1.0 0.05 2
    $numFade = Add-NumRow $f ([ref]$y) '过渡时长（毫秒）'  $cfg.FadeMs      0    2000 20   0
    $numLift = Add-NumRow $f ([ref]$y) '上浮距离（像素）'  $cfg.LiftPx      0    60   4    0

    $l2 = New-Object System.Windows.Forms.Label
    $l2.Text = '目标进程（逗号分隔）'
    $l2.Location = New-Object System.Drawing.Point(16, ($y + 3)); $l2.Size = New-Object System.Drawing.Size(120, 22)
    $f.Controls.Add($l2)
    $tb = New-Object System.Windows.Forms.TextBox
    $tb.Location = New-Object System.Drawing.Point(140, $y); $tb.Size = New-Object System.Drawing.Size(270, 24)
    $tb.Text = (@($cfg.Processes) -join ', ')
    $f.Controls.Add($tb); $y += 40

    $hint = New-Object System.Windows.Forms.Label
    $hint.Text = 'Pogget 是闭源第三方软件，自身设置里没有透明/浮起选项，所以由本助手承载；XSpace 的同类开关在它自己的设置窗口里。上浮距离 0 = 不做上浮/下沉。'
    $hint.Location = New-Object System.Drawing.Point(16, $y); $hint.Size = New-Object System.Drawing.Size(400, 40)
    $hint.ForeColor = [System.Drawing.Color]::DimGray
    $f.Controls.Add($hint); $y += 44

    $ok = New-Object System.Windows.Forms.Button
    $ok.Text = '保存'; $ok.Location = New-Object System.Drawing.Point(230, $y); $ok.Size = New-Object System.Drawing.Size(84, 30)
    $ok.DialogResult = 'OK'
    $f.Controls.Add($ok)
    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text = '取消'; $cancel.Location = New-Object System.Drawing.Point(324, $y); $cancel.Size = New-Object System.Drawing.Size(84, 30)
    $cancel.DialogResult = 'Cancel'
    $f.Controls.Add($cancel)
    $f.AcceptButton = $ok; $f.CancelButton = $cancel

    if ($f.ShowDialog() -eq 'OK') {
        $cfg.Enabled     = [bool]$chk.Checked
        $cfg.OpacityAway = [double]$numAway.Value
        $cfg.OpacityOver = [double]$numOver.Value
        $cfg.FadeMs      = [int]$numFade.Value
        $cfg.LiftPx      = [int]$numLift.Value
        $cfg.Processes   = @(($tb.Text -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        if (-not $cfg.Processes -or $cfg.Processes.Count -eq 0) { $cfg.Processes = @('Pogget') }
        Save-Config $cfg
        [System.Windows.Forms.MessageBox]::Show("已保存。`n`n常驻助手会每秒重读一次配置，立刻生效（若助手没在跑，请运行 -Install 或 -Run）。", '桌面插件 · 鼠标跟随透明度') | Out-Null
    }
    $f.Dispose()
}

# ================== 开机自启 ==================
function Install-Autostart {
    $scriptPath = $PSCommandPath
    if (-not $scriptPath) { $scriptPath = Join-Path $PSScriptRoot 'desktop-mouse-fade.ps1' }
    $cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $scriptPath + '" -Run'
    $vbs = 'CreateObject("WScript.Shell").Run "' + ($cmd -replace '"', '""') + '", 0, False'
    Set-Content -Path $StartupVbs -Value $vbs -Encoding ASCII
    Write-Log "已安装开机自启：$StartupVbs"
    return $StartupVbs
}

function Uninstall-Autostart {
    if (Test-Path $StartupVbs) { Remove-Item $StartupVbs -Force }
    Write-Log "已移除开机自启：$StartupVbs"
    return $StartupVbs
}

# ================== 入口 ==================
if ($Install) {
    $p = Install-Autostart
    "已装开机自启：$p"
    "（用 -Uninstall 可撤销；现在想立刻生效可先跑 -Run）"
}
elseif ($Uninstall) {
    $p = Uninstall-Autostart
    "已移除开机自启：$p"
}
elseif ($Restore) {
    $cfg = Get-Config
    $n = Restore-All $cfg
    "已把 $n 个目标窗口还原为完全不透明。"
}
elseif ($Status) {
    $cfg = Get-Config
    "配置：Enabled=$($cfg.Enabled)  离开=$($cfg.OpacityAway)  悬停=$($cfg.OpacityOver)  过渡=$($cfg.FadeMs)ms  上浮=$($cfg.LiftPx)px  目标=$(@($cfg.Processes) -join ',')"
    "配置文件：$ConfigPath"
    "开机自启：$(if (Test-Path $StartupVbs) { '已安装  ' + $StartupVbs } else { '未安装' })"
    $wins = Get-TargetWindows $cfg
    if ($wins.Count -eq 0) { "目标窗口：没找到（目标程序没在运行？）" }
    else {
        $pt = New-Object MouseFadeNative+POINT
        [void][MouseFadeNative]::GetCursorPos([ref]$pt)
        "目标窗口（z 序，上→下）："
        foreach ($h in $wins) {
            $a = [MouseFadeNative]::GetAlpha($h)
            $rc = [MouseFadeNative]::RectOf($h)
            $on = if ([MouseFadeNative]::InRect($h, $pt)) { ' ← 鼠标在上面' } else { '' }
            "  0x$($h.ToInt64().ToString('X'))  LAYERED=$([MouseFadeNative]::IsLayered($h))  不透明度=$(if ($a -lt 0) { '未设置(255)' } else { $a })/255  rect=$(if ($rc) { "($($rc[0]),$($rc[1]))-($($rc[2]),$($rc[3]))" } else { '?' })$on  $([MouseFadeNative]::TitleOf($h))"
        }
    }
}
elseif ($Run) {
    Invoke-Daemon
}
else {
    Show-Settings
}
