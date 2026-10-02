# 功能对照与路线图（本仓库各形态 vs 官方 Windows 独立版）

> 对比对象：上游 `MeteorNOX/DeepSeek-Balance-Whale-Widget` 的 `For–WinDesktop` 分支 =
> `ds-desktop-whale` **v2.0.0**（Tauri v2 + Rust 2.8 万行 + 原生前端 1.75 万行，**仅 Windows**）。
>
> 重要前提：本仓库的 `dsh-whale-desktop/`（Windows）与 `dsh-whale-desktop-linux/`（Linux）
> **是同一套代码**（差异只有开机自启分支与构建目标）。因此不存在「本仓库 Windows 版更强」的问题；
> 真正的差距来自「我们复用 DSH 插件本体」vs「官方那条线是独立重写」。

---

## 一、已对齐 / 已在本仓库可用

| 能力 | 官方 Windows 独立版 | 本仓库桌面版（Win/Linux 同一套） |
|---|---|---|
| 桌面挂件本体（透明/置顶/穿透/拖动/吸附） | ✅ | ✅（Linux 用 `setShape`，见下） |
| 余额实时 + 数字滚动 | ✅ | ✅（插件本体） |
| 今日已用记账 + 归档 | ✅ | ✅ **+ 余额校正 + 按密钥分本**（更强） |
| 峰谷标签 + 倒计时 | ✅ | ✅ 插件本体；**+ 提前预警**（v1.2 增强层） |
| 模块化气泡 / 逐模块样式 | ✅ 6 类模块 | ✅ **更细**（另含对话名、跑马灯、拖拽排版、模块库、A/B 加权） |
| 台词 / 音效 / 自定义角色 | ✅ | ✅ 插件本体 |
| 多厂商余额 / 额度 | ✅ 供应商卡片 + 写入客户端配置 | ✅ **34 个厂商模板 + 订阅窗口**（另一套能力，由插件提供） |
| 开机自启 / 单实例 | ✅ | ✅（v1.1 修好 AppImage 路径 + 加单实例锁） |
| 系统托盘显隐/退出 | ✅ | ✅（需 GNOME AppIndicator 扩展；本机已启用） |
| DSH 生态集成（每轮消耗/提问授权提示/对话名/账号登录态读余额） | ❌ 没有 | ✅ **插件独有** |
| Codex 本地会话统计 | ❌ 没有 | ✅ **插件独有** |
| 唯二能在 Linux Wayland 原生悬浮的形态 | ❌ 仅 Windows | ✅ GNOME 扩展版 |

## 二、仍缺（对齐官方 Windows 版）

| # | 能力 | 难度 | 依赖 | 状态 |
|---|---|---|---|---|
| 1 | 峰谷提前预警 | 低 | 无（纯逻辑 + 自绘提示） | ✅ **已完成**（v1.2） |
| 2 | 多币种汇率（CNY/USD/EUR/JPY/GBP/HKD + 换算缓存） | 中 | 需汇率接口 | ⬜ 待做 |
| 3 | 多套气泡组（新建/切换/删除） | 中高 | 插件前端已有单气泡编辑，需扩成「组」 | ⬜ 待做 |
| 4 | 台词轮播 / 间隔与波动配置 | 中 | 插件已有随机语句模块，需加轮播模式 | ⬜ 待做 |
| 5 | 账单图表（时/天/月聚合） | 中 | 插件已有用量记录列表，缺图表渲染 | ⬜ 待做 |
| 6 | 三态主题（浅色/深色/毛玻璃）+ 全局配色 | 低中 | 仅作用于配置界面 | ⬜ 待做 |
| 7 | 智能抠图（BiRefNet + onnxruntime，离线） | 高 | Electron 侧等价物重、包体大 | ⛔ 暂不建议 |
| 8 | 多状态形象 + 心情状态机（生气/失落/害羞/疲惫…） | 高 | 需成套美术素材 | ⛔ 暂不建议 |

## 三、实施方式（关键约定）

`dsh-whale-widget/` 是上游插件的**原样 vendored 副本**（便于 diff 与追溯）。因此：

- **桌面版特有功能一律走增强层**：`dsh-whale-desktop-linux/assets/desktop-enhance.js`
  （由主进程在插件脚本之后注入；Windows 版同路径）。上游升级插件时不会冲突。
- 若要改的确实是**插件共有**的能力（例如气泡组、台词轮播、账单图表、多币种），
  优先三条路：
  1. **向上游提 PR**（推荐，桌面版与网页版同时受益）
  2. 在增强层里做**叠加式**实现（接口层能拿到数据时可行）
  3. 确实必须改插件源码时，把差异固化为 patch 并记录，**不要**让 vendored 副本静默漂移

## 四、Linux 平台关键约束（实测结论，改动前必读）

| 约束 | 说明 |
|---|---|
| `--ozone-platform=x11` | 必须是**命令行参数**；在 main.js 里 `appendSwitch` 太晚。否则跑原生 Wayland：无 X11 窗口、`getCursorScreenPoint()` 恒为 `(0,0)`、`setAlwaysOnTop` 无效 |
| `setIgnoreMouseEvents(…,{forward:true})` | 在 Linux 是**空操作**：窗口仍收全部鼠标事件，且透明区点击**不穿透** → 全屏透明窗会挡住整个桌面。**禁用** |
| `win.setShape(rects)` | ✅ Linux 正确做法。注意它走 X11 **ShapeBounding**，会**同时裁剪绘制** → 形状必须覆盖所有可见像素 |
| 形状跟随 | 鲸鱼移动中要用大 padding（当前 56px）防裁切；静止后收紧（12px）提精度 |
| 沙箱 | Ubuntu 24.04：AppImage 无 setuid `chrome-sandbox` + userns 受限 → 必须 `--no-sandbox`；deb 有 setuid 则保留沙箱 |
| 缩放 | 窗口 `getBounds()` 是逻辑坐标，设备像素 = 逻辑 × scaleFactor（本机 2.0） |

## 五、验收口径

- **不裁切**：`DSHW_DEBUG=1` 时自检会输出「不透明像素覆盖率」，必须 **100%**
- **穿透**：`ShapeBounding` 面积应远小于整窗；用背景窗点击测试确认区域外点击可达
- **回归**：`node tools/ci-audit.mjs --no-pack`（插件 5/5）、`tools/ledger-compat-test.mjs`（25/25）、
  `tools/desktop-plugin-integration-test.mjs`（23/23）
- ⚠️ 现有 `desktop-ui-smoke-test.mjs` / `desktop-button-audit.mjs` 走 **CDP 注入**，
  绕过合成器输入区域，**测不到**穿透问题 —— 必须用真实鼠标或上表的形状检查补齐
