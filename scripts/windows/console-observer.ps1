. (Join-Path $PSScriptRoot 'owned-process.ps1')
Initialize-ConsoleObserver

function Invoke-ConsoleControl([string]$Executable,[string]$Fixture) {
  $id=[Guid]::NewGuid().ToString('N')
  $handle=Assert-GatePath (Join-Path $Fixture ($id+'.hwnd'))
  $stop=Assert-GatePath (Join-Path $Fixture ($id+'.stop'))
  $before=[MurageConsoleObserver]::Samples
  $args=(ConvertTo-WindowsArgument $handle)+' '+(ConvertTo-WindowsArgument $stop)
  $control=[MurageGateProcess]::RunInBackground($Executable,$args,$Fixture,15,$true)
  $detected=$false
  try {
    $deadline=[DateTime]::UtcNow.AddSeconds(8)
    while([DateTime]::UtcNow -lt $deadline -and -not $control.IsCompleted) {
      if(Test-Path -LiteralPath $handle) {
        $hwnd=0L
        if([long]::TryParse([IO.File]::ReadAllText($handle),[ref]$hwnd) -and $hwnd -ne 0 -and [MurageConsoleObserver]::AcceptControl($hwnd,$before)){$detected=$true;break}
      }
      Start-Sleep -Milliseconds 50
    }
    if(-not $detected){throw 'Sampler failed to detect owned visible console'}
    return [MurageConsoleObserver]::Now()
  } finally {
    [IO.File]::WriteAllText($stop,'stop')
    if($control.GetAwaiter().GetResult() -ne 0){throw 'Positive control failed'}
    [MurageConsoleObserver]::EndControl()
    Assert-WindowsHideControl @{seen=$detected;closed=$true;samples=([MurageConsoleObserver]::Samples-$before);observations=@($hwnd);errors=@()}
  }
}
