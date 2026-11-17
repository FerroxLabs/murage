# L8 provenance: Slice 0

Base: `c12aaad9341e8f87126a193f35b5c2768f0aa66f`. Branch: `dev/1019-l8r0`.
Authority: `/fixture-home/orph/_ev/designs/RULING-l8-1019.md`, which closes the objections in `odes-l8/last.txt` and `odes2-l8/last.txt`. No later lane review was present when seated. `hl-amend.md` and `hl-refs.md` were read: their HighLevel contracts do not change this turn-state slice; no HighLevel implementation is duplicated here.

## Reused source and conflicting reports

- L4B semantics/reference: `571b3212bfea06d2d00b14cdc5b902fa80cafd1b`. This later tree lacks the L13 fixture, port and lifetime files; do not replace the matching historical fixture with it.
- Matching packaged fixture source: `19ef45264b846f5b625e5f00943ca238fda39e0d` (q12). Comparison source: `5b0a0a1eb946b084ea276b1f6889efab5d2e1717`. Differences are the sign-out opening/draft fix, ownerApi seam, scoped grant/splash/clock/spec stabilization, production-config exclusion and documentation. The complete diff is retained in `.l8-artifacts/l13-source.diff`.
- The ORPHAN-PLAN report says rows 5/8 NOT FIXED and the packaged spec never ran. The later historical handoff reports q12 ALL 15 PASS. Both are retained; neither establishes acceptance on c12aaad93 or this branch. Original q12 output is retained as `.l8-artifacts/historical-q12.log`.
- M2 history/test source: `13315e2a7089360b06d0db253b7e329f8187c2db`; r1.3 remains rejected. Its review is `/fixture-home/orph/l8/evidence/M2-astra-r13.md`. No M2 implementation is ported by Slice 0.
- F7 proposal: `304e59c7b52f0be873172337d0eb8501c489d62f:designs/L4B-F7-SEND-FAIL-1018.md`; its callback-only approach remains blocked. Exact original review: [F7-review-original.md](F7-review-original.md), recovered by the ruling from session `01a1b328-c04b-7992-864f-f0ac07558596`.
- `29f17944b` is proof provenance only; `7c5cbfc3e` remains an unverified historical pointer. No historical branch is merged wholesale.

## Every original F7 finding

Mapping recovered does not mean behavior implemented or verified. All tests below belong to later slices.


| F7 item | Contract paragraph in DESIGN-r2 | Named tests |
|---|---|---|
| 1 High: all definitively unsubmitted failed lines (ordinary and lateRefused) leave replay | section 3.1 `send_replay_exclusions` (every new attempt starts excluded), section 4 | F7-REPLAY, F7-WARM, F7-COPY |
| 2 High: ACP setup failure after a returned turn id bypasses onDispatchError | section 3.3 shared terminalizer (ACP setup failure, background failure after `startTurn`) | F7-SETUP (rejected dispatch and accepted ACP turn whose setup later fails) |
| 3 High: late rebuild terminal (`settleWithCard`) never settles the batch | section 3.1 binding epochs, section 3.3 "final rebuild exhaustion" | F7-REBUILD (exhaustion, rejected redispatch, Stop during rebuild) |
| 4 High: restart skips started/failed rows | section 3.3 Restart row | F7-CRASH at every committed boundary |
| 5 High: Stop and drain gap lets another turn replay a not-yet-failed line | section 3.3 Stop row, section 3.1 "begins excluded" | F7-STOP-GAP, STOP-AWAITS |
| 6 High: pruning erases retry and exclusion facts | section 3.4 pruning paragraph | F7-PRUNE, F7-DELETE, F7-RESTORE |

### Medium/Low findings (items 7 to 14): new binding decisions

Each row is now F7-ML1 to F7-ML8 in the provenance manifest.

**F7-ML1 (item 7, Medium): room routes.** Anchors on base: `server/channel-queue.ts:13` (owner_sends channel drain), `server/index.ts:28531-28593` (group POST route reopens failed/refused rows and calls `sendStore.retire(stale.seq)`).
Decision: the receipt rule is universal. (a) The owner_sends channel drain creates and settles attempts only through the section 3 terminalizer; room question-card answers ride the same path. (b) The group POST route no longer reopens or retires a failed or refused row by itself: a same-ID request returns the immutable receipt (as for bots); an explicit resend uses the group action route in R2 below. `sendStore.retire` may not be called on any row whose attempt has a linked line. Owner: A1 adds `server/channel-queue.ts` and `server/channel-queue.test.ts`; the `server/index.ts` group-route change is a patch to I.
Tests: `F7-ML1-GROUP-SAMEID` (same-ID retry after a failed-with-line group send returns the receipt, no rerun, no retire), `F7-ML1-GROUP-RESEND` (explicit group resend creates exactly one replacement), `F7-ML1-CHANNEL-DRAIN` (channel drain failure settles the attempt and excludes the line).

**F7-ML2 (item 8, Medium): give-back path may leave no explanation.** Anchor: `server/index.ts:14596-14604` `giveBackAdmittedTurn(..., onDispatchError)`.
Decision: the terminalizer owns the explanation. On a terminal failed or refused outcome it checks whether an activity explanation already exists for `(attempt_id)`; if not, it writes exactly one, keyed by `(attempt_id, terminal_revision)` so repeats are no-ops. The receipt commits first; the explanation is an owed effect of kind `publication` in `turn_cleanup_owed`, retried if writing throws. A thrown explanation never blocks or reverses settlement.
Tests: `F7-ML2-GIVEBACK-LINE` (give-back path with no prior line produces exactly one line), `F7-ML2-LINE-THROWS` (writer throws; receipt still terminal; line appears on the owed-effect retry), `F7-ML2-NO-DUPLICATE` (setup already wrote its line; none added).

**F7-ML3 (item 9, Medium): an existing failed receipt answers as success.** Anchor: `server/index.ts:16670-16682` (`accepted.kind === "match"` returns `{ok:true, ...steered}` whatever the row's state); `src/state/send-delivery.ts` treats that as acknowledged; the Help callback in `src/state/store.tsx` gets no failure field.
Decision: a same-ID retry whose attempt is terminal and not completed returns `200 {ok:false, existing:true, threadId, receipt:{state, attemptId, receiptRevision}}` where `state` is the section 5.2 wire state (`failed`, `refused`, `removed`, `stopped`, `unknown`). `send-delivery.ts` treats `existing:true` with a terminal non-completed receipt as definitive: it stops retrying and hands the receipt to the caller; the Help reader receives `failure: receipt.state`. Completed or in-flight receipts keep today's `ok:true` shape.
Tests: `F7-ML3-LOSTACK-E2E` (server route, real `send-delivery.ts` outbox and real store reducer: first POST commits then the response is dropped; the retry gets the failed receipt; Help shows the failed state and Send again), `F7-ML3-COMPLETED-UNCHANGED`.

**F7-ML4 (item 10, Medium): a cancelled receipt maps to missing.** Decision: the Help receipt mapper maps a confirmed cancelled receipt to `removed`, never `missing`; the server's turn-state check for a cancelled attempt runs before any missing-messageId return. Owner: A3 (Help UI) and B1 (`server/ask-turn-state.ts`).
Tests: `F7-ML4-ACKED-QUEUED-REMOVE` (acknowledged queued send removed on another surface shows Removed and stops following), `F7-ML4-LOSTACK-AFTER-REMOVE` (lost acknowledgement retry after removal returns removed).

**F7-ML5 (item 11, Medium): sends without a send id stay started.** Decision: `send_id` is never null. When a request has no client sendId, the server mints `srv-` plus a UUID inside the acceptance transaction and returns it. Batch settlement is keyed by the attempt ids captured on the binding at queue selection, never by looking up a transcript line's sendId.
Tests: `F7-ML5-ANON-BATCH` (batch of one client-id send and one anonymous send fails; both attempts terminal and excluded), `F7-ML5-ANON-RETURNS-ID`.

**F7-ML6 (item 12, Medium): exclusion query scale.** Decision: replay eligibility is evaluated only for the bounded replay candidate set, one primary-key lookup per candidate on `send_replay_exclusions(thread_id, message_id)`. No query scans failed rows or `owner_sends` by status for replay.
Tests: `F7-ML6-QUERY-PLAN` (EXPLAIN QUERY PLAN shows `SEARCH send_replay_exclusions USING PRIMARY KEY`, no SCAN), `F7-ML6-FAILED-ROWS-INVARIANT` (lookup count identical with 0, 10,000 and 100,000 failed rows in the thread).

**F7-ML7 (item 13, Medium): test honesty.** Decision: every test in DESIGN-r2 section 10 carries a label in `evidence/l8-baseline.md`: RED-ON-BASE (fails on base for the stated defect) or GUARD (passes on base and protects existing behavior). Known GUARDs: Help retry budget reset after a successful load; same recorded `actionId` returning `existing`. F7-REPLAY must force replay into a fresh session (not a resumed one). UI tests must exercise the callback wired by the mounted component, not a source assertion.
Test: `F7-ML7-LABELS` is a check in Slice I that every section 10 test has a label and every RED-ON-BASE test was observed failing on base.

**F7-ML8 (item 14, Low): state-table accuracy.** Decision: DESIGN-r2 section 3.1 already says a `dispatchedIn` stamp never proves delivery. Add to section 3.4 migration: legacy `started` plus `dispatchedIn` imports as `delivery=uncertain`, never `submitted` and never `failed-not-submitted`. Legacy replacement rules (fingerprint, restore, Stop and action-token checks in `server/send-store.ts:606-616`) remain the guard for legacy flags (see R2).
Test: `F7-ML8-LEGACY-DISPATCHED-IMPORT`.


## Slice boundary

Slice 0 recovers the packaged harness and records baseline/provenance only. Slice I0 owns schema and shared types. A3 owns current HelpPanel/store/Composer integration and the new receipt contract. B3 owns L13 mutations after baseline; I owns combined-head proof. L13 rows 5 and 8 remain **NOT FIXED**. M8e is expected GREEN equivalence, never a fabricated mutation RED.

No decision for Sean is needed in this slice. Final independent reviews, MAIN disposition and the design's cross-platform/real-engine proof remain release requirements.

## Current-tree recovery adaptations and provisional interfaces

The matching 19ef45264 fixture/spec/port/build scanner were reused, not redesigned. HelpAsk.tsx retains its historical behavior and inlines the unchanged historical lifetime helpers because the separate lifetime file is not in Slice 0's ownership. It retains the historical main-pack copy lookup locally; A3 owns wiring it into the current Help copy/store/receipt contracts. Current HelpPanel continues to use its existing fallback.

**PROVISIONAL INTERFACE** in help-ask-port.ts: the narrow historical send/cancel callback action shape used by this recovered fixture, until A3 implements its store interface. No runtime capability is advertised. **PROVISIONAL INTERFACE** in HelpAsk.tsx: read the optional historical dispatchedIn stamp only when it is an actual string, without modifying the shared Message type or inferring a current turn. These are compatibility boundaries for recovery, not replacements for frozen F4/F6.

The human config uses current `evidenceDir`; the spec places scratch profiles under `evidenceRoot` and waits for the seeded Chief snapshot. The baseline historical product/package is unchanged. The packaging scanner is inserted into package:prepare; the existing CI budget workflow is outside Slice 0 and was not edited. The recovered test asserts the owned packaging/default-config/release-mode boundaries.
