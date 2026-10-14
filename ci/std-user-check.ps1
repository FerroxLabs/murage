# Runs AS the local standard user. Per-user install, headless start,
# /api/health within 60 s, install lands in this user's LOCALAPPDATA, uninstall.
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$Node)
$ErrorActionPreference = 'Stop'
$fail = @()
function Note($m) { Write-Host $m }

# 0. prove we are a standard user
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Note "user=$($id.Name) isAdmin=$isAdmin"
if ($isAdmin) { Note 'FAIL: running elevated, not a standard user'; exit 2 }
if (-not $env:LOCALAPPDATA -or $env:LOCALAPPDATA -notlike "C:\Users\$($env:USERNAME)\*") { Note "FAIL: LOCALAPPDATA=$env:LOCALAPPDATA"; exit 2 }
$app = Join-Path $env:LOCALAPPDATA 'Programs\murage'
if (Test-Path $app) { Note "FAIL: $app already exists on a fresh user"; exit 2 }

# 1. install (per-user, silent)
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process $Installer -ArgumentList '/S','/currentuser' -PassThru
if (-not $p.WaitForExit(40*60*1000)) { Stop-Process -Id $p.Id -Force; $fail += 'installer-timeout' }
elseif ($p.ExitCode -ne 0) { $fail += "installer-exit-$($p.ExitCode)" }
Note "installer exit=$($p.ExitCode) secs=$([int]$sw.Elapsed.TotalSeconds)"
$exe = Join-Path $app 'Murage.exe'
$landed = Test-Path $exe
Note "installed in LOCALAPPDATA: $landed ($app)"
if (-not $landed) { $fail += 'not-in-localappdata' }
$ver = if ($landed) { (Get-Item $exe).VersionInfo.ProductVersion } else { '' }
Note "version=$ver"
$hkcu = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
  Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like 'Murage*' }
Note "HKCU uninstall entry: $([bool]$hkcu)"
if (-not $hkcu) { $fail += 'no-hkcu-uninstall-entry' }

# 2. start headless as this user and wait up to 60 s for /api/health
$health = $false; $secs = -1
if ($landed) {
  $port = 21988
  $data = Join-Path $env:USERPROFILE 'murage-std-data'
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
  Note "uninstall exit=$($u.ExitCode) Murage.exe left=$left"
  if ($left) { $fail += 'uninstall-left-files' }
  if ($u.ExitCode -ne 0) { $fail += "uninstall-exit-$($u.ExitCode)" }
}

$result = if ($fail.Count) { 'FAIL ' + ($fail -join ',') } else { 'PASS' }
@{ result = $result; user = $id.Name; isAdmin = $isAdmin; version = $ver; installedUnderLocalAppData = $landed; healthSecs = $secs } |
  ConvertTo-Json | Set-Content (Join-Path $PWD 'result.json') -Encoding utf8
Note "RESULT: $result"
if ($fail.Count) { exit 1 }
