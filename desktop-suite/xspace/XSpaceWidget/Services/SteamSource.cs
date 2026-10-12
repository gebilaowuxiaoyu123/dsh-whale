using System.Text.Json;
using XSpaceWidget.Models;

namespace XSpaceWidget.Services;

/// <summary>把 Steam 商店条目 / 购物车条目翻译成信息栏条目（价格 + 折扣 + 优惠政策标签）。</summary>
public static class SteamTagger
{
    /// <summary>Steam 的折扣类型文案（页面里是 #discount_desc_* 的本地化 key）。</summary>
    private static readonly Dictionary<string, string> DiscountTokens = new(StringComparer.OrdinalIgnoreCase)
    {
        ["#discount_desc_preset_special"] = "特惠",
        ["#discount_desc_preset_onsale"] = "特惠",
        ["#discount_desc_preset_weeklongdeals"] = "周间特惠",
        ["#discount_desc_preset_weekend"] = "周末特惠",
        ["#discount_desc_preset_dailydeal"] = "每日特惠",
        ["#discount_desc_preset_franchise"] = "系列特惠",
        ["#discount_desc_preset_publisher"] = "发行商特惠",
        ["#discount_desc_preset_launch"] = "首发特惠",
        ["#discount_desc_preset_vr"] = "VR 特惠",
        ["#discount_desc_preset_steamchina"] = "蒸汽平台特惠",
        ["#discount_desc_preset_ownedelsewhere"] = "其他平台已拥有",
        ["#discount_desc_preset_loyalty"] = "老玩家优惠",
    };

    private static string Str(JsonElement e, string name)
        => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() ?? "" : "";

    private static int Int(JsonElement e, string name)
        => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v)
           && (v.ValueKind == JsonValueKind.Number ? v.TryGetInt32(out int n) : int.TryParse(v.GetString(), out n))
            ? n : 0;

    private static string Price(JsonElement e, string name)
        => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Object
            ? Str(v, "formatted") is { Length: > 0 } f ? f : Str(v, "formatted_amount")
            : "";

    /// <summary>商店条目 → 信息栏条目。</summary>
    public static NoticeItem? FromStoreItem(JsonElement it, bool inCart = false)
    {
        if (it.ValueKind != JsonValueKind.Object) return null;
        if (it.TryGetProperty("success", out var ok) && ok.ValueKind == JsonValueKind.Number && ok.GetInt32() != 1) return null;

        string name = Str(it, "name");
        if (name.Length == 0) return null;
        uint appid = (uint)Int(it, "appid");
        string path = Str(it, "store_url_path");
        string url = path.Length > 0
            ? "https://store.steampowered.com/" + path.TrimStart('/')
            : (appid > 0 ? $"https://store.steampowered.com/app/{appid}/" : "");

        bool hasBpo = it.TryGetProperty("best_purchase_option", out var bpo) && bpo.ValueKind == JsonValueKind.Object;
        string finalText = hasBpo ? Str(bpo, "formatted_final_price") : "";
        string origText = hasBpo ? Str(bpo, "formatted_original_price") : "";
        int cents = hasBpo ? Int(bpo, "final_price_in_cents") : 0;
        int discount = hasBpo ? Int(bpo, "discount_pct") : 0;
        bool hidePct = hasBpo && bpo.TryGetProperty("hide_discount_pct_for_compliance", out var h)
                       && h.ValueKind == JsonValueKind.True;

        // 发行时间（0 / 缺失 = 未发售）
        long release = 0;
        if (it.TryGetProperty("release", out var rel) && rel.ValueKind == JsonValueKind.Object)
            release = Int(rel, "steam_release_date");
        DateTime? releaseDate = release > 100000 ? DateTimeOffset.FromUnixTimeSeconds(release).LocalDateTime : null;
        bool comingSoon = releaseDate.HasValue && releaseDate.Value > DateTime.Now.AddDays(1);

        bool free = cents == 0 && (hasBpo || Str(it, "type").Length > 0) && finalText.Contains('0');
        if (hasBpo && cents == 0) free = true;

        // 特惠类型 + 截止时间
        string dealKind = "";
        DateTime? dealEnd = null;
        if (discount > 0 && hasBpo && bpo.TryGetProperty("active_discounts", out var ads) && ads.ValueKind == JsonValueKind.Array)
        {
            foreach (var ad in ads.EnumerateArray())
            {
                string token = Str(ad, "discount_description");
                if (dealKind.Length == 0)
                    dealKind = DiscountTokens.TryGetValue(token, out string? label) ? label : "特惠";
                long end = Int(ad, "discount_end_date");
                if (end > 100000)
                {
                    var dt = DateTimeOffset.FromUnixTimeSeconds(end).LocalDateTime;
                    if (dealEnd == null || dt > dealEnd) dealEnd = dt;
                }
            }
        }
        if (dealKind.Length == 0 && discount > 0) dealKind = "特惠";

        var item = new NoticeItem
        {
            Title = name,
            ShortTitle = name,
            Url = url,
            Page = 1,
            IsPriceItem = true,
            DiscountPercent = discount,
            PriceText = free ? "免费" : (finalText.Length > 0 ? finalText : "—"),
            OldPriceText = origText,
            Level = dealKind,
        };

        // ---- 标签：折扣力度 → 特惠类型 → 剩余时间 / 捆绑 / 免费 / 未发售 ----
        // 价格那块显示的是「原价（主）+ 折扣价」，折扣百分比就只在标签里出现一次，不会重复
        var tags = new List<NoticeTag>();
        if (discount > 0 && !hidePct) tags.Add(new NoticeTag("pct", $"−{discount}%"));
        if (dealKind.Length > 0) tags.Add(new NoticeTag("deal", dealKind));
        if (free) tags.Add(new NoticeTag("free", "免费"));
        if (dealEnd.HasValue)
        {
            var left = dealEnd.Value - DateTime.Now;
            if (left.TotalHours >= 1)
                tags.Add(new NoticeTag("note", left.TotalDays >= 1 ? $"限期 {Math.Ceiling(left.TotalDays):0} 天" : $"限期 {Math.Ceiling(left.TotalHours):0} 小时"));
        }
        if (hasBpo && bpo.TryGetProperty("bundle_discount_pct", out var bd) && bd.ValueKind == JsonValueKind.Number && bd.GetInt32() > 0)
            tags.Add(new NoticeTag("note", $"捆绑额外 -{bd.GetInt32()}%"));
        if (comingSoon) tags.Add(new NoticeTag("note", "尚未发售"));
        if (!free && (finalText.Length == 0 || finalText == "—")) tags.Add(new NoticeTag("note", "暂无价格"));
        if (discount == 0 && !free && !comingSoon && finalText.Length > 0) tags.Add(new NoticeTag("note", "无折扣"));
        if (inCart) tags.Add(new NoticeTag("note", "已在购物车"));

        item.Tags = tags.Take(4).ToArray();

        // 悬停提示：完整信息
        var tip = new List<string> { name };
        if (dealKind.Length > 0) tip.Add($"{dealKind}　-{discount}%" + (dealEnd.HasValue ? $"（{dealEnd:MM-dd HH:mm} 结束）" : ""));
        else if (!free) tip.Add("当前无折扣");
        if (free) tip.Add("免费游玩");
        if (origText.Length > 0 && discount > 0) tip.Add($"原价 {origText} → 现价 {finalText}");
        if (it.TryGetProperty("basic_info", out var bi) && bi.ValueKind == JsonValueKind.Object)
        {
            string shortDesc = Str(bi, "short_description");
            if (shortDesc.Length > 0) tip.Add(shortDesc.Length > 120 ? shortDesc[..120] + "…" : shortDesc);
            if (bi.TryGetProperty("developers", out var devs) && devs.ValueKind == JsonValueKind.Array)
            {
                var names = devs.EnumerateArray().Select(d => Str(d, "name")).Where(s => s.Length > 0).ToArray();
                if (names.Length > 0) tip.Add("开发商：" + string.Join(" / ", names));
            }
        }
        if (releaseDate.HasValue) tip.Add("发行日期：" + releaseDate.Value.ToString("yyyy-MM-dd"));
        item.Tooltip = string.Join("\n", tip);
        return item;
    }

    /// <summary>购物车行项（拿不到商店条目时兜底）。</summary>
    public static NoticeItem? FromCartLine(JsonElement li, uint id = 0, string kind = "packageid")
    {
        uint appid = li.ValueKind == JsonValueKind.Object ? (uint)Int(li, "appid") : 0;
        if (appid == 0 && kind == "appid") appid = id;
        string name = Str(li, "name");
        if (name.Length == 0) name = Str(li, "package_name");
        if (name.Length == 0) name = Str(li, "bundle_name");
        if (name.Length == 0) name = kind == "appid" ? $"App {id}" : $"礼包 {id}";

        string price = Price(li, "price");
        if (price.Length == 0) price = Price(li, "price_when_added");
        if (price.Length == 0) price = Price(li, "subtotal");
        int discount = Int(li, "discount_pct");
        var item = new NoticeItem
        {
            Title = name,
            ShortTitle = name,
            Url = id > 0 ? $"https://store.steampowered.com/{(kind == "appid" ? "app" : "sub")}/{id}/" : "",
            Page = 1,
            IsPriceItem = true,
            PriceText = price.Length > 0 ? price : "—",
            DiscountPercent = discount,
            Tags = discount > 0
                ? new[] { new NoticeTag("pct", $"−{discount}%"), new NoticeTag("deal", "优惠中") }
                : new[] { new NoticeTag("note", "无折扣") },
            Tooltip = name,
        };
        return item;
    }
}

/// <summary>Steam 愿望单（价格 + 折扣）。</summary>
public sealed class SteamWishlistSource : INoticeSource
{
    private readonly SteamSession _session;

    public SteamWishlistSource(SteamSession session) => _session = session;

    public string Title => "Steam 愿望单";
    public string Key => "steam-wishlist";
    public bool SupportsPaging => false;
    public string Unit => "款";
    public string EmptyHint => "愿望单是空的\n可以在 Steam 商城把游戏加入愿望单";
    public double SlotWidth => 60;
    public bool EmptyIsOk => true;

    public async Task<IReadOnlyList<NoticeItem>> FetchAsync(int page, CancellationToken ct = default)
    {
        if (!await _session.EnsureSessionAsync(false, ct))
            throw new InvalidOperationException(_session.LastError ?? "Steam 登录态不可用");
        if (!await _session.EnsureWapitAsync(false, ct))
            throw new InvalidOperationException(_session.LastError ?? "无法获取 Steam API 令牌");

        var wish = await _session.GetWishlistAsync(ct);
        if (wish.Count == 0) return Array.Empty<NoticeItem>();

        var storeItems = await _session.GetStoreItemsAsync(wish.Select(w => w.AppId).ToList(), ct);
        var added = wish.ToDictionary(w => w.AppId, w => w.DateAdded);

        var list = new List<NoticeItem>();
        foreach (var si in storeItems)
        {
            var item = SteamTagger.FromStoreItem(si);
            if (item == null) continue;
            if (si.TryGetProperty("appid", out var a) && added.TryGetValue(a.GetUInt32(), out long ts) && ts > 0)
            {
                item.Date = DateTimeOffset.FromUnixTimeSeconds(ts).LocalDateTime.ToString("yyyy-MM-dd");
                item.Source = "愿望单";
            }
            list.Add(item);
        }

        // 打折最狠的排前面，同等折扣按加入时间从新到旧
        list.Sort((a, b) =>
        {
            int c = b.DiscountPercent.CompareTo(a.DiscountPercent);
            return c != 0 ? c : string.CompareOrdinal(b.Date, a.Date);
        });
        return list;
    }

    public Task<int> GetMaxPageAsync(CancellationToken ct = default) => Task.FromResult(1);
}

/// <summary>Steam 购物车（价格 + 折扣）。</summary>
public sealed class SteamCartSource : INoticeSource
{
    private readonly SteamSession _session;

    public SteamCartSource(SteamSession session) => _session = session;

    public string Title => "Steam 购物车";
    public string Key => "steam-cart";
    public bool SupportsPaging => false;
    public string Unit => "款";
    public string EmptyHint => "购物车是空的\n在 Steam 商城/客户端里加几款游戏就会出现在这里";
    public double SlotWidth => 60;
    public bool EmptyIsOk => true;

    public async Task<IReadOnlyList<NoticeItem>> FetchAsync(int page, CancellationToken ct = default)
    {
        if (!await _session.EnsureSessionAsync(false, ct))
            throw new InvalidOperationException(_session.LastError ?? "Steam 登录态不可用");
        if (!await _session.EnsureWapitAsync(false, ct))
            throw new InvalidOperationException(_session.LastError ?? "无法获取 Steam API 令牌");

        var cart = await _session.GetCartAsync(ct);
        if (cart == null || !cart.Value.TryGetProperty("line_items", out var lines)
            || lines.ValueKind != JsonValueKind.Array || lines.GetArrayLength() == 0)
            return Array.Empty<NoticeItem>();

        // 购物车行项只有 packageid（没有 appid），要用商店条目补齐名字/价格/折扣
        var ids = new List<(string Kind, uint Id)>();
        foreach (var li in lines.EnumerateArray())
        {
            if (li.TryGetProperty("packageid", out var pk) && pk.ValueKind == JsonValueKind.Number && pk.GetUInt32() > 0)
                ids.Add(("packageid", pk.GetUInt32()));
            else if (li.TryGetProperty("bundleid", out var bu) && bu.ValueKind == JsonValueKind.Number && bu.GetUInt32() > 0)
                ids.Add(("bundleid", bu.GetUInt32()));
            else if (li.TryGetProperty("appid", out var ap) && ap.ValueKind == JsonValueKind.Number && ap.GetUInt32() > 0)
                ids.Add(("appid", ap.GetUInt32()));
        }

        var byId = new Dictionary<uint, JsonElement>();
        if (ids.Count > 0)
        {
            foreach (var si in await _session.GetStoreItemsAsync(ids, ct))
            {
                if (si.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number)
                    byId[idEl.GetUInt32()] = si;
            }
        }

        var list = new List<NoticeItem>();
        foreach (var (kind, id) in ids)
        {
            NoticeItem? item = byId.TryGetValue(id, out var si2)
                ? SteamTagger.FromStoreItem(si2)
                : null;
            if (item == null) item = SteamTagger.FromCartLine(default, id, kind);
            if (item != null) list.Add(item);
        }
        return list;
    }

    public Task<int> GetMaxPageAsync(CancellationToken ct = default) => Task.FromResult(1);
}
