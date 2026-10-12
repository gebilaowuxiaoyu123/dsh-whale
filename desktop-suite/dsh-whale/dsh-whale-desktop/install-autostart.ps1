# Register auto-start: run start-widget.ps1 (hidden) at logon
$ErrorActionPreference = 'Stop'

# 用脚本自身所在目录，避免原文里硬编码的路径在别的机器上失效
$script   = Join-Path $PSScriptRoot 'start-widget.ps1'
$taskName = 'DSH Whale Desktop Widget'

$action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"')
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'DSH whale desktop widget auto-start at logon' -Force | Out-Null
  # 提权重跑时清掉之前回退写入的 Run 条目，免得登录后启动两次
  Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $taskName -ErrorAction SilentlyContinue
  Write-Host "Registered auto-start task: $taskName"
  Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
}
catch {
  # 非管理员注册计划任务会被拒绝（0x80070005）。退回到当前用户的 Run 条目：同样开机自启，且不需要提权。
  Write-Host "计划任务注册被拒绝（$($_.Exception.Message.Trim())），改用当前用户的开机启动项。" -ForegroundColor Yellow
  $runKey     = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $runCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"'
  New-ItemProperty -Path $runKey -Name $taskName -Value $runCommand -PropertyType String -Force | Out-Null

  Write-Host "Registered auto-start entry: $taskName"
  (Get-ItemProperty -Path $runKey).PSObject.Properties |
    Where-Object { $_.Name -eq $taskName } |
    Select-Object Name, Value | Format-List
  Write-Host '（想要计划任务版本：用管理员身份重跑本脚本，它会先删掉这个 Run 条目）' -ForegroundColor DarkGray
}
