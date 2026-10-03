# freeze-fix —— 屏幕定格 / GPU 挂死 / GRUB 被 Windows 抢走 的取证与修复

> 针对本机（Ubuntu 24.04 / GNOME 46 Wayland / Intel Meteor Lake i915 / 与 Windows 双系统）
> 2026-10-03 实际发生的故障。所有结论都来自日志取证，不是猜测。

---

## 一条命令跑完全部修复

```bash
sudo bash /home/wukai/dsh-whale/tools/freeze-fix/apply-all.sh
```

> ⚠️ 用**绝对路径**。在 `~` 下直接写 `tools/freeze-fix/...` 会报"没有那个文件或目录"。

先只看不改（**不需要 root**）：

```bash
bash /home/wukai/dsh-whale/tools/freeze-fix/apply-all.sh --check
```

只想跑其中一步：`--only=i915` / `--only=watchdog` / `--only=esp`

---

## 故障现象

屏幕突然定格、**只有鼠标光标还能动**，点什么都没反应 → 只能长按电源键强制关机
→ 下次开机 **Windows 自动修复**接管、重建 ESP 分区并篡改引导项 → GRUB 入口"消失"。

## 根因链（全部有日志证据）

```
① i915/MTL GPU 挂死
   i915: *ERROR* GT0: GUC: TLB invalidation response timed out for seqno N
   i915: GPU HANG: ecode 12:0:00000000
   i915: GT0: Resetting chip for stopped heartbeat on rcs0
   （两天累计 59 次；12:16:16 起每 2 秒一次刷屏）

② GPU reset 之后 mutter 恢复不了
   gsd-power: Error setting 'PowerSaveMode' on org.gnome.Mutter.DisplayConfig: 已到超时限制

③ 合成器不再出帧 → 画面定格，只剩硬件光标能滑（光标是独立 plane，不经合成器）

④ 强制关机 → Windows 自动修复重建 ESP：
   分区 UUID 变成 DAA2-C912，而 /etc/fstab 里还写着旧的 2AC8-E406
   → /boot/efi 挂不上（暂无大碍，但之后 update-grub 会写进空的 /boot/efi，很危险）
   并新增 Boot0002：名字叫 "Windows Boot Manager"、却指向 \EFI\ubuntu\grubx64.efi
```

**诱因（持续压力源）**：`dsh-whale-widget` 的 GPU 进程在 reset 后每 30 秒崩溃重启一次
（`GPU process exited unexpectedly: exit_code=512`），`code.desktop` 同样掉 GPU 进程；
另外 hanabi 动态壁纸扩展的 `gjs` 进程长期占用 **94% CPU**。

## 脚本

| 脚本 | 作用 | 需要 root |
|---|---|---|
| `diagnose.sh` | 取证体检：GPU 挂死统计、mutter 超时证据、负载源、ESP/引导健康度 | 否 |
| `i915-stabilize.sh` | 写入 `i915.enable_psr=0 enable_dc=0 enable_fbc=0 i915.reset=1`；开 SysRq | 是 |
| `gpu-watchdog.sh` | 装 systemd 看门狗：GPU 挂死**且** mutter D-Bus 无响应 → 自动 `systemctl restart gdm` | 是 |
| `fix-esp-grub.sh` | 修 fstab 的 ESP UUID 失配、删被篡改的引导项、重建 ubuntu 项并置顶、启用 os-prober | 是 |
| `apply-all.sh` | 上面三步的顺序编排 + 只读体检入口 | 是 |

### 为什么 `i915.enable_psr=0` 是关键

PSR（Panel Self Refresh）出错时硬件会停止取帧，而合成器以为画面还在正常刷新 ——
症状就是**画面定格但光标能动**。DC states / FBC 是同类问题的次要来源，一起关掉。
代价是待机功耗略增，换来稳定，对台式/插电使用完全值得。

### 为什么需要看门狗

原来的处理方式是长按电源键 —— 而**强制关机正是 Windows 自动修复抢走引导的起因**。
看门狗把"发现冻结 → 救回会话"自动化，从根上打断这个循环：

- 判定用**双条件**（内核出现 GPU 挂死标志 + 之后 20 秒内 mutter 对 D-Bus 无响应），避免误杀
- 默认动作是 `systemctl restart gdm`（只结束图形会话，你重新登录即可）
- 若 60 秒后仍不健康，兜底 `systemctl reboot -f`（仍比硬断电干净）
- 配置在 `/etc/default/gpu-watchdog`：`ACTION=gdm|log|reboot`、`ESCALATE`、`GRACE`、`PROBE_TIMEOUT`

```bash
sudo bash gpu-watchdog.sh --status      # 状态 + 历史触发记录
sudo bash gpu-watchdog.sh --test        # 干跑一次判定（不执行恢复动作）
sudo bash gpu-watchdog.sh --uninstall
journalctl -u gpu-watchdog -f           # 实时日志
```

### 紧急自救（以后不必再强制关机）

1. `Ctrl+Alt+F3` 切到文字终端登录 → `sudo systemctl restart gdm`
2. 或 `Alt+SysRq+S`（落盘）→ `Alt+SysRq+U`（只读重挂）→ `Alt+SysRq+B`（重启）
   —— 需 `kernel.sysrq=1`，`i915-stabilize.sh` 会帮你打开

## Windows 侧必须做的两件事

否则异常关机后**仍会**触发 Windows 自动修复来抢引导：

1. 控制面板 → 电源选项 → 选择电源按钮功能 → 更改当前不可用的设置 → **取消「启用快速启动」**
   （管理员 PowerShell 里 `powercfg /h off` 更彻底，还能避免 NTFS 脏挂载）
2. 系统属性 → 高级 → 启动和故障恢复 → 设置 → **取消「自动重新启动」**

并建议在 BIOS 里把 `ubuntu` 调到 `Windows Boot Manager` 之前。

## 额外发现（未擅自改动）

hanabi 动态壁纸扩展的 renderer（`gjs`）持续占 **94% CPU**，是持续负载源之一。
它不归本修复管，但建议关掉或改成失焦暂停，能明显降低 GPU/CPU 压力。

## 踩过的坑（写给以后的自己）

- `lsblk` 不加 `--list` 会输出 `├─/dev/nvme0n1p1` 这种带树形前缀的假路径；
  拿它再查 UUID 会得到**空字符串**，进而把空 UUID 写进 `fstab`。已加空值安全闸。
- `git -C <dir> diff --output=<相对路径>` 会把相对路径解析到 `<dir>` 下，
  写不进去还静默失败。要么用绝对路径，要么先 `cd`。
- GNOME 的 `org.gnome.Shell.Screenshot` D-Bus 接口在本机会 `AccessDenied`；
  透明窗口用 `Page.captureScreenshot` 只能拿到全透明帧 —— 抓屏一律走 `xwd` + `ffmpeg`。
