# 📋 版本更新日志（CHANGELOG）

> 记录 DSH 小鲸鱼所有形态的版本演进。格式参照 [Keep a Changelog](https://keepachangelog.com/)。
>
> - **GNOME Shell 扩展版**（`dsh-whale-shell-extension/`，Wayland 桌面首选，当前主力迭代）：v9 → v12 → … → v31
>   （v10/v11 为引入初期的一次性内部迭代，未单独建档，已合并体现在 v12 定型）
> - **桌面版 / DSH 网页插件**（Windows、Ubuntu Linux、dsh-web）：v1.0 + 上游插件跟进至 **v0.3.17**

---

## [修复：齿轮按钮 / 置顶开关后上浮 / 两只桌宠贴底 + 双机适配] - 2026-10-10

> 这一轮全部来自实机排查（都插过探针取证），并把仓库从「只在本机成立」改成**两台机器共用**。

### 修复
- **点聊天框的齿轮打不开设置界面**（真因是 `show()` 从没被调用，与 GPU 无关）
  上游原本是 `settings.once('ready-to-show', () => settings.show())`；本轮给 `openSettings`
  加诊断时手滑写成了 `() => () => settings.show()` —— **多套了一层箭头函数**，
  `ready-to-show` 触发时只是「返回」了一个函数，从来没有执行它。窗口以 `show: false`
  创建，于是永远亮不出来：进程在、程序坞里有条目、页面也在后台加载，但用户看到的是
  「点了没反应 / 只在程序坞里转圈」。
  → 改回真正的调用，并加 3 秒兜底（`ready-to-show` 万一不来也把窗口亮出来）；
  复用已存在窗口的分支补上「尺寸跑歪就纠回 1180x800 + 提到最前 + 确保映射」，
  真出错就销毁重建。代码注释里写明「这里必须是调用」以及错误写法，防止再犯。
  **实测**：点击后主进程 CDP 页面数 `0 → 1`，URL = `http://127.0.0.1:17788/#/home`
  （控制台 SPA 已加载并完成路由跳转）。
  另一层与真因无关、但确实存在的加固保留：GPU 崩溃（`exit_code=139`）时渲染进程起不来，
  主进程因此加了软件渲染兜底 + `render-process-gone` 自动重载。

- **「置顶显示」关一次再开，桌宠停在半空**
  不置顶期间窗口是 NORMAL，mutter 会把它夹回 workArea（底边只到 Dock 上沿，高出 ~71px）；
  光把类型改回 DOCK 不会把位置退回来 → `applyOnTop()` 里切回置顶时重新 `cover()` 贴底。
  并给 `tools/aot-toggle-test.mjs` 加了「开关一次后窗口仍贴在屏幕底」判据（现 6/6）。
- **DSH 小鲸鱼离屏幕底留一条缝**：`BOTTOM_M` 6 → 0（原来空出 12 物理像素）→ 实测距屏底 0 像素。
- **看门狗误整机重启**（真正在造「莫名奇妙关机」）：`restart gdm` 会销毁用户会话，
  60 秒后再探「用户会话里的 mutter」必然失败 → 100% 落到 `systemctl reboot -f`。
  改为探 gdm 自身 + 恢复冷却 180s + 两次 gdm 都起不来才动整机。
- **电池下闲置 15 分钟自动挂起** → `sleep-inactive-battery-type` 改为 `nothing`（原值已备份）。
- **hanabi 动态壁纸吃 92% CPU / 53W** → `pause-on-battery` 从 1（低于阈值才停）改 2（电池下即停）：
  功耗 53.4W → 37.2W，剩余时间 36.9 → 52.5 分钟。

### 两台机器共用（队友那台 Ubuntu 22.04 + Legion + RTX 5070 / X11）
- `tools/freeze-fix/*`：`install-guc-firmware.sh` 加平台判定（非 Intel / 非 MTL 直接跳过）；
  `i915-stabilize.sh` 同样守卫（但 `--revert` 永远放行）；`gpu-watchdog.sh` 补 NVRM 关键字
  （`GPU has fallen off the bus` / `NVRM: Xid`，仍由「内核异常 + mutter 真冻结」双条件把关）；
  `diagnose.sh` 按平台分岔（NVIDIA 机器改查驱动与 Xid）；`apply-all.sh` 跳过措辞修正。
- 去掉所有写死家目录：`dsh-whale-desktop-linux/main.js`、Coopanion `host/electron-main.cjs`、
  `dsh-whale-pets-tray/extension.js` 统一改为「环境变量 → ~/dsh-whale → 仓库相对/向上查找」。
- Coopanion 侧改动重新折进 `patches/coopanion/0001-dsh-pet-features.patch`（12 文件 868 行，与工作区逐字一致）。

### 未完成（唯一一项）
- **「随刷新率」走动 + 悬停按钮「测试刷新率」**（原六个自研功能里的最后两个）。
  上游把 `web/kit/body.js` 并回了 `web/pet-core.js`，补丁无法原样套用；实现要点见
  [`docs/coopanion-integration.md`](docs/coopanion-integration.md)（含读数吸附表、
  rAF 探针、「一帧一步」段序、`hzPinned` 钉住读数等）。
  `coopanion-feature-test` 剩余 11 项失败全部属于它，不是回归。

---

## [Coopanion 升级到上游 v0.1.20（重新移植全部自研功能）] - 2026-10-10

> 上游在 **v0.1.19 / v0.1.20** 重构了前端：原来的 `web/pet-core.js` 被拆成 **`web/kit/body.js`（模拟引擎）**、
> `web/ui.js`（图标/主题）、`web/coo/*`（形象）、`web/i18n.js`（多语言），控制台文案挪到
> `console/features/pet/strings.ts`。源码一漂，原来的补丁**整段打不上**，所以本次把源码与子模块都**钉死版本**，
> 并把六个自研功能**重新移植**到新结构上。

### 变更
- **版本钉死**：Coopanion `v0.1.20` + 子模块 `vendor/cortico` @ `f944984`（上游 tarball 不含子模块，commit 也一并钉死）。
- 六个自研功能全部重新移植（对照表见 [`docs/coopanion-integration.md`](docs/coopanion-integration.md)）：
  气泡左侧调试入口、「随刷新率」走动、置顶显示开关、开机自启（未打包可用）、自启不弹调试界面、
  「与 DSH 挂件同步」按钮、悬停按钮「测试刷新率」。补丁共 18 个文件。
- **「置顶显示」默认值回到「开」**（与上游一致）：想要「应用窗口盖住它、它仍在桌面图标之上」，
  去控制台「习惯」页把「置顶显示」关掉。
- 自检脚本跟着换路径：`tools/coopanion-hzscan-test.mjs` 改为 import `web/kit/body.js`；
  `coopanion-feature-test.mjs` / `coopanion-sync-roam-test.mjs` 同步更新。

### 本机适配踩坑（2026-10-10）
- **`setup-coopanion.ps1 -Update` 不看 `git fetch/checkout` 的退出码**：本机当天 GitHub 直连被掐，
  `fetch` 失败后脚本照样往下跑 → 结果是「源码还是旧版 v0.1.10 + 补丁打不上（只报警）+ 构建照跑」，
  外表完全看不出错。已给脚本加上**版本与子模块的硬校验**，并在补丁打不上时**直接中止**（不再往下构建一个没有功能的产物）。
- 升级前先备份 `third-party/Coopanion/build/data/home/`（`config.json` + `providers/*/.env` 里的令牌）。

---

## [桌面刷新率测试] - 2026-10-09

> 需求（用户原话）：新加一个功能「测试桌面刷新率」——在侧边小按钮点击后，小鲸鱼会先快速跑到左侧
> （正常速度），然后按桌面刷新率从左向右、再从右向左跑两趟；**跑完冒个语言泡说测试完成，
> 再慢悠悠回到开始之前的位置**。

### 新增
- Coopanion 的**悬停按钮多一项「测试刷新率」**（控制台「习惯」页 → 悬停按钮里勾选，和打字/语音输入同一处）：
  - 先按它自己的快走跑到**最左**（这一段不算成绩）；
  - 再以 **「一帧一步」（1 px / 屏幕帧）** 从左到右、右到左共 **4 段**（两趟来回），跑到边就转身；
  - 跑完冒气泡：`测试完成 · 屏幕约 120 Hz（实测 115.9 Hz · 4 段 1767 px 用时 15.4 秒）`；
  - 说完**慢悠悠走回测试前站着的位置**（用走、不用跑）；全程不动行为模式，跑完接着按原来的模式过。
  - 再点一下 = 停下；中途被拎起来/抛出去 = 中断（会冒一句话说明）。
- `web/kit/body.js`（上游 v0.1.20 里由 `web/pet-core.js` 拆分而来）新增 `hzScan()` / `stopHzScan()` / `scanning`：测速探针 + 段序状态机 + 一帧一步的固定速度；图标在 `web/ui.js`，文案在 `console/features/pet/strings.ts`。

### 为什么这么量
- 页面平时的帧循环为了省电被压到 **15/30 fps**，所以它数出来的「帧率」不是屏幕的刷新率。
  探针在测试前**不设上限**地数 0.9 秒真实帧（单开一条 rAF 只数数、不画东西），
  用「帧数 ÷ 耗时」得到真刷新率；读数会写回 `ctl.hz` 并**钉住**（换屏幕/改缩放时解钉重测）。
- 1 px/帧 × 刷新率 = 这段路的速度，所以 **4 段用时 ÷ 路程就是刷新率**，拿秒表也能反推 ——
  这也是为什么测试那几段不做加减速（到边一帧不多一帧不少）。
- **顺手修掉一个老问题**：「随刷新率」的读数原来也是从被压过的帧循环里读的，
  本机 120 Hz 会被读成 15~30 Hz → 走动速度只剩 0.5×。现在测过一次后读数就被钉住，
  「随刷新率」立刻按真实屏幕走（状态行里的「屏幕约 N Hz」也随之对了）。

### 自检
- 新增 `tools/coopanion-hzscan-test.mjs`（**20 项**）：受控时钟 + 受控 rAF 推进模拟，量测速读数
  （60/120 Hz）、段序（到最左 → 右 → 左 → 右 → 左）、一帧一步（帧数 ≈ 像素数）、
  60 Hz 下同样 4 段用时翻倍、收尾（速度放开、读数写回且不被拉回）、叫停。
- `tools/coopanion-feature-test.mjs` **28 → 34 项**（新按钮的源码片段 + 构建产物）。
- 实测（本机 120 Hz）：跑到最左 3.3 s → 4 段 15.4 s（~117 px/s，与读数 115.9 Hz 对得上）→
  气泡逐字说完 → 5 s 后从最左慢走回原位，停在测试前那个位置。

---

## [双桌宠 API Key 一键同步] - 2026-10-09

> 需求（用户原话）：把两个桌宠插件的 api_key **打通**，「在 api_key 输入窗口旁边加一个同步 key」。
> 澄清后的口径是关键：**「不按不同步，按一下两个都同步」**—— 不是后台自动轮询，也不是
> 「我这边刷新了、你还得去另一个插件点一下同步」，而是**任一处的 key 窗口上按一下，两边立刻都用上同一把**。

### 新增
- **挂件侧**（Windows / Linux 两个桌面版同步）：托盘「改 API Key…」小窗口（`/key`）改成三个键 ——
  - **「保存并同步到两个桌宠」**（主键）：写两边 + 自动关窗；
  - 「只保存到挂件」：只写 `~/.dsh/.credentials.yaml`；
  - 「以 Coopanion 为准（拉过来）」：把 Coopanion 已存的那把写进挂件。
  窗口顶部常显两边的**打码值**与结论：`两边一致 ✓` / `两边不一致` / `没找到 Coopanion 的 .env`。窗口高度 390 → 480。
- **Coopanion 侧**：控制台「开始」页的 key 输入框旁多一个 **「与 DSH 挂件同步」**。填了 key 就先走它自己的
  保存 + 测试（**测不过就不往下推**，不会把错的令牌同步出去），成功了再推给挂件；输入框留空就以已保存的那把
  为准拉过去。改动落在 `patches/coopanion/0001-dsh-pet-features.patch`（补丁 11 → 12 个文件）。
- 桌面版路由：`GET /dsh-whale/key-sync`（状态）、`POST /dsh-whale/key-sync/push`、`POST /dsh-whale/key-sync/pull`；
  `/key-sync` 只收 `GET`，push/pull 只收 `POST`（其余 405），对方是 Coopanion 控制台自己的源
  （`127.0.0.1:17788`）→ 放行 `OPTIONS` 预检（204 + `Access-Control-Allow-Origin: *`）。
- 最后一次同步结果记在 `~/.dsh/.dshw-key-sync.json`（`lastSyncAt` / `lastSource` / `lastError`），状态接口带出来。

### 边界（为什么这样做）
- **不做后台自动轮询**：除了按按钮，不改你任何一个令牌文件 —— 同步是个显式动作。
- 写的位置只有两处：挂件 `~/.dsh/.credentials.yaml`、Coopanion 当前 provider 的
  `build/data/home/providers/<厂商>/.env`（`<厂商>` 取自 `companion/config.json` 的 `activeProvider`）。
- 只做 DeepSeek 这一把的同步（两个桌宠都只认 `DEEPSEEK_API_KEY`）。

### 自检
- `tools/desktop-apikey-window-test.mjs` **17 → 33 项**：新页面三键、`/key-sync` 状态形状、OPTIONS 预检（204 + `*`）、
  push/pull 的**原值往返**（用完还是同一把；两边本来就不一致时自动跳过，免得改掉真实令牌）、GET 写路由 405。
- `tools/coopanion-feature-test.mjs` **24 → 28 项**：控制台新按钮的源码片段 + 构建产物是否跟上。
- 实测：`push` 用假令牌 → 两边文件同时变成那把（`inSync: true`）；`pull` → 一致；还原后两边都是真令牌
  `sk-3441******d266`；并在**真实控制台源**上跑通跨源 push（浏览器里 `fetch` → 200 + 两边一致）。

---

## [换 Key 入口修复] - 2026-10-09

> 现象：在 DeepSeek 控制台换了新令牌后，**挂件里换不了**（找不到能用的入口）。
>
> 定位（有据）：挂件菜单里的「密钥 / 接口」面板，其**「厂商模板」下拉把内置项排除**掉了
> （`whale-widget.js`：`if (apiTemplates[ti].builtin) continue`），而保存时提交的 `provider`
> 正是取自那个下拉 —— 内置 DeepSeek 模型因此永远拿不到 `'deepseek'`，保存不可能成功。
> 插件是 vendored 上游原样副本（本仓库不改它），所以换 key 的入口补在**桌面版自己的托盘**里。

### 新增
- 托盘菜单 → **「改 API Key…」**：打开小窗口（`/key`），显示当前令牌的**打码值**
  （形如 `sk-3441******d266`），粘贴新 key → 保存 → 写 `~/.dsh/.credentials.yaml` 并自动关窗。
- `GET /dsh-whale/apikey` 多返回一个 `masked` 字段（打码值，用于确认当前用的是哪把）。
- 桌面版路由 `POST /dsh-whale/open-key-window` / `POST /dsh-whale/key-window-done`（给自检与截图用）。

### 修复
- 新窗口打开后**主动提到最前**（瞬时置顶 + `focus`）。从 HTTP 路由/脚本打开时 Windows 不允许
  后台进程抢焦点，窗口会停在别的窗口后面 —— 用户看到的效果就是「点了没反应」。
- Windows / Linux 两个桌面版同步。

### 自检
- 新增 `tools/desktop-apikey-window-test.mjs`（**17 项**）：页面内容、打码字段（断言不含明文）、
  保存接口（拿当前 key 原值写回，内容不变）、空值必须被拒、开窗/关窗路由、GET 写路由应 405。
  设计上**不会改动你的令牌**。

### 现场处置
- 本机挂件当时用的还是旧令牌（`…8030`，DeepSeek 返回 401 `Authentication Fails`），
  Coopanion 用的已是新令牌（`…d266`，HTTP 200，余额 53.28 CNY）。已把新令牌写入
  `~/.dsh/.credentials.yaml`，挂件立即恢复取到余额。
- 提醒：账本是**按 key 指纹分账**的，换 key 后 `今日已用` 会从那一刻重新起算（历史仍在账本里）。

---

## [双系统引导安全 v1] - 2026-10-04

> 主题：**Ubuntu 侧 GPU 挂死 → 强制关机 → Windows 自动修复抢走 GRUB** 的取证、结论与保障。
>
> 用户反馈：今天在 Ubuntu 里测插件时桌面渲染崩溃（画面定格、只剩光标能动），别的操作都没用，
> 只能强制关机；重开机时 Windows 自动修复接管，把 GRUB 覆盖/挤掉，变成「只能进 Windows」。
>
> 结论：**远程仓库里的 GPU 优化本来就是照这台机器做的**（Intel Meteor Lake i915 实测取证），
> 要的就是「拉下来并应用」，不需要另做一套；真正缺的是两个本机特有的开关 —— Ubuntu 侧
> `/etc/fstab` 的 ESP UUID（事故后已从 `2AC8-E406` 变成 `DAA2-C912`），以及 Windows 侧的自动修复开关。
> 详见 [`docs/dualboot-boot-safety.md`](docs/dualboot-boot-safety.md)。

### 取证的坑（重要）
- **只看 Windows 事件日志会得出「一切正常」的错误结论**：崩的是 Ubuntu 会话，Windows 自己关机干净，
  所以既无 `6008` 也无 `41`；`SrtTrail.txt` 也不在装好的系统里（WinRE 的 RAM 盘，重启即丢）。
  本机实测：最近 7 天「开机 25 / 干净关机 24 / 异常掉电 0」，且每次引导都写「上一次关机成功 = true」。
  真正的证据在 **ESP 的卷序列号、`\EFI\ubuntu\*` 与 `\EFI\BOOT\BOOTX64.EFI` 的哈希、以及 BCD/UEFI 启动项**里。

### 新增
- **`tools/boot-safety/check-boot-health.ps1`**（只读体检，退出码 0/1）：机型与固件类型、
  最近 N 天的开关机事件、ESP 的 UUID 与引导文件哈希（含「回退引导是不是被 Windows 换成了 bootmgfw」）、
  BCD `{bootmgr}.path` 是否被篡改、UEFI 启动顺序里 ubuntu 是否第一、快速启动/自动重启状态。
- **`tools/boot-safety/fix-windows-boot-safety.ps1`**（管理员）：先 `bcdedit /export` 备份（可 `bcdedit /import` 回滚），
  再关快速启动、关崩溃后自动重启、复原 `{bootmgr}.path = \EFI\Microsoft\Boot\bootmgfw.efi`、
  把 `ubuntu` 顶回 UEFI 第一启动项；`-Check` 只看不改。
- **`docs/dualboot-boot-safety.md`**：完整时间线、证据表、结论（拉优化 vs 单独优化）、故障链与三个断点的对策、待办清单。

### 本机 Windows 侧已落地（2026-10-04）
- 导出 BCD 备份 → `%USERPROFILE%\dsh-whale-backups\BCD-20261004-013346.bin`
- `AutoReboot`: `1` → `0`；`{bootmgr}.path`: `\EFI\ubuntu\grubx64.efi` → `\EFI\Microsoft\Boot\bootmgfw.efi`
- 复核 `check-boot-health.ps1`：**没发现可疑项（退出码 0）**
- 复查确认：快速启动本来就已关；UEFI 第一启动项本来就是 `ubuntu`；回退引导仍是 ubuntu 的 shim（未被覆盖）

### 踩坑
- `bcdedit` 的**键名会跟着控制台代码页变**：中文代码页下 `identifier` 显示成 `标识符`，
  而 `device`/`path`/`description` 仍是英文；切到 UTF-8（65001）又全变回英文 —— 解析必须两种都认。
- `Win32_Volume` 没有 `Size` 属性，要用 `Capacity`；否则 `$_.Size -le 600MB` 会因为
  `$null` 当 0 参与比较而“意外成立”，容量还会打印成 0 MB。
- 新写的 `.ps1` 必须补 **UTF-8 BOM**（`create_file` 写出的是无 BOM UTF-8，PowerShell 5.1 会按 ANSI 读 → 中文全乱）。

---

## [图层修复 v1] - 2026-10-04

> 主题：**桌宠不再压住一切** —— 默认层级改成「应用窗口 > 桌宠 > 桌面图标」，并给一个「置顶显示」开关。
>
> 起因：用户反馈两个桌宠（DSH 小鲸鱼挂件 + Coopanion 鲸鱼娘）不管打开什么软件都浮在最前面，
> 看视频时一直在屏幕上游。根因是两个窗口都用了 `setAlwaysOnTop(true, 'screen-saver')` —— 那是**最高**层级，
> 连全屏应用都在它下面。
>
> 测试：`tools/desktop-always-on-top-test.mjs` **9/9**、`tools/coopanion-feature-test.mjs` **24/24**、
> `tools/coopanion-sync-roam-test.mjs` **19/19**、`tools/ledger-compat-test.mjs` **25/25**、
> `tools/desktop-plugin-integration-test.mjs` **23/23**；真机用 Win32 `WS_EX_TOPMOST` 做 A/B
> （关 → `normal`，开 → `TOPMOST`）+ DXGI 截屏对照。

### 变更
- **两个桌宠默认都不置顶**：Windows 上就是普通窗口 —— 打开的应用窗口盖住桌宠，桌宠仍在桌面图标之上。
- **DSH 桌面挂件（Windows / Linux）**：托盘菜单新增「置顶显示」勾选项，默认**关**；
  开关值存在 `~/.dsh/.dshw-window.json`（**不能**混进 `.dshw-size.json`：插件保存设置时按固定字段整包覆盖，会把这个键抹掉），
  另提供 `GET/PUT /dsh-whale/always-on-top` 便于自动化与自检。
- **Coopanion 桌宠**：配置项 `worlds.desktop-pet.window.alwaysOnTop`（默认 `false`），
  控制台「习惯」页新增「置顶显示」开关；改动**实时生效**（配置 → World 快照 → 页面 `prefs` →
  `petHost.setAlwaysOnTop` → 主进程 `setAlwaysOnTop`），并随 `--always-on-top=0|1` 传给窗口进程作启动初值。
- **Linux 版的连带改动**：窗口类型跟着开关走 —— 开 → `_NET_WM_WINDOW_TYPE_DOCK`（旧行为，
  dock 的 intellihide 会忽略它）；关 → `NORMAL`（普通窗口，应用窗口能盖住）。
  代价：关着时那个铺满工作区的窗口可能把 autohide 的 GNOME dock 顶掉，介意就把开关打开（已写进文档）。

---

## [Coopanion 桌宠改造 v1] - 2026-10-03

> 主题：**把别人的桌宠改成自己顺手的样子** —— 加调试入口、多一种走动模式、能开机自启且不烦人，
> 并补上 Linux 版与自检脚本。
>
> 因为 Coopanion 是 AGPL-3.0-or-later，改造**以补丁形式**存进本仓库
> （`patches/coopanion/0001-dsh-pet-features.patch`），由安装脚本打上，源码仍不入库。
>
> 测试：`tools/coopanion-sync-roam-test.mjs` **19/19**、`tools/coopanion-feature-test.mjs` **15/15**；
> 补丁做了「回退源码 → 干净应用 → 逐字节比对」的往返验证；
> 另做真机验证：真实鼠标双击 + DXGI 截屏、开机自启 A/B 对照。

### 新增（桌宠，走补丁）
- **聊天气泡左侧的调试入口**：双击桌宠弹出的输入框，左边多一个小齿轮（`⚙ 想说什么… 发送`）。
  按下经 World 的 `control/settings` 打开本地控制台 `http://127.0.0.1:17788/`。
  没有嵌入方时按钮不显示 —— 不给一个按了没用的键。
- **「随刷新率」走动模式**（第四种，接在 不乱动/多待着/常走动 后面）：
  按帧间隔量屏幕刷新率（中位数 + 量化到常见刷新率 + EMA 平滑，长卡顿丢弃），
  速度按 `hz/60` 缩放并夹在 **0.5×~3×**；**步频乘同一个系数**，
  所以每个步幅周期走过的距离恒定（实测各刷新率均为 **37.14 px**）—— 速度变了但脚不滑。
  菜单提示里会写「屏幕约 N Hz」（本机实测 120 Hz）。
- **`--set-autostart=on|off` 命令行开关**，且托盘里的「开机自动启动」在未打包运行时也能用
  （原来被 `app.isPackaged` 挡着）。
- **`--background` 启动不弹调试界面**：引导流程里「桌宠 60 秒没连上就打开设置窗」那句被跳过。
  这就是「开机自启却弹了调试界面」的根因。

### 新增（Linux 版）
- `tools/setup-coopanion.sh`：拉源码/子模块 → 装依赖 → 补 Electron 二进制 → 打补丁 → 构建。
- `tools/coopanion-autostart.sh`：XDG 自启条目（`~/.config/autostart/coopanion.desktop`）登记/撤销/查看。
- 文档写明三个前提：需要 X11（Wayland 走 XWayland）、小鲸鱼要 WebGL（无 GPU 靠 SwiftShader）、
  托盘要 StatusNotifier 宿主（没有也能用右键菜单）。

### 新增（自检）
- `tools/coopanion-sync-roam-test.mjs`：用受控时钟按固定帧间隔推进 `pet-core` 模拟，
  直接量刷新率读数、巡航速度比例、每步幅周期位移；带「抖动的 60 Hz」与「长卡顿」两个反例。
- `tools/coopanion-feature-test.mjs`：查补丁是否打上、构建产物是否跟上
  （控制台页面是打包产物，只打补丁不重构就看不到新选项）、补丁文件与工作区是否一致、
  有没有把调试插桩漏在源码里。

### 踩坑（已写进 `docs/coopanion-integration.md`）
- 桌宠页本体 `web/*` 每请求现读，改完刷新页面即生效；**控制台页面 `console/**` 必须重新构建**。
- `Start-Process -WindowStyle Hidden` 会让 Electron 建的窗口全部隐藏，且 `show()` 之后
  `isVisible()` 仍是 false —— 排查「窗口不出现」时要按正常方式启动。

---

## [桌面版 Linux v1.7 + 扩展版 v32] - 2026-10-02

> 主题：**把路线图剩下的全做完**（含原来标「暂不建议」的两项），
> 并修掉三个会真实影响日常使用的问题（dock / 桌面图标 / 端口冲突）。
>
> 测试：`tools/desktop-enhance-test.mjs` 扩到 **52 项，全绿**；
> 插件回归 `ledger-compat-test` 25/25、`desktop-plugin-integration-test` 23/23。

### 新增（桌面版，全部走增强层，不动 vendored 插件）
- **气泡组（新建 / 切换 / 删除）**：内置 经典/暗夜/樱花/薄荷 4 套，
  并可 `dshwEnhance.bubble.add(name,{fill,text,radius,accent})` 自建、`remove(id)` 删除、
  `use(id)/next()` 切换。
  关键：插件用 `html .dshwv-pop{background:transparent!important}` 重置了气泡容器，
  改背景色无效 —— 必须改 SVG `path` 的 `fill`，所以颜色是真作用到插件气泡上的。
- **心情状态机（多状态形象）**：6 种心情（平常/开心/兴奋/心疼/困了/烦躁），
  信号全部来自本地已有数据（接口失败、久无交互、峰谷时段、今日花费 vs 预算、刚被摸/拖），
  驱动形象滤镜脉冲、台词池、角标表情。只动 `filter` 不动 `transform`，
  避免和插件自己的镜像 transform 打架把鲸鱼翻转坏。
  （按心情换**立绘**需要成套美术素材，已留接口位，默认不开）
- **离线一键抠图**：边界泛洪 + alpha 羽化，纯浏览器端、零依赖、离线。
  算完经 IPC 落盘并新增 `/dsh-whale/matted.png` 路由提供给渲染层，重启后仍生效。
  没上 BiRefNet/onnxruntime 是权衡：模型上百 MB + 拖一个推理运行时对桌面挂件不划算。
- **账单图表三口径**：时（今日按 2 小时）/ 天（近 7 日）/ 月（近 6 个月）。
- **迷你控制条**：鲸鱼旁 🎨（换气泡组）/ 📊（换图表口径）/ ✂️（一键抠图，再点恢复原图），
  三个都是真实可点按钮，并纳入 `setShape` 形状（否则会被裁掉看不见）。

### 修复（日常可用性）
- **dock 开机不显示 / 关完窗口也不回来**：取证发现本机 dock 是
  `autohide=true + intellihide=true + intellihide-mode=ALL_WINDOWS` —— 只要有窗口压到 dock 区域
  就自动隐藏。而我们的窗口是 `_NET_WM_WINDOW_TYPE_NORMAL` 的全屏置顶窗口，
  于是 dock 被它一直顶掉（点一下桌面才恢复），`ding` 的桌面图标刷新也跟着不正常。
  → 窗口类型改为 **`_NET_WM_WINDOW_TYPE_DOCK`**（dash-to-dock 必须忽略 dock 类型窗口，
  否则它自己也会把自己藏起来），并补上 `SKIP_TASKBAR/SKIP_PAGER/STICKY`。
  已实测窗口类型生效。
- **端口冲突导致挂件起不来**：原来 `srv.listen(3090)` 不做任何错误处理，3090 被占就白屏。
  现在按 3090→3091…3098→系统分配 依次回退。
  **实测**：占住 3090 后启动，日志显示「端口 3090 不可用（EADDRINUSE），换下一个」
  → 本地服务端口 = 3091，接口 200，窗口正常。

### 新增（扩展版 v32）
- **A7 音频回退**：原来写死 `/usr/bin/pw-play`（本机实测没有 paplay，而有些发行版只有 paplay）。
  改为按 `pw-play → paplay → ffplay → mpv → gst-play-1.0` 探测能力并缓存，
  播放失败自动换下一个；全都没有才静音并明确报一次日志（不再无声无息）。
- **A6 锁屏降级**：监听 `Main.sessionMode`，锁屏时隐藏挂件并停掉呼吸/特效/跟随定时器
  （省电，也避免出现在锁屏界面上），解锁后恢复。
- **A8 跟随刷新率**：拖动跟随定时器不再写死 16ms，改为按当前显示器刷新率算
  （60Hz→16ms、120Hz→8ms，夹在 8~20ms）。
- **A9 偏好健壮性**：偏好文件解析失败时备份为 `prefs.json.bad` 并从默认值继续跑，
  同时明确报错（不再变成「已配置却读不到」的玄学状态）；数值字段统一夹紧，
  手改出 NaN/负值不会再把界面搞崩。
- **A3/A4 触屏**：新增 `touch-event` 处理 —— 按住可拖动、长按 550ms 当右键唤出菜单
  （触屏没有右键）。

---
## [桌面版 Linux v1.4] - 2026-10-02

> 主题：**把「泡泡渲染坏了」这类问题从根上堵死**。
> 上一版只解决了「浮层被裁」这一种成因；这一版重新审视了整条链路。

### 根因复盘
`setShape` 在 Linux 走 X11 **ShapeBounding**，它**同时裁剪绘制与输入** ——
形状漏掉哪块像素，那块就**直接被裁掉看不见**（不是「少穿透」，是「消失」）。
而形状来源是 preload 的 **DOM 启发式**推断，天然会漏：
- `paints()` 判断「某元素画没画东西」会漏：插件气泡本体是 **SVG**，元素自身
  `background` 是 `transparent`、又没有**直接**文本子节点 → 被判为没画东西
- 阴影 / 伪元素 / 溢出内容会超出元素自己的盒模型
- 数量上限会**直接截断**（`dedupe` 按面积降序 + 到上限就 `break`，
  小矩形会被静默丢弃）

### 修复
- **两层浮层互盖**（真凶之一）：插件自己的气泡/面板就画在鲸鱼**上方**，
  与增强层角标是同一块地盘。实机截图里插件的「DeepSeek 余额 / 今日已用」
  面板与我们的汇率、峰谷角标完全叠在一起。
  → 新增避让：插件 UI（`.dshwv-pop-open` / 菜单 / 面板 / 各种 mask）一出现，
  增强层浮层立即隐藏，退场后 200ms 内自动恢复；
  气泡打开时挂起的提示会自动延后重试（最多 3 次）
  → 上一版漏了 `.dshwv-pop`（气泡本体）不在避让名单里，这一版补上
- **形状数量上限截断**：`dedupe` 不再因数量上限丢弃矩形（除非被更大矩形完整包住），
  `MAX_RECTS/MAX_SHAPE_RECTS` 抬到 400 且只当保险丝
- **像素兜底形状**（新增）：从页面真实渲染结果反推不透明区域，与 DOM 结果取**并集**
  （只增不减，原理上不可能造成新裁切）。
  实测本机透明窗 `capturePage()` 拿到的是**全透明帧**，连续 3 帧为空即**自动退避**
  并停止白白耗 CPU —— 这条路径在本机不可用，但保留给能用的平台
- **气泡皮肤真正生效**：插件用 `html .dshwv-pop{background:transparent!important}`
  重置了气泡容器，改背景色没用；改为改 SVG `path` 的 `fill`
  → `night / sakura / mint` 现在能真正改变插件气泡配色，不再只影响增强层浮层
- **拖动期间形状放整窗**（v1.3 已做）+ 安全网：必须「鼠标确实按住」且
  「插件标记了 dragging」同时成立，避免类名卡住导致整窗吞点击

### 测试
- `tools/desktop-enhance-test.mjs` 扩到 **30 项**，新增避让回归：
  「初始状态角标可见 / 插件菜单打开时角标隐藏 / 菜单关闭后角标恢复」
- 实测：**30/30 通过**；打包产物 23/23 + 拖动位移与预期一致

### 已知限制
- 本机（Wayland + XWayland 透明窗）`capturePage()` 取不到内容，像素兜底自动停用，
  形状以 DOM 上报为准（已去除截断、上限放宽）

---

## [桌面版 Linux v1.3] - 2026-10-02

> 主题：**修掉两个实机可见的渲染/交互 bug** + 把路线图剩余 4 项一次性补齐。
> 新增 `tools/desktop-enhance-test.mjs`（CDP 端到端测试），**打包产物 23/23 通过**。

### 修复
- **泡泡/角标被裁掉一半**（用户报「显示的泡泡窗口渲染有问题」）
  - 根因：增强层浮层挂在 `document.documentElement` 上，而 `preload-linux.js` 的
    `scanOthers()` 只遍历 `document.body` → 这些元素不算「可见内容」→ 不进
    `setShape` 形状 → 被 X11 ShapeBounding **当成不该画的部分裁掉**
  - 实证：截图里 `⛰ 高峰 2h43m 后切换` 被切成 `▲ 高峰 2h43`
  - 修复：① 浮层一律 `mount()` 到 `<body>`；② preload 里按选择器给 `.dshwe-*`
    加**硬保名单**（`scanOthers` 的 `paints()` 是启发式判断，可能漏判）
- **不能在全屏随意拖动**（用户报「不好在全屏幕随意拖动」）
  - 根因：插件拖拽靠 document 级 `pointermove`，而形状是节流更新的；快速拖动时
    指针瞬间跑到鲸鱼形状之外 → Chromium 派发 `pointercancel` → **拖动中断**
  - 修复：拖动期间（`.dshwv-root.dshwv-dragging`）**形状直接放成整窗**，指针永不
    跑出输入区。安全网：必须「鼠标确实按住」+「插件标记了 dragging」同时成立
  - 顺带：`SEND_INTERVAL` 33ms → 16ms、`PAD_MOVE` 56 → 80（跟手更紧、更不易切边）
- **角标/气泡贴右边被切尾**：定位原用写死的 `innerWidth - 160/240/300` 估算宽度，
  改为 `place()` **实测元素尺寸后再夹进视口**；比视口还宽时自动允许换行
- **浮层错位**：鲸鱼会浮动/被拖动，而角标原本只在自己刷新时定位一次（可能间隔 20s）
  → 新增 `follow()` 每 200ms 校准一次

### 新增（对齐 Windows 独立版，路线图第 2–6 项）
- **多币种汇率**：余额按实时汇率折算，角标显示 `💱 ¥86.19 ≈ $12.82 USD`，
  点击在 `USD → EUR → JPY → GBP → HKD → 关` 之间循环（JPY 不带小数）。
  余额走插件同源的 `/dsh-whale/balance.json`，汇率走 `open.er-api.com` + 本地 6h 缓存；
  拿不到汇率就**不显示**，不冒错数据
- **三态主题**：`dark` / `light` / `glass`（毛玻璃）/ `auto`（跟随系统），
  `window.dshwEnhance.theme('glass')` 切换
- **多套气泡组**：`classic` / `night` / `sakura` / `mint`，同时作用于插件气泡与增强层浮层，
  `window.dshwEnhance.skin('sakura')` 切换
- **台词轮播**：按 `speechMinutes` 随机冒一句台词（默认 10 分钟，`speechOn:false` 关闭）
- **账单图表**：近 7 日用量柱状图（今天那根高亮）。数据取插件的
  `/dsh-whale/usage-records.json`；**启动时速览一次**，**余额变化时自动冒一次**，
  也可点汇率角标右键手动唤出

### 测试
- 新增 `tools/desktop-enhance-test.mjs`：走 CDP 真实操作 DOM 并截图存档，覆盖
  浮层几何（必须完整在视口内 + `scrollWidth <= clientWidth` 防 CSS 截断）、
  三态主题生效且配色确实不同、四套气泡皮肤、图表柱条数量与高亮、提示不越界
- 实测（打包产物）：**23/23 通过**；拖动测试鲸鱼位移与预期 X 完全一致
- 截图对比（dark / light / glass / sakura）确认浮层完整、无裁切

---

## [扩展版 v31] - 2026-10-02

### 修复（未来兼容性 / 静默失效）
- **GJS `Uint8Array` 兼容**：4 处 `data.toString()` / `JSON.parse(bytes.get_data())` 统一改为
  `decodeBytes()`（内部用 `TextDecoder`）。`journalctl` 已对 `Uint8Array.toString()` 发出弃用警告，
  未来 GJS 版本会改为返回逗号分隔的数字串 —— 届时凭据 / 账本 / 偏好 / 余额都会**静默读不到**
  （表现为「已配置却提示未配置」）。本版先消除该隐患

### 新增（多显示器）
- **显示器热插拔守卫**：监听 `Main.layoutManager` 的 `monitors-changed` 与 `global.display` 的
  `workareas-changed`，变化后把鲸鱼夹回合法工作区（已贴边则重新贴边）
  —— 修复「拔掉外接屏 / 改分辨率或缩放后，鲸鱼停在已消失的显示器坐标上而不见了」
- **跨显示器拖动**：拖动时的边界以「指针所在显示器」为准，可把鲸鱼从主屏拖到外接屏
- **吸附 / 气泡 / 菜单**改为跟随「鲸鱼当前所在显示器」的 `workArea`（此前一律按主屏计算，
  在外接屏上吸附会跳回主屏）
- **「回到左下角」**明确定义为主屏左下角（多显示器下不再受当前所在屏影响）

### 变更
- `metadata.json` 的 `version` 由 `1` 对齐为 `31`（与本节版本号一致）

### 说明
- 显示器相关改动在本机（Ubuntu 24.04 / GNOME 46 / Wayland，DP-1～DP-4 当前未接外接屏）**无法完整实机
  覆盖**，验收口径与测试矩阵见 `docs/linux-adaptation-plan.md`（D5 / T5）
- 本次**未改**：触屏长按菜单（A3）、音频回退（A7）、锁屏降级（A6）等，见该文档 §3 与 §10

---

## [扩展版 v30] - 2026-09-04

### 优化（动画流畅度）
- 拖动跟手采样 30ms→**16ms（60fps）**，与屏幕刷新对齐，消除拖动顿挫感
- 余额数字滚动 30ms→**16ms（60fps）** 并做**文本去重**：数值未变化时不触发整块重排
- 气泡尾随：目标位置未变时跳过重定位与尾巴重绘，减少与滚动动画抢帧

## [扩展版 v29] - 2026-09-04

### 新增（令牌模式·今日已用精算）
- 读取 `DEEPSEEK_PLATFORM_TOKEN`，调用平台用量接口
  `platform.deepseek.com/api/v0/usage/by_api_key/amount` 拉取今日 token 消耗
- 按 DeepSeek **峰谷定价**（空闲/高峰两档）换算为今日金额：base/pro 分档、命中/未命中/输出分项，
  周末（2026-08-23 起）全天低谷价
- 内置 60s 结果缓存；**无 token / 接口失败自动回落记账模式**，绝不阻断余额展示
- 右键菜单「📒 用量」支持 记账 ⇄ 令牌 切换并持久化；切换无 token 时气泡给出配置提示

## [扩展版 v28] - 2026-09-04

### 新增
- 音色主题由 3 套扩至 **6 套**：默认 / 叮咚(bell) / 低沉(low) / 柔和(soft) / 活泼(pop) / 清脆(chirp)
  （新增 `sfx_pop_*`、`sfx_chirp_*` 音效素材）
- 卖萌台词扩至 17 条，新增「吐槽」句组
- 台词改为**加权随机**：峰谷提示 4.5 / 卖萌 3 / 吐槽 1.6 / 今日已用专属 1.2（仅今日有消耗时）

## [扩展版 v27] - 2026-09-04

### 新增（数字滚动动画）
- 同币种余额金额变化时，气泡首行金额 700ms ease-out-cubic **平滑滚动**到新值（30ms 帧驱动、可中断清理）

## [扩展版 v26] - 2026-09-04

### 新增（今日已用·小鲸鱼记账）
- 余额差值记账：观测到余额下降即累计为「今日已用」，跨天归零并按 30 天滚动归档
- 币种感知：多币种切换时只重置基准，避免虚记
- 账本写入 `~/.dsh/.dshw-usage.json`，与 dsh-web 账本文件格式兼容
- 气泡升级为三行：💬 余额 / 📊 今日已用 / 随机台词

## [扩展版 v25] - 2026-09-04

### 新增（自动轮询）
- 余额 60s 自动轮询：启动即**静默对齐**缓存；仅当余额实际变化才弹泡
- 防重入保护（避免并发请求）；右键菜单「🔄 自动刷新 60s/关」开关并持久化

## [扩展版 v24] - 2026-09-04

### 新增（四边 + 四角吸附）
- 松手后按鲸鱼中心所在视口外侧 1/4 带，水平/垂直**独立**贴边或贴角（两轴自由组合）
- 记录贴边状态：缩放、回到左下角后仍保持贴边

## [扩展版 v23] - 2026-09-04

### 修复
- **根治左缘抖动**：改为按住时记录「抓取偏移」+ 跟随单调边界 clamp（此前临界点翻转造成 200px 级抖动）

### 新增
- 右键菜单完善：音色主题循环 / 音量调节行 / 音效开关 / 气泡开关 / 峰谷文案切换 / 隐藏(禁用扩展)
- **摸摸头互动**：左键轻点 → 开心小跳 ×3 + 飘爱心/音符 + 卖萌台词气泡
- **静置动效**：飘音符/爱心、眨眼、双音符（像 gif 一直在动）
- 偏好持久化：音色 / 音量 / 音效 / 气泡 / 峰谷文案 / 自动刷新 保存到 `~/.cache/dsh-whale/prefs.json`

## [扩展版 v22] - 2026-09-04

### 新增
- 气泡可**点击换台词**（不重复请求余额）
- 缓存上次余额；气泡出现改为 Q 弹（scale ease-out-back）动画

## [扩展版 v21] - 2026-09-04

### 修复
- 左缘抖动缓解：跟随即时定位（不用 ease）、吸附动画去掉超调（EASE_OUT_QUAD）
- 气泡增加小尾巴，指向鲸鱼并防越界

## [扩展版 v20] - 2026-09-04

### 新增（右键菜单）
- 右键菜单雏形：查看余额 / 回到左下角 / 放大 / 缩小 / 音效开关 / 峰谷文案切换（默认 · 梁文峰谷 · !?强强?!）

## [扩展版 v19] - 2026-09-04

### 新增
- 音效（拿起/放下/摸摸头，`pw-play` 播放，按音色主题与音量）
- 呼吸动画（静置时上下浮动）；台词库扩充
- 桌面菜单入口脚本归档（`desktop-menu.sh` + `.desktop`，显示余额/重启扩展联动）

## [扩展版 v18] - 2026-09-03

### 变更
- 启动默认停靠**左下角**；移除位置记忆（回到固定默认位，行为更可预期）

## [扩展版 v17] - 2026-09-03

### 修复
- 反转镜像方向：贴左朝右、贴右朝左（朝向屏幕内），观感修正

## [扩展版 v16] - 2026-09-03

### 修复
- 翻转改由鲸鱼所在**半屏**决定（更符合预期）
- 松开兜底：鲸鱼本体绑定 button-release 双保险，避免卡在跟随态

## [扩展版 v15] - 2026-09-03

### 新增
- 接近边缘时提前翻转贴合；气泡 30ms 平滑跟随鲸鱼

## [扩展版 v14] - 2026-09-03

### 新增
- **贴边吸附** + 按所贴侧镜像朝向
- 气泡锚定鲸鱼且防越界跟随

## [扩展版 v13] - 2026-09-03

### 变更
- 交互改为「按住=跟随、松开=停靠」；单击出余额台词

## [扩展版 v12] - 2026-09-03

### 新增
- 跟随模式 + 随机台词 / 峰谷提示 + 贴边吸附
- 扩展版从此进入逐版迭代的稳定主干（v10/v11 早期快速迭代并入本版）

## [扩展版 v9] - 2026-09-03

### 新增（扩展版首个可用版本）
- 新增 GNOME Shell 扩展版小鲸鱼：解决 Wayland 会话 Electron 透明窗不可悬浮的问题
- 鲸鱼悬浮于 Shell 层；拖拽移动（限主屏工作区）、按压回弹；点击读取 API Key 显示余额气泡
- 配套 `install.sh` 安装脚本与扩展元数据（uuid `dsh-whale@local`，Shell 45–47）

---

## [桌面版 Linux v1.2] - 2026-10-02

### 新增（桌面版增强层 —— 不修改 vendored 插件本体）
- 新增 `assets/desktop-enhance.js`：由主进程在插件脚本**之后**注入，用于叠加桌面版特有功能。
  这样 `dsh-whale-widget/` 继续保持**原样 vendored**，上游升级插件时不产生冲突
- **峰谷提前预警**（对齐官方 Windows 独立版、插件本体缺失）：进入/离开高峰前 N 分钟提醒
  （默认 10 分钟，可配），并常驻显示「现在高峰/谷价，还有多久切换」角标
  · 配置：`localStorage['dshwDesktopEnhance']`，或控制台 `window.dshwEnhance.set({leadMinutes:15})`
- 验证：`/dsh-whale/desktop-enhance.js` 返回 200；渲染进程日志确认增强层加载与提示执行；
  `setShape` 自检仍为不透明像素覆盖 100%（无回归）
- 未实现（路线图见 `docs/feature-comparison.md`）：多币种汇率、多套气泡组、台词轮播、账单图表、三态主题

### 工程（打包链修复）
- `build.deb.depends` 加 t64 备选：Ubuntu 24.04 把 `libgtk-3-0` / `libatspi2.0-0` 改名为 `*t64`，
  原名不存在会让 `dpkg -i` 被依赖阻断；改为 `libgtk-3-0 | libgtk-3-0t64` 等，兼容 22.04/24.04
- 补 `homepage`（fpm 生成 deb 必需）、`desktopName` + `linux.syncDesktopName`（修 dock 窗口关联）、
  `build/icon.png` 512×512（此前用默认 Electron 图标）
- 产物：`dsh-whale-widget-1.0.0-x86_64.AppImage`（126 MB，已实际运行验证）；
  `dsh-whale-widget-1.0.0-amd64.deb`（101 MB，9 组依赖在 24.04 全部可满足）

---

## [桌面版 Linux v1.1] - 2026-10-02

> 实机基线：Ubuntu 24.04.4 / GNOME 46 / **Wayland** / Intel Meteor Lake / 3120×2080 缩放 2.0

### 修复（阻断性 —— 此前 Linux 版实际上不可用）
- **点击穿透在 Linux 上失效且反向有害**：`setIgnoreMouseEvents(true, {forward:true})` 的 `forward`
  官方只支持 macOS/Windows。实机探针实测：Linux 下窗口仍收到**全部** mousemove，且透明区域的
  点击**不会穿透**到下层窗口（背景窗 0 次收到）→ 一个全屏透明窗会**挡住整个桌面的点击**。
  现改用 `win.setShape(rects)`：实测区域外点击可**精确穿透**（背景窗准确收到点击坐标）。
  实测效果：`ShapeBounding` 从整窗 5,846,880 px² 收窄到 **325,056 px²**（约 5.6%），其余全部穿透
- **强制 XWayland**：`--ozone-platform=x11` 必须作为**命令行参数**传入（在 main.js 里 `appendSwitch`
  太晚，Chromium 已选好 Ozone 平台）。不强制时会跑原生 Wayland：没有 X11 窗口（`setShape` 不可用）、
  `screen.getCursorScreenPoint()` 恒返回 `(0,0)`、`setAlwaysOnTop` 无效。现由主进程启动时
  **自动用正确参数重启一次自己**（AppImage 下用 `APPIMAGE` 本体）
- **Ubuntu 24.04 沙箱**：AppImage 无法保留 setuid `chrome-sandbox`，而 24.04 默认禁止非特权
  user namespace → Chromium 沙箱必然启动失败。现在检测到「userns 受限 + 无 setuid 沙箱」时
  自动附加 `--no-sandbox`（deb 安装有 setuid 沙箱则不加，保留沙箱）
- **开机自启路径失效**：AppImage 下 `process.execPath` 是 `/tmp/.mount_xxxx/...` 临时挂载点，
  重启后必然失效。改为优先 `process.env.APPIMAGE`；`Exec` 加引号并带上 `--ozone-platform=x11`
- **单实例锁**：新增 `requestSingleInstanceLock()` —— 自启与手动启动撞车时会抢 3090 端口，
  导致第二次启动崩溃

### 新增
- `preload-linux.js`：Linux 专用 preload。按 PNG alpha 轮廓把鲸鱼切成 16 条横向分带
  （比整块方形贴合得多），加上其它可见元素（面板/气泡/飘字）的矩形，去重后上报主进程 `setShape`。
  实测确认 `setShape` 走的是 X11 **ShapeBounding**，会**同时裁剪绘制**，因此：鲸鱼移动中自动用
  大 padding（56px，绝不被裁切），静止 250ms 后收紧到 12px（穿透更精确）；最多约 30fps 上报，
  形状不变则不重复调用

### 说明
- 本轮改动只针对 `dsh-whale-desktop-linux/`；Windows 版沿用官方支持的 forward 方案，不受影响
- 已实机验证：自动重启、X11 窗口建立、`setShape` 生效、23 条插件路由加载
- **尚未做视觉验收**（鲸鱼是否被裁切、穿透手感、拖动是否跟手），需人工确认

---

## [桌面版 v1.0] - 2026-09-02

### 新增
- **Windows 桌面挂件**（`dsh-whale-desktop/`，Electron）：无边框透明置顶悬浮窗、满桌面拖动、
  像素级点击穿透、菜单内改 API Key、开机自启（计划任务）、打包便携 exe
- **Linux 桌面挂件**（`dsh-whale-desktop-linux/`）：Ubuntu 22.04 / 24.04 amd64，
  AppImage/deb 构建、XDG 开机自启（X11 会话可用）
- **DSH 网页版插件**（`dsh-whale-widget/`）：随 dsh web 自动启用，每轮对话统计消耗
- 本地直连 `api.deepseek.com/user/balance`；余额差值本地记账 `~/.dsh/.dshw-usage.json`
- GitHub Actions CI 自动构建 Windows exe + Linux AppImage/deb

## 变更与杂项

- `2026-10-02` chore(widget)：vendored 上游插件 **v0.3.16 → v0.3.17**（整目录覆盖，与上游 tag `v0.3.17` 逐字节一致）
  - 变更规模：前端 `assets/whale-widget.js` +282 行、宿主 `lib/index.js` +17 行；新增 `tools/check-dead-settings.mjs`、`.gitattributes`
  - 内容：②区「提示音量」死控件修复（音量解析器 + 三态，含音效组）、②区「冒泡提示」开关接上、设置保存失败可见化、
    等待提问/授权气泡可点关、死键体检护栏
  - 验证：`tools/ci-audit.mjs --no-pack` **5/5**、`tools/ledger-compat-test.mjs` **25/25**、
    `tools/desktop-plugin-integration-test.mjs` **23/23**（含回环/同源安全栅栏用例）
  - 两个桌面版经 `host-shim.js` 直接复用本插件（`path.join(appDir,'..','dsh-whale-widget','lib','index.js')`），**自动获得同样更新**
- `2026-10-02` chore(third-party)：上游研究克隆的 remote 由失效的 `ghfast.top` 代理改为直连；解除浅克隆（`--unshallow`）并补齐 `For-Codex` / `For-Windows` / `For–WinDesktop` 三个分支
- `2026-10-02` docs：新增 `docs/linux-adaptation-plan.md` —— Linux 适配实机基线（Ubuntu 24.04.4 / GNOME 46 / Wayland /
  Intel Meteor Lake / 3120×2080@120Hz 缩放 2.0 / 内建触屏）、仓库代码状态（合并远端 v0.3.16 与 host-shim 桌面版）、
  形态取舍（扩展版为主力；Electron 版按 T11 实测结果定性）、A1–A10 改造项、外接显示器与触屏专项风险、
  完成判定标准 DoD（D1–D13）、交付前测试方案（T0–T12，含 CDP 测试盲区说明与真实鼠标验证）
- `2026-10-02` merge：合并远端 6 个提交（插件同步 v0.2.10→v0.3.16、桌面版 host-shim 直跑插件本体、
  点击穿透判定改通用 `pointer-events` 语义、新增 4 个测试工具）；`README.md` 4 处冲突已人工解决
- `2026-09-04` chore：`third-party/` 加入 .gitignore（仅存放上游研究克隆，不入库）
- `2026-09-02` chore：忽略 Windows 便携 exe 构建产物（由 CI 自动构建分发）

## [Coopanion Linux 完善 v2] - 2026-10-02

### 修复（上游「Linux 版开发不完全」的 4 个根因）
- **桌宠窗口不出现**：`--pet-host` 是**子 Electron 进程**，而 `appendSwitch()` 不继承。
  补 `ELECTRON_OZONE_PLATFORM_HINT=x11` + 给子进程显式 `--ozone-platform=x11`。
  原先子进程退回原生 Wayland（窗口不能自定位/置顶）→ 窗口从未被创建。
- **全屏透明窗吞掉整个桌面点击**：Linux 上 `setIgnoreMouseEvents(true,{forward:true})`
  是空操作。改用 `win.setShape()`（X11 ShapeBounding，同时裁剪绘制与输入）。
- **形状变全屏**：形状上报误把全屏 `<svg>` 容器算进去；改为只白名单叶子几何标签。
- **白色方块残影**：`setShape` 放大后新区域未绘制 → 补 `webContents.invalidate()`。
- 额外：`xprop` 把窗口类型设为 `_NET_WM_WINDOW_TYPE_DOCK`，避免 dash-to-dock 自动隐藏。

### 新增
- `tools/coopanion-linux-test.mjs` —— Linux 端到端自检 **26 项全绿**，含真实 CDP
  右键菜单、「行为模式」逐按钮点击并验证标签变化、装扮页、X11 抓屏渲染校验、截图存档。
- `tools/setup-nvidia.sh` + `docs/coopanion-linux-and-nvidia.md` —— Linux NVIDIA
  显卡对接**预制配置**（本机无 N 卡：检测到就只报告、零副作用；有 N 卡则写入
  PRIME 卸载/EGL 直通环境并注入自启项，附 `nvidia-selftest.sh`）。
- Coopanion 与 DSH 桌面端均接上 `COOPANION_GPU_FLAGS` / `DSH_GPU_FLAGS`（空值时行为不变）。
- `patches/coopanion/0001-dsh-pet-features.patch` 重新固化（含新增
  `host/electron-main.cjs`、`host/preload.cjs`）。

### 验证
- `node tools/coopanion-linux-test.mjs` → 26/26 通过
- `node tools/coopanion-feature-test.mjs` → 15/15 通过

## [自启修复 + GPU 稳定性复核] - 2026-10-03

### 修复：Live2D 鲸鱼娘开机自启静默失败
- 根因：`petctl.sh` 启动 Live2D 时**漏了 `--no-sandbox`**（DSH 那条一直带着）。
  本机 electron 的 `chrome-sandbox` 不是 setuid root，而 Ubuntu 24.04 默认
  `apparmor_restrict_unprivileged_userns=1` 封掉了非特权 userns 回退 →
  Electron 直接 `FATAL:setuid_sandbox_host.cc:166` 退出，外观上就是「自启没生效」。
- 主进程与 `--pet-host` 子进程（独立 Electron 进程，不继承 appendSwitch）都补上参数。
- 新增 `tools/autostart-pet.sh`：等 mutter 就绪 → 启动 → 失败退避重试 4 次 → 全程写日志。
  自启项改由它调用，把过去的「静默失败」变成「等一等、重试、留痕」。

### 修复：GPU 健康度误报
- `petctl.sh status` 的 `gpu_hang_count` 未限定内核日志，把 gpu-watchdog 服务
  **自己的启动文案**（"检测 i915 GPU HANG ..."）当成挂死记录 → 假阳性 degraded。
  改用 `journalctl -k`（只看内核），`diagnose.sh` 同步修正。

### 复核结论（重启后，i915 参数已生效）
- 内核参数 `i915.enable_psr=0 enable_dc=0 enable_fbc=0 i915.reset=1` 已生效
- 本次开机 **真实 GPU 挂死 0 次**（此前两天 59 次）→ PSR/DC/FBC 修复有效
- `gpu-watchdog.service` 已安装并运行
- 剩余上游修复：内核提示 `GuC firmware 70.53.0 is recommended, but only 70.36.0 found`
  → 建议 `sudo apt install --only-upgrade linux-firmware`（能真正修掉 GuC TLB 失效超时）

## [最终审核 + 触屏测试稳定性] - 2026-10-03

### 复核（重启后，i915 参数已生效）
- 本次开机**真实 GPU 挂死 0 次**、mutter D-Bus 超时 0 次（此前两天 59 次）
- `gpu-watchdog.service` active + enabled，触发 0 次
- `linux-firmware` 已升级 `0ubuntu2.27` → `0ubuntu3.1`；但内核里加载的仍是
  `mtl_guc_70.bin 70.36.0`，仍提示 "70.53.0 is recommended" —— **固件在驱动初始化时加载，
  需要重启才会换上新固件**
- 测试：端到端 26/26、触屏 21/21、功能与补丁一致性 15/15、补丁逐字节无漂移

### 触屏测试稳定性修复（测试自身缺陷，非产品问题）
用隔离实验逐条排除了「产品会把宠物窗口弄消失」的怀疑：
- 单独调 `petHost.focus()` → 窗口仍 `IsViewable`（不是它）
- 单次点「打字和我说话」→ 仍 `IsViewable`
- 连续 20 次猛点宠物身体 → 仍 `IsViewable`
结论：之前的 unmap 是**测试流程**造成的 —— 长按弹出的菜单没关掉，后续候选点
正好点在菜单最后一项「隐藏桌宠」上。已修：
- `closeMenus()`：关菜单 + 关气泡（气泡会撑大墨迹包围盒，导致推算坐标落到气泡上）
- 拖拽改为**朝屏幕中心**拉（原来一律往右，把宠物拖出视口 → 形状塌缩成 1x1 → 后续量不到墨迹）
- 拖拽后只等 250ms 就测量（宠物放手后会 `walkTo(home)` 往回走，等 900ms 只能测到残值）
- 每节开头断言「窗口仍可见」，让失败归因清晰

## [剩余待办全部完成] - 2026-10-03

### 新增：DSH 小鲸鱼里的 Live2D 开关（两个入口）
- **迷你控制条**：🎨 📊 ✂️ 之后新增 **🐋**，点一下开关 Live2D 鲸鱼娘。
  走 preload 的 `dshwBridge.petToggle` → 主进程 → `tools/petctl.sh`。
- **托盘菜单**：新增「Live2D 鲸鱼娘（开 / 关）」，失败时弹通知而不是静默。
- 启动统一走 `petctl.sh`（AppImage 里没有仓库路径，故用候选路径 + `DSHW_PETCTL` 覆盖）。
- ⚠️ 这两个入口在 **AppImage 里**，改完源码必须重建：`bash dsh-whale-desktop-linux/build-linux.sh`
  并把新产物复制到 `~/Applications/`（已实际重建并部署验证）。

### 新增：GNOME 顶栏控制图标 `dsh-whale-pets-tray/`
- 顶栏 🐋 按钮 → 菜单显示两个桌宠状态（● 运行 / ○ 已停），点条目即开/关。
- 动作全部转发 `petctl.sh`：桌面图标 / 开机自启 / DSH 控制条 / 顶栏，四个入口同一套实现。
- 状态读取用 `Gio.Subprocess` 异步，不阻塞 Shell 主循环；只在开菜单时刷新，不做轮询。
- 安装：`bash dsh-whale-pets-tray/install.sh`，**之后必须注销重新登录**
  （GNOME Shell 只在启动时扫描扩展目录）。

### 新增：降低 GPU/CPU 持续负载（针对 GPU 挂死的诱因）
- **Coopanion**：shape 上报从「固定 60ms 一直跑」改为自适应 —— 形状变化中 50ms
  快速跟随，连续稳定 8 次后降到 320ms 巡检。
- **DSH 挂件**：主循环从「每帧全量重算」（60 次/秒的 DOM 遍历 + 数组构造 + 序列化）
  改为形状稳定约 0.7s 后降到 250ms 巡检；任何指针活动/拖动立刻拉回逐帧。
- 实测空闲 CPU：DSH 渲染进程 ≈5.9%，Coopanion 渲染进程 ≈16.9%。

### 清理
- 卸载旧 GNOME 扩展 `dsh-whale@local`（悬浮鲸鱼本体），源码仍保留在
  `dsh-whale-shell-extension/`；旧脚本 `~/.local/bin/dsh-whale-widget` 已改名为
  `.legacy-disabled`。

### 验证
- Coopanion 端到端 **26/26**、触屏 **21/21**、功能与补丁一致性 **15/15**，补丁无漂移
- **齿轮按钮实测**：点桌宠气泡里的齿轮 → 主进程新建页面 `http://127.0.0.1:17788/#/home`（控制台真的打开）
- 端到端实测 🐋 开关：`petToggle('live2d')` → `live2d=stopped` → 再点 → `live2d=running`
- DSH 新构建已验证：`{"hasBridge":true,"ctlButtons":["🎨","📊","✂️","🐋"],"hasWhaleBtn":true}`

