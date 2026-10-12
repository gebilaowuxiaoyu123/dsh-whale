using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace XSpaceWidget.Services;

/// <summary>加载 / 保存 exe 同目录下的 config.json（便携式配置）。</summary>
public class SettingsService
{
    public AppConfig Config { get; private set; } = new();

    public string ConfigPath { get; }

    public SettingsService()
    {
        ConfigPath = Path.Combine(AppContext.BaseDirectory, "config.json");
        Load();
        // 开机自启状态以注册表为准，与配置文件保持一致
        try { Config.AutoStart = AutoStartService.IsEnabled(); } catch { }
        // 每次启动右栏都回到默认的赛氪竞赛广场（只重置模式，保留用户填写过的自定义网址）
        Config.Mode = "xspace";
    }

    public void Load()
    {
        try
        {
            if (File.Exists(ConfigPath))
            {
                var json = File.ReadAllText(ConfigPath);
                var cfg = JsonSerializer.Deserialize<AppConfig>(json, JsonOpts);
                if (cfg != null) Config = cfg;
            }
        }
        catch
        {
            Config = new AppConfig();
        }
        Sanitize();
    }

    public void Save()
    {
        Sanitize();
        try
        {
            var json = JsonSerializer.Serialize(Config, JsonOpts);
            var tmp = ConfigPath + ".tmp";
            File.WriteAllText(tmp, json);
            File.Move(tmp, ConfigPath, true);
        }
        catch { /* 忽略写入失败 */ }
    }

    private void Sanitize()
    {
        Config.BarCount = Math.Clamp(Config.BarCount, 2, 12);
        Config.RefreshMinutes = Math.Clamp(Config.RefreshMinutes, 5, 120);
        // 旧版单栏默认（360）与上一版默认（640）都迁移到当前默认宽度 600
        if (Config.Width <= 640) Config.Width = 600;
        Config.Width = Math.Clamp(Config.Width, 420, 1200);
        if (Config.Mode != "generic") Config.Mode = "xspace";

        // Steam 价格视图
        Config.SteamAccount ??= "";
        Config.SteamProxy ??= "";
        Config.SteamCountry = string.IsNullOrWhiteSpace(Config.SteamCountry) ? "CN" : Config.SteamCountry.Trim();
        Config.SteamLanguage = string.IsNullOrWhiteSpace(Config.SteamLanguage) ? "schinese" : Config.SteamLanguage.Trim();
    }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        // 允许序列化 double.NaN（窗口位置未设置时的占位值），否则保存会抛异常
        NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals
    };
}
