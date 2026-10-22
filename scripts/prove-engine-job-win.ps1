# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# prove-engine-job-win.ps1: proves, on a real Windows box and under the session it runs in (the gate box: an SSH session-0
# Standard user), that the stop route Murage 1.0.3 gives engine turns works there. With the extracted app's own
# engine-exclusion.node it:
#   1. creates a named job (Local\murage-pip-eng-proof-..., KILL_ON_JOB_CLOSE), as procs.ts engineJob does;
#   2. starts cmd.exe, which starts ping.exe, and puts cmd in the job at once (as spawnCli does);
#   3. terminates the job (jobStop, as stopOwnedCli does) and checks that BOTH processes are gone;
#   4. separately, puts a second cmd->ping tree in one job and then in another one (a nested job), and reports whether Windows
#      allowed it and whether stopping the inner job still ends the whole tree.
# Exit 0 when the main proof passes, 1 when it does not, 2 when it could not run. Nothing is installed or left behind.
#
# Usage (from the sshd session):
#   powershell -NoProfile -ExecutionPolicy Bypass -File prove-engine-job-win.ps1 -AppDir C:\path\to\extracted\Murage
#   ... -NodeExe C:\path\node.exe -AddonPath C:\path\engine-exclusion.node   (any node: the addon is N-API)
[CmdletBinding()]
param(
  [string]$AppDir = (Join-Path $env:LOCALAPPDATA 'Programs\Murage'),
  [string]$NodeExe,
  [string]$AddonPath
)
$ErrorActionPreference = 'Stop'

function Find-Addon([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return $null }
  $direct = Join-Path $dir 'resources\engine-exclusion.node'
  if (Test-Path -LiteralPath $direct) { return $direct }
  $found = Get-ChildItem -LiteralPath $dir -Recurse -Filter 'engine-exclusion.node' -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { return $found.FullName }
  return $null
}

if (-not $AddonPath) { $AddonPath = Find-Addon $AppDir }
if (-not $AddonPath -or -not (Test-Path -LiteralPath $AddonPath)) { Write-Output "NO-RUN: engine-exclusion.node not found (pass -AddonPath or -AppDir)"; exit 2 }
$useElectron = $false
if (-not $NodeExe) {
  $murage = Join-Path $AppDir 'Murage.exe'
  if (Test-Path -LiteralPath $murage) { $NodeExe = $murage; $useElectron = $true }
  else {
    $onPath = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($onPath) { $NodeExe = $onPath.Source }
  }
}
if (-not $NodeExe -or -not (Test-Path -LiteralPath $NodeExe)) { Write-Output "NO-RUN: no Murage.exe or node.exe (pass -NodeExe)"; exit 2 }

$proof = @'
// Runs in node (or Murage.exe with ELECTRON_RUN_AS_NODE=1). argv: <addon> <pids file>. Prints one JSON line.
const { spawn } = require("child_process");
const fs = require("fs");
const [addonPath, pidsFile] = process.argv.slice(2);
const addon = require(addonPath);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const out = { node: process.version, electron: process.versions.electron || null, addon: addonPath, addonVersion: null, user: process.env.USERNAME || null, session: process.env.SESSIONNAME || null };
try { out.addonVersion = addon.version(); } catch (error) { out.addonVersion = "unreadable: " + error.message; }
const jobs = [];
const children = [];
const record = (pid) => { if (pid) fs.appendFileSync(pidsFile, pid + "\n"); };
const table = () => addon.processes();
// Gone means no live process with this pid AND this start time (a reused pid is a different process).
const gone = (p) => !table().some((row) => row.pid === p.pid && String(row.start) === String(p.start));
const named = (tag) => "Local\\murage-pip-eng-proof-" + tag + "-" + process.pid + "-" + Date.now();

async function startTree(job, refusalCode) {
  const cmd = spawn("cmd.exe", ["/d", "/c", "ping -n 120 127.0.0.1 >nul"], { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
  children.push(cmd);
  record(cmd.pid);
  let assigned = false, assignError = null;
  try { assigned = addon.jobAssign(job, cmd.pid, refusalCode); } catch (error) { assignError = error.message; }
  const exited = new Promise((resolve) => cmd.once("exit", (code, signal) => resolve({ code, signal })));
  const cmdRow = table().find((row) => row.pid === cmd.pid) || null;
  let ping = null;
  for (let i = 0; i < 100 && !ping && cmd.exitCode === null; i++) {
    await sleep(50);
    ping = table().find((row) => row.ppid === cmd.pid && /ping/i.test(String(row.exe || row.comm || (row.argv || []).join(" ")))) || null;
  }
  if (ping) record(ping.pid);
  return { cmd, cmdRow, ping, assigned, assignError, exited };
}

async function settle(tree) {
  const exit = await Promise.race([tree.exited, sleep(5000).then(() => null)]);
  for (let i = 0; i < 60; i++) {
    const cmdGone = !tree.cmdRow || gone(tree.cmdRow), pingGone = !tree.ping || gone(tree.ping);
    if (cmdGone && pingGone) break;
    await sleep(50);
  }
  return {
    cmdPid: tree.cmd.pid, pingPid: tree.ping ? tree.ping.pid : null, rootExit: exit,
    cmdGone: tree.cmdRow ? gone(tree.cmdRow) : tree.cmd.exitCode !== null,
    pingGone: tree.ping ? gone(tree.ping) : null,
  };
}

(async () => {
  // 1-3: the engine route.
  const name = named("main");
  const job = addon.jobCreate(name);
  jobs.push(job);
  const tree = await startTree(job, 220);
  out.main = { job: name, assigned: tree.assigned, assignError: tree.assignError, pingStarted: tree.ping !== null };
  try { out.main.jobStop = await addon.jobStop(name, 4000); } catch (error) { out.main.jobStop = "failed: " + error.message; }
  Object.assign(out.main, await settle(tree));
  out.main.pass = tree.assigned === true && tree.ping !== null && out.main.cmdGone === true && out.main.pingGone === true;

  // 4: a nested job (the CLI's own session may already put it in one).
  const outerName = named("outer"), innerName = named("inner");
  const outer = addon.jobCreate(outerName); jobs.push(outer);
  const inner = addon.jobCreate(innerName); jobs.push(inner);
  const nested = await startTree(outer, 221);
  out.nested = { outerAssigned: nested.assigned, outerAssignError: nested.assignError };
  if (nested.assigned) {
    try { out.nested.innerAssigned = addon.jobAssign(inner, nested.cmd.pid, 222); } catch (error) { out.nested.innerAssigned = false; out.nested.innerAssignError = error.message; }
    if (out.nested.innerAssigned) {
      try { out.nested.innerJobStop = await addon.jobStop(innerName, 4000); } catch (error) { out.nested.innerJobStop = "failed: " + error.message; }
    } else {
      try { await addon.jobStop(outerName, 4000); } catch { /* reported by settle */ }
    }
  }
  Object.assign(out.nested, await settle(nested));
  out.nested.allowed = out.nested.innerAssigned === true;
  out.nested.innerStopEndsTree = out.nested.allowed ? (out.nested.cmdGone === true && out.nested.pingGone === true) : null;
})().catch((error) => { out.error = String(error && error.stack || error); }).finally(() => {
  for (const job of jobs) { try { addon.jobClose(job); } catch { /* closed */ } }
  for (const child of children) { try { if (child.exitCode === null) child.kill(); } catch { /* gone */ } }
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exitCode = out.main && out.main.pass ? 0 : 1;
});
'@

$work = Join-Path ([System.IO.Path]::GetTempPath()) ('murage-engjob-proof-' + [guid]::NewGuid().ToString('N'))
$pidsFile = Join-Path $work 'pids.txt'
$hadElectronVar = Test-Path Env:ELECTRON_RUN_AS_NODE
$oldElectronVar = $env:ELECTRON_RUN_AS_NODE
$code = 2
try {
  New-Item -ItemType Directory -Path $work | Out-Null
  $script = Join-Path $work 'proof.js'
  Set-Content -LiteralPath $script -Value $proof -Encoding UTF8
  if ($useElectron) { $env:ELECTRON_RUN_AS_NODE = '1' }
  Write-Output "node: $NodeExe (ELECTRON_RUN_AS_NODE=$useElectron)"
  Write-Output "addon: $AddonPath"
  # Windows PowerShell 5.1 turns a native stderr line into a terminating error under 'Stop': read it as text instead.
  $ErrorActionPreference = 'Continue'
  $result = & $NodeExe $script $AddonPath $pidsFile 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  $result | ForEach-Object { Write-Output $_ }
  $json = $result | Where-Object { "$_".StartsWith('{') } | Select-Object -Last 1
  if ($json) {
    $r = "$json" | ConvertFrom-Json
    Write-Output ''
    Write-Output ("MAIN   : assigned={0} pingStarted={1} jobStop={2} cmdGone={3} pingGone={4} => {5}" -f $r.main.assigned, $r.main.pingStarted, ($r.main.jobStop | ConvertTo-Json -Compress), $r.main.cmdGone, $r.main.pingGone, $(if ($r.main.pass) { 'PASS' } else { 'FAIL' }))
    Write-Output ("NESTED : outerAssigned={0} nestedJobAllowed={1} innerStopEndsTree={2}" -f $r.nested.outerAssigned, $r.nested.allowed, $r.nested.innerStopEndsTree)
    if ($r.error) { Write-Output "ERROR  : $($r.error)" }
  } else {
    Write-Output 'NO-RUN: the proof printed no result'
    $code = 2
  }
}
finally {
  if ($hadElectronVar) { $env:ELECTRON_RUN_AS_NODE = $oldElectronVar } else { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
  # Only the cmd and ping processes this proof started (by recorded pid, and only while they still are cmd or ping).
  if (Test-Path -LiteralPath $pidsFile) {
    foreach ($line in Get-Content -LiteralPath $pidsFile) {
      $leftPid = 0
      if ([int]::TryParse("$line".Trim(), [ref]$leftPid) -and $leftPid -gt 0) {
        $left = Get-Process -Id $leftPid -ErrorAction SilentlyContinue
        if ($left -and ($left.ProcessName -eq 'cmd' -or $left.ProcessName -eq 'PING' -or $left.ProcessName -eq 'ping')) {
          Write-Output "cleanup: ending leftover $($left.ProcessName) $leftPid"
          Stop-Process -Id $leftPid -Force -ErrorAction SilentlyContinue
        }
      }
    }
  }
  $tempRoot = [System.IO.Path]::GetTempPath()
  if ($work -and $work.StartsWith($tempRoot) -and (Split-Path -Leaf $work).StartsWith('murage-engjob-proof-') -and (Test-Path -LiteralPath $work)) {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}
exit $code
