# Remove auto-start (scheduled task, or the Run-entry fallback written by install-autostart.ps1)
$ErrorActionPreference = 'SilentlyContinue'

$taskName = 'DSH Whale Desktop Widget'

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $taskName

Write-Host "Removed auto-start: $taskName"
