using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;
using Microsoft.Win32;

namespace XSpaceWidget.Services;

/// <summary>Steam 客户端里登录过的一个账号。</summary>
public sealed record SteamAccount(string SteamId64, string AccountName, string PersonaName)
{
    public string Display => string.IsNullOrEmpty(PersonaName) ? AccountName : $"{PersonaName}（{AccountName}）";
}

/// <summary>
/// Steam 数据访问层。
///
/// 登录态：直接从 Steam 客户端（CEF）的 cookie 库里取 —— 用 DPAPI 解出 AES 主密钥，
/// 再解 AES-GCM 加密的 cookie 值；cookie 库被 steamwebhelper 独占锁定时，
/// 会（可选）短暂结束 webhelper、复制一份、由 Steam 自动重启它。取到的登录态用 DPAPI
/// 加密缓存在本程序目录，避免每次都去动 Steam。
///
/// 网络通路：直连优先（装 UU 加速器时通常直接可用）；直连失败则自动改用本机代理
/// （SOCKS5/HTTP，自动探测 7890 等常用端口），且**自己解析域名后只把 IP 交给代理**——
/// 常见分流规则里 Steam 域名被写成“直连”，只给 IP 就能落回默认代理规则，从而打通。
/// </summary>
public sealed class SteamSession
{
    private const string WishlistApi = "https://api.steampowered.com/IWishlistService/GetWishlist/v1/";
    private const string ItemsApi = "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/";
    private const string CartApi = "https://api.steampowered.com/IAccountCartService/GetCart/v1/";
    private const string StoreRoot = "https://store.steampowered.com/";

    private static readonly int[] ProxyCandidates = { 7890, 7891, 7897, 10808, 10809, 1080, 7078, 2080, 8080 };

    /// <summary>单次请求最多尝试几次（每次换一个解析出的 IP / 换一条通路）。</summary>
    private const int HttpAttempts = 4;
    /// <summary>TCP 握手超时：国内直连被墙时表现为长时间无响应，必须限时才好换下一个 IP。</summary>
    private const int ConnectTimeoutMs = 3000;
    private static readonly TimeSpan AddressTtl = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan BadIpCooldown = TimeSpan.FromMinutes(3);
    private static readonly TimeSpan ProxyProbeInterval = TimeSpan.FromSeconds(20);

    private readonly Func<AppConfig> _config;
    private readonly HttpClient _http;
    private readonly SemaphoreSlim _gate = new(1, 1);

    private string _cookieHeader = "";
    private string _wapit = "";
    private DateTime _wapitExpiry = DateTime.MinValue;
    private DateTime _sessionExpiry = DateTime.MinValue;
    private (string Host, int Port)? _proxy;
    private DateTime _proxyProbedAt = DateTime.MinValue;

    // ===== 多 IP 轮换（Steam 域名解析出多个 CDN IP，其中一部分被墙）=====
    private sealed class HostEntry
    {
        public IPAddress[] Items = Array.Empty<IPAddress>();
        public int Cursor;
        public DateTime Fetched = DateTime.MinValue;
    }

    private readonly object _addrLock = new();
    private readonly Dictionary<string, HostEntry> _hosts = new();
    private readonly Dictionary<IPAddress, DateTime> _badIps = new();
    private readonly Dictionary<string, IPAddress> _lastTry = new();
    private readonly Dictionary<string, IPAddress> _lastTcpOk = new();

    public SteamSession(Func<AppConfig> config)
    {
        _config = config;
        var handler = new SocketsHttpHandler
        {
            ConnectCallback = ConnectAsync,
            PooledConnectionLifetime = TimeSpan.FromMinutes(3),
            AutomaticDecompression = DecompressionMethods.All,
            UseProxy = false,
            AllowAutoRedirect = true,
        };
        _http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(15) };
        _http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
        _http.DefaultRequestHeaders.TryAddWithoutValidation("Accept-Language", "zh-CN,zh;q=0.9");
        Detect();
    }

    /// <summary>状态文字（主窗口状态栏）。</summary>
    public event Action<string>? Progress;

    public string? SteamRoot { get; private set; }
    public string? HtmlCache { get; private set; }
    public SteamAccount? Account { get; private set; }
    public List<SteamAccount> Accounts { get; } = new();

    /// <summary>当前网络通路描述（direct / socks5 127.0.0.1:7890 …）。</summary>
    public string Transport { get; private set; } = "direct";

    public string? LastError { get; private set; }

    public bool HasSession => _cookieHeader.Length > 0;

    private string Country => string.IsNullOrWhiteSpace(_config().SteamCountry) ? "CN" : _config().SteamCountry.Trim();
    private string Language => string.IsNullOrWhiteSpace(_config().SteamLanguage) ? "schinese" : _config().SteamLanguage.Trim();

    // ================= 本地探测：Steam 路径 / 账号 =================

    private void Detect()
    {
        try
        {
            object? path = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam")?.GetValue("SteamPath");
            string? root = path as string;
            if (!string.IsNullOrEmpty(root) && Directory.Exists(root)) SteamRoot = Path.GetFullPath(root);
        }
        catch { }

        if (SteamRoot == null)
        {
            foreach (var candidate in new[]
                     {
                         Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Steam"),
                         @"C:\Program Files (x86)\Steam", @"D:\Steam", @"E:\Steam", @"F:\Steam",
                     })
            {
                if (Directory.Exists(candidate)) { SteamRoot = candidate; break; }
            }
        }

        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        foreach (var cache in new[]
                 {
                     Path.Combine(local, "Steam", "htmlcache"),
                     SteamRoot == null ? "" : Path.Combine(SteamRoot, "config", "htmlcache"),
                 })
        {
            if (!string.IsNullOrEmpty(cache) && File.Exists(Path.Combine(cache, "Local State"))
                && File.Exists(Path.Combine(cache, "Default", "Network", "Cookies")))
            {
                HtmlCache = cache;
                break;
            }
        }

        ReadAccounts();
    }

    private void ReadAccounts()
    {
        try
        {
            if (SteamRoot == null) return;
            string vdf = Path.Combine(SteamRoot, "config", "loginusers.vdf");
            if (!File.Exists(vdf)) return;
            string text = File.ReadAllText(vdf);

            uint active = 0;
            try
            {
                object? v = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam\ActiveProcess")?.GetValue("ActiveUser");
                if (v != null) active = Convert.ToUInt32(v);
            }
            catch { }
            string activeId = active == 0 ? "" : (76561197960265728UL + active).ToString();

            foreach (Match m in Regex.Matches(text, "\"(\\d{17})\"\\s*\\{(.*?)\\}", RegexOptions.Singleline))
            {
                string id = m.Groups[1].Value;
                string body = m.Groups[2].Value;
                string name = Regex.Match(body, "\"AccountName\"\\s*\"([^\"]*)\"").Groups[1].Value;
                string persona = Regex.Match(body, "\"PersonaName\"\\s*\"([^\"]*)\"").Groups[1].Value;
                Accounts.Add(new SteamAccount(id, name, persona));
            }

            string wanted = _config().SteamAccount?.Trim() ?? "";
            Account = Accounts.FirstOrDefault(a => !string.IsNullOrEmpty(wanted)
                                                   && (a.AccountName.Equals(wanted, StringComparison.OrdinalIgnoreCase)
                                                       || a.PersonaName.Equals(wanted, StringComparison.OrdinalIgnoreCase)
                                                       || a.SteamId64 == wanted))
                      ?? Accounts.FirstOrDefault(a => !string.IsNullOrEmpty(activeId) && a.SteamId64 == activeId)
                      ?? Accounts.FirstOrDefault();
        }
        catch (Exception ex) { Debug.WriteLine("read loginusers failed: " + ex.Message); }
    }

    // ================= 登录态 =================

    private string CachePath
    {
        get
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                                      "XSpaceWidget");
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, "steam_session.dat");
        }
    }

    /// <summary>确保拿到登录态（必要时从 Steam 客户端提取）。</summary>
    public async Task<bool> EnsureSessionAsync(bool force, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            if (!force && HasSession && (_sessionExpiry == DateTime.MaxValue || _sessionExpiry > DateTime.Now.AddHours(2)))
                return true;

            if (!force && LoadCache()) return true;

            Progress?.Invoke("正在读取 Steam 登录态…");
            if (await ExtractFromClientAsync(force, ct)) { SaveCache(); return true; }

            LastError = HtmlCache == null
                ? "没找到 Steam 客户端的登录数据（请确认已安装并登录 Steam 客户端）"
                : "无法读取 Steam 登录态（Steam 正在运行且拒绝访问 cookie 库）";
            return false;
        }
        finally { _gate.Release(); }
    }

    private bool LoadCache()
    {
        try
        {
            if (!File.Exists(CachePath)) return false;
            byte[] raw = ProtectedData.Unprotect(File.ReadAllBytes(CachePath), null, DataProtectionScope.CurrentUser);
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            string cookie = root.TryGetProperty("cookies", out var c) ? c.GetString() ?? "" : "";
            if (cookie.Length == 0) return false;
            _cookieHeader = cookie;
            _wapit = root.TryGetProperty("wapit", out var w) ? w.GetString() ?? "" : "";
            _wapitExpiry = root.TryGetProperty("wapitExpiry", out var we) && we.TryGetInt64(out long exp)
                ? DateTimeOffset.FromUnixTimeSeconds(exp).LocalDateTime : DateTime.MinValue;
            long ses = root.TryGetProperty("sessionExpiry", out var se) && se.TryGetInt64(out long sexp) ? sexp : 0;
            _sessionExpiry = ses > 0 ? DateTimeOffset.FromUnixTimeSeconds(ses).LocalDateTime : DateTime.MaxValue;
            if (_sessionExpiry <= DateTime.Now.AddHours(2)) { _cookieHeader = ""; return false; }
            return true;
        }
        catch { return false; }
    }

    private void SaveCache()
    {
        try
        {
            var json = JsonSerializer.Serialize(new
            {
                cookies = _cookieHeader,
                wapit = _wapit,
                wapitExpiry = _wapitExpiry == DateTime.MinValue ? 0 : ((DateTimeOffset)_wapitExpiry).ToUnixTimeSeconds(),
                sessionExpiry = _sessionExpiry == DateTime.MaxValue ? 0 : ((DateTimeOffset)_sessionExpiry).ToUnixTimeSeconds(),
            });
            File.WriteAllBytes(CachePath, ProtectedData.Protect(Encoding.UTF8.GetBytes(json), null,
                                                                DataProtectionScope.CurrentUser));
        }
        catch { }
    }

    /// <summary>从 Steam 客户端的 CEF cookie 库里提取 steamLoginSecure。</summary>
    private async Task<bool> ExtractFromClientAsync(bool allowRestart, CancellationToken ct)
    {
        if (HtmlCache == null) return false;
        string db = Path.Combine(HtmlCache, "Default", "Network", "Cookies");
        string? copy = TryCopyLocked(db);
        if (copy == null && _config().SteamSessionFromClient)
        {
            // Steam 客户端运行时 cookie 库被独占锁定：短暂结束它的浏览器内核（Steam 会自动重启）
            Progress?.Invoke("正在读取 Steam 登录态（会短暂重启 Steam 的浏览器内核）…");
            KillWebHelper();
            await Task.Delay(900, ct);
            copy = TryCopyLocked(db);
        }
        if (copy == null) return false;

        try
        {
            byte[] key = ReadAesKey();
            var values = ReadCookieValues(copy, key);
            var parts = new List<string>();
            foreach (var name in new[] { "steamLoginSecure", "sessionid", "steamCountry", "Steam_Language", "browserid" })
            {
                if (values.TryGetValue(name, out string? v) && v.Length > 0) parts.Add($"{name}={v}");
            }
            if (!values.ContainsKey("steamLoginSecure")) return false;
            _cookieHeader = string.Join("; ", parts);
            _sessionExpiry = JwtExpiry(values["steamLoginSecure"]) ?? DateTime.Now.AddDays(30);
            return true;
        }
        catch (Exception ex)
        {
            LastError = "解密 Steam 登录态失败：" + ex.Message;
            Debug.WriteLine(LastError);
            return false;
        }
        finally
        {
            try { File.Delete(copy); } catch { }
        }
    }

    private static void KillWebHelper()
    {
        try
        {
            foreach (var p in Process.GetProcessesByName("steamwebhelper"))
            {
                try { p.Kill(); } catch { }
            }
        }
        catch { }
    }

    /// <summary>复制被别人独占打开的文件（Steam 的 cookie 库）。</summary>
    private static string? TryCopyLocked(string src)
    {
        if (!File.Exists(src)) return null;
        IntPtr handle = CreateFileW(src, 0x80000000 /*GENERIC_READ*/, 0x1 | 0x2 | 0x4 /*share all*/,
                                   IntPtr.Zero, 3 /*OPEN_EXISTING*/, 0, IntPtr.Zero);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return null;
        string dst = Path.Combine(Path.GetTempPath(), "xspace_steam_cookies.db");
        try
        {
            using var fs = new FileStream(dst, FileMode.Create, FileAccess.Write, FileShare.None);
            var buf = new byte[1 << 16];
            while (true)
            {
                if (!ReadFile(handle, buf, buf.Length, out int read, IntPtr.Zero) || read <= 0) break;
                fs.Write(buf, 0, read);
            }
            return fs.Length > 0 ? dst : null;
        }
        catch { return null; }
        finally { CloseHandle(handle); }
    }

    private byte[] ReadAesKey()
    {
        string localState = Path.Combine(HtmlCache!, "Local State");
        using var doc = JsonDocument.Parse(File.ReadAllText(localState));
        string b64 = doc.RootElement.GetProperty("os_crypt").GetProperty("encrypted_key").GetString()!;
        byte[] raw = Convert.FromBase64String(b64);
        if (raw.Length <= 5 || Encoding.ASCII.GetString(raw, 0, 5) != "DPAPI")
            throw new InvalidDataException("os_crypt key 前缀不是 DPAPI");
        return ProtectedData.Unprotect(raw[5..], null, DataProtectionScope.CurrentUser);
    }

    private static Dictionary<string, string> ReadCookieValues(string dbPath, byte[] key)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        using var con = new SqliteConnection($"Data Source={dbPath};Mode=ReadOnly");
        con.Open();
        using var cmd = con.CreateCommand();
        cmd.CommandText = "SELECT host_key, name, encrypted_value FROM cookies WHERE host_key LIKE '%steampowered%'";
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            string host = reader.GetString(0);
            string name = reader.GetString(1);
            byte[] enc = (byte[])reader.GetValue(2);
            string value;
            try { value = DecryptCookie(key, enc); }
            catch { continue; }
            // store 域优先
            if (!result.ContainsKey(name) || host.Contains("store.steampowered"))
                result[name] = value;
        }
        return result;
    }

    private static string DecryptCookie(byte[] key, byte[] value)
    {
        if (value.Length > 15 && (Encoding.ASCII.GetString(value, 0, 3) == "v10"
                                  || Encoding.ASCII.GetString(value, 0, 3) == "v11"))
        {
            byte[] nonce = value[3..15];
            byte[] payload = value[15..];
            byte[] plain = new byte[payload.Length - 16];
            using var gcm = new AesGcm(key, 16);
            gcm.Decrypt(nonce, payload.AsSpan(0, payload.Length - 16), payload.AsSpan(payload.Length - 16), plain);
            return Encoding.UTF8.GetString(plain);
        }
        return Encoding.UTF8.GetString(ProtectedData.Unprotect(value, null, DataProtectionScope.CurrentUser));
    }

    /// <summary>取 JWT 的 exp。</summary>
    private static DateTime? JwtExpiry(string token)
    {
        try
        {
            int dot = token.IndexOf('.');
            int dot2 = dot < 0 ? -1 : token.IndexOf('.', dot + 1);
            if (dot2 < 0) return null;
            string payload = token[(dot + 1)..dot2].Replace('-', '+').Replace('_', '/');
            payload = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
            using var doc = JsonDocument.Parse(Convert.FromBase64String(payload));
            if (doc.RootElement.TryGetProperty("exp", out var exp) && exp.TryGetInt64(out long seconds))
                return DateTimeOffset.FromUnixTimeSeconds(seconds).LocalDateTime;
        }
        catch { }
        return null;
    }

    // ================= Web API =================

    /// <summary>取网页版 API 令牌（wapit），购物车/愿望单接口需要它。</summary>
    public async Task<bool> EnsureWapitAsync(bool force, CancellationToken ct = default)
    {
        if (!force && _wapit.Length > 0 && _wapitExpiry > DateTime.Now.AddMinutes(5)) return true;
        try
        {
            // 必须带登录态，否则拿到的是未登录的登录页（里面没有 API 令牌）
            string html = await HttpGetAsync($"{StoreRoot}cart/?cc={Country}&l={Language}", ct);
            var m = Regex.Match(html, "g_wapit\\s*=\\s*\"([^\"]+)\"");
            if (!m.Success) { LastError = "没能从 Steam 商城页拿到 API 令牌"; return false; }
            _wapit = m.Groups[1].Value;
            var e = Regex.Match(html, "g_wapitExpiry\\s*=\\s*\"?([0-9]+)");
            _wapitExpiry = e.Success && long.TryParse(e.Groups[1].Value, out long ts)
                ? DateTimeOffset.FromUnixTimeSeconds(ts).LocalDateTime
                : JwtExpiry(_wapit) ?? DateTime.Now.AddHours(12);
            SaveCache();
            return true;
        }
        catch (Exception ex) { LastError = Short(ex); return false; }
    }

    /// <summary>愿望单里的 appid 列表（按添加时间倒序）。</summary>
    public async Task<List<(uint AppId, long DateAdded)>> GetWishlistAsync(CancellationToken ct = default)
    {
        string url = $"{WishlistApi}?access_token={Uri.EscapeDataString(_wapit)}&steamid={Account?.SteamId64}";
        string json = await HttpGetAsync(url, ct);
        var list = new List<(uint AppId, long DateAdded)>();
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("response", out var resp)) return list;
        if (!resp.TryGetProperty("items", out var items)) return list;
        foreach (var it in items.EnumerateArray())
        {
            if (!it.TryGetProperty("appid", out var app)) continue;
            uint id = app.GetUInt32();
            long added = it.TryGetProperty("date_added", out var d) && d.TryGetInt64(out long t) ? t : 0;
            list.Add((id, added));
        }
        list.Sort((a, b) => b.DateAdded.CompareTo(a.DateAdded));
        return list;
    }

    /// <summary>批量取商店条目（含价格、折扣、特惠类型）。ids 元素形如 ("appid"|"packageid"|"bundleid", id)。</summary>
    public async Task<List<JsonElement>> GetStoreItemsAsync(IReadOnlyList<(string Kind, uint Id)> ids,
                                                           CancellationToken ct = default)
    {
        var result = new List<JsonElement>();
        foreach (var chunk in ids.Chunk(30))
        {
            var idObjects = chunk.Select(x => x.Kind == "packageid"
                ? new Dictionary<string, uint> { ["packageid"] = x.Id }
                : x.Kind == "bundleid"
                    ? new Dictionary<string, uint> { ["bundleid"] = x.Id }
                    : new Dictionary<string, uint> { ["appid"] = x.Id }).ToArray();
            var input = new
            {
                ids = idObjects,
                context = new { language = Language, country_code = Country, steam_realm = 1 },
                data_request = new
                {
                    include_basic_info = true,
                    include_release = true,
                    include_all_purchase_options = true,
                },
            };
            string url = $"{ItemsApi}?access_token={Uri.EscapeDataString(_wapit)}&input_json="
                         + Uri.EscapeDataString(JsonSerializer.Serialize(input));
            string json = await HttpGetAsync(url, ct);
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("response", out var resp)) continue;
            if (!resp.TryGetProperty("store_items", out var items)) continue;
            foreach (var it in items.EnumerateArray()) result.Add(it.Clone());
        }
        return result;
    }

    /// <summary>按 appid 批量取商店条目。</summary>
    public Task<List<JsonElement>> GetStoreItemsAsync(IReadOnlyList<uint> appIds, CancellationToken ct = default)
        => GetStoreItemsAsync(appIds.Select(a => ("appid", a)).ToArray(), ct);

    /// <summary>购物车（可能为空）。返回 accountcart.cart 节点。</summary>
    public async Task<JsonElement?> GetCartAsync(CancellationToken ct = default)
    {
        string url = $"{CartApi}?access_token={Uri.EscapeDataString(_wapit)}";
        string json = await HttpGetAsync(url, ct);
        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.TryGetProperty("response", out var resp)
            && resp.TryGetProperty("cart", out var cart))
            return cart.Clone();
        return null;
    }

    // ================= HTTP =================

    /// <summary>
    /// GET（自动带登录态）。Steam 域名在国内会被解析到多个 CDN IP，其中一部分被墙：
    /// 因此单次请求会尝试多次 —— 每次换一个解析出的 IP，必要时再切换本机代理通路。
    /// </summary>
    public async Task<string> HttpGetAsync(string url, CancellationToken ct = default, bool withCookies = true)
    {
        string host = new Uri(url).Host;
        Exception? last = null;
        for (int attempt = 0; attempt < HttpAttempts; attempt++)
        {
            ct.ThrowIfCancellationRequested();
            if (attempt > 0)
            {
                await Task.Delay(120 * attempt, ct);
                await EnsureTransportAsync(ct);
            }
            try
            {
                return await SendOnceAsync(url, withCookies, ct);
            }
            catch (SteamStatusException) { throw; }
            catch (SessionExpiredException) { throw; }
            catch (Exception ex) when (IsTransportError(ex, ct))
            {
                last = ex;
                MarkBadFromLastConnect(host);
            }
        }
        LastError = "网络不通（已试多次）：Steam 接口连不上，可开启加速器后重试";
        throw last ?? new HttpRequestException("Steam 接口请求失败");
    }

    private async Task<string> SendOnceAsync(string url, bool withCookies, CancellationToken ct)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, url);
        if (withCookies && _cookieHeader.Length > 0)
            req.Headers.TryAddWithoutValidation("Cookie", _cookieHeader);
        req.Headers.TryAddWithoutValidation("Accept", "application/json, text/html;q=0.9,*/*;q=0.8");
        using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseContentRead, ct);
        if ((int)resp.StatusCode is 401 or 403) throw new SteamStatusException((int)resp.StatusCode);
        string text = await resp.Content.ReadAsStringAsync(ct);
        // 302 到登录页说明登录态失效
        if (resp.RequestMessage?.RequestUri?.AbsolutePath.Contains("/login") == true)
            throw new SessionExpiredException();
        return text;
    }

    /// <summary>判断是否属于"网络通路不通"（值得换 IP/换通路重试）。</summary>
    private static bool IsTransportError(Exception ex, CancellationToken ct) => ex switch
    {
        SteamStatusException => false,
        SessionExpiredException => false,
        OperationCanceledException => !ct.IsCancellationRequested,   // 自己超时（非用户取消）
        SocketException => true,
        IOException => true,
        HttpRequestException => true,
        _ => false,
    };

    /// <summary>
    /// 按需调整网络通路：直连受限时切到本机代理；代理死了就退回直连（探测结果带节流，不粘死）。
    /// </summary>
    private async Task EnsureTransportAsync(CancellationToken ct)
    {
        if (DateTime.UtcNow - _proxyProbedAt < ProxyProbeInterval) return;
        _proxyProbedAt = DateTime.UtcNow;

        string configured = _config().SteamProxy?.Trim() ?? "";
        bool proxyForbidden = configured.Equals("direct", StringComparison.OrdinalIgnoreCase);

        if (Transport.StartsWith("socks5"))
        {
            if (!proxyForbidden && _proxy is { } alive && await IsSocks5Async(alive.Host, alive.Port, ct)) return;
            _proxy = null;
            Transport = "direct";
            Progress?.Invoke("本机代理不可用，改回直连");
            if (proxyForbidden) return;
        }
        else if (proxyForbidden) return;

        var found = await FindProxyAsync(configured, ct);
        if (found == null) return;
        _proxy = found;
        Transport = $"socks5 {found.Value.Host}:{found.Value.Port}";
        Progress?.Invoke($"直连受限，改用本机代理 {found.Value.Host}:{found.Value.Port}");
    }

    /// <summary>找一个可用的本机代理（先复用已知的，再试配置的，最后扫常用端口）。</summary>
    private async Task<(string Host, int Port)?> FindProxyAsync(string configured, CancellationToken ct)
    {
        if (_proxy is { } known && await IsSocks5Async(known.Host, known.Port, ct)) return known;
        if (configured.Length > 0 && TryParseProxy(configured, out var ep) && await IsSocks5Async(ep.Host, ep.Port, ct))
            return ep;
        foreach (int port in ProxyCandidates)
            if (await IsSocks5Async("127.0.0.1", port, ct)) return ("127.0.0.1", port);
        return null;
    }

    private static bool TryParseProxy(string text, out (string Host, int Port) ep)
    {
        ep = ("127.0.0.1", 7890);
        try
        {
            string s = text.Contains("://") ? text[(text.IndexOf("://", StringComparison.Ordinal) + 3)..] : text;
            s = s.TrimEnd('/');
            string[] parts = s.Split(':');
            if (parts.Length == 2 && int.TryParse(parts[1], out int port))
            {
                ep = (parts[0], port);
                return true;
            }
        }
        catch { }
        return false;
    }

    private static async Task<bool> IsSocks5Async(string host, int port, CancellationToken ct)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(400);
            using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            await socket.ConnectAsync(host, port, cts.Token);
            byte[] greet = { 0x05, 0x01, 0x00 };
            await socket.SendAsync(greet, SocketFlags.None, cts.Token);
            var buf = new byte[2];
            int n = await socket.ReceiveAsync(buf, SocketFlags.None, cts.Token);
            return n == 2 && buf[0] == 0x05;
        }
        catch { return false; }
    }

    /// <summary>连接回调：直连优先；走代理时自己解析域名，只把 IP 交给代理。每次连接轮换一个 IP。</summary>
    private async ValueTask<Stream> ConnectAsync(SocketsHttpConnectionContext ctx, CancellationToken ct)
    {
        var ep = ctx.DnsEndPoint;
        if (_proxy is { } proxy && Transport.StartsWith("socks5"))
        {
            IPAddress ip = await NextAddressAsync(ep.Host, ct);
            RecordTry(ep.Host, ip);
            return await Socks5ConnectAsync(proxy.Host, proxy.Port, ip, ep.Port, ct);
        }

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(ConnectTimeoutMs);
        var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            IPAddress ip = await NextAddressAsync(ep.Host, ct);
            RecordTry(ep.Host, ip);
            await socket.ConnectAsync(new IPEndPoint(ip, ep.Port), cts.Token);
            lock (_addrLock) _lastTcpOk[ep.Host] = ip;   // TCP 握手成功 → 这个 IP 至少没被 TCP 层墙掉
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    // ===== IP 轮换 / 坏 IP 冷却 =====

    /// <summary>取该域名下一个候选 IP（跳过刚失败过的；没有缓存或缓存过期则重新解析）。</summary>
    private async Task<IPAddress> NextAddressAsync(string host, CancellationToken ct)
    {
        if (IPAddress.TryParse(host, out var literal)) return literal;

        lock (_addrLock)
        {
            if (_hosts.TryGetValue(host, out var e) && e.Items.Length > 0 && DateTime.UtcNow - e.Fetched <= AddressTtl)
                return PickLocked(e);
        }

        IPAddress[] addrs;
        try
        {
            addrs = await Dns.GetHostAddressesAsync(host, ct);
        }
        catch
        {
            // DNS 也失败：退回上一次的列表凑合用
            lock (_addrLock)
            {
                if (_hosts.TryGetValue(host, out var e) && e.Items.Length > 0) { e.Fetched = DateTime.UtcNow; return PickLocked(e); }
            }
            throw;
        }

        var v4 = addrs.Where(a => a.AddressFamily == AddressFamily.InterNetwork).ToArray();
        if (v4.Length == 0) v4 = addrs;
        if (v4.Length == 0) throw new SocketException((int)SocketError.HostNotFound);

        lock (_addrLock)
        {
            if (!_hosts.TryGetValue(host, out var e)) _hosts[host] = e = new HostEntry();
            e.Items = v4;
            e.Cursor = 0;
            e.Fetched = DateTime.UtcNow;
            return PickLocked(e);
        }
    }

    /// <summary>取下一个 IP：优先没进冷却的；全在冷却里就挑最早解禁的。调用方需持有 _addrLock。</summary>
    private IPAddress PickLocked(HostEntry e)
    {
        DateTime now = DateTime.UtcNow;
        for (int i = 0; i < e.Items.Length; i++)
        {
            IPAddress ip = e.Items[e.Cursor % e.Items.Length];
            e.Cursor++;
            if (!_badIps.TryGetValue(ip, out DateTime until) || until <= now) return ip;
        }
        IPAddress best = e.Items.OrderBy(ip => _badIps.TryGetValue(ip, out DateTime t) ? t : DateTime.MinValue).First();
        _badIps.Remove(best);
        return best;
    }

    private void RecordTry(string host, IPAddress ip)
    {
        lock (_addrLock) _lastTry[host] = ip;
    }

    /// <summary>把最近这次尝试用到的 IP 拉黑一段时间，下次自然换别的。</summary>
    private void MarkBadFromLastConnect(string host)
    {
        lock (_addrLock)
        {
            if (!_lastTry.TryGetValue(host, out var ip)) return;
            _badIps[ip] = DateTime.UtcNow + BadIpCooldown;
            if (_lastTcpOk.TryGetValue(host, out var ok)) _badIps[ok] = DateTime.UtcNow + BadIpCooldown;
            _lastTry.Remove(host);
            _lastTcpOk.Remove(host);
            if (_badIps.Count > 64)
            {
                foreach (var k in _badIps.Where(kv => kv.Value <= DateTime.UtcNow).Select(kv => kv.Key).ToArray())
                    _badIps.Remove(k);
            }
        }
    }

    /// <summary>最小的 SOCKS5 CONNECT 实现。</summary>
    private static async Task<Stream> Socks5ConnectAsync(string proxyHost, int proxyPort,
                                                        IPAddress target, int port, CancellationToken ct)
    {
        var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            await socket.ConnectAsync(proxyHost, proxyPort, ct);
            await socket.SendAsync(new byte[] { 0x05, 0x01, 0x00 }, SocketFlags.None, ct);
            var resp = new byte[2];
            if (await socket.ReceiveAsync(resp, SocketFlags.None, ct) != 2 || resp[1] != 0x00)
                throw new IOException("SOCKS5 握手失败");

            byte[] addr = target.GetAddressBytes();
            var req = new byte[4 + 4 + 2];
            req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x01;
            Array.Copy(addr, 0, req, 4, 4);
            req[8] = (byte)(port >> 8);
            req[9] = (byte)(port & 0xFF);
            await socket.SendAsync(req, SocketFlags.None, ct);

            var head = new byte[4];
            await ReadExactAsync(socket, head, ct);
            if (head[1] != 0x00) throw new IOException($"SOCKS5 连接被拒绝 ({head[1]})");
            int tail = head[3] switch { 0x01 => 4 + 2, 0x04 => 16 + 2, _ => 1 + 2 };
            await ReadExactAsync(socket, new byte[tail], ct);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    private static async Task ReadExactAsync(Socket socket, byte[] buffer, CancellationToken ct)
    {
        int offset = 0;
        while (offset < buffer.Length)
        {
            int n = await socket.ReceiveAsync(buffer.AsMemory(offset), SocketFlags.None, ct);
            if (n <= 0) throw new IOException("连接提前关闭");
            offset += n;
        }
    }

    private static string Short(Exception ex)
    {
        string s = ex.Message;
        return s.Length > 80 ? s[..80] : s;
    }

    // ================= Win32 =================

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa,
                                             uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(IntPtr handle, byte[] buffer, int count, out int read, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}

/// <summary>登录态失效（需要重新取）。</summary>
public sealed class SessionExpiredException : Exception
{
    public SessionExpiredException() : base("Steam 登录态已失效") { }
}

/// <summary>Steam 返回 401/403（令牌过期等）—— 这类不是网络问题，不重试。</summary>
public sealed class SteamStatusException : HttpRequestException
{
    public int Code { get; }
    public SteamStatusException(int code) : base($"HTTP {code}") => Code = code;
}
