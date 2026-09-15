# Source-only task fixture. Dot-source from the admitted Limited desktop driver.
# No input injection, global hotkeys, clipboard, dialog replacement or IPC calls.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Find-OwnedElement([int]$OwnerPid, [string]$Name, [string]$AutomationId = '') {
  $scope = [System.Windows.Automation.TreeScope]::Descendants
  $pidCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $OwnerPid)
  $items = [System.Windows.Automation.AutomationElement]::RootElement.FindAll($scope, $pidCondition)
  $kind = if ($Name -match '^(Murage (Backup mode|recovery)|Save an encrypted application-data backup|Choose an encrypted application-data backup|Choose an independent age recovery key file)$') {
    [System.Windows.Automation.ControlType]::Window
  } else { [System.Windows.Automation.ControlType]::Button }
  $found = @($items | Where-Object {
    ($Name -eq '' -or $_.Current.Name -eq $Name -or ($Name -eq 'Murage Backup mode' -and $_.Current.Name -eq 'Murage recovery')) -and
    ($AutomationId -eq '' -or $_.Current.AutomationId -eq $AutomationId) -and $_.Current.IsEnabled -and $_.Current.ControlType -eq $kind
  })
  if ($found.Count -ne 1) { return $null }
  return $found[0]
}

function Wait-OwnedElement([int]$OwnerPid, [string]$Name, [string]$AutomationId = '', [int]$Seconds = 30) {
  $until = [DateTime]::UtcNow.AddSeconds($Seconds)
  if ($script:qualificationDeadline -and $until -gt $script:qualificationDeadline) { $until = $script:qualificationDeadline }
  do {
    $item = Find-OwnedElement $OwnerPid $Name $AutomationId
    if ($null -ne $item) { return $item }
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $until)
  throw "UIA prerequisite missing or ambiguous for owned PID ${OwnerPid}: $Name / $AutomationId"
}

function Invoke-OwnedButton([int]$OwnerPid, [string]$Name) {
  $item = Wait-OwnedElement $OwnerPid $Name
  $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}

function Set-OwnedFileDialog([int]$OwnerPid, [string]$Title, [string]$File, [string]$Button) {
  $dialog = Wait-OwnedElement $OwnerPid $Title
  # Common Item Dialog filename control; fail closed if the Windows UI differs.
  $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1148')
  $controls = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  if ($controls.Count -ne 1) { throw 'Native filename control 1148 absent/ambiguous; fixture admission failure' }
  $edits = if ($controls[0].Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) { @($controls[0]) } else {
    @($controls[0].FindAll([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)))
  }
  if ($edits.Count -ne 1) { throw 'Native filename value Edit absent/ambiguous; fixture admission failure' }
  $edits[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($File)
  $buttons = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $Button))
  if ($buttons.Count -ne 1) { throw 'Native file dialog button absent/ambiguous' }
  $buttons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
