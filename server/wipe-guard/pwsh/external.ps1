# Private entrypoint for format.cmd and diskpart.cmd. No token in process argv.
param(
    [Parameter(Mandatory = $true, Position = 0)][ValidateSet('format', 'diskpart')][string] $Tool,
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]] $ToolArguments
)
$real = $null
$config = $null
try {
    . (Join-Path $PSScriptRoot 'guard.ps1')
    $module = Get-Module MurageWipeGuard
    $config = & $module { Read-MurageGuard }
    if ($config -and $config.realTools) { $real = $config.realTools.$Tool }
} catch { $config = $null }
if (!$real) {
    if ($Tool -eq 'format') { $real = Join-Path $env:SystemRoot 'System32\format.com' }
    else { $real = Join-Path $env:SystemRoot 'System32\diskpart.exe' }
}
if ($config) {
    $decision = & $module {
        param($Config, $Tool, $Arguments)
        Request-MurageDecision $Config $Tool $Arguments @()
    } $config $Tool $ToolArguments
    if ($decision -ne 'allow') {
        if ($decision -eq 'deny') { [Console]::Error.WriteLine('Murage wipe check refused this command; nothing was deleted.') }
        else { [Console]::Error.WriteLine('Murage wipe check could not reach the app; nothing was deleted.') }
        exit 126
    }
}
& $real @ToolArguments
exit $LASTEXITCODE
