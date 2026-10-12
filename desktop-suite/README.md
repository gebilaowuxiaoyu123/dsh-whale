# 🧩 desktop-suite —— 本机桌面插件集散地

把本机那套「桌面美化 / 桌面管理」插件**统一成一棵目录树**：**每个插件各自一个包，彼此平级、互不依赖**。
原本散在 `E:\` 根、`C:\` 根、桌面、`third-party\`、仓库根的东西，现在全在这里。

**入库策略（重要）**

| 内容 | 是否入库 | 为什么 |
|---|---|---|
| 自家源码（`dsh-whale/*`、`xspace/`、`xspace-notes/`）、魔改补丁、脚本、文档 | ✅ 入库 | 换设备 clone 下来就有 |
| 第三方程序本体（`coopanion/`、`pogget/`、`miside-wallpaper/`）与运行时数据 | ❌ 不入库 | 体积大、单文件超 GitHub 100 MB 上限、pnpm 符号链接 git 还原不了、运行时里含真实 API Key |

第三方不随仓库分发，**但仓库带着“自动拉 + 自动打魔改”的能力**：clone 之后跑
`tools\desktop-suite-doctor.ps1` 体检、`tools\setup-coopanion.ps1` 自动拉 Coopanion 并把 **18 个文件的魔改**打回去。
完整换机流程见 [`../docs/desktop-suite-clone.md`](../docs/desktop-suite-clone.md)。

## 目录

```
desktop-suite/
├── dsh-whale/              ← ① DSH 小鲸鱼的各个形态打包成一个包（自家源码）
│   ├── desktop-suite/dsh-whale/dsh-whale-desktop/           Windows 桌面挂件（Electron）
│   ├── desktop-suite/dsh-whale/dsh-whale-desktop-linux/     Linux 桌面挂件（AppImage/deb）
│   ├── desktop-suite/dsh-whale/dsh-whale-shell-extension/   GNOME Shell 扩展（Wayland 悬浮首选）
│   ├── desktop-suite/dsh-whale/dsh-whale-widget/            DSH 网页版插件（vendored 上游 MIT 副本）
│   └── desktop-suite/dsh-whale/dsh-whale-pets-tray/         托盘小扩展
├── coopanion/              ← ② Coopanion 桌宠（AGPL，不入库；脚本自动拉 + 打魔改）
├── xspace/                 ← ③ XSpace 竞赛通知桌面栏（自家 .NET，MIT）
├── xspace-notes/           ← ④ XNoteWidget 工程 + 资料（自家 .NET，MIT）
├── pogget/                 ← ⑤ Pogget 桌面容器（第三方专有，不入库；离线包还原）
└── miside-wallpaper/       ← ⑥ MiSide Unity 应用壁纸 + 自研壁纸守护（第三方素材，不入库）
```

| 包 | 搬之前在哪 | 怎么启动 / 还原 |
|---|---|---|
| `dsh-whale/desktop-suite/dsh-whale/dsh-whale-desktop` | 仓库根 `desktop-suite/dsh-whale/dsh-whale-desktop/` | 计划任务 `DSH Whale Desktop Widget` → `start-widget.ps1` |
| `coopanion/` | `desktop-suite\coopanion/` | HKCU Run `electron.app.Electron` → `node_modules\electron\dist\electron.exe` + `--background`；装一次跑 `tools\setup-coopanion.ps1` |
| `xspace/` | `C:\xspace_widget\` | HKCU Run `XSpaceWidget` → `xspace\XSpaceWidget\bin\Debug\net9.0-windows\win-x64\XSpaceWidget.exe` |
| `xspace-notes/` | `C:\xspace_notes\` + 两个散在 C 盘根的 html | 不自动启动（`XNoteWidget` 工程+资料） |
| `pogget/` | `E:\Pogget.exe` + `E:\.pogget_config` | HKCU Run `MyCoolApp` |
| `miside-wallpaper/` | 桌面 `MisideStartWallpapaer\` | 由 Lively 承载；守护由启动文件夹 `wallpaper-power-guard.vbs` 拉起 |

## 搬迁时改掉的绝对路径引用（2026-10-13）

搬目录不只是「剪切粘贴」——下面这些地方写的是绝对路径，全部一起改了：

| # | 位置 | 改成 |
|---|---|---|
| 1 | 计划任务 `DSH Whale Desktop Widget` | `...\desktop-suite/dsh-whale/dsh-whale-desktop\start-widget.ps1` |
| 2 | `HKCU\...\Run` → `electron.app.Electron` | `...\desktop-suite\coopanion\node_modules\electron\dist\electron.exe` + `...\desktop-suite\coopanion --background` |
| 3 | 同上 → `MyCoolApp` | `"...\desktop-suite\pogget\Pogget.exe"` |
| 4 | 同上 → `XSpaceWidget` | `"...\desktop-suite\xspace\XSpaceWidget\bin\Debug\net9.0-windows\win-x64\XSpaceWidget.exe"` |
| 5 | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\wallpaper-power-guard.vbs` | `-File "...\desktop-suite\miside-wallpaper\wallpaper-power-guard.ps1"` |
| 6 | Lively 壁纸库 `...\Library\wallpapers\misidestart_miside\LivelyInfo.json` 的 `FileName` | `...\desktop-suite\miside-wallpaper\MisideStartWallpaper.exe` |

> 这六处不用手改：`tools\desktop-suite-doctor.ps1 -Action wire` 会按**本机实际存在的插件**全部对齐。

**不需要改的**（已核实）：

- `WallpaperLayout.json` 是按**库 id** `misidestart_miside` 引用当前壁纸的，不含路径；
- `wallpaper-power-guard.ps1` 只按**进程名** `MisideStartWallpaper` 找窗口，日志写在 `%LOCALAPPDATA%\Lively Wallpaper\`；
- 桌面与开始菜单里没有指向这三个程序的快捷方式（它们靠自启）；
- 计划任务 `DSH Whale Desktop Widget` 指向的是仓库本体，仓库位置没动。

## 运行时数据（**没有搬**，那些是程序自己的约定位置）

| 程序 | 数据在哪 |
|---|---|
| Pogget | `D:\.pogget\user_storage\u_abdf7f`（写在它自己的配置里，与程序放在哪无关） |
| XSpace | `%LOCALAPPDATA%\XSpaceWidget`（WebView2 用户数据） |
| MiSide 壁纸 | `HKCU\Software\MisideStart`（Unity PlayerPrefs） |
| Lively 本体 | `%LOCALAPPDATA%\Programs\Lively Wallpaper`（**正式安装程序、带卸载项，别动**） |
| 两个桌宠 | DSH 挂件：`%APPDATA%\desktop-suite/dsh-whale/dsh-whale-desktop`；Coopanion：`desktop-suite\coopanion\build\data`（含 API Key，**不入库**） |

## 回滚

- **原件都在回收站**（还原即可）：`C:\xspace_widget`、`C:\xspace_notes`、`C:\xspace_home.html`、
  `C:\xspacenews,html`、`E:\Pogget.exe`、`E:\.pogget_config`、桌面 `MisideStartWallpapaer\` 的全部内容。
- **改动前的引用备份**：`%USERPROFILE%\dsh-whale-backups\desktop-suite-move-<时间戳>\`
  （`autostart-before.txt`、`wallpaper-power-guard.vbs`、`LivelyInfo.json`、`WallpaperLayout.json`、`Pogget.vina`）。
- 桌面上的 `MisideStartWallpapaer\` 现在是个**空壳目录**：它被某个进程当作当前工作目录占着，删/改名都失败 →
  **重启之后直接删掉即可**（内容早已全部进回收站）。

## 在这个目录里干活要注意

- 本目录已在 `.vscode/settings.json` 里排除出**文件监视**与**全局搜索**（1 GB / 2600+ 文件，不排会拖慢 VS Code）。
- `xspace/XSpaceWidget/` 是 .NET 9 工程（`XSpaceWidget.csproj`）：换目录后仍可直接构建，产物落在 `bin\`，
  **自启指向的就是 `bin\Debug\net9.0-windows\win-x64\` 里的 exe** → 想把启动点换成发布产物，改自启指向 `dist\` 即可。
- `miside-wallpaper/` 里的 `wallpaper-power-guard.ps1` 是我们自己写的省电守护（壁纸被最大化窗口盖住 / 空闲 / 电池时
  `SW_HIDE` 隐藏壁纸窗口）；它的日志在 `%LOCALAPPDATA%\Lively Wallpaper\wallpaper-power-guard.log`，
  手动查看状态：`powershell -File desktop-suite\miside-wallpaper\wallpaper-power-guard.ps1 -Status`。
