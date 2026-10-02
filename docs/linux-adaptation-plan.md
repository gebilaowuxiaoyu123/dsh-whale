# DSH 小鲸鱼 · Linux 适配规划与交付方案

> 本文是「Linux 桌面适配」的调研结论 + 实施规划 + 风险登记 + 验收/测试口径。
> 基线数据于 **2026-10-02** 在目标机上实机采集（非推测），采集命令见各节脚注。

---

## 0. 实机环境基线

| 维度 | 实测值 | 影响 |
|---|---|---|
| 发行版 | Ubuntu **24.04.4 LTS** (noble)，内核 `7.0.0-28-generic` | 决定 AppArmor/沙箱、GNOME 版本 |
| 会话 | **Wayland**（`XDG_SESSION_TYPE=wayland`，`wayland-0`）；`DISPLAY=:0` → XWayland 可用 | 决定扩展版为首选形态 |
| 桌面 | **GNOME Shell 46.0**，`XDG_CURRENT_DESKTOP=ubuntu:GNOME`，session mode `ubuntu` | 扩展 `shell-version` 声明的 45/46/47 覆盖 ✅ |
| 机型 | HUAWEI `VGHH-XX` / `M1010`（笔记本） | 含内建屏 + 内建触屏 + 4 路 DP |
| GPU | Intel **Meteor Lake-P**（Arc Graphics，`8086:7d55`），驱动 **i915**（`xe` 模块存在但未加载）；**单卡无独显** | 排除 NVIDIA PRIME/混合渲染坑；透明合成走 iris |
| 显示器 | 仅 `eDP-1`（VXN `VisN236HUZ15`）**3120×2080 @120Hz**，缩放 **2.0**；`DP-1`~`DP-4` 全部 `disconnected` | 当前是**真 HiDPI + 高刷**单屏 |
| 缩放设置 | `scaling-factor=0`(auto)、`text-scaling-factor=1.0`、`experimental-features=[]`（未开分数缩放） | 只有整数 2.0；外接屏很可能 1.0 → 混合缩放场景 |
| **触屏** | **有**：`ICNT9288:00 7F7F:9288`（i2c-hid，`ID_INPUT_TOUCHSCREEN=1`，走 `i2c_designware.1`），多点触控 | 必须按触摸设备适配，不能只做鼠标 |
| 触摸板 | `GXTP7863:00 27C6:01E0 Touchpad` | 拖动跟手性基线 |
| 托盘 | `ubuntu-appindicators@ubuntu.com` **已启用** | 本机托盘**可用**（GNOME 默认无托盘，靠该扩展补齐） |
| 音频 | `pw-play` ✅ `/usr/bin/pw-play`；`paplay` **缺失**；`aplay`/`ffplay`/`mpv`/`canberra-gtk-play` 可用 | 扩展硬编码 `pw-play`，本机可行但无回退 |
| 已启用扩展 | 14 个：`ubuntu-dock`、`ubuntu-appindicators`、`ding`、`blur-my-shell`、`hanabi`、`compiz-windows-effect`、`clipboard-indicator`、`Vitals`、`live-lockscreen`、`tiling-assistant`、`apps-menu`、`user-theme`、`extension-list`、`reboottouefi` | 冲突面见 §6 |
| 扩展安装状态 | `dsh-whale@local` **已安装并启用**；`extension.js` 与仓库版本**逐字节一致**（46,714 B，无漂移） | 可直接在本机做验收 |
| 运行数据 | `~/.dsh/.credentials.yaml` 含 `DEEPSEEK_API_KEY`；`~/.dsh/.dshw-usage.json`：`date=2026-10-02`、`todayUsage=0`、`lastBalance=89.55 CNY`、`history` 2 天 | **余额与记账链路正常** |
| 偏好 | `~/.cache/dsh-whale/prefs.json` **尚不存在** → 全默认值 | 偏好持久化路径**未被实际走通**，需纳入验收 |

> 采集命令：`XDG_SESSION_TYPE`/`loginctl show-session`、`gnome-shell --version`、
> `lspci -nnk`、`/sys/class/drm/*/status`、`gdbus … org.gnome.Mutter.DisplayConfig.GetCurrentState`、
> `udevadm info --query=property --path=/sys/class/input/inputN`、`gnome-extensions list --enabled`、
> `journalctl --user -b`。

---

## 1. 结论摘要（TL;DR）

1. **本机是 Wayland + HiDPI(2.0) + 120Hz + 内建触屏**，这是适配的真正主战场。
2. **GNOME 扩展版是唯一正确形态**：Mutter 不提供 `wlr-layer-shell`，Electron 透明窗无法在 Wayland 原生悬浮。本机扩展已在跑且数据链路正常。
3. **Linux Electron 桌面版在本机不可用**，且存在 P0 级硬伤（见 §2）；建议**降级为 experimental 并明确只支持 X11 会话**，不投入适配。
4. 扩展版有 **3 个必须修的技术债**：
   - 只按 `primaryMonitor` 取几何 + **无热插拔监听** → 接/拔外接屏后鲸鱼可能跑出可视区；
   - **触屏无长按菜单入口**，拖动 `moved` 阈值对触摸过于敏感；
   - 三处 `Uint8Array` 隐式 `toString()` → 现能跑，**未来 GJS 版本会静默坏掉**（表现为"已配置却提示未配置"）。
5. 高刷/HiDPI **不是**问题：Clutter stage 坐标是逻辑像素，2.0 缩放无需手工换算；16ms 轮询则把帧率锁在 60fps，120Hz 屏上有优化余量（非缺陷）。

---

## 2. 形态取舍：扩展版 vs Linux Electron 版

| 形态 | 本机（Wayland）可用性 | 结论 |
|---|---|---|
| **GNOME Shell 扩展版** | ✅ 原生悬浮、可置顶、可满屏拖动；已启用运行中 | **主力形态**，投入全部适配资源 |
| Linux Electron 桌面版 | ❌ 见下 3 条硬伤 | **降级 experimental**，README 明示仅 X11；不建议在本机投入 |
| Windows Electron 桌面版 | 不在本机范围 | 保持现状 |
| DSH 网页插件（vendored） | 与桌面环境无关 | 保持；升级到上游 0.3.17 属独立议题 |

**Electron 版不可用的三条硬伤（均已核对官方文档）：**

1. `setIgnoreMouseEvents(true, {forward: true})` 的 `forward` 选项**官方仅支持 macOS/Windows**。Linux 上该参数被忽略 → 窗口一旦穿透就**再也收不到 `mousemove`**，而 `preload.js` 正是靠 `mousemove` 解锁 → **鲸鱼永久穿透、菜单气泡全点不到**。
2. `setAlwaysOnTop` / `setPosition` / `moveTop` / `center` **不支持 Wayland**；本机默认就是 Wayland → 悬浮与定位失效（需 `--ozone-platform=x11` 强制 XWayland 才有机会）。
3. Ubuntu 24.04 的 `kernel.apparmor_restrict_unprivileged_userns=1` + AppImage 无法保留 setuid `chrome-sandbox` → user-namespace 沙箱被拒 → **启动即崩**；另 22.04/24.04 默认**无 `libfuse2`**。

**取舍决定**：本机基线**只交付扩展版**；Electron 版保留代码但标注 experimental，不纳入本次验收。理由：Wayland 是 Ubuntu 24.04 默认会话，Electron 版即便修好穿透也仍需强制 XWayland，收益低于成本。

---

## 3. 适配规划

### 3.1 阶段与优先级

| 阶段 | 改造项 | 目标 |
|---|---|---|
| **P0（必须）** | A1 热插拔几何守卫、A3 触屏输入、A5 GJS 兼容 | 不修则"外接屏/触屏会出现可见故障"或"未来静默失效" |
| **P1（应做）** | A2 多显示器支持、A4 触摸菜单尺寸、A6 锁屏降级、A7 音频回退 | 体验与健壮性 |
| **P2（可选）** | A8 高刷跟随、A9 偏好/路径健壮性、A10 版本号对齐 | 打磨 |

### 3.2 改造项清单

| 编号 | 改造项 | 具体做法 | 依据 |
|---|---|---|---|
| **A1** | 显示器热插拔几何守卫 | 连接 `Main.layoutManager` 的 `monitors-changed` 与 `workareas-changed`；回调里重算工作区并把鲸鱼 `clamp` 回合法范围；`disable()` 中断开 | 代码中**当前完全没有**这两个信号；`_placeInitial` 之后位置再无校验 |
| **A2** | 多显示器支持 | 由"只用 `primaryMonitor.workArea`"改为"按鲸鱼中心点所在显示器的 `workArea` 做 clamp + 吸附"；允许跨屏拖动 | `_workArea()`（第 254 行）只取 `primaryMonitor` |
| **A3** | 触屏输入 | ① 长按 600ms（可选：550–700ms）唤出菜单，替代右键；② `moved` 阈值对触摸单独放宽（如 12 逻辑 px）并增加去抖；③ 增加 `TOUCH_END` / `button-release` 双通道兜底，避免手势抢占后卡在跟随态 | `_onPress`（563 行）只认 `get_button()===1/3`；`_endHold` 阈值固定 5px |
| **A4** | 触摸菜单尺寸 | 菜单项最小高度 ≥ 44 逻辑 px、字号 ≥ 13、`_menuBtn` 增加 padding | 触屏命中精度 |
| **A5** | GJS 兼容（去弃用） | 三处改 `new TextDecoder('utf-8').decode(...)`：`_readKey()`（308 行）、`_loadLedger()`（381 行）、`_fetchBalance` 内 `JSON.parse(bytes.get_data())`（966 行附近） | `journalctl` 三条 `Some code called array.toString() on a Uint8Array instance` 警告 |
| **A6** | 锁屏降级 | `unlock-dialog` 模式下隐藏菜单/气泡/拖动交互，或直接移除 `unlock-dialog` | `metadata.json` 声明 `session-modes: ["user","unlock-dialog"]`，与 `live-lockscreen` 叠加 |
| **A7** | 音频回退 | 启动时探测 `pw-play → paplay → aplay`，缓存结果；缺失时静默降级不抛异常 | 硬编码 `/usr/bin/pw-play`（465 行）；本机 `paplay` 缺失 |
| **A8** | 高刷跟随 | 拖动采样由 16ms `timeout_add` 改为跟随合成帧（`Clutter.Timeline` / frame-clock），或按 `global.display.get_refresh_rate()` 自适应 | 120Hz 屏 + 16ms 轮询 = 60fps 上限 |
| **A9** | 偏好与路径健壮性 | 首次写入生成 `prefs.json`；损坏时回落默认并备份；`gnome-extensions` 走 PATH 探测而非硬编码 `/usr/bin` | `prefs.json` 当前不存在；860 行硬编码 `/usr/bin/gnome-extensions` |
| **A10** | 版本号对齐 | `metadata.json` 的 `version: 1` 与 CHANGELOG 的 v30 口径统一 | 当前不一致 |

> **明确不改（保持兼容）**：`uuid` 仍为 `dsh-whale@local`（避免用户需重装/重新授权）；`~/.cache/dsh-whale/prefs.json`、
> `~/.dsh/.dshw-usage.json`、`~/.dsh/.credentials.yaml` 文件格式不变（向后兼容已有数据）。

---

## 4. 专项：外接显示器

### 4.1 现状

- 本机 `DP-1`~`DP-4` 当前**全部未连接** → **外接屏场景无法在本机实机验证**，必须接入一台外接屏；否则只能降级为"代码审查 + 逻辑单测"。
- 扩展几何**只认主屏**：`_workArea()` 返回 `primaryMonitor.workArea`。

### 4.2 预判风险

| 编号 | 风险 | 触发条件 | 后果 | 解决 |
|---|---|---|---|---|
| R-EXT-1 | 鲸鱼跑出可视区 | 拔掉外接屏 / 改分辨率 / 改缩放 / 切主屏 | 静置位置不校验 → 鲸鱼停在已不存在的工作区坐标 → **看起来"扩展坏了"** | A1 |
| R-EXT-2 | 无法拖到外接屏 | 接入第二屏后往外拖 | 被 `clamp` 硬拽回主屏范围 | A2 |
| R-EXT-3 | 吸附目标错屏 | 鲸鱼在外接屏，吸附却按主屏边角算 | 吸附后位置跳回主屏 | A2 |
| R-EXT-4 | 混合缩放视觉不一致 | eDP 2.0 + 外接 1.0 | 鲸鱼在 1.0 屏物理像素更小 | **预期行为**（逻辑尺寸一致）；文档说明即可，不修 |
| R-EXT-5 | 刷新率切换 | 120Hz ↔ 60Hz（本机 eDP 枚举了大量模式） | 拖动跟手性变化；`workArea` 变化 | A1 + A8 |
| R-EXT-6 | 主屏切换后翻转方向错 | 把主屏设为外接屏 | 镜像翻转按"半屏"判定，跨屏后可能反直觉 | A2 覆盖（按所在屏判定） |

### 4.3 验收要点

- 插拔外接屏 **20 次**后，鲸鱼始终满足：`wa.x ≤ x ≤ wa.x+wa.width-nw` 且 `wa.y ≤ y ≤ wa.y+wa.height-nh`，且**可见**。
- 主屏切换（内建 ⇄ 外接）后 0.5s 内鲸鱼自动回到合法位置。
- 鲸鱼可在外接屏上正常拖动/吸附/翻转/出气泡。

---

## 5. 专项：触屏

### 5.1 现状

- 本机**有触屏**（`ICNT9288`，i2c-hid，多点），位于内建 `eDP-1`（3120×2080，缩放 2.0）。
- 扩展的拖动是 **16ms 定时器轮询 `global.get_pointer()`**（非 motion-event），**这一点对触摸是友好的**：Clutter 会为触摸序列驱动虚拟指针，单指拖动理论上可用。
- 但输入入口只识别 `get_button()`：`1` = 拖动/摸头，`3` = 菜单。**触屏没有右键** → 菜单无入口。

### 5.2 预判风险

| 编号 | 风险 | 说明 | 解决 |
|---|---|---|---|
| R-TOUCH-1 | **无法打开菜单** | 无右键；GNOME 对触摸长按有自身占用 | A3（长按 600ms） |
| R-TOUCH-2 | "摸头"误判为"拖动" | 阈值仅 5px，手指抖动即超人 | A3（触摸阈值放宽 + 去抖） |
| R-TOUCH-3 | 卡在跟随态 | 多指手势（3 指切工作区/概览）抢占序列，`BUTTON_RELEASE` 可能收不到 | A3（`TOUCH_END` 兜底 + 超时保护） |
| R-TOUCH-4 | `track_hover` 无意义 | 触摸无 hover 概念 | 无功能影响，仅语义 |
| R-TOUCH-5 | 双指缩放误触 | 2 指在鲸鱼上可能被 mutter 识别为缩放/滚动 | 观察项：若冲突，则仅在单指序列响应拖动 |
| R-TOUCH-6 | 菜单项命中过小 | 鼠标尺寸按钮在触屏上易误点 | A4 |

### 5.3 验收要点

- 单指按住拖动跟手、松手吸附生效；轻点出气泡；**长按 600ms 出菜单**。
- 连续 30 次触摸拖动/点击无卡死、无残留跟随态。
- 3 指手势（概览/切工作区）在鲸鱼上触发后，鲸鱼状态可自动恢复。

---

## 6. 风险登记册（含扩展冲突面）

### 6.1 代码级风险

| 编号 | 风险 | 严重度 | 现状证据 | 解决方案 |
|---|---|---|---|---|
| R-CODE-1 | `Uint8Array.toString()` 隐式转换 | 🔴 高（未来必坏） | `journalctl` 三条警告，指向 308/381/966 行 | A5 |
| R-CODE-2 | 无热插拔几何守卫 | 🔴 高 | 无 `monitors-changed` 监听 | A1 |
| R-CODE-3 | 单主屏几何 | 🟠 中 | `_workArea()` 用 `primaryMonitor` | A2 |
| R-CODE-4 | 触屏无菜单入口 | 🟠 中 | `_onPress` 仅认 button 1/3 | A3 |
| R-CODE-5 | 硬编码 `/usr/bin/pw-play` | 🟡 低 | 465 行 | A7 |
| R-CODE-6 | `prefs.json` 未走通 | 🟡 低 | 文件不存在 | A9 |
| R-CODE-7 | 锁屏叠加 | 🟡 低 | `session-modes` 含 `unlock-dialog` | A6 |
| R-CODE-8 | 版本号不一致 | 🟡 低 | `metadata.json version:1` vs CHANGELOG v30 | A10 |

### 6.2 扩展冲突面（本机 14 个已启用扩展中需重点观察的 4 个）

| 扩展 | 冲突点 | 预判 | 验证方式 |
|---|---|---|---|
| `ding@rastersoft.com`（桌面图标） | 桌面层点击/右键归属 | 右键鲸鱼时可能同时触发桌面菜单 | 右键鲸鱼观察是否双菜单 |
| `ubuntu-dock@ubuntu.com` | 左缘 intellihide 与热区抢点击 | 鲸鱼贴左缘时点击可能被 dock 吞掉 | 鲸鱼拖到左缘后点击/拖动 |
| `blur-my-shell@aunetx` | 对 `uiGroup` 施加效果/亮度 | 可能影响鲸鱼渲染清晰度 | 开/关对比截图 |
| `hanabi-extension@jeffshee.github.io`（动态壁纸） | 全屏背景层 z-order | 与 `ding` 已知有互动；可能影响鲸鱼层级 | 开/关对比 |
| 其余（`compiz-windows-effect`/`clipboard-indicator`/`Vitals`/`live-lockscreen`/`tiling-assistant`/`apps-menu`/`user-theme`/`extension-list`/`reboottouefi`/`ubuntu-appindicators`） | 低 | 关注 `live-lockscreen` 与锁屏组合 | 逐个 disable 回归 |

> 另注：`hanabi` 自身在本机报 `GstPlay` typelib 缺失、`Vitals` 报 `GTop` 缺失 —— 属它们自身问题，但会让 shell 日志噪声变大，排查我们的错误时应先按 `dsh-whale@local` 过滤。

### 6.3 环境级风险

| 编号 | 风险 | 说明 | 解决 |
|---|---|---|---|
| R-ENV-1 | 重登/重启后扩展不加载 | Wayland 下新增扩展需重新登录才会被扫描 | 文档写明；`install.sh` 末尾提示 |
| R-ENV-2 | 系统升级换 GNOME 版本 | `shell-version` 已声明 45/46/47，但 48 未含 | 升级前先测；`metadata.json` 增补 |
| R-ENV-3 | 纯 PulseAudio 环境无 `pw-play` | 硬编码路径 | A7 |
| R-ENV-4 | 外接屏不可得 | 本机 DP 全空 | 需接入外接屏或声明"未验证" |

---

## 7. 完成判定标准（DoD）

交付前须**全部**满足，否则不视为适配完成。

**功能**
- [ ] D1 鼠标：拖动跟手、松手吸附（四边+四角）、轻点摸头、右键菜单、滚轮缩放，全部正常
- [ ] D2 触屏：单指拖动跟手、轻点出气泡、**长按 600ms 出菜单**，30 次无卡死
- [ ] D3 `prefs.json` 生成，且音色/音量/气泡/自动刷新等设置**重启后仍生效**
- [ ] D4 余额与今日已用正常（本机基线：`lastBalance≈89.55 CNY`、`todayUsage=0`），60s 自动刷新生效

**兼容性**
- [ ] D5 单屏 / 内建+1 外接 / 主屏切换 / 热插拔 20 次 → 鲸鱼**始终可见且位置合法**
- [ ] D6 缩放 1.0 与 2.0 切换后尺寸与清晰度正常（本机 2.0，外接屏可能 1.0）
- [ ] D7 与 14 个已启用扩展共存：右键/点击/拖动不被 `ding`、`ubuntu-dock` 抢占
- [ ] D8 锁屏 → 解锁往返 10 次无 UI 残留、无报错

**稳定性**
- [ ] D9 `journalctl --user -b | grep dsh-whale` **无 ERROR/CRITICAL**，且 `Uint8Array` 弃用警告**清零**
- [ ] D10 扩展 `disable`/`enable` 10 次无 GLib 断言；`Main.uiGroup` 子节点数回归到基线（无残留 actor）
- [ ] D11 连续运行 24h，`Vitals` 观察 gnome-shell CPU 无异常增长、内存无持续上涨（`_autoTimer`/`_breathTimer`/`_followTimer` 无泄漏）

**降级与回滚**
- [ ] D12 移除 `pw-play` 后可优雅降级（不抛异常、无音效但其余功能正常）
- [ ] D13 `gnome-extensions disable dsh-whale@local` 后无残留；重新 enable 后位置与偏好恢复

---

## 8. 交付前测试方案

| 编号 | 测试项 | 命令 / 操作 | 判定 |
|---|---|---|---|
| T0 | 语法与静态检查 | `node --check extension.js`（或 `gjs -c`）；`jq . metadata.json` | 无语法错误、JSON 合法 |
| T1 | 加载与日志 | `gnome-extensions enable dsh-whale@local` → 重新登录 → `journalctl --user -b \| grep dsh-whale` | 无 ERROR/CRITICAL |
| T2 | 纯逻辑单测 | 抽出 `_isPeak`/吸附/clamp 为纯函数，用 `node` 跑断言（边界：贴角、越界、负坐标） | 边界用例全绿 |
| T3 | 鼠标交互矩阵 | 拖动×4 边 4 角、轻点、右键、滚轮、菜单全项 | 与 v30 行为一致 |
| T4 | 触屏交互矩阵 | 单指拖动、轻点、长按 600ms、3 指手势打断 | D2 全通过 |
| T5 | 显示器矩阵 | 单屏 → 接外接屏 → 改主屏 → 改缩放 → 拔屏（各 5 次） | 每次鲸鱼位置合法可见 |
| T6 | 冲突矩阵 | 依次 disable `ding` / `ubuntu-dock` / `blur-my-shell` / `hanabi` 观察行为差异 | 找出并记录抢占者 |
| T7 | 锁屏矩阵 | 锁屏→解锁 ×10（含 `live-lockscreen` 开启态） | 无残留、无报错 |
| T8 | 降级测试 | 临时 `mv /usr/bin/pw-play`（需 root，或用 PATH 注入模拟）后触发音效 | 无异常抛出 |
| T9 | 长稳测试 | 24h 挂机 + `Vitals` 采样（CPU/内存/线程） | 无持续增长 |
| T10 | 回滚验证 | disable → 删目录 → 重装 `install.sh` | 数据（账本/凭据/偏好）不丢 |

**不可在本机完成的项（必须显式声明）**：外接屏相关（T5 需接入显示器）、非 Intel GPU、非 Ubuntu 发行版、GNOME 45/47、纯 X11 会话、纯 PulseAudio 环境。

---

## 9. 与原版本的取舍

### 9.1 保留（不动）

- `uuid` = `dsh-whale@local`、`assets/` 素材、`install.sh` / `desktop-menu.sh` / `.desktop` 入口
- 三项用户数据格式：`~/.dsh/.credentials.yaml`、`~/.dsh/.dshw-usage.json`、`~/.cache/dsh-whale/prefs.json`
- 全部已有交互语义：拖动/吸附/翻转/摸摸头/菜单/音效/6 套音色/峰谷文案/记账与令牌双模式
- Windows 桌面版、DSH 网页插件（本轮不动）

### 9.2 修改

| 项 | 原版 | 适配后 |
|---|---|---|
| 几何 | 仅主屏 | 按鲸鱼所在显示器（A1/A2） |
| 输入 | 仅鼠标（button 1/3） | 鼠标 + 触摸（长按菜单、触摸阈值）（A3/A4） |
| 数据读取 | `Uint8Array.toString()` | `TextDecoder`（A5） |
| 音频 | 硬编码 `/usr/bin/pw-play` | 探测 + 回退（A7） |
| 锁屏 | 全功能 | 降级或移除 `unlock-dialog`（A6） |

### 9.3 降级 / 下线

- **Linux Electron 桌面版** → 标记 `experimental`，README 明示"仅 X11 会话、Linux 上点击穿透不可用"；本机不验收、不投入适配。
- **`DEEPSEEK_PLATFORM_TOKEN` 令牌模式** → 上游 0.3.x 已下线该模式；建议标注 `deprecated` 并在下一轮移除（属独立议题，涉及 CHANGELOG/README 口径同步）。

### 9.4 与上游（vendored 插件）的关系

- 本轮**无需**升级 vendored 插件即可完成 Linux 适配；两者代码无耦合。
- 上游 `0.2.10 → 0.3.17` 的升级（含 v0.3.11/v0.3.15 两个安全修复）建议**单独作为一个变更**推进，见 `CHANGELOG.md` 与根 `README.md`。
- 遗留合规缺口：仓库根**缺 `LICENSE` 文件**（README badge 指向死链），且上游 `assets/` 素材**不在 MIT 覆盖范围**（as-is，不授予再许可）。建议在下一轮补齐 `LICENSE` + 素材来源声明。

---

## 10. 建议执行顺序

1. **A5（GJS 兼容）** —— 改动最小、消除未来静默失效，先落地。
2. **A1（热插拔守卫）+ A2（多显示器）** —— 外接屏专项的前置，一起改。
3. **A3 + A4（触屏）** —— 本机可直接实机验收。
4. **A6 / A7 / A9** —— 健壮性收尾。
5. **A8 / A10** —— 打磨。
6. 走 §7 DoD + §8 测试方案，出验收结论后再同步 GitHub。

> 注：本机当前 **无外接屏接入**，第 2 步改造只能做到"代码审查 + 逻辑单测"级别；要打勾 D5，
> 需接入至少一台外接显示器（DP 或 Type-C Alt-Mode）。
