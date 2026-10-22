# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 1.0.3 packaged Windows proof for the Codex hook launch (fix/103-codexhook-pkg). Needs no Node: it runs the INSTALLED Murage.exe
# the way the fixed driver does. It writes the launcher exactly as server/drivers/codex-hook.ts hookWindowsLauncher does, sets
# MURAGE_CODEX_HOOK and MURAGE_CODEX_EXE as the driver does (through non-ASCII, spaced paths), removes ELECTRON_RUN_AS_NODE from its own environment, and runs the
# unchanged hooks.json command_windows under cmd /C (quoted and bare) and PowerShell -NoProfile -Command, from a folder
# with spaces. PASS = every form runs the probe in node mode (ELECTRON_RUN_AS_NODE=1, process.versions.electron set) and exits 0,
# and no Murage.exe instance is left behind. It also prints each form's wall time (the cold start the SessionStart bound covers).
#   powershell -NoProfile -ExecutionPolicy Bypass -File prove-codex-hook-packaged-win.ps1 [-Exe <path to Murage.exe>]
param([string]$Exe = (Join-Path $env:LOCALAPPDATA "Programs\Murage\Murage.exe"))
$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $Exe)) { Write-Output "FAIL no Murage.exe at $Exe"; exit 1 }
# a spaced, non-ASCII scope folder and a non-ASCII path to the installed Murage.exe (a junction to its folder: no copy, no admin)
$u = [string][char]0x00E9 + [char]0x00FC + [char]0x6771
$root = Join-Path $env:TEMP ("murage hook proof " + $u + " " + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $root | Out-Null
$exeLink = Join-Path $root ("Murage Jos" + $u)
$pass = $false
$out = $null
# everything that can throw runs inside try; the finally removes the junction itself BEFORE any recursive delete
try {
  New-Item -ItemType Junction -Path $exeLink -Target (Split-Path -Parent $Exe) | Out-Null
  $exeViaLink = Join-Path $exeLink (Split-Path -Leaf $Exe)
  $probe = Join-Path $root "murage-hook.mjs"
  $out = Join-Path $env:TEMP ("murage-hook-proof-" + [guid]::NewGuid().ToString("N").Substring(0, 8) + ".txt")
  $outJs = ($out | ConvertTo-Json)
  [System.IO.File]::WriteAllText($probe, @"
import { appendFileSync } from "node:fs";
let s = ""; for await (const c of process.stdin) s += c;
appendFileSync($outJs, JSON.stringify({ form: JSON.parse(s).session_id, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, electron: process.versions.electron ?? null, node: process.versions.node, script: import.meta.url }) + "\n");
process.exit(0);
"@, (New-Object System.Text.UTF8Encoding $false))
  $launcher = Join-Path $root "murage-hook.cmd"
  # byte for byte hookWindowsLauncher(): pure ASCII, no path in it
  $text = "@echo off`r`nif not defined MURAGE_CODEX_EXE exit /b 2`r`nset `"ELECTRON_RUN_AS_NODE=1`"`r`n`"%MURAGE_CODEX_EXE%`" `"%~dp0murage-hook.mjs`"`r`nexit /b %ERRORLEVEL%`r`n"
  [System.IO.File]::WriteAllText($launcher, $text, [System.Text.Encoding]::ASCII)
  $sysRoot = if ($env:SystemRoot -match '^[A-Za-z]:\\[A-Za-z0-9_.-]+(\\[A-Za-z0-9_.-]+)*$') { $env:SystemRoot } else { "C:\Windows" }
  $command = "$sysRoot\System32\cmd.exe /d /v:off /c %MURAGE_CODEX_HOOK%"
  $env:MURAGE_CODEX_HOOK = '@"' + $launcher + '"'
  $env:MURAGE_CODEX_EXE = $exeViaLink
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $before = @(Get-Process -Name Murage -ErrorAction SilentlyContinue | ForEach-Object Id)
  function Run-Form([string]$name, [string]$file, [string]$argLine) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $file; $psi.Arguments = $argLine; $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardOutput = $true; $psi.CreateNoWindow = $true
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.StandardInput.Write('{"hook_event_name":"SessionStart","session_id":"' + $name + '","source":"startup"}'); $p.StandardInput.Close()
    $ok = $p.WaitForExit(120000); $sw.Stop()
    $err = $p.StandardError.ReadToEnd().Trim()
    if (-not $ok) { try { $p.Kill() } catch {} }
    Write-Host ("{0,-11} exit={1} ms={2} stderr={3}" -f $name, $(if ($ok) { $p.ExitCode } else { "TIMEOUT" }), $sw.ElapsedMilliseconds, $err)
    return ($ok -and $p.ExitCode -eq 0)
  }
  $cmdExe = "$sysRoot\System32\cmd.exe"
  $results = @(
    (Run-Form "cmd-escaped" $cmdExe ('/C "' + $command + '"')),
    (Run-Form "cmd-bare" $cmdExe ('/C ' + $command)),
    (Run-Form "powershell" "powershell.exe" ('-NoProfile -Command ' + $command))
  )
  Start-Sleep -Seconds 3
  $stray = @(Get-Process -Name Murage -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id })
  $lines = if (Test-Path -LiteralPath $out) { @(Get-Content -LiteralPath $out) } else { @() }
  $lines | ForEach-Object { Write-Output "probe $_" }
  $good = @($lines | Where-Object { $_ -match '"runAsNode":"1"' -and $_ -match '"electron":"[0-9]' }).Count
  $pass = ($results -notcontains $false) -and $good -eq 3 -and $stray.Count -eq 0
  Write-Output ("forms ok={0}/3 node-mode probes={1}/3 stray Murage.exe={2}" -f @($results | Where-Object { $_ }).Count, $good, $stray.Count)
} finally {
  # the junction first, never recursively (PS 5.1's Remove-Item -Recurse can follow it into the Murage install), and only once it
  # is gone the scratch folder
  $linkGone = $true
  if (Test-Path -LiteralPath $exeLink) {
    try { [System.IO.Directory]::Delete($exeLink) } catch { & "$env:SystemRoot\System32\cmd.exe" /d /c rmdir "$exeLink" | Out-Null }
    $linkGone = -not (Test-Path -LiteralPath $exeLink)
  }
  if ($linkGone) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
  else { Write-Output "WARN the junction $exeLink could not be removed; $root was left in place, not deleted"; $pass = $false }
  if ($out) { Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue }
}
if ($pass) { Write-Output "PASS"; exit 0 } else { Write-Output "FAIL"; exit 1 }
