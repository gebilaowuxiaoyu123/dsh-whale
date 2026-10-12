# XSpace 竞赛通知桌面栏（桌面插件包）

> 本目录是 **desktop-suite** 里的一个插件包 —— 每个插件各自一个包，彼此互不依赖。

- **它是什么**：贴在桌面边缘的一条「竞赛通知 / X-Space 创客空间联盟」信息栏，.NET 9 + WPF + WebView2。
- **工程**：`XSpaceWidget/XSpaceWidget.csproj`（VS 直接打开这个工程即可）；附带 `tools/`、`_shots/`、`dist/`、`XSpace竞赛通知桌面栏.zip`。
- **许可**：**MIT**（见 `LICENSE`）。这是自家工程，源码随仓库一起入库。
- **不入库的东西**：`bin/`、`obj/`、`_shots/`、`*.zip`、`dist/*.exe`（构建产物，见 `.gitignore`）—— 换设备后重新构建即可。
- **运行时数据**（不随包走）：`%LOCALAPPDATA%\XSpaceWidget`（WebView2 用户数据）。
- **怎么启动**：`XSpaceWidget\bin\Debug\net9.0-windows\win-x64\XSpaceWidget.exe`；开机自启登记在
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `XSpaceWidget` 值里。

## 换设备怎么还原

```powershell
# 1) 拉源码（本目录已在仓库里）
git clone https://github.com/gebilaowuxiaoyu123/dsh-whale.git
cd dsh-whale\desktop-suite\xspace\XSpaceWidget

# 2) 构建（需要 .NET 9 SDK）
dotnet build -c Debug            # 或者用 Visual Studio 打开 XSpaceWidget.csproj 直接生成

# 3) 接线（自启；也可以交给 tools\desktop-suite-doctor.ps1 -Wire 自动做）
$exe = "$PWD\bin\Debug\net9.0-windows\win-x64\XSpaceWidget.exe"
Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'XSpaceWidget' -Value "`"$exe`""
```

对外发布（换发布产物而不是 Debug 产物）：把 `XSpaceWidget.csproj` 用 `dotnet publish` 打一份，然后把自启指向那份 exe。
