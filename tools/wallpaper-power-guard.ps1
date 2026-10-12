<#
    wallpaper-power-guard.ps1

    Purpose
        Keeps the MiSide Unity "application wallpaper" (started by Lively Wallpaper) from
        heating up / draining the battery when nobody can see it.

        How it works
        It hides the wallpaper window (ShowWindow SW_HIDE) whenever the wallpaper should not
        run, and shows it again the moment it is needed. A hidden Unity window stops
        presenting frames, so GPU usage drops to ~0 and CPU to a small fraction, while the
        desktop falls back to the normal Windows wallpaper. Nothing is suspended and nothing
        blocks the shell - this is safe for the desktop (unlike suspending the process, which
        hangs Progman/Explorer because the wallpaper window is a child of the desktop).

    Hide rules (any one true => hidden)
        - on battery power                     (use -AllowOnBattery to disable this rule)
        - workstation locked / secure desktop
        - no keyboard or mouse input for -IdleMinutes
        - the desktop is covered by a maximised window (>= -CoverRatio of the work area)

    Notes
        * It never edits the wallpaper, Lively settings or the registry.
        * Stop it by ending the powershell process that runs it, or by deleting the shortcut
          from the Startup folder; if the wallpaper window is left hidden, run this script
          once with -Resume to show it again.

    Usage
        powershell -NoProfile -ExecutionPolicy Bypass -File wallpaper-power-guard.ps1
        powershell -NoProfile -ExecutionPolicy Bypass -File wallpaper-power-guard.ps1 -Status
        powershell -NoProfile -ExecutionPolicy Bypass -File wallpaper-power-guard.ps1 -Resume
#>
param(
    [string]$ProcessName = 'MisideStartWallpaper',
    [string]$WindowClass = 'UnityWndClass',
    [int]$PollMs = 800,
    [int]$IdleMinutes = 5,
    [int]$CoverDelaySeconds = 60,
    [double]$CoverRatio = 0.9,
    [int]$FadeMs = 600,
    [switch]$NoFade,
    [switch]$AllowOnBattery,
    [switch]$Status,
    [switch]$Resume,
    [string]$LogFile = "$env:LOCALAPPDATA\Lively Wallpaper\wallpaper-power-guard.log"
)

$ErrorActionPreference = 'Continue'

$signature = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class Guard2
{
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string win);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string cls, string win);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr mon, ref MONITORINFO mi);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO lii);
    [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("kernel32.dll")] public static extern uint GetTickCount();
    [DllImport("kernel32.dll")] public static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS s);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);

    public delegate bool EnumProc(IntPtr h, IntPtr lp);

    public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public uint cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
    [StructLayout(LayoutKind.Sequential)] public struct SYSTEM_POWER_STATUS
    {
        public byte ACLineStatus; public byte BatteryFlag; public byte BatteryLifePercent;
        public byte SystemStatusFlag; public uint BatteryLifeTime; public uint BatteryFullLifeTime;
    }

    private static readonly HashSet<string> SkipClasses = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow",
        "Windows.UI.Core.CoreWindow", "WindowsDashboard", "XamlExplorerHostIslandWindow",
        "MultitaskingViewFrame", "EdgeUiInputTopWndClass", "ForegroundStaging", "TaskListThumbnailWnd",
        "Ghost",              // DWM ghost window for a hung app - not a real cover
        "Windows.Internal.Shell.TabProxyWindow", "DummyDWMListenerWindow", "ThumbnailDeviceHelperWnd",
        "MSCTFIME UI", "IME", "WinUIDesktopWin32WindowClass"
    };

    public static void Init()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }   // PER_MONITOR_AWARE_V2
    }

    public static bool IsLocked()
    {
        IntPtr d = OpenInputDesktop(0, false, 0x0100);
        if (d == IntPtr.Zero) return true;
        CloseDesktop(d);
        return false;
    }

    public static double IdleSeconds()
    {
        LASTINPUTINFO lii = new LASTINPUTINFO();
        lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (!GetLastInputInfo(ref lii)) return 0;
        return (GetTickCount() - lii.dwTime) / 1000.0;
    }

    public static bool OnBattery()
    {
        SYSTEM_POWER_STATUS s;
        if (!GetSystemPowerStatus(out s)) return false;
        return s.ACLineStatus == 0;
    }

    // ---- find the wallpaper window (it is a child of the desktop, not a top level window) ----
    private static IntPtr found;
    private static int wantPid;
    private static string wantClass;

    public static IntPtr FindWindow(int pid, string cls)
    {
        found = IntPtr.Zero; wantPid = pid; wantClass = cls;
        EnumWindows(delegate(IntPtr h, IntPtr lp) { Walk(h); return found == IntPtr.Zero; }, IntPtr.Zero);
        return found;
    }

    private static void Walk(IntPtr h)
    {
        if (found != IntPtr.Zero) return;
        uint p;
        GetWindowThreadProcessId(h, out p);
        if ((int)p == wantPid)
        {
            StringBuilder sb = new StringBuilder(256);
            GetClassName(h, sb, 256);
            if (string.Equals(sb.ToString(), wantClass, StringComparison.OrdinalIgnoreCase)) { found = h; return; }
        }
        EnumChildWindows(h, delegate(IntPtr c, IntPtr lp) { Walk(c); return true; }, IntPtr.Zero);
    }

    // ---- placement / visibility helpers -----------------------------------------
    // The wallpaper window lives inside Progman, BELOW the desktop icon layer
    // (SHELLDLL_DefView). ShowWindow(SW_SHOW) raises it above the icons, which makes the
    // icons disappear and reappear (= flicker), so visibility is toggled with
    // SetWindowPos + SWP_NOZORDER and the window is explicitly kept below the icon layer.
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private const uint SWP_HIDEWINDOW = 0x0080;

    public static IntPtr DefView()
    {
        return FindWindowEx(FindWindow("Progman", null), IntPtr.Zero, "SHELLDLL_DefView", null);
    }

    public static bool IsVisible(IntPtr h) { return h != IntPtr.Zero && IsWindowVisible(h); }

    /// <summary>Put the wallpaper directly below the desktop icon layer (never above it).</summary>
    public static void PlaceBelowIcons(IntPtr h)
    {
        if (h == IntPtr.Zero) return;
        IntPtr def = DefView();
        if (def != IntPtr.Zero)
            SetWindowPos(h, def, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    /// <summary>Show the wallpaper without changing the z-order (icons stay untouched).</summary>
    public static bool Show(IntPtr h)
    {
        if (h == IntPtr.Zero) return false;
        PlaceBelowIcons(h);
        return SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

    /// <summary>Hide the wallpaper without changing the z-order.</summary>
    public static bool Hide(IntPtr h)
    {
        if (h == IntPtr.Zero) return false;
        return SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_HIDEWINDOW);
    }

    /// <summary>0 = fully transparent, 255 = fully opaque (used for the fade transition).</summary>
    public static void SetAlpha(IntPtr h, int alpha)
    {
        if (h == IntPtr.Zero) return;
        if (alpha < 0) alpha = 0;
        if (alpha > 255) alpha = 255;
        SetLayeredWindowAttributes(h, 0, (byte)alpha, 0x2);
    }

    // ---- is the desktop covered by a maximised window? ----
    public static string CoveredBy(HashSet<string> skipProcs, double ratio)
    {
        IntPtr mon = MonitorFromWindow(GetDesktopWindow(), 1);
        MONITORINFO mi = new MONITORINFO();
        mi.cbSize = (uint)Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfo(mon, ref mi)) return null;
        RECT wa = mi.rcWork;
        long area = (long)(wa.Right - wa.Left) * (long)(wa.Bottom - wa.Top);
        if (area <= 0) return null;

        string cover = null;
        EnumWindows(delegate(IntPtr h, IntPtr lp)
        {
            if (!IsWindowVisible(h)) return true;
            if (IsIconic(h)) return true;                       // minimised windows do not cover anything

            StringBuilder sb = new StringBuilder(256);
            GetClassName(h, sb, 256);
            string cls = sb.ToString();
            if (SkipClasses.Contains(cls)) return true;

            int ex = GetWindowLong(h, -20);
            if ((ex & 0x08000000) != 0 && (ex & 0x00000080) != 0) return true;   // NOACTIVATE + TOOLWINDOW
            if ((ex & 0x00000020) != 0 && (ex & 0x00080000) != 0) return true;   // TRANSPARENT + LAYERED overlay

            int cloaked = 0;
            try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }
            if (cloaked != 0) return true;                      // UWP/shell windows that are not really shown

            uint pid;
            GetWindowThreadProcessId(h, out pid);
            string pname;
            try { pname = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
            catch { return true; }
            if (skipProcs.Contains(pname)) return true;

            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            if (r.Right <= r.Left || r.Bottom <= r.Top) return true;
            if (r.Left <= -20000 || r.Top <= -20000) return true;                // parked off screen
            long ix = Math.Min(r.Right, wa.Right) - Math.Max(r.Left, wa.Left);
            long iy = Math.Min(r.Bottom, wa.Bottom) - Math.Max(r.Top, wa.Top);
            if (ix > 0 && iy > 0 && (double)(ix * iy) / area >= ratio)
            {
                cover = pname + " / " + cls;
                return false;
            }
            return true;
        }, IntPtr.Zero);

        return cover;
    }
}
"@

Add-Type -TypeDefinition $signature
[Guard2]::Init()

$skipProcs = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($n in @('Lively', 'Lively.UI.WinUI', 'Lively.Watchdog', 'powershell', 'pwsh', 'explorer')) { [void]$skipProcs.Add($n) }

function Write-Log([string]$msg) {
    $line = ('{0}  {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $msg)
    Write-Host $line
    try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
}

# ---- fade transition -------------------------------------------------------------------
# The alpha of the layered wallpaper window is animated so that showing/hiding it is a
# smooth cross-fade instead of a hard cut. The desktop icons live *above* the window, so
# they are never covered or repainted during the transition (= they do not flicker).
function Invoke-AlphaFade {
    param([IntPtr]$Handle, [int]$From, [int]$To, [int]$Ms)
    if ($NoFade -or $Ms -le 0) { [Guard2]::SetAlpha($Handle, $To); return }
    $steps = 16
    $delay = [int][Math]::Max(15, ($Ms / $steps))
    for ($i = 1; $i -le $steps; $i++) {
        $a = [int]($From + ($To - $From) * $i / $steps)
        [Guard2]::SetAlpha($Handle, $a)
        Start-Sleep -Milliseconds $delay
    }
    [Guard2]::SetAlpha($Handle, $To)
}

function Show-Wallpaper {
    param([IntPtr]$Handle)
    [Guard2]::SetAlpha($Handle, 0)          # start invisible, no flash
    [void][Guard2]::Show($Handle)           # show without changing the z-order
    Start-Sleep -Milliseconds 250           # give Unity a moment to render its first frame
    Invoke-AlphaFade -Handle $Handle -From 0 -To 255 -Ms $FadeMs
}

function Hide-Wallpaper {
    param([IntPtr]$Handle)
    Invoke-AlphaFade -Handle $Handle -From 255 -To 0 -Ms $FadeMs
    [void][Guard2]::Hide($Handle)
    [Guard2]::SetAlpha($Handle, 255)        # ready for the next fade-in
}

$script:coverSince = $null

function Get-Decision {
    if ([Guard2]::OnBattery() -and (-not $AllowOnBattery)) { return @{ Run = $false; Why = 'on battery' } }
    if ([Guard2]::IsLocked()) { return @{ Run = $false; Why = 'session locked' } }
    $idle = [Guard2]::IdleSeconds()
    if ($idle -gt ($IdleMinutes * 60)) { return @{ Run = $false; Why = ('idle {0:N0} min' -f ($idle / 60)) } }
    $cov = [Guard2]::CoveredBy($skipProcs, $CoverRatio)
    if ($null -ne $cov) {
        # The desktop is covered by a window. Do not stop right away - switching windows
        # around (alt-tab, opening/closing windows) must not make the wallpaper flap.
        # It is only hidden once the desktop stayed covered for CoverDelaySeconds.
        if ($null -eq $script:coverSince) { $script:coverSince = Get-Date }
        $held = ((Get-Date) - $script:coverSince).TotalSeconds
        if ($held -ge $CoverDelaySeconds) {
            return @{ Run = $false; Why = ('desktop covered for {0:N0}s by ' -f $held) + $cov }
        }
        return @{ Run = $true; Why = ('covered {0:N0}s/{1}s - keeping it alive' -f $held, $CoverDelaySeconds) }
    }
    $script:coverSince = $null
    return @{ Run = $true; Why = 'desktop visible' }
}

function Get-TargetPid {
    $p = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $p) { return -1 }
    return $p.Id
}

if ($Status) {
    $d = Get-Decision
    $targetPid = Get-TargetPid
    $h = if ($targetPid -gt 0) { [Guard2]::FindWindow($targetPid, $WindowClass) } else { [IntPtr]::Zero }
    Write-Host ('decision : run={0}  reason={1}' -f $d.Run, $d.Why)
    Write-Host ('context  : idle={0:N0}s  onBattery={1}  locked={2}  coverDelay={3}s  coverRatio={4}' -f [Guard2]::IdleSeconds(), [Guard2]::OnBattery(), [Guard2]::IsLocked(), $CoverDelaySeconds, $CoverRatio)
    Write-Host ('covered  : {0}' -f [Guard2]::CoveredBy($skipProcs, $CoverRatio))
    Write-Host ('wallpaper: pid={0} window={1} visible={2}' -f $targetPid, $h, [Guard2]::IsVisible($h))
    exit 0
}

if ($Resume) {
    $targetPid = Get-TargetPid
    if ($targetPid -lt 0) { Write-Host 'wallpaper process not running'; exit 0 }
    $h = [Guard2]::FindWindow($targetPid, $WindowClass)
    Show-Wallpaper -Handle $h
    Write-Host ('show pid={0} window={1} visible={2}' -f $targetPid, $h, [Guard2]::IsVisible($h))
    Write-Log ('MANUAL SHOW pid={0} window={1}' -f $targetPid, $h)
    exit 0
}

Write-Log ("guard started (target=$ProcessName poll=${PollMs}ms idle=${IdleMinutes}min coverDelay=${CoverDelaySeconds}s coverRatio=${CoverRatio} fadeMs=${FadeMs} freezeOnBattery=$(-not $AllowOnBattery))")

# self-heal: an earlier run may have been killed mid-fade, leaving the window transparent
$healPid = Get-TargetPid
if ($healPid -gt 0) {
    $healWnd = [Guard2]::FindWindow($healPid, $WindowClass)
    if ($healWnd -ne [IntPtr]::Zero) {
        if ([Guard2]::IsVisible($healWnd)) { [Guard2]::SetAlpha($healWnd, 255) }
        [Guard2]::PlaceBelowIcons($healWnd)
    }
}

$state = ''       # '', 'hidden', 'shown'
$statePid = -1
while ($true) {
    try {
        $targetPid = Get-TargetPid
        if ($targetPid -lt 0) {
            if ($state -ne '') { Write-Log 'wallpaper process not running (waiting)'; $state = ''; $statePid = -1 }
            Start-Sleep -Milliseconds $PollMs
            continue
        }
        if ($targetPid -ne $statePid) { $state = ''; $statePid = $targetPid }   # new instance -> re-evaluate

        $h = [Guard2]::FindWindow($targetPid, $WindowClass)
        if ($h -eq [IntPtr]::Zero) {
            Start-Sleep -Milliseconds $PollMs
            continue
        }

        $d = Get-Decision
        if (-not $d.Run) {
            if ([Guard2]::IsVisible($h)) {
                Hide-Wallpaper -Handle $h
                Write-Log ('HIDDEN  pid={0} ({1})' -f $targetPid, $d.Why)
            }
            $state = 'hidden'
        }
        else {
            if (-not [Guard2]::IsVisible($h)) {
                Show-Wallpaper -Handle $h
                Write-Log ('SHOWN   pid={0} ({1})' -f $targetPid, $d.Why)
            }
            $state = 'shown'
        }
    }
    catch { }

    Start-Sleep -Milliseconds $PollMs
}
