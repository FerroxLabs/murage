# Windows runners execute this file unchanged in BOTH Windows PowerShell 5.1 and 7:
# powershell.exe -NoProfile -NonInteractive -File server/wipe-guard/pwsh/tests/windows.ps1
# pwsh.exe       -NoProfile -NonInteractive -File server/wipe-guard/pwsh/tests/windows.ps1
$ErrorActionPreference = 'Stop'
if ([IO.Path]::DirectorySeparatorChar -ne '\') { throw 'This entrypoint requires Windows.' }
$guardDirectory = Split-Path $PSScriptRoot -Parent
$metadata = @{}
foreach ($tool in @('Remove-Item', 'Move-Item', 'Format-Volume', 'Clear-Disk', 'Initialize-Disk', 'Remove-Partition')) {
    $cmdlet = Get-Command $tool -CommandType Cmdlet,Function -ErrorAction Stop
    $metadata[$tool] = @($cmdlet.Parameters.Keys)
}
. (Join-Path $guardDirectory 'guard.ps1')
foreach ($tool in $metadata.Keys) {
    $proxy = Get-Command $tool -CommandType Function -ErrorAction Stop
    foreach ($parameter in $metadata[$tool]) {
        if (!$proxy.Parameters.ContainsKey($parameter)) { throw ('Lost native parameter: ' + $tool + '/' + $parameter) }
    }
}
Remove-Module MurageWipeGuard -Force
# Common tests use harmless compiled fixture disk cmdlets, NEVER actual disks.
. (Join-Path $PSScriptRoot 'run.ps1')
# Separate processes keep helper Add-Type declarations isolated.
$testHost = (Get-Process -Id $PID).Path
foreach ($suite in @('review.ps1','mutants.ps1')) {
    & $testHost -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot $suite)
    if ($LASTEXITCODE -ne 0) { throw ('Regression suite failed: ' + $suite) }
}
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('guard-external-fixture-' + [Guid]::NewGuid().ToString('N'))
$oldGuard = $env:MURAGE_WIPE_GUARD
$oldOff = $env:MURAGE_WIPE_GUARD_OFF
$pipe = $null
try {
    $null = New-Item -ItemType Directory -Path $fixture
    $pipe = New-Object GuardFixturePipe
    $env:MURAGE_WIPE_GUARD = Join-Path $fixture 'guard.json'
    $env:MURAGE_WIPE_GUARD_OFF = ''
    $fakeTool = Join-Path $fixture 'fixture-tool.cmd'
    [IO.File]::WriteAllText($fakeTool, "@echo off`r`necho fixture-arguments %*`r`nexit /b 23`r`n")
    $config = @{ v = 1; socket = ('\\.\pipe\' + $pipe.Name); threadId = 'fixture-external-turn'
        token = [Guid]::NewGuid().ToString('N'); roots = @($fixture); off = $false
        realTools = @{ format = $fakeTool; diskpart = $fakeTool } }
    [IO.File]::WriteAllText($env:MURAGE_WIPE_GUARD, (ConvertTo-Json -InputObject $config -Depth 5))
    # Windows dot names are not hidden by default: exercise actual attributes.
    $hiddenRoot = Join-Path $fixture 'hidden-root'
    $null = New-Item -ItemType Directory -Path $hiddenRoot
    foreach ($name in @('visible', 'hidden')) {
        $child = Join-Path $hiddenRoot $name
        $null = New-Item -ItemType Directory -Path $child
        [IO.File]::WriteAllText((Join-Path $child 'keep.txt'), 'fixture')
    }
    [IO.File]::SetAttributes((Join-Path $hiddenRoot 'hidden'), ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::Hidden))
    $config.roots = @($hiddenRoot)
    [IO.File]::WriteAllText($env:MURAGE_WIPE_GUARD, (ConvertTo-Json -InputObject $config -Depth 5))
    . (Join-Path $guardDirectory 'guard.ps1')
    $before = $pipe.Requests.Count
    $result = Invoke-GuardChild (Join-Path $guardDirectory 'guard.ps1') $fixture $hiddenRoot 'Get-ChildItem -LiteralPath $script:root -Force | Remove-Item -Recurse -Force'
    if ($result.Code -ne 126 -or $result.Err -notlike '*Murage wipe check refused*' -or $pipe.Requests.Count -ne $before + 1 -or @(Get-ChildItem -LiteralPath $hiddenRoot -Force).Count -ne 2) { throw 'Windows hidden-attribute pipeline was not refused atomically.' }
    Remove-Module MurageWipeGuard -Force
    $config.roots = @($fixture)
    [IO.File]::WriteAllText($env:MURAGE_WIPE_GUARD, (ConvertTo-Json -InputObject $config -Depth 5))
    foreach ($tool in @('format', 'diskpart')) {
        $shim = Join-Path $guardDirectory ($tool + '.cmd')
        $before = $pipe.Requests.Count
        $pipe.Decision = 'allow'
        $output = @(& $shim 'fixture-target' '/fixture-option' 'fixture label')
        if ($LASTEXITCODE -ne 23) { throw ($tool + ' lost real exit code') }
        if (($output -join "`n") -notlike '*fixture-arguments*fixture-target*/fixture-option*fixture label*') { throw ($tool + ' lost argv/output') }
        if ($pipe.Requests.Count -ne $before + 1) { throw ($tool + ' did not ask exactly once') }
        $pipe.Decision = 'deny'
        # Capture stderr to a fixture file; native stderr is not a terminating
        # PowerShell error under the runner's ErrorActionPreference=Stop.
        $stderr = Join-Path $fixture ($tool + '-stderr.txt')
        $savedPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { $output = @(& $shim 'fixture-target' 2>$stderr) } finally { $ErrorActionPreference = $savedPreference }
        if ($LASTEXITCODE -ne 126 -or $output.Count -ne 0) { throw ($tool + ' did not refuse without running fake tool') }
        if ([IO.File]::ReadAllText($stderr) -notlike '*Murage wipe check refused*') { throw ($tool + ' lost plain refusal') }
    }
    foreach ($line in @($pipe.Requests.ToArray() | Select-Object -Skip 1)) {
        $request = ConvertFrom-Json -InputObject $line
        if ($request.tool -notin @('format', 'diskpart') -or $request.argv[0] -ne 'fixture-target') { throw 'External request lost actual tool/argv.' }
        if ($request.token -ne $config.token -or $request.threadId -ne $config.threadId) { throw 'External request lost turn identity.' }
    }
    Write-Output ('PASS Windows native metadata and both external shims PowerShell=' + $PSVersionTable.PSVersion)
} finally {
    if ($pipe) { $pipe.Dispose() }
    $env:MURAGE_WIPE_GUARD = $oldGuard
    $env:MURAGE_WIPE_GUARD_OFF = $oldOff
    if (Test-Path -LiteralPath $fixture) { Microsoft.PowerShell.Management\Remove-Item -LiteralPath $fixture -Recurse -Force }
}
