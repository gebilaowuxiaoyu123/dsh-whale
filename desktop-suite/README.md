# 🧩 desktop-suite —— 本机桌面美化程序（**整目录不入库**）

本机那套「桌面美化」的统一工作目录。除仓库本体的两个桌宠外，其余全部收在这里，
免得散在 `C:\` 根、`E:\` 根、桌面各处。

> ⚠️ 本目录在 `.gitignore` 里是 **`/desktop-suite/*` 忽略、只放行本 README**。
> 里面是第三方程序 / 同人素材 / 构建产物（约 1 GB），**不要** `git add -f`，也别往里放隐私文件。

## 目录

| 子目录 | 搬之前在哪 | 体量 | 怎么启动 |
|---|---|---|---|
| `pogget/` | `E:\Pogget.exe` + `E:\.pogget_config` | 3.3 MB / 36 文件 | HKCU Run `MyCoolApp`（Pogget 自己也会写这条自启） |
| `xspace/` | `C:\xspace_widget\` | 504.4 MB / 1649 文件 | HKCU Run `XSpaceWidget` → `xspace\XSpaceWidget\bin\Debug\net9.0-windows\win-x64\XSpaceWidget.exe` |
| `xspace-notes/` | `C:\xspace_notes\` + `C:\xspace_home.html` + `C:\xspacenews,html` | 418.4 MB / 1007 文件 | 不自动启动（`XNoteWidget` 工程 + 资料） |
| `miside-wallpaper/` | 桌面 `MisideStartWallpapaer\` | 129.7 MB / 220 文件 | 由 **Lively Wallpaper** 承载（Lively 随开机自启）；守护由「启动」文件夹的 `wallpaper-power-guard.vbs` 拉起 |

两个桌宠**不在这里**，因为它们本来就在仓库里：

- **DSH 小鲸鱼**：仓库根 `dsh-whale-desktop/`（Electron，Windows 版）+ `dsh-whale-desktop-linux/`
- **Coopanion**：`third-party/Coopanion/`（AGPL，源码不入库，只把改造留在 `patches/`）

## 搬迁时改掉的绝对路径引用（2026-10-13）

搬目录不只是「剪切粘贴」——下面这些地方写的是绝对路径，全部一起改了：

| # | 位置 | 改成 |
|---|---|---|
| 1 | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `MyCoolApp` | `"...\desktop-suite\pogget\Pogget.exe"` |
| 2 | 同上 → `XSpaceWidget` | `"...\desktop-suite\xspace\XSpaceWidget\bin\Debug\net9.0-windows\win-x64\XSpaceWidget.exe"` |
| 3 | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\wallpaper-power-guard.vbs` | `-File "...\desktop-suite\miside-wallpaper\wallpaper-power-guard.ps1"` |
| 4 | Lively 壁纸库 `...\Library\wallpapers\misidestart_miside\LivelyInfo.json` 的 `FileName` | `...\desktop-suite\miside-wallpaper\MisideStartWallpaper.exe` |

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
| 两个桌宠 | `%APPDATA%\dsh-whale-desktop`、`third-party\Coopanion\build\data` |

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
