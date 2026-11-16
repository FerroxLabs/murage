# int19m4 integration

Base: `c1bb723797156eb41884d9f3077e3a6eecaa5149`.

## Merge and conflict table

| Order | Reviewed lane | Merge commit | Conflict hunks | Full typecheck |
| --- | --- | --- | --- | --- |
| 1 | G-MARC connector reconnect (hard gate) `b31dfd13c` | `3928b2dab46099f6ed2834a2a47c5a062a5231f2` | 8 | PASS |
| 2 | Sable approved large-file write `9dc8958ff` | `461ce4c47c594ee77094419e0370a128ac207f8f` | 0 | PASS |
| 3 | ftsdrain r3 lifecycle `9b4fc9fc3` | `dc1d2ede569bbfc7ceac2795a911f6c449ea89be` | 2 | PASS |
| 4 | Smoothness S6 `2fe571bb9` | `d0da471d0ad9e647ce73b3a97e1ee90b67062840` | 0 | PASS |
| 5 | HighLevel hlf2 fixes `6e4d9bc3e` | `862daffa01a6316445bc9b43e9ac4a59a32577fd` | 4 | PASS |

All five lane tips required merges; none was already an ancestor. Every merge uses `--no-ff` and the requested ci identity.

## Conflict hunks

| Lane | File | Hunk | Resolution |
| --- | --- | --- | --- |
| G-MARC | `ci/gate-tests.txt` | 1 | Retain every base gate registration and the incoming scheduled connector workflow gate. |
| G-MARC | `src/locales/source-hashes.json` | 1 | Retain existing cloud/L2C source hashes and append all five connectorHealth hashes; preserve both locale key sets with valid JSON commas. |
| G-MARC | `src/locales/source-hashes.json` | 2 | Retain existing cloud/L2C source hashes and append all five connectorHealth hashes; preserve both locale key sets with valid JSON commas. |
| G-MARC | `src/locales/source-hashes.json` | 3 | Retain existing cloud/L2C source hashes and append all five connectorHealth hashes; preserve both locale key sets with valid JSON commas. |
| G-MARC | `src/locales/source-hashes.json` | 4 | Retain existing cloud/L2C source hashes and append all five connectorHealth hashes; preserve both locale key sets with valid JSON commas. |
| G-MARC | `src/locales/source-hashes.json` | 5 | Retain existing cloud/L2C source hashes and append all five connectorHealth hashes; preserve both locale key sets with valid JSON commas. |
| G-MARC | `src/locales/source-hashes.json` | 6 | Retain existing cloud/L2C source hashes and append all five connectorHealth hashes; preserve both locale key sets with valid JSON commas. |
| G-MARC | `src/locales/source-hashes.json` | 7 | Retain existing cloud/L2C source hashes and append all five connectorHealth hashes; preserve both locale key sets with valid JSON commas. |
| ftsdrain | `server/added-table-lifecycle.ts` | 1 | Keep permanent HighLevel privacy-mark lifecycle alongside search_intents and all retired-search lifecycle registrations. |
| ftsdrain | `server/installation-app-schema-downgrade.ts` | 1 | Keep highlevel_thread_marks in the downgrade table list and also include search_intents and all retired search objects. |
| hlf2 | `ci/gate-tests.txt` | 1 | Retain all existing gates including G-MARC and append the incoming opportunity-plan-platform gate. |
| hlf2 | `scripts/highlevel-hlf2-fixture-driver.ts` | 1 | Keep current FileRpcApprovalJournal instances and incoming users.get fixture spec plus exact review approval callback. |
| hlf2 | `scripts/highlevel-hlf2-fixture-driver.ts` | 2 | Restore settlement through the current approvalJournal name and retain the unrelated pipe_A record alongside the accepted new pipeline; all existing assertions remain. |
| hlf2 | `server/highlevel/opportunities-dispatch.test.ts` | 1 | Keep the complete MAIN frozen durable RPC identity test, close it separately, then retain every RV6/RV7 follower-budget and crash-recovery assertion. |

Original conflict diffs are retained in `../evidence/`. No test is removed or assertion weakened.

## Verification method

Verification used `/work/fuigo-builds/tools/it-remote.sh`, `IT_JOB=int19m4`, `IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh`, network none, and the integration worktree as `IT_W`. The separate detached base worktree used the same runner for comparison. The job ran at most two containers concurrently and waited while the host load exceeded 60. All engines and providers were fakes in isolated fixture homes and data directories. No live app/data, billable provider, or Mac was used.

The full `pnpm typecheck` passed after each of the five merges, before the next merge; the base also passed. G-MARC's first attempt ran prematurely against a truncated JSON resolution and failed TS1005. That precommit resolution was restored from the index and corrected; the committed G-MARC merge passed the full check. The first hlf2 attempt fell back to the local generic container without dependencies (`tsc: not found`); the remote retry passed. Both failed attempts and corrected runs are retained. Typecheck logs are `typecheck-base.log`, `typecheck-marc-fixed.log`, `typecheck-sable.log`, `typecheck-ftsdrain.log`, `typecheck-s6.log`, and `typecheck-hlf2-retry.log`.

The required inventory contains 114 files: every lane's changed tests, the reviewed connector regressions, and every test referencing a conflicted file by path or basename. Three more HighLevel recovery files verify the interaction behind the NEW failures. The main merged run uses source commit `862daffa01a6316445bc9b43e9ac4a59a32577fd`. A later inventory fix classifies connector-health.json, connector-notice-receipts.json, and the receipt writer's pid temp files as installation-local runtime state excluded from backup and restore. The gate-registration change adds 12 blocking test entries. A focused follow-up runs a final full typecheck and rechecks the gate inventory, all three recovery files, the data-directory and snapshot inventory files, and the large-write fixture with evidence retention enabled, and the failing locale copy checks with their full diagnostic report enabled. Repeated test files use their latest result in the comparison, without double-counting.

During automatic merging, the hlf2 deletion-crash fixture also needed its incoming `approvals.settle` references adapted to the base's `approvalJournal` name. Its current FileRpcApprovalJournal identity and all prior/new fixture assertions remain.

## Results

Across 117 distinct test files (114 required targets plus three HighLevel recovery checks), the latest result for each file is:

| Runner | Base files | Merged files | Base passed / failed / skipped | Merged passed / failed / skipped | NEW failures |
| --- | --- | --- | --- | --- | --- |
| Vitest | 86 | 102 | 2525 / 8 / 21 | 2782 / 14 / 24 | 7 |
| Node | 14 | 15 | 184 / 0 / 0 | 194 / 0 / 0 | 0 |

Seven Vitest failures are inherited, one base failure is no longer failing, and seven are NEW. The inherited failures are the CI classification assertion (the same 52 diagnostics), two backup/restore speech cases, one connected-app relay replay case, the internal vendor-name check, and two 1.0.2 downgrade schema assertions. The base-only installation-downgrade stop/rerun assertion passed on the merged run; no causal fix is claimed. Exact identities and counts are in `test-comparison.json`.

The final full typecheck completed successfully on source commit `c5a81515f93bc368d0fb6628ef41241ae2da2b06`. Both corrected backup inventory files passed. CI registration diagnostics returned from 64 to the inherited 52, with zero new diagnostics (`gate-inventory-final-comparison.json`). All three additional HighLevel guard files and the approved large-write fixture passed. The isolated HighLevel dispatch/Doctor workflows passed on both base and merged trees. No test or assertion was edited to obtain these results.

The required G-MARC scheduled Buffer workflow remains FAIL. Its focused rerun reproduces the first passive-incident assertion failure, so this integration does not qualify that hard gate. The seven NEW assertions are reported below for follow-up; they are not waived.

## NEW G-MARC scheduled Buffer workflow

`server/connector-health-scheduled-workflow.test.ts :: P2-6 scheduled Buffer work fails visibly while lapsed and safely continues after reconnect` is NEW relative to the base (the file is absent on the base). Its first passive-incident assertion waits 35 seconds and receives zero reconnect incidents instead of one, before scheduled dispatch starts. The later r2 scheduled and reactive workflows pass. The older fixture returns an outer JSON-RPC authentication error while its connected inventory stays ACTIVE; the r3 preflight deliberately distinguishes broker authorization failures from account-attributed upstream expiry. That interaction is the suspected cause. The failing assertion, strict attribution behavior and all fixture inputs remain unchanged. The final focused rerun reproduces the same zero-versus-one failure. Fresh fixture evidence is retained under `guard-current-fixtures/lane-evidence/connector-reconnect-r1/`. Scheduled dispatch and reconnect continuation are not reached in this older workflow; their success is not claimed.

## NEW HighLevel recovery mismatch

Four newly added RV7 cases in `server/highlevel/opportunities-dispatch.test.ts` expect `not_applied` but return `outcome_unknown`:

- `RV7 host collection replay retains refusal for negative unrelated`
- `RV7 host collection replay retains refusal for negative error`
- `RV7 host collection replay retains refusal for negative sibling`
- `RV7 host deletion cannot prove absence from hidden negative collection`

The base's shared `readReconciliation` guard rejects negative provider flags before opportunity-specific collection reconciliation can run. The incoming collection code's negative-confirmation classification is therefore unreachable for these responses. All tests and the shared guard remain intact. These failures are reported for HighLevel follow-up; the integration is not an all-green release qualification.

## NEW connector copy-review coverage

The base passes all 165 assertions in `src/locales/copy-final.test.ts`. Two review-ledger assertions become NEW failures with the connector catalogue additions:

- `section 2: every review record and ledger entry is valid (and complete once LEDGER_REQUIRED)`
- `section 2: the records alone give a valid ledger, so a reviewed.json merge conflict can always be rebuilt`

The reviewed lane records explicitly leave independent review open: `lane-evidence/connector-reconnect/copy-status.txt` names 32 original reconnect strings awaiting review, and the r3 README records eight catalogue entries for the new `connectorHealth.unverified` string without a copy-review record. Both base and incoming locale/hash entries are preserved. No reviewer approval, pending exception, or replacement ledger is fabricated. Full current diagnostics are retained by the focused follow-up with `COPY_FINAL_REPORT=1`.

## Connector backup inventory correction

The original merged run adds one NEW failure in `server/data-dir-inventory.test.ts`: `static scan: every name joined under the data folder in source`. G-MARC writes `connector-health.json` and desktop receipt state beneath the owned installation. The integration classifies that health file, `connector-notice-receipts.json`, and its exact pid temp-file family as excluded runtime state, matching the existing account-inventory and health-delivery policies. This prevents an observed connector incident or receipt from stopping every backup while keeping stale credential-bound incidents and receipt IDs out of restored installations. The original assertion and every existing inventory entry/pattern remain; the final focused run validates the correction.

## CI inventory correction

The original merged run increased the inherited CI classification check's diagnostics from 52 to 64: 12 incoming regression files lacked a tier registration. The integration adds all 12 as blocking gates, with no excluded tests or changed assertions. The post-correction focused check has the same 52 diagnostics as the base, with zero new diagnostics; details are in `gate-inventory-final-comparison.json` and `new-gate-registrations.diff`. The earlier 64-versus-52 comparison remains as `gate-inventory-comparison.json`.

## Evidence and cleanup

Evidence lives in the job's `../evidence/` directory, with source and lane provenance, target inventories, commands, raw Vitest/JUnit reports, failure-set comparison, fixture JSON/server logs, and every original conflict diff. The unchanged shared leak guard v2 matcher passed on the base and merged tree with zero whole-tree and added-line hits. The final committed tree is scanned again before push; scanner/pattern hashes are in `leak-v2-shared.sha256`.

## Resume audit

On resume, HEAD was `c5a81515f93bc368d0fb6628ef41241ae2da2b06` with all five ordered merge commits and two integration corrections present. The only untracked paths were S6 fixture evidence and Python bytecode. All source work and conflict resolutions were kept; no source reset was performed. The guard container completed after the interrupted agent stopped, and its completed reports were recovered from `.planning/int19m4-guard/`. Its final typecheck passed. The S6 evidence and fresh guard fixture logs/JSON were copied into the job evidence directory before cleanup; disposable bytecode is removed.

The resume audit independently checked every lane's changed test list and references by path, filename, and extension-free filename to all six conflicted files. Every discovered test is in the executed inventory (`resume-coverage-audit.json`). The original base and every requested lane tip are ancestors of HEAD, so no merges are repeated on resume. None was skipped in the original integration; all five are already ancestors now.

Cleanup removes job-created node_modules, generated native/build outputs, tsbuildinfo and bytecode while retaining fixture evidence and tracked build inputs. The cleanup record is `cleanup.log`. A normal non-force push targets `HEAD:refs/heads/dev/1019-int19m4` in the shared bare hub `/work/mb-105-git.git`; because this worktree owns that hub ref, the push may report it is already up to date. No history is rewritten.

The requested `ijfw_memory_prelude` tool is unavailable and `.ijfw/memory/` is absent.
