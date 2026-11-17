# Native adapter witness producer owner: Builder B; authorized Beast transport, pins and execution owner: MAIN.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Output,
    [Parameter(Mandatory)][string] $ObserverPath,
    [Parameter(Mandatory)][string] $ObserverSha256,
    [Parameter(Mandatory)][string] $CiToolSha256,
    [Parameter(Mandatory)][string] $ProbeExe,
    [Parameter(Mandatory)][string] $ProbeSha256
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Native witnesses require the admitted Windows standard-account host' }
$collector = [IO.Path]::GetFullPath("$PSScriptRoot/..")
$checkout = [IO.Path]::GetFullPath("$collector/../../..")
foreach ($path in @($Output,$ProbeExe)) {
    if (-not [IO.Path]::IsPathFullyQualified($path) -or [IO.Path]::GetFullPath($path) -cne $path -or -not $path.StartsWith('D:\murage-ci\',[StringComparison]::OrdinalIgnoreCase)) { throw 'User-scope native paths must stay under the admitted workspace' }
}
$relative=[IO.Path]::GetRelativePath($checkout,$Output)
if (-not $relative.StartsWith('..\',[StringComparison]::Ordinal) -or (Test-Path -LiteralPath $Output)) { throw 'New evidence directory outside checkout required' }
foreach ($digest in @($ObserverSha256,$CiToolSha256,$ProbeSha256)) { if ($digest -cnotmatch '\A[a-f0-9]{64}\z') { throw 'Independent native pins required' } }
$refs=@(Get-ChildItem "$PSHOME/ref/*.dll" | ForEach-Object FullName)
$sources=@(Get-ChildItem "$collector/*.cs" | Where-Object { $_.Name -notlike '*.selfcheck.cs' } | ForEach-Object FullName)
$sources+=@(Get-ChildItem "$PSScriptRoot/*.cs" | Where-Object { $_.Name -notlike '*.selfcheck.cs' } | ForEach-Object FullName)
$sources+=@(Get-ChildItem "$collector/reapers/*.cs" -ErrorAction SilentlyContinue | ForEach-Object FullName)
$sources+=@("$collector/../boundary/SigningProcess.cs","$collector/../boundary/WindowsSigningProcessApi.cs")
Add-Type -Path $sources -ReferencedAssemblies $refs
$token=[Murage.Witness.TokenObserver]::Current()
if (-not $token.Standard) { throw 'Native probe must run under the unchanged true standard account' }
$null=[IO.Directory]::CreateDirectory($Output)
$lines=[Collections.Generic.List[string]]::new()
$deadline=[Environment]::TickCount64+[Murage.Witness.WitnessCodec]::CaseMilliseconds
$budget=[Threading.CancellationTokenSource]::new([Murage.Witness.WitnessCodec]::CaseMilliseconds)
try {
    $lines.Add("TOKEN_CURRENT_STANDARD=$($token.Standard); ADMINISTRATORS_SID=$($token.AdministratorMember); SHUTDOWN_LUIDS_ABSENT=$($token.ShutdownRemoved)")
    $binding=[Murage.Witness.CollectionEntry]::WorkflowBinding(('a'*40))
    try {
        $peer=[Murage.Witness.SystemObservationPeer]::new($ObserverPath,$ObserverSha256,$budget.Token)
        $channel=[Murage.Witness.ObservationChannel]::new($peer)
        try {
            $snapshot=[Murage.Witness.SacAdapter]::Snapshot($channel,$binding,$CiToolSha256,$budget.Token)
            if ($snapshot.State -notin @(0,2)) { throw 'Beast negative SAC witness expected state 0 or 2' }
            $lines.Add("SAC_EXPECTED_RED state=$($snapshot.State) build=$($snapshot.Build) ubr=$($snapshot.Ubr); NOT_ACCEPTANCE")
        } finally { $channel.Dispose() }
    } finally { }
    $self=[Diagnostics.Process]::GetCurrentProcess()
    $selfBytes=[IO.File]::ReadAllBytes($self.MainModule.FileName)
    $selfHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($selfBytes)).ToLowerInvariant()
    $witness=[Murage.Witness.ProcessIdentity]::new([uint32]$self.Id,$self.StartTime.ToUniversalTime().ToFileTimeUtc(),$selfHash,$self.MainModule.FileName)
    $environment=[Collections.Generic.Dictionary[string,string]]::new()
    $environment.Add('SystemRoot',$env:SystemRoot); $environment.Add('WINDIR',$env:SystemRoot); $environment.Add('TEMP',$Output); $environment.Add('TMP',$Output)
    $api=[Murage.Witness.WindowsS4ProcessApi]::new($ProbeExe,$ProbeSha256,$Output,$environment,$deadline)
    $child=$null
    try {
        $api.ArmContainment()
        $child=$api.CreateSuspended()
        if ($api.PrimaryTokenId($child) -ceq $api.PrimaryTokenId($witness)) { throw 'S4 feasibility RED: child primary token is shared; no DACL was changed' }
        $api.DenyOwnAdjustPrivilege($child); $api.Resume($child)
        $marker=Join-Path $Output 's4-native-marker.json'
        $remaining=[int]($deadline-[Environment]::TickCount64)
        if ($remaining -lt 0 -or $api.WaitForExit($child,$remaining) -ne 0) { throw 'Native feasibility process failed or exceeded the existing deadline' }
        $measurement=Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
        if ($measurement.api -cne 'OpenProcessToken' -or $measurement.requestedAccess -ne 40 -or $measurement.succeeded -ne $false -or $measurement.error -ne 5 -or $measurement.osFeasibilityOnly -ne $true) { throw 'S4 own-token native failure marker absent' }
        $lines.Add('S4_OWN_TOKEN_DACL_FEASIBLE; OS_FEASIBILITY_ONLY; NOT_SLICE6; RELEASE_HOLD')
    } finally { try { if ($null -ne $child) { $api.Terminate($child) } } finally { $api.Dispose() } }
} finally {
    $budget.Dispose()
    [IO.File]::WriteAllLines((Join-Path $Output 'adapters-native.txt'),$lines)
    $lines | Write-Output
}
