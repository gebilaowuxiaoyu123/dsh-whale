# 双系统引导安全 —— 取证、结论、保障（Windows + Ubuntu）

> 事故：2026-10-03 Ubuntu 会话里桌面渲染崩溃（画面定格、只有光标能动）→ 别无他法只能长按电源键
> → 下次开机 Windows 自动修复接管、重建 ESP、抢走 GRUB 入口。
> 本文只记**有证据的**结论。Ubuntu 侧的根因与修复见 [`tools/freeze-fix/`](../tools/freeze-fix/README.md)。
>
> 2026-10-04 在 Windows 侧复查 + 补保障：`tools/boot-safety/`。

---

## 1. 结论先说

**「要不要拉远程仓库里那个 GPU 优化？」—— 要，而且要原样拉。**

那个优化**本来就是照这台机器做的**（Intel Meteor Lake 的 i915 实测取证：GPU HANG、
TLB invalidation 超时、PSR/DC/FBC 关掉的取舍、看门狗的双条件判定），不是通用模板。
所以不存在「为这台机器再单独优化一套」的问题 —— 缺的只是「把它应用上去」+ 两个本机特有的开关：

| 缺口 | 在哪一侧 | 状态 |
|---|---|---|
| i915 稳定化 + GPU 看门狗 + 修 fstab/引导 | Ubuntu | **待做**（`git pull` 后跑 `apply-all.sh`） |
| `/etc/fstab` 里 `/boot/efi` 的 UUID 要 == 当前 ESP 的 UUID（`DAA2-C912`） | Ubuntu | **待做** |
| 关快速启动 | Windows | ✅ 已完成（本来就已经是关的） |
| 关「崩溃后自动重启」 | Windows | ✅ 2026-10-04 已关 |
| 复原被篡改的 `{bootmgr}.path` | Windows | ✅ 2026-10-04 已复原 |
| `ubuntu` 顶回 UEFI 第一启动项 | Windows/UEFI | ✅ 复查时已是第一 |

另外：仓库里的 `tools/setup-nvidia.sh`（NVIDIA 预制件）**与本机无关** —— 本机是 Intel Arc 核显
（`Intel(R) Arc(TM) Graphics`，Meteor Lake），没有 N 卡。在没 N 卡的机器上跑它只报告、不写文件。

---

## 2. 取证（本机实测，2026-10-04 01:30 左右）

### 2.1 事件时间线（Windows 事件日志）

| 时间 | 事件 | 说明 |
|---|---|---|
| 10-03 11:31:29 | 引导（Kernel-General 12） | Windows 开机 |
| 10-03 12:37 | 1074 + 6006 | 正常关机（用户主动） |
| 10-03 14:24 | 1074 | 用户主动发起关机 |
| 10-03 14:25:56 | Kernel-General 13 | Windows 正常关闭 ← **最后一次 Windows 干净关机** |
| （14:26 – 16:37） | —— | **Ubuntu 会话 = 崩溃窗口**（约 2 小时 11 分） |
| 10-03 16:37:27 | 引导（Kernel-General 12） | 再次进入 Windows（这一次只看到 Windows） |

### 2.2 为什么 Windows 日志「看起来没问题」

```
开机 25 次 / 干净关机 24 次 / 异常掉电标记 0 个      ← 最近 7 天
Kernel-Boot 20：每一次都写着「上一次关机的成功状态为 true。上一次引导的成功状态为 true。」
```

这不是矛盾：**崩的是 Ubuntu 会话，Windows 自己确实关机干净**，所以不会有 `6008`/`41`。
`SrtTrail.txt` 也不在装好的系统里（那份「启动修复」日志在被 RAM 盘承载的 WinRE 里，重启即丢）。
**这正是这台机器最容易误判的地方** —— 只看 Windows 日志会得出「一切正常」的错误结论。

### 2.3 真正的证据：ESP 与引导项

| 证据 | 实测值 | 含义 |
|---|---|---|
| ESP 卷序列号（= Linux 眼里 `/boot/efi` 的 UUID） | **`DAA2-C912`** | 和事故前记录值（`2AC8-E406`）不一致 → ESP **被重建过**（自动修复的签名） |
| ESP 上的 `\EFI\ubuntu\{shimx64,grubx64,mmx64}.efi` + `grub.cfg` | 都在，时间戳 `2026-10-03 05:55` | GRUB **没有被清掉**（事后被重装/修复过） |
| `\EFI\BOOT\BOOTX64.EFI` 的 SHA256 前 16 位 | `6FE6E1BCBE6CF6BA` == `\EFI\ubuntu\shimx64.efi` | 回退引导**还是 ubuntu 的 shim**，没被 Windows 的 `bootmgfw.efi` 覆盖 |
| `\EFI\Microsoft\Boot\bootmgfw.efi` | `2025-02-20`，未被改动 | Windows 自己的加载器完好 |
| BCD `{bootmgr}.path` | 曾被改成 **`\EFI\ubuntu\grubx64.efi`** | 名字叫「Windows Boot Manager」却去加载 GRUB —— 典型的引导修复工具/自动修复留下的篡改 |
| UEFI 启动顺序 | `ubuntu` 第一，`Windows Boot Manager` 第三 | 复查时已是正确顺序（事故当时被挤到后面） |
| `HiberbootEnabled` | `0` | 快速启动已关 |
| `AutoReboot` | 曾是 `1` | 蓝屏会自动重启 → 已改为 `0` |

### 2.4 硬件（顺带确认「优化适配性」）

| 项 | 值 |
|---|---|
| 机型 | HUAWEI VGHH-XX（笔记本） |
| CPU/GPU | Intel Meteor Lake，`Intel(R) Arc(TM) Graphics`（**核显，无 NVIDIA**） |
| 内存 / 硬盘 | 31.5 GB / WD PC SN740 1 TB NVMe（`Healthy`） |
| 固件 | UEFI，安全启动**关闭**；WinRE 已启用 |
| 双系统分区 | ESP 196 MB + C: 294 GB + E: 419 GB + D: 114 GB + WINPE 1 GB + Onekey 20 GB + WinRE 1 GB + **Linux 103.86 GB**（未挂载 = ext4） |

→ 与 `tools/freeze-fix/` 文档里写的实测环境（Ubuntu 24.04 / GNOME 46 / Wayland / scale 2.0 /
Intel Meteor Lake i915）**完全一致**：这就是同一台机器。所以 Ubuntu 侧那份修复是**对症的**。

---

## 3. 保障措施

### 3.1 已经在 Windows 侧落地（2026-10-04）

用 `tools/boot-safety/fix-windows-boot-safety.ps1` 一键完成，并已复核：

```
[ok] 导出 BCD 备份      → C:\Users\HUAWEI\dsh-whale-backups\BCD-20261004-013346.bin
[ok] 关闭崩溃后自动重启  （AutoReboot: 1 → 0）
[ok] 复原 {bootmgr}.path （\EFI\ubuntu\grubx64.efi → \EFI\Microsoft\Boot\bootmgfw.efi）
[ok] UEFI 第一启动项 = ubuntu（本来就是）
```

复核（`check-boot-health.ps1`）：**没发现可疑项，退出码 0**。

### 3.2 还要在 Ubuntu 侧做（否则下次 GPU 挂死还会重演）

```bash
cd ~/dsh-whale
git pull
sudo bash tools/freeze-fix/apply-all.sh        # i915 稳定化 + GPU 看门狗 + 修 fstab/引导
bash tools/freeze-fix/apply-all.sh --check     # 只体检，不改（不需要 root）
```

> ⚠️ **第一优先是 fstab 的 ESP UUID**：当前 ESP 是 `DAA2-C912`，而 `/etc/fstab` 里很可能还写着
> 旧的 `2AC8-E406`。那样 `/boot/efi` 挂不上（开机看似无碍），但**下次 `update-grub` 会往一个空目录里写**，
> 引导文件就真的没了。`fix-esp-grub.sh` 会处理，但请确认它跑过。

> 关于「要不要为这台机器单独优化」：**不需要另做一套**，但这两条是本机特有的、必须手工确认的
> （fstab 的 UUID 是**这次事故之后**才变的；Windows 侧的自动修复开关是这台机器的策略）。

### 3.3 紧急自救（以后不必再长按电源键）

1. `Ctrl+Alt+F3` 切文字终端登录 → `sudo systemctl restart gdm`
2. `Alt+SysRq+S`（落盘）→ `Alt+SysRq+U`（只读重挂）→ `Alt+SysRq+B`（重启）
   —— 需要 `kernel.sysrq=1`，`i915-stabilize.sh` 会打开
3. 实在要硬关机，也请优先走「重启」而不是「长按电源」：
   长按电源 = 脏关机 = 触发 Windows 自动修复 = 抢 GRUB，这就是这条故障链的闭环。

---

## 4. 命令速查

```powershell
# Windows：只读体检
powershell -NoProfile -ExecutionPolicy Bypass -File tools\boot-safety\check-boot-health.ps1 `
  -Days 7 -ExpectedEspSerial DAA2-C912

# Windows：修复（管理员；先备份 BCD）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\boot-safety\fix-windows-boot-safety.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools\boot-safety\fix-windows-boot-safety.ps1 -Check

# Windows：回滚 BCD
bcdedit /import "C:\Users\<你>\dsh-whale-backups\BCD-<时间戳>.bin"
```

```bash
# Ubuntu：只体检 / 全量修复
bash tools/freeze-fix/apply-all.sh --check
sudo bash tools/freeze-fix/apply-all.sh

# Ubuntu：单步
sudo bash tools/freeze-fix/apply-all.sh --only=i915
sudo bash tools/freeze-fix/apply-all.sh --only=watchdog
sudo bash tools/freeze-fix/apply-all.sh --only=esp
```

---

## 5. 复盘：这次为什么会「只能进 Windows」

```
① Ubuntu 会话里 i915 GPU 挂死
   （硬件 PSR/DC 状态机出错 → 停止取帧；合成器以为还在正常刷新）
        ↓
② 画面定格，但硬件光标能动（光标走独立 plane，不经合成器）
   → 鼠标还能滑、键盘还在，但点什么都没反应，看起来「死机」
        ↓
③ 除了长按电源键没有别的办法 → 脏关机
        ↓
④ 脏关机 + 开机时引导失败计数 → bootmgr 判定「上次启动不正常」
   → 进 WinRE 的「启动修复」
        ↓
⑤ 启动修复重建 ESP（UUID 从 2AC8-E406 变 DAA2-C912）
   → GRUB 入口消失 / 被挤到后面；并且留下「bootmgr 指向 grubx64.efi」这种错乱
        ↓
⑥ 只能进 Windows。而且 Windows 事件日志里一切正常（因为崩的不是它）
```

**三个断点，各自都有对策**：

| 断点 | 对策 | 位置 |
|---|---|---|
| ① i915 挂死 | `i915.enable_psr=0 enable_dc=0 enable_fbc=0` | `tools/freeze-fix/i915-stabilize.sh` |
| ② 冻结后没法恢复 | systemd 看门狗：GPU 挂死 **且** mutter 无响应 → `systemctl restart gdm` | `tools/freeze-fix/gpu-watchdog.sh` |
| ③④⑤ 脏关机 → 自动修复抢引导 | 关快速启动/自动重启 + 复原 bootmgr + ubuntu 置顶 + fstab UUID | `tools/boot-safety/` + `tools/freeze-fix/fix-esp-grub.sh` |

---

## 6. 待办清单

- [x] Windows：BCD 备份 / 关自动重启 / 复原 bootmgr 路径 —— 2026-10-04
- [x] Windows：只读体检脚本 + 修复脚本（`tools/boot-safety/`）—— 2026-10-04
- [ ] Ubuntu：`git pull` + `sudo bash tools/freeze-fix/apply-all.sh`
- [ ] Ubuntu：确认 `/etc/fstab` 的 `/boot/efi` UUID == `DAA2-C912`
- [ ] Ubuntu：确认 `gpu-watchdog` 已 enabled 且 `journalctl -u gpu-watchdog` 无异常
- [ ] 可选：BIOS 里再确认一次启动顺序（把 `ubuntu` 放在 `Windows Boot Manager` 之前）
