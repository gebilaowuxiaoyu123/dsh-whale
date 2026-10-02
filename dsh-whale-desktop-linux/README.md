# DSH 小鲸鱼桌面挂件 —— Ubuntu 22.04 / 24.04 amd64（x86_64）版

Windows 桌面挂件（`../dsh-whale-desktop`）的 **Linux 移植版**。同样是本地自包含的小鲸鱼余额挂件：
无边框、透明、置顶、覆盖整个桌面、可满桌面拖动；余额直连 DeepSeek API，首次运行自动弹窗配置
API Key 并可勾选开机自启。

> 本目录基于 Windows 版复制并做 Linux 适配（开机自启改 XDG autostart、构建目标改 AppImage/deb）。
> 数据/配置与 Windows 版一致：`~/.dsh/.credentials.yaml`、`~/.dsh/.dshw-usage.json` 等。

**功能来源**：挂件通过 `host-shim.js` **直接运行 `../dsh-whale-widget/lib/index.js`**
（DSH 网页版插件本体），因此余额 / 记账 / 多厂商额度 / 自定义角色·音效·泡泡图等功能
与网页版插件**完全一致**（23 条路由）；以后更新插件，桌面版自动同步。
插件加载失败时自动回退到内置实现，挂件始终可用；打包时插件目录经 `extraResources` 随包分发。

## 目标环境

- Ubuntu 22.04 / 24.04，**amd64（x86_64）**
- Node.js 20 / 22 LTS（Ubuntu 自带的 Node 12 太旧，需另装）

## 目录

```
dsh-whale-desktop-linux/
├── main.js                 # 主进程：本地服务(3090) + 窗口/托盘 + 插件宿主
├── host-shim.js            # DSH 宿主契约适配层：让插件本体在本机 HTTP 服务里运行
├── preload.js              # 点击穿透
├── widget.js               # 回退用前端（插件不可用时启用）
├── assets/                 # 回退用图片/音效
├── package.json            # Linux 构建配置（AppImage + deb, x64）
├── .npmrc
├── build-linux.sh          # 一键构建（AppImage + deb）
├── start-linux.sh          # 源码启动（开发）
├── install-autostart.sh    # 设置开机自启
└── uninstall-autostart.sh  # 取消开机自启
```

## 准备环境（Ubuntu）

```bash
# Node.js 20/22 LTS（任选一种）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
# 或使用 nvm

node -v   # 应 >= 20
```

## 构建

```bash
cd dsh-whale-desktop-linux
./build-linux.sh
# 产物：dist/dsh-whale-widget-1.0.0-x64.AppImage 和 .deb
```

国内网络可先设置镜像：
```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

## 运行 / 安装

**方式 A：AppImage（免安装）**
```bash
chmod +x dist/*.AppImage
./dist/dsh-whale-widget-1.0.0-x64.AppImage
# 若提示缺 libfuse2（Ubuntu 22.04 常见）：
sudo apt-get install -y libfuse2
# 若报 sandbox 相关错误，可尝试：./xxx.AppImage --no-sandbox
```

**方式 B：deb 包安装**
```bash
sudo dpkg -i dist/dsh-whale-widget-1.0.0-x64.deb   # 或 sudo apt install ./xxx.deb
dsh-whale-widget                                     # 从应用菜单或命令启动
```

## 首次运行

首次运行（`~/.dsh` 无配置）自动弹出**配置窗口**：
- 填 DeepSeek API Key（`sk-...`）
- 可勾选「开机自启」（写入 `~/.config/autostart/dsh-whale-widget.desktop`）
- 保存后创建 `~/.dsh/.credentials.yaml` 并启动挂件

之后随时可在挂件菜单里改 key（打开菜单 → 最下方 API Key 输入框 → 保存）。

## 开机自启（手动）

```bash
./install-autostart.sh "/绝对路径/到/DSH Whale Widget-x.x.x-x64.AppImage"
./uninstall-autostart.sh   # 取消
```

## 常见问题

- **AppImage 打不开 / 缺 libfuse2**：`sudo apt-get install -y libfuse2`
- **sandbox 报错**：较老内核或受限环境可 `--no-sandbox` 运行；或确认 `kernel.unprivileged_userns_clone` 已启用。
- **托盘不显示**：需要支持 StatusNotifier/AppIndicator 的桌面环境（GNOME 装 `gnome-shell-extension-appindicator`）。
- **在 Windows 上交叉构建**：可用 `npx electron-builder --linux dir` 产出 `dist/linux-unpacked` 校验配置；
  **AppImage/deb 建议在 Ubuntu 上构建**（Windows 上不保证成功）。
