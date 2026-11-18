# Run as-is: powershell.exe (5.1) or pwsh -NoProfile -NonInteractive -File tests/run.ps1
# Every mutation is confined to a unique temp tree; no app or real disk is used.
$ErrorActionPreference = 'Stop'
$guardScript = Join-Path (Split-Path $PSScriptRoot -Parent) 'guard.ps1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('wipe-guard-fixture-' + [Guid]::NewGuid().ToString('N'))
$originalLocation = Get-Location
$originalGuard = $env:MURAGE_WIPE_GUARD
$originalOff = $env:MURAGE_WIPE_GUARD_OFF
$script:checks = 0
$script:failures = New-Object 'System.Collections.Generic.List[string]'
$pipe = $null
. (Join-Path $PSScriptRoot 'fixture.ps1')
function Assert($Condition, [string] $Message) {
    if (!$Condition) { $script:failures.Add($Message); Write-Host ('FAIL: ' + $Message) }
    $script:checks++
}
function Reset-Tree {
    Set-Location -LiteralPath $fixture
    if (Test-Path -LiteralPath $script:root) {
        Microsoft.PowerShell.Management\Remove-Item -LiteralPath $script:root -Recurse -Force
    }
    $null = New-Item -ItemType Directory -Path $script:root
    foreach ($name in @('alpha', 'beta', '.hidden')) {
        $child = Join-Path $script:root $name
        $null = New-Item -ItemType Directory -Path $child
        [IO.File]::WriteAllText((Join-Path $child 'keep.txt'), 'fixture')
    }
}
function Write-Config {
    param([bool] $Off = $false, [string] $Socket = $pipe.Name)
    $socketPath = $Socket
    if ([IO.Path]::DirectorySeparatorChar -eq '\') { $socketPath = '\\.\pipe\' + $Socket }
    $config = @{ v = 1; socket = $socketPath; token = [Guid]::NewGuid().ToString('N'); threadId = 'fixture-turn'
        roots = @($script:root); realTools = @{}; off = $Off }
    [IO.File]::WriteAllText($env:MURAGE_WIPE_GUARD, (ConvertTo-Json -InputObject $config -Depth 5))
}
function Expect-Denied([scriptblock] $Action, [string] $Name) {
    Reset-Tree
    $before = $pipe.Requests.Count
    $result = Invoke-GuardChild $guardScript $fixture $script:root $Action.ToString()
    $denied = $result.Code -eq 126 -and $result.Err -like '*Murage wipe check refused*'
    Assert $denied ($Name + ' refused')
    Assert ($pipe.Requests.Count -eq $before + 1) ($Name + ' one request')
    Assert (@(Get-ChildItem -LiteralPath $script:root -Force).Count -eq 3) ($Name + ' no partial deletion')
}
try {
    $null = New-Item -ItemType Directory -Path $fixture
    $script:root = Join-Path $fixture 'protected'
    $env:MURAGE_WIPE_GUARD = Join-Path $fixture 'guard.json'
    $env:MURAGE_WIPE_GUARD_OFF = ''
    $pipe = New-Object GuardFixturePipe
    Reset-Tree
    Write-Config
    $loadOutput = @(. $guardScript)
    Assert ($loadOutput.Count -eq 0) 'dot-source is silent'
    foreach ($name in @('Remove-Item', 'Move-Item', 'Format-Volume', 'Clear-Disk', 'Initialize-Disk', 'Remove-Partition')) { Assert ((Get-Command $name).CommandType -eq 'Function') ($name + ' is a proxy') }
    foreach ($name in @('ri', 'rm', 'rmdir', 'del', 'erase', 'rd', 'mi', 'mv', 'move')) {
        Assert ((Get-Command $name).ResolvedCommand.CommandType -eq 'Function') ($name + ' resolves to proxy')
    }
    Expect-Denied { Remove-Item -LiteralPath $script:root -Recurse -Force } 'literal root'
    Expect-Denied { Set-Location $script:root; Get-ChildItem -Force | Remove-Item -Recurse -Force } 'pipeline cwd'
    Expect-Denied { Set-Location $script:root; Remove-Item * -Recurse -Force } 'star'
    Expect-Denied { Set-Location $script:root; Remove-Item .\* -Recurse -Force } 'dot star'
    Expect-Denied { Set-Location (Join-Path $script:root 'alpha'); Remove-Item ..\* -Recurse -Force } 'parent star'
    Expect-Denied { $target = $script:root; Remove-Item $target -Recurse -Force } 'variable'
    Expect-Denied { foreach ($target in @($script:root)) { ri -LiteralPath $target -Recurse -Force } } 'loop list'
    Expect-Denied { Get-Item -LiteralPath $script:root | Move-Item -Destination (Join-Path $fixture 'moved') } 'pipeline move'
    Expect-Denied { Get-ChildItem -LiteralPath $script:root -Force | Move-Item -Destination $fixture } 'pipeline move children'
    Expect-Denied { [pscustomobject]@{ LiteralPath = $script:root } | Remove-Item -Recurse -Force } 'property binding'
    foreach ($diskTool in @('Format-Volume', 'Clear-Disk', 'Initialize-Disk', 'Remove-Partition')) {
        $before = $pipe.Requests.Count
        $result = Invoke-GuardChild $guardScript $fixture $script:root ($diskTool + ' -Number 7 -Confirm:$false')
        $caught = $result.Code -eq 126 -and $result.Err -like '*Murage wipe check refused*'
        Assert ($caught -and $pipe.Requests.Count -eq $before + 1) ($diskTool + ' always checks (fixture cmdlet)')
        $pipe.Decision = 'allow'
        $echoed = @(42 | & $diskTool -Confirm:$false)
        Assert ($echoed.Count -eq 1 -and $echoed[0] -eq 42) ($diskTool + ' replays pipeline unchanged')
        $pipe.Decision = 'deny'
    }
    # Benign look-alikes, literal brackets, selected children, filtered wildcards.
    Reset-Tree
    $before = $pipe.Requests.Count
    $lookalike = $script:root + '-copy'
    $null = New-Item -ItemType Directory -Path $lookalike
    $output = @(Remove-Item -LiteralPath $lookalike -Recurse -Force)
    Assert ($output.Count -eq 0 -and !(Test-Path -LiteralPath $lookalike)) 'benign silent deletion'
    $brackets = Join-Path $fixture '[literal]'
    [IO.File]::WriteAllText($brackets, 'fixture')
    Remove-Item -LiteralPath $brackets -Force
    Assert (!(Test-Path -LiteralPath $brackets)) 'LiteralPath brackets'
    Remove-Item -LiteralPath (Join-Path $script:root 'alpha') -Recurse -Force
    Assert (!(Test-Path -LiteralPath (Join-Path $script:root 'alpha'))) 'one child runs'
    $oracle = Join-Path $fixture 'include-oracle'
    $null = New-Item -ItemType Directory -Path (Join-Path $oracle 'beta') -Force
    $null = New-Item -ItemType Directory -Path (Join-Path $oracle '.hidden') -Force
    foreach ($child in @('beta', '.hidden')) { [IO.File]::WriteAllText((Join-Path (Join-Path $oracle $child) 'keep.txt'), 'fixture') }
    Microsoft.PowerShell.Management\Remove-Item -Path (Join-Path $oracle '*') -Include beta -Recurse -Force
    Remove-Item -Path (Join-Path $script:root '*') -Include beta -Recurse -Force
    $expected = @(Get-ChildItem -LiteralPath $oracle -Recurse -Force | ForEach-Object { $_.FullName.Substring($oracle.Length) } | Sort-Object)
    $actual = @(Get-ChildItem -LiteralPath $script:root -Recurse -Force | ForEach-Object { $_.FullName.Substring($script:root.Length) } | Sort-Object)
    Assert (($actual -join '|') -eq ($expected -join '|')) 'Include selects identical targets to real cmdlet'
    Assert ($pipe.Requests.Count -eq $before) 'benign operations never call pipe'
    Reset-Tree
    $before = $pipe.Requests.Count
    Remove-Item -Path (Join-Path $script:root '*') -Exclude alpha,beta -Recurse -Force
    Assert ($pipe.Requests.Count -eq $before) 'Exclude avoids whole-root match'
    Assert (Test-Path -LiteralPath (Join-Path $script:root 'alpha')) 'Exclude preserved'
    # Real output/WhatIf/Confirm and native error semantics on the allowed path.
    $pipe.Decision = 'allow'
    Reset-Tree
    $whatIfOutput = @(Remove-Item -LiteralPath $script:root -Recurse -Force -WhatIf)
    Assert (Test-Path -LiteralPath $script:root) 'WhatIf preserved after approval'
    Remove-Item -LiteralPath $script:root -Recurse -Force -Confirm:$false
    Assert (!(Test-Path -LiteralPath $script:root)) 'approved real deletion'
    Reset-Tree
    $destination = Join-Path $fixture 'destination'
    $null = New-Item -ItemType Directory -Path $destination
    $moved = @(Get-Item -LiteralPath (Join-Path $script:root 'alpha') | Move-Item -Destination $destination -PassThru)
    Assert ($moved.Count -eq 1 -and $moved[0].Name -eq 'alpha') 'PassThru pipeline output preserved'
    $caught = $false
    try { Remove-Item -LiteralPath (Join-Path $fixture 'missing') -ErrorAction Stop } catch { $caught = $true }
    Assert $caught 'ErrorAction Stop preserved'
    $errs = @()
    Remove-Item -LiteralPath (Join-Path $fixture 'missing') -ErrorAction SilentlyContinue -ErrorVariable errs
    Assert ($errs.Count -gt 0) 'ErrorVariable and SilentlyContinue preserved'
    # Kill switches, missing/broken guard, and matcher fault all fail open.
    foreach ($mode in @('off', 'environment', 'missing', 'malformed', 'fault')) {
        Reset-Tree
        Write-Config -Off ($mode -eq 'off')
        if ($mode -eq 'environment') { $env:MURAGE_WIPE_GUARD_OFF = '1' }
        if ($mode -eq 'missing') { [IO.File]::Delete($env:MURAGE_WIPE_GUARD) }
        if ($mode -eq 'malformed') { [IO.File]::WriteAllText($env:MURAGE_WIPE_GUARD, '{') }
        if ($mode -eq 'fault') {
            $cfg = Get-Content -LiteralPath $env:MURAGE_WIPE_GUARD -Raw | ConvertFrom-Json
            $cfg.roots = @([string][char]0)
            [IO.File]::WriteAllText($env:MURAGE_WIPE_GUARD, (ConvertTo-Json $cfg))
        }
        $before = $pipe.Requests.Count
        Remove-Item -LiteralPath $script:root -Recurse -Force
        Assert (!(Test-Path -LiteralPath $script:root) -and $pipe.Requests.Count -eq $before) ($mode + ' runs real cmdlet')
        $env:MURAGE_WIPE_GUARD_OFF = ''
    }
    Reset-Tree
    Write-Config
    $pipe.Decision = 'malformed'
    $result = Invoke-GuardChild $guardScript $fixture $script:root 'Remove-Item -LiteralPath $script:root -Recurse -Force'
    $caught = $result.Code -eq 126 -and $result.Err -like '*Murage wipe check could not reach*'
    Assert ($caught -and (Test-Path -LiteralPath $script:root)) 'bad reply refuses'
    $pipe.Decision = 'allow'; $pipe.DelayMs = 150
    $clock = [Diagnostics.Stopwatch]::StartNew()
    Remove-Item -LiteralPath $script:root -Recurse -Force
    Assert ($clock.ElapsedMilliseconds -ge 150 -and !(Test-Path -LiteralPath $script:root)) 'wait for owner'
    $pipe.DelayMs = 0
    Reset-Tree
    Write-Config -Socket ('absent-' + [Guid]::NewGuid().ToString('N'))
    $caught = $false
    $clock.Restart()
    $result = Invoke-GuardChild $guardScript $fixture $script:root 'Remove-Item -LiteralPath $script:root -Recurse -Force'
    $caught = $result.Code -eq 126 -and $result.Err -like '*Murage wipe check could not reach*'
    Assert ($caught -and (Test-Path -LiteralPath $script:root) -and $result.Code -eq 126) 'unreachable refuses with status'
    Assert ($clock.ElapsedMilliseconds -ge 8500 -and $clock.ElapsedMilliseconds -lt 15000) 'three bounded connect attempts'
    # Every captured line validates the wire shape, token provenance and resolved targets.
    foreach ($line in $pipe.Requests.ToArray()) {
        $request = ConvertFrom-Json -InputObject $line
        Assert ($request.v -eq 1 -and $request.kind -eq 'wipe-exec' -and $request.id -and $request.token -and $request.threadId -eq 'fixture-turn') 'wire identity'
        Assert ($request.argv -is [array] -and $request.targets -is [array] -and $request.cwd) 'wire arrays and provider cwd'
        foreach ($target in $request.targets) { Assert ([IO.Path]::IsPathRooted($target)) 'resolved target is absolute' }
    }
    Write-Config
    # Warm fast-path overhead versus module-qualified cmdlet, no mutation.
    $benign = Join-Path $fixture 'bench-missing.txt'
    $count = 100
    $clock.Restart()
    for ($i = 0; $i -lt $count; $i++) { Microsoft.PowerShell.Management\Remove-Item -LiteralPath $benign -ErrorAction SilentlyContinue }
    $baseline = $clock.Elapsed.TotalMilliseconds / $count
    $clock.Restart()
    for ($i = 0; $i -lt $count; $i++) { Remove-Item -LiteralPath $benign -ErrorAction SilentlyContinue }
    $overhead = $clock.Elapsed.TotalMilliseconds / $count - $baseline
    Assert ($overhead -lt 5) 'ordinary invocation adds under 5 ms'
    if ($script:failures.Count) { throw ('Failed checks: ' + ($script:failures -join '; ')) }
    Write-Output ('PASS checks=' + $script:checks + ' PowerShell=' + $PSVersionTable.PSVersion + ' overhead_ms=' + [Math]::Round($overhead, 3))
} finally {
    Set-Location $originalLocation
    if ($pipe) { $pipe.Dispose() }
    Remove-Module MurageWipeGuard -Force -ErrorAction SilentlyContinue
    Remove-Module $diskModule -Force -ErrorAction SilentlyContinue
    $env:MURAGE_WIPE_GUARD = $originalGuard
    $env:MURAGE_WIPE_GUARD_OFF = $originalOff
    if (Test-Path -LiteralPath $fixture) { Microsoft.PowerShell.Management\Remove-Item -LiteralPath $fixture -Recurse -Force }
}
