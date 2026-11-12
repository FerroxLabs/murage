# int19m6 integration

Requested comparison base: `b845d135fe63157de68507a112c9d93e4a674b96`.

## Resume audit

The resumed worktree began at `35246b1ac96b18d11a6bdc44268260c635fdefed`, with eight requested lane tips already merged and four earlier native-deny/routine merges. These commits and the existing regression-runner/fixture-cleanup correction are preserved. Existing requested ancestors are skipped, as instructed. The first session had branched from wave 4 (`f6b9b86de7`), so the requested wave 5 tip must also be merged; it is not silently treated as an ancestor.

The duplicate older integrator process and its two queued follow-ups were stopped by exact PID. Its two named test containers were stopped, and their partial logs retained in `../evidence/interrupted-head/` and `../evidence/interrupted-base/`. Those interrupted runs and their wrong baseline are not final comparison evidence. The isolated baseline checkout now uses the requested wave 5 SHA.

No per-merge typecheck evidence was present for the eight existing requested merge commits. Their exact committed snapshots are checked retrospectively in an isolated container, with that timing explicitly distinguished from the required checks after new merges. No claim is made that the old session checked between commits.

The project-memory tool `ijfw_memory_prelude` is unavailable and `.ijfw/memory/` is absent.

## Existing conflict hunks

| Merge | File | Hunk | Resolution |
| --- | --- | --- | --- |
| `3fd1f7f706` checkahead | `ci/gate-tests.txt` | 1 | Retain every existing gate and append all incoming checkahead registrations. |
| `8c92691a27` reds-main | `ci/gate-tests.txt` | 1 | Retain all unique paths from both sides, preserve the specific existing behavioral reasons, and union platform coverage (`all` includes linux and mac). Repeated registrations are deduplicated, with no test removed. |

The original remerge diffs are `../evidence/conflict-checkahead.diff` and `../evidence/conflict-reds-main.diff`.

## Verification in progress

New merge checks use `/work/fuigo-builds/tools/it-remote.sh` with `IT_JOB=int19m6`, the job worktree as `IT_W`, `IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh`, and network none. At most two owned containers run concurrently, with launches waiting while host load is greater than 60. Tests use only fakes and isolated homes/data. No live app, billable provider or Mac is used.

The final report will record each requested merge/ancestor, every additional conflict hunk, full typecheck results, the complete test coverage inventory, NEW versus base failure identities, isolated fixture evidence, leak guard v2 results, cleanup, and the fast-forward-only push.

## Continuation audit (MAIN 09:35Z)

Preserve tip `209a863f3c` and all earlier merges. Comparison base for the final continuation run is `f6b9b86de72d64bd10f1d0363b7d44f58ae3af32`, per MAIN. The original required wave-5 tip `b845d135fe` was absent from ancestry; finish its in-progress merge. A duplicate resume agent was terminated by exact PID (1804350, helper 1806838); its independent historical typecheck container is retained to completion.

| Merge | File | Hunk | Resolution |
| --- | --- | --- | --- |
| wave-5 base `b845d135fe` | `ci/gate-tests.txt` | 1 | Concatenate both complete registration blocks; no path or reason removed. |
| wave-5 base `b845d135fe` | `server/highlevel/f01-contract.test.ts` | 1 | Keep incoming snapshot helper and both snapshot tests, plus all overload assertions. |
| wave-5 base `b845d135fe` | `server/highlevel/f01-contract.test.ts` | 2 | Keep F7 historical normalization and approved 9aaeaa1195 copy hashes; pin the combined current signatures independently, retaining historical digest d5a50b9748. |
| wave-5 base `b845d135fe` | `server/highlevel/f02-contract.test.ts` | 1 | Keep both current and historical signature assertions, normalizing only enumerated F7 additions for the historical assertion; preserve approved copy hashes. |

The automatic frozen-contract merge reverted two approved validation-message hashes from reds-main. Restore exactly common.ts and opportunities.ts to the reviewed reds-main hashes while retaining every incoming F7 signature. Combined current digests are computed from these frozen declarations; no schema, signature, operation, test, or assertion is dropped.

| Signal `08acbf536e` | `RELEASE-ASSET-PLAN.md` | 1 | Use committed D102 strict verification status and retain MAIN/Sean publication ownership and every OPEN-MAIN-PUBLICATION row. |
| Signal `08acbf536e` | `RELEASE-ASSET-PLAN.md` | 2 | Retain check-ahead D044-D046/D094/D098/D100 rulings and incoming closed D102 row. |
| Signal `08acbf536e` | `RELEASE-ASSET-PLAN.md` | 3 | Retain full standing D094 exception with immutable digest and all incoming D102 closure details. |
| Signal `08acbf536e` | `RELEASE-ASSET-PLAN.md` | 4 | Replace stale D102 in-progress statement with reviewed closure, retaining strict-verification requirement and every incoming evidence/qualification limit. |

| park-B3b `f6c8875829` | `src/locales/copy-lint/reviewed.json` | 1 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/copy-lint/reviewed.json` | 2 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/copy-lint/reviewed.json` | 3 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/copy-lint/reviewed.json` | 4 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/copy-lint/reviewed.json` | 5 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/copy-lint/reviewed.json` | 6 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/copy-lint/reviewed.json` | 7 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/copy-lint/reviewed.json` | 8 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/copy-lint/reviewed.json` | 9 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/de.json` | 1 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/en.json` | 1 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/es.json` | 1 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/fr.json` | 1 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/hi.json` | 1 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/ja.json` | 1 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/pt-br.json` | 1 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/source-hashes.json` | 1 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/source-hashes.json` | 2 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/source-hashes.json` | 3 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/source-hashes.json` | 4 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/source-hashes.json` | 5 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/source-hashes.json` | 6 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/source-hashes.json` | 7 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |
| park-B3b `f6c8875829` | `src/locales/zh.json` | 1 | Semantic three-way JSON merge keeps every reviewed key, translation, source hash and copy review from both sides; distinct keys unioned; current same-as-english file pin retained where its review metadata differs, since that file is unchanged by this lane. |

Park resolution correction: the first JSON merge helper stopped on the differing same-as-english file review pin, but its calling shell incorrectly continued. That intermediate merge was immediately amended before publication. Its failed typecheck (`typecheck-park-B3b.log`) is retained as rejected evidence; only the fresh `typecheck-park-B3b-final` run checks the corrected merge. All subsequent merge drivers stop on errors. The unchanged same-as-english file has SHA-256 `e0946a98c0e695311639796177cb3d6103ecd0309bf6deecab0a48aeb380a7a4`, matching the current reviewed pin. Incoming park review artifacts remain intact.

Sol integrator browser copy check: the changed test expectations match the approved Sol re-review recorded in `docs/verification/rec-browser/RE-REVIEW.md` and `src/locales/copy-lint/reviews/2026-11-11-1019-browser-re-review-3f31e16e2daa.json`. Exact strings: “Setup also enables browser tools in this workspace.” and “This browser task stopped. Ask the bot to start a new browser task, then choose Continue again.” These are existing approved product strings; this integration introduces no new browser wording.

| park-int-basereds `d1eab9ba07` | `server/backup-waiting-api.test.ts` | 1 | Keep the incoming fake-engine preload and existing windowsHide flag; retain every backup waiting assertion. |
| park-int-basereds `d1eab9ba07` | `server/cloud-home/home-commands.fixture.py` | 1 | Keep update_target, park_marker, all assertions, both scenario registrations, and immutable.thaw_all cleanup. |
| park-int-basereds `d1eab9ba07` | `server/index.ts` | 1 | Keep all existing engine, browser, owner-authority and restore-review imports; add restoreWindowOpen and consumeRestoreMarker. Retain both restore marker consumption and restored-connection fencing. |
| park-int-basereds `d1eab9ba07` | `server/index.ts` | 2 | Keep all existing engine, browser, owner-authority and restore-review imports; add restoreWindowOpen and consumeRestoreMarker. Retain both restore marker consumption and restored-connection fencing. |

Post-merge typecheck found TS1117 in `server/backup-wait-space-1018.test.ts`: the automatic merge duplicated `bannerNative:null` and `attentionSurfaces:null` in one fixture object. Retain the first identical declarations and remove only the duplicate pair. No assertion or fixture value changes. Re-run the full typecheck before final head tests.

The integrated inventory/release-workflow test found 19 Vitest files missing from both CI lists (restore park and indexed-work lanes). Register all 19 as blocking gates with their user failures; preserve every existing gate/extended row and every test assertion. These registrations require a targeted CI-inventory/release-workflow recheck after the broad run. No runtime code changes.
