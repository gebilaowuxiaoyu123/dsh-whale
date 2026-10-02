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

```powershell
# 首次安装并启动
powershell -ExecutionPolicy Bypass -File tools\setup-coopanion.ps1 -Run

# 更新到最新版并启动
powershell -ExecutionPolicy Bypass -File tools\setup-coopanion.ps1 -Update -Run
```

## 手动步骤（等价）

```powershell
git clone --depth 1 https://github.com/Pal-AI-Lab/Coopanion.git third-party/Coopanion
git -C third-party/Coopanion submodule update --init --depth 1 vendor/cortico
pnpm --dir third-party/Coopanion install
pnpm --dir third-party/Coopanion run build:cortico
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

## 使用要点

- **首次启动**：Coo 从屏幕顶部掉到底边，托盘区出现图标，**不会弹出任何窗口**
- **配置模型**：右键 Coo → 设置（或点托盘图标），填 API Key（默认推荐 DeepSeek）
- **换形象**：设置窗口「装扮」页 → 形象 → **DeepSeek 大肥鱼**
- **退出**：右键托盘图标 → 退出（**关掉设置窗口不会退出程序**）
- **数据目录**：`third-party/Coopanion/data`（记忆 / 设置 / 日志都在这里，重装不丢）

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
