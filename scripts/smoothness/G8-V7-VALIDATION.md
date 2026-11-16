# G8 v7 validation — 2026-11-11

The private fixture archive and its digest are recorded in the operator manifest,
outside this repository.

Preparation used product `4dbd8ce177c35ea7a12172606a2c9202afb50828` and fake
engines `fd825341c6cc752318f0433203399db4d434a19c`. See [the provenance](G8-V7.md)
for the normal boot, product offline drain, normal reboot, and checkpoint stages.
The product offline drain reported 12 → 0 active jobs, 13 slices, no pending
work. The subsequent normal boot reported zero active/undoing/seeding jobs and
receipt flips across 30 healthy seconds and after a clean exit 0. Both pristine
`messages.db` and `routines.json` retained their recorded before/after hashes.

| Check | Result |
| --- | --- |
| Launcher regression tests | 9 passed |
| Host-worker failure/timeout/fixture refusal tests | 4 passed |
| Rig smooth-config / smooth-gate tests at the selected rig | 268 / 65 passed |
| Pinned fake delegated-marker tests | 3 passed |
| Product prebuild / containment node tests | 64 passed |
| Overlay parent, five fake blobs, changes restricted to rig/testing paths | verified |
| Shell syntax, module syntax, diff whitespace | passed |

The real host check used rig `786790aeaf30d9d9b4ee953f5cf58277c5b2166c`,
product overlay `2dc0f0c83c37d5cd8f8f441f1c5d49b7b854f1b6`, PREBUILD=1,
fake engines and an intentionally short **240-second** worker deadline. It
verified the archive hash, extracted a fresh copy with activeJobs=0, built and
verified both product preListen indexes, booted the server, found the Fuigo,
Grok and Claude fake wrappers available, and entered routineBurst. The deadline
then produced worker exit 143 and launcher/wait exit 124. This proves bounded
launch/cleanup; **it is not a completed smoothness verdict**. MAIN must run the
full sequential idle/load command in G8-V7.md at the normal 2400-second limit.

Host and hub reports remain in their operator-configured evidence directories,
outside source and disposable data. A timeout retains private diagnostics; a
completed runner also produces a scrubbed keeper archive.

All containers created for preparation, tests and the launch check were removed.
The preparation checkout/node_modules and working data copy, and the launch
check's checkout/node_modules/data were removed. The archive, logs, hub rig
worktree and pre-existing shared caches remain. No Mac or external network was
used; every started container had networking disabled.
