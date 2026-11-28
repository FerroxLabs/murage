# CHANGES round 3: DELEG D6a hand-off producer (DESIGN-r3.md supersedes DESIGN-r2.md)

Owners: design lane conv-I20-r3 (this file). Producer side: D6a builder seat (OPEN NO-OWNER). Consumer side: DELEG owner
(OPEN NO-OWNER). Base `dev/1021` @ `068a595c9a`. Inputs: r2 `881273f5f3`; FABLE-DESIGN-R2 I20 (AGREE, 10 findings); ASTRA-DESIGN-R2
I20 (BLOCK, 12 findings). Third round, so the clustered mechanisms are redesigned, not patched (DESIGN-r3 §2): one obligation row per
hand-off (`handoff_reports`), one synchronous writer (`syncReport`), re-arm inside the causing transaction, hand-off end read from
DELEG's durable state.

| finding | sev | status | where in DESIGN-r3 | witness / mutant |
|---|---|---|---|---|
| Astra 1: source-turn Stop not identity-bound | High | FIXED: queuing turn bound by STOP1 (base rule named); later source-chat Stop writes `handoff_stops` for the exact live hand-off ids at the press, read by `handoffLiveNow`; restart/redispatch-safe | 5.4, 5.1 | W4 (a)-(e); mutants drain-on-stop, mark removed, memory-only marks, F-PLACE recheck dropped |
| Astra 2: slot and intent not one transaction; preview differs from placement; cross-source duplicate | High | FIXED: slot UPDATE + D5 insert in one `BEGIN IMMEDIATE` via F2 `within(tx)`; `placementDecision` shared by `askPreview` and F-PLACE, D5 `sameRequest` card for non-new decisions; W5(e) same-bot different-source | 5.5, 5.6 | W5 (e)(f)(g); mutants slot outside tx, preview skips decision |
| Astra 3: W5 mutant leaves PK; W5(c) vs D5 Delete | High | FIXED: mutant keys the slot by request identity (rephrased retry -> 2 creates); W5(c) asserts D5's `not_set_up`, 0 creates | 5.6, 7 | W5 (a)(c) |
| Astra 4: D6a read share starvable; result path hides reads; keyless restart | High | FIXED: own 4-request allowance per pass counted at `phoneVendorFetch` (tagged); `refreshOne` without `reconcilePending`; pass starts without a key (store open is constant time) | 3.3 | W10 (backlog, keyless terminal row); mutants pass gated on key, allowance not counted at fetch |
| Astra 5: `unclear` frozen though D5 upgrades it | High | FIXED: REVISABLE state; one `correction` line under its own stable id; D5 writes re-arm it; automatic `refreshOne` reads continue (6 h, then daily, no end); posted state read from the lines themselves so a crash cannot swallow the correction | 3, 3.1, 6.1 | W8 (late `done` after grace); mutant REVISABLE as DONE |
| Astra 6 / Fable 3: no append-failure witness beside healthy rows | High | FIXED: W10 case (busy twice on one row, two healthy rows, committed tool result) | 3.1 step 7 | W10; mutants shared try, rethrow, attempt cap |
| Astra 7 (r2 numbering "Astra 8"): index build reads history; downgrade drops owed | High | FIXED: new empty tables, `phone_calls` not altered, no backfill; downgrade refused while `done = 0` with existing `PHONE_CALLS_PENDING`; full-route W14 | 5.11 | W14; mutants probe clause removed, migration reads `phone_calls` |
| Astra 8 / Fable 1 (r1): discovery stops at day 7 | High | FIXED: daily reads with no end while not final; key save re-arms; no owner refresh needed | 3.1, 3.2 | W11 (key back day 9, unreadable to day 12) |
| Astra 9 / Fable 2 (r1): no durable "no call" obligation; approval binding | High | REDESIGNED: obligation armed before the card (F-ASK) or tool (F-CALL); `notCalled` decided from the absent hand-off row; approval records no longer read | 5.7, 5.8 | W13 (a)-(g), W12; mutants arm removed, keyed on approval records |
| Astra 10: resumed engine may not see the line | High | FIXED: `markTaskContextExternallyUpdated` per posted line, idempotent (`queueExternalUpdate`) | 5.9 | W6 positive + crash case |
| Astra 11: interim writer races final/Delete | High | FIXED: the pass never writes; `syncReport` decides interim lines from fresh reads; CAS on flags | 3.1, 3.3 | W8, W9 |
| Astra 12: terminal debt with NULL due after crash | High | FIXED: re-arm inside the same CallStore transaction; CHECK `done = 1 OR due IS NOT NULL` (no parked state); start re-arms rows not yet seen ended | 3.1, 3.2 | W7 (a); mutant re-arm outside tx |
| Astra 7 note (r2 "closed"): honour `has_reference`, omit time when absent | - | FIXED in copy | 5.10, 6.1 | W6 |
| Fable 1 (r2): Stop/restart after placement silent for days | High-cand. | FIXED: `placedPending` when the hand-off ended not ok or the call is scheduled > 10 min ahead | 5.7, 6.2 | W13 (f) |
| Fable 2 (r2): promise wider than mechanism (No limits, Allowed-not-run, open records) | Med-High | FIXED by the Astra 9 redesign | 5.7, 5.8 | W13 (b)(d)(e) |
| Fable 4 (r2): wrong downgrade claim | Medium | FIXED with Astra 7 | 5.11 | W14 |
| Fable 5 (r2): Stop read has no source | Medium | FIXED: three Stops named with exact state read; `confirmedStopGenerations` explicitly not used | 5.4 | W4 |
| Fable 6 (r2): budget has no interval | Medium | FIXED: >= 30 s between passes, 4 D6a requests per pass | 3.3 | W10 |
| Fable 7 (r2): create failure consumes slot | Low | STATED as intended | 5.6 | - |
| Fable 8 (r2): final rows with NULL due unswept | Low | FIXED with Astra 12 | 3.2 | W7 |
| Fable 9 (r2): waiting copy when no key | Low | FIXED: `waitingNoKey` | 6.2 | W11 |
| Fable 10 (r2): slot pruned at 30 d | Low | FIXED: DONE rows pruned only after their hand-off row is gone | 3.3 | - |
| r2 Fable 4 base exposure; D5 K2 scope; Sean Q1 | - | ROUTED / PARKED unchanged | 5.2, 10 | - |

Removed from r2: the `phone_calls` report columns and partial index; `handoff_calls`; the `approval_records` read in the DELEG hook;
the shared D5/D6a budget; `READ_UNTIL` stop of discovery; the claim that downgrade keeps obligations.

## In-lane Astra convergence (ASTRA-CONV.txt)

| Astra conv finding | sev | status | where | witness / mutant |
|---|---|---|---|---|
| R1-1 (repeat Fable 1): lost end nudge delays `placedPending` until dial time | High | FIXED: two schedules; `due` includes a 60 s end watch while the hand-off is not seen ended; start re-arms those rows | 3.1 (two schedules), 3.2 | W7(c) with a call 3 days ahead; mutant end watch tied to `read_due` |
| R1-2: REVISABLE rows got no automatic reads | High | FIXED: `refreshOne` allowed for REVISABLE (D5 owner-refresh re-read), 6 h then daily, no end; no parked state | 3.1, 3.3 | W8 (late `done` day 1 and day 9, no refresh); mutant no reads for REVISABLE |
| R1-3: downgrade clause missed debt with empty `phone_calls` | High | FIXED: separate probe statement on `handoff_reports` | 5.11 | W14(b); mutant nested probe |
| R1-4: outcome id across append-to-CAS crash | Medium | FIXED: posted state read from the stable-id lines; outcome payload marks revisable | 3.1 step 2 | W7(e) |
| R1-5: witnesses for late entrant under sustained D5 work, refresh/Delete during read, > 1 page recovery | Medium | FIXED | 7 | W10, W8, W7(d) |
| R1-6: W11 vs `placedPending`; W4(c) redispatch of accepted work | Medium | FIXED: W11 expects one `placedPending`; W4(c) uses a parked hand-off | 7 | W11, W4(c) |
| R1-7: re-registration after consumption | Low | STATED: one repeated external-update line in that crash window; accepted | 5.9 | - |
| R2-1 (Astra 4 fairness): skipped reads had `read_due` advanced, starving rows | High | FIXED: `read_due` written only by an actual attempt (plus place, REVISABLE transition, key save); eligibility read before `syncReport`; unread rows keep their past `due` and sort first; `due` ignores `read_due` without a key | 3.1, 3.3 | W10 (8 eligible rows, 4 allowance: rows 5-8 read next pass); mutant `syncReport` recomputes `read_due` |
| R2-2: recovered line still needs registration/publication | Medium | FIXED: step 6 also replays lines found without their flag | 3.1 step 6 | W6 crash case |
| R2-3: `messageById` may build the history index | Medium | FIXED: `{ buildIndex: false }` point lookup | 3.1 step 2 | W10 (large conversation) |
| R2-4: constants and miss counter unnamed | Low | FIXED: constants listed; `read_misses` column | 3, 3.1 | - |
| R3-1: no finite due when no deadline remains | Medium | FIXED: `now + 24 h` idle wake; posted/inapplicable deadlines excluded | 3.1 | - |
| R3-2: key save read before a scheduled call's time | Medium | FIXED: `read_due = max(now, anchor + GRACE)` on key save | 3.1, 3.2 | W10 (key saved the day before) |
| R3-3: loaded-thread append scans loaded messages | Medium | NARROWED: cost claim limited to the phone DB; the app append costs what any base status line costs | 3.3 | - |
| R3-4: `read_due` wording | Low | FIXED | 3.3 | - |

