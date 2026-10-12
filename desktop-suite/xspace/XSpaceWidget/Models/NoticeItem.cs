namespace XSpaceWidget.Models;

/// <summary>信息栏里的胶囊标签（Kind 用于上色：form / level / category / team）。</summary>
public sealed class NoticeTag
{
    public NoticeTag(string kind, string text)
    {
        Kind = kind;
        Text = text;
    }

    public string Kind { get; }
    public string Text { get; }
}

/// <summary>一条竞赛通知。</summary>
public class NoticeItem
{
    /// <summary>标题。</summary>
    public string Title { get; set; } = "";

    /// <summary>文章绝对链接。</summary>
    public string Url { get; set; } = "";

    /// <summary>发布日期 yyyy-MM-dd，可能为空。</summary>
    public string Date { get; set; } = "";

    /// <summary>来源 / 发布单位（如有）。</summary>
    public string Source { get; set; } = "";

    /// <summary>来自列表的第几页。</summary>
    public int Page { get; set; } = 1;

    /// <summary>报名/参赛状态（如"正在报名"、"已结束"）；普通网页为空。</summary>
    public string Status { get; set; } = "";

    /// <summary>距离报名截止的天数；-1 表示未知。</summary>
    public int DaysLeft { get; set; } = -1;

    /// <summary>报名截止日期 yyyy-MM-dd（如有）。</summary>
    public string Deadline { get; set; } = "";

    /// <summary>竞赛级别（全国性 / 省级 / 校级 / 国际级 …）；未知为空。</summary>
    public string Level { get; set; } = "";

    /// <summary>类别标签（数学建模 / 程序设计 / 外语 …），按标题关键词推断。</summary>
    public string Category { get; set; } = "";

    /// <summary>人数标签（个人赛 / 团队赛）；未知为空。</summary>
    public string Team { get; set; } = "";

    /// <summary>去掉榜单序号 / 【…】前缀的短标题（列表里显示用）。</summary>
    public string ShortTitle { get; set; } = "";

    /// <summary>热度排名（赛氪的 TOP n）；0 表示无。</summary>
    public int TopRank { get; set; }

    /// <summary>参赛形式（线上考试 / 提交论文 / PPT路演 / 提交作品 …）；推断不出来则为空。</summary>
    public string Form { get; set; } = "";

    /// <summary>列表里显示的胶囊标签：形式 → 级别 → 类别 → 人数（有值的才显示，最多 3 个）。</summary>
    public NoticeTag[] Tags { get; set; } = Array.Empty<NoticeTag>();

    // ================= 价格栏（Steam 游戏）用 =================

    /// <summary>是否价格条目（价格栏）：为真时左侧显示价格而不是日期。</summary>
    public bool IsPriceItem { get; set; }

    /// <summary>现价大字（如 "¥18.32"）。</summary>
    public string PriceText { get; set; } = "";

    /// <summary>原价（如 "¥22.90"）：有折扣时作为次要信息（小字 + 划线）显示在折扣价下方。</summary>
    public string OldPriceText { get; set; } = "";

    /// <summary>折扣百分比（0 = 无折扣）。</summary>
    public int DiscountPercent { get; set; }

    /// <summary>是否有折扣（列表用于把折扣价文字变绿加粗）。</summary>
    public bool HasDiscount => DiscountPercent > 0;

    /// <summary>悬停提示（为空时用 Title）。</summary>
    public string Tooltip { get; set; } = "";

    /// <summary>展示用日期：报名类列表优先显示"报名截止"日期。</summary>
    public string DisplayDate => string.IsNullOrEmpty(Deadline) ? Date : Deadline;

    /// <summary>MM-dd，用于信息栏左侧显示；若日期只有 MM-dd 则原样显示。</summary>
    public string MonthDay => DisplayDate.Length >= 10 ? DisplayDate[5..10] : DisplayDate;

    /// <summary>yyyy，用于信息栏左侧年份。</summary>
    public string Year => DisplayDate.Length >= 10 ? DisplayDate[..4] : "";

    /// <summary>日期块第二行：报名类列表显示剩余天数，否则显示年份。</summary>
    public string SubText => DaysLeft >= 0 ? $"剩 {DaysLeft} 天" : Year;

    /// <summary>左侧大字：价格条目以**折扣价（现价）**为主，否则显示日期。</summary>
    public string SlotTopText => IsPriceItem ? PriceText : MonthDay;

    /// <summary>左侧小字：有原价时在折扣价下方用小字划线标出原价；没折扣时提示"无折扣"。</summary>
    public string SlotBottomText => !IsPriceItem ? SubText
        : HasDiscount && OldPriceText.Length > 0 ? OldPriceText
        : "无折扣";

    /// <summary>悬停提示文字。</summary>
    public string TooltipText => Tooltip.Length > 0 ? Tooltip : Title;

    /// <summary>完整日期，无则为 —。</summary>
    public string DateText => string.IsNullOrEmpty(DisplayDate) ? "—" : DisplayDate;
}
