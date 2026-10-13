# Linux 预制件

本目录是给 Linux 用的**预制件**（脚本 + `.desktop` 模板），配套说明见
[`../docs/linux-presets.md`](../docs/linux-presets.md)。

| 文件 | 用途 |
| --- | --- |
| `boot-order.sh` | 开机分级启动（错峰、固定顺序、缺插件跳过、时间戳日志）；`--status` / `--dry-run` / `--run` / `--install` |
| `mouse-fade-x11.sh` | 鼠标跟随透明度（X11 + 合成器，`_NET_WM_WINDOW_OPACITY`）；`--status` / `--restore` |
| `presets/*.desktop` | XDG autostart 模板：把 `__REPO__` 替换成本仓库绝对路径后拷到 `~/.config/autostart/` |
| `presets/*.desktop.disabled` | 对应插件在 Linux 上跑不了（XSpace 是 WPF、Pogget 是闭源 Windows 程序），留作迁移参考 |

**这些都没在 Linux 实机验证过**（本机没有 Linux 环境）。用前请：

```bash
chmod +x linux/boot-order.sh linux/mouse-fade-x11.sh
bash linux/boot-order.sh --dry-run      # 先看计划，确认探测关键字对得上
bash linux/mouse-fade-x11.sh --status   # 确认能找到目标窗口、且有合成器
```

如果 `boot-order.sh` 的进程探测关键字和你的实际进程名不一致，改脚本顶部的 `STAGES` 表即可。
