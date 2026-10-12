using System.Text.RegularExpressions;
using XSpaceWidget.Models;

namespace XSpaceWidget.Services;

/// <summary>
/// 给通知补上"小标签"：级别 / 类别 / 人数，并把标题缩短（去掉榜单序号、"【…】"前缀）。
/// 类别词表参考赛氪竞赛广场的官方分类（数学建模 / 程序设计 / 机器人 / 外语 …），顺序从具体到宽泛。
/// </summary>
public static class NoticeTagger
{
    private static readonly Regex RankPrefix =
        new(@"^\s*TOP\s*\d+\s*", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex BracketPrefix =
        new(@"^\s*(?:【[^】]{0,30}】\s*)+", RegexOptions.Compiled);

    private static readonly Regex LeadWords =
        new(@"^\s*关于\s*(?:举办|组织|开展|做好|举行|申报|评选|征集|印发)?\s*", RegexOptions.Compiled);

    private static readonly Regex TailWords =
        new(@"\s*(?:的通知|的公告|通知|公告)\s*$", RegexOptions.Compiled);

    /// <summary>榜单排名（赛氪的 "TOP 41"）。</summary>
    private static readonly Regex TopRankRe =
        new(@"TOP\s*(\d+)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly (string[] Keys, string Name)[] Categories =
    {
        (new[] { "数学建模", "建模" }, "数学建模"),
        (new[] { "人工智能", "大模型", "智能体", "机器学习", "深度学习" }, "人工智能"),
        (new[] { "大数据", "数据分析", "数据挖掘" }, "大数据"),
        (new[] { "程序设计", "编程", "算法", "代码", "软件", "信息技术", "计算机", "网络安全", "信息安全" }, "程序设计"),
        (new[] { "机器人", "机械", "车辆", "汽车", "无人机", "飞行器", "航空", "航天", "船舶", "工程训练" }, "机械与机器人"),
        (new[] { "电子设计", "嵌入式", "芯片", "集成电路", "FPGA", "自动化" }, "电子电气"),
        (new[] { "数学竞赛", "数学" }, "数学"),
        (new[] { "物理" }, "物理"),
        (new[] { "化学", "化工", "材料" }, "化学材料"),
        (new[] { "土木", "建筑", "结构", "测绘", "桥梁" }, "土木建筑"),
        (new[] { "环境", "能源", "环保", "低碳", "绿色" }, "环境能源"),
        (new[] { "医学", "健康", "生物", "生命", "药学" }, "医学健康"),
        (new[] { "英语", "外语", "翻译", "词汇", "日语", "口语" }, "外语"),
        (new[] { "演讲", "辩论", "主持", "朗读" }, "演讲辩论"),
        (new[] { "创业", "创新", "挑战杯", "互联网+" }, "创新创业"),
        (new[] { "商业", "金融", "经济", "会计", "营销", "商务", "工商管理", "审计" }, "商业管理"),
        (new[] { "设计", "创意", "艺术", "绘画", "摄影", "服装", "音乐", "书画", "广告" }, "设计艺术"),
        (new[] { "电竞", "电子竞技" }, "电子竞技"),
        (new[] { "体育", "运动", "健身", "田径" }, "体育"),
        (new[] { "技能", "实训", "就业", "职业", "办公" }, "职业技能"),
        (new[] { "案例", "公共", "调研", "社会", "公益", "志愿", "环保" }, "综合"),
    };

    /// <summary>参赛形式（“要干嘛”）：先按标题关键词判断；名字尽量短（2-4 字）。</summary>
    private static readonly (string[] Keys, string Name)[] Forms =
    {
        (new[] { "路演", "答辩", "汇报", "宣讲", "展演" }, "路演"),
        (new[] { "计划书", "商业计划", "创业计划", "策划书" }, "计划书"),
        (new[] { "论文", "征文", "学术", "综述" }, "论文"),
        (new[] { "调研", "报告", "方案", "案例" }, "报告"),
        (new[] { "考试", "测评", "答题", "测试", "测验" }, "线上考试"),
        (new[] { "词汇", "翻译", "写作", "听力", "口语", "阅读" }, "线上考试"),
        (new[] { "演讲", "朗读", "朗诵", "辩论", "主持" }, "演讲"),
        (new[] { "实操", "实训", "操作", "焊接", "装调" }, "实操"),
        (new[] { "编程", "代码", "算法", "软件开发" }, "代码"),
        (new[] { "作品", "实物", "模型", "制作", "创意", "绘画", "摄影", "海报", "视频" }, "作品"),
        (new[] { "设计" }, "作品"),
    };

    /// <summary>类别 → 常见参赛形式（标题没线索时兜底）。</summary>
    private static readonly Dictionary<string, string> FormByCategory = new()
    {
        ["数学建模"] = "论文",
        ["数学"] = "笔试",
        ["物理"] = "笔试",
        ["化学材料"] = "笔试",
        ["外语"] = "线上考试",
        ["程序设计"] = "代码",
        ["人工智能"] = "作品",
        ["大数据"] = "作品",
        ["机械与机器人"] = "作品",
        ["电子电气"] = "作品",
        ["创新创业"] = "计划书",
        ["商业管理"] = "报告",
        ["设计艺术"] = "作品",
        ["医学健康"] = "实操",
        ["职业技能"] = "实操",
        ["演讲辩论"] = "演讲",
        ["电子竞技"] = "线上赛",
        ["体育"] = "现场赛",
    };

    // 具体的排在前面：同一标题里既有“全国”又有“省/校”时，按更小的范围标注
    private static readonly (string Key, string Name)[] Levels =
    {
        ("国际", "国际级"), ("全球", "国际级"), ("亚洲", "国际级"),
        ("校级", "校级"), ("校赛", "校级"), ("校内", "校级"),
        ("江苏省", "省级"), ("省赛", "省级"), ("省级", "省级"), ("赛区", "省级"), ("区域", "省级"),
        ("全国", "全国性"), ("国家", "全国性"), ("中国", "全国性"),
    };

    private static readonly (string Key, string Name)[] Teams =
    {
        ("个人", "个人赛"), ("单人", "个人赛"),
        ("团队", "团队赛"), ("团体", "团队赛"), ("小组", "团队赛"), ("组队", "团队赛"),
    };

    /// <summary>类别 → 公认赛制（只在标题没写时用来兜底，尽量不做猜测）。</summary>
    private static readonly Dictionary<string, string> TeamByCategory = new()
    {
        ["数学建模"] = "团队赛",
        ["创新创业"] = "团队赛",
        ["机械与机器人"] = "团队赛",
        ["电子电气"] = "团队赛",
        ["数学"] = "个人赛",
        ["外语"] = "个人赛",
        ["演讲辩论"] = "个人赛",
    };

    /// <summary>为一条通知补齐短标题与标签。</summary>
    public static void Apply(NoticeItem item)
    {
        item.ShortTitle = Shorten(item.Title);

        var top = TopRankRe.Match(item.Title ?? "");
        if (top.Success && int.TryParse(top.Groups[1].Value, out int rank)) item.TopRank = rank;

        string text = item.Title + " " + item.Category + " " + item.Level + " " + item.Team;
        if (string.IsNullOrEmpty(item.Category)) item.Category = MatchAny(text, Categories);
        if (string.IsNullOrEmpty(item.Form))
        {
            item.Form = MatchAny(item.Title, Forms);
            if (item.Form.Length == 0 && FormByCategory.TryGetValue(item.Category, out var form))
                item.Form = form;
        }
        if (string.IsNullOrEmpty(item.Team))
        {
            item.Team = MatchOne(text, Teams);
            // 标题没写赛制时，只对“必定组队”的类别兜底（不做过度猜测）
            if (item.Team.Length == 0 && TeamByCategory.TryGetValue(item.Category, out var team))
                item.Team = team;
        }
        if (string.IsNullOrEmpty(item.Level)) item.Level = MatchOne(text, Levels);

        item.Tags = BuildTags(item);
    }

    /// <summary>去掉 "TOP 12" / "【…】" 之类前缀；剥得太短就保持原样。</summary>
    public static string Shorten(string? title)
    {
        string s = (title ?? "").Trim();
        if (s.Length == 0) return "";

        string t = BracketPrefix.Replace(RankPrefix.Replace(s, ""), "").Trim();
        t = LeadWords.Replace(t, "").Trim();      // “关于举办…”
        t = TailWords.Replace(t, "").Trim();      // “…的通知”
        return t.Length >= 4 ? t : s;
    }

    private static string MatchAny(string text, (string[] Keys, string Name)[] table)
    {
        foreach (var (keys, name) in table)
            foreach (var k in keys)
                if (text.Contains(k, StringComparison.Ordinal)) return name;
        return "";
    }

    private static string MatchOne(string text, (string Key, string Name)[] table)
    {
        foreach (var (key, name) in table)
            if (text.Contains(key, StringComparison.Ordinal)) return name;
        return "";
    }

    /// <summary>显示用的标签：形式 → 级别 → 类别 → 人数，最多 3 个（“要干嘛”最关键，放最前）。</summary>
    private static NoticeTag[] BuildTags(NoticeItem item)
    {
        var list = new List<NoticeTag>(3);
        Add("top", item.TopRank > 0 ? $"TOP {item.TopRank}" : "");
        Add("form", item.Form);
        Add("level", item.Level);
        Add("category", item.Category);
        Add("team", item.Team);
        return list.ToArray();

        void Add(string kind, string s)
        {
            if (string.IsNullOrWhiteSpace(s) || list.Count >= 3) return;
            if (list.Exists(t => t.Text == s)) return;
            list.Add(new NoticeTag(kind, s));
        }
    }
}
