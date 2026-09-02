# DSH 小鲸鱼 · GNOME Shell 扩展版（Wayland 桌面悬浮）

在 **GNOME Wayland** 上实现"像 Windows 那样的悬浮小鲸鱼"的正解。
它是 GNOME Shell 扩展：鲸鱼直接绘制在 Shell 层，**天然悬浮于所有普通窗口之上**，
支持透明 PNG、动画、拖拽、点击——这是 GNOME Wayland 下唯一可靠的浮层方式
（Mutter 不支持 wlr-layer-shell，Electron 透明窗在 Wayland 亦不可用）。

## 背景
- 原仓库 `dsh-whale` 的 Electron 桌面版（`dsh-whale-desktop-linux`）在 **X11/Xorg 会话**下
  可用完整悬浮穿透；在 **GNOME Wayland** 会话下 Electron 无法合成透明悬浮窗口（已实测：
  X11 后端 GPU 崩溃 139、软件渲染退化、原生 Wayland 透明窗不显示）。
- 本扩展版即为 Wayland 会话提供等价的悬浮鲸鱼体验。

## 功能（MVP v1）
- 🐋 悬浮鲸鱼（透明 PNG，位于屏幕右下，记住上次位置）
- 🖱️ 拖拽移动（限主屏工作区）、按压回弹动画
- 👆 点击 → 读取 `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY` →
  调用 `api.deepseek.com/user/balance` → 气泡显示余额
- 与既有扩展（hanabi 动态壁纸等）同属扩展体系，互不冲突，可统一开关

## 目录
```
dsh-whale-shell-extension/
├── metadata.json     # 扩展元数据（uuid dsh-whale@local）
├── extension.js      # 扩展主逻辑（ESM / GNOME 45+）
├── assets/dshw.png   # 鲸鱼素材（源自 desktop assets/DSniang1.png）
└── install.sh        # 安装/更新脚本
```

## 安装
```bash
cd dsh-whale-shell-extension
./install.sh                 # 复制到 ~/.local/share/gnome-shell/extensions/
# 注销 → 重新登录（GNOME Wayland 需重载 shell 才会扫描新扩展）
gnome-extensions enable dsh-whale@local     # 或扩展管理器里打开
```

## 排错
```bash
journalctl --user -b -f -o cat | grep -i dsh-whale   # 看扩展日志/报错
gnome-extensions info dsh-whale@local
```

## Roadmap（后续迭代）
- [ ] 点击显示"今日已用/峰谷提示"（本地记账或平台令牌）
- [ ] 呼吸/按压 Q 弹/左吸附镜像等 widget.js 动画移植
- [ ] 汉堡菜单（大小/音效/开关）
- [ ] 气泡台词组（复用 dsh-whale-widget 素材）
- [ ] 设置面板（gschema）
