using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using XNoteWidget.Models;
using XNoteWidget.Services;
using Point = System.Windows.Point;
using MouseEventArgs = System.Windows.Input.MouseEventArgs;
using Button = System.Windows.Controls.Button;
using Brush = System.Windows.Media.Brush;
using Brushes = System.Windows.Media.Brushes;
using TextBox = System.Windows.Controls.TextBox;
using KeyEventArgs = System.Windows.Input.KeyEventArgs;
using HorizontalAlignment = System.Windows.HorizontalAlignment;
using VerticalAlignment = System.Windows.VerticalAlignment;

namespace XNoteWidget;

public partial class MainWindow : Window
{
    // ---- 布局常量 ----
    private const double BarSlot = 60;       // 每条栏高度 + 上下间距
    private const double HeaderH = 52;
    private const double FooterH = 36;
    private const double OuterPad = 18;      // 阴影外边距 9*2
    private const double MinW = 260;         // 最小宽
    private const double MinH = 200;         // 最小高
    private const double ResizeEdge = 7;     // 可缩放的边缘宽度(DIP)
    private const double DragThreshold = 14; // 拖动判定阈值(DIP)，小于此视为点击
    private const double DoubleEnterMs = 500; // 回车×2 判定窗口(ms)
    private const double DeleteSwipeThreshold = 60; // 左划删除阈值(DIP)

    private readonly SettingsService _settings;

    private readonly List<NoteData> _notes = new();  // 便签列表（新→旧，即从上到下）
    private int _offset;                              // 视口起始索引

    // ---- 信息栏容器（固定最多 12 条，便于逐条控制动画）----
    private readonly NoteBar[] _bars = new NoteBar[12];

    // ---- 编辑状态 ----
    private NoteBar? _editingBar;      // 正在编辑的信息栏
    private int _editingIndex = -1;    // 正在编辑的便签索引
    private DateTime _lastEnterTime = DateTime.MinValue; // 上一次回车时间（回车×2 判定）
    private DispatcherTimer? _enterTimer;

    // ---- 鼠标交互 ----
    private Point _downPos;
    private bool _downing;
    private bool _dragScroll;
    private double _lastDragY;
    private NoteBar? _downBar;
    private HwndSource? _hwndSource;

    // ---- 自定义窗口缩放 ----
    private bool _resizing;
    private Point _resizeStart;
    private double _resizeStartW;
    private double _resizeStartH;

    // ---- 触屏 ----
    private double _touchAccum;
    private NoteBar? _touchStartBar;
    private bool _touchDeleted;

    /// <summary>一个信息栏的元素集合。</summary>
    private sealed class NoteBar
    {
        public Border Border = null!;
        public TextBlock Display = null!;
        public TextBox Edit = null!;
        public Button Delete = null!;
    }

    public MainWindow(SettingsService settings)
    {
        InitializeComponent();
        _settings = settings;
        BuildBars();
        MinWidth = MinW;
        MinHeight = MinH;
        LoadNotes();
        ApplyConfig();
        Deactivated += (_, _) => ExitEdit();   // 窗口失焦时提交并退出编辑
    }

    // ================= 数据 =================

    /// <summary>从配置加载便签，不足栏数时补空白栏。</summary>
    private void LoadNotes()
    {
        _notes.Clear();
        foreach (var t in _settings.Config.Notes)
            _notes.Add(new NoteData { Text = t });
        EnsureMinNotes();
    }

    /// <summary>保证至少 BarCount 条便签（不足补空白信息栏）。</summary>
    private void EnsureMinNotes()
    {
        int need = _settings.Config.BarCount;
        while (_notes.Count < need) _notes.Add(new NoteData());
    }

    private void SaveNotes()
    {
        _settings.Config.Notes = _notes.Select(n => n.Text).ToList();
        _settings.Save();
    }

    // ================= 信息栏构建 =================

    private void BuildBars()
    {
        for (int i = 0; i < 12; i++)
        {
            var bar = CreateBar();
            bar.Border.Visibility = Visibility.Collapsed;
            _bars[i] = bar;
            BarsHost.Children.Add(bar.Border);
        }
    }

    private NoteBar CreateBar()
    {
        var bar = new NoteBar();

        bar.Border = new Border
        {
            Height = 54,
            CornerRadius = new CornerRadius(11),
            Margin = new Thickness(0, 3, 0, 3),
            Cursor = System.Windows.Input.Cursors.IBeam,
            Background = (Brush)FindResource("BarBrush")
        };

        var grid = new Grid { Margin = new Thickness(12, 0, 6, 0) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        // 显示层（不参与命中测试，点击落在 Border 上）
        bar.Display = new TextBlock
        {
            FontSize = 12.5,
            Foreground = (Brush)FindResource("TextPrimaryBrush"),
            TextTrimming = TextTrimming.CharacterEllipsis,
            TextAlignment = TextAlignment.Left,          // 向左靠齐
            VerticalAlignment = VerticalAlignment.Center,
            IsHitTestVisible = false
        };

        // 编辑层（无边框、透明背景、左对齐）
        bar.Edit = new TextBox
        {
            FontSize = 12.5,
            Foreground = (Brush)FindResource("TextPrimaryBrush"),
            CaretBrush = (Brush)FindResource("AccentBrush"),
            Background = Brushes.Transparent,
            BorderThickness = new Thickness(0),
            Padding = new Thickness(0),
            TextAlignment = TextAlignment.Left,          // 向左靠齐
            VerticalContentAlignment = VerticalAlignment.Center,
            Visibility = Visibility.Collapsed
        };
        bar.Edit.PreviewKeyDown += OnEditKeyDown;
        bar.Edit.LostKeyboardFocus += OnEditLostFocus;

        var content = new Grid();
        content.Children.Add(bar.Display);
        content.Children.Add(bar.Edit);
        Grid.SetColumn(content, 0);

        // 删除按钮（悬停显示）
        bar.Delete = new Button
        {
            Content = "\uE74D",
            Style = (Style)FindResource("IconButton"),
            Width = 24,
            Height = 24,
            ToolTip = "删除此便签",
            Visibility = Visibility.Collapsed,
            Margin = new Thickness(6, 0, 0, 0)
        };
        bar.Delete.Click += (_, _) =>
        {
            int idx = IndexOfBar(bar);
            if (idx >= 0) DeleteNoteAt(idx);
        };
        Grid.SetColumn(bar.Delete, 1);

        grid.Children.Add(content);
        grid.Children.Add(bar.Delete);
        bar.Border.Child = grid;

        bar.Border.MouseEnter += (_, _) =>
        {
            bar.Border.Background = (Brush)FindResource("BarHoverBrush");
            if (_editingBar != bar) bar.Delete.Visibility = Visibility.Visible;
        };
        bar.Border.MouseLeave += (_, _) =>
        {
            bar.Border.Background = (Brush)FindResource("BarBrush");
            if (_editingBar != bar) bar.Delete.Visibility = Visibility.Collapsed;
        };

        return bar;
    }

    /// <summary>当前 _offset 下某信息栏对应的便签索引（-1 表示未显示）。</summary>
    private int IndexOfBar(NoteBar bar)
    {
        int slot = Array.IndexOf(_bars, bar);
        if (slot < 0) return -1;
        int idx = _offset + slot;
        return idx >= 0 && idx < _notes.Count ? idx : -1;
    }

    // ================= 更新渲染 =================

    private void UpdateBars()
    {
        ExitEdit();
        int barCount = _settings.Config.BarCount;
        int shown = 0;
        for (int i = 0; i < _bars.Length; i++)
        {
            int idx = _offset + i;
            if (i < barCount && idx < _notes.Count)
            {
                var bar = _bars[i];
                bar.Border.DataContext = _notes[idx];
                bar.Border.Visibility = Visibility.Visible;
                UpdateBarDisplay(bar, _notes[idx]);
                shown++;
            }
            else
            {
                _bars[i].Border.DataContext = null;
                _bars[i].Border.Visibility = Visibility.Collapsed;
            }
        }

        CountText.Text = $"共 {_notes.Count} 条";
    }

    private void UpdateBarDisplay(NoteBar bar, NoteData note)
    {
        if (string.IsNullOrWhiteSpace(note.Text))
        {
            bar.Display.Text = "点击添加便签…";
            bar.Display.Foreground = (Brush)FindResource("TextSecondaryBrush");
            bar.Display.ToolTip = null;
        }
        else
        {
            bar.Display.Text = note.Text;
            bar.Display.Foreground = (Brush)FindResource("TextPrimaryBrush");
            bar.Display.ToolTip = note.Text;
        }
    }

    /// <summary>整体滑动动画：所有信息栏一起从偏移位置滑入（逐条滚动效果）。</summary>
    private void AnimateSlide(int steps)
    {
        BarsSlide.BeginAnimation(TranslateTransform.YProperty, null);
        BarsSlide.Y = steps > 0 ? BarSlot : -BarSlot;
        var anim = new DoubleAnimation(0, TimeSpan.FromMilliseconds(300));
        anim.EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut };
        anim.FillBehavior = FillBehavior.Stop;
        BarsSlide.BeginAnimation(TranslateTransform.YProperty, anim);
    }

    // ================= 编辑 =================

    private void EnterEdit(NoteBar bar, int index)
    {
        ExitEdit();
        if (index < 0 || index >= _notes.Count) return;
        _lastEnterTime = DateTime.MinValue;
        _editingBar = bar;
        _editingIndex = index;
        bar.Edit.Text = _notes[index].Text;
        bar.Display.Visibility = Visibility.Collapsed;
        bar.Edit.Visibility = Visibility.Visible;
        bar.Delete.Visibility = Visibility.Collapsed;
        bar.Border.Background = (Brush)FindResource("BarHoverBrush");
        bar.Edit.Focus();
        bar.Edit.CaretIndex = bar.Edit.Text.Length;
        Keyboard.Focus(bar.Edit);
        // 允许输入需要窗口激活（便签场景下用户主动点击编辑，激活是合理的）
        try { if (!IsActive) Activate(); } catch { }
    }

    /// <summary>提交当前编辑内容到便签数据。</summary>
    private void CommitEdit()
    {
        if (_editingBar == null || _editingIndex < 0 || _editingIndex >= _notes.Count) return;
        var note = _notes[_editingIndex];
        note.Text = _editingBar.Edit.Text.Trim();
        UpdateBarDisplay(_editingBar, note);
    }

    /// <summary>退出编辑（提交并恢复显示层）。</summary>
    private void ExitEdit()
    {
        if (_editingBar == null) return;
        CommitEdit();
        SaveNotes();   // 提交即持久化，避免退出前未保存
        _editingBar.Edit.Visibility = Visibility.Collapsed;
        _editingBar.Display.Visibility = Visibility.Visible;
        _editingBar.Border.Background = (Brush)FindResource("BarBrush");
        _editingBar = null;
        _editingIndex = -1;
        StopEnterTimer();
    }

    private void OnEditLostFocus(object sender, KeyboardFocusChangedEventArgs e)
    {
        if (sender is not TextBox tb || tb != _editingBar?.Edit) return;
        ExitEdit();
    }

    private void OnEditKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            e.Handled = true;
            var now = DateTime.UtcNow;
            bool isSecond = (now - _lastEnterTime).TotalMilliseconds <= DoubleEnterMs;
            _lastEnterTime = now;
            if (isSecond)
                CreateNewNoteAfterCurrent();
            else
            {
                CommitEdit();
                StartEnterTimer();   // 等待第二个回车：未到则自动退出编辑
            }
        }
        else if (e.Key == Key.Escape)
        {
            e.Handled = true;
            ExitEdit();
        }
    }

    private void StartEnterTimer()
    {
        StopEnterTimer();
        _enterTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(DoubleEnterMs + 60) };
        _enterTimer.Tick += (_, _) => { StopEnterTimer(); ExitEdit(); };
        _enterTimer.Start();
    }

    private void StopEnterTimer()
    {
        _enterTimer?.Stop();
        _enterTimer = null;
    }

    /// <summary>回车×2：在当前便签下方新建一条空白便签并进入编辑。</summary>
    private void CreateNewNoteAfterCurrent()
    {
        if (_editingBar == null || _editingIndex < 0) return;
        int idx = _editingIndex;
        CommitEdit();
        _editingBar.Edit.Visibility = Visibility.Collapsed;
        _editingBar.Display.Visibility = Visibility.Visible;
        _editingBar = null;
        _editingIndex = -1;
        StopEnterTimer();

        var nb = new NoteData();
        _notes.Insert(idx + 1, nb);
        int newIdx = idx + 1;
        int barCount = _settings.Config.BarCount;
        // 若新便签在视口外，滚动使其可见
        if (newIdx - _offset >= barCount) _offset = newIdx - barCount + 1;
        _offset = Math.Clamp(_offset, 0, Math.Max(0, _notes.Count - barCount));
        SaveNotes();
        UpdateBars();

        int slot = newIdx - _offset;
        if (slot >= 0 && slot < _bars.Length)
        {
            _lastEnterTime = DateTime.MinValue;   // 重置，避免连环新建
            EnterEdit(_bars[slot], newIdx);
        }
    }

    /// <summary>新增一条便签（末尾），滚动到末尾并进入编辑。</summary>
    public void AddNote()
    {
        ExitEdit();
        var nb = new NoteData();
        _notes.Add(nb);
        int newIdx = _notes.Count - 1;
        int barCount = _settings.Config.BarCount;
        _offset = Math.Max(0, _notes.Count - barCount);
        SaveNotes();
        UpdateBars();
        int slot = newIdx - _offset;
        if (slot >= 0 && slot < _bars.Length)
            EnterEdit(_bars[slot], newIdx);
    }

    // ================= 删除 =================

    private void DeleteNoteAt(int idx)
    {
        ExitEdit();
        if (idx < 0 || idx >= _notes.Count) return;
        _notes.RemoveAt(idx);
        EnsureMinNotes();
        int barCount = _settings.Config.BarCount;
        _offset = Math.Clamp(_offset, 0, Math.Max(0, _notes.Count - barCount));
        SaveNotes();
        UpdateBars();
    }

    // ================= 滚动 =================

    private void ScrollBy(int steps)
    {
        int barCount = _settings.Config.BarCount;
        if (_notes.Count == 0) return;
        int maxOffset = Math.Max(0, _notes.Count - barCount);
        int newOffset = Math.Clamp(_offset + steps, 0, maxOffset);
        if (newOffset == _offset) return;
        ExitEdit();
        _offset = newOffset;
        UpdateBars();
        AnimateSlide(steps);
    }

    // ================= 鼠标交互 =================

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
        if (msg == 0x020A) // WM_MOUSEWHEEL
        {
            int delta = (short)((long)wParam >> 16);
            if (delta != 0)
            {
                ScrollBy(delta > 0 ? -1 : 1);
                handled = true;
                return IntPtr.Zero;
            }
        }
        return IntPtr.Zero;
    }

    private void OnMouseWheel(object sender, MouseWheelEventArgs e)
    {
        ScrollBy(e.Delta > 0 ? -1 : 1);
        e.Handled = true;
    }

    // ---- 触屏：上下滑滚动，左划删除 ----
    private void OnManipulationStarting(object sender, ManipulationStartingEventArgs e)
    {
        e.ManipulationContainer = this;
        e.Mode = ManipulationModes.TranslateX | ManipulationModes.TranslateY;
        e.Handled = true;
    }

    private void OnManipulationStarted(object sender, ManipulationStartedEventArgs e)
    {
        _touchAccum = 0;
        _touchDeleted = false;
        _touchStartBar = FindBarAt(e.ManipulationOrigin);
    }

    private void OnManipulationDelta(object sender, ManipulationDeltaEventArgs e)
    {
        double dx = e.DeltaManipulation.Translation.X;
        double dy = e.DeltaManipulation.Translation.Y;

        // 向左划 → 删除当前信息栏
        if (!_touchDeleted && _touchStartBar != null &&
            dx < -DeleteSwipeThreshold && Math.Abs(dx) > Math.Abs(dy) * 1.5)
        {
            _touchDeleted = true;
            int idx = IndexOfBar(_touchStartBar);
            if (idx >= 0) DeleteNoteAt(idx);
        }
        else
        {
            // 上下滑动 → 滚动（手指向下滑 = 查看更早；向上滑 = 返回较新）
            _touchAccum += dy;
            while (_touchAccum >= BarSlot) { ScrollBy(1); _touchAccum -= BarSlot; }
            while (_touchAccum <= -BarSlot) { ScrollBy(-1); _touchAccum += BarSlot; }
        }
        e.Handled = true;
    }

    private void OnManipulationInertiaStarting(object sender, ManipulationInertiaStartingEventArgs e)
    {
        e.Handled = true;   // 关闭惯性，避免误触
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

        // 点在删除按钮上 → 交给按钮处理，不进入编辑/拖动
        if (HitDeleteButton(pos))
        {
            _downing = false;
            return;
        }

        _downPos = pos;
        _downing = true;
        _dragScroll = false;
        _downBar = FindBarAt(pos);
        // 注意：不能立即 CaptureMouse()，否则会抢走鼠标事件，
        // 导致按钮收不到 MouseUp、Click 不触发，标题栏 DragMove 也无法工作。
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

        // 判定拖动方向
        if (!_dragScroll)
        {
            double dx = pos.X - _downPos.X;
            double dy = pos.Y - _downPos.Y;
            if (Math.Abs(dx) > DragThreshold || Math.Abs(dy) > DragThreshold)
            {
                // 水平向左为主 → 左划删除当前信息栏
                if (Math.Abs(dx) > Math.Abs(dy) * 1.5 && dx < -DragThreshold && _downBar != null)
                {
                    int idx = IndexOfBar(_downBar);
                    if (idx >= 0) DeleteNoteAt(idx);
                    _downing = false;
                    _downBar = null;
                    e.Handled = true;
                    return;
                }
                // 垂直方向 → 拖动滚动
                _dragScroll = true;
                _lastDragY = pos.Y;
                _downBar = null; // 开始拖动则不再当作点击
                CaptureMouse();
            }
            return;
        }

        double d = pos.Y - _lastDragY;
        _lastDragY = pos.Y;
        if (Math.Abs(d) >= 18)
        {
            int steps = (int)(d / 18);
            ScrollBy(steps);                 // 向下拖动 → 查看更早
            _lastDragY = pos.Y - (d - steps * 18);
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
        if (wasDrag) ReleaseMouseCapture();
        if (wasDrag) { _downBar = null; return; }

        if (_downBar != null)
        {
            int idx = IndexOfBar(_downBar);
            // 已在该栏编辑时（如点击文本框定位光标）不重复进入编辑
            if (_editingBar == _downBar && _editingIndex == idx)
            {
                _downBar = null;
                return;
            }
            if (idx >= 0) EnterEdit(_downBar, idx);
        }
        else
        {
            // 点击空白处 → 退出编辑
            ExitEdit();
        }
        _downBar = null;
    }

    private NoteBar? FindBarAt(Point p)
    {
        var hit = InputHitTest(p) as DependencyObject;
        while (hit != null)
        {
            if (hit is Border b)
            {
                foreach (var nb in _bars)
                    if (nb.Border == b) return nb;
            }
            hit = VisualTreeHelper.GetParent(hit);
        }
        return null;
    }

    private bool HitDeleteButton(Point p)
    {
        var hit = InputHitTest(p) as DependencyObject;
        while (hit != null)
        {
            if (hit is Button btn)
            {
                foreach (var nb in _bars)
                    if (nb.Delete == btn) return true;
                return false;
            }
            hit = VisualTreeHelper.GetParent(hit);
        }
        return false;
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
        _settings.Config.Top = Top;
        _settings.Save();
    }

    // ================= 布局 / 配置 =================

    private void ApplyConfig()
    {
        var c = _settings.Config;
        Width = c.Width;
        Height = OuterPad + HeaderH + 1 + 10 + c.BarCount * BarSlot + 8 + FooterH;
        Topmost = c.TopMost;

        // 位置
        var wa = SystemParameters.WorkArea;
        if (c.RememberPos && !double.IsNaN(c.Left) && !double.IsNaN(c.Top))
        {
            Left = Math.Clamp(c.Left, wa.Left - Width + 40, wa.Right - 60);
            Top = Math.Clamp(c.Top, wa.Top, wa.Bottom - 60);
        }
        else
        {
            Left = wa.Right - Width - 24;
            Top = wa.Top + 90;
        }

        UpdateBars();
    }

    /// <summary>设置窗口改动后调用。</summary>
    public void ApplySettings()
    {
        EnsureMinNotes();
        SaveNotes();
        _offset = Math.Clamp(_offset, 0, Math.Max(0, _notes.Count - _settings.Config.BarCount));
        ApplyConfig();
    }

    // ================= 对外方法（托盘 / 菜单调用） =================

    /// <summary>允许真正关闭（退出时由 App 设置）。</summary>
    public bool AllowClose { get; set; }

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

    private SettingsWindow? _settingsWin;

    public void OpenSettings()
    {
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
        _settingsWin.Left = Left - _settingsWin.Width - 12;
        _settingsWin.Top = Top;
        if (_settingsWin.Left < SystemParameters.WorkArea.Left) _settingsWin.Left = Left + Width + 12;
        _settingsWin.Show();
        _settingsWin.Closed += (_, _) => _settingsWin = null;
    }

    // ================= 按钮 / 菜单事件 =================

    private void BtnAdd_Click(object sender, RoutedEventArgs e)
    {
        e.Handled = true;
        AddNote();
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

    private void CtxAdd_Click(object sender, RoutedEventArgs e) => AddNote();
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
