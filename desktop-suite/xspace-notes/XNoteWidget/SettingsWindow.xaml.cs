using System.Windows;
using System.Windows.Input;
using XNoteWidget.Services;
using Point = System.Windows.Point;
using MouseEventArgs = System.Windows.Input.MouseEventArgs;

namespace XNoteWidget;

/// <summary>设置窗口：栏数、开机自启、置顶、记住位置等。</summary>
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
        VersionText.Text = "便签桌面栏 v" + (System.Reflection.Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "1.0.0");
        LoadConfig();
        _loading = false;
    }

    private void LoadConfig()
    {
        var c = _settings.Config;
        BarCountSlider.Value = c.BarCount;
        BarCountValue.Text = c.BarCount.ToString();
        AutoStartCheck.IsChecked = c.AutoStart;
        TopMostCheck.IsChecked = c.TopMost;
        RememberPosCheck.IsChecked = c.RememberPos;
    }

    private void SaveAndApply()
    {
        if (_loading) return;
        _settings.Save();
        _main.ApplySettings();
    }

    private void BarCountSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (_loading) return;
        int v = (int)Math.Round(e.NewValue);
        BarCountValue.Text = v.ToString();
        _settings.Config.BarCount = v;
        SaveAndApply();
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
    private const double SMinH = 300;
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
