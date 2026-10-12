param(
  [Parameter(Mandatory=$true)][string]$Action,
  [Parameter(Mandatory=$true)][int]$ProcId,
  [int]$Win = -1,
  [int]$Hwnd = 0,
  [string]$Key = "",
  [string]$Value = "",
  [int]$Max = 400,
  [string]$Out = "C:\xspace_widget\_shots\uia.txt"
)

# UI Automation helper for XSpaceWidget. ASCII-only on purpose.
# Actions: wins | dump | text | invoke | select | setvalue
# Results for dump/text are written to $Out as UTF-8 (console would garble CJK).

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$root = $AE::RootElement

$cond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $ProcId)
$wins = @()
foreach ($w in $root.FindAll($TS::Children, $cond)) {
  $r = $w.Current.BoundingRectangle
  if ($r.Width -gt 100 -and $r.Width -lt 20000) { $wins += , $w }
}

function Get-Target {
  if ($Hwnd -ne 0) { return $AE::FromHandle([IntPtr]$Hwnd) }
  if ($wins.Count -eq 0) { throw "no window found for pid $ProcId" }
  if ($Win -lt 0) { return $wins[0] }
  if ($Win -ge $wins.Count) { throw "window index $Win out of range ($($wins.Count))" }
  return $wins[$Win]
}

function Find-Element([string]$idOrName) {
  $w = Get-Target
  $c1 = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $idOrName)
  $e = $w.FindFirst($TS::Descendants, $c1)
  if ($e) { return $e }
  $c2 = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $idOrName)
  return $w.FindFirst($TS::Descendants, $c2)
}

switch ($Action) {
  "wins" {
    Write-Output ("count=" + $wins.Count)
    for ($i = 0; $i -lt $wins.Count; $i++) {
      $r = $wins[$i].Current.BoundingRectangle
      Write-Output ("[$i] name='" + $wins[$i].Current.Name + "' hwnd=" + $wins[$i].Current.NativeWindowHandle + " rect=" + [int]$r.X + "," + [int]$r.Y + "," + [int]$r.Width + "x" + [int]$r.Height)
    }
    break
  }
  "dump" {
    $w = Get-Target
    $all = $w.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("total=" + $all.Count + " window='" + $w.Current.Name + "'")
    $i = 0
    foreach ($e in $all) {
      $n = $e.Current.Name
      if ([string]::IsNullOrWhiteSpace($n)) { continue }
      $r = $e.Current.BoundingRectangle
      $lines.Add(("{0,3} {1,-22} id={2,-16} rect={3},{4},{5}x{6} name={7}" -f $i,
        $e.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""),
        $e.Current.AutomationId, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height,
        $n.Replace("`r", " ").Replace("`n", " | ")))
      $i++
      if ($i -ge $Max) { break }
    }
    $lines | Out-File -FilePath $Out -Encoding UTF8
    Write-Output ("dumped " + $i + " elements to " + $Out)
    break
  }
  "text" {
    $w = Get-Target
    $all = $w.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($e in $all) {
      if ($e.Current.ControlType -ne $CT::Text) { continue }
      $n = $e.Current.Name
      if ([string]::IsNullOrWhiteSpace($n)) { continue }
      $lines.Add($n.Replace("`r", " ").Replace("`n", " | "))
    }
    $lines | Out-File -FilePath $Out -Encoding UTF8
    Write-Output ("dumped " + $lines.Count + " texts to " + $Out)
    break
  }
  "invoke" {
    $e = Find-Element $Key
    if (-not $e) { throw "element '$Key' not found" }
    $p = $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $p.Invoke()
    Write-Output ("invoked '" + $Key + "'")
    break
  }
  "select" {
    $e = Find-Element $Key
    if (-not $e) { throw "element '$Key' not found" }
    $p = $e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $p.Select()
    Write-Output ("selected '" + $Key + "'")
    break
  }
  "setvalue" {
    $e = Find-Element $Key
    if (-not $e) { throw "element '$Key' not found" }
    $p = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $p.SetValue($Value)
    Write-Output ("set '" + $Key + "' = '" + $Value + "'")
    break
  }
  default { throw "unknown action: $Action" }
}
