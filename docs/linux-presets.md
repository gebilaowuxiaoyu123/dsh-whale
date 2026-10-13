# Linux 预制（配置为主，未在 Linux 实机验证）

本页是**预制件**：把各插件在 Linux 上要怎么启动、怎么自启、GPU 要注意什么写清楚，
并给出可直接改路径使用的文件（放在 `linux/` 下）。**除小鲸鱼 Linux 桌面版与 GNOME 扩展版外，
均未在 Linux 实机验证过** —— 用之前请先按"验证要点"过一遍。

## 一、哪些能跑、哪些不能

| 插件 | Linux 可行性 | 预制件 | 说明 |
| --- | --- | --- | --- |
| 小鲸鱼 GNOME Shell 扩展版 | 可以（推荐） | `desktop-suite/dsh-whale/dsh-whale-shell-extension/install.sh` | Wayland 首选，实机测过 45–47 |
| 小鲸鱼 Linux 桌面版（Electron） | 可以 | `linux/presets/dsh-whale.desktop` | X11 会话最稳；Wayland 下置顶/定位受限 |
| Coopanion 桌宠（Electron） | 可以（有魔改） | `linux/presets/coopanion.desktop` | 见 `coopanion-linux-and-nvidia.md` |
| 鼠标跟随透明度助手 | 可以（X11 + 合成器） | `linux/mouse-fade-x11.sh`、`linux/presets/dsh-mouse-fade.desktop` | 见下方"三、X11 显隐" |
| 开机分级启动 | 可以 | `linux/boot-order.sh`、`linux/presets/dsh-boot-order.desktop` | 见下方"四" |
| XSpace 竞赛通知栏 | **不能**（.NET 9 WPF 仅 Windows） | `linux/presets/xspace.desktop.disabled` | 要 Linux 得移植到 Avalonia；临时可用扩展版以气泡形式显示通知 |
| Pogget 桌面容器 | **不能**（第三方专有 Windows 程序） | `linux/presets/pogget.desktop.disabled` | Wine 也许能跑，但窗口形状/层级行为不可预期 |
| MiSide 动态壁纸 | **不能**（Windows Unity 产物） | — | Linux 上换用原生壁纸方案（视频壁纸 / Godot / Unity Linux 构建），自研守护脚本需按新目标改写 |

## 二、GPU 相关（Intel Arc / Mesa / NVIDIA）

- **VA-API 硬解**：装 `intel-media-va-driver-non-free`（或 `-non-free` 包名按发行版），
  用 `vainfo` 确认；Meteor Lake 及更新用 `LIBVA_DRIVER_NAME=iHD`（老平台才是 `i965`）。
- **Electron 走 Wayland 原生**：`--ozone-platform=wayland --enable-features=UseOzonePlatform`
  （Coopanion 的 Linux 魔改已强制子进程继承 ozone 参数，否则桌宠窗口不出现）。
- **透明/置顶**：Wayland 下 Electron 的 `setAlwaysOnTop` / `setPosition` 不生效（Mutter 限制），
  要悬浮请优先用 GNOME Shell 扩展版；X11 下正常。
- **NVIDIA**：驱动安装与预制参数见 [`coopanion-linux-and-nvidia.md`](coopanion-linux-and-nvidia.md)
  （检测不到 N 卡时零副作用）。
- **别在启动瞬间叠 GPU 负载**：用 `linux/boot-order.sh` 错峰（壁纸单独一段）。

## 三、X11 显隐（鼠标离开时变透明/下沉）

Linux 没有 Windows 的 `WS_EX_LAYERED`，但 X11 + 合成器（picom / KWin / Mutter / xfwm4 合成模式）
支持 EWMH 的 `_NET_WM_WINDOW_OPACITY`：

```bash
xprop -id <窗口id> -f _NET_WM_WINDOW_OPACITY 32c -set _NET_WM_WINDOW_OPACITY 0x8fffffff   # 约 56% 不透明
```

`linux/mouse-fade-x11.sh` 就是按这个做的（轮询鼠标是否落在目标窗口内 → 平滑过渡不透明度；
下沉位移用 `xdotool windowmove`，若合成器/窗口管理器不允许移动则自动跳过）。
依赖：`xdotool`（取鼠标位置/窗口几何/移动窗口）、`xprop`（X11 自带）。

**验证要点**：确认正在跑合成器（`xprop -root _NET_SUPPORTING_WM_CHECK` 有值、且窗口能透明）；
若窗口纹丝不动，说明合成器不支持，改用 GNOME Shell 扩展版或关掉本功能。

## 四、开机分级启动（Linux）

`linux/boot-order.sh` 与 Windows 版逻辑一致：按顺序启动 + 等进程就绪 + 额外间隔 + 缺插件跳过 + 打时间戳日志。
自启用 XDG autostart（`~/.config/autostart/*.desktop`），顺序由脚本内部保证（而不是靠 desktop 文件的排序）。

```bash
bash linux/boot-order.sh --dry-run     # 只打印计划
bash linux/boot-order.sh --run         # 真正按顺序启动
bash linux/boot-order.sh --install     # 装 XDG 自启（~/.config/autostart/dsh-boot-order.desktop）
bash linux/boot-order.sh --status      # 看各插件在不在 + 当前自启项
```

配置写在 `desktop-suite/_runtime/boot-order/config.json`（与 Windows 版共用一个位置，但各自解析），
**不进版本库**，所以别的系统拉仓库时不会带上你的机器配置。

## 五、预制件怎么用

```bash
# 1) 把 .desktop 拷到 XDG autostart 并改路径
mkdir -p ~/.config/autostart
sed "s#__REPO__#$PWD#g" linux/presets/dsh-whale.desktop > ~/.config/autostart/dsh-whale.desktop

# 2) 脚本给可执行权限
chmod +x linux/boot-order.sh linux/mouse-fade-x11.sh

# 3) 想先手动试一次
bash linux/boot-order.sh --dry-run
```

`.desktop.disabled` 结尾的是**故意不启用**的（对应插件在 Linux 上跑不了），留作迁移参考。

## 六、未验证清单（提醒）

- 所有 `.desktop` 文件都未在真实桌面会话里跑过（本机无 Linux 环境）；
- `mouse-fade-x11.sh` 的透明度过渡依赖合成器，未实测；
- `boot-order.sh` 的进程探测关键字按 Windows 侧进程名类比填写，**首次使用务必先 `--dry-run`**，
  必要时改脚本顶部的 `STAGES` 表。
