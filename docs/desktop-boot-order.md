# 开机分级启动（错峰 + 固定顺序）

## 为什么需要它

六个插件原先各自抢占开机自启：计划任务（小鲸鱼）、注册表 `Run`（Coopanion / XSpace / Pogget / Lively）、
启动文件夹（鼠标助手 / 壁纸守护）。它们在同一时刻开火，CPU 与 GPU 峰值叠在一起 ——
开机后那几秒桌面明显卡一下，动态壁纸启动时更明显（Unity 渲染本身就吃 GPU）。

本仓库把它们排成一条队，前一个"**进程真的起来了**"再等一段间隔，才放行下一个，把峰值摊平。

## 顺序

| 步骤 | 启动内容 | 等就绪上限 | 额外间隔 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | dsh 小鲸鱼（Windows 挂件） | 30s | 6s | 走它自己的计划任务，最轻，先上 |
| 2 | lived2d 小鲸鱼（Coopanion 桌宠） | 35s | 6s | Electron 主进程 + 多个渲染进程，给足时间 |
| 3 | 动态壁纸（Lively + MiSide + 壁纸守护） | 45s | 8s | **GPU 重负载单独一段**，前后都留间隔，不和其它插件抢 GPU |
| 4 | Pogget（桌面收纳容器） | 25s | 6s | |
| 5 | XSpace（竞赛通知栏） | 25s | 4s | .NET 启动后有首轮网络抓取 |
| 6 | 鼠标跟随透明度助手 | 10s | 0 | 最轻，放最后 |

顺序和等待时间都可以在 `desktop-suite\_runtime\boot-order\config.json` 里改（首次运行自动生成）。

## 命令

```powershell
tools\desktop-suite-boot-order.ps1            # 看现状：各步插件在不在、当前自启项、上次启动耗时
tools\desktop-suite-boot-order.ps1 -DryRun    # 只按顺序打印计划（不动任何程序）
tools\desktop-suite-boot-order.ps1 -Run       # 真正按顺序启动（开机自启用它）
tools\desktop-suite-boot-order.ps1 -Install   # 接管自启（先备份现有自启项）
tools\desktop-suite-boot-order.ps1 -Restore   # 还原自启项
```

## 作为"辅助包"的定位（重要）

- **脚本**在 `tools/`（随仓库走，任何设备都能用）；
- **每台机器的配置与备份**在 `desktop-suite\_runtime\boot-order\`，该目录被 `.gitignore` 排除 ——
  所以别的系统拉仓库时**不会带上你机器的启动配置**，而是在本机首次运行时按本机情况生成自己的；
- **缺插件自动跳过**：每一步先探测插件目录/可执行文件是否存在，不存在就记一行日志跳过，不报错、不阻塞后面的步骤。
  比如某台机器没装 Pogget，那第 4 步直接跳过。

## `-Install` 会做什么（都会备份）

1. 备份 `HKCU\...\Run` 里的 `electron.app.Electron` / `XSpaceWidget` / `MyCoolApp` 并删除
   （Lively 的 `Run` 项**不动**：它由第 3 步以正常用户令牌拉起，效果一样但便于回退）；
2. 导出并**禁用**计划任务 `DSH Whale Desktop Widget` 的登录触发（启动器按需 `Start-ScheduledTask` 拉起）；
3. 备份并移除启动文件夹里的 `dsh-mouse-fade.vbs`（鼠标助手改由第 6 步拉起）；
   壁纸守护 `wallpaper-power-guard.vbs` **保持原样**（它很轻，第 3 步也会确保它在跑）；
4. 在启动文件夹装自己的 `dsh-boot-order.vbs`。

备份落在 `desktop-suite\_runtime\boot-order\autostart-backup.json`（+ 计划任务 XML 导出），
`-Restore` 会按它把所有自启项还回去。

## GPU 相关

- 第 3 步单独一段：动态壁纸启动时 GPU 占用会明显抬升，这一段前后各留 6~8 秒，避免与 Electron（Coopanion）
  的合成/首屏渲染撞在一起；
- 启动器**不改**任何现有 GPU 开关（Electron 的 GPU 白名单、MPO 设置等一律不动），只做"延后启动"；
- 每个阶段都等上一个进程出现才开始计时间隔，所以机器快时整体更快、机器慢时自动拉长，不需要手工调。

## 怎么核对

每次启动都会往 `desktop-suite\_runtime\boot-order\boot-order.log` 写带毫秒的时间戳：

```
19:31:02.104  ===== 分级启动开始 =====
19:31:02.118  [1] dsh 小鲸鱼（桌面挂件） — 已拉起（用时 0.0s）
19:31:04.220  [1] dsh 小鲸鱼（桌面挂件） — 进程已就绪（累计 2.1s）
19:31:10.239  [2] lived2d 小鲸鱼（Coopanion） — 已拉起（用时 0.0s）
19:31:14.301  [2] lived2d 小鲸鱼（Coopanion） — 进程已就绪（累计 12.2s）
...
19:31:52.870  ===== 全部完成，总耗时 50.8s =====
```

想核对某一步是否被跳过，直接搜索 `跳过：本机没有这个插件`。

## 已知注意事项

- 第 3 步用 `explorer.exe` 启动 Lively，目的是拿到**普通用户令牌**：如果从提权终端/计划任务里直接
  `Start-Process`，Lively 会以管理员身份运行（它自己会警告 `Process is running elevated`，
  影响托盘与交互）。本机因为 UAC 关闭（`EnableLUA=0`）整个会话都是提权的，所以这条警告一直存在，与启动器无关。
- 若某天想临时不开分级启动：`-Restore` 还原，或把 `config.json` 里的 `Enabled` 置 `false`。
- Linux 版对应脚本见 [`linux-presets.md`](linux-presets.md)（`linux/boot-order.sh`）。
