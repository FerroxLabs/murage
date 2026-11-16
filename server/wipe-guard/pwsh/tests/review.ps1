# Regression witnesses for the review findings. All mutations use fake temp roots.
param([string] $GuardScript = (Join-Path (Split-Path $PSScriptRoot -Parent) 'guard.ps1'),
    [ValidateSet('all','H1','H2','M1','M2','M3')][string] $Case = 'all')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'fixture.ps1')
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('guard-review-' + [Guid]::NewGuid().ToString('N'))
$root = Join-Path $fixture 'protected'
$oldGuard = $env:MURAGE_WIPE_GUARD
$pipe = $null
$failures = @()
function Check($Condition, $Name) {
    if ($Condition) { Write-Output ('PASS ' + $Name) } else { $script:failures += $Name; Write-Output ('FAIL ' + $Name) }
}
function Reset-Root {
    if (Test-Path -LiteralPath $root) { Microsoft.PowerShell.Management\Remove-Item -LiteralPath $root -Recurse -Force }
    $null = New-Item -ItemType Directory -Path $root
    foreach ($i in 1..10) {
        $child = Join-Path $root ('child' + $i)
        $null = New-Item -ItemType Directory -Path $child
        [IO.File]::WriteAllText((Join-Path $child 'keep.txt'), 'fixture')
    }
}
function Child([string] $Action) {
    Invoke-GuardChild $GuardScript $fixture $root $Action
}
try {
    $null = New-Item -ItemType Directory -Path $fixture
    $pipe = New-Object GuardFixturePipe
    $env:MURAGE_WIPE_GUARD = Join-Path $fixture 'guard.json'
    $config = @{v=1;socket=$pipe.Name;threadId='fixture-turn';token=[Guid]::NewGuid().ToString('N');roots=@($root)}
    [IO.File]::WriteAllText($env:MURAGE_WIPE_GUARD, (ConvertTo-Json $config))
    if ($Case -in @('all','H1')) {
    foreach ($selection in @('-Include ''*.txt''', '-Exclude ''protected''', '-Filter ''*.txt''')) {
        Reset-Root
        $before = $pipe.Requests.Count
        $r = Child ('Remove-Item -LiteralPath $root -Recurse -Force ' + $selection)
        Check ($pipe.Requests.Count -eq $before+1 -and @(Get-ChildItem $root -Recurse -Filter '*.txt').Count -eq 10) ('H1 recursive ' + $selection)
    }
    }
    if ($Case -in @('all','H2')) {
    foreach ($action in @(
        'foreach ($p in @(Get-ChildItem $root -Force)) { Remove-Item -LiteralPath $p.FullName -Recurse -Force }',
        '$paths = @(Get-ChildItem $root -Force | ForEach-Object FullName); foreach ($p in $paths) { ri -LiteralPath $p -Recurse -Force }',
        'foreach ($p in @(Get-ChildItem $root -Force)) { Move-Item -LiteralPath $p.FullName -Destination $fixture }'
    )) {
        Reset-Root
        $before = $pipe.Requests.Count
        $r = Child $action
        Check ($pipe.Requests.Count -eq $before+1 -and @(Get-ChildItem $root -Force).Count -eq 10) ('H2 loop atomic ' + $action.Split('{')[0])
    }
    Reset-Root
    $before = $pipe.Requests.Count
    $r = Child '$paths = @(Get-ChildItem $root -Force | Select-Object -First 2 -ExpandProperty FullName); foreach ($p in $paths) { Remove-Item -LiteralPath $p -Recurse -Force }'
    Check ($r.Code -eq 0 -and $pipe.Requests.Count -eq $before -and @(Get-ChildItem $root -Force).Count -eq 8) 'H2 partial runtime list remains ordinary'
    Reset-Root
    $pipe.Decision = 'allow'
    $r = Child 'foreach ($p in @(Get-ChildItem $root -Force)) { Remove-Item -LiteralPath $p.FullName -Recurse -Force }'
    Check ($r.Code -eq 0 -and @(Get-ChildItem $root -Force).Count -eq 0) 'H2 approval does not consume caller enumerator'
    $pipe.Decision = 'deny'
    }
    Reset-Root
    $before = $pipe.Requests.Count
    if ($Case -in @('all','M1')) {
    $r = Child 'Remove-Item -LiteralPath $root -Recurse -Force -WhatIf'
    Check ($r.Code -eq 0 -and $pipe.Requests.Count -eq $before -and @(Get-ChildItem $root -Force).Count -eq 10) 'M1 WhatIf deny peer bypass'
    $r = Child '$WhatIfPreference = $true; Remove-Item -LiteralPath $root -Recurse -Force'
    Check ($r.Code -eq 0 -and $pipe.Requests.Count -eq $before) 'M1 WhatIfPreference bypass'
    $r = Child '$WhatIfPreference = $true; Remove-Item -LiteralPath $root -Recurse -Force -WhatIf:$false'
    Check ($r.Code -eq 126 -and $pipe.Requests.Count -eq $before+1) 'M1 explicit WhatIf false still guarded'
    $config.socket = 'absent-' + [Guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($env:MURAGE_WIPE_GUARD, (ConvertTo-Json $config))
    $r = Child 'Remove-Item -LiteralPath $root -Recurse -Force -WhatIf'
    Check ($r.Code -eq 0 -and @(Get-ChildItem $root -Force).Count -eq 10) 'M1 WhatIf absent peer bypass'
    }
    if ($Case -in @('all','M2')) {
    $config.socket = 'absent-' + [Guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($env:MURAGE_WIPE_GUARD, (ConvertTo-Json $config))
    $r = Child 'try { Remove-Item -LiteralPath $root -Recurse -Force } catch { }; [IO.File]::WriteAllText((Join-Path $fixture ''continued''), ''wrong'')'
    Check ($r.Code -eq 126 -and !(Test-Path (Join-Path $fixture 'continued')) -and $r.Err -like '*Murage wipe check could not reach the app; nothing was deleted.*') 'M2 unreachable process exit 126'
    $config.socket = $pipe.Name
    [IO.File]::WriteAllText($env:MURAGE_WIPE_GUARD, (ConvertTo-Json $config))
    $r = Child 'try { Remove-Item -LiteralPath $root -Recurse -Force } catch { }; [IO.File]::WriteAllText((Join-Path $fixture ''continued''), ''wrong'')'
    Check ($r.Code -eq 126 -and !(Test-Path (Join-Path $fixture 'continued')) -and $r.Err -like '*Murage wipe check refused*') 'M2 deny process exit 126'
    }
    $config.socket = $pipe.Name
    [IO.File]::WriteAllText($env:MURAGE_WIPE_GUARD, (ConvertTo-Json $config))
    if ($Case -in @('all','M3')) {
    $r = Child '$clock = [Diagnostics.Stopwatch]::StartNew(); $paths = @(1..2000 | ForEach-Object { $p = Join-Path $fixture (''benign'' + $_); [IO.File]::WriteAllText($p, ''fixture''); $p }); $paths | ForEach-Object { if ($_ -eq $paths[1] -and (Test-Path -LiteralPath $paths[0])) { throw ''not streaming'' }; $_ } | Remove-Item -Force; if (@(Get-ChildItem $fixture -Filter benign*).Count) { throw ''remaining'' }; [Console]::Out.WriteLine(''BENCH benign_count=2000 elapsed_ms='' + $clock.ElapsedMilliseconds); if ($clock.ElapsedMilliseconds -gt 10000) { throw ''pipeline too slow'' }'
    Check ($r.Code -eq 0) 'M3 2000 benign pipeline streams before next input'
    if ($r.Out) { Write-Output $r.Out.Trim() }
    }
    if ($failures.Count) { throw ('Review regressions failed: ' + ($failures -join '; ')) }
} finally {
    if ($pipe) { $pipe.Dispose() }
    $env:MURAGE_WIPE_GUARD = $oldGuard
    if (Test-Path -LiteralPath $fixture) { Microsoft.PowerShell.Management\Remove-Item -LiteralPath $fixture -Recurse -Force }
}
