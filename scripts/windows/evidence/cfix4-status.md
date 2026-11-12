Implementation complete; MAIN confirm review required before either Windows profile.

Job cfix4-winscen, branch dev/1019-winscen. Starting worktree HEAD and bare-hub branch both verified as 76d3162a81d79f341209bc71f3e61444bdaaef0a. Binding input: crev3-winscen/last.txt and RULING-winscen-p11c-MAIN.md, over p11b/p11. The memory prelude tool and .ijfw/memory were unavailable.

1. Cleanup: 3 RED -> 18 GREEN checks. The initial structural assertion and both exact behavioral witnesses failed: TimeoutSeconds=60, prelaunch CIM still blocked at virtual t=151, then Scheduler enumeration hanging, and separately throwing. The RED behavioral test executes the original cleanup core with injected Scheduler boundaries, not a rewritten model. The wrapper name is fixed in memory and request.json. The new coordinator removes it first (End -> job empty -> unregister -> absence readback, five attempts within 60 seconds), then runs the prefix diff in a separate owned child with a 60-second deadline. All cleanup Scheduler/CIM operations are inside deadline-bound jobs. Its finally block writes failure.json/result.txt with the exact task and removal command, including when an earlier launcher error is followed by successful cleanup. The pre-registration worker starts only after fixture environment setup. GREEN coverage: one structural check, 12 witness/success/failure-publication assertions across both witness runs, five deadline-boundary assertions. The 11 existing wrapper assertions also remain green. Sources: cfix4-red.log, cfix4-ps-red.log, cfix4-ps-throw-red.log, cfix4-tests.log, cfix4-p11c.log, cfix4-p11c-throw.log, cfix4-p11c-deadline.log, cfix4-p11b.log.

2. Native ownership: 2 RED -> 14 GREEN checks. The original Desktop snapshot helper's 300-second timer actually invoked the fake child.kill boundary (RED); its structural check failed too. Native admission, snapshot, relaunch, process-readback and cmd-chain helpers now use one Node launcher which exchanges file requests with the already-owned PowerShell parent. There is no unowned bootstrap exe. The broker uses the existing suspended atomic job-list creation, no breakaway, restricted handles, TerminateJobObject and empty proof. Responses require closed/empty/no-breakaway proof; native-jobs.jsonl preserves it. Linux-only test subprocess entry points are confined to the same Node module and explicitly refuse Windows. GREEN coverage: one structural check, eight Node behavior tests, five real broker/C# tests with a Linux Win32 boundary double. The exact >300-second snapshot witness records 11 ordered native events and leaves the unrelated fake PID untouched. Existing schtasks >30-second checks still pass. One initial native-double run aborted because a variable set inside PowerShell did not reach libc getenv; supplying it in the container command corrected the fixture setup, without changing production behavior or expectations. Sources: cfix4-reviewer-red.log, cfix4-tests.log, cfix4-p11c-native.log, cfix4-native-timeout.log.

3. Scanner: 5 RED -> 3 GREEN checks; fixture hit rate 27/27 (100%). The original checker missed lowercase JS termination, lowercase taskkill.exe /PID ... /F in a test-named file, and Invoke-CimMethod -InputObject $process -MethodName Terminate. Two completeness checks also failed before implementation. The new scanner traverses all scripts/windows recursively, all eight required extensions, including test/check/mutate names. Only the two exact production owner paths are allowlisted; identical basenames elsewhere are tested and refused. JavaScript calls and process API imports are parsed; PowerShell, embedded C#, CMD/BAT termination/launch forms are scanned case-insensitively. The fixture corpus contains every required form, including bracketed PowerShell Process.Start and aliased JS imports. Final complete-tree scan: zero violations. Sources: cfix4-reviewer-red.log, cfix4-tests.log, cfix4-scanner.log, native-scanner-fixtures.json.

4. Mutants: 1 RED completeness check -> 1 GREEN; 4/4 new real source mutants fail assertions, plus 6/6 prior ownership and 4/4 prior safety mutants. New mutants: enumeration-before-removal, cleanup-without-deadline, node-native-kill, taskkill-in-test. Every mutation is installed in actual source, an assertion failure is required, and originals are restored in finally. The unchanged source tree passes its scanner afterwards. Sources: cfix4-mutants.log, cfix4-ownership-mutants.log, cfix4-prior-mutants.log and individual mutant logs.

Final validation: 136/136 Node tests; 74 PowerShell/native-boundary assertions (13 p11b, 16 ownership, 8 finalizer, 7 admission policy, 6 safety, 2 native schtasks, 12 cleanup witnesses/success paths, 5 cleanup deadline, 5 native snapshot/broker). 34 PowerShell files parse; 35 receipt schema cases, four quoting cases, and four embedded C# helpers compile. Server TypeScript build and bundle succeed. Test source digests are in cfix4-sources.sha256. All execution used the requested it-remote.sh route, one Linux container at a time. No Windows execution, live-app mutation, credentials, provider calls, billable resources, vtq, global Git configuration changes or weakened Desktop NEVER requirements.

Expectation changes are cited in /work/build/cfix4-winscen/CHANGED-EXPECTATIONS.md, with a committed copy in cfix4-changed-expectations.md. The Desktop installer refusal, handoff-only HTTPS dispatch, isolated profile, staged-package identity, protected preexisting/unprefixed tasks and outer-only provenance-bound receipts remain required. The cmd-chain's existing inherited preload/output assertions remain, while native execution now uses the required common owner.

The initial executable reviewer-witness source is preserved as cfix4-reviewer-red-witness.txt (data, not a gate script). To reproduce RED, use an isolated checkout of starting HEAD, save that text as an .mjs outside scripts/windows and run it with node --test in the authorized Linux container. The p11c-check.ps1 fallback also executes the original cleanup core on that checkout. No Windows Scheduler, actual Job Object, or packaged workflow acceptance is claimed. MAIN needs confirm PASS on the implementing commit before either profile.

Reproduction (PowerShell 7.4.2 linux-x64 archive digest: cfix4-toolchain.sha256; extract to .test-tmp/cfix4-winscen/pwsh):

```sh
IT_JOB=cfix4-winscen IT_W=/work/build/winscen/wt IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh /work/fuigo-builds/tools/it-remote.sh '<commands below>'
```

Container commands:

```sh
node /nm/typescript/bin/tsc -p tsconfig.server.build.json
node scripts/bundle-server.mjs
node --test scripts/windows/*.node-test.mjs electron/updater-restart.node-test.mjs electron/sentinel-schedule.node-test.mjs
for check in p11c p11c-deadline p11b dry ownership finalizer admission-policy safety; do
  .test-tmp/cfix4-winscen/pwsh/pwsh -NoProfile -File "scripts/windows/$check-check.ps1"
done
.test-tmp/cfix4-winscen/pwsh/pwsh -NoProfile -File scripts/windows/p11c-check.ps1 -Witness throw
gcc -shared -fPIC scripts/windows/native-timeout-fixture.c -o .test-tmp/cfix4-winscen/native-timeout.so
WINSCEN_NATIVE_SHIM=/work/.test-tmp/cfix4-winscen/native-timeout.so WINSCEN_NATIVE_TRACE=/work/.test-tmp/cfix4-winscen/native-trace.txt .test-tmp/cfix4-winscen/pwsh/pwsh -NoProfile -File scripts/windows/native-timeout-check.ps1
WINSCEN_NATIVE_WAIT_MS=300000 WINSCEN_NATIVE_SHIM=/work/.test-tmp/cfix4-winscen/native-timeout.so WINSCEN_NATIVE_TRACE=/work/.test-tmp/cfix4-winscen/native-trace.txt .test-tmp/cfix4-winscen/pwsh/pwsh -NoProfile -File scripts/windows/p11c-native-check.ps1
node scripts/windows/mutate-p11c.mjs
node scripts/windows/mutate-ownership.mjs
node scripts/windows/mutate-safety.mjs
node scripts/windows/scan-native.mjs
```

Cleanup inventory is in cfix4-cleanup.log. Generated dependencies, dist-server, downloaded PowerShell and compiled fake-native binaries are removed locally and from this job's remote test copies; source fixtures and evidence remain. Containers used --rm.
