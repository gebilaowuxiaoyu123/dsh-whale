namespace XNoteWidget.Services;

/// <summary>应用配置（保存于 exe 同目录 config.json，便于随程序一起拷贝）。</summary>
public class AppConfig
{
    /// <summary>显示的栏数（条数），范围 2..12。</summary>
    public int BarCount { get; set; } = 5;

    /// <summary>是否开机自启。</summary>
    public bool AutoStart { get; set; }

    /// <summary>是否置顶显示。</summary>
    public bool TopMost { get; set; } = true;

    /// <summary>是否记住窗口位置。</summary>
    public bool RememberPos { get; set; } = true;

    /// <summary>上次窗口位置。</summary>
    public double Left { get; set; } = double.NaN;

    /// <summary>上次窗口位置。</summary>
    public double Top { get; set; } = double.NaN;

    /// <summary>窗口宽度。</summary>
    public double Width { get; set; } = 360;

    /// <summary>便签内容（按顺序，空字符串表示空白信息栏）。</summary>
    public List<string> Notes { get; set; } = new();
}
