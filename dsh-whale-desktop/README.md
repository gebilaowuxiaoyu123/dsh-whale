# DSH 小鲸鱼桌面挂件（本地自包含版 · Windows）

> 本仓库已整合到统一目录 `C:\Users\HUAWEI\Desktop\dsh-whale\`：
> - `dsh-whale-widget/`   —— DSH 网页版插件源码（GitHub 克隆）
> - `dsh-whale-desktop/`  —— 本文件夹（Windows 桌面挂件）
> - `dsh-whale-desktop-linux/` —— Ubuntu 22.04/24.04 amd64 版本（另见其 README）

把 DSH 的小鲸鱼余额挂件做成**独立的桌面悬浮挂件**：无边框、透明、默认不置顶、覆盖整个桌面，
鲸鱼直接浮在 Windows 桌面上，**不依赖 dsh web、不用打开任何网页**。余额由挂件自己直连
DeepSeek API 拉取（读 `DEEPSEEK_API_KEY`），「今日已用」用本地记账模式计算。开机自动启动挂件。

**功能来源**：挂件通过 `host-shim.js` **直接运行 `../dsh-whale-widget/lib/index.js`**
（DSH 网页版插件本体），因此余额 / 记账 / 多厂商额度 / 自定义角色·音效·泡泡图等功能
与网页版插件**完全一致**（23 条路由）；以后更新插件，桌面版自动同步。
插件加载失败时自动回退到内置实现，挂件始终可用；打包时插件目录经 `extraResources` 随包分发。

## 依赖

- 本机已装 Node.js（挂件文件夹内的 Electron 已装好）。
- 需要 `DEEPSEEK_API_KEY` 已配置：`C:\Users\HUAWEI\.dsh\.credentials.yaml`（或环境变量）。
- 需要能访问 `https://api.deepseek.com`（拉余额用）。**不需要** `dsh web`。

## 目录

```
dsh-whale-desktop/
├── main.js                    # Electron 主进程：本地服务(3090) + 窗口/托盘 + 插件宿主
├── host-shim.js               # DSH 宿主契约适配层：让插件本体在本机 HTTP 服务里运行
├── preload.js                 # 像素级点击穿透控制（仅鲸鱼身体/菜单可交互）
├── widget.js                  # 回退用前端（插件不可用时启用）
├── assets/                    # 回退用图片/音效资源
├── package.json
├── start-widget.ps1           # 启动脚本：直接拉起挂件（不依赖 dsh web）
├── install-autostart.ps1      # 注册开机自启（计划任务）
└── uninstall-autostart.ps1    # 移除开机自启
```

## 手动启动

```powershell
cd C:\Users\HUAWEI\Desktop\dsh-whale\dsh-whale-desktop
node_modules\electron\dist\electron.exe .
```

或直接运行 `start-widget.ps1`。

## 开机自启

以管理员身份运行一次（或直接 PowerShell 执行）：

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\HUAWEI\Desktop\dsh-whale\dsh-whale-desktop\install-autostart.ps1
```

会注册计划任务 `DSH Whale Desktop Widget`（登录时运行）。取消自启：

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\HUAWEI\Desktop\dsh-whale\dsh-whale-desktop\uninstall-autostart.ps1
```

## 打包成 exe（部署到其他电脑）

本目录已配置 electron-builder，可打包成**单个便携 exe**：

```powershell
cd C:\Users\HUAWEI\Desktop\dsh-whale\dsh-whale-desktop
npm install            # 首次需安装依赖（含 electron-builder）
npx electron-builder --win portable
```

产物：`dist\dsh-whale-widget-<版本>.exe`（也已复制一份到桌面根目录 `C:\Users\HUAWEI\Desktop\dsh-whale-widget-1.0.0.exe`）。

**部署到新电脑**：直接把 exe 拷过去双击运行即可。首次运行会自动弹出配置窗口：
- 填 DeepSeek API Key（`sk-...`）→ 点「开始使用」
- 可勾选「开机自启」（登录时自动启动挂件）
- 保存后自动创建配置 `用户目录\.dsh\.credentials.yaml` 并启动挂件；之后随时可在挂件菜单里改 key

注意事项：
- exe 未签名，新电脑上 Windows SmartScreen 可能提示「未知发布者」，点「更多信息 → 仍要运行」即可。
- 挂件需要联网访问 `api.deepseek.com` 拉余额；配置只保存在本机，不会上传。
- 端口 3090 被占用时请先关闭其他挂件实例再启动。

## 说明 / 已知限制

- 挂件窗口**覆盖整个桌面**（透明、点击穿透），鲸鱼可以**满桌面拖动**；大小可在挂件菜单里调（0.6–2.5×）。
  **默认不置顶**：打开的应用窗口会盖住挂件，挂件仍在桌面图标之上；
  想让它浮在所有窗口之上，在**托盘菜单**里勾上「置顶显示」（值存在 `~/.dsh/.dshw-window.json`）。
- 透明区域点击穿透，鼠标移到鲸鱼/菜单上才接收点击；**拖动鲸鱼**、**点击刷新**、**汉堡菜单**均可用。
- **菜单里可直接改 API Key**：点开鲸鱼右上角菜单 → 最下方「API Key」输入框粘贴新的 `sk-...` → 点「保存」即写入 `~/.dsh/.credentials.yaml` 并自动刷新余额（打开菜单会显示当前「已配置/未配置」状态）。
- **托盘控制**：挂件窗口无边框且不进任务栏，请用**系统托盘**的小鲸鱼图标（右键）来「显示/隐藏挂件」「退出」。
- 余额/今日已用由挂件本地直连 DeepSeek API 计算（小鲸鱼记账模式），与 `dsh web` 无关；`dsh web` 想用时自己 `dsh web` 启动即可。
- 本地服务端口 3090；`DEEPSEEK_API_KEY` 未配置时鲸鱼会显示「未配置 DEEPSEEK_API_KEY」提示。
- 修改代码后重启：`Stop-Process -Name electron -Force` 后重新运行 `node_modules\electron\dist\electron.exe .`（或直接运行 `start-widget.ps1`）。
