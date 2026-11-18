Implementation/pack/contracts producer owner: win-sac-sign; protected deployment, enrollment, execution and private archive consumer owner: MAIN.
Signing identity/publication approval owner: secure administration with Sean; SAC/S4 evidence acceptance owner: GrokBuild; release HOLD owner: Sean.

# Windows signing and SAC runbook

**PARTIAL — release HOLD.** This is the single execution runbook for the Windows
build workstation and the existing bare-metal standard-account witness host.
Use the workstation checkout at `D:\murage-ci`. The witness host remains witness/SAC
only; signing and fresh-image extraction stay on separately admitted boundaries.
The private handoff maps the two host roles to their existing machines. No host,
account, credential, key, endpoint, allow rule or lifetime extension is created here.

The common signer covers engine-exclusion, anchored-read, presence-guard, nested
addons and every discovered shipped PE. D2(1) admits exactly the reviewed literal `1.0.19`, including the collector identity codec.
The shared release verifier, pack runner and codec fixtures use the same literal;
both relabel directions and a matched 1.0.20 pair remain refused.

Current status: the shared case runner has explicit schedules for all 21 cases,
with registration before actions, operation binding, exclusive faults, measured
captures, independent absence checks, and exclusive result publication after a
durable flush. Workflow collection has a separate read-only measurement interface.
Portable doubles live only in `Adapters.selfcheck.cs`, excluded by the production
project along with all fixtures. They establish orchestration, not native proof.

**Production is incomplete.** The CLI validates its mode and exact seam table,
then the explicitly unenrolled R-COL(6)/D2(7) production authenticator refuses.
The protected operation-side implementation of `ICaseOperations` and
`IAssetsMeasurements` is not supplied by the existing SYSTEM service. No generic
command verb is added to that service. The CLI therefore cannot yet construct a
production CaseRunner session or produce the workflow handoff. This implementation
dependency must be resolved before calling the collector builder-complete; a
reserved seam alone does not excuse a missing production operation binding.

D2 names `sac-interval-v1`, `s4-own-token-dacl-v1`, and
`evidence-manifest-pin-v1`. SAC evaluation and all four closed CI observation
verbs are implemented. The collector never reads SAC registry state, runs CiTool,
or subscribes to the log. MAIN's SYSTEM observer must supply those verbs. S4 has
a native suspended-process/token-DACL adapter and requires distinct token IDs,
installed path/hash equality, a true standard caller, and the native failure
marker. It arms a kill-on-close job before creation and passes JOB_LIST to
CreateProcess so containment is atomic with creation, including the gap before
PID registration. Native termination uses the remaining original case deadline.
Its disposable probe is OS feasibility only. Slice 6 remains blocked until
the required failure is demonstrated on signed installed candidate bytes.

## 1. MAIN's protected inputs and stop conditions

Resolve QUESTIONS-FOR-MAIN.md first for execution. In particular, the approved
qualification-only signing path; existing identity/policy and distinct controller
keys; separate observation authentication/custody; accepted Windows-build SAC
adapter; demonstrated signed-candidate own-token S4 failure mechanism; existing
extractor recipe/scopes/reaper authority; disposable promotion target; and host
expiry remain required. Builder B owns collector orchestration and adapter code; MAIN must resolve the
protected operation-side contract and supply deployment acceptance and custody.

GrokBuild must accept the amended plan and adapters. Keep all 21 cases, every
variant, 20 minutes per case including cleanup, and 128 MiB per capture. Unknown
SAC, lost interval records, rollover loss, reboot or observer death fails. A
cleanup retry cannot turn an incomplete run into PASS. Do not proceed unless
independent cleanup and private archive can finish before the existing tag expiry.

Open MAIN's independently measured PowerShell 7 with `-NoProfile`. Before each
command block MAIN supplies these variables from its existing protected records;
none is learned from downloaded candidate manifests:

| Variable | Required independently selected value |
| --- | --- |
| `$PinnedPwsh`, `$MainPwshSha256` | Absolute measured PowerShell 7 executable and final-byte SHA256 |
| `$PinnedNode`, `$MainNodeSha256` | Absolute sealed Node executable and final-byte SHA256 |
| `$PinnedGit`, `$MainGitSha256`, `$MainSourceRevision` | Measured Git and exact reviewed collector-source revision |
| `$PinnedDotnet`, `$MainDotnetSha256`, `$MainSdkVersion` | Sealed Windows .NET 10 host and exact `10.0.N` SDK |
| `$Intermediate` | Reviewed restore/intermediate tree outside the checkout, containing project.assets.json; no online restore |
| `$PackageRoot` | The restored NuGet package folder restore filled (the one project.assets.json records), outside the checkout; mandatory for Build.ps1 and Enroll.ps1 |
| `$InstalledCollector`, `$MainCollectorSha256` | Protected final signed collector and independently approved signed-byte hash |
| `$MainTemplate`, `$MainTemplateSha256` | Private, exact-shape public-reference enrollment template and independent hash |
| `$Enrollment`, `$MainEnrollmentSha256` | Protected frozen enrollment and independent hash |
| `$Pack`, `$MainPackManifestSha256` | Sealed external WITNESS-PACK directory and independently supplied PACK-SHA256.txt hash |

Do not run any command with an unset variable. Do not put signing credentials,
raw OIDC tokens, capabilities, secret values or reusable secret hashes in this
shell, enrollment, captures or console. Existing secure administration retains
credentials. The complete SDK/compiler/package/tool trees need independent
measurement and sealing; pinning dotnet.exe alone is insufficient.

Choose ONE role's paths below. These are new private evidence directories outside
the checkout; an existing output is an error, not permission to overwrite it.
MAIN transfers the reviewed source/pack to these locations through its existing
admitted channel before using this runbook.

```powershell
# Build workstation, source already checked out here:
$Checkout = 'D:\murage-ci\source'
$Evidence = 'D:\murage-ci\evidence-win-sac-sign'
```

```powershell
# Existing bare-metal witness host, source already transferred here:
$Checkout = 'C:\Witness\checkout'
$Evidence = 'C:\Witness\evidence-r'
```

On either host, validate pins before invoking tools. All digests below are public
references selected outside the candidate, never credentials:

```powershell
$ErrorActionPreference = 'Stop'
foreach ($pin in @(@($PinnedPwsh, $MainPwshSha256), @($PinnedNode, $MainNodeSha256), @($PinnedGit, $MainGitSha256))) {
    if (-not [IO.Path]::IsPathFullyQualified($pin[0]) -or $pin[1] -cnotmatch '\A[a-f0-9]{64}\z' -or
        (Get-FileHash -LiteralPath $pin[0] -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin[1]) { throw 'Independent tool pin mismatch' }
}
$revision = & $PinnedGit -C $Checkout rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $revision -cne $MainSourceRevision) { throw 'Reviewed source revision required' }
if (Test-Path -LiteralPath $Evidence) { throw 'New private evidence directory required' }
$null = New-Item -ItemType Directory -Path $Evidence
```

## 2. Portable checks on BOTH Windows hosts

These checks compile C# in PowerShell for verification only; they neither publish
NativeAOT nor enroll/deploy/sign the resulting assembly. Run with no credentials:

```powershell
& $PinnedPwsh -NoProfile -NonInteractive -File "$Checkout\infra\windows-signing\collector\Collector.selfcheck.ps1"
if ($LASTEXITCODE -ne 0) { throw 'Collector checks failed' }
& $PinnedPwsh -NoProfile -NonInteractive -File "$Checkout\scripts\windows-signing-witness\Launcher.selfcheck.ps1"
if ($LASTEXITCODE -ne 0) { throw 'Launcher checks failed' }
& $PinnedPwsh -NoProfile -NonInteractive -File "$Checkout\infra\windows-signing\collector\Collector.mutants.ps1" -Output "$Evidence\portable-mutants"
if ($LASTEXITCODE -ne 0) { throw 'Portable mutant survived or was invalid' }
& $PinnedNode --test "$Checkout\scripts\windows-signing-witness\verify.node-test.mjs"
if ($LASTEXITCODE -ne 0) { throw 'Pack verifier checks failed' }
```

Expected: each existing check passes with no skipped or weakened test. The
adapter suite is run separately below; its counters describe portable assertions,
not Windows witness acceptance. Mutation compilation errors do not count as kills.

```powershell
& $PinnedPwsh -NoProfile -NonInteractive -File "$Checkout\infra\windows-signing\collector\adapters\Adapters.mutants.ps1" -Selfcheck -Output "$Evidence\adapter-checks"
if ($LASTEXITCODE -ne 0) { throw 'Adapter selfcheck failed' }
& $PinnedPwsh -NoProfile -NonInteractive -File "$Checkout\infra\windows-signing\collector\adapters\Adapters.mutants.ps1" -Output "$Evidence\adapter-mutants"
if ($LASTEXITCODE -ne 0) { throw 'Adapter mutant survived or failed to compile' }
```

The adapter checks cover the exact 21-case seam table, every schedule end to end
with doubles, M-B1 through M-B13 and D2 negatives. Their production compile-list
check verifies that test doubles and fixtures cannot enter the NativeAOT project.
The root codec/pack fixtures still requiring 1.0.20 must receive the D2(1) update
from their assigned owner. Do not skip that failure or treat it as GREEN.

## 3. Native API checks on BOTH Windows hosts

Use the existing standard account on the witness host. Do not elevate it or change
its groups. This check creates only its own disposable files/junction and one
credential-free PowerShell child, records its exact PID/creation FILETIME,
rejects a mismatched incarnation, terminates only that child and checks absence.
It exercises held-file replacement, ancestor movement, hardlinks and junctions,
exclusive capture creation and idempotent process recovery. Finally it removes
its exact private scratch. These checks do not qualify SAC or signed app behavior.

```powershell
& $PinnedPwsh -NoProfile -NonInteractive -File "$Checkout\infra\windows-signing\collector\Native.selfcheck.ps1" -OutputParent $Evidence
if ($LASTEXITCODE -ne 0) { throw 'Native adapter check failed; retain private diagnostics' }
& $PinnedPwsh -NoProfile -NonInteractive -File "$Checkout\infra\windows-signing\collector\Collector.mutants.ps1" -Native -Output "$Evidence\native-mutants"
if ($LASTEXITCODE -ne 0) { throw 'Native mutant survived or was invalid' }
```

Expected after the portable assertion lines: `WINDOWS_WITNESS_NATIVE_ADAPTER_CHECKS
13 RELEASE_HOLD`; for mutation execution, five `killed=True` lines followed by
`WINDOWS_WITNESS_MUTANTS_KILLED 5 RELEASE_HOLD`, all exit 0. **These commands have
not been run on Windows by this lane.** Archive failures; do not retry around,
raise deadlines or omit a failing variant.

### Adapter native check on the non-SAC standard-account workstation only

Use a source checkout at `D:\murage-ci\source`, with evidence and the disposable
probe in sibling directories under `D:\murage-ci`. This satisfies both the
workspace-only write rule and the evidence-outside-checkout rule. MAIN builds
`adapters/fixtures/s4-feasibility.c` with its already pinned native toolchain and
supplies independently selected `$ProbeExe` and `$ProbeSha256`. No candidate is
patched, no privilege is granted, and no power action occurs.

The existing protected SYSTEM observer must already implement D2's closed CI
verbs. `$ObserverPath`, `$ObserverSha256`, and `$CiToolSha256` come from protected
configuration. A user-mode test pipe cannot establish authoritative SAC state.

```powershell
& $PinnedPwsh -NoProfile -NonInteractive -File "$Checkout\infra\windows-signing\collector\adapters\Adapters.native.ps1" -Output "$Evidence\adapter-native" -ObserverPath $ObserverPath -ObserverSha256 $ObserverSha256 -CiToolSha256 $CiToolSha256 -ProbeExe $ProbeExe -ProbeSha256 $ProbeSha256
if ($LASTEXITCODE -ne 0) { throw 'Retain native failure; do not retry around it' }
```

Expected: a measured standard own-process token, a SAC state 0/2 negative witness,
and either a demonstrated own-token denial on the disposable probe or a recorded
feasibility failure before token mutation. A failure is RED, never slice-6
acceptance. This lane has not executed the Beast checks; native evidence is still
required. Nothing runs on the SAC proof host under this section.

## 4. MAIN + Sean: NativeAOT publication and separate signing

Only on the already admitted Windows build/signing boundary, using its sealed SDK,
native compiler and offline restored package tree. A build workstation is not
signing admission merely because section 2 passed. No restore/download/signing
command is supplied or authorized by this lane.

```powershell
& $PinnedPwsh -NoProfile -NonInteractive -File "$Checkout\infra\windows-signing\collector\Build.ps1" -Dotnet $PinnedDotnet -DotnetSha256 $MainDotnetSha256 -SdkVersion $MainSdkVersion -Intermediate $Intermediate -PackageRoot $PackageRoot -Output "$Evidence\native-publication"
if ($LASTEXITCODE -ne 0) { throw 'NativeAOT publication failed' }
```

Expected: `WINDOWS_WITNESS_NATIVE_CORE_BUILT RELEASE_HOLD; secure administration
must approve/sign final bytes separately`, exit 0, and
`$Evidence\native-publication\witness-collector.exe`. Review/sign only through the
existing approved qualification path under MAIN/Sean/secure administration. This
runbook never signs. Re-measure final signed bytes, verify native trust, seal the
entire collector/observer/checker/runner/tool deployment and verify tampered-tree
refusal. Until the adapters, authentication and independent supervisor are complete,
retain publication as build evidence only; do not enroll it for measurement.

## 5. Freeze public references AFTER admitted candidate production

After the blockers are resolved, produce/authenticate the exact 1.0.19 candidate,
build receipts and evidence before freeze, with their own run id/attempt. Fill
`enrollment.example.json` privately with independent public pins, not secrets or
new authority. A locked-build witness subsequently rebuilds frozen inputs into its
own pre-registered output/operation nonce; it never changes baseline descriptors.

```powershell
& $PinnedPwsh -NoProfile -NonInteractive -File "$Checkout\infra\windows-signing\collector\Enroll.ps1" -Collector $InstalledCollector -CollectorSha256 $MainCollectorSha256 -Template $MainTemplate -TemplateSha256 $MainTemplateSha256 -PackageRoot $PackageRoot -Destination "$Evidence\frozen-enrollment.json"
if ($LASTEXITCODE -ne 0) { throw 'Public-reference freeze failed' }
```

Expected: `WINDOWS_WITNESS_PUBLIC_REFERENCES_VALID RELEASE_HOLD` and
`WINDOWS_WITNESS_PUBLIC_ENROLLMENT_FROZEN RELEASE_HOLD; protected installation and
independent pin selection remain MAIN duties`, exit 0. This validates references;
it does not authenticate observations or authorize a run.

MAIN installs the exact frozen bytes/digest as
`C:\Program Files\MurageSigning\controller\witness-enrollment.json` and
`witness-enrollment.json.sha256`, owned/writable only by SYSTEM/Administrators,
with protected ancestors. Preserve the independently selected external digest.
Install service/observer/runner admission separately from the standard session.
Before faults, register the independent supervisor, expiry, exclusivity and exact
PID/creation-time ownership; record pre-existing service/groups/tasks/SAC/tool state.
No box tag, account groups, SAC policy, identity or pre-existing task changes.

## 6. Full 21-case witness on the bare-metal host ONLY

**Blocked in this revision.** This section becomes executable only with completed,
reviewed, enrolled adapters and the independent reaper. MAIN checks the complete
plan/admission, host expiry, real isolated app home and already-configured real
engine first. Signing/extraction actions are delegated to their separately admitted
boundaries; they never execute those roles locally on the witness box.

Stage the sealed pack outside candidate roots. Verify PACK-SHA256.txt against
`$MainPackManifestSha256`, then every file it names, rejecting missing/extra files,
links and reparse ancestors. The pack source is
`$Checkout\scripts\windows-signing-witness`; transfer includes the launcher check.
Record the source revision separately from the candidate's source revision.

From the unchanged standard account, outside CI, with `$Enrollment` pointing at the
same protected frozen enrollment and `$Pack` at the sealed external pack:

```powershell
$Capture = Join-Path $Evidence 'captures'
& $PinnedPwsh -NoProfile -NonInteractive -File "$Pack\Run.ps1" -Node $PinnedNode -NodeSha256 $MainNodeSha256 -Enrollment $Enrollment -EnrollmentSha256 $MainEnrollmentSha256 -Output $Capture
if ($LASTEXITCODE -ne 0) { throw 'Witness failed; retain captures and use section 7' }
& $PinnedPwsh -NoProfile -NonInteractive -File "$Pack\Run.ps1" -Mode verify -Node $PinnedNode -NodeSha256 $MainNodeSha256 -Enrollment $Enrollment -EnrollmentSha256 $MainEnrollmentSha256 -Output $Capture
if ($LASTEXITCODE -ne 0) { throw 'Complete capture verification failed' }
```

Success requires these twenty action lines plus the twenty-first cleanup result
in the verified summary (cleanup has no separate PASS console line):

```text
PASS preflight
PASS presecret-both-workflows
PASS acquisition
PASS service-admission
PASS sealed-tree-races
PASS native-launch-network
PASS locked-build
PASS crash-receipt-write
PASS crash-assignment
PASS crash-pipe-disconnect
PASS crash-bootstrap-death
PASS crash-driver-death
PASS crash-service-death
PASS crash-controller-death
PASS authenticode
PASS installed-coverage
PASS extraction-contract
PASS vm-cleanup
PASS sac-real-turn-s4
PASS promotion-both-entries
WINDOWS_WITNESS_PASS RELEASE_HOLD
```

Independent verify prints `WINDOWS_WITNESS_PASS RELEASE_HOLD`, exit 0, after
rehashing every result/capture and checking all 21 cases. summary.json alone is
not verification. Require every variant and independent absence of every created
resource. vm-cleanup includes success, install failure, collection error, timeout,
cancellation and controller death, each on a fresh OS disk. S4 uses distinct fresh
success/failure processes and the signed installed failure process's own
OpenProcessToken request (`requestedAccess: 40`), EPOWER and zero engine/job start;
a side token, fake engine, test addon or declared expectation does not count.

## 7. Recovery, independent closure and private archive

After any failure/interruption use the SAME enrollment/digest and original
capture path. The independent supervisor remains authoritative if any runner,
collector, service or controller dies. It must restore prior service state and
independently confirm lease/capability/job/process/task/VM/disk/NIC closure.

```powershell
& $PinnedPwsh -NoProfile -NonInteractive -File "$Pack\Run.ps1" -Mode cleanup -Node $PinnedNode -NodeSha256 $MainNodeSha256 -Enrollment $Enrollment -EnrollmentSha256 $MainEnrollmentSha256 -Output $Capture
if ($LASTEXITCODE -ne 0) { throw 'Independent cleanup confirmation required' }
```

Completed collector expected output: `WINDOWS_WITNESS_CLEANUP_PASS RELEASE_HOLD`,
exit 0. A fresh cleanup-retry subdirectory preserves the failed run. The current
incomplete collector refuses; never treat that refusal as cleanup confirmation.

For journal recovery, the privileged independent operator can use
this restricted command AFTER MAIN has admitted/protected the exact journal at
`C:\Program Files\MurageSigning\controller\runs\<runNonce>\resources.jsonl`:

```powershell
& $InstalledCollector --reap-run $RunNonce
if ($LASTEXITCODE -ne 0) { throw 'Recovery incomplete; use admitted independent reapers' }
```

`$RunNonce` is the original run.json nonce, not a new value. `--reap-run` and
`--supervise` route to Builder A's recovery entry and reaper registry. Unknown or
unenrolled resource classes, uncertain incarnations, or incomplete independent
absence checks fail closed. Verify the complete registry and native checks on
Builder A's final revision before relying on it. The standard witness account
cannot invoke its privileged journal path; do not elevate that account to do so.

MAIN then authenticates actual observations and exact candidate/output/evidence
through their distinct existing authorities, runs qualification and BOTH fresh
extraction stage/publish-prepared gates against the admitted disposable target,
and all normal release gates. Require zero production visibility changes.
Compare authority, identity, groups, SAC policy, tasks, services and tool trees to
baseline. Archive private captures plus independent cleanup/retention inventory
outside Git before expiry; remove only this run's exact scratch/transfer resources.
GrokBuild later accepts/rejects the complete evidence. Sean releases HOLD separately.

Unchecked by this lane: native Windows checks/mutants, NativeAOT publication,
signing/deployment, all 21 real cases, SAC/real-engine/S4 and independent cloud
cleanup. Risk: missing production operation binding and native evidence still block execution;
portable green results cannot qualify the release.

## Native script diagnostic inventory

`collector/adapters/Adapters.native.ps1` emits operator diagnostics only; these
strings are not application UI copy. Its failures are: "Native witnesses require
the admitted Windows standard-account host"; "User-scope native paths must stay
under the admitted workspace"; "New evidence directory outside checkout required";
"Independent native pins required"; "Native probe must run under the unchanged
true standard account"; "Beast negative SAC witness expected state 0 or 2";
"S4 feasibility RED: child primary token is shared; no DACL was changed";
"Native feasibility process failed or exceeded the existing deadline"; and
"S4 own-token native failure marker absent". Its evidence labels are
`TOKEN_CURRENT_STANDARD`, `ADMINISTRATORS_SID`, `SHUTDOWN_LUIDS_ABSENT`,
`SAC_EXPECTED_RED`, `NOT_ACCEPTANCE`, `S4_OWN_TOKEN_DACL_FEASIBLE`,
`OS_FEASIBILITY_ONLY`, `NOT_SLICE6`, and `RELEASE_HOLD`.
