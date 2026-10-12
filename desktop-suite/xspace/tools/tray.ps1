# List notification-area (tray) buttons with their rects.
# Usage: powershell -File tools\tray.ps1 -Out _shots\tray.txt [-Match XSpace]
param(
  [string]$Out = "C:\xspace_widget\_shots\tray.txt",
  [string]$Match = ""
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

$root = $AE::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, "Shell_TrayWnd")
$tray = $root.FindFirst($TS::Children, $cond)
if (-not $tray) { throw "Shell_TrayWnd not found" }
$bcond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)
$btns = $tray.FindAll($TS::Descendants, $bcond)

$lines = New-Object System.Collections.Generic.List[string]
foreach ($b in $btns) {
  $n = $b.Current.Name
  if ([string]::IsNullOrWhiteSpace($n)) { continue }
  if ($Match -ne "" -and $n -notlike "*$Match*") { continue }
  $r = $b.Current.BoundingRectangle
  $lines.Add(("{0}|{1},{2},{3}x{4}" -f $n.Replace("`r", " ").Replace("`n", " "), [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height))
}
$lines | Out-File -FilePath $Out -Encoding UTF8
Write-Output ("buttons=" + $lines.Count + " -> " + $Out)
