namespace XSpaceWidget.Services;

/// <summary>应用配置（保存于 exe 同目录 config.json，便于随程序一起拷贝）。</summary>
public class AppConfig
{
    /// <summary>右栏默认网址：赛氪竞赛广场（每次启动都回到该默认）。</summary>
    public const string DefaultRightUrl = "https://www.saikr.com/contests";

    /// <summary>右栏默认标题。</summary>
    public const string DefaultRightTitle = "赛氪竞赛广场";

    /// <summary>每列显示的栏数（条数），范围 2..12。</summary>
    public int BarCount { get; set; } = 5;

    /// <summary>是否联网自动刷新。</summary>
    public bool AutoRefresh { get; set; } = true;

    /// <summary>自动刷新间隔（分钟），范围 5..120。</summary>
    public int RefreshMinutes { get; set; } = 10;

    /// <summary>是否开机自启。</summary>
    public bool AutoStart { get; set; }

    /// <summary>是否置顶显示。</summary>
    public bool TopMost { get; set; } = false;

    /// <summary>是否记住窗口位置。</summary>
    public bool RememberPos { get; set; } = true;

    /// <summary>上次窗口位置。</summary>
    public double Left { get; set; } = double.NaN;

    /// <summary>上次窗口位置。</summary>
    public double Top { get; set; } = double.NaN;

    /// <summary>窗口宽度（两列合计）。</summary>
    public double Width { get; set; } = 600;

    /// <summary>右栏内容："xspace"=默认(赛氪竞赛广场)，"generic"=一般(自定义网页)。</summary>
    public string Mode { get; set; } = "xspace";

    /// <summary>一般模式（右栏自定义网页）的监控网址。</summary>
    public string GenericUrl { get; set; } = "";

    /// <summary>一般模式（右栏自定义网页）的信息栏标题。</summary>
    public string GenericTitle { get; set; } = "";

    // ================= Steam 价格视图（翻转后的两栏） =================

    /// <summary>使用哪个 Steam 账号（留空 = 用当前登录的那个；可填账号名 / 昵称 / SteamID64）。</summary>
    public string SteamAccount { get; set; } = "";

    /// <summary>
    /// 网络通路："" = 直连优先，失败自动找本机 SOCKS5 代理（常见 7890 等）；
    /// "direct" = 只用直连；"socks5://host:port" = 指定代理。
    /// </summary>
    public string SteamProxy { get; set; } = "";

    /// <summary>允许从 Steam 客户端读登录态（cookie 库被锁时会短暂结束 webhelper，Steam 会自动重启它）。</summary>
    public bool SteamSessionFromClient { get; set; } = true;

    /// <summary>Steam 区域（决定计价货币），默认中国大陆。</summary>
    public string SteamCountry { get; set; } = "CN";

    /// <summary>Steam 语言。</summary>
    public string SteamLanguage { get; set; } = "schinese";
}
