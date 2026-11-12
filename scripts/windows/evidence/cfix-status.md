IMPLEMENTED P1-1 — both profiles admitted by the operator launcher; confirm review and Windows execution remain MAIN's work.

Job: cfix2-winscen. Base and shared hub ref verified as 0733fe78ca7f9709138ff44eefd740a36cf068d8 on dev/1019-winscen. Binding contract: RULING-winscen-p11-MAIN.md (2026-11-10 23:08Z). The referenced prior DONE was absent; prior cfix evidence remains in this directory.

1. Job ownership: RED -> GREEN, 1 initial requirement failure -> passing requirement check; native source compiles. Suspended child assigned to an audit parent and KILL_ON_JOB_CLOSE child job; no breakaway. Close owner handle, query distinct audit parent for zero processes. Admission verifies named-job membership. Sentinel's prefixed task uses a GUI bridge that joins that job before starting the unchanged packaged trampoline. New surviving interactive-session or caller-owned service-session processes are reported and never killed; no path/name-based relaunch kill remains. Windows native execution is untested here.
2. Task Scheduler: RED -> GREEN, 1 initial requirement failure -> passing requirement check and 9 cleanup behavior cases. Full path/name/author/action/definition snapshots before launch and before/after every group. Delete only newly added prefixed tasks, preserve pre-existing tasks even when prefixed, fail/report unprefixed additions, modifications, enumeration/deletion errors and leftovers. Child cleanup no longer deletes scheduler registrations.
3. Profile split: RED -> GREEN, 1 initial requirement failure -> passing requirement check plus 4 group-evidence cases. Desktop runs javascript/file/bat/executable refusal rows only. Loopback HTTPS dispatch is in Handoff only; its fulfilled dispatch and permitted default-browser survivor are recorded. No Desktop command selects HTTPS dispatch.
4. Installer registrations: RED -> GREEN, 1 initial requirement failure -> passing requirement check, 3 host/profile behavior checks plus shared snapshot-diff cases. Registry/ARP/protocol surfaces in both views and Desktop/Programs shortcuts are snapshot-diffed on gate-win-nogit only. Prefixed additions are cleaned; other additions/changes FAIL and are preserved. A normal installer that creates unprefixed Murage registrations will fail this policy; no bypass or unprefixed deletion is authorized.
5. Outer finalization: RED -> GREEN, 1 initial requirement failure -> passing requirement check, 8 finalizer cases and 16 cleanup-proof cases. Child emits assertions only. Scheduled outer task closes the scenario job and snapshots cleanup; operator waits for task exit, cleans wrapper from its baseline, then validates/pairs and publishes the receipt. Child-written receipts, failed cleanup, nonempty jobs, validator failures and pair failures cannot publish. Receipt includes cleanup diffs, job proof, process exceptions and writer/timing evidence.
6. Mutants: 4/4 RED — allow breakaway; delete an unprefixed task (actual PowerShell cleanup behavior); HTTPS dispatch on Desktop; finalize inside child. Earlier mutants also 4/4 RED — skip launcher cleanup, accept link ancestor, compare EXE only, bypass actual PowerShell ReparsePoint guard.

Verification: 118 Node tests pass; 25 targeted Node checks were rerun after the final process-audit change; 16 ownership behavior checks, 8 finalizer checks, 7 admission checks and 6 earlier safety checks pass. 27 PowerShell files parse, 35 schema cases pass and 4 C# helpers compile. Five initial requirement tests were RED before implementation (cfix2-red.log). Admission was enabled after items 1-5 and all four MAIN mutants passed their required checks. Native Windows behavior, real junctions, EnumWindows and packaged workflow receipts remain unverified in this builder job. A confirm review is still required; container results are not Windows acceptance.

One container at a time via it-remote.sh; observed host load below 85. No vtq, Windows PC/SSH, credential handling, external provider calls or billable resource creation. Generated dependencies/build outputs and downloaded test toolchain are removed after verification; retained logs are evidence only.

MAIN commands (run only in the PC/gate session after confirm review; use a newly built ZIP containing the code and packaged provenance):

```powershell
$verifiedZipSha256 = '<MAIN-VERIFIED-ZIP-SHA256>'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\murage-ci\source\scripts\windows\stage.ps1 -PackageZip C:\murage-ci\candidate.zip -Sha256 $verifiedZipSha256
$commit = (Get-Content C:\murage-ci\app\resources\build-provenance.json -Raw | ConvertFrom-Json).commit
```

Handoff on gate-win-nogit, with its existing gate-owned user setup. Includes HTTPS dispatch and installer registration snapshots:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\murage-ci\run-interactive.ps1 -Mode Handoff -PackageSha256 $verifiedZipSha256 -Commit $commit -InteractiveUser 'gate-win-nogit\murage-gate' -OutputDirectory C:\murage-ci\results\h1 -TimeoutSeconds 1800
```

Desktop after MAIN transfers the handoff receipt and evidence. Six Desktop groups; external-shell refusal rows only:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\murage-ci\run-interactive.ps1 -Mode Desktop -PackageSha256 $verifiedZipSha256 -Commit $commit -InteractiveUser ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -HandoffReceipt C:\murage-ci\handoff\scenario.json -OutputDirectory C:\murage-ci\results\d1 -TimeoutSeconds 1800
```

Retain each fixture's scenario.json and evidence directory, windows.json, operator output cleanup.json/baseline.json, wrapper task XML/result, and Desktop pair.json. Pair validation requires both receipts for the same packaged commit, ZIP digest, full staged file manifest and fixture installer digest.

Container reproduction (extract PowerShell 7.4.2 to .test-tmp/cfix2-winscen/pwsh first; archive digest in cfix2-toolchain.sha256). Initial preparation used `node /nm/typescript/bin/tsc -p tsconfig.server.build.json && node scripts/bundle-server.mjs` inside the same approved runner. The existing Sentinel suite needs the bundled server boundary.

```sh
IT_JOB=cfix2-winscen IT_W=/work/fuigo-builds/swarm-b/winscen/wt IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh /work/fuigo-builds/tools/it-remote.sh 'node --test scripts/windows/*.node-test.mjs electron/updater-restart.node-test.mjs electron/sentinel-schedule.node-test.mjs && .test-tmp/cfix2-winscen/pwsh/pwsh -NoProfile -File scripts/windows/dry-check.ps1 && .test-tmp/cfix2-winscen/pwsh/pwsh -NoProfile -File scripts/windows/ownership-check.ps1 && .test-tmp/cfix2-winscen/pwsh/pwsh -NoProfile -File scripts/windows/finalizer-check.ps1 && .test-tmp/cfix2-winscen/pwsh/pwsh -NoProfile -File scripts/windows/admission-policy-check.ps1 && .test-tmp/cfix2-winscen/pwsh/pwsh -NoProfile -File scripts/windows/safety-check.ps1 && node scripts/windows/mutate-ownership.mjs && node scripts/windows/mutate-safety.mjs'
```
