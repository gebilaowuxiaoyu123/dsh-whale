# dsh-whale-pets-tray —— GNOME 顶栏桌宠控制图标

在 GNOME 顶栏右侧放一个 🐋 按钮，一眼看到两个桌宠的状态，并能直接开关。

```
顶栏：  ... 🔋 🔊 🌐 🐋
                    │
                    ├─ ● 🐟 DSH 小鲸鱼：开着（点击关闭）
                    ├─ ○ 🐋 Live2D 鲸鱼娘：已停（点击打开）
                    ├─ ──────────────
                    ├─ 🔄 刷新状态
                    └─ 🐋 打开鲸鱼娘装扮页
```

## 为什么这么实现

1. **不自己造一套启停逻辑** —— 所有动作都转发给仓库里的 `tools/petctl.sh`。
   桌面图标、开机自启、DSH 挂件里的 🐋 按钮、这个顶栏图标，四个入口**同一套实现**，
   不会出现「从 A 入口打开的、从 B 入口关不掉」这种分裂。
2. **状态读取必须异步** —— 同步 spawn 会阻塞 GNOME Shell 主循环（整个桌面卡顿）。
   这里用 `Gio.Subprocess` + `communicate_utf8_async`。
3. **不做常驻轮询** —— 只在打开菜单时刷新一次。桌宠状态不常变，轮询纯浪费。
4. **路径用候选列表 + `DSHW_PETCTL` 覆盖** —— 扩展装到
   `~/.local/share/gnome-shell/extensions/` 之后就和仓库分家了，不能靠相对路径。

## 安装

```bash
bash dsh-whale-pets-tray/install.sh          # 安装（会复制到扩展目录）
# ⚠️ 然后必须注销并重新登录
gnome-extensions enable dsh-whale-pets@local
bash dsh-whale-pets-tray/install.sh --status # 自检
```

### 为什么要重新登录

**GNOME Shell 只在启动时扫描扩展目录**，`gnome-extensions list` 走的是 Shell 的
D-Bus 接口 —— 新装的扩展在重新登录前根本不会出现在列表里。Wayland 会话下也没法
原地重启 Shell（X11 才能用 Alt+F2 → `r`）。所以「装完看不到」是正常的，重登即可。

排查加载问题：

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i dsh
```

## 卸载

```bash
bash dsh-whale-pets-tray/install.sh --uninstall
```

## 相关

- `tools/petctl.sh` —— 两个桌宠的统一控制器（start/stop/restart/toggle/status/autostart）
- `tools/autostart-pet.sh` —— 开机自启的稳妥入口（等会话就绪 + 重试 + 留日志）
- 旧的 GNOME 扩展 `dsh-whale@local`（悬浮鲸鱼本体）已卸载，源码仍在
  `dsh-whale-shell-extension/` 里，可随时回退。
