using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using XSpaceWidget.Services;
using Point = System.Windows.Point;
using MouseEventArgs = System.Windows.Input.MouseEventArgs;

namespace XSpaceWidget;

/// <summary>设置窗口：栏数、自动刷新、开机自启、置顶等。</summary>
public partial class SettingsWindow : Window
{
    private readonly SettingsService _settings;
    private readonly MainWindow _main;
    private bool _loading = true;

    public SettingsWindow(SettingsService settings, MainWindow main)
    {
        InitializeComponent();
        _settings = settings;
        _main = main;
        VersionText.Text = "XSpace竞赛通知桌面栏 v" + (System.Reflection.Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "1.0.0");
        LoadConfig();
        _loading = false;
    }

    private void LoadConfig()
    {
        var c = _settings.Config;

        // 模式
        if (c.Mode == "generic") RadioGeneric.IsChecked = true;
        else RadioDefault.IsChecked = true;
        GenericPanel.Visibility = c.Mode == "generic" ? Visibility.Visible : Visibility.Collapsed;
        GenericUrlBox.Text = c.GenericUrl;
        GenericTitleBox.Text = c.GenericTitle;

        BarCountSlider.Value = c.BarCount;
        BarCountValue.Text = c.BarCount.ToString();
        AutoRefreshCheck.IsChecked = c.AutoRefresh;
        IntervalCombo.IsEnabled = c.AutoRefresh;
        foreach (ComboBoxItem item in IntervalCombo.Items)
            if (item.Tag?.ToString() == c.RefreshMinutes.ToString())
            {
                IntervalCombo.SelectedItem = item;
                break;
            }
        AutoStartCheck.IsChecked = c.AutoStart;
        TopMostCheck.IsChecked = c.TopMost;
        RememberPosCheck.IsChecked = c.RememberPos;

        // 鼠标跟随透明度
        MouseFadeCheck.IsChecked = c.MouseFade;
        OpacityAwaySlider.Value = Math.Clamp(c.OpacityAway, 0.05, 1.0);
        OpacityOverSlider.Value = Math.Clamp(c.OpacityOver, 0.05, 1.0);
        FadeMsSlider.Value = Math.Clamp(c.FadeMs, 0, 1000);
        OpacityAwayValue.Text = OpacityAwaySlider.Value.ToString("0.##");
        OpacityOverValue.Text = OpacityOverSlider.Value.ToString("0.##");
        FadeMsValue.Text = (int)FadeMsSlider.Value + " ms";
        HoverLiftSlider.Value = Math.Clamp(c.HoverLiftPx, 0, 24);
        HoverLiftValue.Text = HoverLiftSlider.Value.ToString("0") + " px";
    }

    private void ModeRadio_Checked(object sender, RoutedEventArgs e)
    {
        if (_loading || sender is not System.Windows.Controls.RadioButton rb) return;
        string mode = rb.Tag?.ToString() ?? "xspace";
        _settings.Config.Mode = mode;
        GenericPanel.Visibility = mode == "generic" ? Visibility.Visible : Visibility.Collapsed;
        SaveAndApply();
        _main.ApplySettings(reload: true);   // 切换后立即按新内容重新抓取右栏
    }

    private void GenericInput_Changed(object sender, TextChangedEventArgs e)
    {
        if (_loading) return;
        _settings.Config.GenericUrl = GenericUrlBox.Text.Trim();
        _settings.Config.GenericTitle = GenericTitleBox.Text.Trim();
        _settings.Save();
    }

    private void SaveAndApply()
    {
        if (_loading) return;
        _settings.Save();
        _main.ApplySettings();
    }

    // ---- 鼠标跟随透明度 ----

    private void MouseFade_Changed(object sender, RoutedEventArgs e)
    {
        if (_loading) return;
        _settings.Config.MouseFade = MouseFadeCheck.IsChecked == true;
        SaveAndApply();
    }

    private void OpacityAway_Changed(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (_loading) return;
        _settings.Config.OpacityAway = Math.Round(e.NewValue, 2);
        OpacityAwayValue.Text = e.NewValue.ToString("0.##");
        SaveAndApply();
    }

    private void OpacityOver_Changed(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (_loading) return;
        _settings.Config.OpacityOver = Math.Round(e.NewValue, 2);
        OpacityOverValue.Text = e.NewValue.ToString("0.##");
        SaveAndApply();
    }

    private void FadeMs_Changed(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (_loading) return;
        _settings.Config.FadeMs = (int)Math.Round(e.NewValue);
        FadeMsValue.Text = _settings.Config.FadeMs + " ms";
        SaveAndApply();
    }

    private void HoverLift_Changed(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (_loading) return;
        _settings.Config.HoverLiftPx = Math.Round(e.NewValue);
        HoverLiftValue.Text = _settings.Config.HoverLiftPx + " px";
        SaveAndApply();
    }

    private void BarCountSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (_loading) return;
        int v = (int)Math.Round(e.NewValue);
        BarCountValue.Text = v.ToString();
        _settings.Config.BarCount = v;
        SaveAndApply();
    }

    private void AutoRefresh_Changed(object sender, RoutedEventArgs e)
    {
        if (_loading) return;
        _settings.Config.AutoRefresh = AutoRefreshCheck.IsChecked == true;
        IntervalCombo.IsEnabled = _settings.Config.AutoRefresh;
        SaveAndApply();
    }

    private void IntervalCombo_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (_loading || IntervalCombo.SelectedItem is not ComboBoxItem item) return;
        if (int.TryParse(item.Tag?.ToString(), out int v))
        {
            _settings.Config.RefreshMinutes = v;
            SaveAndApply();
        }
    }

    private void AutoStart_Changed(object sender, RoutedEventArgs e)
    {
        if (_loading) return;
        _settings.Config.AutoStart = AutoStartCheck.IsChecked == true;
        AutoStartService.SetEnabled(_settings.Config.AutoStart);
        SaveAndApply();
    }

    private void TopMost_Changed(object sender, RoutedEventArgs e)
    {
        if (_loading) return;
        _settings.Config.TopMost = TopMostCheck.IsChecked == true;
        SaveAndApply();
    }

    private void RememberPos_Changed(object sender, RoutedEventArgs e)
    {
        if (_loading) return;
        _settings.Config.RememberPos = RememberPosCheck.IsChecked == true;
        SaveAndApply();
    }

    private async void BtnRefreshNow_Click(object sender, RoutedEventArgs e)
    {
        await _main.RefreshNowAsync();
    }

    private void BtnClose_Click(object sender, RoutedEventArgs e)
    {
        _settings.Save();
        Close();
    }

    private void Header_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        try { DragMove(); } catch { }
    }

    // ---- 窗口缩放（右下角边缘拖动）----
    private const double ResizeEdge = 7;
    private const double SMinW = 260;
    private const double SMinH = 400;
    private bool _resizing;
    private Point _resizeStart;
    private double _resizeStartW;
    private double _resizeStartH;

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
        if (IsInResizeEdge(pos))
        {
            _resizing = true;
            _resizeStart = pos;
            _resizeStartW = ActualWidth;
            _resizeStartH = ActualHeight;
            CaptureMouse();
            e.Handled = true;
        }
    }

    private void OnMouseMove(object sender, MouseEventArgs e)
    {
        var pos = e.GetPosition(this);
        if (_resizing)
        {
            Width = Math.Max(SMinW, _resizeStartW + (pos.X - _resizeStart.X));
            Height = Math.Max(SMinH, _resizeStartH + (pos.Y - _resizeStart.Y));
            e.Handled = true;
            return;
        }
        if (e.LeftButton == MouseButtonState.Released)
            Cursor = IsInResizeEdge(pos)
                ? System.Windows.Input.Cursors.SizeNWSE
                : System.Windows.Input.Cursors.Arrow;
    }

    private void OnMouseUp(object sender, MouseButtonEventArgs e)
    {
        if (_resizing)
        {
            _resizing = false;
            ReleaseMouseCapture();
            e.Handled = true;
        }
    }
}
