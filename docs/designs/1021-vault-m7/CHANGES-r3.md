# VAULT-M7 part 1: CHANGES r2 → r3

Owners: VAULT-M7 design convergence lane r3 wrote this table (design side); the VAULT-M7 builder lane (OPEN NO-OWNER until MAIN seats it) owns building each mechanism and making each witness RED then GREEN and each mutant RED; Fable and Astra own the verdicts.

Every finding of Fable r2 (`frev-UPVAULT-r2/FABLE-R2.txt`) and Astra r2 (`arev2-dsg-UPVAULT-r2/ASTRA-R2.txt`). Sections, decisions (D), witnesses (W) and fences (F) refer to DESIGN-r3.md. "By construction" means the r3 redesign removes the surface the finding is about; the witness then proves the surface is absent or bounded.

## Critical and High

| Finding | Sev | Mechanism (DESIGN-r3) | Witness | Mutant (must turn the witness RED) |
| --- | --- | --- | --- | --- |
| Fable r2 #1: uncertain write later KEPT is undone by the next sibling save (stale `current`) | High | Writer reconcile inside the same queue job: readBack, adopt the file as `current`, then a durable re-persist before KEPT (a page-cache read alone never confirms); DIVERGED refuses all writes and leases until that succeeds (D21, 5.3, V1, V4) | W6b, W6d | reconcile removed (current stays previous); DIVERGED not entered; KEPT on readBack without re-persist |
| Fable r2 #2: a read overtakes the write it judges; timer makes NOT_KEPT then the write lands | High | Main is the only decider (D2, D22); status and index are queue jobs (M4, M5); server timers only display "Not confirmed yet"; an app restart ends main's queue, so boot answers are final (5.4) | W6e, W5, W6 | status answered outside the queue; server timer produces NOT_KEPT |
| Fable r2 #3: `vault_run` runs commands outside the bot's containment | High | By construction: no command delivery in part 1 (D4); `vault_fetch` reaches only owner-pinned origins on public addresses (F15); no per-call prompt needed because the owner's pinned grant is the authority (D20); part-2 command contract requires Murage-owned containment (11.1) | W2b, W29, W3 (process rows) | origin check removed; lookup hook removed; value placed in a child/env |
| Astra r2 #1: ungranted same-login bot can read Vault material (live recipient, store key) | Critical | By construction no live local recipient exists (D4): no child, env, pipe or file ever holds a value. The remaining same-user path (OS store key, Windows process memory) is exactly the one that covers every provider key today; stated as R1 and asked as a NEW acknowledgement (Q1), not presented as already accepted | W29 (two same-login bots, B at Full access on its real engine, positive control), W3 | value placed in any env/argv/file/child |
| Astra r2 #2: free-form command lets the model recover the secret / write plaintext into the workspace | Critical | By construction: the model chooses neither program nor slot; the recipient is the owner-pinned origin, the value goes only in the pinned slot (reserved headers, query check), the output is scrubbed in 14 forms before any cap; binary bodies are never returned; nothing local receives the value so nothing writes it to the workspace (D4, 4.4, F9) | W2c, W13, W3 (workspace scan) | reserved-header check removed; a form dropped; binary bytes returned |
| Astra r2 #3: truncation before scrub; launcher diagnostics leak | High | Streaming scrub with carry-over before the cap (D11, F9); no launcher is used at all; library error messages replaced by fixed strings (4.4 step 8) | W13 (split-chunk and cap-boundary rows), W13c | cap before scrub; no carry-over; raw library error returned |
| Astra r2 #4: boot retires a failed revoke after an unrelated generation change; single-target ledger | High | Journal entries carry exact targets (`{itemId, botId}` etc.); retired only by their own receipt or a later KEPT widening on the same exact target (D16, M3); re-posted with the original opId (5.4); interrupted append: `writeFileDurable` whole-or-old, failure = `journalFault` (5.3); corrupt journal = all grants removed (5.4) | W16, W16b, W16c, W16d, W16e | retirement by generation; target without botId; corrupt journal treated as empty |
| Astra r2 #5: receipt protocol loses an acknowledged write or reports a late commit as failed; ring eviction | High | Reconcile (D21); queue-ordered status (M4); receipts kept until `vault-ack`, widening refused at 1024 unacked (D17); W4 has the explicit KEPT path and 5.3 the missing-receipt path (NOT_KEPT(not-saved)) | W6b, W6d, W6e, W4, W8 | reconcile removed; status outside queue; receipt pruned before ack |
| Astra r2 #6: card settlement authority outlasts revocation; crash after CAS; early GRANT continuation | High | No once copy on KEEP: the bot uses only the committed item; chat holds exist only for "this chat" or as the NOT_KEPT fallback, bound to bot+thread+origin+slot, dropped on Forget/thread delete/bot delete/restart (4.1 steps 6-9); CAS and op record in one store write before posting (step 5); continuation only after the outcome (step 8) | W23b, W5, W4, W22, W24 | early continuation; hold outlives bot delete; op posted before the CAS commit |
| Astra r2 #7: 1Password grant lacks exact field identity | High | Grants by `{accountId, vaultId, itemId, fieldId}`; reads by ids in main; relink with another accountId voids grants; completion re-check (D12, 4.5) | W20 | label resolution; completion re-check removed |
| Astra r2 #8: server-spawned command exceeds authority or starts after confirmed Stop | High | No spawned command (D4); dispatch fence re-checks `requireActiveInternal`, confirmed Stop, epoch and lease revocation in the same synchronous block that starts the request; abort on Stop (4.4 steps 4, 7); `vault_fetch` needs a real item (lease) by definition | W15a, W15d, W15c | liveness checked only at ingress; no dispatch fence |
| Astra r2 #9: child env can carry an unrelated provider credential | High | By construction: no child process, no environment (D4) | W3 (process rows), W29 | value placed in any env/child |
| Astra r2 #10: POSIX command survives server death | High | By construction: the request lives in the server process and dies with it; E1 drops that epoch's leases; part-2 contract 11.1(4) requires a surviving authority before command delivery | W3 (no child process exists), E1 covered by W7 restart row | n/a for part 1 (no surface); 11.1 for part 2 |
| Astra r2 #11: lost tool reply duplicates an external action | High | `invocationId` join, DISPATCHED call records, "Outcome unknown" after restart; timeout ≤ 60 s < 250 s proxy wait (D23, 4.4 step 1) | W27 | duplicate join removed |
| Astra r2 #12: masking depends on secrets outside the call | High | Matcher built from the lease's own values only (D11, F9) | W13b | matcher from all items in view |
| Astra r2 #13: part 1 omits MCP pointer materialization (scope gate) | High (scope) | Unchanged safe state: D8 disables binding (W17). **PARKED for MAIN's scope ruling** (QUESTIONS-r3 Q3), with the part-2 contract 11.2 now requiring a main lease | W17 | `resolveHeldEnv` consults the Vault |

## Medium (Fable r2)

| Finding | Mechanism | Witness | Mutant |
| --- | --- | --- | --- |
| #4 once items vs READY guard; W10 impossible | No custom card unless READY; reason line instead (D24) | W10, W11 | card raised while LOCKED |
| #5 failed narrowing then re-grant | Later same-target KEPT widening retires older entries (M3) | W16c | no retirement by later widening |
| #6 scrub after truncation | Stream scrub with carry-over, then cap (F9) | W13 | cap before scrub |
| #7 multi-line values | Values must be single-line (D14); PEM keys go to part 2 (11.1) | W25 | line check removed |
| #8 ledger append failure | `journalFault`: leases paused until the narrowing is KEPT, page line (5.3) | W16d | lease answered during journalFault |
| #9 residual cite overstated | R1 presented as a NEW acknowledgement; cite limited to what it covers (1.1, Q1) | W28 (text) | line removed |
| #10 No limits turns | No custom card on No limits; text points to Settings (D24) | W12 | card raised on No limits |
| #11 masked count ambiguous | Exactly 14 forms listed; W13 expects 14 | W13 | each form dropped |

## Astra r2 notes on earlier findings (carried)

| Note | Mechanism | Witness |
| --- | --- | --- |
| H5: W7 must queue the old op while its epoch is live | W7 rewritten that way | W7 |
| H8: W10 vs LOCKED delivery | D24 | W10 |
| H9: W19b should inspect the v1.0.20 backup contents | W19b scans the backup | W19b |
| H10: receiver must refuse any home provider key, any name | 8, W21b | W21b |

## Parked by Fable r2 (still parked)
- A child leaving its process group: moot in part 1 (no child); 11.1 for part 2.
- Restoring an old data-folder backup over a profile with an undurable narrowing: the journal lives in userData, not the data folder (7), so a data-folder restore cannot drop it.
- Item names in the server log line reaching exported diagnostics: names are owner-chosen labels, not values; unchanged.

## In-lane Astra convergence round 2 (r3 → r3b, design 15a58791d9 → this commit)

| Astra conv finding | Sev | Mechanism | Witness | Mutant |
| --- | --- | --- | --- | --- |
| #1 Full-access B uses A's turn bearer | Critical | D25: leases paused (LOCKED(full-access)) while any bot can read another turn's credential file; unqualified engine/OS pairs count as Full access; Q1 states it | W29b | bearer-only admission with a Full-access bot present |
| #2 key echoed in Content-Type | Critical | bare `type/subtype` only, number-only status, every returned string scrubbed (4.4 step 6) | W13d | raw header forwarding |
| #3 GRANT widens to unseen origins/slot | High | GRANT choice names the whole scope; no GRANT across slots (4.1 step 4) | W2d | single-origin disclosure |
| #4 revoke notice in flight; REPLACE leases | High | D26 server-side `narrowedSince` fence; REPLACE revokes leases (M3) | W15e | main-notice-only fence; REPLACE not invalidating |
| #5 reconcile adopts a sign-in draft | High | 5.3 step 2b: drafts with a second phase roll back durably, never adopted | W6f | unconditional adoption |
| #6 unreadable boot NOT_KEPT; DELETE on v2 | High | M4 answers UNCONFIRMED while unreadable; M3 writes only when READY | W6g | NOT_KEPT on unreadable; narrowing writes BROKEN doc |
| #7 disk full blocks journal | High | preallocated checksummed journal slots written in place (5.1) | W16f | allocating append |
| #8 crash between re-grant and retirement | High | receipts carry seq+target; boot retires from receipts (5.4 step 3) | W16g | own-receipt-only retirement |
| #9 HOLD_CHAT unnamed; phantom hold | High | holds carry name/nameKey; card shows a hold only on `hold: true` | W23c, W5 | unnamed hold; phantom hold line |
| #10 redelivery gets fresh id; late reservation | High | id = H(turn, proxy instance, JSON-RPC id); atomic reservation before lease | W27 | fresh id; reservation after lease |
| #11 1Password label ambiguity | High | ambiguous vault-level resolution refused | W20b | first match |
| #12 LINK token via server | High | preload IPC straight to main | W20b | LINK through the server |
| #13 restored profile retires journal | High | per-`docId` journal file | W16h | shared journal |
| Medium: form count | Medium | 13 forms, distinct-form sentinel | W13 | each form dropped |
| Fable 2 note: W6e masking | — | W6e observes status reach main before release | W6e | status outside queue |
| Astra 5 note: receipt pressure | — | W8c | W8c | prune before ack |

## In-lane Astra convergence round 3 (r3b 9be2f02665 → r3c), cap reached: folded in, NOT re-reviewed by Astra

| Astra conv3 finding | Sev | Mechanism | Witness | Mutant |
| --- | --- | --- | --- | --- |
| #1 bearer copied during the pause works after unpause | Critical | D25 unpause fence: leases only for claims issued after `pauseEndedAt` | W29c | reopen on current settings alone |
| #2 lease asked after REPLACE starts gets the old value | High | D26 `replacing` mark refuses leases until the outcome | W15f | sequence-only fence |
| #3 failed rollback, then recovery adopts the cancelled draft | High | 5.3 step 2b `rollbackTarget` re-persisted by DIVERGED recovery; restart case Parked (existing writer behaviour) | W6h | recovery adopts disk draft |
| #4 CoW full volume defeats preallocated slots | High | clean-shutdown `open` marker; a dirty boot pauses leases as LOCKED(review) until the owner presses Resume | W16i | preallocation without the marker |
| #5 Forget vs issued lease; stale "usable" line | High | Forget = server-started narrowing (D26); M1b handler; display from the live index | W23d | no lease fence; display from the settled record |
| #6 proxy remount changes the invocation id | High | id = H(turnId, request id, tool, canonical args), no instance id | W27 (remount row) | instance-keyed id |
| #7 same-origin redirect carries the query value | High | query slot: no redirects; header slots: Location scanned before following | W2c | origin-only redirect check |
| #8 preload relink bypasses the server fence | High | main-started narrowings use a revoke/ack handshake before applying | W15f | relink without handshake |
| #9 narrowing in BROKEN stalls the shared writer queue | High | narrowing waits in the journal outside the queue until READY | W6i | wait inside `derive` |
| Medium: W29 positive control inside the pause; W12 under No limits | Medium | W29 control at Auto on a qualified pair; W12 expects no lease under No limits | W29, W12 | — |
