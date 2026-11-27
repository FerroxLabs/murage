# CLOUD-COMPUTER-BOOT-105: a cloud computer turn cut off by a restart is stopped at the provider, and an ended request settles as cancelled

Lane fix/105-cloud-computer-boot on fix/104-cancel-tree-d12 82c5129a4. Closes the two residuals of CANCEL-TREE-104 section 5:
(a) a cloud computer (boxAgent) turn accepted before a crash is not re-interrupted at boot: the box keeps running and acting with nothing
watching it; (b) an acceptance or submit stamp is read as "the provider has it", so a hand-off whose request ended is held or receipted
"interrupted by a restart", never settled as cancelled.
Round 2: every item of Astra's round-1 REVISE is answered in place (C0 item 1; C2 items 2, 8; C3 items 4, 5; C5 item 3; L1 item 6; C6 item 7;
C7 item 11; H1 items 9, 10; section 5 item 12). Round 2 REVISE (12 items) was the last round (cap 2): section 6 records how each
item is closed in this text, simplified and fail closed, with the one provider assumption that remains stated for Sean.

## 0. Facts this design rests on (verified in code)

- server/drivers/boxagent.ts: the turn runs ON the bot's box. sendTurn calls beforeSubmit, then POST /boxes/{box}/prompt (returns promptId),
  then returns {turnId}; the host's accepted callback (index.ts recordHandoffAccepted) stamps accepted_turn_id after that. Progress is read
  only by this process's poll loop (GET /events, GET /prompts/{promptId}); the stop is POST /boxes/{box}/interrupt (box-wide). The only
  record of a live box turn is the in-memory `active` map: after a crash nothing knows the box, the prompt or the thread.
- A local engine's turn is a child of the process and ends with it; a box turn does not.
- The next turn on the same box polls GET /events with a fresh `seen` set, so events of an earlier prompt still listed there are read as
  the new turn's work.
- delegations.ts settleAfterFailure (boot settle, live afterStartFailure): accepted -> "interrupted by a restart" receipt (failed, owed
  reply); submitted with no evidence -> held for the owner; a held row (started_at NULL) returns early. It never reads the request of a
  handed row. Held rows are visited at boot only by noticeHeldPage.

## 1. State machine A: one cloud computer prompt (new ledger, server/cloud-computer-turns.ts)

The ledger is `cloud-computer-turns.json` in the data folder (atomic write with fsync; the in-memory copy changes only after the write
succeeded), one entry per box prompt: { turnId, boxId, threadId, promptId|null, owner (this process's random id), state, at, line }.
Classified `excluded` in data-dir-inventory (runtime state; a restore never brings back stops for boxes it did not start), and so is
`cloud-computer-turns.json.unreadable` (C0).

| State | Meaning | Leaves by |
|---|---|---|
| L0 none | no prompt of this turn can be on the box | sendTurn, under the box lock (C3): write L1 BEFORE beforeSubmit and the POST; a failed write refuses the send |
| L1 sending | the POST may be on its way | 2xx with a promptId -> L2; 2xx without one -> L2 with promptId null; a proven refusal (rule L1R) -> L0; any other answer or none -> L4; beforeSubmit threw -> L0 |
| L2 running | the box has it; this process's poller is registered as its monitor | the poll reads a terminal status (or the event backstop's end) -> L0; Stop -> L3; the poller fails -> L4 (C6) |
| L3 stopping | a Stop is being confirmed | confirmed (C2) -> L0; not confirmed -> L4 |
| L4 fenced | the box may still run it; nothing reads it | a confirmed stop (C2) -> L0, or L5 while its line is owed |
| L5 stopped, line owed | the stop is confirmed; only the owner's line is missing | the line is written -> L0 |

L1R (proven refusal): only an HTTP answer of 400, 401, 402, 403, 404, 409, 422 or 429 clears L1 (the box answered and did not take it).
Every other outcome (5xx, 408, any other status, an unparseable answer, a network error, the 30 s timeout) is L4.

Blocking entries of a box (they keep it from taking a new prompt): every entry not in L5 that is (a) another process's (an orphan of a
process that died; a provider reload keeps the owner), (b) L4, (c) this process's L1-L3 with no registered monitor (its poller ended or
its last transition could not be written: lost monitoring). This process's monitored L2 entries are "live".

## 2. Rules

C0 (an unreadable ledger is unknown, not empty). A ledger file that cannot be read or parsed is never overwritten. While it is unknown
every box send is refused ("Murage cannot yet tell whether a cloud computer is still running work from before the restart. Try again in
a minute."). Recovery (at boot and at every refused send): GET /boxes must answer with a box list; every listed box gets the stop of C2's
no-id rule (not before the file's modification time + 60 s); all confirmed -> the file is renamed to `cloud-computer-turns.json.unreadable`
and the ledger starts empty. Anything less keeps it unknown. No thread is known, so there is no owner line; the refusal is what the owner reads.

C1 (boot). Right after the hand-off host is configured, before settleStartedHandoffs, the server starts recoverCloudComputerTurns with the
configured box token: every box with blocking entries is cleared (C2) under its lock, boxes in parallel. The stop does not wait for the first
health answer; the owner lines do. Confirmed: each orphan -> L5 -> its line -> L0. Not confirmed: each orphan -> L4 with its line.

C2 (stop and confirm, fail closed).
- Interrupt: a 2xx whose body is not `ok:false` is an acknowledgement. A 404 confirms only when GET /boxes answers with a list that does not
  hold this box (the box is gone, and every prompt on it). Anything else is not confirmed.
- Each entry with a promptId: GET /prompts/{promptId} up to 5 times, 1 s apart; the driver's own terminal sets (done: completed, succeeded,
  done, finished; ended: failed, error, cancelled, interrupted) confirm; 404 confirms only with the box-gone check; still running or
  unreadable after the last read is not confirmed.
- No-id rule (an entry with promptId null: a crash or timeout before the POST's answer, or a 2xx without an id): the interrupt is sent no
  earlier than the entry's time + 60 s, twice the POST's 30 s client timeout. Provider ordering assumption, stated: a prompt request the box
  has not taken within 30 s of its send is never taken later (its connection is gone). After that wait the acknowledged box-wide interrupt
  confirms it.

C3 (the gate before every prompt; one box lock). A per-box lock in the module (shared by every driver instance, so reloads too)
serializes, for one box: the gate, the stop, the L1 write, beforeSubmit, the POST and its answer's transition; a Stop's confirmation; a
recovery. Under the lock a send: (1) C0 unknown -> refused; (2) blocking entries and a live turn of this process on the box -> refused
("...stopped only when no other turn is running there"), nothing interrupted; (3) blocking entries, none live -> C2; not confirmed ->
refused ("Murage could not confirm that work from before is stopped on this bot's cloud computer, so nothing new is sent to it yet. Try
again once the computer is reachable."); (4) GET /events snapshot: every listed event id is marked seen for the new turn; a snapshot that
fails refuses the send; (5) L1, beforeSubmit, POST. The snapshot runs on EVERY send: every earlier prompt of this box is terminal or
confirmed stopped before it (blocking entries are cleared first; a live turn of another thread is the only exception, and its events are
shared with the new turn exactly as today), and a terminal prompt emits no further events (assumption, stated), so nothing from before is
ever read as the new turn's work, delayed or not.

C4 (nothing acts on an orphan's results). After a restart no poll of an orphan prompt exists and none is ever started for it: its text,
tools and status reach no thread, no receipt and no asker. C3's snapshot keeps them out of every later turn. The hand-off row of an orphan
is settled from the row alone (H1, or today's interrupted/held), never from the box.

C5 (live Stop). The local cancel is immediate, as today (the turn settles cancelled at once, STOP1). The ledger side runs under the box
lock: L3, interrupt, C2 for its promptId (no-id rule for a null id) -> L0, or L4 with the in-process line (C7).

C6 (lost monitoring). The poller registers its turn as monitored when it starts and unregisters it on every exit. A poller that throws
moves its entry to L4 (in-process line). A transition write that fails leaves the older state on disk and in memory; the unregistered
entry is then blocking (c), so the next send on that box stops and confirms it first.

C7 (the owner's line, one per entry, stating only what is established). In the thread the turn ran in; skipped when that thread is gone.
- restart, confirmed (`cloud-computer-restart:<turnId>`): "Murage restarted during this turn. Its work on the cloud computer was stopped
  there, so nothing from before the restart carries on."
- restart, not confirmed (same id): "Murage restarted during this turn and could not confirm that its work on the cloud computer stopped.
  Nothing it does now is read as a reply, and Murage stops it before the next turn on that computer."
- this process, not confirmed: a Stop or a lost poller (`cloud-computer-unconfirmed:<turnId>`): "Murage could not confirm that this turn's
  work on the cloud computer stopped. Nothing it does now is read as a reply, and Murage stops it before the next turn on that computer."
An entry whose line was written never gets a second one when it is later confirmed.

H1 (an ended request settles a handed or held hand-off as cancelled). For a started-phase row that was handed over (accepted_turn_id or
submitted_at) or is held (started_at NULL), whose request ended by a cancel (requestEndedForHandoff: the request is `cancelled`, or a room
ask whose asker above it was cancelled, askerEnded; a held hand-off's own request already reads `failed` from its hold receipt, so "terminal"
alone would close every held row; requests that expired or failed on their own keep today's path): instead of "interrupted by a restart", held, or left
held, the CANCEL-TREE-104 R6 closing line in the source room (same text, same stable id), then the cancelled receipt on disk (result
cancelledEnding(outcomeNote), no owed reply: nobody wakes the asker that ended; it replaces a held row's earlier receipt), then the row's
removal (a held row through releaseHeld, which clears its Send again control in the same commit). A step that fails, or no line writer
(SettleOptions.closingLine, or a store that can append), returns "unsettled" and keeps the row; there is no fallback to interrupted/held.
Sites: settleAfterFailure (the boot settle of started rows, and live afterStartFailure, which now passes the full settleOptions(env));
noticeHeldPage at boot (H1 before the held notice); dropDelegationsOf at the cancel's post-commit (a held hand-off of the cancelled
request). A never-handed, not held row keeps R3's reset path. The provider side of such a row is C1-C6's job.

## 3. Cancel before, during and after the crash (hand-off on a box)

| # | When the cancel lands | Row / request at boot | Outcome |
|---|---|---|---|
| X1 | before the crash, after acceptance; R1's live interrupt ran | accepted / cancelled; ledger L3 or L4 | C1 confirms or fences the box; H1: closing line + cancelled receipt |
| X2 | before the crash, effects not run (commit, then crash) | accepted / cancelled; ledger L2 | same as X1 |
| X3 | during setup: submitted, POST in flight at the crash | submitted / cancelled; ledger L1 (id null) | C1 no-id rule; H1 (not held: nothing for the owner) |
| X4 | no cancel before the crash | accepted / running | C1 confirms or fences; today's "interrupted by a restart" receipt, the asker is told |
| X5 | after the crash, before the boot settle's writes | accepted / cancelled | as X1 |
| X6 | after the boot settle | receipted (X4) or held | receipted: nothing more; held: dropDelegationsOf settles it by H1 |
| X7 | live, refused at acceptance (R2: the box took the POST, accepted() threw) | submitted / cancelled | the host interrupts the turn (C5); afterStartFailure -> H1 instead of held |
| X8 | before the crash, the row already held (X3 of an earlier boot) | held / cancelled | noticeHeldPage -> H1 |

## 4. Failure list

| # | Case | Outcome |
|---|---|---|
| F1 | crash before the L1 write | nothing was sent |
| F2 | crash after L1, before or during the POST | orphan L1, id null: no-id rule |
| F3 | crash while running | orphan L2: interrupt + status confirm, or L4 |
| F4 | box unreachable or no token | L4 + one "could not confirm" line; every later send retries C2 and is refused until it confirms |
| F5 | the prompt still reads running after 5 reads | L4 |
| F6 | the box was deleted | 404 + not in the account's list: confirmed |
| F7 | an ambiguous 404 (list unreadable, or the box is still listed) | not confirmed |
| F8 | ledger write fails at send | the send is refused, nothing sent |
| F9 | ledger file unreadable | C0: unknown, never overwritten, every box send refused until every listed box is confirmed stopped |
| F10 | a second boot before the lines were written | still owed (L4/L5): written once; the stable id prevents a duplicate |
| F11 | provider reload in the same process | same owner: not orphans; the old instance's Stop/dispose runs C5 |
| F12 | the turn's thread was deleted | no line; the box is still confirmed or fenced |
| F13 | an orphan's events still listed | C3's snapshot marks them seen |
| F14 | two sends, or a send and a recovery, race on one box | the box lock: one at a time; a recovery never interrupts a prompt sent after it read its targets |
| F15 | blocking entries while another turn of this process runs on the box | refused, nothing interrupted |
| F16 | the poller throws, or a transition write fails | L4 (C6), or blocking (c); stopped and confirmed before the next send |
| F17 | H1 line write fails, receipt not on disk, or no writer | "unsettled": the row stays, the next pass repeats |
| F18 | 2xx without a promptId | L2 id null; its Stop and recovery use the no-id rule |

## 5. Tests (fail on 82c5129a4, pass on the branch)

| Test | Proves |
|---|---|
| B1 boot stop | seeded orphan L2 + fetch double: interrupt, status cancelled -> entry gone, one "stopped" line under the stable id; a second recovery adds none |
| B2 unconfirmed | fetch throws -> L4 + one "could not confirm" line; a send on that box retries C2, still failing -> refused, no POST; box back -> interrupt first, snapshot, then the POST; the old events never reach the new turn |
| B3 still running / ambiguous 404 | status stays running -> L4; interrupt 404 with the box still listed -> L4; 404 and not listed -> confirmed |
| B4 no-id rule | an orphan L1: no interrupt before at + 60 s (clock injected), confirmed after |
| B5 driver ledger | the L1 entry is on disk when the POST arrives; a 500 or a network error -> L4; a 409 -> L0; completion -> L0; a Stop whose status stays running -> L4 + in-process line; a poller throw -> L4 |
| B6 lock and live guard | a recovery and a send on one box run one after the other; blocking entries plus a live turn: the send is refused, no interrupt sent |
| B7 unknown ledger | an unparseable file is kept as is, sends refused; listed boxes stopped -> file set aside, sends go again |
| H1a/b/c | accepted, submitted-only and held rows with the request cancelled: the boot settle writes the closing line, the cancelled receipt, row gone; never held, never "interrupted by a restart"; no wake; no writer -> unsettled, row kept; a request still running keeps today's path; live afterStartFailure of a submitted row -> H1; dropDelegationsOf settles a held row |
| S1 sites | index.ts starts the recovery at boot with the box token and configures the line writer; data-dir-inventory classifies both names |

## 6. Round 2 (last round): how each item is closed

The rules above are amended as follows; where this section and sections 1-2 differ, this section governs.

| Astra r2 | Change |
|---|---|
| 1, 2 (no-id stop; interrupt semantics) | A prompt WITH an id is confirmed only by its own status: read first (already terminal: confirmed, no interrupt sent), else interrupt, then read again; an interrupt acknowledgement alone never confirms it. A prompt WITHOUT an id (the POST got no answer, or a 2xx without an id) has no prompt-scoped proof. It stays fenced and is confirmed only by an acknowledged box-wide interrupt (2xx, JSON body, not `ok:false`) sent no earlier than 60 s after it was recorded. This is the one stated provider assumption (a prompt request the box has not taken within the sender's 30 s is never taken later). It is reported to Sean as a decision; the code keeps it in one place (`NO_ID_WAIT_MS`). |
| 3 (L1R) | Kept to HTTP client-error semantics, narrowed: only 400, 401, 403, 404 and 422 (the request was not acceptable as sent) clear L1. 402, 409, 429 and every other answer are L4 (fenced, no-id rule). |
| 4 (event barrier) | The snapshot stays on every send, and an event that names its prompt (promptId / promptRunId at the top or under `data`) is read only when it names this turn's prompt. An unnamed event listed after the snapshot is read as today (the box gives no cursor); after a confirmed terminal status of every earlier prompt this is the driver's existing box-wide stream, not a new path. |
| 5 (event backstop) | The backstop (no promptId, a box-wide "complete" event) still ends the turn for the owner, but its entry goes to L4 without a line, never L0: nothing proves that prompt ended. The next send clears it by the no-id rule. |
| 6 (stale stops) | Under the lock, a recovery and a queued Stop re-read their targets, and neither sends a box-wide interrupt while another watched turn of this process is live on the box: the targets stay L4 (a Stop) or blocking (a recovery) and the next send settles them. |
| 7 (ledger writes) | Every change is a synchronous read-modify-write of the in-memory list followed by a synchronous atomic file write, with no await inside it; one process holds a data folder (the data-dir lease), so no write can lose another box's entry. No code change. |
| 8 (schema) | The file is `{ version: 1, entries, unknown? }`; every field is checked (state in the five names, ids non-empty strings, promptId string or null, at a finite number). Anything else is unknown (C0). |
| 9 (account) | Each entry records a fingerprint of the token it was sent with (first 16 hex of its sha256). A stop or a box-gone check uses the current token only when the fingerprints match; a different account confirms nothing (fenced). C0 no longer interrupts every listed box: an unknown file is set aside under `.unreadable` (kept, not deleted), the new ledger records `unknown.since`, and each box gets one no-id-rule clearing before ITS first send (the bot's own box, nothing else), remembered in `unknown.cleared`. |
| 10 (L5-only restart) | Boot recovery always writes every owed line (L4 and L5), whatever the blocking set. |
| 11 (confirmed end, cleanup failed) | A turn this process saw end (terminal status) whose removal could not be written is remembered in memory as ended: not blocking, no line, no interrupt; the next successful write drops it. At a restart it is an orphan whose status reads terminal: confirmed without an interrupt. The restart line for a confirmed orphan says only what is established: "Murage restarted during this turn. The cloud computer has no work from it still running, so nothing from before the restart carries on." |
| 12 (tests) | Section 5 plus: a status already terminal (no interrupt sent), a 2xx-without-id backstop (L4), a Stop queued behind a live turn (no interrupt), another account's token (fenced), an invalid schema (unknown, set aside, per-box clearing), an L5-only restart (line written), a cleanup write failure (no alarm). |

## 7. Grok round 1 (REVISE, 2 Highs): the record is never missing, and a turn reads only its own prompt's work

Where this section and sections 1-6 differ, this section governs.

### 7.1 Finding 1: setting an unreadable record aside left a window with no record (cloud-computer-turns.ts load(), old :81-93)

Root cause: load() renamed the unreadable file to `.unreadable` FIRST and then wrote the new record best-effort. A crash between the two, or a
failed write, left no `cloud-computer-turns.json`; the next start read "no file" as an empty record (not unknown, not stuck) and sent.

State machine of the record file (path P = cloud-computer-turns.json, U = cloud-computer-turns.json.unreadable):

| State | On disk | Next load reads it as | Leaves by |
|---|---|---|---|
| R0 absent | no P, no U | empty (no prompt was ever recorded) | first save -> R1 |
| R1 valid | P valid | its entries (and `unknown` when present) | every save (atomic replace) -> R1 |
| R2 bad | P unreadable or invalid | unknown | set-aside (below) -> R3, or stays R2 when any step fails (stuck: every send refused this run) |
| R3 set aside | P valid with `unknown: {since, cleared: []}`, U = copy of the bad bytes | unknown (per-box clearing, section 6 item 9) | each box cleared -> R1 with `cleared` grown |
| R4 lost | no P, U present (only by an outside deletion of P, or a crash under the replaced code) | unknown, `since` = U's modification time | the new record is written -> R3 |

Set-aside, in this order (every step synchronous): (1) `since` = P's modification time; (2) copy P to U and fsync the copy; (3) write the new
record over P with writeFileAtomic (temp file, fsync, rename over P, `syncDir: true`). P is never renamed away or deleted: at every instant
it holds either the bad bytes (R2) or the new record (R3). Any step that throws: `stuck` (every send refused with the unknown refusal for
the rest of this run), P untouched, so the next start finds R2 again.

| # | Failure | Outcome |
|---|---|---|
| G1 | crash after (1) or during (2) | P still bad: next start R2, set aside again (U overwritten with the same bytes) |
| G2 | copy (2) fails (disk full, permission) | stuck, P kept bad; next start retries |
| G3 | crash during (3) before its rename | P still bad (the temp file is a stray): R2 again |
| G4 | (3) throws | stuck for this run; P is still bad (R2), or, when only the directory sync after the rename threw, the new record (R3): both are unknown at the next start |
| G5 | crash after (3)'s rename, before the directory sync | the rename is either on disk (R3) or not (R2); both are unknown |
| G6 | P deleted from outside after R3 (U kept) | R4: unknown again from U's time, never empty |
| G7 | R4 and the new record cannot be written | stuck, every send refused |

### 7.2 Finding 2: the event barrier let unnamed events, and every event of a turn with no prompt id, into the turn (boxagent.ts old :230, :258)

Root cause: an event was skipped only when it named a prompt AND this turn had an id. An event that named no prompt, and every event of a
turn whose 2xx carried no id, reached the turn as its text, its tool rows and (no id: the backstop) its completion. After a restart, a
trailing event of the cut-off prompt could be read as the new turn's reply.

Rules (replace section 6 items 4 and 5):

- E1 (a turn with no prompt id is not followed). A 2xx without a prompt id gives Murage no way to tell this prompt's work from any other.
  The entry goes to L4 at once (no line: the turn's own message says it), no event and no status is read for it, and the turn ends with
  `runtime.error` "This bot's cloud computer took the turn without naming it, so Murage cannot follow it. Nothing it does is read as a reply,
  and Murage stops it before the next turn on that computer." then `turn.completed ok:false`. The next send clears it by the no-id rule. The
  event backstop (complete/finish events settling a turn) is removed.
- E2 (an event naming a prompt). Read only when it names this turn's prompt id; any other id is skipped (not text, not a tool row, not
  activity).
- E3 (an event naming no prompt). The send reports whether this box was clean: `strict` is true when, under the lock, the gate cleared
  the box for an unknown record, or the record held ANY other entry on this box (an orphan, a fenced prompt, a lost watcher, an L5 entry, a
  prompt seen ending whose removal is not yet written, or another watched turn of this process live on the box). A strict turn reads an unnamed event only as activity (the silence watch's heartbeat):
  never as text, a tool row or an end. Its reply is the prompt's own status result. A clean turn (no earlier prompt of this box can still
  emit: every earlier one ended under its own watcher's terminal status reading, section 6 item 11) reads unnamed events as today, so live
  text and tool rows keep working on boxes that do not name prompts in their events.
- E4. Ending a turn is decided only by the status of its own prompt id (E1 removes every other path); a Stop is unchanged (C5).

| # | Failure | Outcome |
|---|---|---|
| G8 | after a restart, the cut-off prompt emits a trailing `response`/`complete` event naming no prompt | the new turn is strict (the gate cleared the orphan): activity only; text and end come from the new prompt's status |
| G9 | a trailing event naming the old prompt id | skipped (E2), strict or not |
| G10 | 2xx without an id | E1: L4, turn ends ok:false with the message, nothing read |
| G11 | two live turns of this process share a box | the second is strict: its text comes from its own status result |
| G12 | a clean box that names no prompts in events | unchanged from today: live text and tool rows |
| G13 | a strict turn whose status result is empty | "(finished)" as Murage's own line, as today (never engine text) |

### 7.3 Tests (fail on 597d02f71, pass on the fix)

| Test | Proves |
|---|---|
| R1 never missing | with the new record's write failing: P still holds the bad bytes, stuck, sends refused; at a restart P is still unknown (old code: P missing, empty, the send goes out with no clearing). At the moment the new record is written P exists (old code: already renamed away). |
| R2 lost record | no P, U present: unknown with `since` = U's time, the box is cleared before its first prompt |
| R3 strict turn | an orphan cleared at send, then an unnamed `response` "OLD WORK" and an event naming the old id listed after the snapshot: the turn's reply is its own status result, "OLD WORK" never reaches it (old code: streamed as the reply) |
| R4 no id | a 2xx without an id followed by an unnamed `complete` event: the turn ends ok:false with the E1 message, entry L4, no engine text (old code: settled ok:true from the event) |
| R5 clean box | existing boxagent.test.ts streaming tests pass unchanged (unnamed events, clean box) |

### 7.4 Astra round 1 (REVISE, 7 items): how each is closed. Where this differs from 7.1-7.3, this governs.

| Astra r1 | Change |
|---|---|
| 1 (recovery loses history) | A persisted per-box QUARANTINE (`quarantine: {boxId: setAt}` in the record, schema-checked). It is written BEFORE any clearing of that box (clearBoxLocked, at boot and at a send; a quarantine that cannot be written clears nothing and the send is refused), and with the box's entry in `unknown.cleared` (C0). It survives the orphan's removal, retries and restarts. It is lifted only in the same write that removes a turn of that box sent at or after `setAt` and ended by ITS OWN prompt's terminal status (a Stop's break, which reads no status, never lifts it; a write that fails keeps it). Drain boundary, stated as an assumption next to section 2's: a prompt confirmed terminal emits nothing listed after one full later prompt on the box has run to its own terminal status. |
| 2 (overlapping readers) | `strict` is no longer computed once at the send. Every unnamed event is checked with cloudTurnStrict(turnId) at the moment it is processed: strict when the box is quarantined, or ANY other entry of the box is on record (not L5, not seen ending), or the record is unreadable, or this turn was strict before (sticky to its end). A second send writes its L1 entry before its POST, under the box lock, so the first reader is strict before any event of the second prompt can exist. |
| 3 (needless strictness) | Entries seen ending (endedHere) and L5 entries no longer make a turn strict; the quarantine covers L5's box. A clean box keeps live streaming. |
| 4 (rename durability) | Every record write uses `syncDir: true`. A write that throws refuses the send before the POST (F8), as before. |
| 5 (G4) | Amended above: a throw after the rename leaves R3; stuck this run, unknown at the next start either way. Tested with an injected throw after the write. |
| 6 (malformed ids) | sendCloudPrompt normalizes the id once (a non-empty string, else null) and returns the normalized value; a number or object is E1 (not followed). |
| 7 (proven absence) | Absence is proven only by ENOENT from stat. Any other lookup error on P is read as an unreadable record (copy aside fails, stuck, nothing sent); any lookup error on U with P absent is R4 (unknown). |

Tests added to R1-R5: R6 quarantine after boot recovery (orphan confirmed and its line written, entry gone: the next turn still reads no unnamed event; once it ends by its own status the following turn streams unnamed text again); R7 two readers (neither turn's thread gets the other's unnamed output); R8 a throw after the record's rename (stuck this run, unknown at restart); R9 malformed id (E1); R10 P a symlink loop (stuck, refused, not empty) and U a symlink loop with P absent (unknown).

### 7.5 Astra round 2 (REVISE, item 2 only; items 1 and 3-7 closed)

Strictness was latched only when a reader processed an unnamed event, so a turn that ended and left the record before that check could
unlatch the other. Change: in sendCloudPrompt, after the new L1 is written and before beforeSubmit and the POST, the new turn is latched
strict when any other entry of the box is on record (not L5, not seen ending) or the box is quarantined, and every such other turn is latched
strict too. Latches are released only when the turn ends (cloudTurnFinished) or its send fails. The per-event check stays as a second guard.
Test R11: two sends, the first ends and leaves the record, the second stays strict.

### 7.6 Grok round 2 (REVISE, 1 High; both round-1 Highs confirmed closed)

High: a Stop whose `stopping` write failed left the entry `running`; the poller's break then removed it as ended (or marked it seen ending), and
the Stop's confirmation read the missing row as confirmed, so a prompt that may still run had no record and no quarantine. Change: the Stop's
break (cloudTurnFinished `ended` with `terminal: false`) never removes an entry and never marks it seen ending; a `sending`/`running` entry
there is fenced (L4), and if that write fails too it stays as it is, unwatched and so blocking (C6). stopCloudTurn treats a missing row as
confirmed only when its own `stopping` write succeeded. Medium folded in: an unnamed event a strict turn does not read is not written to that
thread's native trace either. Tests R12 (both writes fail: the next send reads the old prompt's status before any POST) and R13 (trace).
