# O36 design rev 4: CHANGES (rev 3 4fa1e38896 -> rev 4)

Owners: this design lane (conv-O36-r4) owns these changes. Reviewer side: in-lane Astra convergence (ASTRA-CONV-r4.txt), then MAIN's Fable check. Builder side: OPEN NO-OWNER O36-builder. Follow-up slice O36b: OPEN NO-OWNER O36b-builder.
Sources: conv-O36-r3/astra-r3.txt (BLOCK 2 High + 1 Medium, fixed after the cap in 4fa1e38896, not re-reviewed by Astra) and fchk-O36-r3/FABLE-R3.txt (BLOCK, 1 new High, 2 Medium, 3 Low).

## Open Critical/High at the start of rev 4
| finding | sev | disposition | mechanism | witness | mutant |
|---|---|---|---|---|---|
| Astra r3 #3 (R2 #3): owner Stop confirmed while sendTurn has not handed back never reaches the receipt; O inits pending; row shown | High | CLOSED in 4fa1e38896 (Fable R3 checked; Astra to confirm in r4 round 1) | R4 `ownerStopReceipts` written when the interrupt result resolves, before the non-dispatching guard (index.ts:5062); O inits from it | W9(v) with handback held until after Stop returns | (e) receipt only inside the release guard |
| Astra r3 new #1: row debt skipped at boot once the run is FAILED | High | CLOSED in 4fa1e38896 (Fable R3 checked; Astra to confirm) | R7 fulfils refusalRowOwed for every run whatever its status; terminal outcome and ring untouched | W5 C6 (delivery off, second restart) | live-only debt filter |
| Fable R3 #1: K3 stops the shipped SL-I I3 plan-limit wait for every run that reached the engine | High | FIXED (rev 4) | K3 limit rule: queue only if not resumed AND the I1 no-activity test (index.ts:15463) / plan-limit message AND !h.activitySeen; the wait clears seatGrantedAt in its save; busy/boot keep started() | W20 (a)-(e), server level with real startTurn; W13(e) resumed limit still FAILED | started() guard on the limit sites; activitySeen ignored; stamp not cleared |

## Recurring finding -> scope cut
Stop-vs-refusal recurred in every round (Astra r1-5, r2-3, r3-3) and Fable R3 #2 found that it also changed ordinary conversations. Rev 4 creates the RefusalObligation only for routine generations (with a handle). Ordinary conversations keep today's code unchanged. The JOINT RULING change for them moves to follow-up slice **O36b** in the same train (dev/1021, owner OPEN NO-OWNER O36b-builder). W9(vi) asserts that ordinary turns match the base byte for byte; mutant (f) creates O without a handle.

## Medium / Low
| finding | sev | disposition |
|---|---|---|
| Astra r3 M2: resend marker | Medium | CLOSED in 4fa1e38896 (R7 exact markers, W5 C7) |
| Fable R3 #2: R1/R4 change ordinary conversations' rows | Medium | FIXED by the scope cut (above) |
| Fable R3 #3: boot re-ring repeats the peer incident report | Medium | FIXED: K2 `onRunFailed(run, { recovered: true })` skips reportTeamIncident; W5 C3/C4 count incident reports; residue Parked |
| Fable R3 #4: semantics of a failed cancel save | Low | STATED in K1 (CANCELLED in memory, no restore; unsaved-end residue Parked) |
| Fable R3 #5: confirmed Stop then crash before the debt-clear save shows a row | Low | PARKED (one save wide; fails toward a visible row) |
| Fable R3 #6: H2 moves the run-limit clock | Low | STATED in H2 |

## Astra r4 round 1 (BLOCK 2 High + 1 Medium) -> fixes
| finding | sev | disposition | mechanism | witness | mutant |
|---|---|---|---|---|---|
| r4-1 #1: buffered first-turn limit terminal replays after onDirectLimitTurnCompleted deleted the LimitTurn | High | FIXED | K3: routine turn's settled LimitTurn kept on h (`keepLimitTurn`, one record, dropped on close/rebind); routineLimitRefusal reads the live record only for the exact turn id, else h's record; neither -> FAILED | W20(a') handback held past the completion microtask | keepLimitTurn removed |
| r4-1 #2: settle-site limit wait ignores assistant text (textActivity is not activity) | High | FIXED | K3: h.textSeen; settle site requires !activitySeen && !textSeen; terminal site keeps I1's refusal-text rule | W20(c') reply then reject -> FAILED; W20(c'') relayed refusal text control -> QUEUED | settle ignores textSeen |
| r4-1 #3: W20(d) activitySeen mutant cannot flip (I1 rejects by itself) | Medium | FIXED | W20(d') tool then plan-limit rejection makes activitySeen decisive; (d) kept as control | W20(d') | activitySeen ignored at settle |

## Astra r4 round 2 (AGREE, 1 Medium) -> folded in
| finding | sev | disposition | mechanism | witness | mutant |
|---|---|---|---|---|---|
| r4-2 M1: exact-turn lookup but thread-wide limitTurns.end deletes a later turn U's record | Medium | FIXED | K3: end the live record only when it is T's | W20(a') variant with U admitted before replay | unconditional end(threadId) |
