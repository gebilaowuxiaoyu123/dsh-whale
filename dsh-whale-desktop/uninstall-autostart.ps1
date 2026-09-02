# Remove auto-start (scheduled task only; does not affect the widget itself)
$ErrorActionPreference = 'SilentlyContinue'
Unregister-ScheduledTask -TaskName 'DSH Whale Desktop Widget' -Confirm:$false
Write-Host 'Removed auto-start task: DSH Whale Desktop Widget'
