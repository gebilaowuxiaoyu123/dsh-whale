# 🐋 DSH 小鲸鱼桌面挂件（DSH Whale Widget）

> 一只住在你屏幕角落的小鲸鱼娘，实时显示 DeepSeek 账户余额与今日消耗。可选 **GNOME Shell 扩展版**
> （Wayland 桌面推荐）、**Windows 桌面版**、**Ubuntu/Linux 桌面版**，以及 **DSH 网页版插件**，
> 全部本地直连、自包含，无需打开网页。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Changelog](https://img.shields.io/badge/版本更新日志-CHANGELOG-blue)](CHANGELOG.md)

---

## 📦 项目简介

DSH 小鲸鱼是一套「DeepSeek 余额挂件」的完整实现，包含四种形态：

| 形态 | 目录 | 说明 |
|---|---|---|
| **GNOME Shell 扩展** | `dsh-whale-shell-extension/` | GNOME 45–47，**Wayland 桌面悬浮首选**：直接画在 Shell 层，天然置顶悬浮、可满屏拖动 |
| **Windows 桌面挂件** | `dsh-whale-desktop/` | 无边框透明置顶悬浮窗，鲸鱼浮在桌面、可满桌面拖动 |
| **Linux 桌面挂件** | `dsh-whale-desktop-linux/` | 适配 Ubuntu 22.04 / 24.04 amd64（x86_64），AppImage/deb（X11 会话） |
| **DSH 网页版插件** | `dsh-whale-widget/` | 基于 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT），随 dsh web 自动启用 |

各形态共用同一套余额数据与记账逻辑，**完全本地运行**：直接调 DeepSeek API 拉余额，不依赖 dsh web、
不用打开浏览器。

> 💡 **在 GNOME Wayland 上**：Mutter 不支持 wlr-layer-shell、Electron 透明窗也无法合成，
> 请直接使用 **GNOME Shell 扩展版**（见下方章节），这也是本仓库当前最活跃的形态。

## ✨ 特性

- 🐋 **桌面悬浮**：无边框、透明、始终置顶、覆盖整个桌面；鲸鱼可**满桌面拖动**（Windows / Linux / GNOME 扩展一致）
- 🧲 **四边四角吸附**：松手自动贴边/角，缩放与回家保持贴边（扩展版）
- 🖱️ **桌面宠物动效**：拖动跟手 60fps、摸摸头小跳、静置呼吸/飘音符/眨眼、余额数字 60fps 平滑滚动（扩展版）
- 💰 **实时余额**：默认 60s 自动刷新，点击鲸鱼手动刷新；余额变化数字滚动动画
- 📊 **今日已用**：记账模式（余额差值本地记账，跨天自动归零/归档 30 天）或令牌精算模式（读平台用量接口按峰谷计价），可随时切换
- 💬 **每轮消耗统计**：监听对话回合，弹出本轮消耗金额（网页版插件能力）
- 🎚️ **汉堡菜单**：大小、音色(6套)、音量、音效/气泡开关、用量模式、峰谷提示、峰谷文案风格、隐藏等
- 🔑 **菜单内改 API Key**：随时粘贴新 `sk-...` 保存即生效，无需改文件
- 🖱️ **点击穿透**：只有鲸鱼不透明像素/菜单可交互，其余区域不挡桌面操作（桌面版）
- ⚙️ **首次运行自动配置**：无配置时自动弹出设置窗口，填 API Key + 可选开机自启（桌面版）
- 🚀 **CI/CD**：GitHub Actions 自动构建 Windows exe 与 Linux AppImage/deb

## 📁 目录结构

```
dsh-whale/
├── README.md                       # 本文件（项目总文档）
├── CHANGELOG.md                    # 版本更新日志（桌面 v1.0 → 扩展版 v9–v30 …）
├── .github/workflows/build.yml     # CI：自动构建 Windows + Linux 产物
├── dsh-whale-shell-extension/      # ★ GNOME Shell 扩展版（Wayland 悬浮首选，当前主力迭代）
│   ├── extension.js                #   扩展主逻辑（ESM / GNOME 45+，含交互/动画/记账/令牌）
│   ├── metadata.json               #   uuid dsh-whale@local
│   ├── assets/                     #   鲸鱼 PNG + 12 个音效（6 套音色主题）
│   ├── install.sh / desktop-menu.sh / dsh-whale-widget.desktop
│   └── README.md                   #   扩展版专属说明（交互/菜单/配置）
├── dsh-whale-widget/               # DSH 网页版插件源码（第三方，MIT，vendored）
├── dsh-whale-desktop/              # Windows 桌面挂件（Electron）
│   ├── main.js                     #   主进程：本地服务(3090)+直连余额+透明置顶窗口
│   ├── preload.js                  #   像素级点击穿透
│   ├── widget.js                   #   小鲸鱼前端（静态副本）
│   ├── assets/                     #   图片/音效
│   ├── start-widget.ps1            #   启动脚本
│   ├── install-autostart.ps1       #   注册开机自启（计划任务）
│   └── uninstall-autostart.ps1
└── dsh-whale-desktop-linux/        # Linux 桌面挂件（Ubuntu 22.04/24.04 amd64）
    ├── main.js                     #   同 Windows 版，开机自启改 XDG autostart
    ├── preload.js / widget.js / assets/
    ├── build-linux.sh              #   一键构建 AppImage + deb
    ├── start-linux.sh              #   源码启动
    ├── install-autostart.sh        #   设置开机自启
    └── uninstall-autostart.sh
```

## 🏗️ 架构

```
┌────────────────────────────────────────────────────────┐
│  Electron 桌面挂件（Windows / Linux）                    │
│  无边框透明置顶窗口  ← 加载 →  本地页面(/dsh-whale/widget.js)│
│  主进程本地 HTTP 服务 (127.0.0.1:3090)                   │
│    ├─ /dsh-whale/balance.json ──→ DeepSeek API(直连)     │
│    ├─ /dsh-whale/widget.js / image.png / 音效 ← 本地文件 │
│    ├─ /dsh-whale/size.json ←→ 本地配置(~/.dsh/.dshw-*)  │
│    └─ /setup 首次配置窗口（API Key + 开机自启）           │
└────────────────────────────────────────────────────────┘
```

- **直连余额**：`https://api.deepseek.com/user/balance`，请求头 `Authorization: Bearer <DEEPSEEK_API_KEY>`
- **记账**：把每次观测到的余额差值累加为「今日已用」，写入 `~/.dsh/.dshw-usage.json`（跨天归零归档）
- **配置**：`~/.dsh/.credentials.yaml`（API Key）、`~/.dsh/.dshw-size.json`（挂件尺寸/开关）
- **跨平台**：路径一律用 `os.homedir()`/`path.join`，无 Windows 专属路径硬编码（开机自启除外，已按平台分支）

## 🐧 GNOME Shell 扩展版（Wayland 桌面推荐）

> 在 GNOME Wayland 会话实现“像 Windows 那样的悬浮小鲸鱼”的正解——直接作为 Shell 扩展渲染，
> 天然悬浮于所有普通窗口之上，透明 PNG + 动画 + 满屏拖动 + 点击，与动态壁纸等扩展互不冲突。

**安装（Ubuntu 24.04 / GNOME 46 已测，45–47 通用）**

```bash
cd dsh-whale-shell-extension
./install.sh                     # 复制到 ~/.local/share/gnome-shell/extensions/
# 注销 → 重新登录（Wayland 需重载 Shell 才会扫描新扩展）
gnome-extensions enable dsh-whale@local
```

**交互与菜单**（详细说明见 `dsh-whale-shell-extension/README.md`）

| 操作 | 效果 |
|---|---|
| 左键按住拖动 | 鲸鱼满屏跟手移动（60fps），松手自动贴四边/四角 |
| 左键轻点（不拖动） | 摸摸头：开心小跳 + 飘爱心音符 + 卖萌气泡 |
| 滚轮 / 菜单放大缩小 | 0.5×–2.5× 缩放，贴边状态保持 |
| 右键 | 汉堡菜单：查看余额 / 60s 自动刷新 / 回左下角 / 放大缩小 / 用量模式(记账·令牌) / 音色(6套) / 音量 / 音效开关 / 气泡开关 / 峰谷文案(3种) / 隐藏 |
| 气泡上单击 | 换一句台词 |

**数据与配置**：余额直连 `api.deepseek.com/user/balance`；今日已用默认为本地记账（差值累计、跨天归档 30 天），
可切换为令牌精算（读平台用量接口按峰谷计价，需配 `DEEPSEEK_PLATFORM_TOKEN`）；
凭据 `~/.dsh/.credentials.yaml`，偏好 `~/.cache/dsh-whale/prefs.json`。

## 🖥️ Windows 版

**运行**
```powershell
cd dsh-whale-desktop
node_modules\electron\dist\electron.exe .     # 或运行 start-widget.ps1
```

**开机自启**
```powershell
powershell -ExecutionPolicy Bypass -File install-autostart.ps1    # 注册（计划任务）
powershell -ExecutionPolicy Bypass -File uninstall-autostart.ps1  # 取消
```

**打包便携 exe / 部署**
```powershell
npm install
npx electron-builder --win portable
# 产物：dist\dsh-whale-widget-<版本>.exe（单个文件，拷到任意 Windows 电脑双击运行）
```
> 新电脑首次运行自动弹配置窗；exe 未签名时 SmartScreen 提示「更多信息 → 仍要运行」。

## 🐧 Linux 版（Ubuntu 22.04 / 24.04 amd64）

**环境**
```bash
# Node.js 20/22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
```

**构建**
```bash
cd dsh-whale-desktop-linux
./build-linux.sh          # 产出 dist/*.AppImage 与 *.deb
```

**运行 / 安装**
```bash
chmod +x dist/*.AppImage && ./dist/dsh-whale-widget-1.0.0-x64.AppImage
# 或
sudo dpkg -i dist/*.deb
```
> AppImage 需 `libfuse2`（Ubuntu 22.04 常见）：`sudo apt-get install -y libfuse2`；
> sandbox 报错可加 `--no-sandbox`。

**开机自启**
```bash
./install-autostart.sh "/绝对路径/到/xxx.AppImage"
./uninstall-autostart.sh
```

## 🔌 DSH 网页版插件（dsh-whale-widget）

随 `dsh web` 自动启用（标准 DSH bundle 插件）。安装方式见 `dsh-whale-widget/README.md`：

```powershell
dsh plugin --profile web add link:C:\...\dsh-whale\dsh-whale-widget
```

> 该目录为第三方插件源码（MIT），已 vendored 进本仓库并保留 LICENSE；上游：
> https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget

## 🔑 配置说明（API Key）

- **必需**：`DEEPSEEK_API_KEY`，用于拉余额（`api.deepseek.com/user/balance`）
- 存放位置：`~/.dsh/.credentials.yaml`（格式 `version: 1` + `refs:`），或环境变量
- 在挂件菜单里（最下方 API Key 输入框）可随时修改并保存，立即生效
- `DEEPSEEK_PLATFORM_TOKEN` 可选：仅「实时·令牌」用量模式需要，不配也能用默认记账模式

## ⚙️ CI/CD

仓库已内置 GitHub Actions（`.github/workflows/build.yml`）：

- 推送到 `main`/`master` 或打 `v*` tag 时自动构建
- **linux**：Ubuntu 22.04 上构建 AppImage + deb（amd64）
- **windows**：Windows 上构建便携 exe
- 产物以 **Artifacts** 形式提供下载；可在此基础上加 Release 发布（`softprops/action-gh-release`）

## 🛠️ 开发

```bash
# 桌面版开发（Windows 或 Linux 任一）
cd dsh-whale-desktop          # Windows
# cd dsh-whale-desktop-linux  # Linux
npm install
npm start                      # electron .
```

- `main.js`：主进程（本地服务、直连余额、记账、窗口、托盘、开机自启）
- `preload.js`：点击穿透命中检测
- `widget.js`：小鲸鱼前端（可从插件 `/dsh-whale/widget.js` 同步更新静态副本）
- 改代码后重启：Windows `Stop-Process -Name electron -Force`；Linux `pkill -f electron` 后重启

## ❓ 常见问题

| 问题 | 解决 |
|---|---|
| GNOME Wayland 下 Electron 悬浮窗不显示/不悬浮 | 改用本仓库 **GNOME Shell 扩展版**（`dsh-whale-shell-extension`） |
| 余额显示「未配置 DEEPSEEK_API_KEY」 | 在 `~/.dsh/.credentials.yaml` 填写或在挂件菜单 API Key 框填入 `sk-...` 并保存 |
| 扩展更新后不生效 | 注销 → 重新登录（Wayland 需重载 Shell） |
| 想用令牌精算今日已用 | 扩展右键菜单「📒 用量」切到令牌，需先在凭据里配 `DEEPSEEK_PLATFORM_TOKEN` |
| AppImage 打不开 | `sudo apt-get install -y libfuse2` |
| sandbox 报错 | 加 `--no-sandbox` 启动参数 |
| Linux 托盘不显示 | 装 AppIndicator 扩展（GNOME） |
| 端口 3090 被占用 | 先关闭其他挂件实例 |
| 想换 API Key | 菜单里直接改，秒级生效 |

## 📋 版本更新日志

所有形态的版本历史（桌面版 v1.0 起步；扩展版 v9→v30 逐版演进：贴边吸附 / 半屏镜像 / 右键菜单 / 摸摸头 / 静置动效 /
今日已用记账 / 60s 自动轮询 / 数字滚动 / 音色主题 / 令牌精算 / 动画流畅度……）见 **[CHANGELOG.md](CHANGELOG.md)**。

## 📄 许可证

- 本项目（桌面挂件 Windows/Linux 版、GNOME 扩展版、文档、CI）：**MIT**
- `dsh-whale-widget/`：第三方插件，**MIT**，版权归原项目作者，见其 `LICENSE`

