# CHANGES round 4 (refresh of r3 `f568146add` on dev/1022 `6d4b5932a8`)

Owners: this file and DESIGN-r4.md = lane rvd-1022-row89-d6a (design refresh seat, SCOPE-1022 row 89). Producer side = D6a
builder seat (OPEN NO-OWNER); consumer side = DELEG owner (OPEN NO-OWNER); decision side = owner of `server/decision/**`;
email seams = D6b owner. Design only; nothing built or run.

r3 had 0 verdicts, so there are no review findings to map. This round re-reads every anchor on dev/1022, records what landed
(C0, C0FIX, F1, D6b admission) and what did not (F2, F3), and runs the r4 GAP-CHECK (DESIGN-r4.md section 10, "round 4").

## A. Anchor map (r3 on dev/1021 068a595c9a -> r4 on dev/1022 6d4b5932a8)
| symbol | r3 | r4 |
|---|---|---|
| `Store.messageById(..., {buildIndex:false})` | store.ts:3494-3511 | store.ts:3501-3505 |
| `Store.appendMessage` stable-id dedupe | store.ts:4264-4294, :4277 | store.ts:4317-4328 |
| `appendProjectCloseMessage` | store.ts:4240-4244 | store.ts:4291-4294 |
| `recordTaskExternalUpdate` | store.ts:5671 | store.ts:5731 |
| `settleReceipted` | delegations.ts:612 | delegations.ts:612-636 (listener inside the tx :622-633) |
| `onDelegationReceipt` single slot | (not cited) | delegations.ts:421; taken at index.ts:22662 |
| held row clears `started_at` / `holdUnexecuted` | delegations.ts:1566-1570, 2094-2113 | delegations.ts:1570, 2096-2104 |
| `settleQueuedDelegations` / `discardDelegations` | delegations.ts:1277-1284, 2139 | unchanged |
| `RESTART_RECEIPT` | delegations.ts:1509 | unchanged |
| `markTaskContextExternallyUpdated` | index.ts:14097 | index.ts:14361 |
| receipt-path source mark | index.ts:22244 | index.ts:22667-22671 |
| phone mount `phoneVerdict` | index.ts:17523-17556 | index.ts:17909-17918 |
| `directOwnerAudience` | index.ts:16172 | index.ts:16565 |
| engine permission handler (decide -> card) | index.ts:2930-2950 | index.ts:2972-2990 |
| `interruptDirectThread` | index.ts:4984 | index.ts:5069 (15 call sites; mark moved to owner Stop paths: `stopDirectThreadForOwner` 14682, Stop everything 37975, local-computer 36659, room 35592 without `queueIds`) |
| `cancelDirectTurnDispatch` | index.ts:5264 | index.ts:5347 |
| `confirmedStopGenerations` | index.ts:4941 | index.ts:3466, 3589 |
| external update carried into the prompt | index.ts:16694 | index.ts:17123 (`externalDelivery.replay`) |
| `turn-context` resume rule | turn-context.ts:258-260 | turn-context.ts:266-267 |
| `queueExternalUpdate` | external-context-delivery.ts:168 | external-context-delivery.ts:174 |
| `servePhoneTool` | service.ts:403 (C0 moves it) | phone-calls/admission.ts:23; route index.ts:31767 |
| C0 late fence in `place` | (C0 not in base) | service.ts:100-141 (`ctx.fenced`) |
| phone-turn record | phone-turns.ts:12 | phone-turns.ts:11-35 |
| email "throw = not authority" | email/admission.ts:151-153 | email/admission.ts:126-159 (catch) |
| email own-thread rule | email/admission.ts:69-71 | unchanged (`ownThread`) |
| late Approve 404/503 | decision/implementation.ts:529 | generation retirement, decision/implementation.ts:129 (builder re-proves in W13) |
| `checkPhoneCallsForDowngrade` / preserve | installation-memory-downgrade.ts:248, 257, 288-292 | :236 (probe :248), :257, :288, :417, :461 |
| F1 start hook | (F1 not in base) | index.ts:3863 `startPhoneCalls`, :41426 start step |

## B. Changes in meaning (each is a GAP-CHECK "Fixed (round 4)" item)
1. Hand-off-end nudge composed into the existing receipt listener, first statement, via `afterCommit`; never a second
   `onDelegationReceipt` (11.3; W13(h)).
2. Source-Stop mark moved from inside `interruptDirectThread` to the four owner Stop paths, incl. typed stop and Stop everything; room
   "Inject now" excluded (5.4, 11.5; W4(b) per path, W4(g)). Hand-off end `ok` excludes held receipts (11.3).
4. Opus self-review (round 4): 1 High (typed stop missing) fixed; Mediums (Stop everything, Inject now) and Lows (held `ok`, caller
   count, chip Stop scope, four anchors) fixed.
3. 5.1 exports two PK-read predicates for D6b's existing seams (11.6). No email file is edited.

## C. Unchanged
States, tables, `syncReport`, schedules, fences, copy, witnesses W1-W14 (W4(b) and W13(h) extended), fail-closed defaults, re-check gate.
