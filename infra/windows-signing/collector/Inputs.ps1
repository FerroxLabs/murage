# Public-reference/build helper producer: win-sac-sign; protected pin/ACL consumer: MAIN.
Set-StrictMode -Version Latest
function Assert-RealPath([string] $Path, [bool] $File) {
    if (-not [IO.Path]::IsPathFullyQualified($Path) -or [IO.Path]::GetFullPath($Path) -cne $Path) { throw 'Absolute canonical path required' }
    $item = Get-Item -LiteralPath $Path -Force
    if ($File -eq $item.PSIsContainer -or $item.LinkType -eq 'HardLink') { throw 'Regular path required' }
    while ($null -ne $item) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse path refused' }
        $parent = [IO.Path]::GetDirectoryName($item.FullName)
        if ([string]::IsNullOrEmpty($parent)) { break }
        $item = Get-Item -LiteralPath $parent -Force
    }
}
function Assert-Pin([string] $Path, [string] $Sha256) {
    Assert-RealPath $Path $true
    if ($Sha256 -cnotmatch '\A[a-f0-9]{64}\z' -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Sha256) { throw 'Independent pin mismatch' }
}
function Get-CleanEnvironment([string] $Executable, [string] $Scratch, [string] $PackageRoot) {
    if (-not [IO.Path]::IsPathFullyQualified($PackageRoot) -or [IO.Path]::GetFullPath($PackageRoot) -cne $PackageRoot) { throw 'Absolute canonical package root required' }
    $environment = [ordered]@{}
    # %SystemRoot% is not stored in the machine environment registry (only %windir%=%SystemRoot% is), so a Machine-scope read yields nothing; cmd.exe, ShellExecute and COM (vswhere) need it.
    $environment['SystemRoot'] = [Environment]::GetFolderPath('Windows')
    $environment['WINDIR'] = $environment['SystemRoot']
    $environment['PATH'] = [IO.Path]::GetDirectoryName($Executable) + ';' + [Environment]::SystemDirectory
    $environment['TEMP'] = $Scratch; $environment['TMP'] = $Scratch
    $environment['DOTNET_ROOT'] = [IO.Path]::GetDirectoryName($Executable)
    $environment['DOTNET_CLI_HOME'] = $Scratch
    $environment['DOTNET_CLI_TELEMETRY_OPTOUT'] = '1'
    $environment['DOTNET_SKIP_FIRST_TIME_EXPERIENCE'] = '1'
    # No welcome banner or first-use text on the captured output.
    $environment['DOTNET_NOLOGO'] = '1'
    # --no-restore still loads project.assets.json; NuGet must find the exact package folder restore filled without a profile lookup.
    $environment['NUGET_PACKAGES'] = $PackageRoot
    # NuGet's user-profile based paths (config, caches) resolve inside the scratch directory, never the real profile.
    $environment['USERPROFILE'] = $Scratch
    # NuGet and MSBuild read %APPDATA% for user-level NuGet.Config and credential state; a distinct scratch subdirectory keeps it off the real roaming profile.
    $environment['APPDATA'] = Join-Path $Scratch 'appdata'
    # %LOCALAPPDATA% holds NuGet/dotnet local caches and SDK resolver state; a distinct scratch subdirectory keeps it off the real local profile.
    $environment['LOCALAPPDATA'] = Join-Path $Scratch 'localappdata'
    if ($IsWindows) {
        # MSBuild reads $(OS) from %OS%; Microsoft.NETCore.Native.Publish.targets raises "Cross-OS native compilation is not supported" for a win-* target when it is not Windows_NT.
        $environment['OS'] = 'Windows_NT'
        # ILCompiler findvcvarsall.bat locates vswhere.exe under %ProgramFiles(x86)%.
        $environment['ProgramFiles(x86)'] = [Environment]::GetFolderPath('ProgramFilesX86')
        # vcvarsall.bat resolves the MSVC toolset and Windows SDK paths under %ProgramFiles%.
        $environment['ProgramFiles'] = [Environment]::GetFolderPath('ProgramFiles')
        # vswhere reads the Visual Studio instance registry under %ProgramData%.
        $environment['ProgramData'] = [Environment]::GetFolderPath('CommonApplicationData')
        # findvcvarsall.bat and vcvarsall.bat select the host toolchain from %PROCESSOR_ARCHITECTURE%.
        $environment['PROCESSOR_ARCHITECTURE'] = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE', 'Machine')
        # MSBuild Exec runs findvcvarsall.bat through the command interpreter named by %ComSpec%.
        $environment['ComSpec'] = Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
        # findvcvarsall.bat runs `where link`; where.exe resolves the extensionless name through %PATHEXT%.
        $environment['PATHEXT'] = '.COM;.EXE;.BAT;.CMD'
        # VsDevCmd.bat (CALLed by vcvarsall.bat) otherwise starts a detached powershell.exe telemetry sender; that program is not on the cleared PATH, and a detached child would inherit the build's output pipes.
        $environment['VSCMD_SKIP_SENDTELEMETRY'] = '1'
    }
    # The child environment is an allow-list; nothing token-like can reach it.
    foreach ($name in @($environment.Keys)) {
        if ($name -cnotmatch '\A(SystemRoot|WINDIR|OS|PATH|TEMP|TMP|DOTNET_[A-Z_]+|NUGET_PACKAGES|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramFiles(\(x86\))?|ProgramData|PROCESSOR_ARCHITECTURE|ComSpec|PATHEXT|VSCMD_SKIP_SENDTELEMETRY)\z') { throw 'Child environment outside allow-list' }
    }
    return $environment
}
function Get-ProcessTable {
    # Id, parent id, start time and name only; command lines can carry values and are never read.
    if ($IsWindows) {
        return @(Get-CimInstance -ClassName Win32_Process | ForEach-Object { [pscustomobject]@{ Id = [int] $_.ProcessId; ParentId = [int] $_.ParentProcessId; Start = $_.CreationDate; Name = $_.Name } })
    }
    return @(Get-Process | ForEach-Object { [pscustomobject]@{ Id = $_.Id; ParentId = $(if ($null -ne $_.Parent) { $_.Parent.Id } else { 0 }); Start = $(try { $_.StartTime } catch { $null }); Name = $_.ProcessName } })
}
function Get-DescendantIds([object[]] $Table, [int] $RootId, [datetime] $RootStart) {
    # Windows keeps the parent id of orphans, so descendants of an exited child are still found; the start-time check refuses reused ids.
    $ids = [Collections.Generic.HashSet[int]]::new(); $null = $ids.Add($RootId)
    do {
        $added = $false
        foreach ($entry in $Table) {
            if ($ids.Contains($entry.ParentId) -and -not $ids.Contains($entry.Id) -and $null -ne $entry.Start -and $entry.Start -ge $RootStart.AddSeconds(-1)) { $null = $ids.Add($entry.Id); $added = $true }
        }
    } while ($added)
    $null = $ids.Remove($RootId)
    return @($ids)
}
function Invoke-Clean([string] $Executable, [string[]] $Arguments, [string] $WorkingDirectory, [string] $Scratch, [string] $PackageRoot, [int] $TimeoutSeconds = 900) {
    if ($TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 1200) { throw 'Child timeout must stay well under the 30 minute job limit' }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable; $start.WorkingDirectory = $WorkingDirectory
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $start.Environment.Clear()
    $cleanEnvironment = Get-CleanEnvironment $Executable $Scratch $PackageRoot
    foreach ($name in $cleanEnvironment.Keys) { $start.Environment[$name] = $cleanEnvironment[$name] }
    # The scratch profile directories must exist before the child starts.
    $null = New-Item -ItemType Directory -Force -Path $cleanEnvironment['APPDATA'], $cleanEnvironment['LOCALAPPDATA']
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    # Names only, never values, of every variable the child ran with.
    $names = (@($start.Environment.Keys | Sort-Object) -join ', ')
    $log = Join-Path $Scratch ('child-' + [Guid]::NewGuid().ToString('N') + '.log')
    $writer = [IO.StreamWriter]::new($log, $false, [Text.UTF8Encoding]::new($false))
    $child = [Diagnostics.Process]::Start($start)
    try {
        $childStart = $child.StartTime
        # Nothing in the tree may wait on console input: a read of stdin sees end-of-file at once.
        $child.StandardInput.Close()
        # Both pipes are read line by line concurrently (no pipe-buffer deadlock); every line is streamed live and kept in the log.
        $readers = @($child.StandardOutput, $child.StandardError)
        $pending = @($readers[0].ReadLineAsync(), $readers[1].ReadLineAsync())
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        $drainDeadline = $null; $stall = $null
        while ($null -ne $pending[0] -or $null -ne $pending[1]) {
            for ($index = 0; $index -lt 2; $index++) {
                while ($null -ne $pending[$index] -and $pending[$index].IsCompleted) {
                    $line = $pending[$index].GetAwaiter().GetResult()
                    if ($null -eq $line) { $pending[$index] = $null }
                    else { $writer.WriteLine($line); Write-Host $line; $pending[$index] = $readers[$index].ReadLineAsync() }
                }
            }
            if ($null -eq $pending[0] -and $null -eq $pending[1]) { break }
            $now = [DateTime]::UtcNow
            # After exit the pipes must close promptly; a descendant that inherited them would otherwise hold the read open forever.
            if ($null -eq $drainDeadline -and $child.HasExited) { $drainDeadline = $now.AddSeconds([Math]::Min(60, $TimeoutSeconds)) }
            if ($now -ge $deadline -or ($null -ne $drainDeadline -and $now -ge $drainDeadline)) {
                $stall = if ($child.HasExited) { 'exited, but a descendant still holds the output pipes' } else { "no exit within $TimeoutSeconds s" }
                break
            }
            $null = [Threading.Tasks.Task]::WaitAny([Threading.Tasks.Task[]] @($pending | Where-Object { $null -ne $_ }), 1000)
        }
        if ($null -eq $stall) {
            $remaining = [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
            if (-not $child.WaitForExit($remaining)) { $stall = "no exit within $TimeoutSeconds s" }
        }
        $writer.Flush()
        if ($null -ne $stall) {
            $table = Get-ProcessTable
            $descendants = Get-DescendantIds $table $child.Id $childStart
            Write-Host "Pinned child stalled: $stall; killing its process tree"
            Write-Host 'Running processes at the stall (id, parent id, name; child tree marked *):'
            foreach ($entry in @($table | Sort-Object ParentId, Id)) {
                $mark = if ($entry.Id -eq $child.Id -or $descendants -contains $entry.Id) { '*' } else { ' ' }
                Write-Host ("{0} {1,7} {2,7} {3}" -f $mark, $entry.Id, $entry.ParentId, $entry.Name)
            }
            # A process that exits between the listing and the kill raises InvalidOperationException; it is already gone.
            try { $child.Kill($true) } catch [InvalidOperationException] { }
            foreach ($id in $descendants) {
                $orphan = Get-Process -Id $id -ErrorAction Ignore
                if ($null -ne $orphan) { try { $orphan.Kill($true) } catch [InvalidOperationException] { } finally { $orphan.Dispose() } }
            }
            $tail = (@(Get-Content -LiteralPath $log -Tail 200) -join "`n")
            Write-Host 'Last child output before the stall:'
            Write-Host $tail
            Write-Host "Child environment variable names: $names"
            throw "Pinned child timed out: $stall`nChild environment variable names: $names`n$tail"
        }
        if ($child.ExitCode -ne 0) {
            $tail = (@(Get-Content -LiteralPath $log -Tail 200) -join "`n")
            Write-Host $tail
            Write-Host "Child environment variable names: $names"
            throw "Pinned child refused: exit $($child.ExitCode)`nChild environment variable names: $names`n$tail"
        }
    }
    finally { $writer.Dispose(); $child.Dispose() }
}
