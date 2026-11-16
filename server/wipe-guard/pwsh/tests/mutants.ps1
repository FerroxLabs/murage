# Each production rollback must fail its own behavioral witness, never just load.
$ErrorActionPreference = 'Stop'
$guard = Join-Path (Split-Path $PSScriptRoot -Parent) 'guard.ps1'
$source = [IO.File]::ReadAllText($guard)
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('guard-mutants-' + [Guid]::NewGuid().ToString('N'))
$hostPath = (Get-Process -Id $PID).Path
$mutants = @{
    H1 = $source.Replace('$filterLeaf = !$Parameters.Recurse -or (!$literal -and [Management.Automation.WildcardPattern]::ContainsWildcardCharacters([string]$path))', '$filterLeaf = $true')
    H2 = $source.Replace('if (!$Enumerator) { return }', 'return # mutant: ignore runtime loop values')
    M1 = $source.Replace('{ $murageConfig = $null }', '{ } # mutant: card dry runs')
    M2 = $source.Replace('exit 126', "throw 'mutant refusal'")
    M3 = $source.Replace("if (`$murageRecords.Count -or (Test-MuragePotential `$murageConfig '__TOOL__' `$murageRecord))", 'if ($true)')
}
try {
    $null = New-Item -ItemType Directory -Path $fixture
    foreach ($case in @('H1','H2','M1','M2','M3')) {
        if ($mutants[$case] -eq $source) { throw ('Mutation did not apply: ' + $case) }
        $path = Join-Path $fixture ($case + '.ps1')
        [IO.File]::WriteAllText($path, $mutants[$case])
        $stdout = Join-Path $fixture 'stdout.txt'; $stderr = Join-Path $fixture 'stderr.txt'
        $review = (Join-Path $PSScriptRoot 'review.ps1').Replace("'", "''")
        $code = "& '$review' -GuardScript '" + $path.Replace("'", "''") + "' -Case '$case'"
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
        $p = Start-Process -FilePath $hostPath -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -Wait -PassThru
        $output = [IO.File]::ReadAllText($stdout)
        Write-Output $output.Trim()
        if ($p.ExitCode -eq 0 -or $output -notlike ('*FAIL ' + $case + '*')) { throw ('Survived or invalid kill: ' + $case + ' ' + [IO.File]::ReadAllText($stderr)) }
        Write-Output ('KILLED ' + $case)
    }
} finally {
    if (Test-Path -LiteralPath $fixture) { Microsoft.PowerShell.Management\Remove-Item -LiteralPath $fixture -Recurse -Force }
}
