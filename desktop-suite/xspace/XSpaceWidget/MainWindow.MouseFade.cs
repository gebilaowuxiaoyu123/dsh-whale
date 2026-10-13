using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media.Animation;
using System.Windows.Threading;

namespace XSpaceWidget
{
    /// <summary>
    /// 鼠标跟随的悬浮效果（可在设置窗口开关 + 设两个状态的透明值 + 过渡时长）：
    ///   鼠标悬停在窗口上 → 向上浮起 HoverLiftPx、不透明度 OpacityOver；
    ///   鼠标离开窗口     → 沉回原位、不透明度 OpacityAway；两边都按 FadeMs 平滑过渡。
    ///
    /// 为什么用轮询而不是 MouseEnter/MouseLeave：
    /// 窗口里嵌了 WebView2（Steam 价格视图）等子 HWND，鼠标在它们上面时
    /// WPF 收不到窗口级的 Enter/Leave，会导致状态判断长时间不更新。
    /// 这里用 90ms 轮询「光标坐标 + 窗口屏幕矩形」判定，稳定且开销可忽略。
    /// </summary>
    public partial class MainWindow
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int X;
            public int Y;
        }

        // 注意：RECT 结构与 GetWindowRect 的 P/Invoke 声明已在 MainWindow.xaml.cs（窗口缩放）里，
        // 同一个 partial 类不能重复声明，这里直接复用。

        [DllImport("user32.dll")]
        private static extern bool GetCursorPos(out POINT p);

        private DispatcherTimer? _fadeTimer;
        private double _fadeWant = 1.0;        // 当前应该处于的目标不透明度（用来判断"目标变了"）
        private bool _fadeHadCursor = true;     // 上一帧鼠标在不在窗口上（日志用）
        private double _restTop = double.NaN;  // 窗口的"静止"上边距（悬浮位移前的基值）
        private double _liftNow = 0;           // 当前已浮起多少（正数=浮起）
        private double _liftWant = 0;          // 目标浮起量

        /// <summary>排查用：设环境变量 XSPACE_FADE_LOG=1 时，每次淡入淡出写日志到 %TEMP%\xspace-mousefade.log。</summary>
        private static readonly bool FadeLog = Environment.GetEnvironmentVariable("XSPACE_FADE_LOG") == "1";

        /// <summary>在窗口构造时调用一次：启动轮询。</summary>
        private void InitMouseFade()
        {
            _fadeTimer = new DispatcherTimer(DispatcherPriority.Background)
            {
                Interval = TimeSpan.FromMilliseconds(90)
            };
            _fadeTimer.Tick += (_, _) => TickMouseFade();
            _fadeTimer.Start();
            TickMouseFade();
        }

        /// <summary>每 90ms 判一次：鼠标在不在窗口上 → 需要不透明度/浮起量多少。</summary>
        private void TickMouseFade()
        {
            var c = _settings.Config;

            if (double.IsNaN(_restTop)) _restTop = Top;   // 首次：当前的位置就是静止位置

            // 关掉开关 → 立刻还原为完全不透明 + 沉回原位（并清掉残留动画）
            if (!c.MouseFade)
            {
                if (Math.Abs(Opacity - 1.0) > 0.001)
                {
                    BeginAnimation(OpacityProperty, null);
                    Opacity = 1.0;
                }
                if (_liftNow > 0.01)
                {
                    BeginAnimation(TopProperty, null);
                    Top = _restTop;
                    _liftNow = 0;
                }
                _fadeWant = 1.0;
                _liftWant = 0;
                return;
            }

            double away = Math.Clamp(c.OpacityAway, 0.05, 1.0);
            double over = Math.Clamp(c.OpacityOver, 0.05, 1.0);
            int fadeMs = Math.Clamp(c.FadeMs, 0, 5000);
            double lift = Math.Clamp(c.HoverLiftPx, 0.0, 40.0);

            // 缩放窗口 / 触屏拖拽窗口时不要淡、也不要浮，否则会和用户的手抢位置
            bool busy = _resizing || _manipulating;
            bool inside = busy || CursorInsideWindow();
            _fadeHadCursor = inside;

            // 空闲且已沉到底时，把当前位置认作新的静止位置（用户拖过窗口后自动校正）
            if (!busy && !inside && Math.Abs(_liftNow) < 0.01)
            {
                _restTop = Top;
            }

            double wantOpacity = inside ? over : away;
            if (Math.Abs(wantOpacity - _fadeWant) > 0.001)
            {
                _fadeWant = wantOpacity;
                FadeOpacityTo(wantOpacity, fadeMs);
            }

            double wantLift = inside ? lift : 0.0;
            if (Math.Abs(wantLift - _liftWant) > 0.01)
            {
                _liftWant = wantLift;
                FadeLiftTo(_restTop - wantLift, fadeMs);
            }
            else if (lift > 0.01 && !double.IsNaN(_restTop))
            {
                // 浮起量没变，但用户/代码可能刚挪过窗口 → 把当前位置认作新基准，保持偏移不变
                _liftNow = _restTop - Top;
                if (Math.Abs(_liftNow - _liftWant) > 0.5)
                {
                    _restTop = Top + _liftWant;
                    _liftNow = _liftWant;
                }
            }
        }

        /// <summary>在 fadeMs 内把窗口上边距平滑移到目标值（配合 _restTop 做上浮/下沉）。</summary>
        private void FadeLiftTo(double targetTop, int fadeMs)
        {
            if (double.IsNaN(_restTop) || double.IsNaN(targetTop)) return;
            double from = Top;

            if (fadeMs <= 0)
            {
                BeginAnimation(TopProperty, null);
                Top = targetTop;
                _liftNow = _restTop - targetTop;
            }
            else
            {
                var anim = new DoubleAnimation(Top, targetTop, TimeSpan.FromMilliseconds(fadeMs))
                {
                    FillBehavior = FillBehavior.Stop,
                    EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
                };
                Top = targetTop;
                BeginAnimation(TopProperty, anim);
                _liftNow = _restTop - targetTop;
            }

            if (FadeLog)
            {
                try
                {
                    System.IO.File.AppendAllText(
                        System.IO.Path.Combine(System.IO.Path.GetTempPath(), "xspace-mousefade.log"),
                        string.Format("{0:HH:mm:ss.fff}  位置 {1:0.#} -> {2:0.#}  ({3}ms) [{4}]\r\n",
                            DateTime.Now, from, targetTop, fadeMs, _fadeHadCursor ? "悬停上浮" : "离开下沉"));
                }
                catch { }
            }
        }

        /// <summary>在 fadeMs 内从当前不透明度平滑过渡到目标值。</summary>
        private void FadeOpacityTo(double to, int fadeMs)
        {
            double from = Opacity;

            if (FadeLog)
            {
                try
                {
                    System.IO.File.AppendAllText(
                        System.IO.Path.Combine(System.IO.Path.GetTempPath(), "xspace-mousefade.log"),
                        string.Format("{0:HH:mm:ss.fff}  {1:0.00} -> {2:0.00}  ({3}ms)  {4}\r\n",
                            DateTime.Now, from, to, fadeMs, _fadeHadCursor ? "鼠标在窗口上" : "鼠标已离开"));
                }
                catch { /* 诊断日志不能影响功能 */ }
            }

            if (fadeMs <= 0)
            {
                BeginAnimation(OpacityProperty, null);
                Opacity = to;
                return;
            }

            var anim = new DoubleAnimation(Opacity, to, TimeSpan.FromMilliseconds(fadeMs))
            {
                // 动画只负责"过程"，结束把值交回基值，避免以后改不透明度被动画锁住
                FillBehavior = FillBehavior.Stop,
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
            };
            Opacity = to;
            BeginAnimation(OpacityProperty, anim);
        }

        /// <summary>光标是否落在本窗口的屏幕矩形内（物理像素，和 GetCursorPos 同一坐标系）。</summary>
        private bool CursorInsideWindow()
        {
            if (!GetCursorPos(out var p)) return _fadeHadCursor;
            var h = new WindowInteropHelper(this).Handle;
            if (h == IntPtr.Zero) return _fadeHadCursor;
            if (!GetWindowRect(h, out var r)) return _fadeHadCursor;
            return p.X >= r.Left && p.X < r.Right && p.Y >= r.Top && p.Y < r.Bottom;
        }
    }
}
