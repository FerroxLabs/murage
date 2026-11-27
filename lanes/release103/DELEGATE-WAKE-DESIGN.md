# Delegate wake: one durable record per owed wake (lane D, 1.0.3, r#4)

Status: design, revision 8 (Astra build round 5 Medium folded in: refused cancellation writes retried, section 5b). Revision 7 (Astra build round 3 folded in, section 5a). Revision 6 (Astra design r4 High and Mediums folded in: durable before it counts, the two unguarded matrix cells, overflow that refuses instead of evicting, restore that refuses instead of repairing; the agreed list of FINISH-103-PLAN.md mapped case by case). Revision 5: Sean's contract (one durable record owed → claimed → started → done | cancelled; an atomic compare-and-set claim; Stop and cancellation re-checked in the same step that marks started; crash recovery idempotent by wake key, the record id, with the held item keyed `wake:<id>`; ceiling, audience and allowance in the record) with the state × event matrix and one test per cell. (Revision 4: revision 1 had an Astra DISAGREE: two Highs, two Mediums, folded in and marked "rev 2"; revision 2 had an Astra DISAGREE on four Mediums and two test notes, folded in and marked "rev 3"; revision 3 had an Astra DISAGREE on two Mediums, the idle-routine-conversation ceiling and the undefined cap, folded in and marked "rev 4". No Critical or High since revision 2; the build follows revision 4 and the build review covers design and code together.)
Scope: `server/asker-wake.ts`, the wake sites in `server/index.ts` (wakeAsker, startTurnAdmitting, the no-tools hold, the submission fence, engine acceptance, the held drain, the memory redispatch), boot restore. The boundary port (`handoff-boundary.ts` AskerWakePort) and the store field (`TaskRecord.askerWakes`) keep their shape.

## 1. The problem the two build rounds left open

Round 2 kept three durable or semi-durable representations of one owed wake: the owed result list on the task record, an in-memory ticket for a wake taken but not yet admitted, and a held continuation when the engine had no tools. Each was cleared on its own schedule, so the open findings are all seams between them:

- High: a held wake picked up for replay has no ticket, so nothing re-checks Stop between the drain's selection and admission.
- Medium: `take()` removes results from the owed list, so a flush caused by a second return (or by `settle()` when `startTurn()` resolves, which is before the engine accepts) loses a wake that is mid-start.
- Medium: a crash after the held copy is saved and before `settle()` clears the owed list leaves both; the restored owed wake runs and does not consume the held copy, so the asker is woken twice.
- Medium: a restored depth-0 intent without a coordination trace reaches `beginInternalTurn`, which mints a fresh root allowance for it.
- Medium: both memory redispatch sites spread an already settled ticket into a new start, which refuses with `asker_wake_stopped`.

## 2. One record, one state machine, one claim

Every owed wake is exactly one `AskerWakeRecord`, kept on the asker's task record (`task.askerWakes.wakes[]`) beside the hand-off intents still out (`task.askerWakes.intents[]`). The record is written synchronously after every transition (`store.setTaskAskerWakes`, one `saveBots`). Nothing else describes the wake: the ticket map is gone, and the held continuation (when one exists) is a carrier that points back at the record, never a second copy of its state.

```ts
interface AskerWakeRecord {
  id: string;                    // uuid, stable across restarts and across held replay
  state: "owed" | "claimed" | "started";   // done and cancelled are terminal: the record leaves the kept list in the same write
  held?: true;                   // carried by held continuation `wake:<id>` until an engine with tools accepts it
  intent: AskerWakeIntent;       // the ceiling (section 5)
  results: AskerWakeResult[];    // the replies this one wake carries: taskId, toBotId, toBotName, ok, messageId
  attempts: number;              // starts given back, held replays that failed, claims lost to a crash; MAX_ASKER_WAKE_ATTEMPTS (6) ends it
  claimedAt?: number;
}
```

Meaning of the states:

- **owed**: a reply landed; no turn is in flight for it. The only state the sweeps claim.
- **claimed**: one starter owns it: either the in-memory `wakeAsker` call between `claim` and admission (not held), or the held continuation `wake:<id>` (held). Admission has been passed or not; the prompt has NOT reached the provider.
- **started** (rev 2): the prompt is being handed to the provider. Set at the submission fence (`beforeSubmit`, index.ts ~10452, the same hook a queued hand-off uses for `delegationRun.submitted()`), written before the call goes out. From here on the engine may have the prompt.
- **done**: the engine accepted the turn and the delivery accounting ran. The record leaves the kept list; an in-memory tombstone (`doneIds`, at most 8 per thread) remains so a rebuild of that same accepted turn (section 3) is told apart from a cancelled one. (rev 3) `done` is reached from claimed as well as from started: an engine that hands its turn id back while setup continues (Codex, `drivers/codex.ts` ~2289) accepts before the submission fence runs; in that order `start` afterwards is a no-op on a tombstone. Either order leaves the tombstone.
- **cancelled**: Stop, a failed turn, a deleted bot or conversation, attempts exhausted, or nothing left owed. Removed from the kept list. (rev 3) The tombstones go only with Stop (`drop`, `dropBot`): a turn that ended without success (`failed(threadId)`) drops the thread's records and intents but keeps its tombstones, because the one rebuild that follows a failed turn, the late memory refusal's, is the rebuild the tombstone exists for. Stop between that refusal and its rebuild still clears the tombstone and the rebuild refuses.

### Transitions

| From | To | Operation | Where | Note |
| --- | --- | --- | --- | --- |
| (none) | owed | `deliver(taskId, result)` | finalizer / receipt recovery (`returned`) | joins the thread's newest **owed** record with the same authority (`sameAuthority`) while it holds fewer than `MAX_ASKER_RESULTS` (16) replies; otherwise, or when no such record exists, a new owed record (rev 3: the overflow opens a second record, nothing is dropped). A claimed or started record never gains a result. |
| owed | claimed | `claim(threadId)` | `wakeAsker`, synchronous, before `startTurn` | the oldest owed record; flushed before any await. Atomic: a record is claimable only while `state === "owed"`, and the whole claim runs in one tick. |
| claimed, started, done | (unchanged) | `check(id, stillOwed)` | `startTurnAdmitting`, the last check before the admission tick | **the re-check of Stop and cancellation.** Missing or cancelled → false → `asker_wake_stopped` (409). claimed or started: `stillOwed` (the engine-owed check, `task.externalUpdates`) is run over the record's replies; none still owed → the record is cancelled, false. A done tombstone → true with no filter (section 3: the rebuild of a turn already accepted). |
| claimed, started | started | `start(id)` | the submission fence | the compare-and-set: re-check and mark in one step (rev 5, below); false refuses the submission. Idempotent; a held record keeps `held` (the item is consumed at acceptance). |
| claimed | claimed + held | `hold(id)` | the no-tools hold in `startTurnAdmitting` | the held item is `wake:<id>`, carries `askerWakeId` and `askerWake: true` in its options, has no `cardId` (a wake has no card; the current lane labels an unrelated request card "held"). |
| claimed, started | owed | `requeue(id)` | `wakeAsker` on a 409 that is not `asker_wake_stopped` | `attempts + 1`; at `MAX_ASKER_WAKE_ATTEMPTS` the record is cancelled instead and an error line is written. |
| claimed + held | claimed + held | `replayHeld(id)` (rev 3, was `retryHeld`) | the drain, right before it calls `startTurn` for an item with `askerWake: true` | `attempts + 1`, written before the attempt, so a replay that crashes in setup has already paid for itself (a restart cannot loop it for free). At the cap, or when the record is gone (Stop), false: the record is cancelled and the drain removes the held item instead of replaying it. The drain's `failed()` re-holds a wake item as `retry` only while `startable(id)`; otherwise it removes the item. Bounded where a card's retry is not. |
| claimed, started | done | `done(id)` | engine acceptance, right after `consumeTaskExternalUpdates` and `consumeTaskHeldContinuations` (index.ts ~10581) | leaves the kept list, enters the tombstones. |
| owed, claimed, started | cancelled | `failed(threadId)` (rev 3) | `turn.completed` without success (index.ts ~8594) | the thread's records and intents; tombstones kept (see **cancelled** above). |
| any | cancelled | `cancel(id)`, `drop(threadId)`, `dropBot(botId)` | Stop (idle or busy, `dropAskerWakes`), bot or conversation deleted, dispatch failure of a direct wake (`onDispatchError`), attempts exhausted, nothing left owed | removed from the kept list and, for `drop` and `dropBot`, the tombstones; `drop` also removes the thread's intents and its held wake items (`dropHeldAskerWakes`). |

`has(threadId)` and `threads()` answer for **owed** records only, so the sweeps never re-claim a wake that is claimed, held or started.

### Durable before it counts (rev 6)

`flush` reports whether the write landed. The three transitions that authorize something refuse, and undo themselves, when it did not: `claim` (back to owed, undefined: the sweep tries again), `start` (back to claimed, false: the submission is refused), `replayHeld` (the attempt is not spent, false: the item stays and the next walk tries again). A write failure can therefore delay a wake, never double it or loop it for free.

### Overflow and idempotent delivery (rev 6, agreed list)

A thread holds at most `MAX_ASKER_WAKES` (16) records. A reply that fits an owed record of the same authority joins it (16 replies per record); otherwise it needs a record of its own, and when the thread is full it gets none: nothing kept is dropped, the newcomer wakes nobody by itself, and its reply is still in the thread and in `externalUpdates`, so the asker's next turn carries it as external context. `deliver` is idempotent by task id and by line id: a return that arrives twice (the finalizer and the receipt's recovery, a replayed commit) is one wake.

### The compare-and-set at the fence (rev 5, Sean's contract)

`start(id, allowed)` is one synchronous step that re-checks identity, cancellation and authority, then marks: the record is looked up by id; gone (Stop, failed turn, deleted bot or conversation, attempts exhausted) → false; owed (never claimed) → false; no reply passes `allowed` (the same predicate as the claim and admission: the reply still in `externalUpdates`, its author still a bot, the peer edge still open under the ask's audience) → cancelled, false; claimed or started → marked started and written, true; a done id → true unchanged (the engine accepted before the fence, or this is the rebuild of an accepted turn). On false `startTurnAdmitting` throws `DirectTurnSetupCancelled` from `beforeSubmit`, so the prompt never goes out and the setup ends on the quiet cancelled path (no error line; a held replay's `failed()` gets `retryable: false` and removes the item). `check(id, allowed)` at admission is the same question asked earlier, before the thread is taken. `claim(threadId)` is the compare-and-set on the other side: it takes the oldest record whose state is owed, sets claimed and writes, all in one tick, so two sweeps cannot both claim it.

### The agreed list (FINISH-103-PLAN.md, Fable + Astra), case by case

| Case | Where |
| --- | --- |
| the claimed + held state | section 2 (states), matrix column "claimed + held", tests "restores a held wake to its held item alone", "spends one attempt per held replay" |
| `start()` at the fence re-checks identity, cancellation and authority, refuses when the record is missing | this section; tests "refuses to start a wake that Stop cancelled", "cancels a wake at the re-check" |
| a wake started when a crash hit is at most once; the reply is kept as owed context | section 4 (started → dropped; `externalUpdates` untouched); test "restores a claimed wake as owed once ... never runs a started one again" |
| delivery idempotent by taskId + messageId | above; test "delivers one return once, however many paths bring it" |
| engine switch | the record is engine-agnostic: admission routes by the engine selected now (`turnRouting`); no tools → held `wake:<id>`, replayed when an engine with tools is selected (`drainHeldContinuations`); the switch between claim and admission changes only which path runs |
| permission change | the stored ceiling is applied through `effectiveRoutinePermissionMode`, the lower of the ceiling and the bot's level now (section 5); a level lowered after the ask lowers the wake |
| the bot deleted or the edge revoked | the asker deleted → `dropBot` (records, intents, tombstones); the teammate deleted or the peer edge revoked → `allowed` fails at the claim, at admission and at the fence → cancelled; a deleted conversation → `drop` |
| overflow | above |
| a late refusal followed by Stop | sections 2 and 3: `failed` keeps the tombstone, `drop` clears it; test "lets a rebuilt turn pass ... but never after Stop" |

### State × event (rev 5): every cell, and the test that covers it

Rows are the record's state (plus "none" and the done tombstone); columns are the events. "inert" means no change and, for a boolean, false. Tests are in `server/asker-wake.test.ts` by name.

| Event ↓ / State → | none | owed | claimed | claimed + held | started | done (tombstone) |
| --- | --- | --- | --- | --- | --- | --- |
| deliver (reply lands) | new owed record ("owes one wake per handed-over ask") | joins if same authority and room, else new record ("merges ... and caps", "never merges ... different authority") | new record ("claims a wake exactly once") | new record (same) | new record (same) | new record |
| consume (asker read it) | inert ("owes nothing for a task the asker read itself") | reply removed; empty record removed (same) | inert, the wake keeps its line ("claims a wake exactly once") | inert | inert | inert |
| claim | undefined | → claimed ("owes one wake") | undefined (same) | undefined | undefined | undefined |
| check | false ("refuses to start a wake that Stop cancelled") | false, never claimed ("events on the wrong state are inert") | true while a reply is allowed, else cancelled ("cancels a wake at the re-check") | true / cancelled (same) | true / cancelled | true ("lets a rebuilt turn pass") |
| start (fence CAS) | false ("refuses ... wherever it waited") | inert, false ("events on the wrong state are inert") | → started, or cancelled when no reply is allowed ("keeps a claimed and a started wake on disk", "cancels a wake at the re-check") | → started + held (same) | idempotent, true ("lets a rebuilt turn pass") | true unchanged (same) |
| deliver, thread full | refused, nothing dropped ("delivers one return once ... refuses a newcomer") | | | | | |
| deliver, same task or line again | refused ("delivers one return once") | | | | | |
| write fails on claim / start / replayHeld | undone and refused ("refuses a claim, a fence and a replay whose write did not land") | | | | | |
| hold | inert | inert ("events on the wrong state are inert") | → held ("keeps ... on disk") | idempotent | inert (same) | inert |
| replayHeld | false | inert, false (same) | inert, false (not held) (same) | attempt + 1 or cancelled at the cap ("spends one attempt per held replay") | inert, false, held or not ("events on the wrong state are inert") | false |
| requeue | false | inert, false (same) | → owed, attempt + 1, or cancelled ("gives a refused start back") | → owed, held cleared ("spends one attempt per held replay") | → owed ("gives a refused start back") | false |
| done | inert | inert (same) | removed, tombstone ("lets a rebuilt turn pass": early acceptance) | removed, tombstone | removed, tombstone ("keeps ... on disk") | idempotent |
| cancel | inert | removed ("gives a refused start back") | removed | removed | removed | inert (tombstone kept) |
| failed (turn ended badly) | inert | removed, intents forgotten | removed | removed | removed | kept ("lets a rebuilt turn pass") |
| drop (Stop) / dropBot | inert | removed ("drops a stopped asker's wake", "forgets everything a stopped or deleted bot asked for") | removed ("refuses ... Stop cancelled") | removed + held item removed by index.ts (same) | removed (same) | cleared (same) |
| restart (restore) | nothing | owed as kept ("persists every change", "drops a wake found at the cap") | → owed, attempt + 1, dropped at the cap ("restores a claimed wake as owed once") | kept if the item exists, else dropped ("restores a held wake to its held item alone"); dropped at the cap | dropped ("restores a claimed wake ... never runs a started one again") | gone (memory only) |
| restart, malformed record | dropped whole, never widened ("restores nothing from a malformed record", "restores no depth-0 intent ... without ... allowance") | | | | | |

### Invariant: one carrier

At every moment a record has at most one carrier: nothing (owed), the in-memory claim (claimed, not held), the held continuation `wake:<id>` (claimed + held), or the dispatched turn (started). A reply belongs to exactly one record, and a record is removed before any second wake for its replies could be claimed. The ways the old code made a second copy are gone: `claim` does not remove the record from the snapshot, there is no `settle` that clears disk early, and the held item is a pointer, not a copy.

## 3. Atomic claim and the re-check at start

- `wakeAsker` runs `claim` synchronously, then the owed filter (reply still in `externalUpdates`, target bot still exists, `authorizeWork` still allows the peer edge), then `startTurn(... { askerWakeId: record.id, onDispatchError: () => cancel(id), ...askerWakeTurnOptions(intent) })`. An empty filter result cancels the record.
- `startTurn` awaits (`prepareThread`, the writer gate). Stop in that interval calls `dropAskerWakes` → `drop(threadId)` → the record is gone.
- `startTurnAdmitting` runs `askerWakes.check(id, stillOwed)` as the last check before the single-tick admission path (where the ticket check sits today, index.ts ~9002). Refused → `asker_wake_stopped`.
- The held replay passes `item.options` (which carry `askerWakeId`) into the same `startTurn`, so the same re-check covers the High: Stop between the drain's selection and admission removed the record, the start refuses, and the drain's `failed()` sees `askerWake: true` with `startable(id)` false and removes the held item. Before the replay the drain calls `replayHeld(id)` (rev 3), which spends one attempt or ends the wake.
- Memory redispatch, both sites, spread `opts` unchanged, `askerWakeId` included (rev 2; revision 1 stripped it at the late site and lost the Stop check there):
  - the dispatch catch (~10654) runs before acceptance with proof nothing was submitted (`submissionBoundary.canRetry`); the record is claimed or started; `check` passes unless Stop removed it.
  - the late-submission refusal (~10537) runs after acceptance; the record is a done tombstone; `check` passes. Stop between the refusal and the rebuild runs `drop`, which clears the tombstones, so the rebuild refuses. The tombstone is the cancellation identity that survives `done`.
- A direct wake whose detached setup fails: `onDispatchError` cancels the record (no `turn.completed` is emitted on that path). The drain replaces that callback for a held replay with its own `failed()`, which is why the wake branch lives there.

## 4. Crash recovery that cannot double-wake

`restore(threadId, snapshot, heldIds)` runs at boot with the task's held continuation ids. Every record is validated whole (a field that does not read back drops the record, never widens it), then reconciled to exactly one carrier:

| Kept state | After restart | Why |
| --- | --- | --- |
| owed | owed | nothing was running. |
| claimed, not held | owed, `attempts + 1` | the claim lived in memory and died with the process before the prompt went out; nothing else carries it. The bounded attempts stop a crash loop. |
| claimed + held, item `wake:<id>` present | claimed + held, attempts as kept | the held item is the carrier; the drain replays it and `check` re-checks. Every replay spent an attempt before it began (`replayHeld`), so a replay that crashed in setup is paid for already; a record found at the cap is dropped and its item removed at boot. |
| claimed + held, item absent | dropped | the item went with Stop (then the record would be gone too, but the two writes are separate) or with acceptance; in both cases no wake is owed. |
| started (held or not) | dropped (rev 2) | the prompt may have reached the engine (the fence is written before the call; the delivery accounting is written after acceptance, in separate saves). The wake is never run again by itself, exactly as a queued hand-off found submitted and not accepted is not (`delegations.ts settleAfterFailure`). The reply itself is not lost: it is still in `externalUpdates`, and the asker's next turn carries it as owed context. At most once, never twice. |

At boot, after every thread is restored, a held item with `askerWake: true` whose record is not startable is removed (a started record that was dropped, a record at the cap, or a crash between the record's removal and the item's).

**The cap, exactly (rev 4).** `attempts` counts attempts spent; `MAX_ASKER_WAKE_ATTEMPTS` (6) is how many may be spent; a record is at the cap when `attempts >= MAX`. A direct start is paid when it comes back: `requeue` adds one and cancels the record if that reaches the cap (so five starts can be given back, the sixth refusal ends it). A held replay is paid before it begins: `replayHeld` cancels at the cap, else adds one (so six replays can begin, the seventh call ends it; a replay that failed and is still startable is re-held, and the next `replayHeld` decides). At boot a claimed record becomes owed with one added (its attempt was lost) and is dropped if that reaches the cap; a held record keeps its count and is dropped at the cap; an owed record is untouched (nothing was running, a restart costs it nothing). One counter for all three ways to spend. Records under the round-2 snapshot shape (`owed: {results}`) restore as nothing; that shape never shipped (lane only, base `int/1.0.3` has no `askerWakes`).

## 5. Stored ceiling, audience and allowance

The record's `intent` is taken when the hand-off is made (`askerWakeIntent` in handoff-boundary.ts), while the asking turn is the one running, and is never read live again:

- `notOwnerAudience` (words nobody proved were the owner's), `unattended`, `routineRun`, `eventId` (the automation budget), `depth`, `routineAuthority` (the routine ceiling, `permissionMode` + `triggerSource`), `coordination` (the hand-off allowance: `rootId` + `path`).
- `askerWakeTurnOptions` maps them onto the turn (`askerWake: true`, `commsDepth`, `coordination`, `notOwnerAudience` + `chainNotOwner`, `unattended`, `eventId`, `routineAuthority`), and a turn marked `askerWake` never reads `routinePeerSources` live (unchanged from round 2).
- **The ceiling applies to an unattended wake too (rev 2).** Admission today skips an explicit `routineAuthority` when the turn is unattended and then reads the routine conversation's live mode (`routineConversationMode`), which is the rule for the owner typing in a routine's conversation. A wake is not the owner typing. Three admission changes, each a no-op for every turn that is not a wake: the stored ceiling is applied when `opts.askerWake` even if unattended (and set on `routinePeerSources`, so a further hand-off from the woken turn carries it on); the conversation-mode read is skipped for a wake; the Full-access origin of an explicitly unattended turn is "other" before the routine test (in base an unattended turn never has `routineLevel` or `inheritedRoutine`, so this changes nothing there). Unattended approvals stay as restrictive as before (`auto-approve.ts` unattended-block); the ceiling only lowers the mode the engine's stop line, folder trust and approvals read.
- **The ceiling survives the next hop (rev 3).** `routinePeerSource` (index.ts ~16335) answers nothing for an unattended thread, so a woken unattended turn that hands off again would register wake B without the ceiling wake A ran under. The `register` port in index.ts (the one that already adds `routineRun`) fills a missing `routineAuthority` from `routinePeerSources.get(threadId)`, which the section 5 admission change set for the unattended wake. The peer's own authority on that hop is unchanged (it runs unattended, as every hand-off from an unattended thread does).
- **The owner asking from an idle routine conversation (rev 4).** With no run active, the owner's turn in a routine's own conversation takes the routine's level from `routineConversationMode` (index.ts ~9099), which neither `routinePeerSource` nor `routinePeerSources` records; its wake would carry no ceiling and, skipping the conversation-mode read, run at the task's own flags. Admission therefore remembers the conversation mode it applied, per thread (`conversationCeilings`, set when `conversationMode` applies and cleared on every other admission, exactly as `routinePeerSources` is), and the `register` port's fallback reads `routinePeerSources.get(threadId) ?? conversationCeilings.get(threadId)` as `{ permissionMode, triggerSource: "manual" }`. The wake then applies it through the same `inheritedRoutine` path as any explicit ceiling (`effectiveRoutinePermissionMode` + `peerTurnAuthority`, which only lower), and its Full-access origin is "routine" where the asking turn's was "owner": lower, never higher.
- **Allowance carried in the record, never minted:** a depth-0 intent always has a trace in memory (`internalOwner.coordination` is set by `coordinationBudget.begin` for every owner turn). `restore` therefore refuses a depth-0 intent or record without a coordination trace, so `beginInternalTurn`'s `depth === 0 ? begin()` branch is never reached by a restored wake. A deeper intent without a trace restores as a wake that cannot hand off at all (unchanged). After a restart the trace resolves against the persisted root in `coordination-budget.ts` (promoted at the first hand-off, 24 h expiry); an expired root means the woken turn cannot delegate, which widens nothing.
- Replies join a record only under `sameAuthority` (bot, depth, audience, unattended, routineRun, eventId, root, path, ceiling), so one wake never mixes ceilings.

## 5a. Revision 7 (Astra build round 3)

- **The asking bot's own level is part of the ceiling.** `askingMode` (the level the asking turn is running at: `botPermissionMode` of the turn's own bot copy, `directRuns.get(threadId).snapshot`, which carries every lowering admission applied, a capped wake's own included; the task's flags only when no turn runs, which a hand-off never is) is stored in the intent and applied at admission as a pure lowering (`effectiveRoutinePermissionMode`: the lower of it and the level now), after every other mode decision; the turn's origin and routine record are unchanged. A bot raised to Full access after the ask does not wake into it. Replies asked at different levels never share a record. A level that does not read back refuses the record.
- **Authority is asked again on a tombstone.** `done` keeps the replies the turn carried; `check` and `start` on a done id pass only while one of their authors is still a bot the asker may hear from (`authorized`: the peer edge now, the audience the ask was made for), the owed half excluded (those replies were carried). A grant revoked between an early acceptance and the fence, or before a rebuild, refuses the submission.
- **A failed write is retried, never cancelled, never stranded.** Direct: `onDispatchError` gives a claimed record back (`requeue`, bounded) and ends a started one (uncertain outcome). Held: a replay refused before it began with the record still carried waits for the next walk; a replay that failed with the record still carried is re-held as `retry` (never `authority`: the owner is not asked to retry a wake); started → the record ends and the item goes; gone → the item goes.
- **A torn hold is reconciled at boot.** A held wake item is kept only while it is its record's carrier (`isHeld`: claimed + held); an item written before the record was marked held, or whose record restored as owed, goes, and the owed record wakes through the direct path.

## 5b. Known limits (agreed, A7 and A6 of FINISH-103-PLAN.md)

- Automatic wake is at most once, not exactly once: a record found started at boot is dropped (the prompt may have reached the engine); its reply stays in `externalUpdates` and the asker's next turn carries it as owed context.
- Where an engine hands its turn id back before the submission fence (Codex), the base delivery accounting treats acceptance as delivery (`consumeTaskExternalUpdates` at `directRuns.accepted`); the wake record follows that accounting (`done` from claimed) and does not re-decide it. A crash between that acceptance and the submission loses the wake, never doubles it.
- A thread full of records (16, beyond the 16 replies per record the list names) refuses a newcomer rather than evicting kept work; the newcomer's reply is still owed context for the next turn.
- A write that fails under a claim, a fence or a replay delays the wake to the next sweep or walk; it is never doubled.
- A write that fails under a cancellation (Stop, a failed turn, a deleted bot) is remembered (`unwritten`) and written again by the parked-delegation sweep (30 s) and by the next change to that thread (rev 8, Astra build round 5). The store keeps the task's field as the disk has it when its save throws (`setTaskAskerWakes`, rev 9), so the retry reaches the disk instead of returning early on a field already cleared in memory; `server/asker-wake-store.test.ts` proves it against the real store with the atomic write failing once. Only a crash before any later successful write leaves the old owed record on disk, and a restart then wakes once what Stop had cancelled: the disk refused the cancellation, and nothing durable can be written to a disk that refuses writes. The asker's reply, in that case, is a real reply that the asker never saw.

## 6. What Stop does

`dropAskerWakes(botId, threadId)` (Stop on a direct thread, idle or busy) and `askerWakes.dropBot` (stop everywhere, bot deleted) remove every record of the thread or bot in any state, the done tombstones, the intents still out, and the held wake items. `turn.completed` without success runs `failed(threadId)`: the thread's records and intents go (a stopped or failed wake turn restarts nothing; a stopped asker's late reply restarts nothing), the tombstones stay for the late memory rebuild (rev 3).

## 7. Changes by file

- `server/asker-wake.ts`: records replace `pending` + `taken`; API `register`, `deliver`, `consume` (intents and owed records only), `has`, `threads`, `claim`, `check`, `start`, `startable`, `hold`, `replayHeld`, `done`, `requeue`, `cancel`, `failed`, `drop`, `dropBot`, `snapshot`, `flush`, `restore(threadId, snapshot, heldIds)`, `heldWakeId`. `askerWakeHeldIds`, `askerWakeTurnOptions`, `askerWakePrompt` unchanged. `AskerWakeSnapshot` becomes `{ intents, wakes }`.
- `server/index.ts`: `wakeAsker` (claim / check / requeue / cancel, `onDispatchError`); `opts.askerWakeId?: string` replaces `askerWakeTicket`; the admission re-check calls `check(id, stillOwed)`; the no-tools hold uses id `wake:<id>`, no `cardId`, keeps `askerWakeId`, calls `hold(id)`; the submission fence calls `start(id)`; acceptance calls `done(id)` after the two consumes; the drain calls `replayHeld` before replaying a wake item and its `failed()` removes a wake item that is no longer startable; the `turn.completed` failure path calls `failed(threadId)`; the `register` port fills a missing ceiling from `routinePeerSources`; the three admission lines of section 5; boot restore passes the held ids and removes orphaned held wake items.
- `server/store.ts`: no change (the field type is imported).
- Tests (written first): `server/asker-wake.test.ts` covers every row of the two tables above; `server/comms.test.ts` keeps the three e2e cases (wake, Stop while idle, delegate_bot return).

## 8. Finding → closure

| Finding | Closed by |
| --- | --- |
| High: held replay starts after Stop | the held item carries `askerWakeId`; `check` re-checks the record in the admission tick; Stop removed it; the drain removes a cancelled wake's held item. |
| Medium: record lost mid-start / cleared before acceptance | claimed and started records stay in the snapshot; `done` only at engine acceptance. |
| Medium: crash leaves held copy + owed record | one record; the held item is a carrier; restore reconciles to one carrier; `started` is dropped at restart (at most once); the owed filter inside `check` is the backstop. |
| Medium: fresh allowance after restart | restore refuses a depth-0 record without a trace. |
| Medium: memory redispatch reuses an expired check | `check` accepts claimed, started and the done tombstone; neither redispatch site strips the id; Stop clears the tombstone. |
| rev 2 High: acceptance not crash-atomic | `started` at the submission fence; a started record is dropped at restart. |
| rev 2 High: late redispatch after Stop | done tombstones, cleared by `drop`. |
| rev 2 Medium: held replay failures unbounded | `replayHeld` shares the attempts cap and is paid before the attempt; the drain removes the item on false. |
| rev 2 Medium: unattended wake skips its ceiling | the three admission changes in section 5. |
| rev 3 Medium: failed-turn drop clears the rebuild's tombstone | `failed(threadId)` keeps tombstones; only Stop clears them. |
| rev 3 Medium: acceptance before the fence (Codex) | `done` from claimed or started; `start` is a no-op on a tombstone. |
| rev 3 Medium: held replay crash-loop | `replayHeld` before the replay, persisted; the cap is checked at boot. |
| rev 3 Medium: ceiling lost on the next hop | the `register` port fills it from `routinePeerSources`. |
| rev 4 Medium: idle routine conversation's level not captured | admission records the applied conversation mode; the `register` port falls back to it. |
| rev 4 Medium: the cap undefined | section 4, "The cap, exactly". |
