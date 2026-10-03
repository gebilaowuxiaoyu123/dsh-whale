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
| **Windows 桌面挂件** | `dsh-whale-desktop/` | 无边框透明悬浮窗（**默认不置顶**：应用窗口会盖住它，它仍在桌面图标之上；托盘可开「置顶显示」），鲨鱼浮在桌面、可满桌面拖动 |
| **Linux 桌面挂件** | `dsh-whale-desktop-linux/` | 适配 Ubuntu 22.04 / 24.04 amd64（x86_64），AppImage/deb |
| **DSH 网页版插件** | `dsh-whale-widget/` | 上游 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT）**v0.3.17** 的原样 vendored 副本，随 dsh web 自动启用 |

三者都**完全本地运行**：直接调 DeepSeek API 拉余额，不依赖 dsh web、不用打开浏览器。
其中两个桌面版共用同一套实现与记账逻辑；网页版插件是上游独立实现，功能更全（见下文）。

> 💡 **在 GNOME Wayland 上**：Mutter 不支持 wlr-layer-shell、Electron 透明窗也无法合成，
> 请直接使用 **GNOME Shell 扩展版**（见下方章节），这也是本仓库当前最活跃的形态。

## ✨ 特性

- 🐋 **桌面悬浮**：无边框、透明、覆盖整个桌面；鲨鱼可**满桌面拖动**（Windows / Linux / GNOME 扩展一致）
- 📌 **置顶显示（默认关）**：默认层级是 **应用窗口 > 挂件 > 桌面图标** —— 看视频、全屏时挂件不会挡在前面；
  托盘菜单里勾上「置顶显示」就回到「浮在所有窗口之上」（桌面版；Linux 版同时切 DOCK/NORMAL 窗口类型）
- 🧲 **四边四角吸附**：松手自动贴边/角，缩放与回家保持贴边（扩展版）
- 🖱️ **桌面宠物动效**：拖动跟手 60fps、摸摸头小跳、静置呼吸/飘音符/眨眼、余额数字 60fps 平滑滚动（扩展版）
- 💰 **实时余额**：默认 60s 自动刷新，点击鲸鱼手动刷新；余额变化数字滚动动画
- 📊 **今日已用**：默认「小鲸鱼记账」模式（余额差值本地记账，跨天自动归零），无需令牌
- 💬 **每轮消耗统计**：监听对话回合，弹出本轮消耗金额（依赖 DSH 会话事件，桌面版独立运行时此项自动跳过）
- 🎚️ **汉堡菜单**：大小(0.6–2.5×)、音效、音量、用量模式、峰谷提示、气泡开关等
- 🔑 **菜单内改 API Key**：随时粘贴新 `sk-...` 保存即生效，无需改文件
- 🖱️ **点击穿透**：只有鲸鱼不透明像素/菜单可交互，其余区域不挡桌面操作（桌面版）
- ⚙️ **首次运行自动配置**：无配置时自动弹出设置窗口，填 API Key + 可选开机自启（桌面版）
- 🚀 **CI/CD**：GitHub Actions 自动构建 Windows exe 与 Linux AppImage/deb
- 🛡️ **双系统（Windows + Ubuntu）引导安全**：Ubuntu 侧 i915 稳定化 + GPU 看门狗（挂死自动救回会话，
  不用再长按电源键）；Windows 侧一键体检/保障（关快速启动与自动重启、复原被篡改的 bootmgr、ubuntu 置顶）
  —— 见 [`docs/dualboot-boot-safety.md`](docs/dualboot-boot-safety.md)

## 📁 目录结构

```
dsh-whale/
├── README.md                       # 本文件（项目总文档）
├── CHANGELOG.md                    # 版本更新日志（桌面 v1.0 → 扩展版 v9–v30 …）
├── docs/
│   ├── linux-adaptation-plan.md    # ★ Linux 适配规划：实机基线 / 风险登记 / DoD / 测试方案
│   ├── coopanion-integration.md    # ★ Coopanion 桌宠集成说明（安装 / 踩坑记录 / 使用要点）
│   └── dualboot-boot-safety.md     # ★ 双系统引导安全：事故取证 / 结论 / 两端口径与保障
├── .github/workflows/build.yml     # CI：自动构建 Windows + Linux 产物
├── dsh-whale-shell-extension/      # ★ GNOME Shell 扩展版（Wayland 悬浮首选，当前主力迭代）
│   ├── extension.js                #   扩展主逻辑（ESM / GNOME 45+，含交互/动画/记账/令牌）
│   ├── metadata.json               #   uuid dsh-whale@local
│   ├── assets/                     #   鲸鱼 PNG + 12 个音效（6 套音色主题）
│   ├── install.sh / desktop-menu.sh / dsh-whale-widget.desktop
│   └── README.md                   #   扩展版专属说明（交互/菜单/配置）
├── tools/
│   ├── ledger-compat-test.mjs      # 账本兼容性测试（桌面版 ↔ 插件共用账本）
│   ├── desktop-plugin-integration-test.mjs  # 桌面版运行插件本体的端到端集成测试（路由/鉴权）
│   ├── desktop-ui-smoke-test.mjs   # UI 冒烟测试（用 CDP 查真实 DOM，需调试模式启动挂件）
│   ├── desktop-button-audit.mjs    # 按钮全覆盖检查（逐面板验证可见按钮可命中/可交互）
│   ├── desktop-always-on-top-test.mjs # 「置顶显示」开关自检（读写 + 落盘 + 恢复原值）
│   ├── setup-coopanion.ps1         # Coopanion 桌宠一键安装/更新（Windows；源码放 third-party/，不入库）
│   ├── setup-coopanion.sh          # Coopanion 桌宠一键安装/更新（Linux）
│   ├── coopanion-autostart.ps1     # Coopanion 开机自启 登记/撤销/查看（Windows，自启不弹调试界面）
│   ├── coopanion-autostart.sh      # Coopanion 开机自启 登记/撤销/查看（Linux，XDG）
│   ├── coopanion-feature-test.mjs  # 桌宠改造自检：补丁是否打上 + 构建产物是否跟上（24 项）
│   ├── coopanion-sync-roam-test.mjs # 「随刷新率」走动自检：读数/速度/不滑步（19 项）
│   ├── freeze-fix/                 # ★ Ubuntu 侧：GPU 挂死取证与防护（i915 稳定化 / GPU 看门狗 / 修 fstab+引导）
│   └── boot-safety/                # ★ Windows 侧：双系统引导体检 + 保障（关自动修复 / 复原 bootmgr / ubuntu 置顶）
├── patches/
│   └── coopanion/                  # 对 Coopanion 源码的改造补丁（AGPL 源码不入库，只存 diff）
│       └── 0001-dsh-pet-features.patch  # 调试入口按钮 + 随刷新率走动 + 开机自启不弹窗 + 置顶显示开关 + Linux 覆盖层
├── dsh-whale-widget/               # DSH 网页版插件源码（第三方 MIT，vendored 上游 v0.3.17）
│                                   #   ← 同时是桌面版的**唯一功能实现来源**
├── third-party/                    # 第三方项目源码，**不入库**（已被根 .gitignore 忽略）
│   └── Coopanion/                  #   Coopanion 桌宠（AGPL-3.0-or-later，用 tools/setup-coopanion.ps1 复原）
├── dsh-whale-desktop/              # Windows 桌面挂件（Electron）
│   ├── main.js                     #   主进程：本地服务(3090)+窗口(默认不置顶)/托盘/自启+插件宿主
│   ├── host-shim.js                #   DSH 宿主契约适配层：让插件本体在本机 HTTP 服务里运行
│   ├── preload.js                  #   像素级点击穿透
│   ├── widget.js                   #   回退用前端（插件不可用时启用）
│   ├── assets/                     #   回退用图片/音效
│   ├── start-widget.ps1            #   启动脚本
│   ├── install-autostart.ps1       #   注册开机自启（计划任务）
│   └── uninstall-autostart.ps1
└── dsh-whale-desktop-linux/        # Linux 桌面挂件（Ubuntu 22.04/24.04 amd64）
    ├── main.js                     #   同 Windows 版，开机自启改 XDG autostart
    ├── host-shim.js                #   同 Windows 版
    ├── preload.js / widget.js / assets/
    ├── build-linux.sh              #   一键构建 AppImage + deb
    ├── start-linux.sh              #   源码启动
    ├── install-autostart.sh        #   设置开机自启
    └── uninstall-autostart.sh
```

## 🏗️ 架构

**核心设计：桌面版直接运行网页版插件本体**（而不是复刻一份会过时的静态副本）

```
┌──────────────────────────────────────────────────────────────┐
│  Electron 桌面挂件（Windows / Linux）                          │
│  无边框透明置顶窗口 ← 加载 → /dsh-whale/widget.js（插件提供）   │
│                                                              │
│  main.js  主进程本地 HTTP 服务 (127.0.0.1:3090)                │
│    ├─ 插件路由优先：dsh-whale-widget/lib/index.js（23 条路由）  │
│    │    ← host-shim.js 提供 DSH 宿主契约（webServer/credentials）│
│    ├─ 未命中则走内置实现（回退网，插件不可用时挂件仍可用）        │
│    └─ 桌面版特有：/setup、apikey、autostart、first-run-done     │
└──────────────────────────────────────────────────────────────┘
```

- **功能与网页版插件完全一致**：余额 / 记账 / 多厂商额度 / 自定义角色·音效·泡泡图 / 余额校正等
  **23 条路由**全部由插件本体提供；插件目录是唯一实现来源，**以后更新插件桌面版自动同步**
- **宿主适配层 `host-shim.js`**：实现插件要求的 `root.effect/on/inject`、`ctx.webServer.register`、
  `ctx.credentials.resolve/set`（读写 `~/.dsh/.credentials.yaml`）。缺失的 DSH 可选服务
  （connection / sessionTitle / deepseekAccount）返回 `null` → 插件自动降级到它**自带的回环+同源校验**
  （伪造 Host / 跨站写请求均被 403），并跳过依赖 DSH 会话的功能（每轮消耗、wait.json）
- **页面自检适配（易踩坑）**：插件前端开头有一段自检 —— 只在「能查到 composer 输入区
  （`textarea` / `[data-composer-input]` 等）的 DSH 主聊天界面」才挂载挂件，否则一行 DOM 都不碰
  （避免干扰 DSH 的 SPA 视图）。桌面版加载的不是 DSH 页面，所以 `PAGE` 里放了一个**不可见、
  不参与布局的占位节点**（`#root > textarea`）让自检通过 —— 缺了它会出现「23 条路由全部 200、
  但挂件一个节点都不渲染」的现象
- **点击穿透判定（易踩坑）**：`preload.js` 判断「鼠标是否在可交互区域」时**不能硬编码类名** ——
  插件 v0.3.17 有 300+ 个 `.dshwv-*` 类名，只认几个类名会让新增面板（设置面板/遮罩/资源列表…）
  整体落在检测范围外，现象是「**面板按钮全点不动、关不掉**」。现按 CSS `pointer-events` 语义
  通用判定（容器 `none`、可交互元素 `auto`），插件以后新增 UI 自动覆盖；鲸鱼本体仍按**不透明像素**
  判定以保持原有手感
- **退出挂件的方式**：窗口为无边框、不进任务栏的悬浮窗（`frame:false` + `skipTaskbar`），
  因此没有标题栏关闭按钮 —— 请**右键系统托盘的小鲸鱼图标 → 退出**（面板上的「取消/保存」只关面板）
- **回退网**：插件加载失败（文件缺失、语法错误等）时自动回退到内置路由实现，挂件始终可用
- **记账**：`~/.dsh/.dshw-usage.json` 与插件共用同一本账（`accounting.books` 按 API key 指纹分本）
- **配置**：`~/.dsh/.credentials.yaml`（API Key）、`~/.dsh/.dshw-size.json`（挂件尺寸/开关），均与插件共用
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

> ⚠️ **Linux 上「点击穿透」存在平台限制，需实机验证。** 桌面版用 `setIgnoreMouseEvents(true, {forward: true})`
> 实现「只有鲸鱼/面板可点、其余区域穿透给桌面」，但该 `forward` 参数**官方仅支持 macOS / Windows**；
> Linux 下窗口一旦穿透就收不到 `mousemove`，而唤醒逻辑正是依赖它 —— 桌面版在 Linux 上的**可交互性
> 必须实测确认**。另 `setAlwaysOnTop` / `setPosition` 在 Wayland 下不生效，故建议在 X11 会话或 XWayland
> 下使用；**Ubuntu 24.04 默认 Wayland**，这也是本仓库同时提供上方 GNOME Shell 扩展版的原因。
> 完整实机调研、风险登记、验收标准与测试方案见 **[docs/linux-adaptation-plan.md](docs/linux-adaptation-plan.md)**。

> 打包时插件目录经 `extraResources` 随包分发；插件自己的 `package.json` 必须一起带上
> （其 ESM 代码依赖它声明 `type: module`）。

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

> **该目录为上游第三方源码的原样 vendored 副本**（MIT，保留 `LICENSE` 与素材来源说明 `PROVENANCE.md`）：
> - 上游：https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget
> - 当前版本：**v0.3.17**（上游 tag `v0.3.17`，更新于 2026-09-29）
> - 维护方式：整目录覆盖上游对应版本、不做本地改动，便于日后 diff 与追溯
> - 上游分支格局（同仓库多条**独立产品线**，勿混用）：
>
> | 分支 | 版本 | 形态 | 与本仓库关系 |
> |---|---|---|---|
> | `main` | **v0.3.17** | DSH Web 插件（兼官方桌面端插件形态） | ✅ 本目录即其原样 vendored 副本 |
> | `For–WinDesktop` | v2.0.0（`ds-desktop-whale`） | 独立 **Windows** 桌面版（Tauri v2 + echarts） | ❌ 平台/运行时不同，Linux 不可用 |
> | `For-Codex` | v0.3.0 | Codex 桌面应用端口 | ❌ 产品形态不同 |
> | `For-Windows` | v0.2.0 | 旧 Windows 线（2026-08-20 后未再更新） | ❌ 已停更 |

### 本次更新要点（v0.2.10 → v0.3.17）

- 🩹 **v0.3.17**：②区「提示音量」死控件修复（音量解析器 + 三态，含音效组）、②区「冒泡提示」开关接上、
  设置保存失败可见化、等待提问/授权气泡可点关，新增死键体检护栏 `tools/check-dead-settings.mjs`
- 🔒 **安全修复（重要）**：v0.3.15 修掉「任意 DSH Web 会话可让宿主动用真实 API key 去请求攻击者可控 URL」的**凭据外带**；写请求（POST/PUT/PATCH/DELETE）自 0.3.15 起仅允许本机来源
- 🏢 **多厂商额度**：内置 33 个厂商模板，可自定义接口地址与模型
- 🎨 **外观与交互**：自定义泡泡点击序列、逐行样式与字体、自定义角色/动图/音效、吸附与翻转自定义
- 🔔 **音效与提示面板**：任务结束音（Minecraft 经验球 / 预设 A）、四入口面板、每事件音量与试听
- 💬 **对话名模块**、**DSH 账号登录态读余额**、**记账按密钥分本**（换 key 后历史账目仍可查看）
- 🧩 **前端拆分**：前端由内嵌改为独立文件 `assets/whale-widget.js`
- 🖥️ **桌面版同步**：两个桌面版通过 `host-shim.js` **直接运行本插件本体**，功能与网页版一致
- 🔧 新增维护脚本 `tools/`（CI 不变量自检，可本地跑 `node tools/ci-audit.mjs --no-pack`，当前 5/5 通过）

> 🔗 **桌面版直接复用本插件**：两个桌面版（`dsh-whale-desktop*`）已通过 `host-shim.js`
> **直接运行本插件本体**，因此功能和网页版插件完全一致（23 条路由），且本目录是
> **唯一实现来源** —— 以后更新插件，桌面版自动同步，无需再逐条适配。详见上文「🏗️ 架构」。

## 🔑 配置说明（API Key）

- **必需**：`DEEPSEEK_API_KEY`，用于拉余额（`api.deepseek.com/user/balance`）
- 存放位置：`~/.dsh/.credentials.yaml`（格式 `version: 1` + `refs:`），或环境变量
- 在挂件菜单里（最下方 API Key 输入框）可随时修改并保存，立即生效
- `DEEPSEEK_PLATFORM_TOKEN` 可选：仅「实时·令牌」用量模式需要，不配也能用默认记账模式

## 📊 记账与账本（桌面版 ↔ 插件共用）

- 「今日已用」由**余额差值本地记账**得出，账本文件：`~/.dsh/.dshw-usage.json`
- 两个桌面版与网页版插件**共用同一本账**，按 **API key 指纹分本**（同一把 key = 同一本账；
  换 key 等于换一本，旧账仍保留在账本里，**不会丢**）
- 账本格式与插件 `lib/accounting.mjs` 对齐：`accounting.books["<scope>-<币种>"].days[<日期>]`，
  并同时维护旧版兼容字段（`date` / `lastBalance` / `todayUsage` / `history`）
- **兼容性保障**：自 2026-09-28 起桌面版已对齐新格式 —— 跨天首次运行、换 key 等场景
  **不会再覆盖插件的记账历史**（旧实现在跨天时会整体重建账本对象，从而丢掉 `accounting.books`）
- 自测：`node tools/ledger-compat-test.mjs`（提取桌面版真实记账代码与插件模块对测，25 项断言）

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
| 接/拔外接显示器后鲸鱼「不见了」 | 已知问题：扩展暂未处理显示器热插拔的几何变化；注销重登，或把鲸鱼拖回屏内。修复计划见 **[docs/linux-adaptation-plan.md](docs/linux-adaptation-plan.md)** |
| 触屏上打不开菜单 | 已知限制：菜单目前只有右键入口，触屏长按入口在适配计划中（见 **[docs/linux-adaptation-plan.md](docs/linux-adaptation-plan.md)**） |
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

---

### Coopanion（鲸鱼娘桌宠）Linux 版与 NVIDIA 预制配置

上游 Coopanion 的 Linux 版原本「开发不完全」（桌宠窗口压根不会出现）。本次修掉了
4 个根因（子进程不继承 ozone 平台参数、Linux 上 `setIgnoreMouseEvents` 是空操作、
形状上报把全屏 SVG 容器算进去、`setShape` 后未 invalidate），并做到 **26 项端到端自检全绿**
（含逐按钮真实点击 + 截屏审查）。Linux NVIDIA 显卡对接为**预制件**（本机无 N 卡，
检测到无卡时零副作用）。

详见 [`docs/coopanion-linux-and-nvidia.md`](docs/coopanion-linux-and-nvidia.md)。
