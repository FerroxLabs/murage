# Dot-source into the command's runspace; supports Windows PowerShell 5.1 and 7.
# Guard helpers stay private to the module. Cmdlet metadata is copied at load time,
# including provider dynamic parameters and common parameters.
if (Get-Module -Name MurageWipeGuard) { return }
$murageModule = New-Module -Name MurageWipeGuard -ScriptBlock {
    function Read-MurageGuard {
        if ($env:MURAGE_WIPE_GUARD_OFF -eq '1' -or !$env:MURAGE_WIPE_GUARD) { return $null }
        try {
            $config = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($env:MURAGE_WIPE_GUARD)) -ErrorAction Stop
            if ($config.v -ne 1 -or $config.off -eq $true -or !$config.socket -or !$config.token -or !$config.threadId) { return $null }
            if ($null -eq $config.roots) { return $null }
            foreach ($root in $config.roots) { if ($root -isnot [string] -or !$root) { return $null } }
            return $config
        } catch { return $null }
    }

    function Copy-MurageParameters($Parameters) {
        $copy = @{}
        foreach ($key in $Parameters.Keys) { $copy[$key] = $Parameters[$key] }
        return $copy
    }

    function ConvertTo-MuragePath([string] $Path) {
        # ProviderPath is supplied by PowerShell; do not resolve relative paths
        # against the process cwd (which can differ from the provider cwd).
        if ([IO.Path]::DirectorySeparatorChar -eq '\') { $Path = $Path.Replace('/', '\') }
        $volume = [IO.Path]::GetPathRoot($Path)
        if ($Path.Length -gt $volume.Length) { $Path = $Path.TrimEnd([char[]]@('/', '\')) }
        return $Path
    }

    function Get-MurageTargets($Parameters) {
        $literal = $Parameters.ContainsKey('LiteralPath')
        $paths = $Parameters.Path
        if ($literal) { $paths = $Parameters.LiteralPath }
        foreach ($path in $paths) {
            $resolve = @{ ErrorAction = 'Ignore' }
            if ($literal) { $resolve.LiteralPath = [string]$path } else { $resolve.Path = [string]$path }
            if ($Parameters.ContainsKey('Filter')) { $resolve.Filter = $Parameters.Filter }
            # Resolve-Path has no Force switch. Get-Item lets the provider expand
            # wildcards including hidden items when the real operation has Force.
            $resolveForce = $literal -or [bool]$Parameters.Force -or ![Management.Automation.WildcardPattern]::ContainsWildcardCharacters([string]$path)
            foreach ($item in @(Microsoft.PowerShell.Management\Get-Item @resolve -Force:$resolveForce)) {
                $resolved = Microsoft.PowerShell.Management\Resolve-Path -LiteralPath $item.PSPath -ErrorAction Ignore
                if (!$resolved) { continue }
                # Match the actual Include/Exclude selection without changing the
                # parameters subsequently handed to the real cmdlet.
                $leaf = Split-Path -Path $resolved.ProviderPath -Leaf
                $filterLeaf = !$Parameters.Recurse -or (!$literal -and [Management.Automation.WildcardPattern]::ContainsWildcardCharacters([string]$path))
                if ($filterLeaf -and $Parameters.Include) {
                    $included = $false
                    foreach ($pattern in $Parameters.Include) { if ($leaf -like $pattern) { $included = $true } }
                    if (!$included) { continue }
                }
                $excluded = $false
                if ($filterLeaf) {
                    foreach ($pattern in $Parameters.Exclude) { if ($leaf -like $pattern) { $excluded = $true } }
                }
                if (!$excluded) { ConvertTo-MuragePath $resolved.ProviderPath }
            }
        }
    }

    function Get-MurageLoopTargets($Parameters, [string[]] $BoundTargets, $Enumerator) {
        # The proxy captures a clone of PowerShell's active foreach array
        # enumerator before any guard loops run. These are actual runtime values;
        # never evaluate source text or advance the caller's enumerator.
        if (!$Enumerator) { return }
        $current = $Enumerator.Current
        if ($current -is [IO.FileSystemInfo]) { $current = $current.FullName }
        if ($current -isnot [string]) { return }
        $selection = Copy-MurageParameters $Parameters
        $selection.Remove('Path'); $selection.Remove('LiteralPath')
        $selection.LiteralPath = $current
        $currentTargets = @(Get-MurageTargets $selection)
        if ($currentTargets.Count -ne 1 -or $BoundTargets -notcontains $currentTargets[0]) { return }
        while ($Enumerator.MoveNext()) {
            $next = $Enumerator.Current
            if ($next -is [IO.FileSystemInfo]) { $next = $next.FullName }
            if ($next -isnot [string]) { continue }
            $selection.LiteralPath = $next
            Get-MurageTargets $selection
        }
    }

    function Test-MuragePotential($Config, [string] $Tool, $Record) {
        if ($Tool -notin @('Remove-Item', 'Move-Item')) { return $true }
        foreach ($target in $Record.Targets) {
            foreach ($root in $Config.roots) {
                $root = ConvertTo-MuragePath $root
                if ($script:PathComparer.Equals($root, $target)) { return $true }
                if (($Record.Parameters.Recurse -or $Tool -eq 'Move-Item') -and
                    $script:PathComparer.Equals($root, (ConvertTo-MuragePath (Split-Path $target -Parent)))) { return $true }
            }
        }
        return $false
    }

    $script:PathComparer = [StringComparer]::Ordinal
    if ([IO.Path]::DirectorySeparatorChar -eq '\') { $script:PathComparer = [StringComparer]::OrdinalIgnoreCase }
    function Get-MurageMatch($Config, [string] $Tool, $Records) {
        $targets = New-Object 'System.Collections.Generic.HashSet[string]' ($script:PathComparer)
        $recursive = $false
        foreach ($record in $Records) {
            if ($record.Parameters.Recurse) { $recursive = $true }
            foreach ($target in $record.Targets) { $null = $targets.Add($target) }
            foreach ($target in @(Get-MurageLoopTargets $record.Parameters $record.Targets $record.Loop)) { $null = $targets.Add($target) }
        }
        if ($Tool -notin @('Remove-Item', 'Move-Item')) {
            return @{ Targets = @($targets) }
        }
        foreach ($root in $Config.roots) {
            $root = ConvertTo-MuragePath $root
            if ($targets.Contains($root)) { return @{ Targets = @($targets) } }
            if (!$recursive -and $Tool -eq 'Remove-Item') { continue }
            $hasChild = $false
            foreach ($target in $targets) {
                if ($script:PathComparer.Equals($root, (ConvertTo-MuragePath (Split-Path $target -Parent)))) { $hasChild = $true; break }
            }
            if (!$hasChild) { continue }
            $children = @(Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $root -Force -ErrorAction Ignore)
            if (!$children.Count) { continue }
            $covered = 0
            foreach ($child in $children) {
                $resolved = Microsoft.PowerShell.Management\Resolve-Path -LiteralPath $child.PSPath -ErrorAction Ignore
                if ($resolved -and $targets.Contains((ConvertTo-MuragePath $resolved.ProviderPath))) { $covered++ }
            }
            if ($covered -gt 0 -and $covered -ge [Math]::Ceiling($children.Count * 0.9)) {
                return @{ Targets = @($targets) }
            }
        }
        return $null
    }

    function Get-MurageArguments($Records) {
        # Bound values, never source text; argv excludes the tool name. Use
        # canonical parameter names so the callback can independently re-decide.
        foreach ($record in $Records) {
            foreach ($key in @($record.Parameters.Keys | Sort-Object)) {
                $value = $record.Parameters[$key]
                if ($value -is [System.Management.Automation.SwitchParameter] -or $value -is [bool]) {
                    if ([bool]$value) { '-' + $key }
                } else {
                    '-' + $key
                    foreach ($item in $value) { [string]$item }
                }
            }
        }
    }

    function Request-MurageDecision($Config, [string] $Tool, [string[]] $Arguments, [string[]] $Targets) {
        # This function is entered only after a positive match. Transport and
        # protocol faults must refuse; they must never turn into guard fail-open.
        $ErrorActionPreference = 'Stop'
        $pipe = $null
        $reader = $null
        $writer = $null
        try {
            $name = [string]$Config.socket
            if ($name.StartsWith('\\.\pipe\')) { $name = $name.Substring(9) }
            for ($attempt = 0; $attempt -lt 3; $attempt++) {
                $pipe = New-Object IO.Pipes.NamedPipeClientStream('.', $name, [IO.Pipes.PipeDirection]::InOut)
                try { $pipe.Connect(3000); break } catch {
                    $pipe.Dispose(); $pipe = $null
                    if ($attempt -eq 2) { throw }
                }
            }
            $encoding = New-Object Text.UTF8Encoding($false)
            $writer = New-Object IO.StreamWriter($pipe, $encoding, 1024, $true)
            $reader = New-Object IO.StreamReader($pipe, $encoding, $false, 1024, $true)
            $id = [Guid]::NewGuid().ToString('N')
            $request = @{ v = 1; kind = 'wipe-exec'; id = $id; token = $Config.token; threadId = $Config.threadId
                tool = $Tool; argv = @($Arguments); cwd = (Get-Location).ProviderPath; targets = @($Targets) }
            $writer.WriteLine((ConvertTo-Json -InputObject $request -Compress -Depth 12))
            $writer.Flush()
            # No read timeout: a connected owner may take as long as needed.
            $line = $reader.ReadLine()
            if (!$line -or $line.Length -gt 65536) { return 'unreachable' }
            $reply = ConvertFrom-Json -InputObject $line -ErrorAction Stop
            if ($reply.id -ne $id -or $reply.decision -notin @('allow', 'deny')) { return 'unreachable' }
            return $reply.decision
        } catch { return 'unreachable' } finally {
            if ($reader) { $reader.Dispose() }
            if ($writer) { $writer.Dispose() }
            if ($pipe) { $pipe.Dispose() }
        }
    }

    function Assert-MurageAllowed($Config, [string] $Tool, $Records) {
        try {
            $match = Get-MurageMatch $Config $Tool $Records
            if (!$match) { return }
            $arguments = @(Get-MurageArguments $Records)
        } catch { return } # Internal guard fault: run the real cmdlet.
        $decision = Request-MurageDecision $Config $Tool $arguments $match.Targets
        if ($decision -eq 'allow') { return }
        $global:LASTEXITCODE = 126
        if ($decision -eq 'deny') { [Console]::Error.WriteLine('Murage wipe check refused this command; nothing was deleted.') }
        else { [Console]::Error.WriteLine('Murage wipe check could not reach the app; nothing was deleted. Target: ' + ($match.Targets -join ', ') + ' (' + $Tool + ')') }
        exit 126
    }

    foreach ($tool in @('Remove-Item', 'Move-Item', 'Format-Volume', 'Clear-Disk', 'Initialize-Disk', 'Remove-Partition')) {
        $command = Get-Command -Name $tool -CommandType Cmdlet,Function -ErrorAction Ignore | Select-Object -First 1
        if (!$command) { continue } # Storage commands exist only on Windows.
        $source = [Management.Automation.ProxyCommand]::Create([Management.Automation.CommandMetadata]::new($command))
        $tokens = $null; $errors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
        $dynamicBody = $null
        if ($ast.DynamicParamBlock) { $dynamicBody = $ast.DynamicParamBlock.Statements.Extent.Text -join "`n" }
        $beginBody = $ast.BeginBlock.Statements.Extent.Text -join "`n"
        $processBody = $ast.ProcessBlock.Statements.Extent.Text -join "`n"
        $endBody = $ast.EndBlock.Statements.Extent.Text -join "`n"
        $newBegin = @'
begin {
    $murageConfig = Read-MurageGuard
    if (($PSBoundParameters.ContainsKey('WhatIf') -and $PSBoundParameters.WhatIf) -or
        (!$PSBoundParameters.ContainsKey('WhatIf') -and $WhatIfPreference)) { $murageConfig = $null }
    if (!$murageLoop -and $foreach -is [ICloneable] -and $foreach.GetType().FullName -like 'System.Array*Enumerator*') {
        $murageLoop = ([ICloneable]$foreach).Clone()
    }
    $murageRecords = New-Object 'System.Collections.Generic.List[object]'
__BEGIN__
}
'@.Replace('__BEGIN__', $beginBody)
        $newProcess = @'
process {
    $murageRecord = $null
    if ($murageConfig) {
        try {
            $murageParameters = Copy-MurageParameters $PSBoundParameters
            $murageRecord = @{ Input = $_; Parameters = $murageParameters; Loop = $murageLoop; Targets = @(Get-MurageTargets $murageParameters) }
            if ($murageRecords.Count -or (Test-MuragePotential $murageConfig '__TOOL__' $murageRecord)) {
                $murageRecords.Add($murageRecord)
            } else { $murageRecord = $null }
        } catch { $murageRecord = $null } # Guard fault: native semantics.
    }
    if (!$murageRecord) {
__PROCESS__
    }
}
'@.Replace('__TOOL__', $tool).Replace('__PROCESS__', $processBody)
        $newEnd = @'
end {
    if ($murageRecords.Count) {
        Assert-MurageAllowed $murageConfig '__TOOL__' $murageRecords
        foreach ($murageRecord in $murageRecords) {
            $_ = $murageRecord.Input
__PROCESS__
        }
    }
__END__
}
'@.Replace('__TOOL__', $tool).Replace('__PROCESS__', $processBody).Replace('__END__', $endBody)
        $replacements = @(@($ast.EndBlock, $newEnd), @($ast.ProcessBlock, $newProcess), @($ast.BeginBlock, $newBegin))
        if ($ast.DynamicParamBlock) {
            $newDynamic = @'
dynamicparam {
    $murageLoop = $null
    if ($foreach -is [ICloneable] -and $foreach.GetType().FullName -like 'System.Array*Enumerator*') {
        $murageLoop = ([ICloneable]$foreach).Clone()
    }
__DYNAMIC__
}
'@.Replace('__DYNAMIC__', $dynamicBody)
            $replacements += ,@($ast.DynamicParamBlock, $newDynamic)
        }
        foreach ($replacement in $replacements) {
            $extent = $replacement[0].Extent
            $source = $source.Remove($extent.StartOffset, $extent.EndOffset - $extent.StartOffset).Insert($extent.StartOffset, $replacement[1])
        }
        Set-Item -Path ('Function:' + $tool) -Value ($ExecutionContext.SessionState.Module.NewBoundScriptBlock([scriptblock]::Create($source)))
    }
    Export-ModuleMember -Function Remove-Item, Move-Item, Format-Volume, Clear-Disk, Initialize-Disk, Remove-Partition
}
Import-Module $murageModule -Global -Force -DisableNameChecking

# Install the standard proxies in the caller's session state. Module-bound
# scriptblocks cannot see the caller's automatic $foreach variable. Keep the
# implementation private and enter its module explicitly at each guard seam.
$murageInstalled = @{}
foreach ($murageTool in @('Remove-Item', 'Move-Item', 'Format-Volume', 'Clear-Disk', 'Initialize-Disk', 'Remove-Partition')) {
    $murageProxy = $murageModule.ExportedFunctions[$murageTool]
    if (!$murageProxy) { continue }
    $murageSource = $murageProxy.Definition
    $murageSource = $murageSource.Replace('Read-MurageGuard', "& (Get-Module MurageWipeGuard) { Read-MurageGuard }")
    $murageSource = $murageSource.Replace('Copy-MurageParameters $PSBoundParameters', '& (Get-Module MurageWipeGuard) { param($p) Copy-MurageParameters $p } $PSBoundParameters')
    $murageSource = $murageSource.Replace('Get-MurageTargets $murageParameters', '& (Get-Module MurageWipeGuard) { param($p) Get-MurageTargets $p } $murageParameters')
    $murageSource = $murageSource.Replace('Test-MuragePotential $murageConfig ' + "'" + $murageTool + "'" + ' $murageRecord', '& (Get-Module MurageWipeGuard) { param($c, $r) Test-MuragePotential $c ' + "'" + $murageTool + "'" + ' $r } $murageConfig $murageRecord')
    $murageSource = $murageSource.Replace('Assert-MurageAllowed $murageConfig ' + "'" + $murageTool + "'" + ' $murageRecords', '& (Get-Module MurageWipeGuard) { param($c, $r) Assert-MurageAllowed $c ' + "'" + $murageTool + "'" + ' $r } $murageConfig $murageRecords')
    Set-Item -Path ('Function:global:' + $murageTool) -Value ([scriptblock]::Create($murageSource))
    $murageInstalled[$murageTool] = $murageSource
}

$murageModule.OnRemove = {
    foreach ($entry in $murageInstalled.GetEnumerator()) {
        $path = 'Function:' + $entry.Key
        $current = Microsoft.PowerShell.Management\Get-Item -LiteralPath $path -ErrorAction Ignore
        if ($current -and $current.Definition -eq $entry.Value) {
            Microsoft.PowerShell.Management\Remove-Item -LiteralPath $path -Force
        }
    }
}.GetNewClosure()

foreach ($murageAlias in @('ri', 'rm', 'rmdir', 'del', 'erase', 'rd')) { Set-Alias -Scope Global -Name $murageAlias -Value Remove-Item -Option AllScope -Force }
foreach ($murageAlias in @('mi', 'mv', 'move')) { Set-Alias -Scope Global -Name $murageAlias -Value Move-Item -Option AllScope -Force }
