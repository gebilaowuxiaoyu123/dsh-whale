# 📋 版本更新日志（CHANGELOG）

> 记录 DSH 小鲸鱼所有形态的版本演进。格式参照 [Keep a Changelog](https://keepachangelog.com/)。
>
> - **GNOME Shell 扩展版**（`dsh-whale-shell-extension/`，Wayland 桌面首选，当前主力迭代）：v9 → v12 → … → v31
>   （v10/v11 为引入初期的一次性内部迭代，未单独建档，已合并体现在 v12 定型）
> - **桌面版 / DSH 网页插件**（Windows、Ubuntu Linux、dsh-web）：v1.0 + 上游插件跟进至 **v0.3.17**

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
