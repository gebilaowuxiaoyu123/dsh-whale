using XSpaceWidget.Models;

namespace XSpaceWidget.Services;

/// <summary>信息栏状态种类（状态点 / 状态栏配色）。</summary>
public enum StatusKind { Loading, Ok, Warn, Error }

/// <summary>一列信息栏的数据来源。</summary>
public interface INoticeSource
{
    /// <summary>列标题。</summary>
    string Title { get; }

    /// <summary>数据源标识：变化时才需要重新装配列（装配会清空列表）。</summary>
    string Key { get; }

    /// <summary>是否支持分页（不支持时只有第一页）。</summary>
    bool SupportsPaging { get; }

    /// <summary>数量的量词（"条" / "款"），用于列头"共 N 条"。</summary>
    string Unit => "条";

    /// <summary>抓到空列表时展示的提示（空 ≠ 出错）。</summary>
    string EmptyHint => "未获取到内容\n请检查网址是否正确、页面是否可访问";

    /// <summary>左侧槽位宽度（日期 46；价格需要更宽）。</summary>
    double SlotWidth => 46;

    /// <summary>空列表是否属于正常情况（如空的购物车）。</summary>
    bool EmptyIsOk => false;

    /// <summary>抓取指定页（page 从 1 开始）。</summary>
    Task<IReadOnlyList<NoticeItem>> FetchAsync(int page, CancellationToken ct = default);

    /// <summary>获取总页数。</summary>
    Task<int> GetMaxPageAsync(CancellationToken ct = default);
}

/// <summary>X·Space 创客空间联盟竞赛通知（目标站点有动态防护，走隐藏 WebView2）。</summary>
public sealed class XSpaceSource : INoticeSource
{
    private readonly FetcherService _fetcher;

    public XSpaceSource(FetcherService fetcher) => _fetcher = fetcher;

    public string Title => "XSpace 竞赛通知";
    public string Key => "xspace";
    public bool SupportsPaging => true;

    public async Task<IReadOnlyList<NoticeItem>> FetchAsync(int page, CancellationToken ct = default)
        => await _fetcher.FetchPageAsync(page, ct);

    public async Task<int> GetMaxPageAsync(CancellationToken ct = default)
    {
        try { return Math.Max(1, await _fetcher.GetLastPageAsync()); }
        catch { return 1; }
    }
}

/// <summary>任意网页（通用抓取，支持分页控件翻页）。</summary>
public sealed class GenericSource : INoticeSource
{
    /// <summary>翻页上限（防止在“看似有分页但永远有新内容”的页面上无限翻）。</summary>
    private const int MaxPages = 30;

    private readonly FetcherService _fetcher;
    private readonly int _limit;

    public GenericSource(FetcherService fetcher, string url, string title, int limit = 200)
    {
        _fetcher = fetcher;
        Url = (url ?? "").Trim();
        _limit = limit;
        Title = string.IsNullOrWhiteSpace(title) ? "自定义信息栏" : title.Trim();
    }

    public string Title { get; }

    /// <summary>监控网址。</summary>
    public string Url { get; }

    public string Key => "generic|" + Url + "|" + Title;

    /// <summary>通用网页支持翻页：页面有分页控件时能一直往下加载。</summary>
    public bool SupportsPaging => true;

    public async Task<IReadOnlyList<NoticeItem>> FetchAsync(int page, CancellationToken ct = default)
    {
        if (Url.Length == 0 || page < 1 || page > MaxPages) return Array.Empty<NoticeItem>();
        return await _fetcher.FetchGenericAsync(Url, _limit, page, ct);
    }

    public Task<int> GetMaxPageAsync(CancellationToken ct = default)
        => Task.FromResult(Math.Max(1, _fetcher.LastGenericMaxPage));
}
