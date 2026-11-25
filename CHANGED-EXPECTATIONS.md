# Scrub expectations

Authority: leakscrub2's user instruction makes the shared shell guard and its
shared POSIX ERE file the only guard. Production behavior must remain unchanged;
changes to test expectations must be recorded here.

The old guard's working-tree, filename, binary, symlink and arbitrary-diff
expectations are replaced by the shared guard's committed-HEAD text scan and
base-to-HEAD added-line scan. Tests create actual temporary commits, exercise
every shared rule using split-string fixtures, verify safe summary output,
and check configuration errors. The former public-switch exemption is removed.
The repository release assertion still requires exit 0, so the unresolved
runtime inventory keeps it red until MAIN rules. No expected failure or
runtime-name exemption was added to that assertion.

Two test descriptions now use a generic route-switch label:

- `cloudflare/control-plane/test/b4-flux.test.ts:4526`
- `cloudflare/control-plane/test/grants-d1-d3.test.ts:690`

Their assertions, test inputs and executable bodies are unchanged.
`server/cloud-home/engine-render-launcher.test.ts:456` constructs the same
endpoint value from two strings. This preserves hostname-normalization
coverage and the existing expected URL at line 460.

All other scrub edits are comments or documentation. No product assertion,
runtime configuration key, environment lookup or deployment value changed.


---

# Changed expectations — cfix-askcards

Binding: `/root/fuigo-builds/swarm-b/askcards1/RULING-askcards-hl-MAIN.md`.

No expectation is loosened.

- Item 4: `thread-marks.test.ts` uses `marked`/`unmarked` instead of booleans and requires `unreadable` on read failure. It additionally asserts denial of a proven native call. `engines-native.test.ts` passes those typed states with every existing allow/deny assertion unchanged.
- Item 4: runtime fixtures (`runtime.test.ts`, `native-wins.test.ts`) explicitly supply confirmed marks. The new mounted-capability regression requires refusal and no extra provider or lease calls after a storage fault, then successful recovery with the same capability.
- Item 3: new restore witnesses require union of backup/destination marks on reopen and refusal before replacement when preservation cannot be proved. This intentionally tightens restoration of a damaged destination database, whose marks cannot be recovered.
- The separate restore activation helper also merges marks before selection, under item 3's permanent-mark requirement.

The incoming HighLevel branch's expectation changes are separately retained in `docs/verification/hlint1-CHANGED-EXPECTATIONS.md`, copied from its MAIN-reviewed integration record.

- Item 4: the incoming `cfix-f02.test.ts` runtime-construction fixture supplies a confirmed mark, matching the other native runtime fixtures; all dispatch/journal/replay assertions remain unchanged. `auto-approve.ts` passes typed `unmarked` instead of the former `false`, preserving ordinary policy behavior.
- Frozen F0 anchored-file contract (`server/highlevel/F0.md:20`, `server/highlevel/frozen-contract.json`, `AnchoredRefusal`/`AnchoredReadRefused`): `c2-fixes.test.ts` FIFO refusal checks the actual exception class and exactly `not_regular` or `unsupported`, replacing the obsolete human-message regex. These are the same two refusal reasons as before; timeout/nonblocking and child exit assertions are unchanged. This strengthens the assertion against arbitrary errors with matching text.
- The existing lifecycle inventory equality assertion remains unchanged. `phone_ask_optins`, already in the schema inventory, is registered with its actual per-phone lifecycle from `PhoneRegistry.setDeviceIdOptIn`/`remove` (no table behavior changes).

## Imported HighLevel integration expectation record

The following is the complete reviewed record from hlint1; MAIN item 2 retains these rulings.

# Changed expectations

Binding sources: MAIN hlint1 rulings in the user instruction; `/root/fuigo-builds/swarm-b/hls0/F0.2.4-FROZEN.txt`; `/root/fuigo-builds/swarm-b/hls0/RULING-hlf-r2-MAIN.md`.

No expectation is relaxed. Journal fixture property names adopt `approvalJournal`/`callJournal` under MAIN (3). Fixtures supplying a plain approval journal now supply the frozen RPC journal subclass, required by the single integrated host. Existing assertions are retained unless enumerated below.

- MAIN (1): a provider's negative recovery confirmation is unconfirmed, rather than applied or authoritative absence. Recovery tests expecting `not_applied` solely from a negative provider flag must expect `outcome_unknown`. Proven absence remains `not_applied`.
- MAIN (4), frozen identity policy: follower removal recovery cannot confirm an empty current set against an approval naming `u1`. It remains `outcome_unknown`; no provider current set can replace the approved set. Add recovery with the exact approved set remains applied; `u_old/u_new` union is rejected.

Exact test edits so far:

- `server/highlevel/contacts-dispatch.f024.test.ts`: table mode `negative` for all 16 operations → `outcome_unknown` (MAIN 1); `followers.remove` mode `accepted`, including the fresh-process witness → `outcome_unknown` (MAIN 4).
- `server/highlevel/cfix3-recovery.test.ts`: `negative confirmation` collection row → `outcome_unknown` (MAIN 1).
- No expected read/send counts, identity assertions, replay assertions or approval requirements were reduced.
- `server/highlevel/opportunities-dispatch.test.ts`: CFIX6 `negative sibling` recovery row → `outcome_unknown` (MAIN 1). Immediate write-response negative confirmation tests remain unchanged.
- Historical R4 fixture now sends the declared notes/tasks pre-state GET instead of silently returning a local empty list; the existing read-count and rate-admission expectations remain unchanged.
- `server/highlevel/cfix3-recovery.test.ts`: `wrong name` and `wrong position` recovery rows lack the created stage IDs required by the frozen whole-response binder. They now remain `outcome_unknown` under MAIN (1)'s missing-confirmation rule. New positive tests supply complete stage IDs and continue to require `not_applied` for both proven mismatches.
- `server/highlevel/contacts-dispatch.f02.test.ts`: pending recovery `negative` journal reason → `unconfirmed` (MAIN 1).
- `server/highlevel/contacts-dispatch.f022.test.ts`: restart recovery `negative` outcome/reason → `outcome_unknown`/`unconfirmed` (MAIN 1); all read counts, no-resend, durable identity and terminal-cache assertions remain.
- Merge resolution `server/highlevel/c2-review.test.ts`, T7: retained hlf1's stronger assertion that zero-attempt restart keeps the original approval ID, and that `beginDispatch` refuses after recovery. This adds checks to hlc2's `outcome_unknown` assertion; F0.2.4 actions recovery instructions require those properties.

---

# Changed expectations

## Browser owner waits release execution (1.0.19 field item 4)

Authority: the browser-lock release task and item 4 of the browser-lock triage,
“release the browser execution claim on ordinary owner waits.”

`server/independent-thread-runs.test.ts` previously required the waiting routine
to keep owning `browser:profile`, and required its sibling to return `yielded`
without browser access. The replacement requires the waiting generation to
release its browser and browser-only screen after dispatch is fenced and drained;
the sibling receives both. A resumed waiter can reclaim the same selected route
only while it is free, and must take a fresh snapshot before acting. A busy route
produces a plain retry explanation. The turn's browser-selection lease survives
the wait; explicit owner control, protected documents, and computer screen claims
are unchanged. The corresponding queued-sibling test now expects admission after
the waiting holder releases, rather than `yielded`.


Review fix round 1 extends the same ownership rule to extension site/action
approval waits. The exact RPC awaiting its card is parked; other active calls
still drain. Its continuation reclaims the pinned route before consuming the
unchanged answer, and Stop cannot revive it. Extension bootstrap recovery may
navigate only from a live `about:blank` document; a successful fresh snapshot is
still required before subsequent page actions. Approval/card policy is unchanged.

## int19m2-C browser handback merge

The MurageCloud B2 no-owner regression is retained alongside Wave B's owned-close and legacy-receipt tests. Current recovery calls `createNativeBrowser(spec, { closeOnly: true })`, which immediately refuses a missing ownership record. The merged fake-time test awaits that complete refusal and verifies both recorded PIDs remain alive; it does not assert the older 70-second implementation detail. The stale-pid case retains its no-exit assertion and adds an exact ownership-refusal and liveness assertion.

## int19m2-C stopped-task copy

Sol's supplied review explicitly rejects telling users to start a new browser task in the extension, which has no such control. The corrected Spanish, Hindi, and Brazilian Portuguese `.23`/`.24` instructions ask the bot to start the task and then choose Continue. The copy regression now checks both actions and rejects the obsolete extension destination for those keys. The displayed-name checks remain unchanged for `browser.profileWaiting` and `.21`, where they apply. This change implements the user's instruction to apply Sol's exact corrections; it does not change a review verdict.

## Room routine lifecycle (r2-room-turns-c)

Lifecycle observation producer and fixture consumer owner: r2-room-turns-c. Native lifecycle owner: tri3-g1.

// MAIN RULING request ROOM-ROUTINE-SINGLE-USE-EVICTION: replace the optional
// spare-eviction log oracle with background:true at the actual adapter submission
// and a confirmed close receipt for the exact native turn; retain completion,
// receipt, room-task selection, user-activity policy and the five-second bound.

The current driver closes mounted turns as `mounted-single-use`
(`server/drivers/claude.ts`), and calls `live.spare?.lost("background turn")`
only if a spare exists. The observer calls the real adapter unchanged. The test
now requires one background dispatch and one matching confirmed teardown, so a
foreground dispatch or retained native child fails. No permission, privacy,
completion, partition, timeout or resource-bound assertion is relaxed.

## Scripted room result wakes (r2-room-turns-c)

Wake-text producer owner: r2-comms-chain-b. Scripted-engine consumer owner: r2-room-turns-c.

// MAIN RULING request ROOM-FAKE-WAKE-SHAPES: model the current direct asker wake
// (asker-wake.ts) and room result continuation (project-prompt.ts); distinguish
// replayed history from the continuation after the current room reply frame.
// Keep every result-delivery, privacy, step-cap and deadline assertion unchanged.

The delegated room fixture failed to consume the reviewed room result heading,
so it handed work over again on every result until the real six-step cap stopped
it. It now consumes that continuation and the direct control-plane wake. Actual
ACP process tests cover direct wakes, room wakes and quoted-history negatives.
No assertion in the Phantom scenario or the assigned 72 IDs changes.

## Quiet-build readiness fixture startup

// MAIN RULING request text: "Update fixtures only to match the current reviewed product contract, never loosening an assertion."

Existing reviewed contract: INT-CONFLICT-DEFAULT eb01447e7d, already cited in
this test: retain the short quiet-build wait and refuse consuming mounts
without readiness. This applies that contract; it requests no new ruling.

`server/drivers/acp/mcp-listed-wait.test.ts` removes the artificial 150 ms
connection delay only from the recovery attempt after two silent attempts.
That attempt still starts the actual agents and memory proxies, completes
real MCP listing, and must be heard inside the unchanged 500 ms short wait.
Every assertion is unchanged, including the silent refusals, zero prompt
writes, short wait, marker observation, and restored full wait. The separate
cold-start control retains its 1500 ms connection delay and timing assertions.
No expectation or product timeout changes.

## MAIN RULING 1115-ACP-MOUNTED-SINGLEUSE

Test implementation owner: ci-reds-ff3a-g. Product contract and native release qualification owner: MAIN.

- `server/host-power.test.ts`, "uses a fresh caged ACP wrapper for each mounted turn and cleans matching-argv descendants": the stale mounted three-turn reuse/idle expectation now requires three fresh wrappers, three handshakes and zero idle entries after every turn. Nonempty integrations are single-use under `cli-mount-relay.ts` and `acp/core.ts`, consistent with MAIN RULING INT-CONFLICT-DEFAULT eb01447e7d in `acp/pool.test.ts`. The integration rotation, real helper permissions and cmdline, engine identity, MCP parentage, session/load `noReplay`, matching-argv grandchild and confirmed whole-tree cleanup assertions remain. Cold continuation replaces resident-session reconciliation: the matching-argv grandchild is cleaned with its single-use tree instead of triggering a reused-process replacement. The fake engine starts/replaces its native transport shim twice on cold session/load; both launches are counted. The actual integration runs in its own cage, so the retained exact server/grandchild argv and parentage checks resolve against that owned tree. Both cages and all observed descendants must be gone.
- `server/host-power.test.ts`, "reuses one caged ACP wrapper across three non-mounted turns with no integrations": a separate real-cage control requires one wrapper, one initialize/authenticate handshake, three successful prompts and one idle entry between turns. It verifies stable engine identity and the physical wrapper cmdline, no redundant session/load, and confirmed cleanup on disposal. No integration is supplied on any turn.

Both native cases carry `// MAIN RULING 1115-ACP-MOUNTED-SINGLEUSE`. No other lifecycle, policy or platform expectation is changed. The anchored-reader diagnostic preserves refusal codes and guards; its Linux diagnostic unit does not qualify the macOS packaged job (B3 remains open).

## redact2-1020 (fix/1020-redact2-n2)
- server/transcript-page.test.ts "an old marker keeps its field without blanking its owner-only row siblings": the owner-only read of an
  assistant text row stored as ONLY «redacted» now expects REPLY_WITHHELD (owner-display.ts), not the bare marker. Sean reported those
  bubbles in a routine thread (1.0.20 pre9); the sibling field (removedText) assertion and the shared-audience assertions are unchanged.

## userbug-sealed-1022 (fix/1022-userbug-sealed-fable)
- server/drivers/cause22-owner-caps-relay-1021.test.ts "R6 owner turn": the two replies that meet a pending memory check on the owner's
  running turn are now delivered whole and in order (1024 bytes and 19 MiB); before, each was held to the bound and answered with the
  -32000 "still checking" error. Reason: owner report (turns refused or tools dead while a memory check never settled); memory readiness
  never refuses or drops the owner's own turn. The no-seal and no-refusal assertions are unchanged, and the hold-then-drop at the bound is
  still asserted for every other turn (server/drivers/mount-pending-defer-1020.test.ts REVKILL2 bound).
- server/drivers/cause22-owner-mount-budget-1021.test.ts "W22-1 owner turn": the 200 tool results (over 20 MiB) that meet a pending memory
  check on the owner's running turn are now delivered whole (dropped 0, no "was dropped" log line, more than 20 MiB reaches the engine);
  before, each was held to the bound and answered with the -32000 error. Same reason as R6 above. Unchanged: no refusal, no seal, no stop
  line, the budget does not degrade, nothing of the results is retained in the ledger, the turn completes.

## learnhold-1022 (fix/1022q-learnhold-opus, MAIN-RULING 2026-11-25T04:52:20Z learning-send-transports :56)
Ruling: the PIP Fuigo/Grok prompt file write and CLI spawn move out of the learning gate's held section; the gate commits its release
first, then the write and the launch follow in the same synchronous turn. learning-send-transports.test.ts stays byte-unchanged.
- server/drivers/headless-text-only.retry-ledger.test.ts "B: prompt write and spawn stay inside the gate" is now "B: the gate commits
  first; the prompt write and spawn follow outside it": at the spawn the transaction is closed (was open) and the gate has released once.
  Unchanged: the send emit runs inside BEGIN IMMEDIATE with the prompt file still empty; a refused gate writes and launches nothing.
- "21: real gate COMMIT failure owns its child" (4 rows) is now "21: real gate COMMIT failure launches no child": the gate's COMMIT runs
  before the spawn, so a failed COMMIT launches nothing and leaves no root (before: the child ran and was stopped). Unchanged: the error
  is memory-send-commit-failed and the attempt counts as released.
- "21: failed COMMIT and unconfirmed stop retain the credential root" is now "21: failed gate COMMIT with an unconfirmed stop leaves no
  credential root: nothing ran with it": no child ever held the credentials, so the root is removed.
- "5: after retry spawn, rollback and reopen ..." is now "5: at the retry's release, ...": the crash fixture sits on the retry's gate
  COMMIT (now before its spawn) instead of the first COMMIT after the second spawn. Unchanged: the first run's journal survives the
  rollback and the reopen; the reconcile result is the same.
- server/memory/pip-paid-calls.test.ts "24: $kind paid cap at $window" (ASTRA int-1022q-n1 50c4d674fc High, integrator int-1022q-n1):
  the three gate windows key on the learning gate's own release COMMIT (inside gate.send, durable charge already 3), not on the first
  COMMIT after the spawn, which is now a later transaction. "after-spawn-before-commit" is now "after-commit-before-spawn" (COMMIT
  lands, the spawn then crashes); "live-commit-failure" now expects no spawn for that attempt (was 1): a failed COMMIT launches
  nothing. New: at that COMMIT no process of the attempt exists yet. "after-commit" still replays the first COMMIT after
  the gate's COMMIT and the spawn (child recorded). Unchanged: injection reached, uncertain-transport state with its
  transport, durable charge 3 after replay, and at most one release per paid call across five restart passes.

---

## 1.0.22 idle DO LESS (q1022-idlequiet-opus; owners: this lane = expectations + witnesses, MAIN = rulings)

Authority: MAIN-RULING 2026-11-25T05:54:59Z (idle DO LESS), 06:57:58Z (rewrite superseded idle relief/start rows as
CHANGED-EXPECTATION with an active-minute assert), 07:09:02Z (boot recovery on an active minute).

- `server/io-budget-slice-admission.test.ts` "owed capture waits on an idle minute ..." and "overlapping capture slices ...": were
  idle capture admission; now idle refuses the capture ticket and the same admission (BG ceiling, copy reservation, the minute's
  closing guard) is asserted on an active minute.
- `server/io-budget-slice-admission.test.ts` "BOOT_RECOVERY yields to owner CRUD ...": was refused for the rest of the minute after
  owner CRUD; now admitted on that active minute under the BG cap (07:09:02Z). Yielding to a held turn, a turn start and typing is
  unchanged (the it.each above it).
- `server/memory/relief-all-subsystems-1022.test.ts` otherWritersSpendTheMinute: the owner-away shapes run on ACTIVE minutes (relief
  still drains every family there). W-RELIEF-ALL: the step labels are now `:active` (idle runs no background step). W-FIELD-MINUTE
  foreground: an active minute with the whole background minute left, so the index step runs at once on the gate's own room (no relief,
  not waited). W-RELIEF-ALL's idle/active step label is read from the real verdict at each pass (admissionIdle() or idleQuiet()).
  W-DISPATCH-ORDER and W-ONE-DOOR-GATE run on ACTIVE minutes the other writers have spent; W-ONE-DOOR-GATE ends on an idle minute where
  the door grants nothing (base 50c4d674fc RED there: granted true). Skipped with the reason written above each row (idle relief has no
  subject under DO LESS): W-RELIEF-JUDGE, W-RELIEF-METER (idle relief grant / idle headroom judge).
- `server/memory/idle-relaunch.test.ts`: the rows pinning the idle helper START and the life of an idle-started helper stay `it.skip`
  (that helper no longer exists). The no-lost-receipt rows (asked again / stop / write after stop / refused step / error on the way out /
  talk cannot postpone io-stop) and the owner-returns half are RETARGETED onto a helper the ordinary ACTIVE start made that asked its own
  idle exit; where a capture is owed while idle, no fresh start runs until the next active minute (base RED: a second helper starts while
  idle). "CHANGED-EXPECTATION idle DO LESS" (2 shapes): idle -> 0 helpers, nothing written; next active minute -> the ordinary start lands
  every capture once. The restart row: idle relaunch does nothing; the next active minute (ledger and wall clock) finishes the queue.
  The restart row moves the wall clock +60 s (Date.now spy) as well as the ledger: an idle-deferred capture is retried on the wall clock.
  "ACTIVE TWIN retry" (r8): the start backoff of the skipped "idle retry" rows (dies before ready, crash loop: 30 s, doubling) is
  asserted on an ORDINARY active start (1 MiB boot); once the backoff has passed on an idle minute no retry is made, and the next active
  minute's ordinary start lands the capture once (base 50c4d674fc RED: the idle rule retries on the idle minute). Still skipped as
  idle-start-only, for MAIN to retire by name: the fork-throws idle retry (a fork that throws on an active start is the owner's start
  and keeps its own handling, worker-controller.ts fork catch), late-exit rest before the next IDLE start, index-open-before-ask and
  not-ended-while-owed of an IDLE-started helper.
- `server/memory/idle-relaunch-real-helper.test.ts` (T10, T1000): with the real forked helper, an idle minute forks nothing, asks no grant
  and writes nothing; the next active minute's ordinary start lands each capture once; the restart does the same (base RED: captured).
- `server/memory/helper-index-relief-1022.test.ts` (W-HELPER-RELIEF whole-grant, smallest-cut, over-half-waits; MAIN-RULING
  2026-11-25T11:49:12Z Q1): (a) IDLE minutes: the relief door stays closed (io-budget.ts bgDoorsClosed, DO LESS), so the same batch,
  dispatcher call and parent cut get no relief grant, no ticket, nothing committed, no row in the index file; (b) the next ACTIVE
  minutes (the other writers still spend the whole background minute first): the SAME original assert, plus one row per record id
  (exactly once). Base 50c4d674fc RED at the idle assert (relief granted 3 times, tickets cut).
- `server/memory/idle-final-receipt-real.test.ts` (the 14 ladder rows W10 ladder, W1b, W2 ladder x2, W3, W5 ladder, W6 ladder x4, W7
  T10/T1000, W8 ladder, W9a; MAIN-RULING 2026-11-25T11:49:12Z Q1): the helper used to be started on an idle minute. Now (a) the idle
  minute starts no helper and captures nothing; (b) the next ACTIVE minute makes one ordinary start (1 MiB boot, not an idle start);
  the owner leaves again at once and the drained helper asks its own idle exit (idle-exit-request); from the controller's answer on,
  every original assert of the row is unchanged. New row (c) W-RESTART-IDLE: quit and restart while idle with a capture pending: no
  helper on the idle minutes around the restart; the first active minute after it lands the receipt exactly once (1 helper, 1
  index-result, 1 index row). Base 50c4d674fc RED at (a) (a helper starts on the idle minute).
- `server/memory/idle-final-receipt-real.test.ts` (MAIN-RULING 2026-11-25T12:35:30Z; owner q1022-idlequiet-opus). RETIRED as unreachable
  (it.skip, by name; DO LESS refuses the idle start these rows began with): W10 ladder, W1b ladder, W3 ladder, W5 ladder, W7 T10,
  W7 T1000, W9a ladder, W2 ladder (synchronous step under an open grant), W6 ladder beats, W6 ladder stdout, W2 ladder (exit-seal
  checkpoint blocked 40 s), W6 ladder beats after io-stop, W6 ladder stdout after io-stop, W8 ladder. REPLACED by R-A (active-started
  helper, owner leaves, own idle-exit ask: nothing sealed while idle; the final receipt and seal land exactly once on the next active
  minute, index entries of the message unchanged) and R-B (the same, then quit and restart while idle, then one active minute).
  W-RESTART-IDLE row count: one message may index as more than one entry; exactly once = no entry id written in two versions.
  STATUS (MAIN-RULING 2026-11-25T12:52:20Z, not a hold): (b) the idle assert accepts a FINAL on the idle minute only when the grant
  it spends was ISSUED before the flip and still open at it (a 4 KiB exit seal on an active-minute grant is no new idle admission) and
  fails on any bg grant issued while idle (asserts the grant issue time). (a) A restart does not seal an unsealed index left by a quit
  (same on base 50c4d674fc; 1.0.23 row q1023-boot-seal-orphan): R-B is re-derived with ONE capture after the restart; on the active
  minute that capture is indexed once (index-result once, no entry id doubled), the message rows of the earlier capture are kept (the
  thread checkpoint row rolls forward with the new capture) and the helper that indexed it seals once on its exit.
  r13 (OPUS/FABLE 37ec40e7da H1 + Medium (b); owner = q1022-idlequiet-opus): W-RESTART-IDLE row count is now pinned to an active-only
  control: message 1, said on the same active minute with no idle span or restart before its capture, indexes as N message rows; the
  capture pending across the idle quit and restart must index as N too (own assert line, so a doubled write under a NEW id fails it, not
  only an id in two versions). R-A takes the held path every run: the owner leaves at the helper's first grant request after its index-result,
  so every grant asked after the batch is asked while idle (fixture.beforeReceive); R-A also asserts that path (no FINAL on the idle minute). The
  paid-before-flip path is kept as its own row (R-A paid-before-flip: the flip after the batch is seen indexed, as before).
  q1022-idlewit (int-1022q-w1 H3, ASTRA a662f67f08 part 2; owner = q1022-idlewit-opus): R-B now also takes the held path and asserts
  paidBy == [] before the quit (the receipt is pending across the quit and restart); before, it admitted the paid-before-flip path too.

### io-budget idle rows (q1022-idleq-io; owners: this lane = expectations + witnesses, MAIN = rulings)

Authority: MAIN-RULING 2026-11-25T11:49:12Z (rewrite the 18 superseded idle io-budget rows: (a) idle minute refuses, (b) next ACTIVE
minute the same assert holds, each capture lands exactly once, no assert dropped). Rule used for every row: each refusal assert of the old
row stays on the idle minute (now refused unconditionally, so also before a burst); each landing assert moves to the next active minute,
with an exactly-once check (row count and highest row number, or the ledger's bg/reserved). Base 50c4d674fc: all 18 RED at the idle
refusal assert.

- `server/io-budget-admission-idle.test.ts` "on an idle minute nothing is admitted ...": was: the owed capture alone is admitted idle.
  Idle: memory-worker and the owed capture both refused, ledger untouched. Next active minute: the capture is admitted, settles once
  (bg 4096, debt 4096, reserved 0); the poisoned ledger still refuses it.
- `server/io-budget-reservation-retry.test.ts` "a capture behind a live reservation retries at the short step on the next active minute
  ...": was: an idle capture behind a live reservation retries at the short step. Idle: no reservation is given and a refusal waits for the
  minute (not a reservation wait). Next active minute: reservationWait true, retry and claim <= 1000 ms, the reservation settles once.
- `server/io-budget-idle-capture-debt.test.ts` (7 rows, real database under instrumentDatabase): W1 1/min and W4 4/min: the idle minutes
  land 0 and write no copy debt; the next active minute(s) land 10/10, 40/40 and 100/100, each exactly once. On active minutes the carried
  copy debt counts against the capture's BG ceiling (admit's BG clause; the idle-only exemption no longer has a subject), so the W4 and tick
  rows let the checkpointer report its copy at each active minute's end, as wal-maintenance.ts:868 does (io-budget.ts backfilled).
  W1 keeps "carried copy debt stays on the ledger" (no checkpoint there). The old W4 premise "carried on past the point where the unpaid
  copy debt alone is larger than the whole background minute" has no subject on active minutes: with no copy paid, owed captures stop
  there (observed: 40 land with 5.4 MB of debt; 100 need about 13.5 MB > 12 MiB). It was an idle-only exemption; it is replaced by the
  checkpointer's report at each active minute's end (OPEN for MAIN, not test-fixable: an active-minute capture backlog depends on the
  checkpointer completing once copy debt passes one BG ceiling). Idle ceiling/burst: refused before and after the burst, other
  sources refused, the next idle minute admits nothing; the next active minute lands both, once. Rolled-back write: idle defers before any
  ticket (nothing charged); the native grant refusal inside a too-small ticket and "charges nothing" are now asserted on an active minute
  (ticket left small by the 49 MiB total clause), and the next active minute lands it once. Tick agrees: ten idle minutes land 0 with no
  over-budget line; the next active minutes land 100 once with no over-budget line. Shared ceiling: the idle minute defers all three
  captures and the tick trips on exactly the 4 MiB (planned = upkeep only, captures wrote 0); the next active minute lands the three once.
  BG-ceiling planning: the idle minutes refuse every attempt and write nothing; on two ACTIVE admission minutes in one tick window (tick
  taken after the owner left, idle verdict) the tick plans exactly what the landed captures wrote, min(one BG ceiling, their metered
  bytes), and judges the rest of the window; every capture deferred on the idle minutes or in the window then lands exactly once. The old exact "judged = window - one ceiling" is not reachable on
  active minutes (their captures carry the copy debt inside the ceiling, so they never settle past it); the cap is asserted on the one
  definition, plannedWrites(1, ..., BG_MINUTE_BYTES + 2 MiB) = BG_MINUTE_BYTES.
  ASTRA 45a7d55227 (High, :311 does not prove the tick applies the cap): the same row now also proves it END TO END. Probe (one-minute
  window, active): 21 captures land a minute, 5.5 MB own + 5.5 MB copy debt = one BG ceiling, so two admission minutes write 11.0 MB
  (with the checkpointer's report between them) or 8.4 MB (without): the original "judged = window - one ceiling" cannot hold there under
  the frozen product. A half-minute active tick window across a minute boundary, with the checkpointer's report between the two admission
  minutes, lands captures past that window's ceiling (BG x 0.5); the tick plans exactly that ceiling and judges the rest
  (io-budget-idle-capture-debt.test.ts:339), and every capture owed lands exactly once after it. Mutant: the tick's owed cap removed
  (io-budget.ts:1284 planned = share.planned - share.owed + owedTick) -> RED AssertionError at :339; the cap removed at the definition (io-budget.ts:77, as before 2626013ad1) -> RED at the direct plannedWrites assert :314. No assert dropped.
  NEW row (Astra pre-check M2): "the idle write gate: an idle capture beside a live reservation waits for the next minute's look": the
  write gate (instrumentDatabase idleQuiet) defers before any room or ticket, so the idle capture waits for the minute (reservationWait
  false), where the admit path alone answers a short-step reservation wait; the next active minute lands it once.
- `server/io-budget-idle-planned.test.ts` (9 rows): WITNESS: the idle minute lands 0; the next active minute lands the 32 owed once
  (bg = 32 x 2 frames, bg + debt <= the idle room as before). Idle ceiling: unplanned upkeep still refuses and leaves backgroundRoom 0; the
  burst world refuses before and after the burst, admit, FGCOPY and copyRoom as before; the next active minute lands the deferred captures
  once. The 4 planned KINDS (one it.each over all 8 kinds; the 4 unplanned kinds were refused on base already): idle tick verdict and the shared planned share as before, no capture admitted
  (planned share = the 2 MiB, no capture bytes); next active minute: capture admitted, tick not tripped, admission and tick take off the
  same bytes, the capture's 2 frames planned once. SITES planned (the 2 capture-ticket sites, admit BG and the reservation retry): closed on
  the idle minute, open on the next active minute beside the same planned upkeep; the other 4 sites unchanged. Planned share ends with its
  minute: the idle minute admits nothing, the next active minute lands the capture once, the idle minute after it excuses nothing.

## 1.0.22 q1022-idlefix-fable (MAIN-RULING 2026-11-25T12:40:11Z: a turn never fails or loses memory because the app was idle)

Owners: fix and witnesses = q1022-idlefix-fable; idle DO LESS = q1022-idlequiet-opus; rulings = MAIN.

Product (server/memory/recall-view.ts, server/io-budget.ts): three things idle DO LESS paused are active work and are no longer held
on an idle minute: the boot/restart sweep of the roster's recall views, a reader's demand for a view that is not ready (it makes the
minute active before the build is requested), and the one page a waiting reader asked for (requestRecallViewMaintenance). Warming
queued by a later roster change, the applier, the reclaimer and every other background writer stay paused as before. Witnesses:
`server/memory/idle-turn-demand-1022.test.ts` W-BOOT-SWEEP, W-DEMAND, W-REQUEST.

- `server/memory/idle-quiet-1022.test.ts` "RECALL: on an idle minute the background recall build writes 0 bytes ...": the row queued
  the FIRST enumeration of the roster (the boot sweep) on an idle minute and asserted that nothing was built. The boot sweep is now
  active work (12:40:11Z), so the row runs it on an active minute first and keeps every original assert (0 frames, 0 bytes, 0 views
  while idle; builds on the next active minute) for warming queued by a later roster change, which is still background.
- `server/memory/controller-admission.test.ts` "an owed capture can claim on an idle minute while unrelated BG remains refused",
  renamed "an owed capture waits on an idle minute like unrelated BG and claims on the next active minute": idle DO LESS
  (05:54:59Z) refuses the owed capture on an idle minute. Per 11:49:12Z (a)/(b): idle minute = still pending, nothing reserved; next
  active minute = the original asserts (leased, nothing left reserved), plus claimed exactly once. Not a witness of this lane's fix
  (product for this row is unchanged since 499dc8b339).
- `server/memory/controller-admission.test.ts` "an owed capture write reserves its copy at the per-frame bound; other writers keep
  the half split": the capture's grant was taken on an idle minute, where the write gate now defers it. (a) idle minute = BG_DEFERRED,
  nothing reserved; (b) next active minute = the same per-frame split asserts. Two asserts are restated for an active minute: the
  cap is min(per-frame share of the room, 1 MiB) because the active room is larger than one slice (the product's existing 1 MiB slice
  cap), and "charged at most 1 MiB - 64 KiB" (the idle ceiling) becomes "charged at most what it reserved". The half-split asserts
  for the other writer are unchanged, one minute later.

---

# q1022-startup H2-sameKey (MAIN-RULING 2026-11-25T17:38:15Z STARTUP-1022)

Message writes (replaceRow, updateMessage in server/message-db.ts) now store attachment paths under the current data root. Three tests
seeded the rows the boot rebase pass migrates through insertMessage, which no longer writes an old-root path. They now seed those rows
by a raw UPDATE of the json after insertMessage (or raw SQL), the shape an older version left behind before the move; every assertion, input value and count is unchanged:

- `server/attachment-paths.test.ts:24` (S5 site 14)
- `server/s5-phase2.test.ts:91` (site 15)
- `server/startup-rebase-marker-1022.test.ts:45-46` (item 3 marker, the 40 seed rows)

The write-time behaviour itself is witnessed by `server/message-write-current-root-1022.test.ts:42`.

## 1.0.22 idle burn (q1022-idleburn-opus; owners: this lane = expectations + witnesses, MAIN = rulings)

Authority: MAIN-RULING 2026-11-25T15:18:33Z HIDDEN-COST triage (q1022-idleburn a/b/c).

- `server/search-index-idle-rate-1022.test.ts` W-SEARCH-IDLE-RATE and W-SEARCH-PRUNE-OWED: were ">= 12 (>= 8) idle worker replies in
  the window, each running no probe/prune"; an idle step that owes nothing now parks, so the window asserts <= 1 reply and <= 1
  probe/prune (stronger). The prune of 200 applied intents and the source rule are unchanged.
- `server/observe.test.ts` "the loop-lag line appears only when p99 ...": the primes waited 80 ms at a 20 ms histogram resolution;
  the resolution is 200 ms now, so they wait 450 ms, and the block is 400 ms (was 250) so its delay beyond the resolution is always over 100 ms. The asserted line is unchanged.
