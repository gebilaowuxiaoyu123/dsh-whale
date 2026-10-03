# boot-safety —— Windows 侧的双系统引导体检与保障

> 针对本机（HUAWEI VGHH-XX / Intel Meteor Lake / Windows 11 + Ubuntu 24.04 双系统）
> 2026-10-03 实际发生的「Ubuntu 侧 GPU 挂死 → 强制关机 → Windows 自动修复抢走 GRUB」。
> Windows 侧的开关全部**脚本化**在这里，不用再靠翻控制面板。

## 什么时候跑

| 场景 | 用哪个 |
|---|---|
| Ubuntu 崩溃 / 强制关机之后，怀疑引导被改 | `check-boot-health.ps1`（只读） |
| 刚装完 / 更新完 Windows，或换完 BIOS 设置 | `check-boot-health.ps1` |
| 体检报出问题，要动手修 | `fix-windows-boot-safety.ps1`（管理员） |
| 想先看修复脚本会做什么 | `fix-windows-boot-safety.ps1 -Check` |

```powershell
# 只读体检（查 ESP/BCD 需要管理员，否则那几项显示「未知」）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\boot-safety\check-boot-health.ps1 `
  -Days 7 -ExpectedEspSerial DAA2-C912

# 修复（管理员；会先导出 BCD 备份到 %USERPROFILE%\dsh-whale-backups）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\boot-safety\fix-windows-boot-safety.ps1
```

`check` 退出码：`0` = 没发现可疑项；`1` = 有可疑项。
`fix` 退出码：`0` = 已就绪；`1` = `-Check` 下仍有待处理项；`2` = 缺管理员；`3` = 有步骤失败。

## 为什么不能在 Windows 事件日志里找

如果崩的是 **Ubuntu 会话**，Windows 上一次关机依然是「干净」的（`6006`），
所以既不会有 `6008`（意外关机）也不会有 `41`（内核掉电）——
**Windows 日志在这里必然是全绿的**，真正的证据在 ESP 和 BCD 里。本机实测就是如此：

```
开机 25 次 / 干净关机 24 次 / 异常掉电标记 0 个
```

## 检查项

| # | 检查 | 为什么 |
|---|---|---|
| 0 | 机型 / 系统 / 安全启动 / 是否存在 FAT32 ESP | 先确定是 UEFI 还是 Legacy，排查思路完全不同 |
| 1 | 最近 N 天的 `41 / 6008 / 6005 / 6006 / 1074` | 判断**Windows 自己**有没有异常关机（注意上面的坑） |
| 2 | ESP 的 UUID + `\EFI\ubuntu\*`、`\EFI\Microsoft\Boot\bootmgfw.efi`、`\EFI\BOOT\BOOTX64.EFI` 的存在与哈希 | 自动修复会把 ESP 重建（UUID 变）、把回退引导换成 Windows 的 bootmgfw |
| 3 | BCD `{bootmgr}.path` 是否被改成 `\EFI\ubuntu\grubx64.efi` | 「Windows Boot Manager」应该指向 Windows 自己的 `bootmgfw.efi` |
| 4 | UEFI 启动顺序里 `ubuntu` 是不是第一 | 自动修复会把它挤到后面 → 开机直接进 Windows |
| 5 | 快速启动（`HiberbootEnabled`）、崩溃后自动重启（`AutoReboot`） | 快速启动让「关机」变休眠（双系统切换脏挂载）；自动重启让蓝屏一闪而过、没法取证 |

## 修复项（`fix-windows-boot-safety.ps1`）

1. `bcdedit /export` 备份 BCD 到 `%USERPROFILE%\dsh-whale-backups\BCD-<时间戳>.bin`
   （回滚：`bcdedit /import "<备份文件>"`）
2. `HiberbootEnabled = 0` —— 关掉快速启动
3. `AutoReboot = 0` —— 蓝屏停在屏上
4. `{bootmgr}.path = \EFI\Microsoft\Boot\bootmgfw.efi` —— 复原被篡改的 Windows 加载器
   - 跳过：`-SkipBcdPath`
5. 把固件启动项里 `description = ubuntu` 的那一项顶到最前
   - 跳过：`-SkipFirmwareOrder`；也可以 `-UbuntuGuid '{...}'` 手动指定

## 两个坑（写给以后的自己）

- **`bcdedit` 的键名会跟着控制台代码页变**：中文控制台下 `identifier` 显示成 `标识符`，
  而 `device` / `path` / `description` 仍是英文；把控制台切到 UTF-8（65001）又全变回英文。
  解析时两种都要认（脚本里 `ConvertFrom-BcdKey` 就是干这个的）。
- **`Win32_Volume` 没有 `Size` 属性**，要用 `Capacity`；否则筛选条件里
  `$_.Size -le 600MB` 会因 `$null` 当 0 比较而「意外成立」，容量也会打印成 0 MB。

## Windows .ps1 的编码约定（本仓库）

`create_file` 写出来的是**无 BOM 的 UTF-8**，而 PowerShell 5.1 会把无 BOM 的 `.ps1`
按系统 ANSI 代码页读 → 中文字符串变乱码、比较全部失败。
所以新脚本写完要补 BOM（`.gitattributes` 里 `*.ps1 text eol=crlf` 只管换行，不管编码）：

```powershell
$enc = New-Object System.Text.UTF8Encoding($true)   # $true = 带 BOM
$t = [IO.File]::ReadAllText($p)
[IO.File]::WriteAllText($p, $t, $enc)
```

同时脚本内部加 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`，
否则管道/重定向拿去的中文输出会乱码。

## 相关

- `tools/freeze-fix/` —— Ubuntu 侧：i915 稳定化 + GPU 看门狗 + 修 fstab/引导
- `docs/dualboot-boot-safety.md` —— 本次事故取证、结论与两端口径
