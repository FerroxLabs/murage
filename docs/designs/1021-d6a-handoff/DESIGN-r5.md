# DESIGN (round 5, Opus redesign after Astra r4 BLOCK): DELEG D6a hand-off producer: "have my secretary book a table", 1.0.22

Owners, one per side (OWNERSHIP rule; every contract below names both sides):
- This document: lane design-1022-g2-d6a (designer, round 5 = Opus redesign of round 4 `8b49ab7d48` after ASTRA-DESIGN r4 BLOCK
  5 High, board `int-1021-n4/QUESTIONS-FOR-MAIN.md:4717`; FABLE-DESIGN r4 AGREE with 4 Medium, `:4713`), for SCOPE-1022 row 89
  (`_small/SCOPE-1022.md:121`). It supersedes DESIGN.md (r1 `28a16617b6`), DESIGN-r2.md (r2 `881273f5f3`), DESIGN-r3.md
  (r3 `f568146add`) and DESIGN-r4.md (r4 `8b49ab7d48`). CHANGES-r5.md maps every r4 Astra and Fable finding to the section and
  witness that closes it. Behaviour is that of round 4 except where section 12 says so.
- **Producer side** (phone side: delegated mount, call-time fences, the `handoff_reports` table, placement slot, report writer,
  follow-up pass, Stop marks, copy): **the D6a builder seat. OPEN NO-OWNER until MAIN names it.** Recommended: one seat after C0 and
  the D5 slices F1, F2, F3 land (it edits F1's `index.ts` phone hunk, F2's `CallStore` transaction and F3's terminal write).
  On dev/1022 C0 (+ C0FIX `ca267a964c`) and F1 (`71cc343ae4`) are in; F2 (`4261530018`, AGREED, not merged) and F3
  (`228105308b`, PARTIAL, NO OWNER) are not (section 11.1).
- **Consumer side** (DELEG side: the read-only hand-off authority helper of 5.1, and one after-commit nudge composed into the
  existing `onDelegationReceipt` listener, `index.ts:22662`; never a second registration, 11.3): **DELEG owner. OPEN NO-OWNER** (no DELEG lane is live). Recommended: the D6a seat writes both; DELEG semantics
  are read, never changed. A DELEG reviewer signs W1, W2, W4, W5 and W13.
- **Decision side** (one call-out in the engine permission handler, 5.8): owner of `server/decision/**` and the engine permission
  path in `server/index.ts`. D6a reads nothing from `approval_records` in round 3 (the round-2 read is removed).
- The D5 phone pack (`docs/designs/1021-phone-businesses/DESIGN.md` at `70141d6a02`, AGREED round 5; the doc is not an ancestor
  of `dev/1022`, its C0/F1 slices are) owns placement, the Ask card, the `sameRequest` card, booking/cancel rules, `phone_call_keys`, reconcile, the final
  predicate and every vendor rule. D6a adds nothing to D5 invariants I1-I13 and does not alter `phone_calls`.
- Bot fence and trusted Ask context: C0 `fix/1021-phone-c0` @ `50f0bd8077` + C0FIX `ca267a964c`, both in `dev/1022`.
- F2 delegation pack (`design/1023-deleg-pack-r3` @ `aac88ca751`, AGREED; builder `fix/1023-deleg-pack-r14`, not in dev/1022)
  constrains itself by its section 7 contract C1-C5 toward D6a; D6a reads none of the fields F2 adds (11.4).
- Delegated email (D6b) owns `server/email/**`. D6a edits no email file. Real-call gate: Sean (D5 P27). No D6a test spends money.

Base read for every anchor: hub `dev/1022` @ `6d4b5932a8` (round 3 read `dev/1021` @ `068a595c9a`; every anchor below was
re-read on dev/1022 in round 4, CHANGES-r4.md table A; the round-5 anchors are in CHANGES-r5.md table A). Anchors name the symbol too, because F2/F3 and later trains move lines.
**Re-check gate:** the D6a seat starts only after C0, F1, F2, F3 are in its base (C0 and F1 are, on dev/1022); its first commit is RE-ANCHOR.md re-reading every
anchor in 3-5 against that base. A changed meaning is a design question, never a silent adaptation.

## 0. PURPOSE and USER PROMISES

**PURPOSE.** The owner tells one bot "have my secretary book a table at Corner Bistro for four on Friday at 7". The secretary bot takes
the hand-off and phones the business on the owner's own Vapi account (D5). The owner gets the true result in the conversation where
they asked, whenever it lands, without opening another bot or page.

**USER PROMISES**
- D1 **One sentence to the bot the owner is talking to.** The secretary gets the hand-off note and the r7.3 context pack.
- D2 **Only the owner's own request can make a bot phone through a hand-off.** Only for a hand-off queued from a turn the owner was
  proven to have started (`owner_rooted`), one hop deep, attended, actively started on its current dispatch, not stopped by the owner.
  The dialling bot must be one the owner allows (D5 I2). The D5 Ask card applies unchanged.
- D3 **One request, one call.** One hand-off places at most one vendor call, whatever the retries, rephrasing, redispatch or restart.
- D4 **The asking conversation always learns what happened, truthfully.** Once the secretary tried to call (asked for the card, or
  called the tool under No limits), the asking conversation gets exactly one outcome line for that hand-off: the call's result from
  D5's committed final result (booked only when the business confirmed), or "no call was made". A call scheduled for later is
  followed from its scheduled time and its real result is posted whenever it lands; a late result gets at most one interim line
  first, never a guessed outcome. If an uncertain result later becomes definite, one correction line follows. The bot in that
  conversation sees the same line on its next turn.
- D5 **The owner's data stays theirs.** No line carries the booking reference, transcript, vendor ids or key (D5 U7).
- D6 **Nothing new to approve.** No new prompt, card or setting.

## 1. Scope

In: delegated mount; call-time fences; source-Stop marks; per-hand-off slot; the `handoff_reports` obligation table and its writer;
follow-up pass; hand-off-end handling; downgrade probe clause; copy; witnesses.
Out (owned elsewhere): D5 placement, number policy, booking/cancel, Ask card text, `phone_calls`/`phone_call_keys` schema; DELEG
queue, pack, receipt and Stop semantics; D6b; D8; `server/phones/**`.

## 2. What changed in the approach (round 3)

Round 2 hung the report state on the D5 call row and had three separate mechanisms for "what does the asking chat hear": a report
column written at place, a timer pass that also wrote interim lines from its own snapshot, and a DELEG hook that read approval
records to decide "no call was made". The round-2 reviews clustered exactly there (Astra 4, 5, 6, 7, 8, 9, 11, 12; Fable 1, 2, 3,
4, 6, 8). Round 3 replaces all three with **one durable obligation per hand-off** and **one synchronous writer that derives every
line from fresh state**:

1. `handoff_reports` (new, empty table in phone-calls.db): one row per hand-off that tried to call, created **before** the Ask card
   or the tool reaches the vendor. The row is the slot (D3) and the debt (D4) at once.
2. `syncReport(handoffId)`: the only code that writes a line. Synchronous, re-reads everything, decides which lines are owed now,
   posts each under its stable id, then advances the row with a compare-and-set. Every other actor (D5 terminal write, pass,
   hand-off end, key save, start) only **re-arms** the row (`due = now`) and calls it.
3. Re-arm is in the **same SQLite transaction** as the D5 write that causes it, so a crash can never leave terminal debt with no due.
4. Hand-off end is read from DELEG's own durable state (the hand-off row is gone), not from a hook's success; the hook is a nudge.

Source Stop (Astra 1, Fable 5) is closed by naming the base rule that already binds the queuing turn (STOP1) and adding one
identity-bound mark for Stops pressed after dispatch (5.4).

## 3. State machine (the only state that crosses turns and restarts)

Table (phone-calls.db, created empty with `CREATE TABLE IF NOT EXISTS` at store open, constant time at any history size):

```
handoff_reports(
  handoff_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, source_thread_id TEXT NOT NULL,
  call_id TEXT,                 -- NULL until the slot is taken (5.6); never cleared
  anchor INTEGER,               -- max(createdAt, when) of the call, set with call_id
  ended INTEGER NOT NULL DEFAULT 0,  -- 0 not yet seen ended, 1 ended ok, 2 ended not ok or kind unknown (written only by syncReport, r5)
  end_kind INTEGER,             -- r5 (Astra M1): the nudge's hint (1 ok, 2 not ok); copied into `ended` only once the hand-off row is absent
  purpose TEXT CHECK (purpose IN ('book','cancel','ask')),  -- r5 (L1): from the first armed place request; NULL = unknown
  posted_placed INTEGER NOT NULL DEFAULT 0, posted_waiting INTEGER NOT NULL DEFAULT 0,
  posted_outcome TEXT CHECK (posted_outcome IN ('revisable','definitive')),
  outcome_at INTEGER,           -- when posted_outcome was first set
  done INTEGER NOT NULL DEFAULT 0,
  due INTEGER,                  -- when syncReport must next run (local work)
  read_due INTEGER,             -- when the pass may next make a vendor read for this row (moved only by an actual read, 3.3)
  read_misses INTEGER NOT NULL DEFAULT 0,  -- vendor reads since the anchor that found the call not final
  attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK (done = 1 OR due IS NOT NULL))
INDEX handoff_reports_due ON handoff_reports(due) WHERE done = 0
INDEX handoff_reports_call ON handoff_reports(call_id) WHERE call_id IS NOT NULL
INDEX handoff_reports_read ON handoff_reports(read_due) WHERE done = 0 AND read_due IS NOT NULL   -- r5 read page (3.3)
handoff_stops(handoff_id TEXT PRIMARY KEY, at INTEGER NOT NULL)        -- 5.4; r5: FALLBACK copy only
```

App DB (r5, Astra H3; created empty with `CREATE TABLE IF NOT EXISTS` at app store open, constant time, D6a-owned):

```
handoff_stop_marks(handoff_id TEXT PRIMARY KEY, at INTEGER NOT NULL)   -- 5.4: the PRIMARY Stop mark, written in the same
                                                                        -- app-DB transaction that reads the live hand-off ids
```

**Invariant:** an open row (`done = 0`) always has a `due` (CHECK). There is no parked state.

```
   [no row]  --(delegate asks for the place card, or F-CALL under No limits: arm, 5.8)-->  ARMED (call_id NULL)
   ARMED     --(F-PLACE: slot + D5 intent insert, ONE transaction, 5.6)-------------->  PLACED (call_id set)
   ARMED     --(hand-off row gone)--> syncReport posts notCalled ----------------------->  DONE
   PLACED    --(syncReport, call not final)--> maybe placedPending (5.7), maybe waiting  (stays PLACED)
   PLACED    --(syncReport, call final, outcome definite)--> outcome line -------------->  DONE
   PLACED    --(syncReport, call final, outcome unclear)--> outcome line ---------------->  REVISABLE (posted_outcome='revisable')
   REVISABLE --(syncReport, D5 later commits a definite outcome)--> correction line ---->  DONE
   REVISABLE --(syncReport, now >= outcome_at + 30 d, r5 Astra M4 / Fable M3)--> no line ->  DONE (the unclear line stands)
   any       --(source deleted)--> no line ------------------------------------------>  DONE
   PLACED/REVISABLE --(owner Deletes the call row)--> no line ------------------------>  DONE (owner's choice)
```

DONE is final. `syncReport` is the only writer of `posted_*`, `done` and lines.

### 3.1 `syncReport(handoffId)` (the single report boundary)

Synchronous end to end (node:sqlite on both DBs, no await), so no other report can interleave in-process. Steps:
0. r5 (Astra M3): the whole body (steps 1-8, including the first read) runs inside one try; nothing in `syncReport` can throw into
   its caller (8).
1. Read the `handoff_reports` row. Missing or `done = 1`: return.
2. **What is already posted is read from the lines themselves** (Astra R1-4): for each line kind, `store.messageById(source_thread_id,
   stableId(kind), { buildIndex: false })` (`store.ts:3501-3505`, `messageByIdPoint`: a point lookup that never builds a loaded conversation's history
   index, so the cost does not grow with the transcript). A line that exists counts as posted even if the row's flag was not advanced (crash between append and
   step 7); the outcome line carries `murage.phoneReport = {kind, revisable}` in its payload, so a recovered `unclear` line is read back
   as REVISABLE and a later definite outcome gets the `correction` line, never a silent dedupe onto the old text. The flags are only a
   cache written in step 7.
3. Fresh reads: the D5 call row by `call_id` (phone DB); whether the hand-off has ended = its `pending_delegations` row is absent
   (one PK read, app DB; DELEG removes the row in the same transaction as the receipt, `settleReceipted`, `delegations.ts:612-636`, so
   "absent" implies the receipt is on disk); `ownerDeletedThread(source_thread_id)`. A read that throws: treat as "unknown", post
   nothing, set `due = now + backoff`; never infer "ended" or "final" from an error. **r5 (Astra M1): `ended` is derived here and only here:** hand-off row present ->
   `ended` stays 0 whatever `end_kind` says (a held hand-off keeps its row, `delegations.ts:267` `removeHeld`, and its held-notice
   receipt, `noticeHeldOne` `:1972-1977`, does not end it, so the end watch keeps running); row absent and `ended = 0` -> step 7 writes
   `ended = coalesce(end_kind, 2)` (kind unknown fails toward telling the owner).
4. Source deleted: `done = 1`, no line.
5. Decide the owed lines from these fresh values only (the caller's snapshot is never used):
   - `call_id` NULL: hand-off live -> nothing; ended -> `notCalled` (the variant for `purpose`, 6.2), then `done = 1`.
   - `call_id` set, call row missing (D5 Delete) -> `done = 1`, no line.
   - call final (`isFinal`, F3): outcome kind `k` (6.1). No outcome line yet -> post `outcome(k)`; REVISABLE if `k` is `unclear`,
     else DONE. Outcome line posted as revisable and `k` now definite -> post `correction(k)`, DONE. REVISABLE and
     `now >= outcome_at + 30 d` -> DONE, no line (r5). Interim lines are never posted once the call is final.
   - call not final: if ended and `placedPending` not posted and (`anchor > now + 10 min` or `ended = 2`) -> post `placedPending`. If
     `now >= anchor + LATE_AFTER` and `waiting` not posted -> post `waiting` (or `waitingNoKey` when no key is held).
6. For each owed line, **and for each line found in step 2 whose flag is not yet set** (an append that landed before a crash: its
   registration and publication must still run, Astra R2-2), in order: `Store.appendMessage` under its stable id (`stableId(kind) = "phone-ho-" + kind + "-" +
   sha256(handoffId)`, kinds `notCalled`, `placedPending`, `waiting`, `outcome`, `correction`; `waitingNoKey` shares `waiting`'s id;
   each kind is written at most once: `appendMessage` returns the held row for a known stable id, `store.ts:4317-4328`); then, if the source is a bot thread (`delegationSource`),
   `markTaskContextExternallyUpdated(bot, source_thread_id, lineId)` (`index.ts:14361`), 5.9. **r5 (Astra M2): publication.** A
   fresh append already emits the `message` change that the SSE broadcast carries (`store.ts:4346`/`:4406` `this.emit`, broadcast at
   `index.ts:8784-8786`), so `syncReport` publishes nothing for it. Only a line found in step 2 with its flag unset **and whose id this process did not append** (an in-memory set
   of the stable ids `syncReport` appended since start; so a line appended before a crash) is published, once, through the store's
   existing change path for an existing row (the builder names the call in RE-ANCHOR.md; no new SSE kind). An in-process retry after
   a failed step 7 therefore publishes nothing twice. A live client sees each line exactly once (W7(b) asserts the count).
7. Advance the row: `UPDATE handoff_reports SET <flags>, ended = ?, due = <next>, attempts = 0, updated_at = now
   WHERE handoff_id = ? AND done = 0 AND updated_at = ?` (the value read in step 1). Zero rows changed means another path advanced it
   first; the stable ids already make the lines exact, so nothing more is done.
8. Any throw in 1-7 (r5: including the first read of step 1 and the fresh reads of step 3): caught here, the row keeps its flags,
   `due = now + min(60 s x 2^attempts, 15 min)`, `attempts + 1`, in its own inner try. **If that retry write throws too** (Astra M3),
   the error is logged and `syncReport` returns; the handoff id goes into the pass's in-memory skip map with the same backoff, so a
   row whose writes keep failing is not re-selected every pass (the local page reads `LIMIT 8 + |skip map|`, skip map capped at 64,
   oldest dropped). The row's durable `due` is untouched and still finite, so a restart retries it. No attempt cap; a transient
   failure never drops the obligation. `syncReport` never throws into its caller; a phone tool's committed outcome is returned to
   the engine whatever happens to a report (W10, W15).

**Two schedules, two pages (Astra R1-1; r5 Astra H4).** Local work and vendor reads are timed by separate columns **and selected by
separate pages** (3.3), so neither can hold the other up.
Constants: `GRACE = 60 s`, `LATE_AFTER = 24 h`, `END_WATCH = 60 s`, `PLACED_SOON = 10 min`, `REVISE_FOR = 30 d`, `MIN_STEP = 30 s`,
persisted per row only through `anchor` and `outcome_at`.
- `read_due` (vendor reads). NULL while ARMED or DONE. **Written only (i) by F-PLACE (`anchor + GRACE`), (ii) by the pass right after
  it INVOKED `refreshOne` for that row, whatever `refreshOne` did (r5: a vendor request, a timeout, an error, or an early return
  with no request at all, as F3's `refreshOne` does for a row it cannot read, `service.ts:543-554` at `228105308b`), (iii) by
  `syncReport` on the PLACED -> REVISABLE transition (`outcome_at + 6 h`), (iv) by key save (`max(now, anchor + GRACE)`), and
  (v) set NULL by `syncReport` on DONE.** A row the pass selected but did not invoke (allowance spent before its turn, or no key)
  keeps its `read_due` (Astra R2-1), so it is first in the next pass's read page. After an invocation that leaves the call not
  final, the pass sets `read_misses + 1` and:
  - PLACED: `now + min(60 s x 2^read_misses, 15 min)` while `now < anchor + 24 h`, then `now + 6 h` until `anchor + 7 d`, then
    `now + 24 h` with no end (discovery never stops on its own; one read per row per day is the whole cost).
  - REVISABLE: `now + 6 h` while `now < outcome_at + 24 h`, then `now + 24 h` until `outcome_at + REVISE_FOR`, when the row goes
    DONE (r5).
- `due` (when `syncReport` next runs; the local page) `= max(now + MIN_STEP, min(end_watch, local_wake, revise_end, now + 24 h))`.
  **r5: `read_due` is no longer a term of `due`** (in r4 it was, so a row whose read never moved kept `due` in the past and pinned
  the shared page). `end_watch = now + 60 s` while `ended = 0`; `local_wake` is the next local deadline (`anchor + LATE_AFTER` for
  `waiting`, `anchor - 10 min` for the `placedPending` rule; a deadline whose line is posted or no longer applies is left out);
  `revise_end = outcome_at + REVISE_FOR` for REVISABLE. A result found by a read reaches `syncReport` through D5's terminal write,
  which re-arms `due = now` (3.2), never through `due`'s formula. The `max(now + MIN_STEP, ...)` floor means every `syncReport`
  that advances a row moves its `due` strictly forward, so a row selected by the local page leaves it (re-arms set `due = now` and
  call `syncReport` at once). So a hand-off that ended while its call is days away is noticed within 60 s of the end, or of the next
  start, with no vendor read; and once `ended != 0` the row sleeps until its next local deadline or a re-arm.

### 3.2 Re-arm (every actor other than `syncReport`)

| actor | re-arm | then |
|---|---|---|
| D5 terminal or outcome-changing write (F3's single terminal write, F2's `update`/`settle`/`delete`: `result`, owner refresh, owner cancel, reconcile, late-analysis settle, Archive fence, definitive create failure, Delete) | `UPDATE handoff_reports SET due = now WHERE call_id = ? AND done = 0`, **inside the same CallStore transaction** (F2 exposes a `within(tx)` hook on those writes) | after commit: `syncReport` for that hand-off |
| hand-off end (DELEG `settleReceipted`: one `afterCommit` nudge composed into the existing receipt listener, 11.3) | phone DB: `SET end_kind = (ok ? 1 : 2), due = now WHERE handoff_id = ? AND done = 0` (r5: a hint; `ended` is written only by `syncReport` from the absent hand-off row, 3.1 step 3) | `syncReport` |
| key saved (D5's key-save path) | `SET due = now, read_due = MAX(now, anchor + GRACE) WHERE done = 0 AND call_id IS NOT NULL` | kick the pass |
| start (after listen) | `SET due = now WHERE done = 0 AND ended = 0` (one statement; open rows only) | first pass |

r5 (Astra H5): the start re-arm and the end watch only cover rows with `ended = 0`. A row with `ended != 0` whose D5 terminal write
committed without its re-arm would wait for its next local deadline (up to 24 h) or its next read. The same-transaction re-arm is
therefore the only thing that makes such a row's report prompt, and W7(a) asserts it at the crash boundary (7).

If the hand-off-end nudge is lost (crash after DELEG's commit, or the phone write throws), nothing is lost: `ended = 0` keeps the row
due within 60 s (and the start re-arm makes it due at once), so `syncReport` reads that the hand-off row is gone, writes `ended = 2`
and posts `notCalled` or `placedPending` as 3.1 says, with no vendor read (W7(c) + W13(f)).

### 3.3 Follow-up pass (owned by the phone service; never in a turn)

- **Started after listen whenever phone-calls.db exists, with or without a key** (Astra 4 r2). It needs only the store, whose open is
  constant time (D5 5.4); F1's start hook opens the store without a key and publishes the vendor service only with a key. Local work
  (hand-off end, Delete, committed outcomes, `notCalled`) never waits for a key.
- One timer, single flight, at least **30 s between passes**; it arms at `min(due)` clamped to [30 s, 1 h].
- **Each pass runs two pages, each row in its own try (r5, Astra H4):**
  1. **Local page:** `done = 0 AND due <= now ORDER BY due LIMIT 8` via `handoff_reports_due` (minus the in-memory skip map of 3.1
     step 8). Per row: `syncReport` only. Every row it advances leaves the page (its next `due` is in the future, 3.1), so the page
     cannot be pinned.
  2. **Read page (only with a key held):** `done = 0 AND read_due <= now ORDER BY read_due LIMIT 4` via `handoff_reports_read`. Per
     row, while the D6a allowance has room: one `refreshOne(callId)` under a 10 s deadline; then the pass writes the next `read_due`
     (3.1: every invocation counts as an attempt and a miss unless the call is now final, whether or not it made a request); then
     `syncReport`. A row reached after the allowance is spent is not invoked and keeps its `read_due`.
  Every invoked row leaves the read page, so a row no read can serve (F3 returns early for an abandoned or unconfirmed row) backs off
  like any miss and can never hold back a readable row. Bound: a read-eligible row with k older read-eligible rows ahead of it is
  invoked within ceil((k+1)/4) passes (k = 8 unreadable rows: 3 passes; k = 1000: 251 passes, about 2 h at the 30 s spacing, while
  each unreadable row backs off so k shrinks after the first lap) (each invocation spends at most one request of F3's `refreshOne`; if a read ever spends more,
  at least one row still moves per pass). Local work never waits behind reads: a row owing `notCalled` or an outcome line is posted
  in the first pass after its `due`, whatever the read backlog (W10).
  The pass itself never writes a line or a flag; every write is `syncReport`'s, from fresh reads (Astra 11 r2).
- **`refreshOne` (F3 exposes it):** the same targeted D5 read the owner refresh makes for one call (its uncertain search step, its
  status read, or for a settled `unclear` row the re-read that lets a late `done` upgrade it, D5 I4), **without** the
  `reconcilePending` pass that D5's `result` runs. Its writes land in D5's terminal write, which re-arms the row (3.2).
- **Allowance (Astra 4, Fable 6):** D6a has its own allowance of **4 vendor requests per pass**, counted at `phoneVendorFetch` by a
  counter tagged per caller (every actual HTTP request, whatever path reached it). D5 keeps its 8 per reconcile pass. Neither queue
  can starve the other; the worst case is 12 vendor requests per 30 s. Oldest `read_due` first (r5: the read page), so a late
  entrant is invoked within ceil((k+1)/4) passes behind k earlier read-eligible rows, whatever D5's backlog does.
- **Cost:** phone-DB work is history-independent: at most 8 + 4 rows and 4 vendor requests per pass, and two index reads. The app-DB
  append reuses `Store.appendMessage`, which for a conversation already loaded in memory checks its stable id against the loaded
  messages (`store.ts:4328`); that is the same cost every Murage status line pays at base, at most one append per line kind. Rows with `ended = 0` belong to
  live hand-offs that tried to call (a handful); every other open row wakes only at its read or local deadline.
- DONE rows are pruned after 30 days, 64 per pass, only once their hand-off row is gone (so a live hand-off always sees its slot).

## 4. Fences (each fails closed)

| Fence | Where | Checks | On failure |
|---|---|---|---|
| F-MOUNT | `runTurn` phone mount (`index.ts:17909-17918`, `phoneVerdict`) | 5.2 predicate from one PK read (5.1 `handoffAuthorityAt`) | no tools, `forgetPhoneThread`, primer 6.3 |
| F-ASK | engine permission handler, phone place request on a delegated generation (5.8) | `handoffLiveNow` + arm the row | request denied through S1's stale-deny path, no card, 0 creates |
| F-CALL | `servePhoneTool` entry (`phone-calls/admission.ts:23`, route `index.ts:31767`) | record `delegated` and generation live; `handoffLiveNow`; D5 per-bot switch; arm the row (No limits path) | `not_set_up`, 0 vendor requests |
| F-PLACE | inside `place`, C0's late-fence point (`service.ts:100-141`, `ctx.fenced`) | `handoffLiveNow` again, record generation live, then slot + D5 intent insert in ONE phone-DB transaction (5.6), no await between check and commit | `not_set_up` or 5.6 result, no row, 0 creates |
| F-GEN | phone-turn record by capability generation (`phone-turns.ts:11-35`) | revoked with the generation (shipped; Stop of the delegate's own turn) | no record, `not_set_up` |
| F-REPORT | `syncReport` | fresh rows, `isFinal`, stable ids, CAS, source not deleted | no line; DONE for a deleted source |
| F-DATA | line builder | only the projection in 5.10 | not a runtime branch (W6) |

A read that throws, or a missing row, counts as "not authority" (`email/admission.ts:126-159`, `authorizeEmailCall`'s catch).

## 5. Design of the parts

### 5.1 Hand-off authority read (consumer contract; `server/handoff-authority.ts`, new, read-only)

```ts
export interface HandoffAuthority { id: string; ownerRooted: boolean; attended: boolean; sourceThreadId: string;
  handoffGen: string }   // handoffGen = `${turn_key}:${start_attempts}`
export function handoffAuthorityAt(run: { id: string }, at: { botId: string; threadId: string; unattended: boolean }): HandoffAuthority | null;
export function handoffLiveNow(rec: { handoffId: string; handoffGen: string; botId: string; threadId: string }): boolean;
```

Live = one PK read of `pending_delegations` shows: `phase = 'started'` and `started_at IS NOT NULL` (a held row clears `started_at`,
`delegations.ts:1570`, `holdUnexecuted` `:2096-2104`); `${turn_key}:${start_attempts}` equals `handoffGen` from mount (redispatch
or re-start changes it); `accepted_turn_id` NULL or the record's turn; `target_thread_id = threadId`; `to_bot_id = botId`;
`owner_rooted = 1`; `origin = 'owner'`; **and no Stop mark for the id: no `handoff_stop_marks` row (app DB) and no
`handoff_stops` row (phone-DB fallback), each one PK read; a read that throws = stopped** (5.4, r5). `handoffAuthorityAt` applies the same stop
check at mount. Writes nothing; constant cost.
r4 (11.6): the module also exports `ownerRootedNow(handoffId)` and `handoffStartedNow(handoffId, { botId, threadId })` over the
same PK read, for D6b's existing admission seams.

### 5.2 Delegated mount predicate (producer; `phoneMount` input, F1's admission module)

`phoneMount` gains `handoff?: HandoffAuthority | null`, `handoffTurn`, `commsDepth`, `chainRootThreadId`, `chainNotOwner`,
`askerWake`, `cardContinuation`, `projectCardRun`, `sharedWorkRun`.
- **direct** (D5 I1, unchanged): `!handoffTurn && !chainRootThreadId && (commsDepth ?? 0) === 0 && !askerWake && !cardContinuation`.
- **delegated**: `handoffTurn`; `handoff` non-null with `ownerRooted`, `attended`; `commsDepth === 1`; `chainRootThreadId ===
  handoff.sourceThreadId`; none of `chainNotOwner`, `askerWake`, `cardContinuation`, `projectCardRun`, `sharedWorkRun`; not an
  automation thread; `directOwnerAudience` (`index.ts:16565`); the bot's own main chat or task (`email/admission.ts:69-71`, `ownThread`); D5's
  per-bot switch, engine and key checks for the dialling bot.
- **anything else**: not mounted. `PhoneTurnRecord` gains `kind` and, for delegated, `handoffId`, `handoffGen`, `sourceThreadId`,
  `intent = "handoff:" + handoffId`.

Base exposure (r2 Fable 4) stays routed to MAIN, now sharper on dev/1022 (11.2): shipped `phoneMount` (`phone-calls/admission.ts:11-16`,
input `PhoneMountInput`, `contracts.ts:73`) takes only `ownerAudience`, `projectRole`, `botAllowed`, `agentsMcp`; the caller
(`index.ts:17909-17914`) passes no hand-off, depth, chain or wake input. The RED witness is owed on `dev/1022`.

### 5.3 Call-time fences and result reads

For a `delegated` record, F-ASK, F-CALL and F-PLACE require `handoffLiveNow(record)` and a live record generation. Once the hand-off
finishes (row removed with its receipt), is held, stopped (5.4), redispatched or moves, any place from that turn gets `not_set_up`
(or, at F-ASK, a denied request). `phone_call_result` from a delegated record answers only for the call in its own
`handoff_reports.call_id`; a direct call id or another hand-off's call gets `not_set_up` (W3).

### 5.4 Stop (Astra 1, Fable 5): which Stop, read where

Three Stops can reach a delegated call. Each is named with the exact state it reads:
1. **The queuing turn in the asking chat (the "source turn").** At base a hand-off queued by a turn runs only after that turn ran to
   its end; a Stop of that turn discards everything it queued (STOP1, `settleQueuedDelegations`, `delegations.ts:1277-1284`, via
   `discardDelegations` `:2139`; unchanged on dev/1022). So by the time the delegate can mount, the source turn's outcome is fixed and was not a Stop. This
   is identity-bound by DELEG's own rule (the queued row belongs to that turn, `fromBotId` + `attempts = 0`); D6a reads nothing for it
   and W4(a) guards it (mutant: drain on a stopped turn).
2. **A later owner Stop in the asking chat, after dispatch** (the source turn already ended; the owner presses Stop in Sable's chat
   while Ember sits at the Ask card). DELEG keeps the hand-off running here on purpose (`discardDelegations` comment, `:2128-2138`).
   D6a is stricter for money: an **owner-proven** Stop of the asking conversation marks every hand-off alive from it (r5 rewrite,
   Astra H1-H3, Fable M1/M2/M4).
   - **Invariant (P1 class):** every request that the owner proved, on any route or typed path that stops a turn in a conversation,
     marks the live hand-offs of that conversation before its first interrupt, cancel or early return after body validation; no
     request without owner proof marks anything.
   - **Owner proof (Astra H2, Fable M4).** A mark takes an `OwnerStopProof` value. It is minted in exactly two places:
     `ownerStopProof(req, url)` = `mayApprove(req, url)` (`index.ts:29475`: desktop surface or `ownerActs`) **and** no MCP grant on the
     request (`grantOfRequest`, `index.ts:2209`; a grant with `send` may call `/api/bots/:id/interrupt`, `mcp-grants.ts:148-149`) **and**
     not an MCP access-key request (the path `scripts/mcp-server.ts:1206-1216` uses for bots and rooms); and `typedStopApplies`
     (`index.ts:14712`, owner principal by `isWorkspaceOwner(threadHumanPrincipal(threadId))`). A Stop without proof (a script with a
     send grant, an unproven conversation-class origin on the room route, `route-policy.ts:234`) still stops the turn as on base, and
     marks nothing: a non-owner must not be able to cancel the owner's booking, and DELEG's own rule keeps the hand-off running.
   - **The sites (SITES.md lists each; W4(f) has one row per site):**
     (i) `POST /api/bots/:id/interrupt` (`index.ts:37923`), proof read once after the body's shape checks, then one mark per branch
     before that branch's first interrupt or cancel: contract-1 scoped Stop (`:37935-37966`, marks `body.threadId` before the
     `stale_action` checks: a stale scoped Stop still expresses the owner's Stop, fail closed); `{all:true}` (`:37975-37977`, marks by
     bot, below); the direct branch through `stopDirectThreadForOwner` (`:37982-37992`, marks the selected `threadId`); the routine
     branch (`:37998-38011`, marks `routineThread`); the busy-room branch (`:38015-38027`, marks `busyGroup.threadId`); the legacy
     direct branch (`:38037-38043`, marks `expectedThreadId ?? bot.threadId` and, if different, `cancelledDirect.threadId`). The
     routine and later branches run only when the bot is busy in a room (`busyChannel`, `:37980`); the legacy direct branch needs
     `activeGroupTurnForBot` truthy at `:37980` and null at `:38015` with no await between, so it is unreachable today: it keeps
     its mark, and SITES.md records it UNREACHABLE with that reason and no witness row.
     (ii) typed "stop" (`typedStopNow`, `index.ts:14719`): marks `threadId` as its first statement. A typed "stop" applies only while
     work runs on that conversation (`typedStopApplies`, `:14712-14714`); otherwise it is an ordinary message and marks nothing
     (TYPED-STOP-107 unchanged; W4(f) sets up a running source turn for this row).
     (iii) `POST /api/local-computer/interrupt` (`index.ts:36624`, desktop class, `route-policy.ts:378`): one mark per thread in
     `stopThread` (`:36659`) before its cancel.
     (iv) `POST /api/groups/:id/interrupt` (`index.ts:35592`): **only when the body carries no `queueIds`** ("Inject now",
     `:35612-35621`, is not a Stop) and only with proof; marks **every thread the route interrupts** (`targetThreadIds`,
     `:35635-35639`: `body.threadId`, else every active operation's thread, else `group.threadId`) and `group.threadId` as well,
     beside the route's own `markSendsStopped` loop (`:35656`, same `queueIds === undefined` condition), before the first await.
     `stopDirectThreadForOwner` itself no longer marks (r4 put it there; it has no request, so it cannot carry proof).
     `stopBotEverywhere` (`:22810`) does not mark: the Stop-everything route marks before calling it, and its two host callers,
     cloud-home quiesce (`:29512`) and the browser switch (`:30781`), are not owner Stops of an asking conversation (they stop the
     delegate's own turn too, so F-GEN covers a call in flight). Routine, host, project, shared-work, review-claim, ask and
     request-fence callers of `interruptDirectThread` are excluded as in r4 (11.5).
   - **What a mark writes (Astra H3).** `markSourceStopped(proof, threadId)` runs **one app-DB transaction**: read the ids of every
     `pending_delegations` row with `source_thread_id = threadId` and `INSERT OR IGNORE` each into `handoff_stop_marks` (app DB,
     section 3). `markSourceStoppedByBot(proof, botId)` does the same for `from_bot_id = botId`. Read and write share one
     transaction on one DB, so the set marked is exactly the set alive at the press: a hand-off queued afterwards is not affected,
     and a redispatch keeps its id (`delegations.ts:1579-1585` resets a never-submitted row to `fresh` under the same id), so the mark
     survives restart and redispatch. **If that transaction throws**, the same ids (read again, outside a transaction) are written
     to the phone-DB `handoff_stops` table (fallback, second file). `handoffLiveNow` and `handoffAuthorityAt` are false if either
     table holds the id, or if either read throws. **If both writes throw**, the ids go into an in-memory set read by the same
     checks, the error is logged, and the Stop continues: the delegate's in-flight turn is not what the owner stopped, so it is
     not interrupted. The only case left open is two independent database files failing on the same press and a restart before
     either recovers (parked, 10). The phone-DB fallback rows are never moved into the app DB; both tables are read, both pruned
     with their hand-off (rows whose `pending_delegations` row is gone, 64 per pass).
   - This is a HELD-Stop rule by design (it fires on the press, not on confirmation): placing a paid call after the owner pressed
     Stop is the worse error; the JOINT RULING governs only what the chat shows.
3. **The delegate's own turn** (Stop in Ember's chat): the generation is revoked (`cancelDirectTurnDispatch`, `index.ts:5347`,
   `revokeInternalGeneration`/`directRuns.cancel`) and with it the phone-turn record (F-GEN). The hand-off chip's Stop
   (`stopWaitingDelegation`, `delegations.ts:847`) acts only on a hand-off that has not started (queued or waiting row); once started,
   Ember's chat Stop is the path, and the hand-off then ends through `settleReceipted`, so `handoffLiveNow` fails.

D6a never reads `confirmedStopGenerations` (`index.ts:3466`, `:3589`): it is consumed at the freeze and keyed by the stopped generation, so it
cannot carry a fence. After the slot is taken, no Stop cancels the call (Sean Q1, parity with a direct turn); 5.7 tells the owner.

### 5.5 Ask preview uses the placement decision (Astra 2)

One function, `placementDecision(record, args)`, used by both D5's `askPreview` (for a delegated record) and F-PLACE:
- `handoff_reports.call_id` set -> `stored(callId)` (same D5 request identity) or `alreadyCalled(callId)` (different identity);
- else D5 `liveByIdentity` hits a call of another hand-off or a direct call -> `duplicateLive(callId)`;
- else `new`.
Only `new` shows the fresh D5 call card. The other three show D5's existing `phoneCalls.card.sameRequest` card for that call (D5 I5,
5.9), so the owner sees an existing call, not a new paid one, before approving. Approving returns the stored result, the
`already_called` result or the `duplicate_live` result; 0 creates. No new card.

### 5.6 One hand-off, one call (D3; Astra 2, Astra 3)

- `intent = "handoff:" + handoffId`.
- **Slot = the `handoff_reports` row.** F-PLACE runs, in one phone-DB transaction (`BEGIN IMMEDIATE`): `placementDecision` re-read;
  `UPDATE handoff_reports SET call_id = ?, anchor = ?, due = ? WHERE handoff_id = ? AND call_id IS NULL AND done = 0` (must change
  exactly one row); D5's `insert` of `phone_calls` + `phone_call_keys` through F2's `within(tx)`; COMMIT. A throw anywhere rolls back
  both: no orphan slot, no slot-less intent. The vendor create runs after the commit, as D5 specifies.
- If the row is missing at F-PLACE (arm failed or was skipped), the place is refused `not_set_up`: no slot, no call.
- **Definitive create failure keeps the slot** (r2 Fable 7): D5 commits `failed`, the owner gets the `failed` line, and a retry in the
  same hand-off gets `already_called`. A second create would need a new owner request. This is intended, not a bug to fix.
- **Owner Delete of the call:** D5 revokes the phone-turn records of its intent (`forgetPhoneIntent`, D5 I5), so a retry in the same
  turn gets `not_set_up`, 0 creates (D5's answer wins; W5(c) asserts it). The slot row keeps `call_id`, so a new turn of the same
  hand-off still cannot place.
- **Boot cases are not retries:** on restart DELEG interrupts an accepted hand-off (`RESTART_RECEIPT`, `delegations.ts:1509`), holds an
  uncertain submitted one and redispatches only one proven never submitted (which cannot have taken the slot). The reachable repeat is
  the in-turn lost tool reply, covered by the slot.

### 5.7 Hand-off end (Fable 1, Fable 2, Astra 9 r2)

Every hand-off end goes through `settleReceipted` (live finish, boot "interrupted", stranded sweep, chip Stop). D6a adds one
after-commit nudge (3.2) carrying `ok` to the existing receipt listener (`index.ts:22662`), as its first statement, before that
listener's `finalizingDelegations` and `held` early returns (11.3). The durable truth is the absent hand-off row, read by `syncReport`, so the nudge may be
lost without effect. What the asking chat then hears, from 3.1 step 4:
- **Tried, never placed** (card unanswered, denied, approved then Stop/restart before F-PLACE committed, No-limits turn stopped
  between F-CALL and F-PLACE, place refused by a fence): one `notCalled` line, after the receipt. The row was armed before any card
  or tool call (5.8), so this covers every path r2 missed (No limits; "Allowed, not run"; decision recovery leaving a record open):
  D6a no longer reads approval records at all.
- **Placed, not yet final, and the hand-off ended not ok (Stop, restart, failure) or the call is scheduled more than 10 minutes
  ahead:** one `placedPending` line ("already placed; the result will be posted here; cancel it on the Phone calls page"). A normal
  finish with a live call in progress gets no extra line; its outcome line follows within minutes.
- **Never tried:** no row, no line; Ember's reply is the whole story.
A late Approve from a stale client can never place (r2 trace kept: decision retirement of the generation's requests,
`installDecisionHost`/`retireRequests`, `decision/implementation.ts:129`, 404/503, F-GEN; the builder re-proves it in W13), and now also
meets `handoffLiveNow` false and a `notCalled` that is already posted.

### 5.8 Arming the obligation (F-ASK and F-CALL)

- **F-ASK.** In the engine permission handler (`index.ts:2972-2990`, after `decide` returns `card`, before `approvalAttention.presentCard`), when the
  request's tool is `PHONE_PLACE_NAME` and the frozen generation has a `delegated` phone-turn record: `handoffLiveNow`, then
  `INSERT OR IGNORE INTO handoff_reports (handoff_id, bot_id, source_thread_id, purpose, due, created_at, updated_at) VALUES (?, ?, ?,
  ?, now + 60 s, now, now)` (`purpose` from the place request's validated D5 purpose enum; anything else NULL; the first arm wins). If either fails, the request is answered deny through S1's stale-deny path (the sole transaction, as a
  retired generation's card is); no card is shown; Ember's tool gets a denial; 0 creates. A direct-turn request is untouched.
- **F-CALL.** The same `INSERT OR IGNORE` at `servePhoneTool` entry for a delegated `phone_call_place` (covers No limits, where no card
  exists); a failure answers `not_set_up`.
- Arming is idempotent (PK). It happens strictly before F-PLACE, so every placed call already has its row.

### 5.9 The bot in the asking chat sees the line (Astra 10)

`syncReport` registers each posted line with `markTaskContextExternallyUpdated` for a bot source thread, exactly as hand-off
delivery does (`index.ts:22667-22671`); `store.recordTaskExternalUpdate` (`store.ts:5731`) queues the id (`queueExternalUpdate`,
`external-context-delivery.ts:174`, removes an equal id before appending, so a re-registration while the id is still pending is a no-op). The next turn then cannot
resume the native session past it
(`turn-context.ts:266-267`, `externallyUpdated`) and the line is carried as an external update (`index.ts:17123`, `externalDelivery.replay`). Nothing wakes the
bot (D6). A crash between append and registration leaves the flag unadvanced; the next `syncReport` re-appends (dedupe) and registers.
If the crash fell after registration and a turn consumed the id before the retry, the retry queues it once more: the same line is
shown to the bot once more as an external update. That costs one repeated line in one prompt, only in that crash window; accepted. Room sources follow the receipt path's rule (only bot threads are marked; rooms replay their transcript).

### 5.10 Lines (F-DATA)

A Murage status line (`actorKind: 'murage'`, `murage: {kind:'status'}`, like `appendProjectCloseMessage`, `store.ts:4291-4294`) in
`source_thread_id`. Inputs, and only these: `purpose` (enum), D5 outcome enum, D5 reason enum mapped to D5's localized copy, `{bot}`
(store display name), `{business}` (D5's validated label, at most 60 chars, control characters stripped; else the number as the Ask
card formatted it), `{time}` (D5's validated structured result time, never `when`; absent -> the `NoTime` key), `has_reference`
(bool; the "reference is on the Phone calls page" clause appears only when true).

### 5.11 Migration and downgrade (Astra 7 r2, Fable 4 r2)

- **Upgrade:** store open runs `CREATE TABLE/INDEX IF NOT EXISTS` for `handoff_reports` and `handoff_stops` (phone DB) and the app
  store open does the same for `handoff_stop_marks` (r5), all new and empty: constant
  time at any history size, nothing read from `phone_calls`, no backfill (no delegated call exists before D6a ships). `phone_calls` is
  not altered. Idempotent, so an interrupted start simply re-runs.
- **Downgrade:** the phone DB is copied aside and removed from the data folder on a downgrade (`preservePhoneCallsForDowngrade`,
  `installation-memory-downgrade.ts:257`, then `:288`; preflight `:417`, preserve `:461`), and nothing restores the copy. So D6a refuses the downgrade while it owes
  anything: one more probe statement in `checkPhoneCallsForDowngrade` (`:236`, beside the `phone_calls` probe `:248`), run on its own and independent of `phone_calls`
  (Astra R1-3): if the `handoff_reports` table exists, `SELECT 1 FROM handoff_reports WHERE done = 0 AND posted_outcome IS NULL LIMIT 1`
  (r5, Astra M4 / Fable M3: only a row that still owes its **first** line refuses); a row fails with the existing `PHONE_CALLS_PENDING`
  code and its existing owner copy. **Exit for every open state (r5):** an ARMED row refuses only once `ended != 0` (its hand-off is
  over and `notCalled` is about to post, or its append is retrying: W14(b)); an ARMED row of a live or held hand-off (`ended = 0`)
  does not refuse, and a downgrade then loses only a "no call was made" line, the owner's choice. A PLACED row with no outcome
  line refuses: either its call is in a base-pending status (the base probe `:248` refuses too), or it is `ended` awaiting analysis
  or `abandoned` with an unconfirmed stop (base lets those pass) and no definite result yet. That refusal is intended (D4) and
  the existing copy is true for it ("Some phone calls are unfinished or their status is unknown ... finish or cancel them in Phone
  calls settings", `electron/recovery/messages.js:99`): deleting that call on the Phone calls page moves the row to DONE at once,
  with or without a key. REVISABLE (outcome line already posted) does not refuse: a downgrade then loses at most the one
  `correction` line. REVISABLE also ends on its own after 30 days (3.1). So no
  D6a row can refuse a downgrade indefinitely, and no vendor read runs past `outcome_at + 30 d` for a REVISABLE row. With no debt, the downgrade proceeds as base; DONE history stays in the preserved copy. The builder records
  in RE-ANCHOR.md what a 1.0.20 app does with an unknown table in an existing phone DB (expected: ignored).

## 6. Copy (every new owner-facing string; the builder's UI/copy owner adds keys and locales)

### 6.1 Outcome lines (`phoneCalls.handoff.*`)

| key | English | when (D5 committed final result) |
|---|---|---|
| `booked` | {bot} booked {business} for {time}. The reference is on the Phone calls page. | `book`, `done`, validated time (reference clause only if `has_reference`) |
| `bookedNoTime` | {bot} booked {business}. The details are on the Phone calls page. | `book`, `done`, no validated time |
| `cancelled` | {bot} cancelled your booking at {business}. | `cancel`, `done` |
| `asked` | {bot} called {business}. What they said is on the Phone calls page. | `ask`, `done` |
| `notDone` | {bot} called {business} but couldn't get it done: {reason}. | `not_done` |
| `noAnswer` | {bot} called {business}, but nobody took the call. | `no_answer`, `busy`, `voicemail` |
| `failed` | {bot}'s call to {business} didn't go through. | `failed`, definitive create failure, vendor refusal |
| `stopped` | {bot}'s call to {business} was cancelled before it finished. | `cancelled`, `abandoned` with confirmed stop |
| `unclear` | Murage couldn't confirm how {bot}'s call to {business} went. Read the transcript on the Phone calls page. | D5 `unclear`, any unmapped outcome (REVISABLE) |
| `correction` | Update: {line for the definite outcome} | REVISABLE -> definite (once) |

The mapping is total; unmapped is `unclear`, never `booked` (W8).

### 6.2 Other lines and results

| key | English | when |
|---|---|---|
| `notCalled` | {bot} didn't make the call. Nothing was booked. Ask again if you still want it. | 5.7, `purpose = 'book'` |
| `notCalledCancel` | {bot} didn't make the call, so your booking was not cancelled. Ask again if you still want it. | 5.7, `purpose = 'cancel'` (r5, L1) |
| `notCalledAsk` | {bot} didn't make the call. Ask again if you still want it. | 5.7, `purpose = 'ask'` or NULL (r5, L1); all three share `notCalled`'s stable id |
| `placedPending` | {bot} had already placed the call to {business}. The result will be posted here; you can cancel it on the Phone calls page. | 5.7 |
| `waiting` | {bot}'s call to {business} hasn't reported back yet. Murage will post the result here when it does. | 3.1, once |
| `waitingNoKey` | {bot}'s call to {business} hasn't reported back, and Murage can't check it until your Vapi key is back in Settings. The result will be posted here. | 3.1, no key held |
| engine `already_called` | "This request already placed a call. A different call needs a new request from the owner." | 5.5, 5.6 |
| engine `duplicate_live` | "A call for this is already in progress. Check the Phone calls page." | 5.5 |

### 6.3 Primer line
`phoneCalls.handoff.notHere`: "Phone calls on a hand-off need the owner's own request, one step away. Ask the owner to ask me
directly." Only on a hand-off turn that fails 5.2 for authority reasons when bot, key and engine would otherwise mount.

## 7. Witnesses (RED first on the builder's base; each mutant must turn its witness RED)

All use the real `runTurn` mount, the real `/api/internal/phone/*` route, the real `handoff-dispatch` start, the real engine permission
handler, and the D5 loopback fake Vapi (`startFakeVapi`, C0) with a fake clock injected into the phone service. Crash cuts are
`kill -9` of a child server (no shutdown handlers) and a restart on the same data folder. No real call.
**Isolation rule:** producer-boundary rows (who mints `owner_rooted`) come from real `delegate` calls; consumer-boundary rows (5.1/5.2)
are written by DELEG's own store helpers with exactly one field varied, so each mutant is killed by its own fixture. Each W2 case
states its boundary.

| row | case | pass condition | mutant(s) |
|---|---|---|---|
| W1 | owner-rooted depth-1 attended hand-off books | tools on Ember's turn; card armed the row before it showed; one create; row PLACED with `due`; fake ends `done` with sentinel reference + result time; Sable's chat has exactly one `booked` line; DONE | delegated predicate removed; arm moved after `presentCard` |
| W2 | not admitted (matrix) | `owner_rooted=0`; origin room/shared/legacy; depth 2; peer ask; unattended; `chainNotOwner`; bot switch off; project card; owner audience false; row missing; held row; start-identity mismatch; Stop mark row in either table (r5). Each: no tools / denied request / `not_set_up`, 0 vendor requests | one per check |
| W3 | hand-off ends mid-turn; result-read ownership | after mount: row removed / held / stop-marked: next place `not_set_up`, 0 creates; `phone_call_result` refuses a direct call and another hand-off's call | `handoffLiveNow` dropped from F-CALL; ownership check dropped |
| W4 | Stop | (a) owner Stops Sable's queuing turn: hand-off discarded, Ember never starts, 0 creates; (b) Ember active at the Ask card, owner presses Stop in Sable's chat (held, never confirmed), then approves: 0 creates, `handoff_stop_marks` row present, after the hand-off ends one `notCalled`; (c) the hand-off is parked (Ember busy, never submitted) when the owner presses Stop in Sable's chat; kill -9; after restart DELEG resets it to `fresh` under the same id (`delegations.ts:1579-1585`), it dispatches and Ember mounts: no tools (mount reads the mark), 0 creates; (c2) r5 H3: (c) with the app-DB mark transaction forced to throw (fault in the D6a mark statement only; the route, DELEG and restart are real): the phone-DB fallback row exists, after kill -9 + restart + redispatch: no tools, 0 creates; (c3) both writes forced to throw: before restart, 0 creates (memory set); the row is the named residual (10, parked) and is asserted only up to restart; (d) barrier: (b)'s Stop lands after F-CALL, before F-PLACE commits: 0 rows, 0 creates; (e) Stop in Ember's chat: F-GEN, 0 creates; (f) r5, **one row per SITES.md site, each driven through its real HTTP route on a booted server (or the typed-stop send) with owner proof**: bot route contract-1 scoped Stop (with a valid v1 tuple from a running source turn), `{all:true}`, direct branch, routine branch (setup: the bot is busy in a room **and** a routine run is active in the source conversation, since that branch is reached only with `busyChannel` set), busy-room branch, room Stop without `threadId` while the hand-off's source is a room **task** thread (the mark lands on every interrupted thread), Sable's **task** thread (not her main chat, Fable L2), typed "stop" (setup: a source turn is running in that conversation, so `typedStopApplies` is true), local-computer Stop, room Stop without `queueIds`: each gives the mark row and 0 creates at the next approve; (g) room "Inject now" (`queueIds`): no mark, the hand-off still places once; (h) r5 H2, **no proof marks nothing**: the same bot interrupt called with a send-scoped MCP grant, through `scripts/mcp-server.ts`'s interrupt tool (MCP access key) on bots and rooms, and from an unproven conversation-class origin on the room route: the turn stops as on base, no mark row, the hand-off still places once; Stop-everything's host callers (cloud-home quiesce, browser switch): no mark row | (a) drain on a stopped turn; (b)/(f) mark removed from that site (one mutant per site); (c) mark kept only in memory; (c2) fallback write removed, or `handoffLiveNow` reads only the app-DB table; (d) F-PLACE recheck dropped; (g) mark before the `queueIds` check; (h) proof check dropped (mark on every request), and separately `stopBotEverywhere` marks (kills the quiesce/browser rows) |
| W5 | one hand-off, one call | (a) lost tool reply, engine retries identical then rephrased args: creates = 1, answers stored / `already_called`; (b) two concurrent places: creates = 1; (c) owner Deletes the call, retry: `not_set_up`, creates = 1; (d) boot cases (accepted, held, never-submitted): total creates = 1; (e) same bot, different source: Rex's chat hands Ember an identical request while Sable's hand-off call is live: `duplicate_live`, creates = 1, Rex's chat later gets `notCalled`; (f) Ask preview for (a)'s rephrased retry shows `sameRequest`, not a fresh card; (g) the D5 insert throws after the slot UPDATE inside the transaction: no slot, no row, the next place creates once | slot keyed by request identity instead of `handoff_id` (kills (a)); slot UPDATE outside the transaction (kills (g)); preview skips `placementDecision` (kills (f)) |
| W6 | owner data stays out; the bot sees the line | sentinel reference, transcript, vendor id, key and private free-text sentinels absent from Sable's rows, the SSE payload, Sable's next engine stdin, the receipt and Ember's tool result; **positive:** Sable's next turn on a resumable native session gets the `booked` line as an external update (not resumed past it); crash between append and registration: after restart, registered once, carried once | builder reads `row.reference`; registration removed; registration not retried |
| W7 | exactly once across crashes | kill -9 (a) **r5 H5:** fixture: hand-off ended ok (`ended = 1`), key held, `read_due` = now + 6 h, no local deadline before + 24 h; the D5 terminal write commits through `result` and the child is killed by a barrier between COMMIT and any after-commit code. **Crash-boundary assertion (before any restart):** open the phone DB file read-only and assert the row's `due` <= the terminal commit time (the re-arm committed with the call row). Then restart: the outcome line is posted in the first pass, with 0 vendor reads (fake request log) and before `read_due`; (b) after append, before the CAS: after restart the line exists once and a live client sees exactly one SSE `message` frame for it (count, r5 M2); (c) after DELEG's settle commit, before the nudge, with the call scheduled 3 days ahead: after restart `placedPending` within 60 s, 0 vendor reads before the anchor; (d) 20 delegated calls of 7 bots reach their terminal commit, kill -9 before any `syncReport`: every one posted exactly once within ceil(20/8) passes; (e) `unclear` appended, kill -9 before the CAS, D5 then commits `done`: exactly one `correction` after restart, no lost revision. Each restart gives exactly one line per kind, stable id | (a) re-arm moved after the CallStore COMMIT (killed at the crash-boundary assertion; the first-pass/0-read assertion kills it again after restart, since `ended = 1` excludes the start re-arm); (b) random line id; explicit publish on a fresh append (kills the SSE count); (c) end watch tied to `read_due`, or end read from the nudge; (d) page not continued; (e) posted state read from flags only |
| W8 | every writer reports truthfully | drive `result`, owner refresh, owner cancel, reconcile (confirmed, not_found), Archive fence, late-analysis settle, definitive create failure; every 6.1 outcome incl. unknown; ended-without-analysis gets no line until final; **cancel reaches grace -> `unclear`; the vendor supplies `done` the next day and again a variant on day 9; nobody refreshes: the pass's `refreshOne` finds it and exactly one `correction` (cancelled) is posted, DONE**; **owner refresh lands the final result, and separately owner Deletes the call, while a pass `refreshOne` is outstanding (barrier): no `waiting` line after the outcome, no line after the Delete, no flag moved back** | re-arm only in `result`; default maps to `booked`; report on "ended"; REVISABLE treated as DONE; no reads for REVISABLE; pass writes an interim line from its own snapshot |
| W9 | deleted source / deleted row | source deleted before final: DONE, no line, thread not recreated; owner Deletes the call while PLACED or REVISABLE: DONE, no line | `ownerDeletedThread` check dropped |
| W10 | pass: bounded, fair, failure-isolated | turn ends while live, nobody reads, fake ends `done`: one line within the first due; 0/1/100 bots x 3 PLACED + 10 and 10,000 past calls: per pass at most 8 local rows, 4 read rows and 4 D6a vendor requests (fake request log, tag); passes at least 30 s apart; **sustained** D5 backlog (the fake refills 50 due reconcile rows every pass) while a D6a row enters behind k = 6 read-eligible rows: it is invoked within ceil((k+1)/4) passes; one read stalls: 10 s deadline, others proceed; **app-DB append throws busy twice for one row while two healthy rows are due: healthy rows posted in that pass, the failing one on a later pass, exactly one line each; the place whose report failed (a definitive create failure, so `syncReport` runs inside the tool call) still returned its committed result**; **8 read-eligible rows, allowance 4: rows 1-4 invoked in pass 1, rows 5-8 in pass 2 (none postponed); first report into a loaded 50,000-message conversation does no history-index build**; **r5 H4 stall row: N open PLACED rows with the oldest `read_due` that no read can serve: half `abandoned` with an unconfirmed stop (not final, F3 `refreshOne` returns early with 0 requests), half whose `refreshOne` read the fake makes time out past the 10 s deadline; plus, entering later, (i) a PLACED row whose call the fake completes `done` and (ii) an ARMED row whose hand-off ends: (ii)'s `notCalled` is posted in the first pass after its end; (i) is invoked within ceil((N+1)/4) passes (N = 8: 3) and its `booked` line posted; each unreadable row's `read_due` is later than before after its invocation; run at N = 8, N = 10 and N = 1000**; key saved the day before a scheduled call: 0 reads before `when`; keyless restart with a terminal PLACED row: line posted, 0 vendor requests | full scan; shared try around the page; rethrow into the tool; attempt cap; pass gated on key; allowance not counted at `phoneVendorFetch`; `syncReport` recomputes `read_due` (kills the 8-row case); **r5: `read_due` moved only when a vendor request was counted (kills the stall row (i)); one shared page for local and read work (kills (ii) at N = 1000)** |
| W11 | scheduled call | `when` = now + 3 d, hand-off ends ok: exactly one `placedPending` at the end, then 0 reads and no other line before `when`; first read at `when` + 60 s; `done` at `when` + 5 min: one `booked`. Variant: live until `when` + 30 h: one `waiting` at + 24 h, then `booked`. Variant: key removed day 2 to day 9, call ends day 3: `waitingNoKey` at + 24 h; on key save day 9 the row is re-armed and `booked` lands with no owner refresh. Variant: vendor stays unreadable to day 12: daily reads continue, then `booked` | misses before the anchor; discovery stops at day 7; key save does not re-arm |
| W12 | Ask card in-turn unchanged | No limits off: card on Ember's turn; deny: 0 creates, later `notCalled` (r5: once per purpose, book / cancel / ask, each with its variant, 6.2); allow: one create. No limits on: no card, F-CALL arms, one create | delegated turns skip the card |
| W13 | hand-off ends without a call | card open; turn ends by (a) Stop, (b) kill -9 + real boot order (decision recovery and DELEG boot settle as shipped, no pre-expired fixture), (c) turn failure: card closed; late Approve 404/503, 0 creates; Sable gets exactly one `notCalled` after the receipt. (d) No limits, Stop between F-CALL and F-PLACE: one `notCalled`. (e) approved, kill -9 before F-PLACE: one `notCalled`. (f) placed scheduled call then Stop: one `placedPending`, later the outcome. (g) never tried: no line. (h) r5 H5, **recovered settles (only the receipt listener completes and wakes; the finalizer at `handoff-boundary.ts:359-377` is not running):** with D6a mounted, (h1) a direct hand-off finished, its receipt on disk, kill -9 before its final commit: at the next start the boot settle runs the listener, the asker is woken (`wakeAfterRecoveredReceipt`) and the source is marked updated, as on base; (h2) the same for a room hand-off: its room request completes `done` pointing at the line; (h3) **re-arm in the settle, separately:** a live finish (finalizer) and a held reply whose hold later settles (row removed), fake clock frozen so the 60 s end watch and every pass timer cannot fire: right after the settle commits, the row's `updated_at` = the settle time, `ended != 0`, and `notCalled` (ARMED) is already in Sable's chat, all before any timer runs; (h4) **r5 M1:** a held-notice settle (`noticeHeldOne`, row kept): `ended` stays 0 and `end_kind` is set; when the held row is later removed, `notCalled` / `placedPending` follows within 60 s | arm removed; `notCalled` keyed on approval records; `placedPending` branch removed; late allow honoured; D6a registers its own `onDelegationReceipt` (kills (h1) wake, (h2) request state); nudge after the early returns (kills (h3)); nudge writes `ended` directly (kills (h4): the end watch stops and the line waits 24 h) |
| W14 | migration and downgrade | open with 10,000 historic calls: no read of `phone_calls` (statement trace); interrupted open re-runs; downgrade through the real downgrade route (a) with one PLACED `done = 0` row and (b) with an **empty** `phone_calls` and one ARMED row whose `notCalled` append failed: both refused `PHONE_CALLS_PENDING`, data untouched; after the report lands: downgrade proceeds as base; **r5 M4: (c) one REVISABLE row (`unclear` posted), call final, no key: downgrade proceeds; (d) REVISABLE at `outcome_at + 30 d`: DONE, no line, 0 reads after; (e) an ARMED row of a live hand-off (`ended = 0`): downgrade proceeds; (f) a keyless PLACED row whose call is `abandoned` (stop unconfirmed): refused `PHONE_CALLS_PENDING` (base alone would pass), then the owner deletes the call on the Phone calls page and the downgrade proceeds** | probe removed; probe nested inside the `phone_calls` query (kills (b)); migration reads `phone_calls`; probe without `posted_outcome IS NULL` (kills (c)); no 30-day end (kills (d)); probe without the ARMED `ended != 0` clause (kills (e)); Delete does not move the row to DONE (kills (f)) |
| W15 | r5 Astra M3: report failures never reach the tool | real `phone_call_place` through `/api/internal/phone/*` under No limits; the fake answers the create with a **definitive failure**, so D5 commits `failed` in its terminal write, the re-arm runs in that transaction and `syncReport` runs after commit **inside the tool call** (3.2); variant: a delegated `phone_call_result` whose `result` commits a final outcome; the D6a store is made to throw on the first `syncReport` read of step 1 and on its step 8 retry write (fault only in those two D6a statements): the tool returns the committed D5 result to the engine, the route answers 200, the row keeps its finite durable `due`; after the fault clears, the next pass posts exactly one line; a restart with the fault still set retries it and posts nothing twice | step 1 read outside the try; retry write unguarded (throws into the tool); skip map never expires (kills the post-clear line) |

**Evidence rules for the builder (r5, PROCFIX P1-P4, binding):** SITES.md lists the class grep and every site for W4(f)/(h) (owner
Stop sites, proof mints, `stopBotEverywhere` callers), W10 (every `refreshOne` early return) and W13(h) (every `settleReceipted`
caller); each row is driven through the production entry point named in the row (CHECKLIST.md column "entry point file:line");
each row is run RED on the D6a seat's declared pre-fix base at its behavioural assertion; besides the targeted mutants, each row
gets REVERT, NOOP and DROP null mutants in mutants.tsv; receipts.tsv is machine-checked (AssertionError at the targeted file:line).

Platform rows: W7, W11 (app stopped across `when`) and W13(b) run on Linux in the gate and on Windows and macOS through
`_small/WINRUN-REQ` / MAIN's Mac relay before release; a laptop sleep across `when` is W11 with the 1 h timer clamp. New test files
go in `ci/gate-tests.txt` (W1, W2, W4, W5, W7, W8, W11, W13, W15) or `ci/extended-tests.txt` (the rest) in the same push.

## 8. Fail-closed defaults (one line each)

- Unreadable or missing hand-off row, generation record, stop mark or report row: no mount, no card, no call.
- An owner-proven Stop pressed in the asking chat stops placement for every hand-off alive from it, on the press, durably (app DB,
  phone-DB fallback); a Stop without owner proof marks nothing.
- A read the pass cannot make, or a report write that keeps failing, backs off that row only; it never holds up other rows.
- Arming fails: no card and no call. Slot and intent commit together or not at all.
- A read error never becomes "ended", "final" or a line; it becomes a later retry.
- No report is guessed; unknown is `unclear`, revised once if D5 later learns more.
- A deleted source gets no line and is not recreated. A report failure never undoes or hides a committed phone outcome.
- A downgrade that would drop an owed line is refused with the existing code.

## 9. Dependencies and order

C0 lands, then F1 (store open without a key; start hook), F2 (`within(tx)` on `insert`/`update`/`settle`/`delete`), F3 (`isFinal`,
the single terminal write, `refreshOne`, the tagged `phoneVendorFetch` counter), then the D6a seat with RE-ANCHOR.md first. Edits:
F1's `index.ts` phone hunk, the engine permission handler call-out (5.8), the owner Stop site call-outs with `OwnerStopProof`
(5.4; r5: the bot interrupt route's six branches, typed stop, local-computer, room), the app-DB `handoff_stop_marks` table, one after-commit
nudge inside the existing receipt listener `index.ts:22662` (11.3), one clause in `checkPhoneCallsForDowngrade`.

## 10. GAP-CHECK (one adversarial pass on round 3, GAP-CHECK-BAR.txt; round-1/2 fixed items stay fixed)

### Fixed (round 3)
- (d) money: owner presses Stop in the asking chat while Ember waits at the card; r2 read a Stop registry that has no hand-off key.
  Fixed: STOP1 named for the queuing turn; identity-bound `handoff_stops` for later Stops (5.4; W4).
- (d) money: slot and intent were two writes; a crash between them left an orphan slot or a slot-less call. Fixed: one transaction
  (5.6; W5(g)). Ask preview showed a fresh card for a stored call. Fixed: shared `placementDecision`, D5 `sameRequest` card (5.5; W5(f)).
- (c) witness integrity: W5's mutant could not flip it; W5(c) contradicted D5 Delete. Fixed: slot-identity mutant; `not_set_up` (W5).
- (b) failure path: D6a read share could be starved; result path hid extra reads; keyless restart blocked a committed report. Fixed: own
  allowance counted at `phoneVendorFetch`, `refreshOne` without reconcile, pass starts without a key (3.3; W10).
- (b) truth: an `unclear` cancel was frozen though D5 later upgrades it. Fixed: REVISABLE state and one `correction` line (3.1; W8).
- (b) failure path: no witness for append failure beside healthy rows. Fixed: W10 case and three mutants.
- (c) migration: index build read all history; downgrade silently dropped owed lines. Fixed: new empty tables, refuse downgrade while
  owed with the existing code (5.11; W14).
- (b) failure path: day-7 stop of discovery lost a result when the key came back on day 9. Fixed: no end to daily discovery; key save
  re-arms (3.1, 3.2; W11).
- (a) purpose gap: the "no call" line had no durable obligation and missed No limits, "Allowed, not run" and open records. Fixed: the
  obligation row is armed before the card or tool; hand-off end read from DELEG's durable state (5.7, 5.8; W13).
- (a) purpose gap: a resumed engine could miss the posted line. Fixed: external-update registration, idempotent (5.9; W6).
- (b) race: interim line written from a stale pass snapshot after a final result or a Delete. Fixed: the pass never writes; all lines
  come from `syncReport`'s fresh reads and CAS (3.1, 3.3; W8, W9).
- (b) recovery: terminal debt with NULL due after a crash. Fixed: re-arm in the same CallStore transaction (3.2; W7(a)).
- (b)/(d) Fable 1 r2: Stop or restart after placement told the owner nothing for days. Fixed: `placedPending` (5.7; W13(f)).
- (e) `waiting` copy now says when Murage can't check (no key) (6.2).

### Fixed (in-lane Astra round 1)
- (b) failure path: Ember schedules Friday's call Wednesday, owner Stops Ember, the app dies before the end nudge; the row slept to
  Friday. Fixed: end watch on its own schedule, start re-arm (3.1, 3.2; W7(c)).
- (a) purpose gap: an `unclear` cancel later confirmed by the vendor never got its correction without an owner refresh. Fixed:
  automatic reads for REVISABLE (3.3; W8).
- (d) data loss: first-ever delegated attempt with an empty `phone_calls`; the downgrade probe returned nothing and the owed
  `notCalled` was copied aside. Fixed: separate probe (5.11; W14(b)).

### Fixed (in-lane Astra round 2)
- (b) failure path / D4: eight delegated calls await their vendor result, allowance 4 per pass; the skipped four had their read
  pushed back each pass and could wait indefinitely. Fixed: only an actual read moves `read_due` (3.1, 3.3; W10).

### Fixed (round 4 refresh on dev/1022)
- (b)/(a) failure path: the builder follows r3 literally and calls `onDelegationReceipt` for D6a's nudge. That slot holds one
  listener (`delegations.ts:421`, last writer wins) and dev/1022 already registers the turn engine's one (`index.ts:22662`: request
  completion, asker wake, source mark). Every hand-off's asking bot would then never hear its result. Fixed: the nudge is composed into
  the existing listener as its first statement, through `afterCommit` (11.3; W13(h)).
- (a) purpose gap: placed after the existing listener's early returns, the nudge would skip every live finish (`finalizingDelegations`)
  and every held reply, so the common path relied on the 60 s end watch only. Fixed: first statement, before both returns (11.3).
- (d) money: r3 marks source Stops inside `interruptDirectThread` "for owner-principal Stops only"; on dev/1022 it has 15 call sites
  and no principal input, so the filter cannot be written there and a routine or project interrupt would mark (or an owner route
  would be missed). Fixed: the mark sits in the four owner Stop paths, including the shared helper that typed "stop" uses and
  bot-level Stop everything (5.4, 11.5; W4(b) per path). Opus self-review High: typed "stop" bypassed the routes r4 first listed.
- (a) purpose gap: an owner who taps "Inject now" in the room that queued the hand-off would have stopped Ember's booking and got
  `notCalled`. Fixed: a room interrupt with `queueIds` marks nothing (5.4 (iv); W4(g)).
- (c) rule conflict with a landed slice: D6b's delegated email admission (`email/admission.ts:53-80, 117-119`) already defines the
  hand-off shape and the `handoffLive(generation, handoffId)` / `ownerRooted(handoffId)` seams that no production caller supplies.
  A second, different helper would give the two delegated tools two meanings of "live". Fixed: 5.1 also exports adapters for those
  two seams; wiring email stays D6b's (11.6).

### Fixed (round 5: Astra r4 BLOCK 5 High + 4 Medium + 1 Low, Fable r4 4 Medium + 2 Low; one adversarial pass)
- H1 (d) money: the owner presses Stop on the scoped v1 Stop (contract 1, what the client sends for a running turn) in Sable's chat
  while Ember waits at the card; that branch calls `interruptDirectThread` directly (`index.ts:37961`), so r4's mark in
  `stopDirectThreadForOwner` never ran and the approve placed a paid call. Fixed: one mark per branch of the route, six branches
  incl. contract 1, routine and busy-room (5.4 (i); W4(f) one row per site). Typed stop needs a running source turn (W4(f) setup).
- H2 (d) owner authority: a script holding a send-scoped MCP grant, or an unproven conversation-class origin on the room route,
  calls interrupt; r4 marked the hand-off and the owner's booking was cancelled to `notCalled` by someone who is not the owner.
  Fixed: `OwnerStopProof` minted only from `mayApprove` without grant or MCP key, or from `typedStopApplies`; host callers of
  `stopBotEverywhere` (quiesce, browser switch) do not mark (5.4; W4(h)). Also closes Fable M2, M4.
- H3 (d) money / (b) restart: the phone-DB mark write fails (disk full on that file), the mark sits in memory, the app restarts,
  DELEG resets the never-submitted hand-off to `fresh` under the same id and Ember places the call the owner stopped. Fixed: primary
  mark in the app DB in the same transaction as the id read, durable phone-DB fallback; residual (both files) parked (5.4; W4(c2)).
- H4 (b) failure path / D4: eight old open rows whose calls F3's `refreshOne` cannot read return with no request; r4 moved
  `read_due` only on a read, so they kept `due` in the past and filled `LIMIT 8` every pass; a later booked call and a `notCalled`
  were never posted. Fixed: separate local and read pages, every invocation moves `read_due`, `due` excludes `read_due` and has a
  30 s floor (3.1, 3.3; W10 stall row at N = 10 and N = 1000).
- H5 (c) witness integrity: W7(a)'s mutant (re-arm after commit) still passed through later reads; W13(h)'s "own listener" mutant
  still passed because the finalizer completes and wakes on a live finish. Fixed: crash-boundary DB assertion with `ended = 1` and
  a far `read_due` (W7(a)); recovered settles for the listener mutant, live finish and held reply kept for the re-arm (W13(h1)-(h3)).
- M1 (b): a held-notice receipt set `ended = 2`, the end watch stopped while the hand-off was still held, and its later end waited
  up to 24 h for a line. Fixed: the nudge writes `end_kind` only; `ended` derives from the absent row (3.1, 3.2; W13(h4)).
- M2 (b): a fresh append already emits SSE; r4's explicit publish showed a second frame. Fixed: publish only on a dedupe hit (3.1; W7(b)).
- M3 (b): a throw in the first read or in the retry write reached the tool. Fixed: whole body in one try, guarded retry write,
  skip map (3.1 step 8; W15).
- M4 / Fable M3 (b): a REVISABLE row or a keyless final row refused every downgrade for ever, under copy about calls in progress.
  Fixed: the probe counts only rows owing a first line; REVISABLE ends after 30 days (5.11; W14(c)(d)).
- Opus self-review r5 (0 Critical/High; 5 Medium, 5 Low, all fixed): (b) room Stop without `threadId` while the source is a room
  task thread marked only the main thread and the approve placed a call: mark every interrupted thread (5.4 (iv); W4(f)); (c)
  W13(h3) asserted a `due` the 30 s floor forbids: assert `ended`/line/`updated_at` at settle time; (c) W15 and W10's "committed
  result" never reached `syncReport` on a successful create: driven by a definitive create failure / `result`; (c) W4(f) routine
  row needs a busy room, legacy branch UNREACHABLE in SITES.md; (b) keyless `abandoned`/`ended` PLACED rows refused under the
  existing copy: kept as intended, Delete clears it, ARMED rows of live hand-offs no longer refuse (5.11; W14(e)(f)); Lows: W10
  stall fixture made buildable with per-N bounds, floor mutant dropped, in-process double publish closed, `end_kind` wording,
  `handoffStartedNow` reads the Stop marks (11.6).
- L1 / Fable L1 (e): `notCalled` said "Nothing was booked" for a cancel or ask. Fixed: purpose-specific variants, one stable id
  (6.2). Fable L2 (e): W4(f) gains a task-thread Stop row.

### Parked (round 4, one line each)
- Shipped exposure on dev/1022 (11.2): needs a RED witness and an owner (phonefix r4 `d49160e4c6` lineage is the candidate); not D6a's fix.
- F2 r3 and F3 each carry their own `within`; reconciling them is the F2/F3 owners' merge, not a D6a design change (11.1).
- D6b's index.ts email mount passes no `handoff`, so delegated email never mounts on dev/1022; D6b's row, not D6a's.

### Parked (for Sean / MAIN; one line each)
- Q1 (Sean): Stop after placement does not cancel the call (parity with a direct turn); `placedPending` tells the owner how to cancel.
- A source-chat Stop refuses placement for live hand-offs even though DELEG lets the hand-off itself run; chosen fail-closed for money.
- r5: the r4 memory-only fallback is replaced by a durable phone-DB fallback (5.4, Astra H3). Left open: the app DB and the phone DB
  both failing on the same Stop press and the app restarting before either recovers; a never-submitted redispatch could then place.
  Two independent files failing together is no realistic user path; a third store would exceed this design's bar.
- Clock skew is not a factor: no rule compares two wall-clock times across actors except due scheduling.
- Re-asking in new words creates a new hand-off and so may place a second call (new owner request by D3's definition).
- Base exposure (Fable 4 r2): RED witness on `dev/1022` needs an owner now (11.2; QUESTIONS.md). D5 K2 scope (Fable 5 r2) recorded by MAIN.
- Honouring a late Ask approval: rejected (places a call after the hand-off ended; new turn-less surface).
- Round-1 parked items (D8 ask-intent, D6b adopting the helper, waking Sable, two bots booking the same table, Sable's own switch)
  stand unchanged.

## 11. Round 4: what dev/1022 changes (refresh; no behaviour change outside 11.3, 11.5, 11.6)

Read on hub `dev/1022` @ `6d4b5932a8` (r3 `f568146add` merged into `design/1022-d6a-r4` with no conflicts; no product file touched).

### 11.1 Dependencies: where each one stands
| dep | what D6a needs from it | on dev/1022 | where it is |
|---|---|---|---|
| C0 + C0FIX | bot fence, trusted Ask context, late fence in `place`, `servePhoneTool` in `admission.ts` | IN (`50f0bd8077`, `ca267a964c`) | `phone-calls/admission.ts:23`, `service.ts:100-141` (`ctx.fenced`) |
| F1 | phone store opened without a key, start hook after listen | IN (`71cc343ae4`) | `startPhoneCalls` `index.ts:3863`, start step `index.ts:41426` (runs when phone calls are supported or `phone-calls.db` exists) |
| F2 | `within(tx)` on `insert`/`update`/`settle`/`delete` | NOT IN: `fix/1022-row48-D5F2-r3` @ `4261530018`, AGREED (row 48), not merged | `store.ts:111` `within(options)` at that sha |
| F3 | `isFinal`, single terminal write, `refreshOne`, counted `phoneVendorFetch` | NOT IN: `fix/1021-i20-d5f3` @ `228105308b`, PARTIAL, NO OWNER (row 65) | `service.ts:543` `refreshOne`, `:753` `isFinal`, `vapi-adapter.ts:69-75` allowance count, at that sha |

F3 `228105308b` is not built on F2 `4261530018` and carries its own `within` (`store.ts:92` at F3). The D6a seat needs one base
with both merged and that `within` reconciled by the F2/F3 owners. **The re-check gate stands unchanged:** no D6a seat before F2 and
F3 are in its base. A D6a without F2's same-transaction re-arm or F3's `isFinal` is refused, not adapted (fail closed: the re-arm is
what makes W7(a) hold).

### 11.2 Shipped exposure (r2 Fable 4), as it reads on dev/1022
`phoneMount` (`phone-calls/admission.ts:11-16`) decides on `ownerAudience`, `projectRole`, `botAllowed`, `agentsMcp` only, and
`runTurn` (`index.ts:17909-17918`) passes `directOwnerAudience && !isAutomationThread && !notOwnerAudience` as `ownerAudience` with no
`handoffTurn`, `commsDepth`, `chainRootThreadId`, `askerWake` or `cardContinuation` input (the email mount right above it,
`index.ts:17899-17906`, passes all of them). So whether a hand-off turn, a depth-2 turn or a card continuation in a bot's own chat
mounts the phone tools today depends only on `directOwnerAudience` for that turn. That is the RED witness r2/r3 asked for, now on
dev/1022; D6a's 5.2 `direct` clause (D5 I1) closes it as a side effect, but the witness and its owner are MAIN's call (parked; the
emergency phonefix r4 `d49160e4c6` mount-audience lineage, not on dev/1022, is the closest owner).

### 11.3 Hand-off-end nudge: compose, never register
dev/1022 has exactly one `onDelegationReceipt` slot (`delegations.ts:421`, "last writer wins") and it is taken by the turn engine
(`index.ts:22662`). The listener runs inside `settleReceipted`'s transaction (`delegations.ts:622-633`). D6a's nudge is therefore:
- the **first statement** of that listener, before its `finalizingDelegations.has(...)` and `receipt.held` returns, so live finishes
  and held replies are nudged too;
- `afterCommit(() => phoneHandoffs.handoffEnded(receipt.id, receipt.status === "done" && !receipt.held))` (`tx-scope.ts:30`; r5: it writes
  only `end_kind` and `due = now`, 3.2, and a held receipt therefore never ends the row's end watch), so the phone-DB write
  and `syncReport` never run inside the app-DB transaction and a rollback of the settle sends no nudge;
- wrapped in its own try; a throw is logged and dropped (the end watch of 3.1 still catches the end within 60 s).
`ok` = `receipt.status === "done" && !receipt.held`; every other status, and a held receipt even with status `done` (`delegations.ts:195`), is `end_kind = 2` (r5: copied into `ended`
only once the hand-off row is absent, 3.1 step 3). **No second `onDelegationReceipt` call anywhere**;
W13(h): with D6a mounted, a finished hand-off still completes its request and wakes its asker (mutant: D6a registers its own listener).

### 11.4 F2 delegation pack (1.0.23) contract
`design/1023-deleg-pack-r3` section 7 (C1-C5) binds F2, not D6a: F2 changes none of the `pending_delegations` fields 5.1 reads
(`owner_rooted`, `origin`, `started_at`, `turn_key`, `start_attempts`, `accepted_turn_id`, `target_thread_id`, `to_bot_id`), writes no
phone line, and leaves the receipt listener slot alone (its C4). D6a reads neither `item.freshRooted` nor `item.freshKey`. Whichever
of F2-pack and D6a lands second re-reads this pair in its RE-ANCHOR.md; W11b on the F2 side and W2 here stay the witnesses.

### 11.5 Owner Stop routes (5.4)
`interruptDirectThread` (`index.ts:5069`) is called from 15 sites on dev/1022 (4133, 5065, 11978, 14688, 14708, 20133, 22176,
22826, 23225, 23241, 23694, 30445, 36672, 36690, 37961: routines, projects, shared work, review claims, extension browser, asks, and
the owner helpers) and takes no principal, and it calls `cancelDirectTurnDispatch(..., ownerStop = true)` for every caller
(`index.ts:5084`), so `ownerStop` is not a principal signal either. The mark therefore goes in the owner Stop paths of 5.4
(i)-(iv). **r5:** at the route layer with an `OwnerStopProof`, one call per branch of the bot interrupt route (six, including the
contract-1 scoped Stop), not inside `stopDirectThreadForOwner` (5.4). `stopDirectThreadForOwner` covers the Stop button and typed stop in one place. W4(b) runs once per path: Stop button,
typed "stop", Stop everything, local-computer Stop, room Stop (room as source); plus W4(g): room "Inject now" marks nothing and the
hand-off still places (mutant: mark before the `queueIds` check).

### 11.6 One meaning of "live" for both delegated tools
D6b's admission already shapes a hand-off as `{ id, origin, ownerRooted, attended }` (`email/admission.ts:55`) and asks the caller
for `handoffLive(generation, handoffId)` and `ownerRooted(handoffId)` (`:117-119`, read at `:145`). `server/handoff-authority.ts`
(5.1) also exports `ownerRootedNow(handoffId)` and `handoffStartedNow(handoffId, { botId, threadId })` (the same PK read as
`handoffLiveNow`, without the mount-time `handoffGen` that D6b's record does not carry; r5: `handoffStartedNow` applies the same two
Stop-mark reads, so a source Stop stops delegated email exactly as it stops the phone path), so D6b's adapter can back its two seams with
the same reading of `pending_delegations`; mapping a capability generation to its email record stays in D6b's adapter. D6a does not edit `server/email/**` (scope unchanged); the D6b owner decides when to wire them.

## 12. Round 5: what changes against round 4 (Opus redesign; everything else is round 4)

| area | r4 | r5 | finding |
|---|---|---|---|
| Stop sites | 4 paths, mark inside `stopDirectThreadForOwner` | route layer, one mark per branch (bot route x6, typed stop, local-computer, room without `queueIds`) | Astra H1, Fable M1 |
| Stop authority | any caller of the routes | `OwnerStopProof` only; grant, MCP key, unproven origin and host callers mark nothing | Astra H2, Fable M2/M4 |
| Stop durability | phone DB, memory fallback | app DB `handoff_stop_marks` (atomic with the id read), phone-DB fallback, memory last | Astra H3 |
| pass | one page `LIMIT 8`, `due` includes `read_due`, read moves `read_due` only when a request is made | local page `LIMIT 8` + read page `LIMIT 4`; every invocation moves `read_due`; `due` floor `now + 30 s` | Astra H4 |
| hand-off end | nudge writes `ended` | nudge writes `end_kind`; `ended` only from the absent row | Astra M1 |
| SSE | publish after every append | publish only on a dedupe hit | Astra M2 |
| failure containment | steps 6-7 | steps 1-7, guarded retry write, skip map | Astra M3 |
| downgrade | any `done = 0` row refuses | only rows owing a first line; REVISABLE DONE after 30 d | Astra M4, Fable M3 |
| copy | one `notCalled` | `notCalled` / `notCalledCancel` / `notCalledAsk` (`purpose` column) | Astra L1, Fable L1 |
| witnesses | W1-W14 | W4 (c2)(c3)(f per site)(h), W7(a)(b), W10 stall row, W13(h1)-(h4), W14(c)(d), new W15; P1-P4 evidence rules | Astra H5, Fable L2 |

MAIN rulings checked: `local-memory-budget` (`QUESTIONS-FOR-MAIN.md:2186`) and `warm-active-only` (`:2296`) bind every lane. D6a adds
no local memory budget or cap of any kind and keeps no warm engine; the only bounds here are per-pass page sizes for background
report work, which never stop, refuse, truncate or delay an owner turn or its reply. No D6a read uses `pragma_data_version`.
Re-check gate unchanged: F2 `4261530018` and F3 `228105308b` are still not in `dev/1022` `6d4b5932a8`; no D6a builder seat before both.
