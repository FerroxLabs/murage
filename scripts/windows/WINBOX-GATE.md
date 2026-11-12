# G-WINBOX — Murage 1.0.19

This is release-gate **preparation**, not a Windows acceptance result. Linux
unit tests do not prove EnumWindows, installation, Terminal delegation, browser
startup, or Task Scheduler behavior. Run both commands below later on the
Windows runner and retain their output directories. No product code changes.

## Runner contract

Use a **fresh disposable Windows 11 runner and account**, on an unlocked,
interactive `WinSta0\\Default` desktop. Never use a customer PC, the developer's
Windows/Mac PC, an existing Murage installation, a service/session 0, or SSH
without an interactive desktop runner. The runner account must not contain a
Murage profile/install or have Murage running. Installation writes per-user
NSIS registrations, so discard the runner afterward. No uninstaller or cleanup
of unrelated user registrations is attempted.

Select **Windows Terminal (stable)** as the default terminal application before
starting. The harness reads and verifies both `HKCU\Console\%%Startup`
delegation values using [Microsoft's registry contract](https://learn.microsoft.com/en-us/windows/terminal/group-policy#registry-information-2).
It does not change the default host, hide windows, or close baseline windows.
Keep the desktop idle except for this run; any new terminal window counts,
including one from another application. Prefer launching from the runner's
interactive GUI agent or Windows PowerShell rather than an existing Terminal
window. If Terminal reuses an existing baseline window for the self-test, the
self-test will correctly refuse to prove detection; use a fresh desktop with
no Terminal windows and repeat in a new evidence directory.

Stage the checkout (including its pinned Node dependencies) under
`C:\murage-ci\source`, Node 24 at `C:\murage-ci\node\node.exe`, and the actual
packaged 1.0.19 **NSIS installer** under `C:\murage-ci\artifacts`. Supply its
independently verified SHA256 and full packaged build commit. The installed
package must contain the winscen build provenance and Windows-hide manifest.
The optional packaged browser runtime and its Chromium assets must already be
available offline. Restrict runner egress to loopback; no accounts, API keys,
paid providers, external websites, or downloads are needed. Dependency/package
staging is a prerequisite, not an action this harness performs.

Use **Windows PowerShell 5.1**, in a new process for each command. Output paths
must be new directories under `C:\murage-ci\results`. All executable/source
paths must be physical paths under `C:\murage-ci` (no links/reparse ancestors).
If a prerequisite fails, the run fails; it never downgrades to a mock browser,
unscheduled Sentinel call, other terminal host, or an unpackaged development
server.

## Negative control first

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\murage-ci\source\scripts\windows\winbox-gate.ps1 `
  -SelfTest -DisposableRunner -OutputDirectory C:\murage-ci\results\winbox-negative
```

Expected exit code **1**, `verdict.json` **FAIL**, `selfTestPassed: true`, and
at least one offending console/Terminal window with owner image and command
line. The worker runs `cmd /c start ... /wait ...` with a deliberately visible
child held for about seven seconds. The sampler receives no control handle or
exemption, so this must be detected as a normal failure. A FAIL with
`selfTestPassed: false` is a broken/inconclusive control and blocks acceptance.
The child is bounded by the winscen native owner/job. Do not accept a positive
run without this separate successful negative control from the same runner
configuration.

## Candidate run

Replace the two digest placeholders with the actual package identity:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\murage-ci\source\scripts\windows\winbox-gate.ps1 `
  -DisposableRunner -Installer C:\murage-ci\artifacts\Murage-1.0.19-setup.exe `
  -InstallerSha256 <64-hex-installer-sha256> -Commit <40-hex-packaged-build-commit> `
  -OutputDirectory C:\murage-ci\results\winbox-rc
```

Expected exit code **0**, `verdict: PASS`, all five phases successful, and
`offendingWindows: []`. Installation runs silently into a fresh path below the
fixture, with isolated HOME/USERPROFILE/AppData, Murage data, and user-data.
Installer SHA256, installed version, executable/code inventory, and packaged
commit are checked. This does not reuse the winscen update-feed installer or
exercise the updater installation flow.

The Node driver uses the real packaged Electron renderer, API, engine process
boundary, MCP launcher, routine scheduler, browser runtime and Windows Sentinel
tasks. Only the provider CLI is the repository's deterministic fake engine;
there is no paid LLM call. It reuses winscen `fixtureEngineEntry`, MCP echo,
control `handleToolCall`, `sentinel-scenario.ps1`, native broker, job owner,
path validation, task bridge, task snapshots and task cleanup.

1. A chat is sent and waited to settlement; its transcript must contain the
   deterministic engine reply.
2. A tool turn launches the extensionless `gate-echo` command through the
   packaged collision launcher's `.cmd` fallback. That real console-subsystem
   Node MCP child launches `cmd.exe /d /c "echo winbox-shell-proof & ver"`.
   Neither the `.cmd` fixture nor that spawn sets `windowsHide`; the package's
   inherited hide hook must be installed and the actual shell result must be
   successful. The parent broker is not used to hide this shell command.
3. A disabled, fixture-owned routine is created and run once through the real
   routine API. The driver waits for that exact run ID to finish successfully.
4. The packaged browser is restarted/taken, navigates to a local HTTP page,
   and returns a nonempty browser frame before its owning bot is deleted.
5. The existing Sentinel scenario checks the packaged task while the app is
   open and closed, then clones its exact action with a real time trigger and
   observes two recurring runs and fresh publications. The clone's one-minute
   repetition accelerates the production two-minute logon schedule. The same
   winscen GUI task bridge joins scheduler-launched processes to the owned job;
   this is not a replacement scanner or a manual-only Sentinel check.

All app HTTP mutations originate in the isolated packaged renderer. Update
metadata is temporarily pointed to the loopback fixture, then restored.
Scenario success requires the app to close, the complete worker job to close
and prove empty, and new prefixed scheduled tasks to be removed and read back.
Preexisting/unprefixed tasks are preserved and reported as failures.

## Observation and evidence

`winbox-sampler.cs` runs an independent native thread in the outer PowerShell
process. It takes its first snapshot **before installation**, then calls
`EnumWindows` on every top-level window at a 200 ms cadence through worker
exit, owned cleanup and the final desktop screenshot. It records all window
classes/visibility, HWND, PID, process creation time, titles and native process
snapshots in `windows.jsonl`. It verifies the active input desktop each tick.
WMI image/command-line lookups run separately so they cannot block sampling.

A window visible in the baseline is exempt only for the same
HWND/PID/creation-time/class identity. A hidden baseline window becoming
visible counts as new. A reused PID/HWND with a different creation time also
counts as new. These fail the run:

- Any NEW visible `CASCADIA_HOSTING_WINDOW_CLASS`, `ConsoleWindowClass`, or
  `PseudoConsoleWindow`, globally, even if Terminal was activated through a
  broker and is outside the Murage process tree.
- Any NEW visible window of any class owned by a descendant of the installed
  Murage process. The normal root Murage GUI is expected. Ancestry is retained
  after parents exit and compared using process creation times to avoid PID
  reuse errors.

`verdict.json` contains PASS/FAIL, reasons, phase evidence, sampling metrics,
owner details, and the screenshot path. `offending-windows.json` is the
standalone deduplicated offender list (first/last sample and count included).
`desktop-end.png` captures the complete virtual desktop, even on failures when
capture is possible. Also retain `request.json`, `installed.json`, manifests,
`process-metadata.json`, `observer.json`, `scenario.json`, task baseline/cleanup,
job proofs, and `fixture/evidence` (transcripts, shell proof, browser frame,
Sentinel task XML and publications). Driver exceptions are written to
`fixture/driver-error.json`; partial completed phases remain in `phases.json`.

Missing samples, prerequisites, owner metadata for an offender, failed/omitted
phases, cleanup failures or a missing screenshot fail closed. The run
also fails coverage when a visible window has no matching nonzero native
owner identity in its process snapshot (including an owner created between
the snapshot and EnumWindows). An invalid later sample preserves earlier
offenders and reports the validation error; subsequent valid samples are
still evaluated. The target
cadence is 200 ms; a gap over 400 ms invalidates the run. Timing gaps are
reported, not silently excused. This is periodic observation: a flash shorter
than 200 ms can fall between ticks, and the final screenshot alone cannot
prove the absence of earlier flashes. Retain the sampler trace and the
successful negative control as part of the release decision.

## Linux unit verification

From the worktree, with host load at most 60 (one container used):

```sh
IT_JOB=afix-winbox-gate IT_W=/work/build/winbox-gate/wt \
IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh IT_CAP=2 \
IT_BOXES='murage-vt1 murage-vt2' NETARG='--network none' \
/work/fuigo-builds/tools/it-remote.sh \
  'set -eu; while awk '\''{exit !($1>60)}'\'' /proc/loadavg; do sleep 5; done; node --test scripts/windows/winbox-driver.node-test.mjs scripts/windows/winbox-proof-audit.node-test.mjs'
```

The pure tests cover detection classes, baselines, transient/hidden windows,
child ancestry, exited/reused processes, owner metadata, coverage and invalid
proof rejection, self-test FAIL semantics, and the five-phase driver including
routine identity, failure and timeout behavior. They do not execute PowerShell
or any Windows binary. Windows acceptance remains pending.
