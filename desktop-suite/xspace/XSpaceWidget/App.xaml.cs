using System.IO;
using System.Threading;
using System.Windows;
using XSpaceWidget.Services;

namespace XSpaceWidget;

/// <summary>应用入口：单实例、托盘图标、服务装配。</summary>
public partial class App : System.Windows.Application
{
    private Mutex? _mutex;
    private System.Windows.Forms.NotifyIcon? _tray;
    private MainWindow? _main;
    private SettingsService? _settings;
    private FetcherService? _fetcher;

    protected override void OnStartup(StartupEventArgs e)
    {
        // 全局异常记录（便于诊断）
        DispatcherUnhandledException += (_, args) =>
        {
            LogError("DispatcherUnhandled", args.Exception);
            args.Handled = true;
        };
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            LogError("AppDomainUnhandled", args.ExceptionObject as Exception);

        // 单实例
        _mutex = new Mutex(true, @"Local\XSpaceWidget_SingleInstance", out bool createdNew);
        if (!createdNew)
        {
            Shutdown();
            return;
        }

        base.OnStartup(e);
        ShutdownMode = ShutdownMode.OnExplicitShutdown;

        _settings = new SettingsService();
        _fetcher = new FetcherService();

        _main = new MainWindow(_settings, _fetcher);
        MainWindow = _main;
        _main.Show();
        CreateTrayIcon();

        // 保存窗口位置等
        _main.Closed += (_, _) => { _settings.Save(); };
    }

    private static void LogError(string tag, Exception? ex)
    {
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "error.log");
            File.AppendAllText(path,
                $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {tag}: {ex}\n\n");
        }
        catch { }
    }

    private void CreateTrayIcon()
    {
        try
        {
            _tray = new System.Windows.Forms.NotifyIcon
            {
                Icon = IconFactory.CreateIcon(),
                Text = "XSpace竞赛通知桌面栏",
                Visible = true
            };
            var menu = new System.Windows.Forms.ContextMenuStrip();
            menu.Items.Add("显示 / 隐藏信息栏", null, (_, _) => ToggleMain());
            menu.Items.Add("立即刷新", null, (_, _) => _main?.RefreshNow());
            menu.Items.Add("设置", null, (_, _) => _main?.OpenSettings());
            menu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
            menu.Items.Add("开机自启", null, (_, _) => _main?.ToggleAutoStart());
            menu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
            menu.Items.Add("退出", null, (_, _) => ExitApp());
            _tray.ContextMenuStrip = menu;
            _tray.DoubleClick += (_, _) => ToggleMain();
        }
        catch { /* 托盘创建失败不阻塞 */ }
    }

    private void ToggleMain()
    {
        if (_main == null) return;
        if (_main.IsVisible) _main.Hide();
        else
        {
            _main.Show();
            _main.Activate();
        }
    }

    private void ExitApp()
    {
        if (_main != null) _main.AllowClose = true;
        try { _settings?.Save(); } catch { }
        try { _tray?.Dispose(); } catch { }
        try { _fetcher?.Dispose(); } catch { }
        Shutdown();
    }

    /// <summary>请求退出应用（先允许窗口关闭）。</summary>
    public static void RequestExit()
    {
        var app = Current as App;
        app?.ExitApp();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        try { _settings?.Save(); } catch { }
        try { _tray?.Dispose(); } catch { }
        try { _fetcher?.Dispose(); } catch { }
        try { _mutex?.Dispose(); } catch { }
        base.OnExit(e);
    }
}

