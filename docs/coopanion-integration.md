# Coopanion 桌宠集成说明

## 这是什么

[Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 是 Pal-AI-Lab 的桌面伴侣 —— 桌宠 **Coo**
住在屏幕底边，会聊天、听你说话、能在你允许时帮你操作电脑。它由 Cortico 框架组装而成。

它内置 **「DeepSeek 大肥鱼」** 形象：一只 Q 版鲸鱼女仆，**分件制作的 Live2D 式全动态模型**
（走 / 跑 / 跳 / 坐下 / 睡觉 / 被鼠标拎起来甩 / 转身 / 眨眼 / 跟着鼠标看，十几种表情；
头发、裙摆、尾巴、鲸鱼鳍和呆毛会跟着动作晃），另有八套厂商主题配色
（DeepSeek / DeepSeek Harness / ChatGPT / Claude / Gemini / 千问 / Kimi / MiniMax）。

## 为什么放在 `third-party/` 且不入库

| 原因 | 说明 |
|---|---|
| **许可** | Coopanion 是 **AGPL-3.0-or-later**（强 copyleft），本仓库是 MIT，**不应**把 AGPL 源码并入 |
| **惯例** | 仓库根 `.gitignore` 已忽略 `third-party/`（见提交 `0959ff0 chore: gitignore third-party`）|
| **体积** | 含子模块与 `node_modules`，远超仓库合理体积 |

因此：**源码放在 `third-party/Coopanion/`（不进入版本库）**，本仓库只保留「安装脚本 + 本文档」，
任何时候都能一键复原。

## 一键安装

### Windows

```powershell
# 首次安装并启动
powershell -ExecutionPolicy Bypass -File tools\setup-coopanion.ps1 -Run

# 更新到最新版并启动
powershell -ExecutionPolicy Bypass -File tools\setup-coopanion.ps1 -Update -Run
```

### Linux

```bash
# 首次安装（-r 装完直接启动）
./tools/setup-coopanion.sh -r

# 更新到最新版并启动
./tools/setup-coopanion.sh -u -r
```

两个脚本做的是同一件事：拉源码与子模块 → `pnpm install` → 补 Electron 二进制 →
**打上本仓库的改造补丁** → `build:cortico`（构建控制台页面）。

## 本仓库的改造（补丁形式，不入库）

Coopanion 是别人的 AGPL 代码，所以**改造不直接改在仓库里**，而是存成补丁：

```
patches/coopanion/0001-dsh-pet-features.patch
```

安装/更新脚本会自动打上（幂等：已打过就跳过；打不上只报警不硬来）。补丁共五件事：

| 改造 | 落在哪 | 说明 |
|---|---|---|
| **聊天框左侧的调试入口** | `web/pet-app.js`、`web/pet.css` | 双击桌宠弹出的输入框，左边多一个小齿轮；一按经 World 的 `control/settings` 打开本地控制台（`http://127.0.0.1:17788/`）。没有嵌入方时这个按钮不显示，而不是给一个按了没用的键 |
| **「随刷新率」走动模式** | `web/pet-core.js`、`web/pet-app.js`、`src/config.ts`、`console/features/pet/index.ts` | 第四种行为模式：按帧间隔量屏幕刷新率，速度按 `hz/60` 缩放（夹在 0.5×~3×）；**步频同步乘同一个系数**，所以每个步幅周期走过的距离不变 —— 不会滑步。菜单里会写「屏幕约 N Hz」 |
| **「置顶显示」开关（默认关）** | `src/config.ts`、`src/world.ts`、`src/window-host.ts`、`host/electron-main.cjs`、`host/preload.cjs`、`web/pet-app.js`、`console/features/pet/index.ts` | 上游窗口是 `alwaysOnTop: true` + `screen-saver` 级别 —— 连全屏应用都在它下面。现在默认**关**：桌宠只是普通窗口，**应用窗口盖住它、它仍在桌面图标之上**；控制台「习惯」页勾上就回到浮在所有窗口之上。改动实时生效：配置 → World 快照 → 页面 `prefs` → `petHost.setAlwaysOnTop` → 主进程；启动初值随 `--always-on-top=0\|1` 传给窗口进程 |
| **开机自启（未打包也能用）** | `app/main.cjs` | 托盘里的「开机自动启动」原来被 `app.isPackaged` 挡着；现在把启动命令行显式写成 `<electron> <应用目录> --background`，另加命令行开关 `--set-autostart=on|off` |
| **自启时不弹调试界面** | `app/main.cjs`、`core/companion.ts` | `--background` 会传成 `CORTICO_START_BACKGROUND=1`，引导流程里那句「桌宠没连上就打开设置窗」被跳过 |

> 改动要**手工改源码**时：改完用 `git -C third-party/Coopanion diff --no-color --output=patches/coopanion/0001-dsh-pet-features.patch`
> 重新生成补丁，否则下次更新会把你的改动冲掉。`tools\coopanion-feature-test.mjs` 会检查这一致性。

## 手动步骤（等价）

```bash
git clone --depth 1 https://github.com/Pal-AI-Lab/Coopanion.git third-party/Coopanion
git -C third-party/Coopanion submodule update --init --depth 1 vendor/cortico
pnpm --dir third-party/Coopanion install
pnpm --dir third-party/Coopanion run build:cortico
git -C third-party/Coopanion apply patches/coopanion/0001-dsh-pet-features.patch
pnpm --dir third-party/Coopanion start
```

## 踩坑记录（本机实测）

### 1. Electron 二进制不会自动下载 ⚠️

pnpm 10+ 默认**阻止依赖的 postinstall 脚本**（安全特性），electron 的下载脚本因此不执行，
启动时报：

```
Downloading Electron binary...
TypeError: fetch failed
Error: Electron failed to install correctly.
```

**解决（走国内镜像，实测有效）：**

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
cd third-party\Coopanion\node_modules\electron
node install.js
```

> `pnpm rebuild electron` 同样受构建脚本策略限制，**直接跑 `install.js` 最可靠**。

### 2. pnpm 命令必须显式指定目录

在本仓库根直接 `pnpm start` 会报 `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`（根目录没有 package.json）。
统一用 `pnpm --dir <路径> <script>`。

### 3. 子模块不会随浅克隆拉取

`git clone --depth 1` 不会拉子模块，`vendor/cortico` 会是空目录，需补：

```powershell
git -C third-party/Coopanion submodule update --init --depth 1 vendor/cortico
```

### 4. 改了前端却不重构 = 看不到新功能 ⚠️

内部有两套前端，更新路径**不一样**：

| 改的是 | 怎么生效 |
|---|---|
| `packages/cortico-world-desktop-pet/web/*`（桌宠页本体） | 服务器每个请求都现读文件，**刷新页面就生效**，不用构建 |
| `console/**`（控制台页面） | 是打包产物，必须 `pnpm --dir <目录> run build:cortico`，然后重启应用 |

「随刷新率」这个新选项在控制台「习惯」页里 —— 只打补丁不重构，控制台就还是三个选项。
`tools\coopanion-feature-test.mjs` 会直接检查构建产物里有没有它。

### 5. 首次启动 60 秒后设置窗会自己弹出来

`core/companion.ts` 的引导流程里有一句：桌宠页面在 60 秒内没连上，就把设置窗打开
（否则用户看不到任何解释）。这就是「开机自启却弹了调试界面」的出处。
补丁的 `--background` 就是关掉这一句；手动双击启动不受影响。

## 开机自启

要的是「跟 DSH 小挂件一样：登录后自动起来，但**不**默认打开调试界面」。
自启条目由 Coopanion 自己写（`app/main.cjs`），脚本只是替你拨那个开关，
所以它和托盘菜单里的「开机自动启动」是**同一个条目**，不会出现两份。

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File tools\coopanion-autostart.ps1            # 登记
powershell -ExecutionPolicy Bypass -File tools\coopanion-autostart.ps1 status     # 查看
powershell -ExecutionPolicy Bypass -File tools\coopanion-autostart.ps1 uninstall  # 撤销
```

```bash
# Linux
./tools/coopanion-autostart.sh             # 登记
./tools/coopanion-autostart.sh status      # 查看
./tools/coopanion-autostart.sh uninstall   # 撤销
```

- **Windows**：`HKCU\...\CurrentVersion\Run` 里的一条启动项，命令行带 `--background`
- **Linux**：XDG 自启条目 `~/.config/autostart/coopanion.desktop`，同样带 `--background`

启动时的实际行为（已做过 A/B 对照实测）：

| 启动方式 | 桌宠 | 托盘图标 | 调试界面 |
|---|---|---|---|
| 开机自启（`--background`） | ✅ 出现 | ✅ 出现 | ❌ **不弹** |
| 手动双击 / `pnpm start` | ✅ 出现 | ✅ 出现 | 只在桌宠连不上时才弹（原行为） |

## Linux 版

`tools/setup-coopanion.sh` 与 `tools/coopanion-autostart.sh` 就是 Linux 版，
Coopanion 上游本身已按平台分好了分支，补丁也是平台无关的。三个前提：

1. **需要 X11**。Wayland 会话下走 XWayland —— Coopanion 启动时自己加 `--ozone-platform=x11`，
   因为 Wayland 不允许窗口自己摆位置、也不能常驻置顶，而桌宠正是靠这两点活着。
   纯 Wayland（没有 XWayland）跑不起来。
2. **小鲸鱼是 WebGL 画的**。没有可用 GPU 的机器（虚拟机、部分驱动）靠 SwiftShader 软件渲染，
   应用自带 `--enable-unsafe-swiftshader`；没有它就只有声音没有身体。
3. **托盘要有 StatusNotifier / AppIndicator 宿主**（GNOME 需装 AppIndicator 扩展）。
   没有托盘也能用：右键桌宠本身就带菜单，暂停 / 设置 / 退出都在里面。

数据目录：打包版在 `~/.config/Coopanion`；从源码跑是 `<安装目录>/build/data`。

## 自检脚本

改完代码、交付之前跑这两个：

```bash
node tools/coopanion-feature-test.mjs    # 补丁是否打上 + 构建产物是否跟上（24 项）
node tools/coopanion-sync-roam-test.mjs  # 「随刷新率」的数学：读数 / 速度 / 不滑步（19 项）
```

第二个用受控时钟按固定帧间隔推进 `pet-core` 的模拟，直接量出巡航速度与每步幅周期的位移，
不需要开窗口；它验证的关键性质是：**各刷新率下每个步幅周期的位移一致（37.14 px）**，
也就是速度变了、脚不会滑。

## 使用要点

- **首次启动**：Coo 从屏幕顶部掉到底边，托盘区出现图标，**不会弹出任何窗口**
- **配置模型**：右键 Coo → 设置（或点托盘图标），填 API Key（默认推荐 DeepSeek）
- **换形象**：设置窗口「装扮」页 → 形象 → **DeepSeek 大肥鱼**
- **改走动方式**：设置窗口「习惯」页 → 走动，四选一：常走动 / 多待着 / 不乱动 / **随刷新率**
  （也可以右键 Coo → 行为模式，点一下轮换；停在「随刷新率」时提示里会写当前屏幕约多少 Hz）
- **改层级**：设置窗口「习惯」页 → **置顶显示**。默认**关** —— 打开的应用窗口会盖住桌宠，
  桌宠仍在桌面图标之上（看视频/全屏时不再挡在前面）；勾上就回到「浮在所有窗口之上」
- **快速开调试界面**：双击 Coo → 输入框左边的小齿轮
- **退出**：右键托盘图标 → 退出（**关掉设置窗口不会退出程序**）
- **数据目录**：`third-party/Coopanion/build/data`（从源码跑时；记忆 / 设置 / 日志都在这里，重装不丢）

## 与本仓库其它形态的关系

本仓库原本是「DSH 小鲸鱼桌面挂件」（Windows / Linux 桌面版 + DSH 网页版插件），
与 Coopanion **相互独立、没有代码依赖**：

| | DSH 小鲸鱼挂件 | Coopanion |
|---|---|---|
| 定位 | 只显示 DeepSeek 余额 / 每日用量的小挂件 | 会聊天、能操作电脑的通用桌宠 |
| 技术 | 自研 Electron 主进程 + 插件宿主（`host-shim`） | Cortico 框架（TypeScript + Electron） |
| 许可 | MIT | AGPL-3.0-or-later |
| 数据 | `~/.dsh/`（与 DSH 插件共用账本） | `third-party/Coopanion/data/` |

两者可以同时运行 —— 都是屏幕上的独立悬浮窗，互不干扰。
