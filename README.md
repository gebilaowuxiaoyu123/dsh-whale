# 🐋 DSH 小鲸鱼桌面挂件（DSH Whale Widget）

> 一只住在你屏幕角落的小鲸鱼娘，实时显示 DeepSeek 账户余额与今日消耗。可选 **Windows 桌面版**、
> **Ubuntu/Linux 桌面版**，以及 **DSH 网页版插件**，全部本地直连、自包含，无需打开网页。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 📦 项目简介

DSH 小鲸鱼是一套「DeepSeek 余额挂件」的完整实现，包含三种形态：

| 形态 | 目录 | 说明 |
|---|---|---|
| **Windows 桌面挂件** | `dsh-whale-desktop/` | 无边框透明置顶悬浮窗，鲸鱼浮在桌面、可满桌面拖动 |
| **Linux 桌面挂件** | `dsh-whale-desktop-linux/` | 适配 Ubuntu 22.04 / 24.04 amd64（x86_64），AppImage/deb |
| **DSH 网页版插件** | `dsh-whale-widget/` | 基于 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT），随 dsh web 自动启用 |

三者共用同一套余额数据与记账逻辑，**完全本地运行**：直接调 DeepSeek API 拉余额，不依赖 dsh web、
不用打开浏览器。

## ✨ 特性

- 🐋 **桌面悬浮**：无边框、透明、始终置顶、覆盖整个桌面；鲸鱼可**满桌面拖动**（Windows 与 Linux 一致）
- 💰 **实时余额**：默认 60s 自动刷新，点击鲸鱼手动刷新；余额变化数字滚动动画
- 📊 **今日已用**：默认「小鲸鱼记账」模式（余额差值本地记账，跨天自动归零），无需令牌
- 💬 **每轮消耗统计**：监听对话回合，弹出本轮消耗金额（网页版插件能力）
- 🎚️ **汉堡菜单**：大小(0.6–2.5×)、音效、音量、用量模式、峰谷提示、气泡开关等
- 🔑 **菜单内改 API Key**：随时粘贴新 `sk-...` 保存即生效，无需改文件
- 🖱️ **点击穿透**：只有鲸鱼不透明像素/菜单可交互，其余区域不挡桌面操作
- ⚙️ **首次运行自动配置**：无配置时自动弹出设置窗口，填 API Key + 可选开机自启
- 🚀 **CI/CD**：GitHub Actions 自动构建 Windows exe 与 Linux AppImage/deb

## 📁 目录结构

```
dsh-whale/
├── README.md                       # 本文件（项目总文档）
├── .github/workflows/build.yml     # CI：自动构建 Windows + Linux 产物
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
| 余额显示「未配置 DEEPSEEK_API_KEY」 | 在挂件菜单 API Key 框填入 `sk-...` 并保存 |
| AppImage 打不开 | `sudo apt-get install -y libfuse2` |
| sandbox 报错 | 加 `--no-sandbox` 启动参数 |
| Linux 托盘不显示 | 装 AppIndicator 扩展（GNOME） |
| 端口 3090 被占用 | 先关闭其他挂件实例 |
| 想换 API Key | 菜单里直接改，秒级生效 |

## 📄 许可证

- 本项目（桌面挂件 Windows/Linux 版、文档、CI）：**MIT**
- `dsh-whale-widget/`：第三方插件，**MIT**，版权归原项目作者，见其 `LICENSE`

