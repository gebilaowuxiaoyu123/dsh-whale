# 🖥️ desktop-suite 换设备还原指南（clone 之后怎么做）

> 适用：把这套「桌面插件合集」部署到**另一台机器**，或者本机重装系统后恢复。
> 原则：**仓库里只带自家源码 + 魔改补丁 + 脚本**；第三方程序由脚本自动拉/用离线包放回去，
> 并且**本机已经装了哪些插件，就只处理哪些**（`-Action status` 先看，再决定还原/接线）。

一键体检：

```powershell
powershell -ExecutionPolicy Bypass -File tools\desktop-suite-doctor.ps1
```

它会逐个插件报：**包在不在 / 程序在不在跑 / 自启等引用指得对不对**，并给出该敲的命令。

---

## 0. 前置依赖

| 用途 | 需要什么 | 检查 |
|---|---|---|
| 拉仓库 / 打补丁 | Git | `git --version` |
| 桌宠（DSH 小鲸鱼、Coopanion） | Node.js + **pnpm** | `node -v` / `pnpm -v` |
| XSpace / XNoteWidget | **.NET 9 SDK** | `dotnet --list-sdks` |
| 壁纸宿主（MiSide 壁纸要用） | Lively Wallpaper（正式安装版，带 app 壁纸支持） | 开始菜单里有 Lively |

> 本机（中国网络）提示：pnpm **不认 Windows 系统代理**，装依赖前要么直连（本机实测直连 GitHub 可用），
> 要么设 `$env:HTTP_PROXY`/`$env:HTTPS_PROXY`；Electron 二进制建议加
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

## 1. 六个包分别怎么还原

### ① `dsh-whale/`（DSH 小鲸鱼：自家，源码在仓库里）

```powershell
cd desktop-suite/dsh-whale/dsh-whale-desktop
npm ci                     # 或 npm install
powershell -File ..\start-widget.ps1      # 先手动跑一次确认能出挂件
powershell -File install-autostart.ps1    # 登记开机自启（计划任务）
```
Linux 形态看 `desktop-suite/dsh-whale/dsh-whale-desktop-linux/README.md`；GNOME 扩展看 `desktop-suite/dsh-whale/dsh-whale-shell-extension/`。

### ② `coopanion/`（第三方 AGPL，**脚本自动拉 + 自动打魔改** —— 这就是"魔改自动适配"的主力）

```powershell
# 全新安装：自动 clone 上游 → 钉版本 v0.1.20 + 子模块 f944984 → 装依赖 → 打补丁 → 构建
powershell -ExecutionPolicy Bypass -File tools\setup-coopanion.ps1

# 已经装过、只想把魔改补丁重新对齐
powershell -ExecutionPolicy Bypass -File tools\setup-coopanion.ps1 -Update

# 登记开机自启（自启不弹调试界面）
powershell -ExecutionPolicy Bypass -File tools\coopanion-autostart.ps1 install
```
- 魔改清单：**18 个文件**，全部在 `patches/coopanion/0001-dsh-pet-features.patch`（脚本会自动应用；补丁打不上脚本会**直接中止**）。
- 装好后自检：`node tools/coopanion-feature-test.mjs`（补丁是否在 + 构建产物是否跟上）。
- 桌宠的运行时配置（形象/走动模式/悬停按钮/置顶/全屏隐藏）在 `coopanion/build/data/home/companion/config.json`，
  属于本机数据，**不随仓库走**；换设备后到控制台「习惯」页重设一遍即可。

### ③ `xspace/` 与 ④ `xspace-notes/`（自家 .NET 工程，MIT，源码入库）

```powershell
cd desktop-suite\xspace\XSpaceWidget;      dotnet build -c Debug
cd desktop-suite\xspace-notes\XNoteWidget; dotnet build -c Debug
```
再把自启指到新产物（`-Action wire` 会替你写）：

```powershell
$exe = "$PWD\bin\Debug\net9.0-windows\win-x64\XSpaceWidget.exe"
Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'XSpaceWidget' -Value "`"$exe`""
```

### ⑤ `pogget/` 与 ⑥ `miside-wallpaper/`（第三方，没有上游 git → 用离线包还原）

这两个是**第三方程序本体**，仓库不分发它们（Pogget 是专有软件；MiSide 壁纸是同人素材）。
换设备时把你自己那份离线包带过去，然后：

```powershell
powershell -File tools\desktop-suite-doctor.ps1 -Action restore `
  -PoggetZip    "D:\downloads\Pogget.zip" `
  -WallpaperZip "D:\downloads\MisideStartWallpaper.zip"
```
脚本会把它们解到 `desktop-suite\pogget\` 与 `desktop-suite\miside-wallpaper\`，
然后 `-Action wire` 负责接线：
- Pogget：`HKCU\...\Run\MyCoolApp` → 新 exe 路径；
- 壁纸：改 Lively 库条目 `Library\wallpapers\misidestart_miside\LivelyInfo.json` 的 `FileName`（**按字节改**，保住原编码）、
  改启动文件夹 `wallpaper-power-guard.vbs` 里的守护脚本路径、并把守护跑起来。

> 壁纸的守护脚本 `wallpaper-power-guard.ps1` 是我们自己写的（壁纸被最大化窗口盖住 / 空闲 / 电池时隐藏壁纸省电），
> 它跟着壁纸包走；**它内部没有硬编码路径**（按进程名找窗口、日志写 `%LOCALAPPDATA%\Lively Wallpaper\`），所以换目录不用改它。

## 2. 接线（引用）清单 —— 漏一个就会"启动不起来"

| # | 位置 | 指向 |
|---|---|---|
| 1 | 计划任务 `DSH Whale Desktop Widget` | `desktop-suite/dsh-whale/dsh-whale-desktop\start-widget.ps1` |
| 2 | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `electron.app.Electron` | `...\desktop-suite\coopanion\node_modules\electron\dist\electron.exe` + `...\desktop-suite\coopanion --background` |
| 3 | 同上 → `XSpaceWidget` | `...\desktop-suite\xspace\XSpaceWidget\bin\Debug\net9.0-windows\win-x64\XSpaceWidget.exe` |
| 4 | 同上 → `MyCoolApp` | `...\desktop-suite\pogget\Pogget.exe` |
| 5 | 启动文件夹 `wallpaper-power-guard.vbs` | `...\desktop-suite\miside-wallpaper\wallpaper-power-guard.ps1` |
| 6 | Lively 库 `misidestart_miside\LivelyInfo.json` 的 `FileName` | `...\desktop-suite\miside-wallpaper\MisideStartWallpaper.exe` |

`tools/desktop-suite-doctor.ps1 -Action wire` 会按**本机实际存在的插件**把上面六处全部对齐（不存在的跳过）。

## 3. 搬目录时容易踩的坑（本机实测）

1. **程序在跑时目录改不了名**：Windows 会以"访问被拒绝"拒绝重命名 —— 先停进程再搬（本项目搬迁脚本都是这么做的）。
2. **终端自己的"当前目录"落在这个文件夹里**，会让它删不掉/改不了名（表现为"正由另一进程使用"）。
   查法：读进程 PEB 里的 `CurrentDirectory`；`tools/desktop-suite-doctor.ps1` 里带了这段实现。
3. **别用 `Move-Item` 搬 pnpm 的 `node_modules`**：里面有符号链接与悬空链接，会中途报
   "未能找到路径…的一部分"甚至半途而废 —— 用 `[IO.Directory]::Move()` 做整目录改名，或干脆重装依赖。
4. **Lively 的 `LivelyInfo.json` 不是纯 UTF-8**（里面混了 GBK 字节）：改路径要**按字节替换**，别整文件当字符串读写。
5. **补丁要按版本钉死**：Coopanion 前端在 v0.1.19/v0.1.20 重构过（`web/pet-core.js` → `web/kit/body.js`），
   上游一漂补丁就整段打不上 —— 所以 `tools/setup-coopanion.ps1` 里 `$CoopanionTag`/`$CorticoCommit` 是钉死的，
   改版本必须同时重新生成补丁（`git -C <Coopanion> diff --no-color --output=patches\coopanion\0001-dsh-pet-features.patch`）。
