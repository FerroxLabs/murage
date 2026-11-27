# X19: automation-ancestry ledger reload after a 1.0.20 round-trip (1.0.22)

Owners: design = design-1022-x19-ledger (this file). Build = an X19 builder seat (MAIN to seat; no owner yet). Row placement, the
forward merge that brings `server/automation-ancestry.ts` into dev/1022 (X21, rel/1.0.21-emergency -> dev/1022) and GO = MAIN.
Source of the row: FABLE phone e299c4a8a8 Medium (board n4:881) + OPUS phone e299c4a8a8 Low (n4:879); MAIN n4:882 made it a 1.0.22 row.
Anchors are on rel/1.0.21-emergency f6ae52c670 (the only line that has the ledger today); dev/1022 6d4b5932a8 does NOT contain
`automation-ancestry.ts` yet, so the build lands after, or rides, the X21 forward merge (see BUILD BASE).

## PURPOSE
The ledger (DATA_DIR/automation-ancestry.json) lets owner-only mounts (the phone above all) tell an owner chain from an automation chain
across a restart. After 1.0.21 -> 1.0.20 -> 1.0.21+, the file left from before the 1.0.20 stint is reloaded as if nothing had happened
in between, although 1.0.20 ran turns on those threads without recording them. This design makes a reload trust the ledger only when
no other build has started on the data since the ledger was last sealed; otherwise it starts empty, which every reader already treats
as automation (fail closed).

## USER PROMISES
- P1. Work a routine (or a wake of one) started, on any version, never gets the owner's phone or other owner-only mounts because of a
  record that predates that work.
- P2. An ordinary restart of the same build forgets nothing (the PHONEAUD promise, automation-ancestry.ts:9-10): owner chains stay
  owner chains.
- P3. No new prompt, card or setting. A dropped ledger costs at most one fail-closed hop per thread (the next owner turn records afresh).

## THE DEFECT (traced)
- Readers that answer "owner" for a stale `false` (a missing record would fail closed): automation-ancestry.ts:60 (chain root,
  `!== false`), :61 (re-run/continuation at `rerunAt`, `!== false`), delegations.ts:1248, handoff-boundary.ts:766 and :1168
  (`threadAutomationAncestry(..) !== false`), index.ts:23672 (`requestAutomationAncestry(..) !== false`) and index.ts:24701-24703
  (a request mark is "never lowered", but a raise during the 1.0.20 stint was never written). automation-ancestry.ts:62 (retry,
  `=== true`) only over-fails on a stale `true`: safe, no change needed.
- Concrete scenario (Fable n4:881): under 1.0.21 the owner talks on thread T (ledger T = [{at: t1, automation: false}]). The owner
  downgrades to 1.0.20; a routine runs on T and posts a card at t2 (1.0.20 records nothing). The owner upgrades; they answer the card.
  index.ts:16298 sets `rerunAt = t2`; automationAncestryAt(T, t2) returns the t1 entry `false`; :61 passes; the continuation of
  routine work mounts the owner's phone. Same for a hand-off rooted at T (:60) and a delegation queued from T (delegations.ts:1248).
- Why the reviewers' hint (data-version.json) cannot work: the marker is raise-only (data-version-marker.mjs:51-56): 1.0.20 never
  writes it when 1.0.21 recorded a higher version, so it cannot show that an older build ran since the last save.

## DESIGN: one fence, at the one loader
Fence = the database start counter `memory_open_turns_build.boot` (server/memory/open-turns.ts:67-78 `bumpOpenTurnsBoot`). Every
server start of 1.0.20, 1.0.21 and 1.0.22 adds exactly one to it in its own BEGIN IMMEDIATE transaction before listen
(index.ts:11872 on f6ae52c670, :12063 on dev/1022). open-turns.ts is byte-identical v1.0.20..f6ae52c670 (git diff empty), so the
1.0.20 stint moves the counter by the number of 1.0.20 starts. No new file, no new table, no change visible to 1.0.20.

State machine of the in-memory ledger (one per process):
```
UNSEALED --(seal(newBoot): file.v==2 && file.boot === newBoot-1 && newBoot>0)--> LIVE (entries published)
UNSEALED --(seal: anything else: v1 file, no boot, mismatch, counter 0, missing/damaged file)--> LIVE (empty)
UNSEALED --(record before seal)--> LIVE-UNSTAMPED (quarantine discarded, file written with boot:null)
LIVE --(record / recordRequest)--> LIVE (file rewritten with the same boot)
```
1. `configureAutomationAncestryFile(path)` (index.ts:1581) parses the file into a QUARANTINE only. Readers see nothing (= automation)
   until the seal. It keeps `{v, boot, threads, requests}`.
2. New `sealAutomationAncestry(newBoot: number)` is called right after a successful `bumpOpenTurnsBoot` inside the same boot step
   (`bumpOpenTurnsBoot` already returns the new count). It publishes the quarantine only when `quarantine.v === 2 &&
   Number.isInteger(quarantine.boot) && quarantine.boot === newBoot - 1 && newBoot > 0`; otherwise it publishes empty maps (threads AND
   requests: the request raise can also be missed, see DEFECT). Either way it rewrites the file at once as
   `{v: 2, boot: newBoot, threads, requests}` (writeFileAtomic, 0600). Every start that accepted or dropped the ledger therefore
   stamps it, so a start that admits no turn still carries the seal forward.
3. `persist()` writes `v: 2` and the process's sealed `boot` (null before a seal). One terminal path: the next start's seal decides.
4. Seal write throws: keep the in-memory maps EMPTY (do not publish the quarantine), log one warn line, carry on. The old stamp on disk
   cannot match the next count, so the next start drops too.
5. Bump fails (5 locked attempts, index.ts:11869-11878) or the start is read-only: no seal; the process runs with empty maps
   (fail closed); the file is untouched unless a turn records (then boot:null, dropped next start).
6. Equality, not ">=": a database restored from a backup carries an older counter, and a restore makes the ledger stale too; it drops.
7. Format v1 -> v2: 1.0.21 reads only `v === 1` (automation-ancestry.ts:123), so a 1.0.22 ledger looks empty to 1.0.21 (fail closed
   there too), and a v1 file written by 1.0.21 is dropped by 1.0.22. This one rule covers 1.0.22 -> 1.0.21 -> 1.0.22 and the first
   1.0.21 -> 1.0.22 upgrade.
8. Generation/epoch fence: the counter IS the epoch. No timer, no wall clock, no version string is compared.
9. Cost per start: one counter value already returned by the bump, one parse (bounded: MAX_THREADS 1024 x MAX_PER_THREAD 8,
   MAX_REQUESTS 2048, as today) and one rewrite of the same bounded size. Nothing scales with history.
10. Inventory/downgrade: the file name is unchanged; data-dir-inventory.ts:201 and DATA_DIR_NAMES_AFTER_102 stay as they are. Update
   the comments at automation-ancestry.ts:9-15 and :115 to say a reload is trusted only across consecutive starts.

Accepted cost (fail closed, P3): after the one-time 1.0.21 -> 1.0.22 upgrade, after any downgrade stint, after a restore and after a
crash between bump and seal, a continuation of a card posted before that point, or a hop rooted at a thread with no turn since, is
treated as automation once (no owner phone on that hop). The thread's next owner turn records afresh.

## DECISIONS
- D1 Drop the whole ledger, not per thread: 1.0.20 leaves no per-thread trace the ledger can compare. Fail closed.
- D2 Drop requests too (missed raise, DEFECT). Pending owner room requests across a stint fall back to roomRequestOwnerProof
  (index.ts:24703), the existing path for an unknown request.
- D3 Do not try to keep v1 ledgers on the 1.0.21 -> 1.0.22 upgrade: nothing proves no 1.0.20 stint happened before it.

## BUILD BASE
Branch from rel/1.0.21-emergency f6ae52c670 (the code exists only there), linear ci commits, no dev merge, so MAIN can carry it in the
X21 forward merge or pick it onto dev/1022 after X21. If X21 has landed on dev/1022 when the builder starts, base on dev/1022 instead.

## WITNESS LIST (RED on f6ae52c670 unless marked; P2 entry = spawned `server/index.ts` on a temp DATA_DIR, harness as in
server/after-listen.test.ts:123 with testing/murage-env.mjs childEnv; a 1.0.20 start is stood in by one `bumpOpenTurnsBoot` on the same
database between two spawns, justified by open-turns.ts being identical in v1.0.20)
Fixture states: ledger with N=10 threads (+3 requests) and N=1000 threads (+1000 requests), each thread's newest entry `automation:false`.

| id | trigger | steps | expect | base |
|---|---|---|---|---|
| W1 | ordinary restart | spawn A (writes v2 ledger via a real owner turn or seeded v2 file with boot = counter), stop, spawn B | all N entries kept; file boot = new counter | GREEN on base (P2 regression guard; must stay GREEN) |
| W2 | one 1.0.20 start | spawn A, stop, bump once, spawn B | threads {} and requests {}; boot = new counter | RED (base keeps all N) |
| W3 | three 1.0.20 starts | as W2 with 3 bumps | dropped | RED |
| W4 | 1.0.21 stint / first upgrade | seed a v1 file (1.0.21 shape, no boot), spawn | dropped, file rewritten v2 | RED |
| W5 | restore | spawn A, stop, set counter lower (restored-database stand-in), spawn B | dropped | RED |
| W6 | crash between bump and seal | spawn with a test hook that exits after bump before seal, then spawn | dropped | RED |
| W7 | start with no turns | spawn A, stop, spawn B (no turn), stop, spawn C | kept on C (seal carried by B's rewrite) | RED if the seal rewrite is missing (mutant M2) |
| W8 | damaged file / counter 0 | garbage file; and a database whose bump returns 0 | empty, no throw, server listens | GREEN on base for garbage (guard) |
| W9 | Fable scenario end to end | owner turn on T (fake engine, testing/c11-chain-engine.mjs class), stop; bump; post a routine card on T in the database at t2; spawn; continue the card over the real continuation route | the continuation turn is NOT phone-owner (no phone tools in its mount, as phone-mount-audience.test.ts reads them) | RED (base mounts the phone) |
| W10 | hop rooted at T | as W9, then a hand-off rooted at T (handoff-dispatch.ts:719 chainRootThreadId) and a delegation queued from T (delegations.ts:1248) | both automation | RED |
| W11 | readers before seal | call each reader site between configure and seal (unit, module level) | every site reads undefined -> automation | RED |
| W12 | 1.0.21 reads a v2 file | load a v2 file with the f6ae52c670 loader | empty (fail closed in 1.0.21) | GREEN by construction (records the compat claim) |

Mutants (each must turn its named witness RED at the behavioral assertion): M1 drop the boot comparison (W2, W3), M2 skip the seal
rewrite (W7), M3 publish the quarantine at configure (W11), M4 keep requests on a drop (W2 requests assertion), M5 accept v1 files
(W4), M6 accept `file.boot >= newBoot - 1` instead of `===` (W5: a restored counter is lower, so the old stamp passes). Null mutants per PROCFIX P3: REVERT
(base), NOOP (seal does nothing), DROP (seal result not published) on W2 and W9.

SITES.md (P1, builder): grep `threadAutomationAncestry\|automationAncestryAt\|requestAutomationAncestry\|automationAncestry(`
over server/ minus tests; on f6ae52c670 it returns the 8 sites named in THE DEFECT; all are FIXED by the one loader fence
(they read only the in-memory maps), :62 is NOT-APPLICABLE (stale true over-fails). One W10/W11 row per site.

## GAP-CHECK (one adversarial pass)
Fixed:
- (b) failure path: crash after the bump, before the seal (stamp left one behind) -> next start drops; W6.
- (b) failure path: seal write fails -> process keeps empty maps, next start drops; covered by step 4 (unit row in W11's file).
- (d) safety: a backup restore also makes the ledger stale (database older than the ledger) -> equality fence drops; W5.
- (d) safety: a request raise missed during the stint -> requests dropped with threads; W2, M4.
- (a) purpose gap: a start that admits no turn would leave the old stamp and make the NEXT ordinary restart drop (breaks P2) -> the
  seal always rewrites; W7.
- (d) safety: 1.0.22 -> 1.0.21 -> 1.0.22 round-trip -> v2 format bump; W4, W12.
Parked (for Sean/MAIN):
- A 1.0.20 start whose own bump failed 5 times (locked database) leaves the counter unmoved, so its unrecorded turns go unseen. 1.0.20
  is shipped and its own reconcile already treats that as a degraded start; rare, no realistic user path to target.
- scripts/verify-memory-faults.ts (reconcileInterruptedMemoryTurns, settlement.ts:28-31) bumps the counter: drops the ledger on the
  next start. Test tool only; fail closed.
- Read-only starts run with an empty ledger (fail closed); read-only is recovery mode, owner phone on chained hops there is not a promise.
Rejected:
- Per-thread fence from message timestamps: 1.0.21's own refused starts and replies write messages after the last record, so it cannot
  tell a 1.0.20 turn from normal traffic.
