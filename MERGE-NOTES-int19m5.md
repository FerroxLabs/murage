# int19m5 integration

Base: `f6b9b86de72d64bd10f1d0363b7d44f58ae3af32`.

## Merge and conflict table

| Order | Lane | Reviewed SHA | Merge commit | Conflict hunks | Full typecheck |
| --- | --- | --- | --- | --- | --- |
| 1 | phone | `75e02e77cb5c62cf58a86279eae1e055b8a9c0de` | `34bc9b500c40f1b3d48a8ce0af16fedea4ce23c7` | 0 | PASS |
| 2 | gatekit | `95c4e34777ebd2849d9a42af24084fe35911c51b` | `3fdb70d80ee26e66947304f72024f00612628630` | 0 | PASS |
| 3 | hlf1 | `c6a42f182041ab11fe9e7fa4c35a4cd71cf109e8` | `764ce94b98f1512dfcaf12ac50472540addd6ed9` | 7 | PASS |
| 4 | smoothio | `f66ea809d6d2a848c885ab535eb990f69ba11f53` | `fd9612db667528516e563d2448fc12f0fb950a59` | 0 | PASS |
| 5 | openclaw | `cddf1c168e35a75f6fd0a09c6a5ec6c76386d598` | `c9971d371d17b583712db3a1176f681ad41ca94f` | 0 | PASS |
| 6 | muse | `f161f3c9e3f248cdd56e4aeba50f3b553000cb65` | `dc400e2acdc2aa74c935d2a8aecab3c14afc4f1a` | 0 | PASS |
| 7 | hlf7 | `8878323e894015a3f62e0b1bc4c9c555b66de4e3` | `51c9c1af0a14f2d8286a128d5bd0ca30b39dfb6c` | 17 | PASS |
| 8 | hlc2 | `4f8c1ce5707c245765f33a9f663100646dde7a06` | `464c193287879495a93e975a87c43286796a6930` | 10 | PASS |
| 9 | hlf4 | `9d598a9e1603ffd2a86d617c3c6ee0095d3f81a9` | `f289935cbc3a3054519714b76f66e29f26da6be3` | 20 | PASS |

## Conflict hunks

| Lane | File | Hunk | Resolution |
| --- | --- | --- | --- |
| hlf1 | `ci/gate-tests.txt` | 1 | Keep every existing gate and append the incoming contacts review gate. |
| hlf1 | `server/highlevel/client.ts` | 1 | Combine schema-bounded 500-contact cached reads with the existing 13-read opportunity budget, five-read default, allowlists and active checks. |
| hlf1 | `server/highlevel/client.ts` | 2 | Propagate recheck admission to the read context and cache the returned contact observation. |
| hlf1 | `server/highlevel/contact-recovery.ts` | 1 | Add scoped contact identity lookup and strict candidate metadata validation; retain shared readReconciliation safety and completeness checks, treating unconfirmed preparation as unavailable proof. |
| hlf1 | `server/highlevel/contact-recovery.ts` | 2 | Preserve approved follower identity validation before incoming scoped contact lookup; retain the existing non-contact collection path. |
| hlf1 | `server/highlevel/host.ts` | 1 | Parse digest-bound replay args and supply the bulk read input through the current durable approvalJournal. |
| hlf1 | `server/highlevel/host.ts` | 2 | Retain native-recovery guards, tag identity snapshots, generic/opportunity plans and replay bindings; share incoming bulk requester for contact recovery. |
| hlf7 | `ci/gate-tests.txt` | 1 | Retain all integrated gates and append every incoming payments regression gate. |
| hlf7 | `server/highlevel/f01-contract.test.ts` | 1 | Keep both exact digest assertions in separately named tests sharing only snapshot construction: original raw MAIN freeze and incoming enumerated F7 normalization; neither hash nor assertion is changed. |
| hlf7 | `server/highlevel/host.ts` | 1 | Keep inertBot and add InvoiceReviewRefused; both imports remain. |
| hlf7 | `src/locales/de.json` | 1 | Retain every existing browser/cloud/connector translation and add all incoming payments title translations; preserve existing localized snapshot titles instead of incoming duplicate English fallback entries. |
| hlf7 | `src/locales/es.json` | 1 | Retain every existing browser/cloud/connector translation and add all incoming payments title translations; preserve existing localized snapshot titles instead of incoming duplicate English fallback entries. |
| hlf7 | `src/locales/fr.json` | 1 | Retain every existing browser/cloud/connector translation and add all incoming payments title translations; preserve existing localized snapshot titles instead of incoming duplicate English fallback entries. |
| hlf7 | `src/locales/hi.json` | 1 | Retain every existing browser/cloud/connector translation and add all incoming payments title translations; preserve existing localized snapshot titles instead of incoming duplicate English fallback entries. |
| hlf7 | `src/locales/ja.json` | 1 | Retain every existing browser/cloud/connector translation and add all incoming payments title translations; preserve existing localized snapshot titles instead of incoming duplicate English fallback entries. |
| hlf7 | `src/locales/pt-br.json` | 1 | Retain every existing browser/cloud/connector translation and add all incoming payments title translations; preserve existing localized snapshot titles instead of incoming duplicate English fallback entries. |
| hlf7 | `src/locales/source-hashes.json` | 1 | Retain all existing browser/cloud/connector hashes and add every incoming payments title hash in this locale; combine valid JSON with duplicate-equal entries collapsed. |
| hlf7 | `src/locales/source-hashes.json` | 2 | Retain all existing browser/cloud/connector hashes and add every incoming payments title hash in this locale; combine valid JSON with duplicate-equal entries collapsed. |
| hlf7 | `src/locales/source-hashes.json` | 3 | Retain all existing browser/cloud/connector hashes and add every incoming payments title hash in this locale; combine valid JSON with duplicate-equal entries collapsed. |
| hlf7 | `src/locales/source-hashes.json` | 4 | Retain all existing browser/cloud/connector hashes and add every incoming payments title hash in this locale; combine valid JSON with duplicate-equal entries collapsed. |
| hlf7 | `src/locales/source-hashes.json` | 5 | Retain all existing browser/cloud/connector hashes and add every incoming payments title hash in this locale; combine valid JSON with duplicate-equal entries collapsed. |
| hlf7 | `src/locales/source-hashes.json` | 6 | Retain all existing browser/cloud/connector hashes and add every incoming payments title hash in this locale; combine valid JSON with duplicate-equal entries collapsed. |
| hlf7 | `src/locales/source-hashes.json` | 7 | Retain all existing browser/cloud/connector hashes and add every incoming payments title hash in this locale; combine valid JSON with duplicate-equal entries collapsed. |
| hlf7 | `src/locales/zh.json` | 1 | Retain every existing browser/cloud/connector translation and add all incoming payments title translations; preserve existing localized snapshot titles instead of incoming duplicate English fallback entries. |
| hlc2 | `ci/gate-tests.txt` | 1 | Retain all existing gates and append incoming bounded-recovery and upload gates. |
| hlc2 | `server/highlevel/cfix3-recovery.test.ts` | 1 | Retain both existing recoveryEnvelope-collision and foreign-nonmatching-member test cases alongside every incoming stricter bounded-recovery assertion. |
| hlc2 | `server/highlevel/host.ts` | 1 | Call combined readWriteRecovery; concrete/invoice reads retain the shared guard and generic lookups use bounded page evidence. |
| hlc2 | `server/highlevel/write-recovery.ts` | 1 | Keep invoice lookup window/contact metadata and add generic journal-time, identity and filter metadata. |
| hlc2 | `server/highlevel/write-recovery.ts` | 2 | Retain invoice IDs and text2pay create classification, while admitting the incoming multipart recovery shape. |
| hlc2 | `server/highlevel/write-recovery.ts` | 3 | Combine invoice bounded draft/approved identities with generic selector filters, upload redaction, journal time and media/message drafts. |
| hlc2 | `server/highlevel/write-recovery.ts` | 4 | Retain strict invoice collection and id/_id validation for the invoice path. |
| hlc2 | `server/highlevel/write-recovery.ts` | 5 | Use the stable no-snapshot hook: generic journal-time recovery replaces location-wide pre-create reads; invoice preparation already skipped those reads. |
| hlc2 | `server/highlevel/write-recovery.ts` | 6 | Persist generic journal time and bind invoice windows to the durable action creation/expiry times; retain digest checks. |
| hlc2 | `server/highlevel/write-recovery.ts` | 7 | Keep the full invoice matching/identity branch and use module-owned bounded evidence for other collections; both paths retain whole-response confirmation checks. |
| hlf4 | `ci/gate-tests.txt` | 1 | Retain all existing CI gates and append incoming calendar gates from this hunk. |
| hlf4 | `ci/gate-tests.txt` | 2 | Retain all existing CI gates and append incoming calendar gates from this hunk. |
| hlf4 | `server/highlevel/held-request.ts` | 1 | Keep draft approvalContext in HeldRequest construction and bind the additive operation extension before returning it. |
| hlf4 | `server/highlevel/host.ts` | 1 | Keep inertBot and InvoiceReviewRefused plus operationExtension; combine loadWriteRecoveryForSpec with the integrated readWriteRecovery dispatcher. |
| hlf4 | `server/highlevel/host.ts` | 2 | Keep inertBot and InvoiceReviewRefused plus operationExtension; combine loadWriteRecoveryForSpec with the integrated readWriteRecovery dispatcher. |
| hlf4 | `server/highlevel/returned-identities.ts` | 1 | Keep shared digest-verified JSON/multipart parsing, then add retained calendar parent identities and explicit assignee-reassignment handling. |
| hlf4 | `server/highlevel/write-recovery.ts` | 1 | Keep payment approval identities and add retained calendar ownership context. |
| hlf4 | `server/highlevel/write-recovery.ts` | 2 | Keep invoice windows and generic identity/time/filter metadata; add calendar incomplete/unavailable lookup flags. |
| hlf4 | `server/highlevel/write-recovery.ts` | 3 | Retain invoice/contact/opportunity collection adapters and add every calendar collection adapter. |
| hlf4 | `server/highlevel/write-recovery.ts` | 4 | Use digest-verified shared JSON/multipart parsing and resolve additive calendar extension rows; multipart recovery stays supported. |
| hlf4 | `server/highlevel/write-recovery.ts` | 5 | Retain multipart conversation identity extraction and add calendar context plus extension-specific declared reads. |
| hlf4 | `server/highlevel/write-recovery.ts` | 6 | Combine book/text2pay create classification and invoice/event/calendar IDs; retain multipart admission. |
| hlf4 | `server/highlevel/write-recovery.ts` | 7 | Keep invoice/generic bounded metadata and upload redaction, add calendar retained context and unavailable-query refusal, and preserve all specialized read drafts. |
| hlf4 | `server/highlevel/write-recovery.ts` | 8 | Apply both calendar and invoice row ceilings; retain strict shared collection completeness and invoice total checks. |
| hlf4 | `server/highlevel/write-recovery.ts` | 9 | Combine invoice scope/envelope validation with calendar hasMore validation. Calendar pre-state reads require the approved bounded query; generic recovery keeps its no-snapshot hook. |
| hlf4 | `server/highlevel/write-recovery.ts` | 10 | Retain durable generic journal-time checks and permit only flagged unavailable calendar lookups with empty targets; validate all extension-declared targets. |
| hlf4 | `server/highlevel/write-recovery.ts` | 11 | Keep bounded generic/invoice dispatch and add bounded calendar query dispatch plus the collision-safe envelope helper. |
| hlf4 | `server/highlevel/write-recovery.ts` | 12 | Retain full generic/invoice comparison and full calendar comparison as separate family paths; calendar destructive-absence restrictions remain intact. |
| hlf4 | `server/highlevel/write-recovery.ts` | 13 | Retain invoice and calendar/event response envelope handling in their respective family paths; no provider sibling is discarded. |
| hlf4 | `server/highlevel/write-recovery.ts` | 14 | Retain payment approval-context reconstruction and calendar draft/context reconstruction; both exact digest and identity checks remain. |

Original conflict markers and combined diffs are retained in `../evidence/`. Every original and incoming test/assertion is preserved.

## Verification

Checks use `/work/fuigo-builds/tools/it-remote.sh` with `IT_JOB=int19m5`, the integration worktree (or isolated detached base) as `IT_W`, `IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh`, and network none. At most two job containers run concurrently, with a host-load wait above 60. Fixtures use temporary homes/data and fake providers; no live app, billable service or Mac is used.

The requested memory prelude tool is unavailable; `.ijfw/memory/` is absent.

## Completed checks and provenance

All nine requested tips required merges; none was skipped. Each reviewed tip is the second parent of its own `--no-ff` merge, in the requested order, and each final merge passed the full `pnpm typecheck` before the next merge. `final-audit.json` verifies both parent order and the requested ci author/committer identity.

The final suite used source commit `f289935cbc3a3054519714b76f66e29f26da6be3`. The later CI-only correction is `99264b1cbc64ad347ae61577f9064209b464c3f7`; it registers nine incoming regression files as blocking gates. It changes no TypeScript inputs. The nine tests referencing the conflicted gate registry were rerun after that correction. No test was dropped and no assertion was weakened. Fixture changes adapt old approval dependency names to the integrated `approvalJournal`/`callJournal` API and use the required RPC-capable journal.

The inventory has 123 files: 111 Vitest files, 11 Node files and one Playwright spec. It includes every lane's changed tests, every discovered test referencing a conflicted file, and broader HighLevel coverage also run on the base. `coverage-audit.json` reports all 123 in the result inventory and zero missing files. The browser spec's assertions are blocked at browser launch, as detailed below. Base files absent before these lanes are recorded rather than silently filtered from the merged inventory.

Raw reports, exact commands, original conflict markers/diffs, source provenance and comparisons are retained in `../evidence/`. The baseline is a detached worktree at the stated base SHA. All test containers used the requested remote runner, network none, fake providers, private fixture homes/data and at most two concurrent job containers, waiting while the shared host load exceeded 60. The Marc API fixtures launch `launchVerificationServer` and preserve control `wait`/`messages` JSON plus server logs in `current-marc-fixture-evidence/`. No live app/data, billable provider or Mac was used.

## NEW versus base

Results below use the latest result for each test identity. Node results replace the four initially conditional gate-fixture skips with the completed private-fixture executions, without double-counting repeated tests.

| Runner | Base passed / failed / skipped | Merged passed / failed / skipped | NEW failures | Inherited failures |
| --- | --- | --- | --- | --- |
| Vitest | 16800 / 43 / 28 | 17377 / 84 / 28 | 72 | 12 |
| Node | 24 / 0 / 0 | 36 / 0 / 0 | 0 | 0 |
| Playwright | 0 / 3 / 0 | 0 / 3 / 0 | 0 | 3 |

The strict test-name comparison initially finds 73 new Vitest identities. One is the renamed F0.2 historical-freeze test: the base and merged reports have the identical actual/expected digest failure. It is classified as inherited, leaving **72 NEW Vitest failures**. The exact rename and matching diagnostic are retained in `test-comparison.json`; the strict 73-name delta is also retained. Thirty-one other base failures, all in the Windows process-ownership fixture file, no longer fail. No removed test is counted as a fix.

The 12 inherited Vitest failures comprise the existing CI inventory assertion, internal vendor-name assertion, original F0.1 freeze, renamed F0.2 freeze, frozen snapshot, four RV7 negative-response cases, runtime ticket assertion and two copy-ledger assertions. These remain visible in the comparison. This integration is not an all-green release qualification; the NEW failures below remain open and are not waived.

| NEW group | Count | Finding |
| --- | --- | --- |
| Legacy calendar expectations | 63 | 10 in `calendar-review-repairs.test.ts`, 51 in `calendars-management.test.ts`, and two in `operations/calendars.test.ts` target the preserved legacy contract while expecting management selectors and operations exposed by the new opt-in contract. |
| Pipeline recovery rulings | 3 | The older MAIN positive/absence assertions supply raw pipeline collections. RULE-A now refuses unsupported collection recovery without bounded evidence, returning an unconfirmed outcome. |
| Incoming F0.1 historical freeze | 1 | The incoming enumerated F7-normalization assertion fails its historical digest pin. Both this assertion and the original MAIN digest assertion are retained with their exact expected hashes. |
| Marc acceptance gates | 5 | Buffer reconnect visibility, two No-limits command acceptance cases, chief-created seat permissions, and switching an existing conversation to No limits fail. |

### Calendar contract mismatch

All 89 tests across the three new opt-in calendar files pass: seven additive-contract checks, 63 management workflow/recovery cases, and 19 review/identity repairs. The contract test explicitly proves that the legacy block schema still rejects `originalStartTime`/`originalEndTime` while the opt-in schema accepts them. The retained legacy management tests expect those same fields to work through the legacy schema. `calendar-legacy-vs-additive.diff` and `calendar-management-legacy-vs-additive.diff` show that the paired suites differ only in their contract/fixture imports and crash-worker selection. Retargeting or skipping those assertions would hide this disagreement. The frozen default schema and MAIN's additive-only ruling remain intact; the 63 legacy-target failures are reported for follow-up.

The complete opt-in fresh-process cases preserve zero resends for accepted, foreign, negative and partial provider results. Shared payment and generic recovery remain separate guarded paths. The final run also passes all 53 contact review cases, all 122 contact crash/restart cases, all 46 bounded generic recovery cases, all 18 payment-bound cases, and both record-key I/O/budget files.

### Pipeline recovery and historical pins

`integration-rulings.test.ts` still contains the original positive pipeline witness assertion and both complete-absence assertions (`name` and `position`). The incoming bounded-recovery contract no longer takes a location-wide pre-create snapshot or reads unsupported pipeline lists. Those older raw-collection assertions therefore receive `unconfirmed` instead of a held witness or `negative_confirmation`. The code does not restore unbounded reads to satisfy them.

The F0.1 merge conflict preserves both exact digest expectations in separately named tests sharing only snapshot construction. The old raw MAIN assertion remains inherited; the incoming F7-normalized historical assertion is NEW. No freeze hash is refreshed to make a test pass. The renamed F0.2 assertion is separately recognized as the same base failure through its identical digest diagnostic.

### Marc acceptance failures

- Buffer's fake sign-in lapse leaves the connected inventory active instead of the expected `NEEDS_RECONNECT` state.
- `ssh host 'cmd'` and the commit/push/remove compound command return an approval hold (`null`) instead of automatic approval. The destructive deny-set controls remain intact.
- The chief-created seat activates with `autoApprove: true`, `fullAccess: false`, `noLimits: false`, instead of all three flags being true. The fresh control observations and server log are retained.
- Switching the existing conversation to No limits leaves one pending approval where the acceptance test expects zero.

### Copy review and CI diagnostics

The CI inventory initially grows from the base's 52 diagnostics to 61. Registering all nine missing incoming Vitest files restores the exact base set: **52 base, 52 final, zero NEW diagnostics**. `gate-inventory-comparison-final.json` records the set comparison; no file is excluded and no assertion is changed.

The two copy-ledger assertions are inherited failures, but their contents worsen: **40 base missing-review entries, 184 final, 144 NEW**. The additional entries are the 18 new payment titles in eight locales. `copy-diagnostics-comparison-final.json` records every new entry for both the persisted and rebuilt ledgers. Independent review approvals are absent; none is fabricated. Both locale/hash key sets are preserved, including existing translated Snapshot labels instead of duplicate incoming English fallbacks.

### Browser and gate-fixture limits

The German dialog spec starts its own synthetic Vite fixture, with no app/native account operations. Its three viewport cases fail before assertions because Chromium revision 1200 is absent from the prescribed container, identically on base and merged trees. They are inherited infrastructure failures and the browser behavior remains unverified. No network install or unrelated browser replacement is attempted.

The RC gate controller tests require fixed fake tool paths. The private fixture copies the gate kit into container-local temporary storage and relocates both literal and regex-escaped tool roots there, leaving every assertion intact. All 12 tests pass, and all five implementation mutants are killed. The first relocation attempt missed the escaped regex root and produced two harness-only failures; that attempt is retained, the relocation is corrected, and the final private-fixture run passes with zero skips. Unique Node results are 24 base passes and 36 merged passes.

## Attempts retained

- hlf1 attempt 1 finds incoming fixtures using old `approvals`/`calls` names. Attempt 2 is interrupted after detecting that its copied fixture predates the last wiring correction. The complete corrected typecheck passes.
- hlf7 attempt 1 encounters unresolved markers after a resolution script rejects differing duplicate Snapshot translations but its shell wrapper continues. The intermediate merge is amended before any subsequent merge; the final resolution preserves existing translated values, validates every JSON file, and passes the full typecheck. No marker remains in the committed result.
- hlc2 attempt 1 finds old fixture property names, an unused import and an impossible narrowed comparison. Attempt 2 identifies the upload fixture's non-RPC journal class. The corrected fixtures and merge code pass the complete check. All failed logs remain available.
- The focused generic/upload/payment/structure run passes 359 assertions. The calendar preflight then finds the same ten retained legacy review failures later present in the full run; its other 143 assertions pass.
- The final full suite exits nonzero with the reported failures. The CI follow-up exits nonzero only for the inherited inventory assertion and two copy-ledger assertions. Reports from both runs are retained, and repeated files use their latest result.

## Evidence, leak guard and cleanup

Evidence is retained in the job's `../evidence/` directory, including all raw JSON/JUnit reports, browser launch diagnostics, fixture observations/server logs, coverage audit, exact command records, failure identities and original conflict hunks. The unchanged shared leak guard v2 and matcher hashes are recorded. The base and mid-wave scans pass; the final committed tree is scanned again before push.

Cleanup removes job-created dependency directories, dist/native outputs, TypeScript build metadata, Python bytecode and duplicate disposable planning output, retaining their evidence copies. Tracked `build/` assets remain intact. Exact owner-label checks confirm no job containers remain; no shared cache or other job is removed. Cleanup results are recorded in `cleanup.log`.

The push is a normal non-force push to `HEAD:refs/heads/dev/1019-int19m5` in the shared bare hub `/work/mb-105-git.git`, with an ancestor check and a matching remote SHA check. This worktree owns that hub ref, so the push may report that it is already up to date. No history is rewritten on push.

## Exact NEW failing identities

- `server/highlevel/calendar-review-repairs.test.ts :: A to B reassignment accepts only B in assignedUserId: user_1`
- `server/highlevel/calendar-review-repairs.test.ts :: A to B reassignment accepts only B in assignedUserId: user_2`
- `server/highlevel/calendar-review-repairs.test.ts :: appointment.book retains original valid envelope fields in the recovered witness`
- `server/highlevel/calendar-review-repairs.test.ts :: appointment.reschedule retains original valid envelope fields in the recovered witness`
- `server/highlevel/calendar-review-repairs.test.ts :: blockSlot.update preserves a colliding original readEnvelope {"assignedUserId":"foreign"}`
- `server/highlevel/calendar-review-repairs.test.ts :: blockSlot.update preserves a colliding original readEnvelope {"contactId":"foreign"}`
- `server/highlevel/calendar-review-repairs.test.ts :: blockSlot.update preserves a colliding original readEnvelope {"success":false}`
- `server/highlevel/calendar-review-repairs.test.ts :: blockSlot.update retains original valid envelope fields in the recovered witness`
- `server/highlevel/calendar-review-repairs.test.ts :: create sends the exact requested calendar eventType configuration`
- `server/highlevel/calendar-review-repairs.test.ts :: review keeps the complete maximum-length note and its approved wire body`
- `server/highlevel/calendars-management.test.ts :: a paginated note collection allows a normal create but cannot prove a create after a crash`
- `server/highlevel/calendars-management.test.ts :: absence on a selected later note page cannot confirm deletion`
- `server/highlevel/calendars-management.test.ts :: appointment.book: fresh-process recovery (accepted) makes zero resends`
- `server/highlevel/calendars-management.test.ts :: appointment.book: fresh-process recovery (foreign) makes zero resends`
- `server/highlevel/calendars-management.test.ts :: appointment.book: fresh-process recovery (negative) makes zero resends`
- `server/highlevel/calendars-management.test.ts :: appointment.book: fresh-process recovery (partial) makes zero resends`
- `server/highlevel/calendars-management.test.ts :: appointment.cancel: fresh-process recovery (accepted) makes zero resends`
- `server/highlevel/calendars-management.test.ts :: appointment.reschedule: fresh-process recovery (accepted) makes zero resends`
- `server/highlevel/calendars-management.test.ts :: appointment.reschedule: fresh-process recovery (foreign) makes zero resends`
- `server/highlevel/calendars-management.test.ts :: appointment.reschedule: fresh-process recovery (negative) makes zero resends`
- `server/highlevel/calendars-management.test.ts :: appointmentNotes.create: fresh-process recovery (accepted) makes zero resends`
- `server/highlevel/calendars-management.test.ts :: appointmentNotes.delete: fresh-process recovery (accepted) makes zero resends`
- `server/highlevel/calendars-management.test.ts :: appointmentNotes.update: fresh-process recovery (accepted) makes zero resends`
- `server/highlevel/calendars-management.test.ts :: appointmentNotes.update: fresh-process recovery (foreign) makes zero resends`
- `server/highlevel/calendars-management.test.ts :: appointmentNotes.update: fresh-process recovery (negative) makes zero resends`
- `server/highlevel/calendars-management.test.ts :: block deletion qualifies its original host through the location-scoped user prerequisite`
- `server/highlevel/calendars-management.test.ts :: block ownership uses the original interval and the dedicated blocked-slot route`
- `server/highlevel/calendars-management.test.ts :: block updates can find the original host without sending it as a new field`
- `server/highlevel/calendars-management.test.ts :: blockSlot.create: fresh-process recovery (accepted) makes zero resends`
- `server/highlevel/calendars-management.test.ts :: blockSlot.update: fresh-process recovery (accepted) makes zero resends`
- `server/highlevel/calendars-management.test.ts :: booking waits for review with its maximum ownership references inside the five-read budget`
- `server/highlevel/calendars-management.test.ts :: calendar management through production preflight and journals: appointment.book`
- `server/highlevel/calendars-management.test.ts :: calendar management through production preflight and journals: appointment.cancel`
- `server/highlevel/calendars-management.test.ts :: calendar management through production preflight and journals: appointment.get`
- `server/highlevel/calendars-management.test.ts :: calendar management through production preflight and journals: appointment.reschedule`
- `server/highlevel/calendars-management.test.ts :: calendar management through production preflight and journals: appointmentNotes.create`
- `server/highlevel/calendars-management.test.ts :: calendar management through production preflight and journals: appointmentNotes.update`
- `server/highlevel/calendars-management.test.ts :: calendar management through production preflight and journals: blockSlot.create`
- `server/highlevel/calendars-management.test.ts :: calendar management through production preflight and journals: blockSlot.update`
- `server/highlevel/calendars-management.test.ts :: calendar management through production preflight and journals: blockSlots.list`
- `server/highlevel/calendars-management.test.ts :: calendar management through production preflight and journals: create`
- `server/highlevel/calendars-management.test.ts :: calendar management through production preflight and journals: events.list`
- `server/highlevel/calendars-management.test.ts :: calendar management through production preflight and journals: freeSlots`
- `server/highlevel/calendars-management.test.ts :: calendar management through production preflight and journals: get`
- `server/highlevel/calendars-management.test.ts :: calendar management through production preflight and journals: list`
- `server/highlevel/calendars-management.test.ts :: changed parent after review stales the held calendar request before a send`
- `server/highlevel/calendars-management.test.ts :: deletes a proved block through the same destructive dispatcher`
- `server/highlevel/calendars-management.test.ts :: event.delete: fresh-process recovery (accepted) makes zero resends`
- `server/highlevel/calendars-management.test.ts :: finds note membership beyond the former 60-note ceiling with a bounded page selector`
- `server/highlevel/calendars-management.test.ts :: full reschedule reply binds retained parents and never sends them as editable fields`
- `server/highlevel/calendars-management.test.ts :: recovery compares the calendar effect and retained identities: appointment.book`
- `server/highlevel/calendars-management.test.ts :: recovery compares the calendar effect and retained identities: appointment.cancel`
- `server/highlevel/calendars-management.test.ts :: recovery compares the calendar effect and retained identities: appointment.reschedule`
- `server/highlevel/calendars-management.test.ts :: recovery compares the calendar effect and retained identities: appointmentNotes.create`
- `server/highlevel/calendars-management.test.ts :: recovery compares the calendar effect and retained identities: appointmentNotes.update`
- `server/highlevel/calendars-management.test.ts :: recovery compares the calendar effect and retained identities: blockSlot.create`
- `server/highlevel/calendars-management.test.ts :: recovery compares the calendar effect and retained identities: blockSlot.update`
- `server/highlevel/calendars-management.test.ts :: recovery compares the calendar effect and retained identities: create`
- `server/highlevel/calendars-management.test.ts :: withholds a full reply with conflicting retained assignedUserId`
- `server/highlevel/calendars-management.test.ts :: withholds a full reply with conflicting retained calendarId`
- `server/highlevel/calendars-management.test.ts :: withholds a full reply with conflicting retained contactId`
- `server/highlevel/f01-contract.test.ts :: F0.1 adds only the two overloads; every F0 signature/schema hash survives the enumerated F0.2.4 and F7 review amendments`
- `server/highlevel/integration-rulings.test.ts :: MAIN P1 complete identity-validated absence remains not_applied: name`
- `server/highlevel/integration-rulings.test.ts :: MAIN P1 complete identity-validated absence remains not_applied: position`
- `server/highlevel/integration-rulings.test.ts :: MAIN P1 positive pipeline effect remains confirmable`
- `server/highlevel/operations/calendars.test.ts :: F4 frozen operations blockSlot.update: prepares one immutable provider request and safe receipt metadata`
- `server/highlevel/operations/calendars.test.ts :: F4 frozen operations registers all 21 calendar operations without a direct send hook`
- `server/release-marc-buffer.test.ts :: Buffer sign-in lapse becomes a visible reconnect alert and survives subsequent turns`
- `server/release-marc-commands.test.ts :: Bash compound: commit + push + remove one temporary file has zero holds`
- `server/release-marc-commands.test.ts :: Bash ssh/cd: owner No limits has zero holds for both field commands`
- `server/release-marc-seat.api.test.ts :: a seat created by a No limits chief starts at No limits after activation`
- `server/release-marc-switch.api.test.ts :: switching an existing conversation to No limits updates that conversation`
