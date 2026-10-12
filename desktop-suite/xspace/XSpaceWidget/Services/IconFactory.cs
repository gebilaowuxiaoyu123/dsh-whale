using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;

namespace XSpaceWidget.Services;

/// <summary>运行时生成程序 / 托盘图标（避免额外携带资源文件）。</summary>
public static class IconFactory
{
    public static Icon CreateIcon(int size = 32)
    {
        using var bmp = new Bitmap(size, size);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.AntiAlias;

        // 圆角渐变背景
        var rect = new Rectangle(1, 1, size - 2, size - 2);
        using var path = RoundedPath(rect, size / 5);
        using (var bg = new LinearGradientBrush(rect, Color.FromArgb(56, 189, 248), Color.FromArgb(13, 116, 144), 45f))
            g.FillPath(bg, path);
        using (var pen = new Pen(Color.FromArgb(120, 255, 255, 255), 1f))
            g.DrawPath(pen, path);

        // 白色 "竞" 字
        using var font = new Font("Microsoft YaHei", size * 0.42f, FontStyle.Bold, GraphicsUnit.Pixel);
        using (var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
        using (var brush = new SolidBrush(Color.White))
            g.DrawString("竞", font, brush, new RectangleF(0, 0, size, size), sf);

        var hIcon = bmp.GetHicon();
        try { return Icon.FromHandle(hIcon); }
        catch { return SystemIcons.Application; }
    }

    private static GraphicsPath RoundedPath(Rectangle r, int radius)
    {
        var p = new GraphicsPath();
        int d = radius * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }
}
