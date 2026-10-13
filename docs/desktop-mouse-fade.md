# 桌宠「鼠标悬停上浮 / 离开下沉变透明」

鼠标不在桌宠（Pogget / XSpace）上时，把它调成「离开时的不透明度」并**下沉**；
鼠标移到它上面时恢复成「悬停时的不透明度」并**上浮**；两个状态之间按设定时长**平滑过渡**。
效果默认开启，两边都能单独关闭（把上浮距离设 0 就只做透明度、不做位移）。

## 一、XSpace（原生实现，改的是我们自己的源码）

- **设置入口**：右键桌宠 → 设置 → 「鼠标悬停上浮、离开下沉变透明」
  - 离开时的不透明度（0.05 ~ 1）
  - 悬停时的不透明度（0.05 ~ 1）
  - 过渡时长（0 ~ 1000 ms，0 = 立即切换）
  - 上浮距离（0 ~ 24 逻辑像素，0 = 不做上浮/下沉）
- **配置落盘**：exe 同目录 `config.json` 的 `MouseFade` / `OpacityAway` / `OpacityOver` / `FadeMs` / `HoverLiftPx`
- **源码位置**：`desktop-suite/xspace/XSpaceWidget/MainWindow.MouseFade.cs`
- **为什么用 90ms 轮询而不是 MouseEnter/MouseLeave**：窗口里嵌了 WebView2（Steam 价格视图）等子 HWND，
  鼠标在它们上面时 WPF 收不到窗口级 Enter/Leave，状态会长时间不更新。
- **不打架的细节**：
  - 缩放窗口、触屏拖动窗口（`_resizing` / `_manipulating`）时自动暂停，不跟用户的手抢位置；
  - 用户手动挪过窗口后，会把新位置认作「静止位置」自动校正；
  - `SavePosition()` 存的是静止位置（`_restTop`），不会把上浮的偏移写进配置。

## 二、Pogget（外部助手；它闭源，改不了源码，所以开关在助手里）

> Pogget 是第三方闭源软件：它的配置（`.pogget_config\DesktopContainer.vina`）里没有任何透明度键，
> UI Automation 也**只能读到 1 个自绘容器**（探不到任何设置控件）。
> 因此「开关 + 两个透明值 + 过渡时长 + 上浮距离」由 `tools/desktop-mouse-fade.ps1` 承载，
> 它给 Pogget 的窗口加 `WS_EX_LAYERED` 用 `SetLayeredWindowAttributes` 调 alpha、用 `SetWindowPos` 做上浮/下沉。

| 命令 | 作用 |
| --- | --- |
| 双击脚本 / `-Settings` | 设置界面（启用、离开/悬停不透明度、过渡时长、上浮距离、目标进程） |
| `-Run` | 常驻运行（开机自启用这个，隐藏窗口） |
| `-Install` / `-Uninstall` | 装 / 卸开机自启（挂 `HKCU Run` 的 `DSH-Boot-Order`，由分级启动器在最后一步拉起） |
| `-Status` | 看目标窗口的 hwnd / LAYERED / 当前不透明度 / rect |
| `-Restore` | 一键还原：全部不透明 + 撤掉 LAYERED |

- 配置文件：`tools/mouse-fade.config.json`（不存在就用脚本内默认值；`-Settings` 保存时写出）
- 日志：`desktop-suite\_runtime\mouse-fade\mouse-fade.log`（原先在 `%LOCALAPPDATA%\dsh-whale`，2026-10-13 已收进仓库）
- 自启：`HKCU Run` 的 `DSH-Boot-Order`（分级启动器第 6 步），**不在**启动文件夹
- 助手**每秒重读一次配置**，所以在设置界面改完立即生效，不用重启。
- 默认只接管 `Pogget`；`Processes` 可以填多个进程名（逗号分隔），理论上也能接管其他闭源桌宠。
- `WindowClassLike`（默认 `Pogget.Vina.Com.Container.Class*`）是**窗口类过滤**：一个进程往往有多个顶层窗口，
  Pogget 的**控制窗口**（`Vina.Class.Pogget.App.Main`）不该跟着淡入淡出/上浮。填了它以后只接管类名匹配的窗口，
  留空则回到「接管该进程全部可见窗口」。不再符合过滤条件的窗口会被**放手**：清动画目标、alpha 还原 255、
  撤掉 `LAYERED`、沉回静止位。`-Restore` 会扫「不套过滤」的全量列表，连强杀留下的分层残留也能清掉。

## 三、怎么验证它在工作

- **XSpace**：以 `XSPACE_FADE_LOG=1` 启动（环境变量），会往 `%TEMP%\xspace-mousefade.log` 写每次过渡，例如：
  ```
  08:36:46.419  0.35 -> 1.00  (450ms)  鼠标在窗口上
  08:36:46.429  位置 527.5 -> 519.5  (450ms) [悬停上浮]
  08:36:48.051  1.00 -> 0.35  (450ms)  鼠标已离开
  08:36:48.054  位置 519.5 -> 527.6  (450ms) [离开下沉]
  ```
- **Pogget**：`tools\desktop-mouse-fade.ps1 -Status`
  鼠标移开时应看到「不透明度≈89/255、rect 回到静止位置」，悬停时「255/255、rect 上浮 16px」。
  列表里**只会出现桌面容器**（`Pogget.Vina.Com.Container.Class.*`）——控制窗口被窗口类过滤挡在外面，
  实测它在离开/悬停/再离开三态下 alpha 恒为 `-1`（未分层、完全不透明）且 Y 坐标一动不动。

## 四、踩过的坑

1. **DPI 坐标**：助手必须自己声明 DPI 感知（脚本里的 `MakeDpiAware()`，PerMonitorV2 并回退 `SetProcessDPIAware`）。
   否则在 200% 缩放下系统会把 `GetWindowRect` / `SetWindowPos` 的坐标虚拟化，
   「上浮 16px」实际会变成 32 物理像素，而且和 XSpace 里的逻辑像素对不上
   （实测症状：同一个窗口，助手读到 Y=91、别的进程读到 Y=182 —— 正好差 2 倍）。
2. **`Add-Type` 类型已存在**：同一个 PowerShell 会话里反复调用脚本时，`MouseFadeNative` 已加载会报错。
   脚本已加「类型存在就跳过」的守卫；但**改了脚本里的 C# 部分后，要开新终端**才会加载到新类型
   （旧会话里的类型换不掉，会报 `方法调用失败…不包含名为 RectOf 的方法`）。
3. **强杀助手**：没走正常退出时，窗口会停在最后的不透明度与上浮位置 → 用 `-Restore` 还原。
4. **拖动冲突**：用户按住左键拖窗口时助手不抢位置；窗口被别的程序挪过（差 > 3px）时自动把新位置认作基准。
5. **透明度是"整窗 alpha"**：`WS_EX_LAYERED` + `LWA_ALPHA` 对整窗口生效（含子窗口），
   如果哪天 Pogget 某块界面变成黑框，用 `-Restore`（或把 `Enabled` 设 false）即可回到原状。
