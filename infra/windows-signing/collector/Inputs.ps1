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
function Invoke-Clean([string] $Executable, [string[]] $Arguments, [string] $WorkingDirectory, [string] $Scratch) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable; $start.WorkingDirectory = $WorkingDirectory
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $start.Environment.Clear()
    $start.Environment['SystemRoot'] = [Environment]::GetEnvironmentVariable('SystemRoot', 'Machine')
    $start.Environment['WINDIR'] = $start.Environment['SystemRoot']
    $start.Environment['PATH'] = [IO.Path]::GetDirectoryName($Executable) + ';' + [Environment]::SystemDirectory
    $start.Environment['TEMP'] = $Scratch; $start.Environment['TMP'] = $Scratch
    $start.Environment['DOTNET_ROOT'] = [IO.Path]::GetDirectoryName($Executable)
    $start.Environment['DOTNET_CLI_HOME'] = $Scratch
    $start.Environment['DOTNET_CLI_TELEMETRY_OPTOUT'] = '1'
    $start.Environment['DOTNET_SKIP_FIRST_TIME_EXPERIENCE'] = '1'
    if ($IsWindows) {
        # ILCompiler findvcvarsall.bat locates vswhere.exe under %ProgramFiles(x86)%.
        $start.Environment['ProgramFiles(x86)'] = [Environment]::GetFolderPath('ProgramFilesX86')
        # vcvarsall.bat resolves the MSVC toolset and Windows SDK paths under %ProgramFiles%.
        $start.Environment['ProgramFiles'] = [Environment]::GetFolderPath('ProgramFiles')
        # vswhere reads the Visual Studio instance registry under %ProgramData%.
        $start.Environment['ProgramData'] = [Environment]::GetFolderPath('CommonApplicationData')
        # findvcvarsall.bat and vcvarsall.bat select the host toolchain from %PROCESSOR_ARCHITECTURE%.
        $start.Environment['PROCESSOR_ARCHITECTURE'] = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE', 'Machine')
        # MSBuild Exec runs findvcvarsall.bat through the command interpreter named by %ComSpec%.
        $start.Environment['ComSpec'] = Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
    }
    # The child environment is an allow-list; nothing token-like can reach it.
    foreach ($name in @($start.Environment.Keys)) {
        if ($name -cnotmatch '\A(SystemRoot|WINDIR|PATH|TEMP|TMP|DOTNET_[A-Z_]+|ProgramFiles(\(x86\))?|ProgramData|PROCESSOR_ARCHITECTURE|ComSpec)\z') { throw 'Child environment outside allow-list' }
    }
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $child = [Diagnostics.Process]::Start($start)
    try {
        $stdout = $child.StandardOutput.ReadToEndAsync(); $stderr = $child.StandardError.ReadToEndAsync()
        $child.WaitForExit()
        $log = Join-Path $Scratch ('child-' + [Guid]::NewGuid().ToString('N') + '.log')
        [IO.File]::WriteAllText($log, $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult())
        if ($child.ExitCode -ne 0) {
            $tail = (@(Get-Content -LiteralPath $log -Tail 60) -join "`n")
            Write-Host $tail
            throw "Pinned child refused: exit $($child.ExitCode)`n$tail"
        }
    }
    finally { $child.Dispose() }
}
