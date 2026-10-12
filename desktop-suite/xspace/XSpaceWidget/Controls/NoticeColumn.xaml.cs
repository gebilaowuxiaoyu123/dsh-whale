using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using XSpaceWidget.Models;
using XSpaceWidget.Services;
// WinForms 的隐式 using 会引入同名类型，这里显式指定 WPF 的
using UserControl = System.Windows.Controls.UserControl;
using Brush = System.Windows.Media.Brush;
using Point = System.Windows.Point;
using Binding = System.Windows.Data.Binding;
using Cursors = System.Windows.Input.Cursors;
using HorizontalAlignment = System.Windows.HorizontalAlignment;
using VerticalAlignment = System.Windows.VerticalAlignment;
using Orientation = System.Windows.Controls.Orientation;
using Color = System.Windows.Media.Color;

namespace XSpaceWidget.Controls;

/// <summary>
/// 单列信息栏：拥有独立的列表、滚动位置、页码与滑动动画。
/// 数据由 <see cref="INoticeSource"/> 提供（左列=X·Space，右列=赛氪 / 自定义网页）。
/// </summary>
public partial class NoticeColumn : UserControl
{
    /// <summary>每条栏占位高度 = 条高 42 + 上下外边距 2+2。</summary>
    public const double BarSlot = 46;

    /// <summary>列头高度（主窗口用它计算总高）。</summary>
    public const double HeaderHeight = 20;

    private const double RollMs = 320;         // 单条弹入时长(ms)
    private const double StaggerMs = 24;       // 逐条错峰间隔(ms)，最多错 5 条
    private const double EntryScale = 0.965;   // 入场起始缩放

    public static readonly DependencyProperty AccentProperty =
        DependencyProperty.Register(nameof(Accent), typeof(Brush), typeof(NoticeColumn),
            new PropertyMetadata(System.Windows.Media.Brushes.DeepSkyBlue,
                (d, _) => ((NoticeColumn)d).ApplyAccent()));

    /// <summary>强调色（日期文字 / 状态点）。</summary>
    public Brush Accent
    {
        get => (Brush)GetValue(AccentProperty);
        set => SetValue(AccentProperty, value);
    }

    /// <summary>一个固定槽位：容器 + 变换 + 需要跟强调色联动的文字。</summary>
    private sealed class BarCell
    {
        public Border Root = null!;
        public ScaleTransform Scale = null!;
        public TranslateTransform Move = null!;
        public TextBlock DateText = null!;
        public ColumnDefinition SlotColumn = null!;
    }

    private readonly List<NoticeItem> _all = new();      // 已加载全部（新→旧）
    private readonly List<BarCell> _cells = new();       // 固定槽位（比显示条数多 1，作滚动缓冲）
    private readonly HashSet<int> _loadedPages = new();
    private INoticeSource? _source;
    private int _barCount = 5;
    private int _offset;                                  // 视口起始索引
    private int _lastLoadedPage = 1;
    private int _maxPage = 1;
    private bool _busy;
    private int _requestId;         // 每次成功开始抓取自增；只有“最后一个请求”负责清 _busy（换源取消时不会卡死）
    private bool _preloading;
    private int _pendingSteps;      // 到边界后用户继续划的格数，等新数据到达自动补齐
    private int _sourceVersion;     // 换数据源时自增，用于丢弃过期的异步结果
    private CancellationTokenSource? _fetchCts;   // 换数据源时取消在途抓取（否则旧结果会晩到盖掉新视图）
    private double _slotWidth = 46; // 左侧槽位宽度（价格栏更宽）

    /// <summary>状态变化（主窗口用它更新底部状态栏）。</summary>
    public event Action<NoticeColumn, StatusKind, string>? StatusChanged;

    public NoticeColumn()
    {
        InitializeComponent();
    }

    /// <summary>列标题。</summary>
    public string ColumnTitle
    {
        get => ColTitle.Text;
        set => ColTitle.Text = value ?? "";
    }

    /// <summary>本列显示条数（1..12）。</summary>
    public int BarCount
    {
        get => _barCount;
        set
        {
            int v = Math.Clamp(value, 1, 12);
            if (v == _barCount) return;
            _barCount = v;
            UpdateBars();
        }
    }

    /// <summary>当前是否有内容。</summary>
    public bool HasItems => _all.Count > 0;

    /// <summary>装配数据源（会清空当前内容，并作废正在进行的抓取）。</summary>
    public void SetSource(INoticeSource? source)
    {
        // 先取消在途请求：否则它的结果晚一步返回，会把新视图的内容盖成旧源的（翻转视图时最容易撞上）
        try { _fetchCts?.Cancel(); } catch { }
        _fetchCts?.Dispose();
        _fetchCts = new CancellationTokenSource();
        _requestId++;                  // 作废在途请求对 _busy 的所有权
        _busy = false;
        _preloading = false;
        _source = source;
        _sourceVersion++;
        _pendingSteps = 0;
        _all.Clear();
        _loadedPages.Clear();
        _offset = 0;
        _lastLoadedPage = 1;
        _maxPage = 1;
        UpdateBars();
        ColPage.Text = "";
        ColumnTitle = source?.Title ?? "";
        _slotWidth = source?.SlotWidth ?? 46;
        foreach (var cell in _cells) ApplySlotMetrics(cell);
        EmptyPanel.Visibility = Visibility.Collapsed;
        SetDot(StatusKind.Loading);
    }

    /// <summary>把当前数据源的槽位宽度 / 字号应用到某个槽位。</summary>
    private void ApplySlotMetrics(BarCell cell)
    {
        cell.SlotColumn.Width = new GridLength(_slotWidth);
        cell.DateText.FontSize = _slotWidth > 50 ? 12 : 13;
    }

    // ================= 刷新 =================

    /// <summary>抓取第一页并重建列表。返回是否成功。</summary>
    public async Task<bool> RefreshNewestAsync()
    {
        if (_source == null || _busy) return false;
        _busy = true;
        int myRequest = ++_requestId;
        var source = _source;
        int version = _sourceVersion;
        var token = _fetchCts?.Token ?? CancellationToken.None;
        try
        {
            if (_all.Count == 0) ShowBusy("正在获取…");
            Report(StatusKind.Loading, "正在获取…");

            var items = await source.FetchAsync(1, token);
            if (version != _sourceVersion) return false;      // 期间换了数据源，丢弃结果
            _maxPage = source.SupportsPaging ? await source.GetMaxPageAsync(token) : 1;
            if (version != _sourceVersion) return false;
            if (_maxPage < 1) _maxPage = 1;

            if (items.Count == 0)
            {
                _all.Clear();
                UpdateBars();
                ShowEmpty(source.EmptyHint);
                bool ok = source.EmptyIsOk;      // 空购物车属于正常情况，不算失败
                Report(ok ? StatusKind.Ok : StatusKind.Warn, ok ? "已是最新" : "未获取到内容");
                return ok;
            }

            _all.Clear();
            _all.AddRange(items);
            _loadedPages.Clear();
            _loadedPages.Add(1);
            _lastLoadedPage = 1;
            _offset = 0;
            _pendingSteps = 0;
            EmptyPanel.Visibility = Visibility.Collapsed;
            UpdateBars();
            SetDot(StatusKind.Ok);
            return true;
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            return false;                     // 换数据源导致的取消，不算错误
        }
        catch (Exception ex)
        {
            if (version != _sourceVersion) return false;
            ShowEmpty("获取失败：\n" + Short(ex), StatusKind.Error);
            Report(StatusKind.Error, "获取失败");
            return false;
        }
        finally { if (myRequest == _requestId) _busy = false; }   // 只有最后一个请求负责清 busy
    }

    /// <summary>定时自动刷新：只替换第 1 页内容，并保持用户当前看到的位置。</summary>
    public async Task AutoRefreshAsync()
    {
        if (_source == null || _busy) return;
        _busy = true;
        int myRequest = ++_requestId;
        var source = _source;
        int version = _sourceVersion;
        var token = _fetchCts?.Token ?? CancellationToken.None;
        try
        {
            var items = await source.FetchAsync(1, token);
            if (version != _sourceVersion) return;      // 期间换了数据源，丢弃结果
            if (items.Count == 0) return;

            // 新旧第一页条数可能不同，按差值平移视口，避免用户看到的内容跳变
            int delta = items.Count - _all.Count(i => i.Page == 1);
            _all.RemoveAll(i => i.Page == 1);
            _all.InsertRange(0, items);
            _offset = Math.Clamp(_offset + delta, 0, Math.Max(0, _all.Count - 1));
            EmptyPanel.Visibility = Visibility.Collapsed;
            UpdateBars();
            SetDot(StatusKind.Ok);
            Report(StatusKind.Ok, $"自动更新 {DateTime.Now:HH:mm:ss}");
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch { if (version == _sourceVersion) Report(StatusKind.Warn, "自动刷新失败，稍后重试"); }
        finally { if (myRequest == _requestId) _busy = false; }
    }

    /// <summary>后台预取下一页（同一时刻只跑一个）；抓完自动补齐挂起的前进、并继续保缓冲。</summary>
    private async Task PreloadNextAsync()
    {
        if (_source == null || !_source.SupportsPaging || _preloading || _busy) return;
        int next = _lastLoadedPage + 1;
        if (next > _maxPage || _loadedPages.Contains(next))
        {
            if (_pendingSteps > 0) { _pendingSteps = 0; AnimateEdgeBounce(-1); }   // 没有更多页了
            return;
        }

        var source = _source;
        int version = _sourceVersion;
        var token = _fetchCts?.Token ?? CancellationToken.None;
        _preloading = true;
        _loadedPages.Add(next);
        Report(StatusKind.Loading, $"正在加载第 {next} 页…");
        UpdatePageText();
        try
        {
            var items = await source.FetchAsync(next, token);
            if (version != _sourceVersion) return;      // 期间换了数据源，丢弃结果

            if (items.Count == 0)
            {
                // 没有更多内容了（例如该页面没有分页控件）：收紧总页数，避免反复重试
                _maxPage = Math.Max(1, _lastLoadedPage);
                Report(StatusKind.Ok, "已到最后一页");
                if (_pendingSteps > 0) { _pendingSteps = 0; AnimateEdgeBounce(-1); }
                return;
            }

            _all.AddRange(items);
            _lastLoadedPage = next;
            SetDot(StatusKind.Ok);
            Report(StatusKind.Ok, $"已加载至第 {next} 页");
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }   // 换数据源导致的取消，忽略
        catch
        {
            if (version != _sourceVersion) return;
            _loadedPages.Remove(next);
            Report(StatusKind.Warn, "加载更多失败");
        }
        finally
        {
            if (version == _sourceVersion) _preloading = false;
            if (version == _sourceVersion) UpdatePageText();
        }

        // 数据到位：把用户在底部继续划的格数补上，然后继续保缓冲
        if (_pendingSteps > 0)
        {
            int steps = _pendingSteps;
            _pendingSteps = 0;
            ScrollBy(steps);
            return;
        }
        EnsureBuffer();
    }

    // ================= 滚动与动画 =================

    /// <summary>滚动 steps 条（正数=查看更早）；到顶/底会回弹，划到末尾会自动继续加载下一页。</summary>
    public void ScrollBy(int steps)
    {
        if (_all.Count == 0 || steps == 0) return;

        int maxOffset = Math.Max(0, _all.Count - 1);
        int next = Math.Clamp(_offset + steps, 0, maxOffset);
        if (next == _offset)
        {
            // 已经在边界上
            if (steps > 0)
            {
                if (_lastLoadedPage < _maxPage)
                    _pendingSteps += steps;    // 还有下一页：先攒着，数据到了一起走
                else
                    AnimateEdgeBounce(-1);     // 真的到底了：向上弹一下
                _ = PreloadNextAsync();
            }
            else
            {
                AnimateEdgeBounce(1);          // 到顶：向下弹一下
            }
            return;
        }

        _offset = next;
        _pendingSteps = 0;
        UpdateBars();
        AnimateRoll(steps);
        EnsureBuffer();
    }

    /// <summary>保持前方有足够缓冲（“一直划能一直出来”）：不足 2 屏就接着抓下一页。</summary>
    private void EnsureBuffer()
    {
        if (_source == null || !_source.SupportsPaging) return;
        if (_all.Count - _offset >= _barCount * 2) return;
        _ = PreloadNextAsync();
    }

    /// <summary>
    /// 刷新列表显示。固定槽位数 = 显示条数 + 1（多出的那条作滚动缓冲，超出列高的部分被裁掉）。
    /// </summary>
    private void UpdateBars()
    {
        EnsureBars();
        int shown = 0;
        for (int i = 0; i < _cells.Count; i++)
        {
            var cell = _cells[i];
            int idx = _offset + i;
            if (idx < _all.Count)
            {
                cell.Root.DataContext = _all[idx];
                cell.Root.Visibility = Visibility.Visible;
                shown++;
            }
            else
            {
                cell.Root.Visibility = Visibility.Collapsed;
                cell.Root.DataContext = null;
            }
        }
        ResetTransforms();

        if (_all.Count == 0)
        {
            ColPage.Text = "";
            EmptyPanel.Visibility = Visibility.Visible;
            return;
        }

        UpdatePageText();
        EmptyPanel.Visibility = shown == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>刷新列头页码（加载中会带“载入中”后缀）。</summary>
    private void UpdatePageText()
    {
        if (_all.Count == 0)
        {
            ColPage.Text = "";
            return;
        }

        int curPage = _all[Math.Min(_offset, _all.Count - 1)].Page;
        string unit = _source?.Unit ?? "条";
        string text = _maxPage <= 1 ? $"共 {_all.Count} {unit}"
                    : curPage <= 1 ? $"最新 · 共 {_maxPage} 页"
                    : $"第 {curPage}/{_maxPage} 页";
        ColPage.Text = _preloading ? text + " · 载入中" : text;
    }

    /// <summary>按显示条数增删固定槽位。</summary>
    private void EnsureBars()
    {
        int need = Math.Clamp(_barCount + 1, 2, 13);
        while (_cells.Count < need)
        {
            var cell = CreateCell();
            cell.Root.Visibility = Visibility.Collapsed;
            _cells.Add(cell);
            BarsHost.Children.Add(cell.Root);
        }
        while (_cells.Count > need)
        {
            var last = _cells[^1];
            BarsHost.Children.Remove(last.Root);
            _cells.RemoveAt(_cells.Count - 1);
        }
    }

    private BarCell CreateCell()
    {
        var scale = new ScaleTransform(1, 1);
        var move = new TranslateTransform(0, 0);
        var cell = new BarCell { Scale = scale, Move = move };

        var dateText = new TextBlock
        {
            FontSize = 13,
            FontWeight = FontWeights.Bold,
            Foreground = Accent
        };
        dateText.SetBinding(TextBlock.TextProperty, new Binding("SlotTopText"));

        // 注意：这里不能直接给 Foreground/FontSize 赋局部值——局部值优先级高于样式触发器，会让折扣变色失效
        var subText = new TextBlock();
        subText.SetBinding(TextBlock.TextProperty, new Binding("SlotBottomText"));
        // 有折扣时：主价（折扣价）已经在上方，这里用小字 + 划线显示原价，一眼能看出“原价多少、便宜了多少”
        var subStyle = new Style(typeof(TextBlock));
        subStyle.Setters.Add(new Setter(TextBlock.ForegroundProperty, (Brush)FindResource("TextSecondaryBrush")));
        subStyle.Setters.Add(new Setter(TextBlock.FontSizeProperty, 8d));
        var subTrigger = new DataTrigger { Binding = new Binding("HasDiscount"), Value = true };
        subTrigger.Setters.Add(new Setter(TextBlock.TextDecorationsProperty, TextDecorations.Strikethrough));
        subTrigger.Setters.Add(new Setter(TextBlock.FontSizeProperty, 9d));
        subStyle.Triggers.Add(subTrigger);
        subText.Style = subStyle;

        var datePanel = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        datePanel.Children.Add(dateText);
        datePanel.Children.Add(subText);
        Grid.SetColumn(datePanel, 0);

        var title = new TextBlock
        {
            FontSize = 11.5,
            Foreground = (Brush)FindResource("TextPrimaryBrush"),
            TextTrimming = TextTrimming.CharacterEllipsis
        };
        title.SetBinding(TextBlock.TextProperty, new Binding("ShortTitle"));
        title.SetBinding(TextBlock.ToolTipProperty, new Binding("TooltipText"));

        // 标题下一行：形式 / 级别 / 类别 胶囊标签
        var chips = new ItemsControl { Margin = new Thickness(0, 2, 0, 0) };
        chips.SetBinding(ItemsControl.ItemsSourceProperty, new Binding("Tags"));
        chips.ItemTemplate = _chipTemplate ??= CreateChipTemplate();
        var chipPanel = new FrameworkElementFactory(typeof(StackPanel));
        chipPanel.SetValue(StackPanel.OrientationProperty, Orientation.Horizontal);
        chips.ItemsPanel = new ItemsPanelTemplate(chipPanel);

        var titlePanel = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        titlePanel.Children.Add(title);
        titlePanel.Children.Add(chips);
        Grid.SetColumn(titlePanel, 1);

        var chev = new TextBlock
        {
            Text = "\u203A",
            FontSize = 15,
            Foreground = (Brush)FindResource("TextSecondaryBrush"),
            VerticalAlignment = VerticalAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Right
        };
        Grid.SetColumn(chev, 2);

        var grid = new Grid { Margin = new Thickness(10, 0, 8, 0) };
        var slotColumn = new ColumnDefinition { Width = new GridLength(_slotWidth) };
        grid.ColumnDefinitions.Add(slotColumn);
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(14) });
        cell.SlotColumn = slotColumn;
        grid.Children.Add(datePanel);
        grid.Children.Add(titlePanel);
        grid.Children.Add(chev);

        var border = new Border
        {
            Height = 42,
            CornerRadius = new CornerRadius(9),
            Margin = new Thickness(0, 2, 0, 2),
            Background = (Brush)FindResource("BarBrush"),
            Cursor = Cursors.Hand,
            Child = grid,
            RenderTransformOrigin = new Point(0.5, 0.5),
            RenderTransform = new TransformGroup { Children = { scale, move } }
        };
        border.MouseEnter += (_, _) => border.Background = (Brush)FindResource("BarHoverBrush");
        border.MouseLeave += (_, _) => border.Background = (Brush)FindResource("BarBrush");
        // 按下时的"果冻"反馈
        border.MouseLeftButtonDown += (_, _) => AnimateScale(cell, 0.972, 90);
        border.MouseLeftButtonUp += (_, _) => AnimateScale(cell, 1, 240);

        cell.Root = border;
        cell.DateText = dateText;
        ApplySlotMetrics(cell);
        return cell;
    }

    private static DataTemplate? _chipTemplate;

    /// <summary>胶囊小标签模板：圆角=半高、字号约高度 2/3；按 Kind 上色（形式=琥珀、级别=蓝、其他=中性）。</summary>
    private static DataTemplate CreateChipTemplate()
    {
        var border = new FrameworkElementFactory(typeof(Border));
        border.SetValue(Border.CornerRadiusProperty, new CornerRadius(6));
        border.SetValue(Border.PaddingProperty, new Thickness(6, 1, 6, 1));
        border.SetValue(Border.MarginProperty, new Thickness(0, 0, 4, 0));
        border.SetValue(FrameworkElement.StyleProperty, BuildChipStyle());

        var label = new FrameworkElementFactory(typeof(TextBlock));
        label.SetValue(TextBlock.FontSizeProperty, 8.5);
        label.SetValue(TextBlock.VerticalAlignmentProperty, VerticalAlignment.Center);
        label.SetValue(FrameworkElement.StyleProperty, BuildChipTextStyle());
        label.SetBinding(TextBlock.TextProperty, new Binding("Text"));
        border.AppendChild(label);

        return new DataTemplate { VisualTree = border };
    }

    private static Style BuildChipStyle()
    {
        var style = new Style(typeof(Border));
        style.Setters.Add(new Setter(Border.BackgroundProperty, Tint(0x28, 0xFF, 0xFF, 0xFF)));
        style.Triggers.Add(TintTrigger("top", Border.BackgroundProperty, Tint(0xE6, 0xFF, 0xC9, 0x3C)));      // 榜单：金色实底
        style.Triggers.Add(TintTrigger("deal", Border.BackgroundProperty, Tint(0xE6, 0xFF, 0xC9, 0x3C)));     // 特惠类型：金色实底
        style.Triggers.Add(TintTrigger("pct", Border.BackgroundProperty, Tint(0xF2, 0x4A, 0xDE, 0x80)));      // 折扣力度：亮绿实底
        style.Triggers.Add(TintTrigger("free", Border.BackgroundProperty, Tint(0xCC, 0x34, 0xD3, 0x99)));     // 免费：绿色
        style.Triggers.Add(TintTrigger("form", Border.BackgroundProperty, Tint(0x4A, 0xFB, 0xBF, 0x24)));
        style.Triggers.Add(TintTrigger("level", Border.BackgroundProperty, Tint(0x3A, 0xA7, 0x8B, 0xFA)));
        style.Triggers.Add(TintTrigger("team", Border.BackgroundProperty, Tint(0x33, 0x34, 0xD3, 0x99)));
        // 折扣胶囊略大一点
        var pctPad = new DataTrigger { Binding = new Binding("Kind"), Value = "pct" };
        pctPad.Setters.Add(new Setter(Border.PaddingProperty, new Thickness(7, 1.5, 7, 1.5)));
        pctPad.Setters.Add(new Setter(Border.CornerRadiusProperty, new CornerRadius(7)));
        style.Triggers.Add(pctPad);
        return style;
    }

    private static Style BuildChipTextStyle()
    {
        var style = new Style(typeof(TextBlock));
        style.Setters.Add(new Setter(TextBlock.ForegroundProperty, Tint(0xFF, 0xD8, 0xE3, 0xEE)));
        style.Triggers.Add(TintTrigger("top", TextBlock.ForegroundProperty, Tint(0xFF, 0x3A, 0x2A, 0x06)));      // 金底上用深色字
        style.Triggers.Add(TintTrigger("deal", TextBlock.ForegroundProperty, Tint(0xFF, 0x3A, 0x2A, 0x06)));
        style.Triggers.Add(TintTrigger("pct", TextBlock.ForegroundProperty, Tint(0xFF, 0x06, 0x2A, 0x17)));       // 亮绿底上用深色字
        style.Triggers.Add(TintTrigger("free", TextBlock.ForegroundProperty, Tint(0xFF, 0x06, 0x2A, 0x17)));
        style.Triggers.Add(TintTrigger("form", TextBlock.ForegroundProperty, Tint(0xFF, 0xFD, 0xE2, 0x8A)));
        style.Triggers.Add(TintTrigger("level", TextBlock.ForegroundProperty, Tint(0xFF, 0xC4, 0xB5, 0xFD)));
        style.Triggers.Add(TintTrigger("team", TextBlock.ForegroundProperty, Tint(0xFF, 0x8C, 0xF0, 0xB4)));
        // 折扣胶囊：字号大一号 + 加粗
        var pctText = new DataTrigger { Binding = new Binding("Kind"), Value = "pct" };
        pctText.Setters.Add(new Setter(TextBlock.FontSizeProperty, 10.5));
        pctText.Setters.Add(new Setter(TextBlock.FontWeightProperty, FontWeights.Bold));
        style.Triggers.Add(pctText);
        return style;
    }

    private static DataTrigger TintTrigger(string kind, DependencyProperty prop, Brush brush)
    {
        var trigger = new DataTrigger { Binding = new Binding("Kind"), Value = kind };
        trigger.Setters.Add(new Setter(prop, brush));
        return trigger;
    }

    private static SolidColorBrush Tint(byte a, byte r, byte g, byte b) => new(Color.FromArgb(a, r, g, b));

    /// <summary>强调色变化时同步所有槽位的日期文字与状态点。</summary>
    private void ApplyAccent()
    {
        foreach (var cell in _cells) cell.DateText.Foreground = Accent;
        ColDot.Fill = Accent;
    }

    /// <summary>
    /// 标记本列是不是“键盘当前作用列”（点过 / 滑过的那一列）：
    /// 激活时列头下方亮一条强调色细线，同时列名不透明；未激活时变淡。
    /// </summary>
    public void SetActive(bool active)
    {
        FocusLine.Opacity = active ? 0.9 : 0;
        ColTitle.Opacity = active ? 1 : 0.7;
    }

    /// <summary>
    /// 逐条弹入（参考 vivo 通知栏的"果冻"手感）：新内容从 ±一格 的位置带轻微过冲滑到位，
    /// 同时淡入 + 微放大，各条之间错峰少量时间形成波浪感。
    /// </summary>
    private void AnimateRoll(int steps)
    {
        double from = steps > 0 ? BarSlot : -BarSlot;
        int n = 0;
        foreach (var cell in _cells)
        {
            if (cell.Root.Visibility != Visibility.Visible) continue;

            var delay = TimeSpan.FromMilliseconds(Math.Min(n, 5) * StaggerMs);
            n++;
            var rise = new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = 0.30 };
            var fade = new CubicEase { EasingMode = EasingMode.EaseOut };

            PlaySettle(cell.Move, TranslateTransform.YProperty, from, 0, delay, rise);
            PlaySettle(cell.Scale, ScaleTransform.ScaleXProperty, EntryScale, 1, delay, rise);
            PlaySettle(cell.Scale, ScaleTransform.ScaleYProperty, EntryScale, 1, delay, rise);
            PlaySettle(cell.Root, OpacityProperty, 0.35, 1, delay, fade);
        }
    }

    /// <summary>到顶 / 到底时的一下弹性回弹。</summary>
    private void AnimateEdgeBounce(int dir)
    {
        int n = 0;
        foreach (var cell in _cells)
        {
            if (cell.Root.Visibility != Visibility.Visible) continue;
            double delayMs = Math.Min(n, 5) * 14;
            n++;

            var frames = new DoubleAnimationUsingKeyFrames { FillBehavior = FillBehavior.HoldEnd };
            frames.KeyFrames.Add(new EasingDoubleKeyFrame(0, KeyTime.FromTimeSpan(TimeSpan.Zero)));
            frames.KeyFrames.Add(new EasingDoubleKeyFrame(dir * 13,
                KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(delayMs + 110)),
                new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = 0.5 }));
            frames.KeyFrames.Add(new EasingDoubleKeyFrame(0,
                KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(delayMs + 300)),
                new CubicEase { EasingMode = EasingMode.EaseOut }));

            cell.Move.BeginAnimation(TranslateTransform.YProperty, null);
            cell.Move.Y = 0;
            cell.Move.BeginAnimation(TranslateTransform.YProperty, frames);
        }
    }

    /// <summary>清掉所有槽位的动画并归位（滚动前先归位，动画才从确定的起点开始）。</summary>
    private void ResetTransforms()
    {
        foreach (var cell in _cells)
        {
            cell.Move.BeginAnimation(TranslateTransform.YProperty, null);
            cell.Move.Y = 0;
            cell.Scale.BeginAnimation(ScaleTransform.ScaleXProperty, null);
            cell.Scale.BeginAnimation(ScaleTransform.ScaleYProperty, null);
            cell.Scale.ScaleX = cell.Scale.ScaleY = 1;
            cell.Root.BeginAnimation(OpacityProperty, null);
            cell.Root.Opacity = 1;
        }
    }

    private static void AnimateScale(BarCell cell, double to, int ms)
    {
        var anim = new DoubleAnimation(to, TimeSpan.FromMilliseconds(ms))
        {
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
        };
        cell.Scale.BeginAnimation(ScaleTransform.ScaleXProperty, anim);
        cell.Scale.BeginAnimation(ScaleTransform.ScaleYProperty, anim);
    }

    /// <summary>属性从 from 弹到 to（延迟 delay 后开始），结束后由动画保持终值。</summary>
    private static void PlaySettle(DependencyObject obj, DependencyProperty prop,
                                   double from, double to, TimeSpan delay, IEasingFunction easing)
    {
        var target = (IAnimatable)obj;
        target.BeginAnimation(prop, null);
        obj.SetValue(prop, from);          // 基值 = 起点（延迟期间显示起点态）
        target.BeginAnimation(prop, new DoubleAnimation(to, TimeSpan.FromMilliseconds(RollMs))
        {
            BeginTime = delay,
            EasingFunction = easing,
            FillBehavior = FillBehavior.HoldEnd
        });
    }

    // ================= 状态 =================

    /// <summary>显示空态 / 错误提示。</summary>
    public void ShowEmpty(string text, StatusKind kind = StatusKind.Warn)
    {
        _all.Clear();
        UpdateBars();
        ColPage.Text = "";
        EmptyText.Text = text;
        EmptyPanel.Visibility = Visibility.Visible;
        SetDot(kind);
    }

    private void ShowBusy(string text)
    {
        EmptyText.Text = text;
        EmptyPanel.Visibility = Visibility.Visible;
        SetDot(StatusKind.Loading);
    }

    private void Report(StatusKind kind, string text)
    {
        SetDot(kind);
        StatusChanged?.Invoke(this, kind, text);
    }

    private void SetDot(StatusKind kind)
    {
        string key = kind switch
        {
            StatusKind.Ok => "OkBrush",
            StatusKind.Warn => "WarnBrush",
            StatusKind.Error => "DangerBrush",
            _ => "AccentBrush"
        };
        if (TryFindResource(key) is Brush b) ColDot.Fill = b;
    }

    private static string Short(Exception ex)
    {
        var s = ex.Message;
        return s.Length > 90 ? s[..90] : s;
    }
}
