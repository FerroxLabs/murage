# int19m3 integration

Base: `1a899c6750f3ec5fb7639810ebfcf17479cd7a32`.

## Merge and conflict table

| Order | Lane | Merge commit | Resolution |
| --- | --- | --- | --- |
| 1 | G-WEB `fd84682d88bed475ec4272f39a5f7fd07400d4ed` | `76b484ed7` | Three files, three conflict hunks; detailed below. |
| 2 | ELD `c26f2029803893d430fdec76290fb5724d8bc49e` | `82ffc75bd` | Clean merge, no conflict hunks. |
| 3 | S5 `8d484d57032fe5f64ecfa142470ecbe7b119e7d5` | `70f4238f1` | Clean merge, no conflict hunks. |

### G-WEB conflict hunks

1. `server/browser-extension-service.ts`, executor call in the binding route: retain the base `bootstrapOnly` capability fence and incoming `Scope` cast, and add the incoming call-scoped `readOnly` bit. Cancellation, admitted targets and admitted URLs remain intact.
2. `server/drivers/browser-proxy.ts`, `browser_read` branch: retain incoming range/handle validation, immutable WebDocuments retention and current capability checks. Preserve the base NotModelRequest classification around the page read and apply the same classification to the new state control request. Retain URL safety validation inside the accepted-text adapter. Complete structured page output replaces the old unretained text output as required by G-WEB.
3. `src/components/BotSettingsPane.tsx`, imports: retain both BotReviewSheet and EngineLimitRow/engineLimitText imports. The base staged/pending bot review wrapper and incoming active-settings engine-limit row both remain.

No test was removed or assertion weakened. Original conflict markers are retained outside the worktree in `../evidence/web-conflicts.diff`.

## Verification

All verification used the required `it-remote.sh` wrapper with `IT_JOB=int19m3`, the job's tip/base worktree as `IT_W`, and `IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh`. Containers used `--network none`, fresh fixture homes/data, and fakes only. There were at most two job containers at once. Launch logs record host loads below 60; the launch wrapper waits above 60. No live app/data, billable engine, or Mac was used. The full suite was not run; MAIN queues it on the pushed SHA.

| Tree / merge | Full typecheck | Evidence |
| --- | --- | --- |
| Base `1a899c675` | PASS, exit 0 | `typecheck-base.log` |
| G-WEB `76b484ed7` | PASS, exit 0 after correction | `typecheck-web-fixed.log` |
| ELD `82ffc75bd` | PASS, exit 0 | `typecheck-eld.log` |
| S5 `70f4238f1` | PASS, exit 0 | `typecheck-s5.log` |

The initial G-WEB resolution omitted the incoming `Scope` cast and produced TS2353 on `readOnly` (`typecheck-web.log`, exit 2). Restoring that cast retained both `readOnly` and `bootstrapOnly`; the corrected full check passed before the next merge. This integration error is fixed.

The targeted inventory contains 71 distinct files: each lane's changed test files, tests referencing any of the three conflicted source files, and the supporting smoothness tests named in the S5 receipt. A sibling-path reference in `server/drivers/turn-credentials-proxies.test.ts` was added as a separate base/tip run; all five assertions passed. No assertion was weakened or removed. The main tip run tested source commit `70f4238f16118dd00a5c2611901d9840f7de8325`; the final documentation commit changes only these notes.

| Checks | Base passed / failed / skipped | Merged passed / failed / skipped | NEW failures |
| --- | --- | --- | --- |
| Vitest (53 base files / 70 merged files) | 2660 / 1 / 3 | 2774 / 2 / 3 | 1 |
| Node (one file at each ref) | 193 / 5 / 0 | 194 / 5 / 0 | 0 |

Failure sets are compared by file and test name, not by exit code alone. The base aggregate exits 1 because inherited failures remain; the merged aggregate exits 1 because those failures and the NEW replay failure remain. Complete comparison: `test-comparison.json`; raw reports: `tests-base.json`, `tests-tip.json`, `credentials-base.json`, `credentials-tip.json`; Node results are in `tests-base.log` and `tests-tip.log`.

Inherited failures:

- `server/engine-swap-round2.test.ts :: N6 room dispatch retries retain the request and respect revalidation delays`
- `exact R4 review: named getAttribute, select, and script Send beside the form in an open root`
- `serialized hostile collectors: named getAttribute select`
- `snapshot cover collector reads a clobbered form identity natively`
- `strict assembled admission: named getAttribute input`
- `strict assembled admission: named getAttribute select`

NEW failures remaining:

- `scripts/web-read-replay/replay.test.mjs :: T4-permissions survives umask 077 for every replay evidence file and folder`

## NEW web replay failure and diagnostic attempts

`T4-permissions survives umask 077 for every replay evidence file and folder` is NEW relative to the base test set (the base does not contain this replay harness). The main merged run and a retained exact fake replay both fail. In the retained replay, the browser and web_read routes reconstruct the entire page; each later receives one owner-initiated `Bash` approval card with `reason=always-ask`, `rule=unreadable`, on `cd <fixture>/dir && pwd > <fixture>/cd.done`. The test correctly remains failing: no card is approved or hidden and no assertion is changed. This is reported for G-WEB follow-up.

A base-only isolated fake permission probe with the equivalent command and no prior page read settles with zero cards (`base-shell-probe.json` and server log). This establishes the ordinary command can run on the base; it does not reproduce the preceding page-read context and does not erase the NEW replay failure. The first probe failed to start because its instrumentation omitted imports; the corrected probe succeeded. Both launch logs are retained.

A fixture-protocol experiment emitted the Bash stream start before the permission request and used one ID for start/ask/result. The focused replay still failed (9 passed / 1 failed), so the experiment was reverted. Its diff and complete focused-test results are retained. The experiment's additional full typecheck completed with exit 0; its focused tests still failed, and the experiment was reverted. All three actual merge typechecks passed before this experiment. No experiment code is committed; the merged source remains exactly `70f4238f1` apart from these notes.

## Fixture and release limits

The native fixture helper was compiled offline and verified as loaded with a no-replace relocation proof. S5's current synthetic relocation test launches an isolated verification server, sends five fake-engine turns, and retains `wait`/`messages` JSON plus the server log under `s5-current-relocation/`. The fresh synthetic fixture measured first text p90 1,658 ms, four resumes and zero failed turns. The four original-fixture evidence assertions were explicitly enabled using the reviewed lane's retained manifest/results; those assertions validate prior evidence, not a new measurement of the original 11,906-message archive.

G-WEB fake replay is FAIL because of the reported NEW test failure. Its installed-engine exclusion proof remains UNVERIFIED, as recorded by the accepted review. Passing full-page unit routing checks do not close that release gate. Full combined smoothness acceptance still needs FTS integration and the combined rig rerun. No full rig or installed-engine proof was claimed here. ELD fixture wait/messages and slicing evidence are in the main test log, with its isolated server log retained as `eld-current-server.log`.

## Leak guard, evidence and cleanup

The unchanged shared leak guard v2 matcher, invoked through `scripts/leak-guard/check.mjs`, passed on both base and merged trees: whole-tree 0 hits and added-lines 0 hits. The final committed tree is scanned again before push. Shared scanner/pattern hashes are retained in `leak-v2-shared.sha256`.

Evidence is retained in the job's `../evidence/` directory, including all complete runs, the original conflict diff, exact runner scripts and target inventory, source/commit provenance, comparison JSON, and fixture output. Cleanup removes generated node_modules, native/build outputs, tsbuildinfo and confirms no job containers remain; see `cleanup.log`. Push uses the shared bare hub without force after verifying the original base and all three lane tips are ancestors.

The requested ijfw_memory_prelude tool is unavailable and `.ijfw/memory/` is absent.
