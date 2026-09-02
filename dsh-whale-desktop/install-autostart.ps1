# Register auto-start: run start-widget.ps1 (hidden) at logon
$ErrorActionPreference = 'Stop'

$script   = 'C:\Users\HUAWEI\Desktop\dsh-whale\dsh-whale-desktop\start-widget.ps1'
$taskName = 'DSH Whale Desktop Widget'

$action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"')
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'DSH whale desktop widget auto-start at logon' -Force | Out-Null

Write-Host "Registered auto-start task: $taskName"
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
