# Coopanion（鲸鱼娘桌宠）Linux 完善与 NVIDIA 预制配置

> 上游：`Pal-AI-Lab/Coopanion`（AGPL-3.0-or-later）
> 本仓库**不 vendor** 上游源码；`third-party/Coopanion/` 是 gitignore 的本地工作副本，
> 所有改动以补丁形式固化在 `patches/coopanion/0001-dsh-pet-features.patch`。
> 本机实测环境：Ubuntu 24.04.4 / GNOME 46 / Wayland(有 XWayland) / scaleFactor 2.0 / Intel Meteor Lake（**无 NVIDIA**）。

---

## 1. 为什么上游的「Linux 版开发不完全」

不是功能没写，是**桌宠窗口压根没被创建出来**，连带后面所有交互全部失效。定位到 4 个根因：

| # | 根因 | 现象 | 修复 |
|---|------|------|------|
| 1 | 桌宠窗口由**子 Electron 进程**（`--pet-host`）创建，而 `app.commandLine.appendSwitch()` **不继承给子进程** | 子进程退回**原生 Wayland**；Wayland 下窗口不能自己摆位置、不能常驻置顶 → 窗口压根不出现（`xwininfo` 找不到任何 X11 窗口，只有一个 `--pet-host` 进程挂着） | `app/main.cjs` 里补 `process.env.ELECTRON_OZONE_PLATFORM_HINT='x11'`（环境变量可被继承）**并**给子进程显式补 `--ozone-platform=x11` 命令行参数（双保险） |
| 2 | Linux 上 `setIgnoreMouseEvents(true,{forward:true})` 是**空操作**（实测日志：`No window shape defined`） | 全屏透明窗**吞掉整个桌面**的点击，什么都点不到 | 改用 `win.setShape(rects)`（X11 ShapeBounding）。**注意它同时裁剪绘制与输入** → 形状必须是可见像素的**超集** |
| 3 | 形状上报时把全屏 `<svg>` 容器也算进去 | 形状=整个窗口 → 等于没裁剪，点击穿透失效 | `host/preload.cjs` 的 `paints()` 只白名单**叶子几何标签**（`IMG/CANVAS/VIDEO/PATH/ELLIPSE/CIRCLE/RECT/POLYGON/POLYLINE/LINE/USE/TEXT`），**故意不含** `svg`/`g` 这类全屏容器 |
| 4 | `setShape` 放大后，新纳入的区域**从未被绘制过** | 出现**白色方块**残影 | `setShape` 后必须 `win.webContents.invalidate()` |

额外：`capturePage()` 在本机对透明窗口恒返回全透明帧 → 验收改用 **X11 抓屏**（`xwd` + `ffmpeg` rawvideo rgb24）在 Node 里算「墨迹包围盒」，既能判定渲染，也能校验「形状 ⊇ 墨迹」。

另外把窗口类型改成 `_NET_WM_WINDOW_TYPE_DOCK`（`xprop`），否则 GNOME 的 dash-to-dock
（intellihide-mode=ALL_WINDOWS）会把常驻置顶的全屏窗当成「抢屏幕的窗口」而自动隐藏 dock。

> ⚠️ **这两个目标是互相拉扯的（2026-10-04 补充）**：默认不再置顶（「置顶显示」关）时窗口类型用
> `_NET_WM_WINDOW_TYPE_NORMAL`（普通窗，应用窗口能盖住桌宠），代价是本机 autohide 的 dock 可能被这个
> 铺满工作区的窗口顶掉；把控制台「习惯」页的「置顶显示」勾上就回到 `DOCK` + `ABOVE`（旧行为，dock 不受影响）。
> 开着或关着都不影响 `setShape` 的点击穿透 —— 那是另一回事。

---

## 2. 功能对照表（Windows 版 → Linux 实机验证）

| 能力 | Windows | Linux（本次） | 验证方式 |
|------|---------|---------------|----------|
| 桌宠窗口出现并可自定位 | ✅ | ✅ | `xwininfo` 找到 `Cortico 桌宠` |
| 常驻置顶 + 不抢任务栏 | ✅ | ✅ | `xprop`：`_NET_WM_WINDOW_TYPE_DOCK`、`ABOVE,SKIP_TASKBAR` || 置顶层级跟随「置顶显示」开关 | ✅（托盘勾选） | ✅（控制台「习惯」页） | `xprop`：开 → `DOCK`+`ABOVE`；关 → `NORMAL`（无 `ABOVE`） || 点击穿透（只鲸鱼可点） | ✅ | ✅ | 形状面积 < 窗口 25%，且形状 ⊇ 墨迹包围盒 |
| Live2D 鲸鱼娘形象渲染 | ✅ | ✅ | X11 抓屏墨迹包围盒非空 + 截图人工审阅 |
| 引导气泡可点 | ✅ | ✅ | 真实 CDP 点击 |
| 右键菜单（≥9 项） | ✅ | ✅ | 真实 `Input.dispatchMouseEvent` 右键，DOM 读项 |
| 菜单项「行为模式」真实生效 | ✅ | ✅ | 点击后标签变化：`中 · 多待着` → … |
| 走动模式：关/安静/自由/**随刷新率** | ✅ | ✅ | 配置 schema + 控制台「习惯」页 |
| 打字对话（双击唤出） | ✅ | ✅ | 页面存在输入通道 |
| 语音输入（FunASR 本地识别） | ✅ | ⚠️ 见下 | `systemRecognizerSupported` 平台判定 |
| 电脑操作 CUA | ✅ | ✅ `engine/linux.ts`（XGetImage/XTest） | 模块存在且随包构建 |
| 装扮页（换配色/帽子） | ✅ | ✅ | `petHost.openDress()` → 「桌宠装扮」窗口出现 |
| 夜间模式 / 音效开关 | ✅ | ✅ | 菜单项可切换 |
| 开机自启（`--background`） | ✅ | ✅ | 自启开关 + `CORTICO_START_BACKGROUND` |
| 托盘图标 | ✅ | ✅ | `busctl` 查到 `StatusNotifierItem-<pid>` |
| 匿名统计 / 更新提醒 | ✅ | ✅ | 上游逻辑，未改 |

> **语音输入说明**：上游把系统级识别器限制为 `process.platform === 'win32'`
> （Windows SAPI）。Linux 上保留 FunASR 本地识别通路，但**未接系统级识别器**——
> 这属于上游的功能边界，不是本次引入的缺陷；如需要可后续接 `pocketsphinx`/`whisper.cpp`。

---

## 3. 怎么跑 / 怎么自测

```bash
# 安装（装依赖、下 Electron、打补丁、构建）
bash tools/setup-coopanion.sh

# 启动（带调试端口，桌宠页 CDP 在 9333）
cd third-party/Coopanion
COOPANION_DEBUG_PORT=9333 nohup ./node_modules/electron/dist/electron . > /tmp/coopN.log 2>&1 &

# 端到端自检（26 项，含逐按钮真实点击 + 截屏存档）
cd ~/dsh-whale && CDP_PORT=9333 node tools/coopanion-linux-test.mjs
# 截图落在 /tmp/coopanion-artifacts/

# 补丁一致性 + 功能清单自检（15 项）
node tools/coopanion-feature-test.mjs
```

改动上游代码后**必须**重新生成补丁，否则工作副本会悄悄漂移：

```bash
git -C third-party/Coopanion diff --no-color \
  --output=/home/wukai/dsh-whale/patches/coopanion/0001-dsh-pet-features.patch
```
> ⚠️ 注意 `--output=` 要用**绝对路径**：`git -C` 会把相对路径解析到 Coopanion 仓库根，
> 结果写不进去还静默失败。

排查用 CDP 通用工具：`CDP_PORT=9333 node tools/cdp-eval.mjs '<js 表达式>'`。

---

## 4. Linux NVIDIA 显卡对接（预制件）

本机是 Intel 核显（i915），**没有 N 卡**，所以这部分是**预制配置**：在没有 N 卡的机器上
运行 = 只报告、**不写任何文件**；拷到 N 卡机器上运行 = 自动配好两套桌宠的独显渲染。

```bash
bash tools/setup-nvidia.sh            # 检测 + 写入（幂等）
bash tools/setup-nvidia.sh --check    # 只检测
bash tools/setup-nvidia.sh --revert   # 清理
bash ~/.config/dsh-whale/nvidia-selftest.sh   # N 卡机器上的通路自检
```

写入 `~/.config/dsh-whale/nvidia.env`：

```sh
export __NV_PRIME_RENDER_OFFLOAD=1     # 混合显卡：渲染卸载到独显
export __GLX_VENDOR_LIBRARY_NAME=nvidia
export __VK_LAYER_NV_optimus=NVIDIA_only   # 仅 Vulkan 生效
export LIBVA_DRIVER_NAME=nvidia            # VAAPI 硬解
export ELECTRON_OZONE_PLATFORM_HINT=x11    # 关键！见下
export DSH_GPU_FLAGS="--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy"
export COOPANION_GPU_FLAGS="$DSH_GPU_FLAGS --enable-features=VaapiVideoDecoder,VaapiVideoEncoder"
```

**为什么 N 卡机器上也必须钉死 XWayland**：桌宠的点击穿透完全依赖 `win.setShape()`，
而它只有 **X11 ShapeBounding** 实现。跑原生 Wayland 时形状会被忽略 → 全屏透明窗吞掉
整个桌面的点击。所以不要为了「原生 Wayland」而放弃 `--ozone-platform=x11`。

**两套桌宠怎么读到这些参数**：

- **Coopanion**：`app/main.cjs` 读取 `COOPANION_GPU_FLAGS`，逐项 `appendSwitch`，
  并**同样传给 `--pet-host` 子进程**（子进程不继承 `appendSwitch`，这正是根因 1）。
  变量为空时 `[...[]]` 展开为空 → 纯核显机器行为**逐字节不变**。
- **DSH 桌宠桌面端**：`main.js` 在「重启以强制 XWayland」的参数里追加 `DSH_GPU_FLAGS`。
  同样在无该变量时完全不追加。
- **自启项**：`tools/setup-nvidia.sh` 会把 `~/.config/autostart/*.desktop` 的
  `Exec=` 改写为 `sh -lc '. ~/.config/dsh-whale/nvidia.env; exec …'`，并有 `--revert`。

依赖建议（N 卡机器）：

```bash
sudo apt install nvidia-driver-550 nvidia-utils-550 libnvidia-egl-wayland1
sudo apt install nvidia-vaapi-driver libva2 vainfo   # 可选：视频硬解
sudo apt install vulkan-tools mesa-utils             # vulkaninfo / glxinfo
```

**未验证声明**：以上 NVIDIA 通路因本机无对应硬件，**只做了逻辑与脚本级验证**
（无卡时零副作用、语法与幂等性、参数拼装正确），**没有真机跑通**。交付到 N 卡机器后
请先跑 `nvidia-selftest.sh`。

---

## 5. 已知限制

- `capturePage()` 对透明窗口在本机返回全透明 → 验收依赖 X11 抓屏。
- `setShape` 矩形上限做了裁剪（最多 240 条，去重取面积优先）→ 极端复杂的页面可能欠覆盖；
  已用「形状 ⊇ 墨迹包围盒」做兜底断言。
- 子进程若被外部直接 spawn（不经 `app/main.cjs`），仍需手动带 `--ozone-platform=x11`。
