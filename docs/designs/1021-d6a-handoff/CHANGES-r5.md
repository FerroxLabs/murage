# CHANGES round 5 (Opus redesign of r4 `8b49ab7d48` on dev/1022 `6d4b5932a8`)

Owners: this file and DESIGN-r5.md = lane design-1022-g2-d6a (design seat, SCOPE-1022 row 89, continuation of the dead
rvd-1022-row89-d6a). Producer side = D6a builder seat (OPEN NO-OWNER); consumer side = DELEG owner (OPEN NO-OWNER); decision side =
owner of `server/decision/**`; email seams = D6b owner. Design only; nothing built or run.

Verdicts mapped: ASTRA-DESIGN r4 BLOCK (`int-1021-n4/QUESTIONS-FOR-MAIN.md:4717`, 5 High, 4 Medium, 1 Low) and FABLE-DESIGN r4
AGREE (`:4713`, 4 Medium, 2 Low). No other verdict line names this lane or sha. Every finding is closed in DESIGN-r5.md; none is parked.

## Finding map

| finding | closed in | witness (mutant that kills it) |
|---|---|---|
| Astra H1: contract-1 scoped Stop (`index.ts:37935-37966`) bypasses the mark; typed stop needs active source work (`:14712-14714`) | 5.4 (i) six bot-route branches incl. contract 1; (ii) typed stop with its precondition | W4(f) one row per SITES.md site; typed-stop row sets up a running source turn (mark removed from that site) |
| Astra H2: owner proof missing; send-grant MCP (`mcp-grants.ts:148-149`) and conversation-class room route (`route-policy.ts:234`) reach the mark; host callers of `stopBotEverywhere` | 5.4 `OwnerStopProof` (two mint points); quiesce `:29512` and browser switch `:30781` do not mark | W4(h) (proof check dropped; `stopBotEverywhere` marks) |
| Astra H3: Stop write failure loses the fence on restart; never-submitted redispatch keeps the id (`delegations.ts:1566-1585`) | 5.4 primary app-DB `handoff_stop_marks` atomic with the id read; phone-DB fallback; residual (both files) parked in 10 | W4(c), (c2), (c3) (memory only; fallback removed; one table read) |
| Astra H4: F3 `refreshOne` early return (`service.ts:543-554` @ `228105308b`) + move-only-on-read pins `LIMIT 8` | 3.1 schedules: every invocation moves `read_due`, `due` excludes `read_due`, 30 s floor; 3.3 separate local and read pages | W10 stall row at N = 10 and N = 1000 (move only on counted request; shared page; no floor) |
| Astra H5: W7(a) mutant survives via due/start re-arm; W13(h) mutant survives via finalizer (`handoff-boundary.ts:359-377`) | 3.2 note; 7 W7(a) crash-boundary DB assertion with `ended = 1`, far `read_due`; W13(h1)-(h3) recovered settles + separate re-arm rows | W7(a) (re-arm after COMMIT); W13(h1)(h2) (own listener); W13(h3) (nudge after early returns) |
| Astra M1: held-notice settle sets `ended = 2`, end watch off (`delegations.ts:267`, `:1970-1977`) | 3 `end_kind`; 3.1 step 3 `ended` only from absent row; 3.2; 11.3 | W13(h4) (nudge writes `ended`) |
| Astra M2: append already emits SSE (`store.ts:4346`, `:4406`; `index.ts:8784-8786`) | 3.1 step 6 publish only on a dedupe hit | W7(b) SSE frame count (publish on fresh append) |
| Astra M3: contain first-read and retry-write failures; committed tool outcome | 3.1 steps 0 and 8, skip map | W15 (read outside try; unguarded retry; skip never expires) |
| Astra M4 / Fable M3: downgrade exit for REVISABLE / keyless debt | 5.11 probe `posted_outcome IS NULL`; 3 REVISABLE -> DONE after 30 d | W14(c)(d) |
| Astra L1 / Fable L1: `notCalled` copy for cancel/ask | 6.2 three variants, `purpose` column (5.8) | copy table; W12 deny case per purpose |
| Fable M1: scoped Stop route missing | as Astra H1 | W4(f) |
| Fable M2: which side of Stop everything marks; other `stopBotEverywhere` callers | 5.4: the route marks; quiesce and browser switch do not | W4(f) `{all:true}`, W4(h) host callers |
| Fable M4: `scripts/mcp-server.ts:1213` non-owner Stop | 5.4 proof excludes MCP access key and grants | W4(h) MCP tool rows |
| Fable L2: task-thread Stop | W4(f) task-thread row | W4(f) |

## A. New anchors read for round 5 (dev/1022 `6d4b5932a8`)
| symbol | anchor |
|---|---|
| bot interrupt route | `index.ts:37923`; contract-1 branch `:37935-37966` (`interruptDirectThread` `:37961`); `{all:true}` `:37975-37977`; direct `:37982-37992`; routine `:37998-38011`; busy room `:38015-38027` (grant refused `:38018`); legacy direct `:38037-38043` |
| `typedStopApplies` / `typedStopNow` | `index.ts:14712`, `:14719` |
| `mayApprove` / `requestOrigin` | `index.ts:29475`, `:29482` |
| `grantOfRequest` | `index.ts:2209` |
| grant send scope on interrupt | `mcp-grants.ts:148-149` |
| room interrupt policy class | `route-policy.ts:234` (conversation); local-computer `:378` (desktop); bot interrupt `:196` (conversation) |
| MCP interrupt tool | `scripts/mcp-server.ts:1206-1216` |
| `stopBotEverywhere` callers | `index.ts:22810`; quiesce `:29512`; browser switch `:30781`; route `:37977` |
| never-submitted redispatch, same id | `delegations.ts:1566-1585` |
| held-notice receipt, row kept | `delegations.ts:267` (`removeHeld`), `:1970-1977` (`recordHeldReceipt`, `noticeHeldOne`) |
| finalizer completes and wakes | `handoff-boundary.ts:359-377` |
| receipt listener recovered path | `index.ts:22662-22680` (`wakeAfterRecoveredReceipt`) |
| append emits SSE | `store.ts:4346`, `:4406`; broadcast `index.ts:8784-8786` |
| F3 `refreshOne` early returns | `service.ts:543-554` at `228105308b` |

## B. Unchanged
States other than the new `end_kind`/`purpose` columns and REVISABLE's 30-day end; the slot (5.6); fences F-MOUNT..F-DATA; Ask
preview; copy other than `notCalled*`; W1-W3, W5, W6, W8, W9, W11, W12; re-check gate (F2 and F3 still not in dev/1022).

## C. Opus self-review (round 5, read-only, foreground; 0 Critical, 0 High, 5 Medium, 5 Low; all fixed in DESIGN-r5.md)
| item | fix |
|---|---|
| M-a W13(h3) asserted `due` = settle time against the 30 s floor | assert `updated_at`, `ended != 0` and the line at settle time, timers frozen |
| M-b W15 / W10 committed-result case never reached `syncReport` on a successful create | driven by a definitive create failure (re-arm in tx, `syncReport` in the tool call) or `result` |
| M-c room Stop marked `body.threadId ?? group.threadId`, the route interrupts `targetThreadIds` (`index.ts:35635-35639`) | mark every interrupted thread plus the main thread, beside `markSendsStopped` `:35656` |
| M-d W4(f) routine and legacy rows not drivable | routine row set up with a busy room; legacy branch UNREACHABLE in SITES.md |
| M-e keyless `abandoned`/`ended` PLACED rows refuse downgrade (base probe `:248` passes them) | intended (D4), existing copy `electron/recovery/messages.js:99` fits, Delete clears; ARMED rows of live hand-offs do not refuse (W14(e)(f)) |
| L-a..L-e | W10 stall fixture buildable and per-N bound; floor mutant dropped; no in-process double publish; `end_kind` wording in 11.3; `handoffStartedNow` reads the Stop marks |
