# CHANGES round 2: DELEG D6a hand-off producer (DESIGN-r2.md supersedes DESIGN.md)

Owners: design lane d6a-design-1021-r2 (this file). Producer side: D6a builder seat (OPEN NO-OWNER). Consumer side: DELEG owner
(OPEN NO-OWNER). Base `dev/1021` @ `ce13438869` unchanged. Inputs: round 1 `28a16617b6`; FABLE-DESIGN I20 BLOCK; ASTRA I20 BLOCK.

| finding | sev | status | where in DESIGN-r2 | witness |
|---|---|---|---|---|
| Fable 1: scheduled call declared lost after ~135 min (12 misses x 15 min cap), real result dropped; first due undefined | High | FIXED: anchor = max(createdAt, when); due persisted in the INSERT (+CHECK); no read or miss before anchor; no miss limit; no "lost" outcome; one interim `waiting` line at anchor + 24 h; the real result is reported whenever any D5 writer lands it, even after reads stop at anchor + 7 d | 3, 5.6, 6.2 | W11 (rewritten), W1 |
| Fable 2: Ask card outlives the delegate's turn | High-cand. | FIXED after tracing base: the card is an engine permission bound to the turn generation; turn end settles it cancelled/expired and renders it closed; a late allow is a no-op (implementation.ts:529) and returns 404/503; no call can be placed. Gap was silence in the asking chat: new `notCalled` line from one hand-off-end hook in `settleReceipted`; honouring under a fresh fence rejected | 5.8, 6.2 | W13 (new) |
| Fable 3: built on code not in base | Medium | FIXED as process: re-check gate, RE-ANCHOR.md as the builder's first commit; a changed meaning is a design question | header, 9 | - |
| Fable 4: base phoneMount exposure needs an owner now | Medium | ROUTED: QUESTIONS.md asks MAIN for an owner of a RED witness on dev/1021 | 5.2, 10 Parked | - |
| Fable 5: K2 scope | Medium | ROUTED: MAIN records K2 answered for the delegated path only | 10 Parked | - |
| Fable 6: wrong downgrade gate named | Low | FIXED: `preservePhoneCallsForDowngrade` (installation-memory-downgrade.ts:257, :288, :461) | 5.3 | W14 |
| Astra 1: held/Stopped hand-off passes the live predicate; result read after hand-off unowned | High | FIXED: `started_at IS NOT NULL`, start identity (turn_key, start_attempts), accepted turn, held-or-confirmed Stop refuses, check+INSERT with no await; result read only for the hand-off's own call | 4, 5.1, 5.4 | W2, W3, W4 |
| Astra 2: rephrased retry creates a second call; liveByIdentity cross-attach | High | FIXED: `handoff_calls` slot (PK handoff_id) in the same section as the INSERT; `already_called`; no cross-owner reuse (`duplicate_live`); survives owner Delete | 5.5 | W5 |
| Astra 3: W5 boot redispatch unreachable; W2 mutants overlap | High | FIXED: reachable in-turn lost-reply repeat + concurrent + Delete cases; boot cases asserted separately; isolation rule (producer vs consumer boundary fixtures) | 5.5, 7 | W2, W5 |
| Astra 4: NULL due; misses spent before schedule; no deadlines, single flight, shared budget, credential loss; scale | High | FIXED: persisted due, post-anchor misses only, 10 s read deadline, single-flight timer clamped to 1 h, shared 8-read budget (D6a <= 4 when D5 has work), no-credential behaviour, 0/1/100 bots | 5.6 | W10, W11 |
| Astra 5: reports on first "ended"; stale snapshot vs refresh/Delete | High | FIXED: D5 `isFinal`; fresh re-read at one synchronous report boundary | 3 | W8, W9 |
| Astra 6: append failure strands/hogs; dedupe hit no SSE; tool error after committed action | High | FIXED: per-row retry with backoff and isolation, no cap; publish on dedupe hit; reportCall never throws to the tool | 3 | W7, W10 |
| Astra 7: `when` used as booked time; untrusted business label; free-text reason | High | FIXED: D5 validated result time, `bookedNoTime`; validated label or approved number; enum reason copy; W6 adds adjacent free-text sentinels and the real SSE payload | 5.7, 6.1 | W6 |
| Astra 8: index scan cost; downgrade loses OWED; platforms | High | FIXED: user_version-guarded idempotent migration, stated one-time O(calls) cost; downgrade keeps columns and obligations, resumes on re-upgrade (refusal parked); Windows/macOS rows via WINRUN/Mac relay | 5.3, 7 | W14, W7, W11 |
| Astra dependency notes (C0 held, owners, Q1, D6b note) | - | Carried: C0 before F1-F3 (9); owners OPEN NO-OWNER (header); Q1 unchanged; D6b note dropped from this design (D6b's own lane) | header, 9 | - |

Witness list changes: W2 +4 cases; W3 +ownership; W4 held and confirmed Stop; W5 rewritten; W6 widened; W7 +SSE, kill -9; W8 +isFinal,
races, create failure; W10 +fairness, deadline, credential; W11 rewritten (scheduled); W13 new (Ask card after turn end); W14 new
(migration/downgrade).
