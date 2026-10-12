using System.IO;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace XSpaceWidget;

/// <summary>隐藏的 WebView2 宿主窗口，用于抓取目标站点数据。</summary>
public partial class FetcherWindow : Window
{
    public WebView2 Web => Web2;

    public FetcherWindow()
    {
        InitializeComponent();
    }

    public async Task InitWebViewAsync()
    {
        var userData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "XSpaceWidget", "WebView2Data");
        var env = await CoreWebView2Environment.CreateAsync(null, userData, null);
        await Web2.EnsureCoreWebView2Async(env);
        Web2.CoreWebView2.Settings.AreDevToolsEnabled = false;
        Web2.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        Web2.CoreWebView2.Settings.IsStatusBarEnabled = false;
        Web2.CoreWebView2.Settings.IsZoomControlEnabled = false;
    }
}
