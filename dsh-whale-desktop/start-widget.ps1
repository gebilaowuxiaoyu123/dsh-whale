# DSH Whale Desktop Widget - launcher (standalone, no dsh web required)
# The widget is self-contained: it fetches the balance directly from DeepSeek API.
$ErrorActionPreference = 'Continue'

$widgetDir   = 'C:\Users\HUAWEI\Desktop\dsh-whale\dsh-whale-desktop'
$electronExe = Join-Path $widgetDir 'node_modules\electron\dist\electron.exe'

# Launch the Electron widget if not already running
$running = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*dsh-whale-desktop*' }

if ((Test-Path $electronExe) -and -not $running) {
    Start-Process -FilePath $electronExe -ArgumentList '.' -WorkingDirectory $widgetDir
}
