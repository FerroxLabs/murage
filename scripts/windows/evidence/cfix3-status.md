Implementation complete; MAIN confirm review required before Windows execution.

Job cfix3-winscen, branch dev/1019-winscen. Starting HEAD and shared hub branch both verified as 338925a9d66bc4b9c5f1122160ff3bc9de3b612b. Implements crev2-winscen/last.txt and binding p11b with p11 and the earlier rulings. The memory prelude tool and .ijfw/memory were unavailable.

1. Wrapper cleanup: RED -> GREEN. One initial structural failure and the missing cleanup behavior were recorded before implementation. Exact reviewer witness: TimeoutSeconds=60 with prelaunch CIM still blocked at t=151 seconds. The wrapper joins an operator-owned Global job before enumeration. Cleanup requests Scheduler End, terminates/proves the job empty, unregisters, then reads back absence. Up to five attempts share a 60-second budget; Scheduler operations run in separately owned jobs with bounded execution/proof time. Persistent failure names the task path and removal command in failure.json/result.txt and prevents successful receipt publication. Preexisting and unprefixed tasks remain protected. Final coverage: one structural check plus 11 PowerShell assertions using virtual time and injected Scheduler callbacks.

2. Native ownership: RED -> GREEN. Two initial structural failures cover schtasks exceeding 30 seconds and Process.Kill. Launcher natives now use CREATE_SUSPENDED with PROC_THREAD_ATTRIBUTE_JOB_LIST, no breakaway, restricted inherited stdio and immediate stdin EOF. Timeout calls TerminateJobObject and proves the audit job empty after owner close. Atomic assignment removes the former TerminateProcess fallback. Final coverage: two structural checks, two PowerShell assertions and two assertions executing the actual C# timeout path against a Linux Win32 API double (11 ordered events). This is not Windows Job Object execution.

3. Mutants: RED -> GREEN. Initial completeness check failed. Completed harness passes, and 6/6 MAIN mutants go RED on assertions: allow-breakaway, delete-unprefixed-task, desktop-https-dispatch, finalize-inside-child, preserve-running-wrapper, native-outside-job. Four earlier safety mutants also go RED. Production files are restored after each mutation.

Final verification: 122/122 Node tests; 52 PowerShell/native-boundary assertions (13 p11b, 16 ownership, 8 finalizer, 7 admission policy, 6 safety, 2 actual C# with fake native boundary); 29 PowerShell parses; 35 schema cases; four quoting cases; four embedded C# helpers compile. TypeScript server build and bundle succeeded. Initial RED evidence: cfix3-red.log (0/4 passing structural checks), cfix3-ps-red.log. Final evidence: cfix3-tests.log, cfix3-p11b.log, cfix3-native-timeout.log, cfix3-dry.log, cfix3-ownership.log, cfix3-finalizer.log, cfix3-admission-policy.log, cfix3-safety.log, cfix3-mutants.log and cfix3-prior-mutants.log.

One approved container at a time; observed host load stayed below 85. No Windows PC/SSH, credentials, provider calls, billable resources, vtq, global Git configuration changes or live-app mutations. Generated dependencies, dist-server, downloaded PowerShell and shim binaries are removed locally and from this job's Linux test copies; source fixtures and evidence remain. Containers use --rm. Cleanup inventory: cfix3-cleanup.log.

Retain launcher-cleanup.json and launcher-jobs.json on Windows, including native job proofs. Receipt identity remains bound to packaged provenance, operator request, paired receipt, ZIP digest and full staged manifest. MAIN must obtain confirm review PASS on this commit before either profile runs. Real Windows Scheduler, Job Objects, junctions, EnumWindows and packaged workflow acceptance remain MAIN's work.

Reproduce with PowerShell 7.4.2 linux-x64 from the official GitHub release extracted to .test-tmp/cfix3-winscen/pwsh (archive digest in cfix3-toolchain.sha256). Run through:

```sh
IT_JOB=cfix3-winscen IT_W=/work/build/winscen/wt IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh /work/fuigo-builds/tools/it-remote.sh '<commands below>'
```

Container commands:

```sh
node /nm/typescript/bin/tsc -p tsconfig.server.build.json
node scripts/bundle-server.mjs
node --test scripts/windows/*.node-test.mjs electron/updater-restart.node-test.mjs electron/sentinel-schedule.node-test.mjs
for check in p11b dry ownership finalizer admission-policy safety; do
  .test-tmp/cfix3-winscen/pwsh/pwsh -NoProfile -File "scripts/windows/$check-check.ps1"
done
gcc -shared -fPIC scripts/windows/native-timeout-fixture.c -o .test-tmp/cfix3-winscen/native-timeout.so
WINSCEN_NATIVE_SHIM=/work/.test-tmp/cfix3-winscen/native-timeout.so WINSCEN_NATIVE_TRACE=/work/.test-tmp/cfix3-winscen/native-trace.txt .test-tmp/cfix3-winscen/pwsh/pwsh -NoProfile -File scripts/windows/native-timeout-check.ps1
node scripts/windows/mutate-ownership.mjs
node scripts/windows/mutate-safety.mjs
```
