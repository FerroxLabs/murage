# O36 design rev 3: CHANGES (rev 2 a04add6312 -> rev 3)

Owners: this design lane (conv-O36-r3) owns these changes. Reviewer side: in-lane Astra convergence (ASTRA-CONV.txt), then MAIN's Fable check. Builder side: OPEN NO-OWNER O36-builder.
Sources: frev-O36-r2/FABLE-R2.txt (AGREE, 1 new High, 3 Medium, 3 Low) and arev2-dsg-O36-r2/ASTRA-R2.txt (BLOCK, 13 High). Rev 3 is a redesign of the settlement layer (DESIGN §0): three owned objects (K run outcome, H dispatch handle, R refusal obligation) replace rev 2's per-exit settleDispatch calls and split rings.

| finding | sev | disposition | mechanism | witness | mutant |
|---|---|---|---|---|---|
| Fable new-1 / Astra 9: resumed run requeued on busy/limit, re-sends prompt | High | FIXED | K3 persisted `started()` guards requeueBusy, limitWaitFor (both sites), boot requeue | W13(e) | K3 guard removed |
| Astra 1: acceptance below `if (!acceptedDirectTurn) return`; buffered reply never replays | High | FIXED | H3: h.accepted(T) right after dispatch returns (not cancelled), before the slot check; cancel/replace fenced by h closing | W12(b) | call moved back below the guard |
| Astra 2 / Fable 4: sealed lease waits on teardownConfirmed unbounded | High | FIXED | R6: the lease's quarantine deadline (`lease.quarantineReached`: 5 s timer or not-confirmed close) -> O.unconfirmedClose (row by R4, FAILED, thread retained); late confirm cannot rebuild | W14 sealed + late-confirm | R6 removed on sealed route |
| Astra 3: Stop after take("rebuild") / quiet setup cancel loses the refusal | High | FIXED | R3: take("rebuild") no longer discharges; O rides into rebuild opts; discharged by handover/freeze/unconfirmed; R4 owner-attributed evidence on O (initialised from the exact generation's confirmed owner Stop, then written by the owner's joins/Stop/Cancel), same function for adapter, sealed, rebuild catch; R5 release backstop | W9 (D2+D3, both routes, i-iv), W4 | take("rebuild") discharges O |
| Astra 4: released/uncertain row vs run error; once-marker before fallible append | High | FIXED | R2 `rowFor` returns row + line from one branch; outcome in finally; O resubmits a rolled-back row; R7 persisted row debt | W3(b) incl. append throw | settle uses refusalKind line |
| Astra 5: P6 misquoted; card case has no production source | High | FIXED | P6 quotes 02:31Z verbatim (QUESTIONS-FOR-MAIN.md:264); scheduled prompt is a stored row (index.ts:16465), card note synthetic (:16464) -> refused, FAILED | W10(a)(b) production paths | static line; settlement skipped |
| Astra 6: crash rings without MAIN approval | High | FIXED by mechanism (Q3 withdrawn) | K2 persisted `ringOwed` in the outcome commit; boot rings owed rows; stable delivery identity with durable push dedupe and the desktop durable receipt path; residue (end never saved before a crash) parked | W5 C1-C5 | boot ignores ringOwed |
| Astra 7: seatWaitRunId spread by setup/refusal retry; no first-seat stamp | High | FIXED | H2: seatGrantedAt stamped at first submission (commit before call); seatWaitRunId first-attempt only at its one registration; runSeatWait returns once started | W6(a)(b) | stamp removed / retries keep seatWaitRunId |
| Astra 8: sealed route never unbinds T | High | FIXED | H4 h.refused at O creation on both routes (lease seal beside retireProviderTurn) | W9/W14 sealed fixtures, T' early events | h.refused only on adapter route |
| Astra 10 / Fable 5: resume commit fails, run stranded | High | FIXED | K4: commit first, then seq'/handle; on throw K1 FAILED with save line, no throw to consent handler | W13(g) | seq issued before commit |
| Astra 11: callRunByTurn FIFO evicts origin | High | FIXED | H3: origin on the generation record and lease, generation lifetime | W12(g) 1,001 admissions | origin from callRunByTurn |
| Astra 12: completion save fails, no ring | High | FIXED | K1/K2: ring after commit regardless of save; ringOwed cleared in memory before recovery persists | W18 | ring gated on save |
| Astra 13: host retire/reconnect thread-keyed failThread | High | FIXED | H5 `hostEnded` captures live handles and ends each via K1; host-closed cards never resume | W17 | settle by thread |
| Fable 2a/2b: ring gated on save; extra done at needs-you | Med | FIXED | K2; W13 asserts 0 done + 1 needs-you at T1 end | W18, W13 | |
| Fable 3: held continuation persists token | Med | FIXED | stores run id; `liveHandle(runId)` at replay; unbounded hold parked (base) | W13 held variant (builder) | |
| Fable 6: run-limit interrupt vs owner Stop | Low | FIXED | R4: limit's interrupt is a host stop, row shows | W8 | |
| Fable 7: stale-seq ticket | Low | FIXED | H4 refusalOwed requires the live handle | W13(f) | |
| Astra coverage: Mac, W11 card resume, W13(d) base claim | — | FIXED | Mac request beside WINRUN; W11 lists card resume; base-GREEN claims recorded by base run or flipped to RED-first | §6 | |
| QUESTIONS Q3 | — | WITHDRAWN | replaced by K2 mechanism; residue parked | | |

Rejected: persisting handles/obligations; a backstop timer; carrying T1's seq into the resume; keeping per-exit settleDispatch calls.

## In-lane Astra convergence round 1 (BLOCK 10) -> fixes
| r1 finding | disposition | mechanism | witness / mutant |
|---|---|---|---|
| #2 sealed close can stay pending (no resolved-false) | FIXED | R6 on the lease's existing quarantine deadline (5 s timer or not-confirmed), new `lease.quarantined` | W14 sealed pending close / R6 hooked only to resolved-false |
| #3 conversation Stop skips routine; receipt not where freeze reads; host-stop close suppresses row | FIXED | R4 `ownerStop` evidence on O, written by joinRefusedStop, the Stop path and routine Cancel; conversation Stop cancels the routine via its handle before joining; host stops never write it | W8(a) attribution mutant; W9 conversation Stop and Cancel separately, mutants (b)(c) |
| #4 row durability (append failure; R6 redispatch path) | FIXED | R2 retrying refusal sink, decision held until commit; R6 freezes the row | W3(b'), W14 durable row / sink removed |
| #6 crash between ring and clear; no MAIN ruling | FIXED by mechanism | K2 stable delivery identity `routine-run:<runId>`: push `collapseId` with durable duplicate check, desktop tag; C4' cut added; C5 residue parked with scenario | W5 C3/C4/C4' / dedupe removed |
| #7 W6(a) stamp mutant cannot flip | FIXED | stamp proven separately: W6(c) rebuild setup BUSY after a written T | W6(c) / stamp removed |
| #8 no explicit sealed W1 | FIXED | W1(s) sealed rebuild with T' early events | W1(s) / adapter-only h.refused |
| #10 K4 mutant can pass | FIXED | assert live seq unchanged; mutant = failure handler removed (stranded) | W13(g) |
| #13 reconnect delayed callback | FIXED | H5 handle captured from the claim; active-claim and No Limits guards kept | W17(c) / thread-keyed |
| new 1 handover at validation | FIXED | R3 handover at boundary's successful release or unfenced invocation; H2 is the stamp only | W4(e) / discharge at validation |
| new 2 queued cancel | FIXED | K1 owner cancel keeps isOpen guard | W19 / isLive guard |
| M3 recovered ring content | FIXED | ringOwed carries kind/thread/detail; no duration receipt stated | W5 C3 |
| M4 W15 seeding | FIXED | seeded ringOwed/cleared rows, forced base save | W15 |
| L5 solo control | FIXED | W16 solo | W16 |
| Fable 3 / Fable 7 notes | FIXED | W13(h) held replay; W13(f) mutant run-id-only | W13 |

## In-lane Astra convergence round 2 (gpt-6-astra, high; BLOCK 4 High + 2 Medium) -> fixes
| r2 finding | disposition | mechanism | witness / mutant |
|---|---|---|---|
| #3 owner Stop confirmed before O exists | FIXED | R4 initialisation from the exact generation's `stopConfirmedAtFreeze` / owner-written `confirmedStopGenerations` / pending `stopInterrupts` | W9(v) / initialisation removed |
| #4 non-busy rollback never resubmitted | FIXED | R2: O resubmits any rolled-back row through the commit-aware sink with backoff; R7 persists the routine's row debt | W3(b') non-busy, no further terminal / resubmission removed |
| #6 desktop dedupe across restart | FIXED | K2: connector-reconnect's durable receipt path generalised to routine outcome frames, epoch-free key | W5 C4 real attention path incl. dismissed notice / receipt removed |
| new 1 crash at D2 sealed: no row | FIXED | R7 `refusalRowOwed` persisted; boot writes the row idempotently, fails the run with its line; nothing re-armed | W5 C1 sealed, delivery off, second restart / boot skips row debt |
| M #7 W6(c) unreachable | FIXED | W6(c) real post-write dispatch-error path with SQLITE_BUSY | W6(c) / stamp removed |
| M #13 W17(c) mutant cannot flip | FIXED | W17(c) kept as stale control (GREEN on base, stated); W17(d) active-claim reconnect | W17(d) / handle settlement omitted |
| M new 2 `quarantined` name clash | FIXED | new promise named `quarantineReached`; boolean unchanged | existing ledger-refusal tests unchanged |
| Parked note: first table superseded text | FIXED | first-table rows for Astra 2/3/4/6 synced | |

## In-lane Astra convergence round 3 (gpt-6-astra, high; BLOCK 2 High + 1 Medium; the cap) -> fixes applied after the cap, NOT re-reviewed by Astra
| r3 finding | disposition | mechanism | witness / mutant |
|---|---|---|---|
| #3 (repeat, narrowed) Stop confirmed while dispatching never reaches the receipt set | FIXED | R4 `ownerStopReceipts` (exact generation) written right after the owner interrupt resolves, before the non-dispatching guard; O initialised from it | W9(v) with handback held past the Stop / (e) receipt only inside the guard |
| new 1 row debt skipped for a terminal run | FIXED | R7 fulfils `refusalRowOwed` for every run that carries it; terminal outcome and ring state untouched | W5 C6 / live-only filter |
| M2 resend row marker | FIXED | R7 idempotence by `errorDetails` submission_refused OR `memoryNote === "resend"` for that turnId | W5 C7 / resend not recognised |
