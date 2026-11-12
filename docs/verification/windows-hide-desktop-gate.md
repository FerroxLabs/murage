# MAIN's Windows desktop gate

The operator launcher admits both profiles under MAIN's P1-1 ownership contract.
Container verification and four rejected mutants are recorded in
`scripts/windows/evidence/cfix-status.md`. Confirm review and real Windows
acceptance remain MAIN's work; this builder has used no Windows host.

The gate has **two mandatory receipts for the same package provenance commit,
MAIN-verified ZIP SHA256, and SHA256 manifest of every staged app file**, following MAIN's 2026-11-10 ruling. A receipt proves only its own half;
`PASS winhide` requires both. Neither Linux tests nor an operator-supplied assertion
count replaces the Windows runs. This builder does not execute either Windows run.

On **gate-win-desktop**, `full-packaged-scenario.ps1` keeps `MURAGE_DATA_DIR` and
`MURAGE_USER_DATA` throughout the packaged app's lifetime, with isolated
HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP. It runs five complete groups plus
`updates-isolated`. It never runs an installer. The existing refusal to restart an
updater with a custom profile is expected product behavior and is not changed.

On **gate-win-nogit**, `updates-handoff.ps1` runs under the gate-owned local user
`murage-gate`, with its **default profile** and a real autologon desktop. It checks
and downloads the local fixture update, clicks the real Restart to update button,
waits for the old app to close, and verifies a new interactive installed process,
its signed executable and the resulting fixture version. This is the only box
where installation and the default profile are exercised. The existing tagged box
is used; no paid resources are created.

Both drivers use the same native console sampler, including during the entire
install/relaunch. It samples **all visible ConsoleWindowClass windows** every
250 ms on a native timer thread, without baseline/PID exclusions. Close every
other visible console on the desktop first. Fewer than four samples, a sampling
gap over one second, any enumeration error or any visible console fails the run.
The sampler's report is retained as `windows.json`, including failures.

The Desktop groups are:

- `bot-turns`: real packaged-server send, settled state, transcript, held-call
  cancellation, and a subsequent successful turn.
- `tools`: the existing fake Codex engine executes actual local echo MCP tools.
  A conflicting fixture environment variable exercises the packaged Codex MCP
  environment launcher's direct Node command and its Windows ENOENT shell fallback.
  The latter resolves an extensionless command to a gate-owned `.cmd` on PATH;
  mount arguments, an executed-shim marker and tool results are retained.
- `sentinel`: read back the production task's packaged executable, trampoline
  arguments, scanner entry digest, InteractiveToken and PT2M repetition. Run that
  task while open and closed and assert successful results. Also register a unique
  gate-owned time-trigger task with the **same packaged action**, then wait for two
  successful recurring triggers while closed, without `/Run` on that task. The
  separate time trigger is necessary because a newly registered production logon
  trigger does not recur until another logon. Retain both XML definitions and run
  times. Both names carry the run prefix; a GUI bridge joins the named launcher
  job before running the unchanged packaged trampoline. Outer cleanup deletes
  only idle, newly created prefixed registrations.
- `mcp`: verify the external Node executable is **PE console subsystem 3**; use it
  for the stdio echo fixture, initialize/list/call, environment override, intentional
  tool error and cancellation with observed child exit. Keep protocol/results.
- `browser`: use the packaged browser's owner API for startup, local-page navigation
  and a nonempty screenshot/frame. Retain its dimensions/digest and the process
  tree; close the app and assert the observed descendants have stopped.
- `updates-isolated`: real in-app update check and download from the local feed,
  followed by clicking Restart to update. Assert the custom-profile refusal text
  is visible, retain a screenshot and updater transitions, and verify the running
  version is still 1.0.19. **Never start an installer on the Desktop.**

`-Groups` defaults to all six Desktop groups. A subset is useful for diagnostics,
but cannot produce a gate receipt. The outer task starts the scenario suspended,
assigns it first to an audit Job Object and then a KILL_ON_JOB_CLOSE child job,
and resumes it. Neither job allows breakaway. Closing the owner job kills its
process tree; QueryInformationJobObject on the distinct audit parent must then
report zero. Keeping a second handle to the owner job would prevent kill-on-close,
so the audit handle deliberately belongs to a different object.

Before launch and before/after every group, snapshot all scheduler task paths,
names, authors and action XML. Cleanup deletes only additions whose path contains
a component beginning with the unique run prefix. Pre-existing tasks, including
prefixed ones, are preserved. Unprefixed additions, changed pre-existing tasks,
enumeration errors and cleanup leftovers fail. New surviving interactive-session or caller-owned service-session processes
outside the closed job are reported, never killed. Only the recorded default
HTTPS browser executable may survive a fulfilled dispatch on gate-win-nogit.

Installer registry/ARP/protocol entries (both registry views) and Desktop/Programs
shortcuts are snapshot-diffed only under the gate-owned Handoff account. Prefixed
additions are cleaned; unprefixed additions or changes fail and are preserved.
This deliberately does not authorize removal of normal Murage registrations.
A standard installer creating unprefixed registrations will fail this gate;
MAIN must inspect the recorded diff in that case, not bypass the policy.

The Node driver and scenario child write assertions only. The scheduled outer
task closes the scenario job, verifies emptiness, performs snapshot cleanup and
writes its cleanup report. After that task exits, the operator process removes
the wrapper using its pre-registration snapshot and only then finalizes
`scenario.json`. A child-written receipt is refused. The receipt includes job
proof, both snapshot diffs, process exceptions, writer PID and cleanup/finalization
times. No success receipt is published on any failure. `receipt.schema.json`
describes each half;
`receipt-pair.mjs` also verifies kinds, package provenance commit, ZIP SHA256,
full staged-file manifest (including `resources/app.asar`), candidate SHA256, candidate/update
versions and update installer SHA256. A single receipt or two Desktop receipts
cannot pass. A copied receipt must travel with its `evidence` directory.

Prepare the artifacts on the existing Windows signing builder, from the exact
clean candidate commit. MAIN supplies the normal signed **1.0.19** candidate ZIP.
Build the fixture candidate from that same commit with this script (replace the
path to the verified candidate executable as necessary):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\build-fixture-update.ps1 -Commit (git rev-parse HEAD) -CandidateExecutable C:\murage-ci\app\Murage.exe -Version 1.0.190 -OutputDirectory C:\murage-ci\fixture-build
```

The script changes only the source package version value and restores it in
`finally`. It invokes the normal Windows package pipeline with the existing
qualification-feed configuration, `forceCodeSigning=true` and `--publish never`.
The fixture must have the same signer as the candidate, use a higher **patch**
version (`x.y.z`, never `1.0.19-gate.1`), and carry only
`http://127.0.0.1:18919/` as its updater feed. Never upload this build to any public
or qualification release feed. The fixture metadata records the source commit,
base executable digest, installer digest and versions. Windows package builds
now write `resources/build-provenance.json` from Git HEAD, refusing uncommitted
inputs except the numeric package version change. Staging reads the commit from
that packaged file and hashes every staged file. The receipt commit is derived
from this verified provenance; `-Commit` is only an equality assertion. The driver's feed validator
checks these plus `latest.yml` file names/digests before the app starts.

Stage on both machines:

- This exact checkout at `C:\murage-ci\source`, including its Windows-prepared
  dependencies (`pnpm install --frozen-lockfile` on the builder). The driver needs
  the repository's Playwright and YAML packages and existing fixture helpers;
  it does not download a browser or an engine during a gate.
- A console-subsystem Node 24 distribution at `C:\murage-ci\node`.
- The same signed candidate ZIP at `C:\murage-ci\candidate.zip`.
- `fixture-update.json`, `latest.yml`, the fixture NSIS installer and its blockmap
  from `fixture-build` at `C:\murage-ci\feed`. Do not stage public feed metadata.

The staging command extracts only into a new `C:\murage-ci\app`, checks safe ZIP
paths/version, and copies the short interactive wrappers. It does not install.
Use MAIN's independently verified ZIP digest in `-Sha256`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\murage-ci\source\scripts\windows\stage.ps1 -PackageZip C:\murage-ci\candidate.zip -Sha256 '<MAIN-VERIFIED-ZIP-SHA256>'
```

Run the handoff **first**. On gate-win-nogit, provision once from an elevated
session, then reboot. The password is generated on the box, stored only in its
local account/LSA autologon secret, and never printed or passed on a command line.
`gate-user.json` records only the username, SID, machine and timestamp.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\murage-ci\source\scripts\windows\setup-gate-user.ps1
Restart-Computer -Force
```

After autologon, use the administrative OpenSSH session to register the `/IT` task
for the recorded gate user. The task runs at LIMITED privilege on that user's real
desktop; it does not require a password. `h1` must be a new output directory, and
the gate user's default `.murage` must not exist before its first run.

```powershell
$verifiedZipSha256 = '<MAIN-VERIFIED-ZIP-SHA256>'
$commit = (Get-Content C:\murage-ci\app\resources\build-provenance.json -Raw | ConvertFrom-Json).commit
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\murage-ci\run-interactive.ps1 -Mode Handoff -PackageSha256 $verifiedZipSha256 -Commit $commit -InteractiveUser 'gate-win-nogit\murage-gate' -OutputDirectory C:\murage-ci\results\h1 -TimeoutSeconds 1800
$fixture = (Get-Content C:\murage-ci\results\h1\task-status.json -Raw | ConvertFrom-Json).fixture
Get-Content "$fixture\scenario.json", "$fixture\windows.json"
Compress-Archive -Path "$fixture\scenario.json", "$fixture\windows.json", "$fixture\evidence" -DestinationPath C:\murage-ci\handoff.zip
```

MAIN copies `handoff.zip` to the Desktop through its existing transfer channel.
On the Desktop, run as the **same account as the logged-on desktop user** from
OpenSSH. No user password is accepted. `d1` and `handoff` must be new directories.

```powershell
Expand-Archive C:\murage-ci\handoff.zip C:\murage-ci\handoff
$verifiedZipSha256 = '<MAIN-VERIFIED-ZIP-SHA256>'
$commit = (Get-Content C:\murage-ci\app\resources\build-provenance.json -Raw | ConvertFrom-Json).commit
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\murage-ci\run-interactive.ps1 -Mode Desktop -PackageSha256 $verifiedZipSha256 -Commit $commit -InteractiveUser ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -HandoffReceipt C:\murage-ci\handoff\scenario.json -OutputDirectory C:\murage-ci\results\d1 -TimeoutSeconds 1800
Get-Content C:\murage-ci\results\d1\result.txt, C:\murage-ci\results\d1\windows.json
```

Only the paired Desktop gate prints `PASS winhide ... BOTH receipts` and writes
`pair.json`. The handoff prints `RECEIPT handoff ... (pair still required)`.
Retain both complete fixture directories, both scheduler wrapper results, the
pair record, and package/fixture manifests. A rerun needs a new fixture/output
path; a handoff rerun also needs MAIN to reset the disposable gate user's profile
and installation through the box's existing reset procedure.

Container verification (no Windows workflow is claimed) runs through
`/work/fuigo-builds/tools/it-remote.sh` with `IT_JOB=cfix3-winscen`, this worktree as
`IT_W`, and `IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh`. Evidence is in
`scripts/windows/evidence`. It covers Node receipt/feed/echo behavior, the real
updater isolation refusal, PowerShell parsing, embedded C# compilation, argument
quoting and both receipt schemas. The pairing mutant that accepts one receipt
must fail both missing-half tests. MAIN still owns Windows execution and acceptance.


The sampler now requests an owned visible console at the start and end of every
group. The independent EnumWindows callback must see its exact window handle;
only that control handle is excluded from unexpected-console observations. Each
group records its time range, every control records detection, and Stop measures
the gap since the final callback. Receipt validation rejects missing controls,
stopped-too-early observation, or any gap over 1000 ms. Helper compilation follows
fixture TEMP/TMP setup (and the complete profile environment on Desktop).

Each tested Sentinel run must publish `lastCheckedAt` newer than both its run
start and the preceding publication. Manual open/closed runs and both recurring
runs retain separate publication artifacts. Scheduler exit 0 alone cannot pass.
The MCP group includes the fake Claude -> console Node MCP -> cmd.exe chain and
checks inherited hide-preload evidence. Desktop browser rows exercise `.bat`,
`.exe`, `javascript:` and `file:` refusals only. The fulfilled loopback HTTPS
ShellExecute dispatch runs only in Handoff on gate-win-nogit, where the browser
may outlive the run and is recorded. Desktop commands never select that row.

The path guard checks every existing ancestor up to the volume root for
ReparsePoint before staging or driver admission, and requires resolved input and
evidence paths inside `C:\murage-ci`. The Linux container exercises a real symlink
under `runs`, which presents the same ReparsePoint attribute to PowerShell.
**A real Windows junction test has not run**; it remains MAIN's Windows acceptance
work during the gate session. Container results are not a Windows
workflow receipt.

Exact container commands and counts are maintained in
`scripts/windows/evidence/cfix4-status.md`. The six prior MAIN ownership mutants are
allow breakaway, delete an unprefixed task, dispatch HTTPS on Desktop, finalize
inside the child, preserve a running wrapper, and start/kill a native helper outside its job. Each must fail assertions. The earlier path, launcher-cleanup
and package-identity mutants remain required. Linux parsing, native compilation
and fixture behavior tests do not replace Windows workflow receipts.


The operator owns a separate named wrapper job before registering the interactive
task. The exact wrapper task name is persisted in `request.json` and retained in
memory. The wrapper joins the job before the prelaunch CIM enumeration. Cleanup
never waits for a snapshot to discover this name. The operator first requests Scheduler End (`Stop-ScheduledTask`), terminates that job and
proves it empty, unregisters the wrapper, then enumerates the root task folder to
prove absence. Job proof, unregister and readback retry at most five times within
a 60-second budget, including bounded Scheduler helpers. A persistent failure
writes `failure.json` and `result.txt` with the exact task path and a one-line
`Unregister-ScheduledTask` command; no successful workflow receipt is published.
Only after name-based removal does the operator run the prefix snapshot diff,
inside a separate child job with its own 60-second deadline. Child cleanup also
runs Scheduler and CIM work inside deadline-bound jobs. Enumeration hangs or
exceptions reach a `finally` failure report with the same exact removal command.
Retain `launcher-cleanup.json` and `launcher-jobs.json` alongside those reports.

Node admission, snapshot, relaunch, process-readback and cmd-chain helpers all
use `native-launcher.mjs`. It sends file requests to the existing PowerShell
parent; it never starts an unowned bootstrap executable. `native-broker.ps1`
passes each request to the same `owned-process.ps1` owner and returns the
result only with closed/empty/no-breakaway job proof. Evidence is retained in
`native-broker/native-jobs.jsonl`. The Node parent still reports its inherited
hide-preload state for the Claude cmd-chain row.

All launcher native commands use suspended creation with an atomic job-list
assignment, no breakaway, and a restricted stdio handle list. A command exceeding
its deadline terminates its own job and records empty-job proof. The Linux native
timeout fixture substitutes only the Win32 API boundary and exercises this C#
control flow; it is not an execution of Task Scheduler or Windows Job Objects.

The recursive `scan-native.mjs` scanner checks every `.ps1`, `.psm1`, `.mjs`,
`.js`, `.cjs`, `.cs`, `.cmd` and `.bat` under `scripts/windows`, including
test/check/mutate names. Only the exact paths of `owned-process.ps1` and
`native-launcher.mjs` are allowlisted. The fixture corpus must score 100%. Four
additional real source mutants must fail: enumeration before name removal,
cleanup without a deadline, Node helper termination, and lowercase taskkill in
a test-named file.

MAIN must obtain a confirm review PASS on the implementing commit before running
either Windows profile. Receipt commit identity remains the packaged provenance
commit, checked against the operator request and the paired receipt.


## Retained int19l desktop and package guards

The shared scenario sources its literal sibling
`scripts/windows/windows-hide-gate-checks.ps1`; keep it with the Windows scripts.
The original `scripts/windows-hide-gate-checks.ps1` path forwards to that helper. Before any
app launch, it checks the active console session, thread and input desktop
(`Default`), and window station (`WinSta0`). The independent sampler repeats
the desktop identity check on every tick. Owned visible positive controls are
observed by that sampler and must close before their verification completes.

Both scenario halves verify `resources/windows-hide-package-manifest.json`
against the embedded `resources/ui/build-commit.json`, the requested commit,
and the exact inventory/hashes of the executable, app archive, and external
JavaScript/TypeScript resources. The normal Windows afterSign hook produces
this manifest. Exact verified bytes are retained as `package-manifest.json`,
and verification repeats after the scenario as `package-manifest-after.json`.
The scenario fails if the manifest changes. These checks supplement the split
gate's packaged provenance, complete app manifest, and outer cleanup receipts.
`windows.json` records desktop identity, positive-control verification, and
package-manifest identity. Linux parsing and C# compilation do not replace
real interactive Windows verification.
