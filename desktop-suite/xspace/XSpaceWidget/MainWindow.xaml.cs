using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using XSpaceWidget.Controls;
using XSpaceWidget.Models;
using XSpaceWidget.Services;
// WinForms 的隐式 using 会引入同名类型，这里显式指定 WPF 的
using Point = System.Windows.Point;
using MouseEventArgs = System.Windows.Input.MouseEventArgs;
using Button = System.Windows.Controls.Button;
using Brush = System.Windows.Media.Brush;

namespace XSpaceWidget;

public partial class MainWindow : Window
{
    // ---- 布局常量 ----
    private const double HeaderH = 40;       // 标题栏
    private const double FooterH = 24;       // 状态栏
    private const double OuterPad = 10;      // 阴影外边距 5*2
    private const double MinW = 420;         // 最小宽（两列）
    private const double MinH = 180;         // 最小高
    private const double ResizeEdge = 7;     // 可缩放的边缘宽度(DIP)
    private const double DragThreshold = 14; // 拖动判定阈值(DIP)，小于此视为点击
    private const double DragStep = 18;      // 拖动滚动一格所需位移(DIP)
    private const double HeaderZone = 48;    // 标题栏高度：触屏在此滑动交给窗口拖动

    private readonly SettingsService _settings;
    private readonly FetcherService _fetcher;
    private readonly SteamSession _steam;

    private bool _busy;
    private bool _steamView;                 // 当前是否 Steam 价格视图（翻转后的另一面）
    private bool _flipping;                  // 翻转动画进行中
    private DispatcherTimer? _refreshTimer;

    // ---- 鼠标交互 ----
    private Point _downPos;
    private bool _downing;
    private bool _dragScroll;
    private double _lastDragY;
    private double _touchAccum;              // 触屏累计位移（正数 = 已累计要“看更早”的距离）
    private double _touchTravel;             // 本次触屏手势总行程，用于区分滑动与点按
    private Point _touchOrigin;              // 手指落点（点按打开时用它找条目）
    private bool _manipulating;              // 触屏手势进行中（避免与鼠标提升事件重复滚动）
    private double _touchDx, _touchDy;       // 手势累计的横 / 纵位移
    private bool _touchHorizontal;           // 本次手势判定为左右滑（用于翻转视图）
    private NoticeItem? _clickCandidate;
    private NoticeColumn? _dragColumn;       // 按下 / 触摸时锁定的列
    private bool _downOnButton;              // 按下点是否落在按钮上（按钮自己处理交互）
    private NoticeColumn? _activeColumn;     // 键盘方向键当前作用列（点过 / 滚过的那列）
    private HwndSource? _hwndSource;

    // ---- 触摸板 / 滚轮：增量累计 ----
    private int _wheelAccum;                 // 竖直累计（每满 120 = 一格；高精度触摸板增量很小，必须累计）
    private NoticeColumn? _wheelColumn;      // 累计值属于哪一列（换列则清零）
    private int _wheelHAccum;                // 横向两指滑动累计（左右滑 = 翻转）
    private DateTime _wheelHAt;              // 上一次横向事件时间（手势间隔超时则清零）

    // ---- 自定义窗口缩放 ----
    private bool _resizing;
    private Point _resizeStart;
    private double _resizeStartW;
    private double _resizeStartH;

    // 右栏数据源标识，避免无谓重建（重建会清空列表）
    private string _rightKey = "";

    public MainWindow(SettingsService settings, FetcherService fetcher)
    {
        InitializeComponent();
        _settings = settings;
        _fetcher = fetcher;
        _steam = new SteamSession(() => _settings.Config);
        _steam.Progress += msg => Dispatcher.BeginInvoke(new Action(() => SetStatus(StatusKind.Loading, msg)));
        MinWidth = MinW;
        MinHeight = MinH;

        LeftColumn.Accent = (Brush)FindResource("AccentBrush");
        RightColumn.Accent = (Brush)FindResource("AccentAltBrush");
        LeftColumn.StatusChanged += OnColumnStatusChanged;
        RightColumn.StatusChanged += OnColumnStatusChanged;

        LeftColumn.SetSource(new XSpaceSource(_fetcher));
        EnsureRightSource();
        ApplyConfig();
        _activeColumn = LeftColumn;           // 默认作用列：左栏（首次手动点选前）
        LeftColumn.SetActive(true);           // 亮出列头下的指示线，告诉用户方向键控制哪一列

        Loaded += async (_, _) =>
        {
            await RefreshAllAsync();
            StartTimer();
            InitMouseFade();          // 鼠标跟随透明度（设置里可开关）
        };
    }

    private void OnColumnStatusChanged(NoticeColumn column, StatusKind kind, string text)
        => SetStatus(kind, text);

    /// <summary>Steam 视图下顺带显示走的通路（直连 / 代理）。</summary>
    private string TransportNote()
        => !_steamView ? ""
           : _steam.Transport == "direct" || _steam.Transport == "cached" ? " · 直连"
           : $" · 代理 {_steam.Transport.Replace("socks5 ", "")}";

    // ================= 翻转：XSpace 竞赛通知 ←→ Steam 价格视图 =================

    private void BtnFlip_Click(object sender, RoutedEventArgs e)
    {
        e.Handled = true;
        _ = FlipToAsync(!_steamView);
    }

    /// <summary>翻转视图：先转到侧面 → 换内容 → 转回，并立即开始刷新。</summary>
    private async Task FlipToAsync(bool steam)
    {
        if (_flipping || _steamView == steam) return;
        _flipping = true;
        try
        {
            await AnimateFlipHalfAsync(1, 0.03, 110);
            _steamView = steam;
            ApplyView();
            _ = RefreshAllAsync();                       // 每次翻转都自动刷新
            await AnimateFlipHalfAsync(0.03, 1, 150);
            SpinFlipButton();
        }
        finally { _flipping = false; }
    }

    private async Task AnimateFlipHalfAsync(double from, double to, int ms)
    {
        var anim = new DoubleAnimation(from, to, TimeSpan.FromMilliseconds(ms))
        {
            EasingFunction = new CubicEase { EasingMode = to < from ? EasingMode.EaseIn : EasingMode.EaseOut },
            FillBehavior = FillBehavior.Stop,
        };
        FlipScale.ScaleX = to;                            // 基值 = 终值，动画结束后自然停住
        FlipScale.BeginAnimation(ScaleTransform.ScaleXProperty, anim);
        // 用定时而不是 Completed 回调：动画被新动画替换时 Completed 可能不触发，会把 _flipping 卡住
        await Task.Delay(ms + 30);
    }

    private void SpinFlipButton()
    {
        double from = FlipRotate.Angle, to = from + 180;
        FlipRotate.Angle = to;                            // 基值 = 终值，动画结束后自然停住
        FlipRotate.BeginAnimation(RotateTransform.AngleProperty,
            new DoubleAnimation(from, to, TimeSpan.FromMilliseconds(260))
            { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }, FillBehavior = FillBehavior.Stop });
    }

    /// <summary>按当前视图装配两栏数据源 / 标题 / 强调色。</summary>
    private void ApplyView()
    {
        if (_steamView)
        {
            HeaderTitle.Text = "Steam 价格速览";
            HeaderSubtitle.Text = "愿望单 · 购物车";
            LeftColumn.Accent = (Brush)FindResource("SteamWishBrush");
            RightColumn.Accent = (Brush)FindResource("SteamCartBrush");
            LeftColumn.SetSource(new SteamWishlistSource(_steam));
            RightColumn.SetSource(new SteamCartSource(_steam));
            BtnFlip.Content = "\uE72B";                   // Back：翻回去
            BtnFlip.ToolTip = "翻回 XSpace 竞赛通知";
        }
        else
        {
            HeaderTitle.Text = "竞赛通知";
            HeaderSubtitle.Text = "X·Space创客空间联盟";
            LeftColumn.Accent = (Brush)FindResource("AccentBrush");
            RightColumn.Accent = (Brush)FindResource("AccentAltBrush");
            LeftColumn.SetSource(new XSpaceSource(_fetcher));
            _rightKey = "";                               // 强制重新装配右栏（赛氪 / 自定义网页）
            EnsureRightSource();
            BtnFlip.Content = "\uE7FC";                   // Game：翻到 Steam
            BtnFlip.ToolTip = "翻到 Steam 价格视图（愿望单 / 购物车）";
        }
    }

    // ================= 数据源 =================

    /// <summary>右栏数据源：默认赛氪竞赛广场；选“一般模式”后改为用户填写的网址。</summary>
    private INoticeSource BuildRightSource()
    {
        var c = _settings.Config;
        if (c.Mode == "generic" && !string.IsNullOrWhiteSpace(c.GenericUrl))
            return new GenericSource(_fetcher, c.GenericUrl,
                string.IsNullOrWhiteSpace(c.GenericTitle) ? "自定义信息栏" : c.GenericTitle.Trim());
        return new GenericSource(_fetcher, AppConfig.DefaultRightUrl, AppConfig.DefaultRightTitle);
    }

    /// <summary>右栏数据源发生变化时重新装配。</summary>
    private void EnsureRightSource()
    {
        var src = BuildRightSource();
        if (src.Key == _rightKey) return;
        _rightKey = src.Key;
        RightColumn.SetSource(src);
    }

    // ================= 生命周期 =================

    private async Task RefreshAllAsync()
    {
        if (_busy) return;
        _busy = true;
        try
        {
            if (!_fetcher.IsReady)
            {
                SetStatus(StatusKind.Loading, "正在初始化浏览器内核…");
                await _fetcher.InitializeAsync();
            }

            if (!_fetcher.IsReady)
            {
                string msg = "浏览器内核初始化失败\n" + (_fetcher.InitError ?? "未知错误");
                LeftColumn.ShowEmpty(msg, StatusKind.Error);
                RightColumn.ShowEmpty(msg, StatusKind.Error);
                SetStatus(StatusKind.Error, "浏览器内核初始化失败");
                return;
            }

            SetStatus(StatusKind.Loading, "正在获取最新内容…");
            var left = LeftColumn.RefreshNewestAsync();
            var right = RightColumn.RefreshNewestAsync();
            bool okLeft = await left;
            bool okRight = await right;

            SetStatus(okLeft && okRight ? StatusKind.Ok : StatusKind.Warn,
                okLeft && okRight ? $"已更新 {DateTime.Now:HH:mm:ss}{TransportNote()}" : "部分内容获取失败，可点击刷新重试");
        }
        finally { _busy = false; }
    }

    private async Task AutoRefreshAllAsync()
    {
        if (_busy || !_fetcher.IsReady) return;
        _busy = true;
        try
        {
            await LeftColumn.AutoRefreshAsync();
            await RightColumn.AutoRefreshAsync();
            SetStatus(StatusKind.Ok, $"自动更新 {DateTime.Now:HH:mm:ss}");
        }
        finally { _busy = false; }
    }

    // ================= 鼠标交互 =================

    // ---- 键盘：方向键滚动“当前列” ----

    /// <summary>
    /// 指定方向键当前作用于哪一列（点过 / 滑过 / 滚过的那一列）。
    /// 注意：这里绝不能调 Activate()/Focus()——那会抢走按钮的鼠标捕获，使列头按钮点不动；
    /// 窗口由点击自然激活，键盘事件本来就会送到本窗口。
    /// </summary>
    private void SetActiveColumn(NoticeColumn col)
    {
        if (ReferenceEquals(_activeColumn, col)) return;
        _activeColumn = col;
        LeftColumn.SetActive(ReferenceEquals(col, LeftColumn));
        RightColumn.SetActive(ReferenceEquals(col, RightColumn));
    }

    /// <summary>方向键 / PageUp / PageDown / Home / End 滚动当前列（↓ 看更早，↑ 看更新）。</summary>
    protected override void OnPreviewKeyDown(System.Windows.Input.KeyEventArgs e)
    {
        base.OnPreviewKeyDown(e);
        var col = _activeColumn;
        if (col == null) return;
        switch (e.Key)
        {
            case Key.Down:     col.ScrollBy(1);              e.Handled = true; break;
            case Key.Up:       col.ScrollBy(-1);             e.Handled = true; break;
            case Key.PageDown: col.ScrollBy(col.BarCount);   e.Handled = true; break;
            case Key.PageUp:   col.ScrollBy(-col.BarCount);  e.Handled = true; break;
            case Key.Home:     col.ScrollBy(-9999);          e.Handled = true; break;   // 回到最新
            case Key.End:      col.ScrollBy(9999);           e.Handled = true; break;   // 跳到最旧
        }
    }

    // Win32 WM_MOUSEWHEEL：不依赖键盘焦点，保证滚轮在任何情况下都能滚动
    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        try
        {
            var helper = new WindowInteropHelper(this);
            _hwndSource = HwndSource.FromHwnd(helper.Handle);
            _hwndSource?.AddHook(WndProc);
        }
        catch { }
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == 0x020A) // WM_MOUSEWHEEL（鼠标滚轮 / 触摸板两指上下滑）
        {
            int delta = (short)((long)wParam >> 16);
            if (delta != 0)
            {
                // 向下滚（delta<0，内容上移）= 看更早（更旧）；向上滚 = 回到更新。
                // 触屏板两指上下滑也走这里，与鼠标滚轮一致。
                _wheelHAccum = 0;                      // 竖向滚动优先：清掉横向累计，避免斜向滑动误触发翻转
                long lp = lParam.ToInt64();
                double screenX = (short)(lp & 0xFFFF);
                var col = ColumnAtScreenX(screenX);
                SetActiveColumn(col);                  // 滚轮滚过的那列就是方向键的作用列
                ScrollByWheelDelta(col, delta);
                handled = true;
                return IntPtr.Zero;
            }
        }
        else if (msg == 0x020E) // WM_MOUSEHWHEEL（触摸板两指左右滑 / 鼠标倾斜滚轮）
        {
            int delta = (short)((long)wParam >> 16);
            if (delta != 0)
            {
                // 两指左滑（delta>0）= 翻到 Steam 面；右滑 = 翻回竞赛通知。
                // Windows 触摸板会先锁定主轴，只有纯横向滑动才会走到这里。
                var now = DateTime.UtcNow;
                if ((now - _wheelHAt).TotalMilliseconds > 700) _wheelHAccum = 0;
                _wheelHAt = now;
                _wheelHAccum += delta;
                if (Math.Abs(_wheelHAccum) >= 240)     // 连续两个刻度才翻转，防误触
                {
                    bool toSteam = _wheelHAccum > 0;
                    _wheelHAccum = 0;
                    _ = FlipToAsync(toSteam);
                }
                handled = true;
                return IntPtr.Zero;
            }
        }
        return IntPtr.Zero;
    }

    /// <summary>
    /// 滚轮 / 触摸板按 120 的整数倍累计再滚动。
    /// 高精度触摸板（Precision Touchpad）送来的是 ±8、±24 这类小增量，
    /// 若“一个事件滚一行”会又快又碎，这里累计成整格后手感与物理滚轮一致。
    /// </summary>
    private void ScrollByWheelDelta(NoticeColumn col, int delta)
    {
        if (!ReferenceEquals(_wheelColumn, col)) { _wheelColumn = col; _wheelAccum = 0; }
        _wheelAccum += delta;
        int steps = _wheelAccum / 120;                 // 向零取整
        if (steps == 0) return;
        _wheelAccum -= steps * 120;
        col.ScrollBy(-steps);                          // 正 steps（向上滚）= 更新
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    /// <summary>窗口内坐标（DIP）定位到列。</summary>
    private NoticeColumn ColumnAt(Point windowPoint)
    {
        double split = LeftColumn.TranslatePoint(new Point(LeftColumn.ActualWidth, 0), this).X;
        return windowPoint.X <= split ? LeftColumn : RightColumn;
    }

    /// <summary>
    /// 屏幕物理坐标（如 WM_MOUSEWHEEL 的 lParam）定位到列。
    /// 用 Win32 窗口矩形 + 实际 DPI 换算，避免 PointFromScreen 在不同 .NET 版本下的单位差异。
    /// </summary>
    private NoticeColumn ColumnAtScreenX(double physicalScreenX)
    {
        try
        {
            var helper = new WindowInteropHelper(this);
            if (helper.Handle != IntPtr.Zero && GetWindowRect(helper.Handle, out RECT r))
            {
                double scale = VisualTreeHelper.GetDpi(this).DpiScaleX;
                if (scale <= 0) scale = 1;
                double x = (physicalScreenX - r.Left) / scale;   // 窗口内 DIP
                return x <= LeftColumn.ActualWidth + 0.5 ? LeftColumn : RightColumn;
            }
        }
        catch { }
        return LeftColumn;
    }

    private void OnMouseWheel(object sender, MouseWheelEventArgs e)
    {
        // 与 WM_MOUSEWHEEL 保持一致（正常情况下消息已被 WndProc 拦下，这里是兼底）
        var col = ColumnAt(e.GetPosition(this));
        SetActiveColumn(col);
        ScrollByWheelDelta(col, e.Delta);
        e.Handled = true;
    }

    // ---- 触屏滑动（手指在信息栏上垂直滑动）----
    //
    // 触屏按手机的逻辑做「直接操纵」：手指向上滑 = 内容跟着往上走 = 看到更早（更旧）的条目；
    // 手指向下滑 = 回到更新的条目。一行高度 = 手指移动一行的高度，1:1 跟手。
    // 鼠标滚轮方向相反（桌面习惯：向下滚 = 更旧），两者都是“内容往上走 = 更旧”。

    private void OnManipulationStarting(object sender, ManipulationStartingEventArgs e)
    {
        e.ManipulationContainer = this;
        e.Mode = ManipulationModes.TranslateX | ManipulationModes.TranslateY;   // 需要横向分量来判断左右滑

        var origin = e.Manipulators.FirstOrDefault()?.GetPosition(this)
                     ?? new Point(ActualWidth / 2, 0);

        // 标题栏 / 状态栏区域不滚动（留给拖动窗口与状态显示）
        if (origin.Y < HeaderZone) { e.Cancel(); return; }
        // 手指落在按钮上：交给按钮自己处理（点按触发 Click，不要滚列表）。
        // Cancel() 会把触摸重新提升为鼠标事件，所以按钮点按照常有效。
        if (InputHitTest(origin) is DependencyObject hit && FindVisualParent<Button>(hit) != null)
        { e.Cancel(); return; }

        _dragColumn = ColumnAt(origin);      // 锁定手指起始所在的列
        SetActiveColumn(_dragColumn);        // 手指划过的列 = 方向键作用列
        _touchOrigin = origin;
        _touchAccum = 0;
        _touchTravel = 0;
        _touchDx = _touchDy = 0;
        _touchHorizontal = false;
        _manipulating = true;
        e.Handled = true;
    }

    private void OnManipulationDelta(object sender, ManipulationDeltaEventArgs e)
    {
        var t = e.DeltaManipulation.Translation;
        _touchTravel += Math.Abs(t.X) + Math.Abs(t.Y);
        if (_touchTravel > DragThreshold) _clickCandidate = null;   // 滑动了就不再算点按

        _touchDx += t.X;
        _touchDy += t.Y;
        // 明显左右滑（横向占主导）→ 本次手势不滚动，松手后翻转视图（与触摸板两指左右滑一致）
        if (!_touchHorizontal && Math.Abs(_touchDx) > 26 && Math.Abs(_touchDx) > Math.Abs(_touchDy) * 1.6)
            _touchHorizontal = true;
        if (_touchHorizontal)
        {
            e.Handled = true;
            return;
        }

        // 手指上滑（dy<0）→ 累计为正 → 看更早
        _touchAccum -= t.Y;
        var col = _dragColumn ?? LeftColumn;
        while (_touchAccum >= NoticeColumn.BarSlot) { col.ScrollBy(1); _touchAccum -= NoticeColumn.BarSlot; }
        while (_touchAccum <= -NoticeColumn.BarSlot) { col.ScrollBy(-1); _touchAccum += NoticeColumn.BarSlot; }
        e.Handled = true;
    }

    private void OnManipulationInertiaStarting(object sender, ManipulationInertiaStartingEventArgs e)
    {
        e.Handled = true;   // 关闭惯性，避免误触
    }

    private void OnManipulationCompleted(object sender, ManipulationCompletedEventArgs e)
    {
        if (_manipulating)
        {
            bool horizontal = _touchHorizontal && Math.Abs(_touchDx) >= 70;   // 左右滑够远才算翻转
            bool tap = !horizontal && _touchTravel <= DragThreshold;          // 几乎没移动 = 点按
            _manipulating = false;
            _touchAccum = 0;
            _touchTravel = 0;
            _touchHorizontal = false;
            _dragColumn = null;
            if (horizontal) _ = FlipToAsync(_touchDx < 0);                    // 手指左滑 = 翻到 Steam（与触摸板一致）
            else if (tap && FindNoticeAt(_touchOrigin) is { } item) OpenNotice(item);
        }
        e.Handled = true;
    }

    // 判断鼠标是否位于可缩放边缘（右下角优先）
    private bool IsInResizeEdge(Point p)
    {
        bool right = p.X >= ActualWidth - ResizeEdge;
        bool bottom = p.Y >= ActualHeight - ResizeEdge;
        return right || bottom;
    }

    private void OnMouseDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ChangedButton != MouseButton.Left) return;
        var pos = e.GetPosition(this);

        // 边缘 → 进入窗口缩放
        if (IsInResizeEdge(pos))
        {
            _resizing = true;
            _resizeStart = pos;
            _resizeStartW = ActualWidth;
            _resizeStartH = ActualHeight;
            CaptureMouse();
            e.Handled = true;
            return;
        }

        _downPos = pos;
        _downing = true;
        _dragScroll = false;
        _dragColumn = ColumnAt(pos);            // 锁定按下位置所在的列
        SetActiveColumn(_dragColumn);           // 点选的那列：方向键随后控制它
        // 点在按钮上时窗口不接管鼠标（否则轻微移动会被当成拖拽，抢走捕获导致 Click 消失）
        _downOnButton = e.OriginalSource is DependencyObject src && FindVisualParent<Button>(src) != null;
        _clickCandidate = _downOnButton ? null : FindNoticeAt(pos);
        // 注意：这里不能立即 CaptureMouse()，否则会抢走鼠标事件，
        // 导致按钮收不到 MouseUp、Click 不触发，标题栏 DragMove 也无法工作。
        // 只在真正开始拖动滚动时（OnMouseMove 中）才捕获。
    }

    private void OnMouseMove(object sender, MouseEventArgs e)
    {
        var pos = e.GetPosition(this);

        // 窗口缩放
        if (_resizing)
        {
            double w = Math.Max(MinW, _resizeStartW + (pos.X - _resizeStart.X));
            double h = Math.Max(MinH, _resizeStartH + (pos.Y - _resizeStart.Y));
            if (Math.Abs(w - Width) > 0.1) Width = w;
            if (Math.Abs(h - Height) > 0.1) Height = h;
            e.Handled = true;
            return;
        }

        // 未按下时更新边缘光标
        if (!_downing)
        {
            Cursor = IsInResizeEdge(pos)
                ? System.Windows.Input.Cursors.SizeNWSE
                : System.Windows.Input.Cursors.Arrow;
            return;
        }

        // 触屏手势进行中：滚动交给 Manipulation 处理，避免与“触摸提升出来的鼠标事件”重复滚动
        if (_manipulating) return;

        // 拖动滚动
        if (!_dragScroll)
        {
            if (_downOnButton) return;          // 按钮上的按下-移动不归窗口管
            if (Math.Abs(pos.Y - _downPos.Y) > DragThreshold || Math.Abs(pos.X - _downPos.X) > DragThreshold)
            {
                _dragScroll = true;
                _lastDragY = pos.Y;
                _clickCandidate = null; // 开始拖动则不再当作点击
                CaptureMouse();          // 拖动滚动时捕获，防止移出窗口丢失跟踪
            }
            return;
        }

        double d = pos.Y - _lastDragY;
        // 注意：不足一格的位移不能把 _lastDragY 归零，否则平滑拖动（每次移动都很小）会永远攒不满一格
        // → 表现就是“拖了但列表不动”。这里只在真正走了一格后才更新基准点，残量留到下次累加。
        if (Math.Abs(d) >= DragStep)
        {
            int steps = (int)(d / DragStep);
            // 直接操纵（与触屏一致）：向上拖动 = 内容跟着上移 = 查看更早
            (_dragColumn ?? LeftColumn).ScrollBy(-steps);
            _lastDragY = pos.Y - (d - steps * DragStep);
        }
    }

    private void OnMouseUp(object sender, MouseButtonEventArgs e)
    {
        if (_resizing)
        {
            _resizing = false;
            ReleaseMouseCapture();
            _settings.Config.Width = ActualWidth;
            _settings.Save();
            e.Handled = true;
            return;
        }
        if (!_downing) return;
        _downing = false;
        bool wasDrag = _dragScroll;
        _dragScroll = false;
        _downOnButton = false;
        if (wasDrag) ReleaseMouseCapture();

        if (!wasDrag && _clickCandidate != null)
            OpenNotice(_clickCandidate);
        _clickCandidate = null;
        _dragColumn = null;
    }

    private NoticeItem? FindNoticeAt(Point p)
    {
        var hit = InputHitTest(p) as DependencyObject;
        while (hit != null && hit is not FrameworkElement { DataContext: NoticeItem })
            hit = VisualTreeHelper.GetParent(hit);
        return (hit as FrameworkElement)?.DataContext as NoticeItem;
    }

    /// <summary>上次打开的链接，用于防重复（触屏点按可能同时走动画路径与鼠标提升事件）。</summary>
    private string _lastOpenUrl = "";
    private DateTime _lastOpenAt;

    private void OpenNotice(NoticeItem item)
    {
        if (string.IsNullOrEmpty(item.Url)) return;
        // 0.7s 内同一链接只打开一次（触屏点按会同时触发 ManipulationCompleted 与提升出来的 MouseUp）
        if (item.Url == _lastOpenUrl && (DateTime.Now - _lastOpenAt).TotalMilliseconds < 700) return;
        _lastOpenUrl = item.Url;
        _lastOpenAt = DateTime.Now;
        try
        {
            Process.Start(new ProcessStartInfo(item.Url) { UseShellExecute = true });
        }
        catch
        {
            SetStatus(StatusKind.Error, "无法打开链接");
        }
    }

    private void Header_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.OriginalSource is DependencyObject src && FindVisualParent<Button>(src) != null)
            return; // 点在按钮上不拖窗
        try { DragMove(); SavePosition(); } catch { }
    }

    private static T? FindVisualParent<T>(DependencyObject? child) where T : DependencyObject
    {
        while (child != null)
        {
            if (child is T t) return t;
            child = VisualTreeHelper.GetParent(child);
        }
        return null;
    }

    private void SavePosition()
    {
        if (!_settings.Config.RememberPos) return;
        if (double.IsNaN(Left) || double.IsNaN(Top)) return;
        _settings.Config.Left = Left;
        _settings.Config.Top = double.IsNaN(_restTop) ? Top : _restTop;   // 存"静止位置"，别把悬浮位移存进去
        _settings.Save();
    }

    // ================= 布局 / 配置 =================

    private void ApplyConfig()
    {
        var c = _settings.Config;
        Width = Math.Max(MinW, c.Width);
        Height = OuterPad + HeaderH + 1 + NoticeColumn.HeaderHeight + c.BarCount * NoticeColumn.BarSlot + FooterH;
        Topmost = c.TopMost;

        LeftColumn.BarCount = c.BarCount;
        RightColumn.BarCount = c.BarCount;

        // 位置（保证整窗都在工作区内，窗口比工作区还大时对齐左上角）
        var wa = SystemParameters.WorkArea;
        if (c.RememberPos && !double.IsNaN(c.Left) && !double.IsNaN(c.Top))
        {
            Left = Math.Clamp(c.Left, wa.Left, Math.Max(wa.Left, wa.Right - Width));
            Top = Math.Clamp(c.Top, wa.Top, Math.Max(wa.Top, wa.Bottom - Height));
        }
        else
        {
            Left = wa.Right - Width - 24;
            Top = wa.Top + 90;
        }
    }

    private void StartTimer()
    {
        _refreshTimer?.Stop();
        _refreshTimer = null;
        if (!_settings.Config.AutoRefresh) return;
        _refreshTimer = new DispatcherTimer
        {
            Interval = TimeSpan.FromMinutes(_settings.Config.RefreshMinutes)
        };
        _refreshTimer.Tick += async (_, _) => await AutoRefreshAllAsync();
        _refreshTimer.Start();
    }

    /// <summary>设置窗口改动后调用。reload=true 时按当前模式重新装配右栏并抓取。</summary>
    public void ApplySettings(bool reload = false)
    {
        ApplyConfig();
        StartTimer();
        if (!reload) return;
        if (_steamView) { _ = RefreshAllAsync(); return; }   // Steam 视图不受右栏内容设置影响

        EnsureRightSource();
        if (_fetcher.IsReady) _ = RightColumn.RefreshNewestAsync();
        else _ = RefreshAllAsync();
    }
    // ================= 状态显示 =================

    private void SetStatus(StatusKind kind, string text)
    {
        StatusDot.Fill = kind switch
        {
            StatusKind.Ok => (Brush)FindResource("OkBrush"),
            StatusKind.Error => (Brush)FindResource("DangerBrush"),
            StatusKind.Warn => (Brush)FindResource("WarnBrush"),
            _ => (Brush)FindResource("AccentBrush"),
        };
        StatusText.Text = text;
    }

    private static string ShortError(Exception ex)
    {
        var s = ex.Message;
        return s.Length > 90 ? s[..90] : s;
    }

    // ================= 对外方法（托盘 / 设置调用） =================

    /// <summary>允许真正关闭（退出时由 App 设置）。</summary>
    public bool AllowClose { get; set; }

    public Task RefreshNowAsync()
    {
        EnsureRightSource();     // 网址/模式可能刚改过
        return RefreshAllAsync();
    }

    public void RefreshNow() => _ = RefreshNowAsync();

    private SettingsWindow? _settingsWin;

    public void OpenSettings()
    {
        // 已打开则激活，避免重复创建
        if (_settingsWin != null && _settingsWin.IsVisible)
        {
            _settingsWin.Activate();
            return;
        }
        _settingsWin = new SettingsWindow(_settings, this)
        {
            Owner = this,
            WindowStartupLocation = WindowStartupLocation.Manual
        };
        // 显示在主窗口旁边（非模态，不阻塞主窗口操作）
        var wa = SystemParameters.WorkArea;
        _settingsWin.Left = Left - _settingsWin.Width - 12;
        _settingsWin.Top = Top;
        if (_settingsWin.Left < wa.Left) _settingsWin.Left = Left + Width + 12;
        // 保证设置窗口完整可见（主窗口靠下时容易被挤出屏幕）
        _settingsWin.Left = Math.Clamp(_settingsWin.Left, wa.Left, Math.Max(wa.Left, wa.Right - _settingsWin.Width));
        _settingsWin.Top = Math.Clamp(_settingsWin.Top, wa.Top, Math.Max(wa.Top, wa.Bottom - _settingsWin.Height));
        _settingsWin.Show();
        _settingsWin.Closed += (_, _) => _settingsWin = null;
    }

    public void ToggleAutoStart()
    {
        _settings.Config.AutoStart = !_settings.Config.AutoStart;
        AutoStartService.SetEnabled(_settings.Config.AutoStart);
        _settings.Save();
    }

    public void ToggleVisible()
    {
        if (IsVisible) Hide(); else Show();
    }

    // ================= 按钮事件 =================

    private async void BtnRefresh_Click(object sender, RoutedEventArgs e)
    {
        e.Handled = true;
        await RefreshNowAsync();
    }

    private void BtnSettings_Click(object sender, RoutedEventArgs e)
    {
        e.Handled = true;
        OpenSettings();
    }

    private void BtnHide_Click(object sender, RoutedEventArgs e)
    {
        e.Handled = true;
        Hide();
    }

    private void CtxRefresh_Click(object sender, RoutedEventArgs e) => RefreshNow();
    private void CtxSettings_Click(object sender, RoutedEventArgs e) => OpenSettings();
    private void CtxHide_Click(object sender, RoutedEventArgs e) => Hide();
    private void CtxExit_Click(object sender, RoutedEventArgs e) => App.RequestExit();

    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        if (!AllowClose)
        {
            // 关闭按钮/Alt+F4 时隐藏到托盘，而不是退出
            e.Cancel = true;
            Hide();
            base.OnClosing(e);
        }
    }
}