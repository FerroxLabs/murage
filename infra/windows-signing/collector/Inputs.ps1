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
    $environment['SystemRoot'] = [Environment]::GetEnvironmentVariable('SystemRoot', 'Machine')
    $environment['WINDIR'] = $environment['SystemRoot']
    $environment['PATH'] = [IO.Path]::GetDirectoryName($Executable) + ';' + [Environment]::SystemDirectory
    $environment['TEMP'] = $Scratch; $environment['TMP'] = $Scratch
    $environment['DOTNET_ROOT'] = [IO.Path]::GetDirectoryName($Executable)
    $environment['DOTNET_CLI_HOME'] = $Scratch
    $environment['DOTNET_CLI_TELEMETRY_OPTOUT'] = '1'
    $environment['DOTNET_SKIP_FIRST_TIME_EXPERIENCE'] = '1'
    # --no-restore still loads project.assets.json; NuGet must find the exact package folder restore filled without a profile lookup.
    $environment['NUGET_PACKAGES'] = $PackageRoot
    # NuGet's user-profile based paths (config, caches) resolve inside the scratch directory, never the real profile.
    $environment['USERPROFILE'] = $Scratch
    # NuGet and MSBuild read %APPDATA% for user-level NuGet.Config and credential state; a distinct scratch subdirectory keeps it off the real roaming profile.
    $environment['APPDATA'] = Join-Path $Scratch 'appdata'
    # %LOCALAPPDATA% holds NuGet/dotnet local caches and SDK resolver state; a distinct scratch subdirectory keeps it off the real local profile.
    $environment['LOCALAPPDATA'] = Join-Path $Scratch 'localappdata'
    if ($IsWindows) {
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
    }
    # The child environment is an allow-list; nothing token-like can reach it.
    foreach ($name in @($environment.Keys)) {
        if ($name -cnotmatch '\A(SystemRoot|WINDIR|PATH|TEMP|TMP|DOTNET_[A-Z_]+|NUGET_PACKAGES|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramFiles(\(x86\))?|ProgramData|PROCESSOR_ARCHITECTURE|ComSpec)\z') { throw 'Child environment outside allow-list' }
    }
    return $environment
}
function Invoke-Clean([string] $Executable, [string[]] $Arguments, [string] $WorkingDirectory, [string] $Scratch, [string] $PackageRoot) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable; $start.WorkingDirectory = $WorkingDirectory
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $start.Environment.Clear()
    $cleanEnvironment = Get-CleanEnvironment $Executable $Scratch $PackageRoot
    foreach ($name in $cleanEnvironment.Keys) { $start.Environment[$name] = $cleanEnvironment[$name] }
    # The scratch profile directories must exist before the child starts.
    $null = New-Item -ItemType Directory -Force -Path $cleanEnvironment['APPDATA'], $cleanEnvironment['LOCALAPPDATA']
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $child = [Diagnostics.Process]::Start($start)
    try {
        $stdout = $child.StandardOutput.ReadToEndAsync(); $stderr = $child.StandardError.ReadToEndAsync()
        $child.WaitForExit()
        $log = Join-Path $Scratch ('child-' + [Guid]::NewGuid().ToString('N') + '.log')
        [IO.File]::WriteAllText($log, $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult())
        if ($child.ExitCode -ne 0) {
            $tail = (@(Get-Content -LiteralPath $log -Tail 200) -join "`n")
            # Names only, never values, of every variable the child ran with.
            $names = (@($start.Environment.Keys | Sort-Object) -join ', ')
            Write-Host $tail
            Write-Host "Child environment variable names: $names"
            throw "Pinned child refused: exit $($child.ExitCode)`nChild environment variable names: $names`n$tail"
        }
    }
    finally { $child.Dispose() }
}
