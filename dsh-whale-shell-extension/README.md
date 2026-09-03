# DSH 小鲸鱼 · GNOME Shell 扩展版（v30）

> 在 **GNOME Wayland** 上实现「像 Windows 那样的悬浮小鲸鱼」的正解。
> 它是 GNOME Shell 扩展：鲸鱼直接绘制在 Shell 层，**天然悬浮于所有普通窗口之上**，
> 支持透明 PNG、动画、满屏拖动、点击——这是 GNOME Wayland 下唯一可靠的浮层方式
> （Mutter 不支持 wlr-layer-shell，Electron 透明窗在 Wayland 亦不可用）。

- 兼容：GNOME Shell **45 / 46 / 47**（Ubuntu 24.04 + GNOME 46 实测）
- UUID：`dsh-whale@local`｜语言：ESM / GJS（GNOME 45+）
- 与动态壁纸（hanabi）等既有扩展同属扩展体系，互不冲突，可在扩展管理器统一开关

---

## ✨ 功能全景（v30）

| 类别 | 能力 |
|---|---|
| 🐋 悬浮 | 透明 PNG 鲸鱼画在 Shell 层，始终在所有普通窗口之上；启动默认左下角 |
| 🖱️ 拖动 | 左键按住即**满屏跟手移动**（60fps 采样，带抓取偏移、无边缘抖动），松手自动停靠 |
| 🧲 吸附 | 松手按中心所在 1/4 带**贴四边/四角**（两轴独立组合）；缩放、回家保持贴边 |
| 👋 摸摸头 | 左键轻点（无拖动）→ 开心小跳 ×3 + 飘爱心/音符 + 卖萌气泡 |
| 🎞️ 静置动效 | 每 2s 呼吸浮动；≥6.5s 随机飘音符/爱心、眨眼、双音符——像 gif 一直在动 |
| 💰 余额 | 直连 `api.deepseek.com/user/balance`；启动静默对齐、60s 自动轮询（可关）、点击气泡换台词 |
| 🔢 数字滚动 | 同币种金额变化时，气泡首行 700ms ease-out 60fps 平滑滚动到新值 |
| 📊 今日已用 | **记账**（余额差值累计、跨天归零归档 30 天、币种感知，兼容 dsh-web 账本）或**令牌精算** |
| 🎟️ 令牌模式 | 读 `DEEPSEEK_PLATFORM_TOKEN` → 平台用量接口按**峰谷定价**精算今日已用；无 token/失败自动回落记账 |
| 🎤 台词 | 峰谷提示 / 卖萌 / 吐槽 / 今日已用四组**加权随机**；峰谷文案 3 种风格（默认 / 梁文峰谷 / !?强强?!） |
| 🎵 音效 | **6 套音色**（默认 / 叮咚 / 低沉 / 柔和 / 活泼 / 清脆）× 拿起·放下·摸摸头，音量可调 |
| 📋 偏好 | 音色/音量/音效/气泡/峰谷文案/自动刷新/用量模式 持久化到 `~/.cache/dsh-whale/prefs.json` |

## 🖱️ 操作一览

| 操作 | 效果 |
|---|---|
| 左键按住拖动 | 鲸鱼跟手移动；松手自动贴四边/四角 |
| 左键轻点（不拖动） | 摸摸头互动 |
| 滚轮 / 菜单「🔍 放大 / 🔎 缩小」 | 0.5×–2.5× 缩放（贴边状态保持） |
| 右键 | 汉堡菜单（见下） |
| 气泡上单击 | 换一句台词 |

## 🍔 右键菜单

| 项 | 作用 |
|---|---|
| 💰 查看余额 | 手动刷新并弹气泡（峰谷 + 今日已用 + 随机台词） |
| 🔄 自动刷新 | 60s 自动轮询开关（余额变化才弹泡，变化时数字滚动） |
| 🏠 回到左下角 | 一键回默认位置 |
| 🔍 / 🔎 放大缩小 | 步进 0.15 缩放 |
| 📒 用量 | 记账 ⇄ 令牌 模式切换（令牌需先配 `DEEPSEEK_PLATFORM_TOKEN`） |
| 🎵 音色 | 6 套音色主题循环切换（即时试听） |
| 🎚 音量 | − / 百分比 / ＋（每档 5%） |
| 🔊 音效 / 💬 气泡 | 总开关 |
| 🎙️ 峰谷文案 | 默认 / 梁文峰谷 / !?强强?! 循环 |
| 🙈 隐藏 | 禁用扩展（在扩展管理器/开始菜单重新启用并回左下角） |

## 🔑 凭据与数据

```yaml
# ~/.dsh/.credentials.yaml
DEEPSEEK_API_KEY: sk-xxxxxx            # 必填：拉余额
DEEPSEEK_PLATFORM_TOKEN: Bearer eyJ…  # 可选：令牌精算今日已用
```

- 记账账本：`~/.dsh/.dshw-usage.json`（与 dsh-web 兼容；跨天归档 30 天）
- 偏好缓存：`~/.cache/dsh-whale/prefs.json`（自动保存/恢复）
- 记账：每次观测到余额下降的差值累计为「今日已用」；无需任何令牌即可用
- 令牌精算：读平台 `/api/v0/usage/by_api_key/amount`，按 deepseek 峰谷定价换算，实时且含缓存

## 📁 目录

```
dsh-whale-shell-extension/
├── metadata.json          # uuid dsh-whale@local；Shell 45–47
├── extension.js           # 全部逻辑（ESM / 单文件，含交互/动画/记账/令牌）
├── assets/
│   ├── dshw.png           # 鲸鱼素材
│   └── Ya1/Ya2 + sfx_{bell,low,soft,pop,chirp}_{pick,drop}.mp3   # 6 套音色
├── install.sh             # 安装/更新（复制到扩展目录）
├── desktop-menu.sh        # 桌面入口：显示余额/重启扩展（供 .desktop 联动）
├── dsh-whale-widget.desktop
└── README.md              # 本文件
```

## 🚀 安装 / 更新 / 卸载

```bash
# 安装 / 更新（重装后需注销重登录一次）
cd dsh-whale-shell-extension
./install.sh

# 注销 → 重新登录（GNOME Wayland 需重载 shell 才会扫描新扩展）
gnome-extensions enable dsh-whale@local        # 或扩展管理器里打开
```

> 改动 `extension.js` 后：同步到 `~/.local/share/gnome-shell/extensions/dsh-whale@local/`，
> 再注销重登录生效（无热重载）。

卸载：`rm -rf ~/.local/share/gnome-shell/extensions/dsh-whale@local`（可选删 `~/.cache/dsh-whale`）。

## 🩺 排错

```bash
journalctl --user -b -f -o cat | grep -i dsh-whale   # 看扩展日志/报错
gnome-extensions info dsh-whale@local
gnome-extensions enable dsh-whale@local              # 手动启用
```

- 余额不显示 → 检查 `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY`
- 令牌模式提示需配置 → 补 `DEEPSEEK_PLATFORM_TOKEN`，或继续用记账模式
- 收起/消失 → 菜单「🙈 隐藏」= 禁用扩展；在扩展管理器重新启用

## 📚 相关

- 仓库总览 / 其它形态（Windows、Linux、DSH 插件）：[`../README.md`](../README.md)
- 逐版更新日志：**[`../CHANGELOG.md`](../CHANGELOG.md)**（桌面 v1.0 → 扩展版 v30）
