# Find a taskbar/overflow button by name and print its rect.
# Usage: powershell -File tools\trayfind.ps1 -Match XSpace -Out _shots\tray.txt
param(
  [string]$Match = "XSpace",
  [string]$Out = "C:\xspace_widget\_shots\trayfind.txt"
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

$bcond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)
$btns = $AE::RootElement.FindAll($TS::Descendants, $bcond)
$lines = New-Object System.Collections.Generic.List[string]
foreach ($b in $btns) {
  $n = $b.Current.Name
  if ([string]::IsNullOrWhiteSpace($n)) { continue }
  if ($n -notlike "*$Match*") { continue }
  $r = $b.Current.BoundingRectangle
  if ($r.Width -lt 1) { continue }
  $lines.Add(("{0}|{1},{2},{3}x{4}" -f $n.Replace("`r", " ").Replace("`n", " "), [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height))
}
$lines | Out-File -FilePath $Out -Encoding UTF8
Write-Output ("found=" + $lines.Count + " -> " + $Out)
