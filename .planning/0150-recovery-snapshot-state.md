# 0150 capture provider qualification

R1: run 34447851716 / source d3729375 failed at MSVC compile, four undefined ERROR_QUOTA_EXCEEDED symbols; no VSS/data fixture ran. Existing VS2022 environment initialized successfully. Full failed-step output inspected. Eligible correction replaces only these four references with documented Windows ERROR_NOT_ENOUGH_QUOTA (1816). Warnings are nonblocking and untouched. Rounds 1/2; corrections 1/2; root authorizes exact isolated-branch push for R2, preserving the branch-only workflow trigger. R2 is final package verification; no additional attempt inferred.

Base: 1a439db5. Isolated branch codex/0150-recovery-snapshot. Outcome: qualify a Windows fixed-NTFS VSS capture provider for the approved no-backup recovery design. This package owns native capture source and a disposable native fixture only; excludes production elevation/IPC/UI, live profiles, archive candidate re-verification, startup selection, publication and permission changes. Existing archive candidate 4da49ec8 and its exhausted native gate remain unchanged.

Acceptance/checks frozen before implementation: native MSVC/Windows SDK compile; real VSS disposable idle fixture with foreign anchors retained byte-for-byte; concurrent WAL/atomic JSON writer survives and snapshot copy validates through existing archive pipeline; unsupported paths/reparse/overlap/root replacement, pending journals, limits, cancellation/provider failures refuse; exact snapshot-ID cleanup with incomplete copies retained and never selected. Snapshot semantics are crash-consistent, not application-consistent. Round 1 runs that check set; round 2 only eligible corrections and invalidated checks. Rounds 0/2; corrections 0/2. Stop at a supported platform/API or integration blocker; no fabricated Windows proof or new attempt budget.

Current: native source and disposable fixture/workflow prepared. Root authorized GitHub Actions windows-2022 with existing MSVC/SDK, disposable fixture VSS only, no host services/ACL changes or live data. Native capture cannot qualify on macOS. No elevated executable or renderer-facing API will ship before the authenticated main-owned capability and native feasibility gates are satisfied. Node 24 fixture syntax and whitespace checks pass; these are not native proof. Root dispatch pending, native rounds still 0/2.

First native check set in the workflow: compile; pre-cancel, confirmation-ID mismatch, UNC and source/destination overlap; idle VSS with original/foreign anchors byte-identical; WAL writer plus post-snapshot JSON mutation and archive/paused-restore preparation; pending package-import and exact sibling restore journal; junction escape; quota/incomplete clone; invalid DB graph rejected by existing archive validator. All provider calls use the same source-bound snapshot ID and explicit receipt/cleanup. Failure stops the runner; no retries or privileged fallbacks. Full application activation/selector/elevation denial and remaining provider-interruption cases are still pending integration gates; passing this fixture does not complete the recovery feature.

Primary API references checked before implementation:
- https://learn.microsoft.com/en-us/windows/win32/api/vss/ne-vss-vss_snapshot_context
- https://learn.microsoft.com/en-us/windows/win32/api/vsbackup/nl-vsbackup-ivssbackupcomponents
- https://learn.microsoft.com/en-us/windows/win32/api/vsbackup/nf-vsbackup-ivssbackupcomponents-deletesnapshots
- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew
- https://learn.microsoft.com/en-us/windows/win32/vss/security-considerations-for-requestors
- https://learn.microsoft.com/en-us/cpp/build/building-on-the-command-line?view=msvc-170
- https://github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md
