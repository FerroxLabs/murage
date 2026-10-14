# Runs AS the local standard user. Per-user install, headless start,
# /api/health within 60 s, install lands in this user's own LOCALAPPDATA,
# per-user uninstall entry in this user's hive, uninstall.
#
# Start-Process -Credential -LoadUserProfile loads this user's profile and
# hive, but the process inherits the CALLER's environment block, so
# USERPROFILE/LOCALAPPDATA/APPDATA/TEMP still name the runner's admin and
# GetFolderPath('LocalApplicationData') expands to the admin's (unreadable)
# folder and returns ''. So: take the profile path the workflow read from
# HKLM ProfileList, prove it is this user's own, derive every folder from it,
# and export them before anything else runs. Never fall back to the admin's.
param(
  [Parameter(Mandatory)][string]$Installer,
  [Parameter(Mandatory)][string]$Node,
  [Parameter(Mandatory)][string]$ProfileDir
)
$ErrorActionPreference = 'Stop'
$fail = @()
function Note($m) { Write-Host $m }
function Die($m) { Note "FAIL: $m"; exit 2 }

# 0. prove we are a standard user
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$sid = $id.User.Value
$me = $id.Name.Split('\')[-1]
Note "user=$($id.Name) sid=$sid isAdmin=$isAdmin"
if ($isAdmin) { Die 'running elevated, not a standard user' }

# 0b. resolve this user's own profile and folders
$inherited = @{ USERPROFILE = $env:USERPROFILE; LOCALAPPDATA = $env:LOCALAPPDATA; APPDATA = $env:APPDATA; TEMP = $env:TEMP; USERNAME = $env:USERNAME }
Note "inherited env (caller's): USERPROFILE=$($inherited.USERPROFILE) LOCALAPPDATA=$($inherited.LOCALAPPDATA) USERNAME=$($inherited.USERNAME)"
$profKey = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid"
$regProf = ''
try { $regProf = [string](Get-ItemProperty -LiteralPath $profKey -Name ProfileImagePath).ProfileImagePath } catch { Note "ProfileList read failed: $($_.Exception.Message)" }
Note "ProfileDir(arg)=$ProfileDir ProfileList($sid)=$regProf"
if (-not $ProfileDir) { Die "empty -ProfileDir (ProfileList=$regProf)" }
if (-not $regProf) { Die "empty ProfileImagePath for $sid (ProfileDir=$ProfileDir); profile not loaded" }
$prof = $regProf.TrimEnd('\')
if ($prof -ne $ProfileDir.TrimEnd('\')) { Die "ProfileDir=$ProfileDir does not match ProfileList=$prof" }
if ($inherited.USERPROFILE -and $prof -eq $inherited.USERPROFILE.TrimEnd('\')) { Die "profile $prof is the caller's profile, not $me's" }
if ((Split-Path $prof -Leaf) -notlike "$me*") { Die "profile $prof is not named for $me" }
if (-not (Test-Path -LiteralPath $prof)) { Die "profile dir $prof does not exist" }
$local = Join-Path $prof 'AppData\Local'
$roaming = Join-Path $prof 'AppData\Roaming'
$temp = Join-Path $local 'Temp'
foreach ($d in $local, $roaming, $temp) {
  if (-not $d) { Die "derived an empty folder from profile '$prof'" }
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
$env:USERPROFILE = $prof; $env:LOCALAPPDATA = $local; $env:APPDATA = $roaming
$env:TEMP = $temp; $env:TMP = $temp; $env:USERNAME = $me
$env:HOMEDRIVE = $prof.Substring(0, 2); $env:HOMEPATH = $prof.Substring(2)
# informational: what the shell now resolves (this is what the installer asks for)
$shellLocal = [Environment]::GetFolderPath('LocalApplicationData', 'DoNotVerify')
Note "LOCALAPPDATA=$local APPDATA=$roaming TEMP=$temp shell(LocalApplicationData,DoNotVerify)=$shellLocal"
if ($shellLocal -and $shellLocal.TrimEnd('\') -ne $local) { Note "WARN: shell resolves LocalApplicationData to $shellLocal, not $local" }
$app = Join-Path $local 'Programs\murage'
if (Test-Path $app) { Die "$app already exists on a fresh user" }
$uninstKey = "Registry::HKEY_USERS\$sid\Software\Microsoft\Windows\CurrentVersion\Uninstall"
if (-not (Test-Path -LiteralPath "Registry::HKEY_USERS\$sid")) { Die "hive HKEY_USERS\$sid is not loaded" }
function Get-UninstallEntry {
  Get-ChildItem -LiteralPath $uninstKey -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } |
    Where-Object { $_.DisplayName -like 'Murage*' }
}
if (Get-UninstallEntry) { Die "a Murage uninstall entry already exists for $me" }

# 1. install (per-user, silent)
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process $Installer -ArgumentList '/S','/currentuser' -PassThru
if (-not $p.WaitForExit(40*60*1000)) { Stop-Process -Id $p.Id -Force; $fail += 'installer-timeout' }
elseif ($p.ExitCode -ne 0) { $fail += "installer-exit-$($p.ExitCode)" }
Note "installer exit=$($p.ExitCode) secs=$([int]$sw.Elapsed.TotalSeconds)"
$exe = Join-Path $app 'Murage.exe'
$landed = Test-Path $exe
Note "installed in this user's LOCALAPPDATA: $landed ($app)"
if (-not $landed) {
  $fail += 'not-in-localappdata'
  $stray = @($inherited.LOCALAPPDATA, 'C:\Program Files') | Where-Object { $_ } | ForEach-Object { Join-Path $_ 'Programs\murage\Murage.exe' }
  foreach ($s in $stray) { if (Test-Path $s -ErrorAction SilentlyContinue) { Note "FAIL: found install at $s instead" } }
}
$ver = if ($landed) { (Get-Item $exe).VersionInfo.ProductVersion } else { '' }
Note "version=$ver"
$entry = @(Get-UninstallEntry)
Note "HKU\$sid uninstall entries: $($entry.Count)"
if (-not $entry) { $fail += 'no-hkcu-uninstall-entry' }
foreach ($e in $entry) {
  Note "  DisplayName=$($e.DisplayName) InstallLocation=$($e.InstallLocation) UninstallString=$($e.UninstallString)"
  if ($e.InstallLocation -and $e.InstallLocation.TrimEnd('\') -ne $app) { $fail += 'uninstall-entry-wrong-location' }
}

# 2. start headless as this user and wait up to 60 s for /api/health
$health = $false; $secs = -1
if ($landed) {
  $port = 21988
  $data = Join-Path $prof 'murage-std-data'
  New-Item -ItemType Directory -Force $data | Out-Null
  $env:MURAGE_PORT = "$port"; $env:MURAGE_DATA_DIR = $data
  $server = Join-Path $app 'resources\server\index.js'
  $srv = Start-Process $Node -ArgumentList "`"$server`"" -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $PWD 'server.out.log') -RedirectStandardError (Join-Path $PWD 'server.err.log')
  $t = [Diagnostics.Stopwatch]::StartNew()
  while ($t.Elapsed.TotalSeconds -lt 60) {
    try { $r = Invoke-WebRequest "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { $health = $true; $secs = [int]$t.Elapsed.TotalSeconds; break } } catch {}
    if ($srv.HasExited) { break }
    Start-Sleep 1
  }
  Note "/api/health answered=$health after ${secs}s"
  if (-not $health) { $fail += 'health'; Get-Content (Join-Path $PWD 'server.err.log') -Tail 40 -ErrorAction SilentlyContinue }
  if (-not $srv.HasExited) { Stop-Process -Id $srv.Id -Force }
  # informational: the packaged Electron app itself (a runner session has no
  # interactive desktop for a second user, so this is best-effort only)
  Remove-Item Env:MURAGE_PORT -ErrorAction SilentlyContinue
  $gui = Start-Process $exe -PassThru -ErrorAction SilentlyContinue
  Start-Sleep 20
  Note "Murage.exe still running after 20 s (informational): $(-not $gui.HasExited)"
  Get-Process | Where-Object { $_.Path -like "$app*" } | Stop-Process -Force -ErrorAction SilentlyContinue
}

# 3. uninstall (per-user, silent)
$un = Get-ChildItem $app -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $un) { $fail += 'no-uninstaller' }
else {
  $u = Start-Process $un.FullName -ArgumentList '/S','/currentuser' -PassThru
  if (-not $u.WaitForExit(10*60*1000)) { Stop-Process -Id $u.Id -Force; $fail += 'uninstall-timeout' }
  Start-Sleep 5
  $left = Test-Path $exe
  $entryLeft = [bool](Get-UninstallEntry)
  Note "uninstall exit=$($u.ExitCode) Murage.exe left=$left uninstall entry left=$entryLeft"
  if ($left) { $fail += 'uninstall-left-files' }
  if ($entryLeft) { $fail += 'uninstall-left-entry' }
  if ($u.ExitCode -ne 0) { $fail += "uninstall-exit-$($u.ExitCode)" }
}

$result = if ($fail.Count) { 'FAIL ' + ($fail -join ',') } else { 'PASS' }
@{ result = $result; user = $id.Name; sid = $sid; profile = $prof; isAdmin = $isAdmin; version = $ver; installedUnderLocalAppData = $landed; healthSecs = $secs } |
  ConvertTo-Json | Set-Content (Join-Path $PWD 'result.json') -Encoding utf8
Note "RESULT: $result"
if ($fail.Count) { exit 1 }
