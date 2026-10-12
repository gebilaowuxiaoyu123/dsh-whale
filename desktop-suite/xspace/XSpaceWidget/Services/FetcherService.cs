using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using XSpaceWidget.Models;

namespace XSpaceWidget.Services;

/// <summary>
/// 通过隐藏的 WebView2（Edge 内核）抓取 X·Space 竞赛通知列表。
/// 目标站点使用"瑞数"动态防护，必须用真实浏览器内核执行 JS 才能拿到数据。
/// </summary>
public class FetcherService : IDisposable
{
    public const string BaseUrl = "https://xspace.njust.edu.cn";
    public const string ListPage1 = BaseUrl + "/14263/list.htm";

    private FetcherWindow? _host;
    private CoreWebView2? _wv;
    private bool _disposed;
    private readonly SemaphoreSlim _lock = new(1, 1);

    /// <summary>WebView2 是否初始化成功。</summary>
    public bool IsReady { get; private set; }

    /// <summary>初始化失败原因（供 UI 提示）。</summary>
    public string? InitError { get; private set; }

    /// <summary>初始化隐藏浏览器窗口并预热一次（解决瑞数挑战、缓存 Cookie）。</summary>
    public async Task InitializeAsync()
    {
        if (IsReady) return;
        try
        {
            _host = new FetcherWindow();
            _host.Show();
            await _host.InitWebViewAsync();
            _wv = _host.Web.CoreWebView2;
            if (_wv == null) throw new InvalidOperationException("WebView2 初始化失败");
            _wv.Settings.AreDefaultContextMenusEnabled = false;
            _wv.Settings.AreDevToolsEnabled = false;
            _wv.Settings.IsStatusBarEnabled = false;

            // 预热：抓第一页，解决挑战并缓存会话
            await NavigateAndWaitAsync(ListPage1, 30000);
            IsReady = true;
        }
        catch (Exception ex)
        {
            InitError = ex.Message;
            IsReady = false;
        }
    }

    /// <summary>抓取指定页的竞赛通知（每页约 14 条，从新到旧）。</summary>
    public async Task<List<NoticeItem>> FetchPageAsync(int page, CancellationToken ct = default)
    {
        if (!IsReady) throw new InvalidOperationException("抓取器尚未就绪");
        await _lock.WaitAsync(ct);
        try
        {
            string url = page <= 1 ? ListPage1 : $"{BaseUrl}/14263/list{page}.htm";
            string json = await NavigateAndWaitAsync(url, 25000, ct);
            var list = ParseItems(json, page);
            return list;
        }
        finally { _lock.Release(); }
    }

    /// <summary>获取列表总页数（从分页"尾页"链接解析）。</summary>
    public async Task<int> GetLastPageAsync()
    {
        if (!IsReady) return 29;
        try
        {
            var r = await _wv!.ExecuteScriptAsync(
                "Math.max.apply(null, Array.from(document.querySelectorAll('a[href]')).map(function(a){var m=a.href.match(/list(\\d+)\\.htm$/); return m?parseInt(m[1]):0;}).concat([1]))");
            if (int.TryParse(r?.Trim('"'), out int n) && n >= 1) return n;
        }
        catch { }
        return 29;
    }

    /// <summary>最近一次通用抓取看到的列表总页数（从分页控件读，读不到为 1）。</summary>
    public int LastGenericMaxPage { get; private set; } = 1;

    private string _genericUrl = "";     // 当前 WebView2 里的通用页面（用于判断能否原地翻页）
    private int _genericPage;            // 该页面目前停在第几页

    /// <summary>
    /// 通用网页抓取：加载指定 URL / 或在同一页面上翻页，提取列表项，返回标题、链接、日期等。
    /// page &gt; 1 时优先"原地点击分页控件翻页"（保持站点排序与会话），失败则重新导航。
    /// </summary>
    public async Task<List<NoticeItem>> FetchGenericAsync(string url, int limit = 200, int page = 1, CancellationToken ct = default)
    {
        if (!IsReady) throw new InvalidOperationException("抓取器尚未就绪");
        if (string.IsNullOrWhiteSpace(url)) return new List<NoticeItem>();
        if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            && !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            url = "https://" + url;

        await _lock.WaitAsync(ct);
        try
        {
            var wv = _wv!;
            string json;

            bool onSameUrl = _genericUrl == url && await IsOnUrlAsync(wv, url);
            if (!onSameUrl || _genericPage > page)
            {
                // 页面不在目标 URL 上（左栏抓取会把页面导航走）或需要往回走：重新导航 + 切排序
                json = await NavigateAndWaitStableAsync(url, 25000, ct);
                _genericUrl = url;
                _genericPage = 1;
            }
            else
            {
                json = await wv.ExecuteScriptAsync(ExtractGenericJs);
            }

            // 从当前页顺序翻到目标页
            while (_genericPage < page)
            {
                if (!await ClickNextPageAsync(wv, ct)) return new List<NoticeItem>();
                await WaitForStableAsync(wv, 12000, ct);
                _genericPage++;
                json = await wv.ExecuteScriptAsync(ExtractGenericJs);
            }

            var list = ParseGenericItems(json);
            return list.Take(Math.Max(1, limit)).ToList();
        }
        finally { _lock.Release(); }
    }

    /// <summary>当前 WebView2 是否停在指定 URL 上（比较 host + path）。</summary>
    private static async Task<bool> IsOnUrlAsync(CoreWebView2 wv, string url)
    {
        try
        {
            var cur = (await wv.ExecuteScriptAsync("location.href"))?.Trim('"') ?? "";
            if (cur.Length == 0) return false;
            var a = new Uri(cur);
            var b = new Uri(url);
            return string.Equals(a.Host, b.Host, StringComparison.OrdinalIgnoreCase)
                && string.Equals(a.AbsolutePath.TrimEnd('/'), b.AbsolutePath.TrimEnd('/'), StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    /// <summary>点击分页控件的"下一页"/下一页码；点不到返回 false。</summary>
    private async Task<bool> ClickNextPageAsync(CoreWebView2 wv, CancellationToken ct)
    {
        try
        {
            var r = await wv.ExecuteScriptAsync(ClickNextPageJs);
            return r?.Trim('"').StartsWith("ok", StringComparison.Ordinal) == true;
        }
        catch { return false; }
    }

    // ---------- 内部实现 ----------

    private Task<string> NavigateAndWaitAsync(string url, int timeoutMs, CancellationToken ct = default)
        => NavigateAndWaitAsync(url, timeoutMs, ct, "li.news", ExtractJs);

    /// <summary>
    /// 通用网页等待：SPA 页面（如赛氪）先渲染骨架、再异步填列表，只等某个选择器出现会抓到空壳。
    /// 这里改为等"页面签名"连续多次不变（链接数 + 正文字数），并保证至少等 1.2 秒。
    /// </summary>
    private async Task<string> NavigateAndWaitStableAsync(string url, int timeoutMs, CancellationToken ct)
    {
        var wv = _wv ?? throw new InvalidOperationException("WebView2 未初始化");
        wv.Navigate(url);
        await WaitForStableAsync(wv, timeoutMs, ct);

        // 竞赛/资讯站常默认按"报名时间"排；这里若页面提供"最近更新"这类排序按钮就先切过去，
        // 让列表按更新时间从新到旧，再等一次内容稳定。
        try
        {
            var r = await wv.ExecuteScriptAsync(SortHintJs);
            if (r?.Trim('"').StartsWith("clicked", StringComparison.Ordinal) == true)
                await WaitForStableAsync(wv, 12000, ct);
        }
        catch { /* 点不到就算了，保持站点默认顺序 */ }

        // 记录列表总页数（供 UI 显示页码、限制翻页上限）
        try
        {
            var mp = await wv.ExecuteScriptAsync(PagerInfoJs);
            LastGenericMaxPage = int.TryParse(mp?.Trim('"'), out int n) && n > 1 ? n : 1;
        }
        catch { LastGenericMaxPage = 1; }

        return await wv.ExecuteScriptAsync(ExtractGenericJs);
    }

    /// <summary>等页面"签名"（链接数 + 正文字数）连续多次不变，认为内容已渲染完。</summary>
    private async Task WaitForStableAsync(CoreWebView2 wv, int timeoutMs, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        string last = "";
        int stable = 0;
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            ct.ThrowIfCancellationRequested();
            await Task.Delay(250, ct);

            string sig;
            try { sig = await wv.ExecuteScriptAsync(SignatureJs); }
            catch { continue; }   // 页面导航中，稍后重试

            sig = sig?.Trim('"') ?? "";
            if (sig.Length > 0 && sig == last) stable++;
            else stable = 0;
            last = sig;

            bool settled = sw.ElapsedMilliseconds >= 1200 && stable >= 3;
            bool giveUp = sw.ElapsedMilliseconds >= 9000 && stable >= 1;
            if (settled || giveUp) break;
        }
    }

    /// <summary>页面签名：链接数 + 正文字数，用于判断内容是否已渲染完。</summary>
    private const string SignatureJs = """
        (function(){
          try {
            var n = document.querySelectorAll('a[href]').length;
            var t = document.body ? (document.body.innerText || '').length : 0;
            return n + ':' + t;
          } catch (e) { return ''; }
        })();
        """;

    /// <summary>
    /// 尝试点击"最近更新/更新时间"这类排序按钮（按更新时间排）。
    /// 只点"按钮组里的叶子控件"，且要求它自身不跳转，避免误点导航链接。
    /// </summary>
    private const string SortHintJs = """
        (function(){
          var words = ['最近更新', '更新时间', '最新更新'];
          var els = document.querySelectorAll('div, span, li, a, button');
          for (var i = 0; i < els.length; i++){
            var el = els[i];
            var t = (el.innerText || el.textContent || '').trim();
            if (words.indexOf(t) < 0) continue;
            if (el.querySelector('a, button, div')) continue;      // 只点叶子小控件
            var par = el.parentElement;
            if (!par || par.children.length < 2) continue;         // 必须是按钮组里的一员
            var href = (el.getAttribute && el.getAttribute('href')) || '';
            if (href && href.indexOf('javascript') !== 0 && href !== '#') continue;
            el.click();
            return 'clicked:' + t;
          }
          return '';
        })();
        """;

    /// <summary>点击分页控件的"下一页"/下一页码（兼容 Element-UI 等常见结构）；点不到返回空。</summary>
    private const string ClickNextPageJs = """
        (function(){
          try {
            var pager = document.querySelector('.el-pager, .el-pagination .el-pager, .pagination, .pager');
            var items = pager ? Array.prototype.slice.call(pager.querySelectorAll('li.number, li')) : [];
            var active = null;
            for (var i = 0; i < items.length; i++){
              if (/is-active|active/.test(items[i].className || '')) { active = items[i]; break; }
            }
            var cur = active ? parseInt((active.innerText || '').trim(), 10) : 0;

            // 1) 明确的"下一页"按钮
            var next = document.querySelector('.btn-next, button[aria-label="下一页"], a[aria-label="下一页"], [aria-label="Next"]');
            if (next && !next.disabled && !/disabled/.test(next.className || '')) { next.click(); return 'ok:next-btn'; }

            // 2) 直接点页码 = 当前页 + 1
            for (var j = 0; j < items.length; j++){
              var v = parseInt((items[j].innerText || '').trim(), 10);
              if (!isNaN(v) && cur > 0 && v === cur + 1) { items[j].click(); return 'ok:page-' + v; }
            }

            // 3) 文本就是"下一页"的可点元素
            var all = document.querySelectorAll('a, button, li, span, div');
            for (var k = 0; k < all.length; k++){
              var t = (all[k].innerText || '').trim();
              if (t === '下一页' || t === '下一页>' || t === '下一页>>' || t === 'Next') {
                all[k].click();
                return 'ok:text-next';
              }
            }
            return '';
          } catch (e) { return ''; }
        })();
        """;

    /// <summary>读分页控件里的最大页码（Element-UI 会显示最后一页）作为总页数。</summary>
    private const string PagerInfoJs = """
        (function(){
          try {
            var nodes = document.querySelectorAll('.el-pager li.number, .el-pagination li.number, .pagination li a, .pager li a');
            var max = 0;
            for (var i = 0; i < nodes.length; i++){
              var v = parseInt((nodes[i].innerText || '').trim(), 10);
              if (!isNaN(v) && v > max) max = v;
            }
            if (max > 1) return max;
            var m = (document.body ? (document.body.innerText || '') : '').match(/(\d+)\s*\/\s*(\d+)\s*页/);
            return m ? parseInt(m[2], 10) : 1;
          } catch (e) { return 1; }
        })();
        """;

    private async Task<string> NavigateAndWaitAsync(string url, int timeoutMs, CancellationToken ct, string waitSelector, string extractScript)
    {
        if (_wv == null) throw new InvalidOperationException("WebView2 未初始化");
        _wv.Navigate(url);

        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            ct.ThrowIfCancellationRequested();
            await Task.Delay(250, ct);
            try
            {
                var r = await _wv.ExecuteScriptAsync($"document.querySelectorAll('{waitSelector}').length");
                if (int.TryParse(r?.Trim('"'), out int n) && n > 0)
                    break; // 列表已渲染
            }
            catch { /* 页面导航中，稍后重试 */ }
        }

        // 提取列表
        string json = await _wv.ExecuteScriptAsync(extractScript);
        return json;
    }

    private const string ExtractJs = """
        (function(){
          var out = [];
          var nodes = document.querySelectorAll('li.news');
          for (var i = 0; i < nodes.length; i++){
            var li = nodes[i];
            var a = li.querySelector('a');
            var m = li.querySelector('.news_meta, .news_date, span[class*=date], span[class*=meta], .date');
            out.push({
              title: a ? (a.getAttribute('title') || a.innerText || '') : '',
              url: a ? a.href : '',
              meta: m ? m.innerText.replace(/\s+/g, ' ').trim() : ''
            });
          }
          return out;
        })();
        """;

    /// <summary>
    /// 通用网页提取：先按"条目容器"结构化抽取（内容卡片 / li / dd / tr），
    /// 再退化为"取所有链接"；过滤导航/页脚/操作按钮，尽量提取日期。
    /// </summary>
    private const string ExtractGenericJs = """
        (function(){
          var out = [];
          var seen = {};
          var skipSel = 'nav, header, footer, .nav, .nav-submenu, .menu, .header, .footer, .pagination, .breadcrumb, .crumbs, .el-pager, .side, .sidebar, .login, .register, .searchbar';
          var navWords = /^(网站首页|首页|联盟简介|关于我们|关于本站|关于本网|更多|联系我们|登录|注册|返回|上一页|下一页|尾页|Home|About|Contact|More|Introduction|News|Notice|简介|欢迎|请输入|用户名|密码|查看详情|详情|立即报名|我要报名|报名|参赛|收藏|分享|下载|查看|点击|京ICP|京公网)/i;
          var itemSels = ['div[class*="item"]', 'div[class*="card"]', 'li', 'dd', 'tr', 'div[class*="news"]'];

          function textOf(el){ return (el.innerText || el.textContent || '').replace(/[ \t\u00A0]+/g, ' ').trim(); }
          function dateOf(t){
            var m = t.match(/(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
            if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
            m = t.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
            if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
            m = t.match(/(\d{1,2})[-\/.](\d{1,2})/);
            if (m) return ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
            return '';
          }
          // 报名/参赛状态：状态通常是独立的短标签（"正在报名"/"比赛进行中"/"比赛结束"），
          // 用短文本精确匹配，避免把"比赛时间待定"里的"待定"当成报名状态
          var statusWords = ['正在报名', '报名中', '比赛进行中', '比赛结束', '已结束', '报名已结束', '报名结束', '已截止', '已开赛', '即将开始', '即将截止', '报名未开始', '未开始'];
          function statusOfNode(el){
            var nodes = el.querySelectorAll('*');
            for (var i = 0; i < nodes.length; i++){
              var t = (nodes[i].innerText || nodes[i].textContent || '').trim();
              if (t.length === 0 || t.length > 8) continue;
              if (statusWords.indexOf(t) >= 0) return t;
            }
            var m = (el.innerText || '').match(/(正在报名|比赛进行中|比赛结束|报名已结束|已截止)/);
            return m ? m[1] : '';
          }
          // "距离报名截止还有 21 天"
          function daysLeftOf(t){
            var m = t.match(/还有\s*(\d+)\s*天/);
            return m ? parseInt(m[1], 10) : -1;
          }
          // 报名时间区间的结束日期（取"报名时间"到"比赛时间"之间的最后一个日期）
          function deadlineOf(t){
            var seg = t.split(/比赛时间|竞赛时间|赛事时间/)[0];
            var m = seg.match(/报名时间[：:]?([\s\S]*)$/);
            if (m) seg = m[1];
            var re = /(\d{4})\s*[年\-\/.]\s*(\d{1,2})\s*[月\-\/.]\s*(\d{1,2})/g, mm, ds = [];
            while ((mm = re.exec(seg)) !== null)
              ds.push(mm[1] + '-' + ('0' + mm[2]).slice(-2) + '-' + ('0' + mm[3]).slice(-2));
            return ds.length ? ds[ds.length - 1] : '';
          }
          // 是否是"包住多个同类条目"的外层容器（内部还有带链接的同类容器才算；否则自己是条目）
          function hasInnerItem(it, sel){
            var kids = it.querySelectorAll(sel);
            for (var i = 0; i < kids.length; i++){
              if (kids[i].querySelector('a[href]')) return true;
            }
            return false;
          }
          // 条目文本范围：条目容器本身 + 向上扩大到"仍像一个条目"的祖先（≤400 字），
          // 因为状态标签/剩余天数常常是条目的兄弟节点，单独取容器会漏。
          function scopeOf(it){
            var el = it;
            for (var i = 0; i < 3 && el.parentElement; i++){
              var pt = textOf(el.parentElement);
              if (pt.length > 400) break;
              el = el.parentElement;
            }
            return el;
          }
          // "竞赛级别： 全国性"
          function levelOf(t){
            var m = t.match(/(?:竞赛|大赛|比赛)级别[：:]\s*([^\s，,。；;]{1,8})/);
            return m ? m[1] : '';
          }
          function push(title, url, date, itemText, status){
            title = (title || '').replace(/\s+/g, ' ').trim();
            if (title.length < 4 || title.length > 200) return;
            if (navWords.test(title)) return;
            if (!/^https?:/.test(url)) return;
            var key = url + '|' + title;
            if (seen[key]) return;
            seen[key] = 1;
            var it = itemText || '';
            out.push({
              title: title,
              url: url,
              meta: date || '',
              status: status || '',
              daysLeft: daysLeftOf(it),
              deadline: deadlineOf(it),
              level: levelOf(it)
            });
          }

          // 在一个条目里挑标题：取文本最长的"像标题"的链接（跳过封面空链接 / 操作按钮）
          function pickItem(it){
            var anchors = [];
            if (it.matches && it.matches('a[href]')) anchors.push(it);
            var inner = it.querySelectorAll('a[href]');
            for (var i = 0; i < inner.length; i++) anchors.push(inner[i]);

            var best = null;
            for (var j = 0; j < anchors.length; j++){
              var a = anchors[j];
              if (a.closest(skipSel)) continue;
              var t = textOf(a).replace(/\s+/g, ' ');
              if (t.length < 4 || t.length > 120) continue;
              if (navWords.test(t)) continue;
              if (!best || t.length > best.title.length) best = { url: a.href, title: t };
            }
            if (best) return best;

            // 链接文本为空（标题在别处）时，退回条目第一行
            var first = it.querySelector('a[href]');
            if (!first) return null;
            var lines = (it.innerText || '').split('\n');
            for (var k = 0; k < lines.length; k++){
              var s = lines[k].replace(/\s+/g, ' ').trim();
              if (s.length >= 4 && s.length <= 120 && !navWords.test(s))
                return { url: first.href, title: s };
            }
            return null;
          }

          // 1) 结构化容器：遍历候选选择器，优先"条目普遍带日期"的那一组（新闻/通知列表的强特征），
          //    同分时取条数多的；每组都只取最内层，避免抓到包住整个列表的壳。
          var bestSet = null;
          var bestScore = -1;
          for (var s = 0; s < itemSels.length; s++){
            var sel = itemSels[s];
            var nodes = document.querySelectorAll(sel);
            var tmp = [];
            for (var i = 0; i < nodes.length; i++){
              var it = nodes[i];
              if (it.closest(skipSel)) continue;
              if (hasInnerItem(it, sel)) continue;                     // 只取最内层条目
              if (it.querySelector('nav, header, footer')) continue;   // 整块页面壳，跳过
              var txt = textOf(it);
              if (txt.length < 4) continue;
              var picked = pickItem(it);
              if (picked)
              {
                var sc = scopeOf(it);
                tmp.push({ p: picked, t: textOf(sc), st: statusOfNode(sc) });
              }
            }
            if (tmp.length < 3) continue;

            var dated = 0;
            for (var d = 0; d < tmp.length; d++) if (dateOf(tmp[d].t)) dated++;
            var score = (dated / tmp.length) * 1000 + Math.min(tmp.length, 300) / 10;
            if (score > bestScore){
              bestScore = score;
              bestSet = tmp;
            }
            if (dated === tmp.length && tmp.length >= 5) break;   // 已经很理想
          }
          if (bestSet){
            // 带日期的条目优先（页面上常混有"栏目/工作室"等无日期列表），各自保持原顺序
            for (var pass = 0; pass < 2; pass++){
              for (var j = 0; j < bestSet.length && out.length < 300; j++){
                var dm = dateOf(bestSet[j].t);
                if ((pass === 0) !== !!dm) continue;
                push(bestSet[j].p.title, bestSet[j].p.url, dm, bestSet[j].t, bestSet[j].st);
              }
            }
          }

          // 2) 退化：列表结构(li/ul/dd > a)，再退化为所有链接
          if (out.length === 0){
            var listNodes = document.querySelectorAll('li a[href], ul a[href], dd a[href]');
            var allNodes = document.querySelectorAll('a[href]');
            var use = listNodes.length >= 4 ? listNodes : allNodes;
            for (var k2 = 0; k2 < use.length && out.length < 300; k2++){
              var a2 = use[k2];
              if (a2.closest(skipSel)) continue;
              var box = a2.closest('li') || a2.closest('dd') || a2.parentElement;
              var boxText = box ? textOf(box) : '';
              push(textOf(a2), a2.href, box ? dateOf(boxText) : '', boxText, box ? statusOfNode(box) : '');
            }
          }

          return out;
        })();
        """;

    private static List<NoticeItem> ParseItems(string json, int page)
    {
        var result = new List<NoticeItem>();
        if (string.IsNullOrWhiteSpace(json)) return result;
        try
        {
            // JS 返回的是小写字段名(title/url/meta)，需忽略大小写才能映射到 RawItem 属性
            var raws = JsonSerializer.Deserialize<List<RawItem>>(json, ParseOpts);
            if (raws == null) return result;
            foreach (var r in raws)
            {
                var m = Regex.Match(r.Meta ?? "", @"(\d{4})-(\d{2})-(\d{2})");
                string date = m.Success ? m.Value : "";
                string source = (r.Meta ?? "").Trim();
                if (m.Success) source = source.Replace(m.Value, "").Trim(' ', '\u00A0', '-');
                result.Add(new NoticeItem
                {
                    Title = (r.Title ?? "").Trim(),
                    Url = r.Url ?? "",
                    Date = date,
                    Source = source,
                    Page = page
                });
            }
        }
        catch { /* 解析失败返回空 */ }
        foreach (var item in result) NoticeTagger.Apply(item);
        return result;
    }

    private static readonly JsonSerializerOptions ParseOpts = new() { PropertyNameCaseInsensitive = true };

    // 还能报名的状态
    private static readonly string[] OngoingStates = { "正在报名", "报名中", "即将截止", "即将开始", "报名未开始", "未开始" };
    // 明确"已经不能报名"的状态
    private static readonly string[] ClosedStates = { "比赛进行中", "比赛结束", "已结束", "报名已结束", "报名结束", "已截止", "已开赛" };

    /// <summary>
    /// 通用列表规范化：若多数条目带报名状态（说明是竞赛/报名类页面），
    /// 过滤掉已不能报名的（比赛中/已结束/已截止…），只留还能报名的；
    /// 顺序保持站点自身的排序（一般已是"最近更新"在前）。非报名类页面原样返回。
    /// </summary>
    private static List<NoticeItem> NormalizeGenericList(List<NoticeItem> list)
    {
        if (list.Count < 3) return list;

        int withStatus = list.Count(i => i.Status.Length > 0);
        bool signingPage = withStatus * 2 >= list.Count && list.Any(i => OngoingStates.Contains(i.Status));
        if (!signingPage) return list;

        var kept = list.Where(i => !ClosedStates.Contains(i.Status)
                                   && !(i.Deadline.Length > 0 && i.DaysLeft < 0))   // 报名截止日已过
                           .ToList();
        // 过滤得太狠（或确实都没在报名）就退回原列表，避免栏位空掉
        return kept.Count >= 2 ? kept : list;
    }

    private static string NormalizeGenericDate(string? s)
    {
        s = (s ?? "").Trim();
        return Regex.IsMatch(s, @"^\d{4}-\d{2}-\d{2}$") ? s : "";
    }

    /// <summary>距离某日还有几天（今天 = 0）；解析失败返回 -1。</summary>
    private static int DaysUntil(string yyyyMMdd)
    {
        if (!DateTime.TryParse(yyyyMMdd, CultureInfo.InvariantCulture,
                DateTimeStyles.None, out var d)) return -1;
        return (int)Math.Floor((d.Date - DateTime.Today).TotalDays);
    }

    private static List<NoticeItem> ParseGenericItems(string json)
    {
        var result = new List<NoticeItem>();
        if (string.IsNullOrWhiteSpace(json)) return result;
        try
        {
            var raws = JsonSerializer.Deserialize<List<RawItem>>(json, ParseOpts);
            if (raws == null) return result;
            foreach (var r in raws)
            {
                var m = Regex.Match(r.Meta ?? "", @"((20\d{2})-(\d{2})-(\d{2}))");
                string date = m.Success ? m.Groups[1].Value : (r.Meta ?? "").Trim();
                string deadline = NormalizeGenericDate(r.Deadline);
                // 页面没直接给"还有 N 天"时，用报名截止日期与今天算出剩余天数（更可靠）
                int daysLeft = r.DaysLeft >= 0 ? r.DaysLeft : DaysUntil(deadline);
                result.Add(new NoticeItem
                {
                    Title = (r.Title ?? "").Trim(),
                    Url = r.Url ?? "",
                    Date = date,
                    Source = "",
                    Page = 1,
                    Status = (r.Status ?? "").Trim(),
                    DaysLeft = daysLeft,
                    Deadline = deadline,
                    Level = (r.Level ?? "").Trim()
                });
            }
        }
        catch { /* 解析失败返回空 */ }
        foreach (var item in result) NoticeTagger.Apply(item);
        return NormalizeGenericList(result);
    }

    private class RawItem
    {
        public string? Title { get; set; }
        public string? Url { get; set; }
        public string? Meta { get; set; }
        public string? Status { get; set; }
        public int DaysLeft { get; set; } = -1;
        public string? Deadline { get; set; }
        public string? Level { get; set; }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { _host?.Close(); } catch { }
        _host = null;
    }
}
