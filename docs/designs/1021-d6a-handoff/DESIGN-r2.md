# DESIGN (round 2): DELEG D6a hand-off producer: "have my secretary book a table", 1.0.21

Owners, one per side (OWNERSHIP rule; every contract below names both sides):
- This document: lane d6a-design-1021-r2 (designer, round 2), for SCOPE-1021 §H row "DELEG r5, r7.3 and D6a" (SCOPE-1021.md:158).
  Round 1 (`design/1021-d6a` @ `28a16617b6`, DESIGN.md) is superseded by this file. CHANGES-r2.md maps every round-1 review finding
  (Fable I20 BLOCK 1-6, Astra I20 BLOCK 1-8) to the section that closes it.
- **Producer side** (phone side: delegated mount input, call-time hand-off fence, per-hand-off placement slot, call-to-hand-off link,
  report writer, report follow-up pass, the hand-off-end "no call was made" line, copy): **the D6a builder seat. OPEN NO-OWNER until
  MAIN names it.** Recommended: one seat after C0 and the D5 slices F1, F2 and F3 land (it edits F1's `index.ts` phone hunk, F2's
  `CallStore` and F3's terminal write).
- **Consumer side** (DELEG side: the read of `pending_delegations` that proves a hand-off is owner-rooted, actively started, on the
  current dispatch generation and not Stopped; and the one registered hand-off-end hook in `settleReceipted`): **DELEG owner. OPEN
  NO-OWNER** (the L5b lanes that built r7.3 have finished, no DELEG lane is live). Recommended: the same D6a seat writes the read helper
  (5.1) and registers the hook (5.8); DELEG semantics are read, never changed. A DELEG reviewer signs W1, W2, W5 and W13.
- **Decision records side** (read only: `approval_records` rows of the delegate's turn, for 5.8): owner of `server/decision/**`
  (No-limits/decision lanes). D6a adds one read helper in its own file and writes nothing there.
- The D5 phone pack (`docs/designs/1021-phone-businesses/DESIGN.md` at `70141d6a02`, AGREED round 5; NOT yet an ancestor of
  `dev/1021`) owns placement, the Ask card text, booking and cancel rules, storage, reconcile, the definition of a final result and
  every vendor rule. D6a adds nothing to D5 invariants I1-I13.
- Bot fence and trusted Ask context: C0 `fix/1021-phone-c0` @ `50f0bd8077` (Astra-BLOCKed on 2 Highs, not in `dev/1021`).
- Delegated email (D6b) owns `server/email/**`. D6a edits no email file.
- Real-call gate: Sean (D5 P27). No D6a test places a real call or spends money.

Base read for every anchor: hub `dev/1021` @ `ce13438869baecb709e495f572bff879c940e740` (round 2 merged `dev/1021` @ `068a595c9a`: it changes none of the cited
phone, DELEG, decision, store or card files; only `server/index.ts` anchors above line 13349 move, by +7). Anchors name
the symbol too, because C0 and F1-F3 will move lines. **Re-check gate (Fable 3):** the D6a seat starts only after C0, F1, F2, F3 are
in its base, and its first commit is a RE-ANCHOR.md that re-reads every anchor in 4, 5.1-5.8 against that base and lists any that
moved or changed meaning. A changed meaning is a design question, never a silent adaptation.

## 0. PURPOSE and USER PROMISES

**PURPOSE.** The owner tells one bot "have my secretary book a table at Corner Bistro for four on Friday at 7". The secretary bot takes
the hand-off with the context it needs and phones the business on the owner's own Vapi account (D5). The owner gets the true result in
the conversation where they asked, whenever it lands, without opening another bot or page.

**USER PROMISES**
- D1 **One sentence to the bot the owner is talking to.** The secretary gets the hand-off note and the r7.3 context pack, and can ask
  the sender for a missing fact through the existing peer ask.
- D2 **Only the owner's own request can make a bot phone through a hand-off.** Allowed only when all hold: the hand-off was queued from
  a turn the owner was proven to have started (`owner_rooted`); it is one hop deep; it is attended; it is actively started on the
  current dispatch generation; no owner Stop is held or confirmed for it. The dialling bot must be one the owner allows (D5 I2). The
  D5 Ask card applies unchanged.
- D3 **One request, one call.** One hand-off places at most one vendor call, whatever the retries, rephrasing, redispatch, rebuild or
  restart.
- D4 **The report comes back and it is true.** The asking conversation gets exactly one outcome line per delegated call, written from
  D5's committed final result: booked only when the business confirmed (D5 U4). A call scheduled for later is followed from its
  scheduled time, and its real result is reported whenever it lands. If the result is late, the owner gets at most one interim
  "still waiting" line first; never a guessed or "lost" outcome that suppresses the real one. If the hand-off ends without a call
  (Ask card never answered, Stop, restart), the owner is told plainly that no call was made.
- D5 **The owner's data stays theirs.** No line carries the booking reference, transcript, vendor ids or key (D5 U7). No engine sees them.
- D6 **Nothing new to approve.** No new prompt, card or setting.

## 1. Scope

In: delegated mount; call-time fence; per-hand-off placement slot; durable call-to-hand-off link; outcome and interim lines in the source
conversation; the follow-up pass; the hand-off-end line for an unanswered Ask card; restart and downgrade handling of the link; copy;
witnesses.

Out (unchanged, owned elsewhere): D5 placement, number policy, booking/cancel, Ask card text, storage beyond 5.3; DELEG queue, pack,
receipt and Stop semantics; D6b; D8 phone ask-intent owner proof; `server/phones/**`.

## 2. The flow (simple path)

1. Owner, in Sable's chat: "Have Ember book a table at Corner Bistro for four on Friday at 7."
2. Sable calls `delegate`. `queueDelegation` (`delegations.ts:1202`) writes the `pending_delegations` row; `owner_rooted = 1` only for
   `origin = 'owner'` with the turn's `PackAuthority` (`:1248-1259`).
3. The dispatcher starts Ember's turn (`handoff-dispatch.ts:716-746`): `delegationRun`, `chainRootThreadId = source`,
   `commsDepth = 1`, `unattended` from the sender; DELEG stamps `started_at`, `turn_key` and `start_attempts` on the row.
4. `runTurn` mounts phone tools only through 5.2 and records `{ kind: "delegated", botId, threadId, generation, handoffId,
   handoffGen, sourceThreadId, intent: "handoff:<id>" }`.
5. Ember calls `phone_call_place`. The D5 Ask card shows on Ember's turn (none under No limits); it is an engine permission request
   bound to Ember's turn generation (see 5.8). After an allow, `servePhoneTool` runs F-CALL; `place` runs F-PLACE and, in the same
   synchronous section, claims the hand-off slot and inserts the intent row with `handoff_id`, `report_thread`, `report='owed'` and a
   persisted `report_due` (5.3, 5.6).
6. Ember gets D5's `engineResult` and replies; the reply returns through the shipped receipt.
7. When D5 commits the call's final result, the single report path (3) writes one line into Sable's chat.
8. If Ember's turn ends with the Ask card unanswered and no call row for the hand-off, 5.8 writes "no call was made" into Sable's chat.

## 3. State machine (the only state that crosses turns and restarts)

State: the call row's `report` column (phone-calls.db). The hand-off row and the in-memory phone-turn record are authority only.

```
         (direct-turn call: report NULL, never enters this machine)

 place(): slot claim + intent INSERT (one sync section), report_due = anchor + GRACE
                |
                v
           +---------+  D5 final result committed (any writer) --> reportCall --+--> outcome line ok --> WRITTEN (final)
           |  OWED   |                                                         +--> source deleted ----> DROPPED (final)
           +---------+  pass: now >= anchor + LATE_AFTER, still not final
                |              --> interim line ("still waiting"), then
                v
           +---------+  D5 final result committed (any writer) --> reportCall --> (same two exits; outcome line ok -> WRITTEN)
           | WAITING |  pass keeps reading until anchor + READ_UNTIL, then stops reading (report_due NULL); any later
           +---------+  D5 writer (owner refresh, D5 reconcile) still lands the real result here
  owner deletes the call row (D5 Delete) in OWED or WAITING -> row gone, nothing written (owner's choice)
```

- `anchor = max(createdAt, when)`; `when` is D5's validated ISO dial time (`service.ts:158-159`). GRACE = 60 s,
  LATE_AFTER = 24 h, READ_UNTIL = 7 d. All persisted per row as `report_anchor` so a clock or code change never re-times a row.
- **OWED and its due time are written in the same INSERT as the D5 intent row** (`CHECK (report IS NULL OR report_due IS NOT NULL OR
  report IN ('written','dropped','waiting'))`). A NULL-due OWED row cannot exist (Astra 4, Fable 1).
- **Reportable = D5's committed final result, not "ended".** `reportCall` calls D5's own final predicate (F3: `isFinal(row)`): ended
  with analysis or past D5's persisted analysis grace; `cancelled` confirmed; `abandoned` with `abandonCancel` settled; or D5's definitive
  create failure. An ended row D5 still holds open for a late analysis or a cancellation confirmation stays OWED/WAITING (Astra 5).
- **The single report boundary.** `reportCall(callId)` is synchronous end to end: it re-reads the row by id from phone-calls.db, checks
  `report IN ('owed','waiting')` and `isFinal`, chooses the line from that fresh row, appends to the app DB under the stable id, then
  `UPDATE ... SET report='written' WHERE id=? AND report IN ('owed','waiting')`. Both stores are synchronous node:sqlite, so there is no
  await between re-read and update; no other report can interleave in-process. A stale pass snapshot never chooses the line (Astra 5).
  A deleted row at re-read writes nothing. Callers (complete list):
  1. after commit of the one D5 terminal write (F3; every D5 writer goes through it: `result`, owner refresh, owner `cancel`,
     `reconcileAbandoned`, bot fence/Archive, late-analysis `settle`, definitive create failure). W8 drives each;
  2. the follow-up pass (5.6), for rows it finds final;
  3. the start sweep (5.6), for final rows left OWED/WAITING by a crash.
  `reportCall` never throws into its caller; a phone tool's committed outcome is returned to the engine whatever happens to the report
  (Astra 6).
- **WRITTEN and DROPPED are final.** WAITING is not final: it only records that the interim line was written (at most once, stable id).
- **Idempotence across the two DBs.** Outcome line stable id `"phone-report-" + sha256([handoffId, callId])`; interim line
  `"phone-report-wait-" + sha256([handoffId, callId])` (shipped stable-id dedupe, `Store.appendMessage`, `store.ts:4264-4294`). A crash
  between append and update leaves the row OWED/WAITING; the next sweep re-appends, the dedupe returns the stored row, and **reportCall
  then publishes that row on the thread's live stream** (the dedupe hit returns without SSE at base, Astra 6), so a connected client
  sees it; hydration covers a reconnect.
- **Append failure (Astra 6).** If the app-DB append throws (busy, I/O), the row stays in its state, `report_due = now + backoff(attempts)`
  (60 s doubling, cap 15 min), `report_attempts + 1`. Each row is handled in its own try; a failing row moves behind healthy rows by due
  time, so it cannot hold the first page. No attempt cap: the obligation is never dropped by a transient failure.
- **Restart.** Phone-turn records are in memory and die with the process: no pre-restart authority can place a call. OWED/WAITING rows
  persist and resume through the start sweep and the pass. DELEG's boot settle decides the hand-off; 5.5 covers why no second call.

## 4. Fences (each fails closed)

| Fence | Where | Checks | On failure |
|---|---|---|---|
| F-MOUNT | `runTurn` phone mount (`index.ts:17517`, `phoneVerdict`) | 5.2 predicate from one PK read of the hand-off row (5.1 `handoffAuthorityAt`) | no tools, `forgetPhoneThread`, primer 6.3 |
| F-CALL | `servePhoneTool` entry (`service.ts:403`; C0 moves it to `admission.ts`) | record is `delegated` and its generation is live; `handoffLiveNow(record)` (5.1); D5 per-bot switch for the dialling bot | `not_set_up`, 0 vendor requests |
| F-PLACE | inside `place`, the C0 late-fence point | `handoffLiveNow(record)` again, the record's generation still live, then the slot claim and intent INSERT, all in one synchronous section with no await between the check and the INSERT | `not_set_up`, no row, 0 vendor requests |
| F-SLOT | the same section | `INSERT INTO handoff_calls(handoff_id, call_id, at)` (PK `handoff_id`) succeeds; on conflict see 5.5 | stored result or `already_called`, 0 creates |
| F-GEN | phone-turn record by capability generation (`phone-turns.ts:12`) | revoked with the generation's claims (shipped) | no record, so `not_set_up` |
| F-REPORT | `reportCall` | fresh row; `isFinal`; stable id; state guard; source not deleted (`ownerDeletedThread`) | no line; DROPPED for a deleted source |
| F-DATA | line builder | only the projection in 5.7 | not a runtime branch (W6) |

Every check reads current state. A read that throws, or a missing row, counts as "not authority" (`email/admission.ts:151-153`).
After the INSERT the D5 vendor create runs as D5 specifies; a Stop that confirms after the INSERT does not cancel the call (Q1, parity
with a direct turn), and the call is reported.

## 5. Design of the new parts

### 5.1 Hand-off authority read (consumer contract; `server/handoff-authority.ts`, new, read-only)

```ts
export interface HandoffAuthority { id: string; origin: DelegationOrigin; ownerRooted: boolean; attended: boolean;
  sourceThreadId: string; handoffGen: string }
/** At mount: one PK read. Null if missing, unreadable, not actively started, or not on this destination/bot. */
export function handoffAuthorityAt(run: { id: string }, at: { botId: string; threadId: string; unattended: boolean }): HandoffAuthority | null;
/** At every call: same PK read; true only if all of 5.1 "live" hold now. */
export function handoffLiveNow(rec: { handoffId: string; handoffGen: string; botId: string; threadId: string }): boolean;
```

"Live" (Astra 1): `phase = 'started'` **and `started_at IS NOT NULL`** (a held row keeps `phase='started'` with `started_at` cleared,
`delegations.ts:1566-1570`, so it fails); the row's start identity equals `handoffGen` captured at mount, where `handoffGen = (turn_key, start_attempts)`, and
`accepted_turn_id` is NULL or equals the record's turn id (it may be stamped after mount) (the row has no generation column;
`delegations.ts:1466-1468`), so a redispatch, a re-start or a hold
(`holdUnexecuted`, `:2094-2113`) fails; the phone record's own capability generation must also still be live (F-GEN); `target_thread_id = threadId`; `to_bot_id = botId`; `owner_rooted = 1`;
`origin = 'owner'`; and **no owner Stop is held or confirmed for this hand-off or its source turn** (the Stop registry read used by
the JOINT RULING STOP-VS-REFUSAL, `index.ts:5075-5076`, `:5264-5274`). Fail-closed choice: a HELD Stop already refuses placement, even
though the ruling only makes it a fact once confirmed; placing a paid call on a Stop the owner pressed is the worse error.
Reads `id, source_thread_id, to_bot_id, origin, phase, started_at, turn_key, start_attempts, accepted_turn_id, target_thread_id,
owner_rooted` by primary key; writes
nothing; constant cost.

### 5.2 Delegated mount predicate (producer; `phoneMount` input, F1's admission module)

`phoneMount` gains `handoff?: HandoffAuthority | null`, `handoffTurn`, `commsDepth`, `chainRootThreadId`, `chainNotOwner`, `askerWake`,
`cardContinuation`, `projectCardRun`, `sharedWorkRun`.

- **direct** (D5 I1, unchanged): `!handoffTurn && !chainRootThreadId && (commsDepth ?? 0) === 0 && !askerWake && !cardContinuation`.
- **delegated**: all of `handoffTurn`; `handoff` non-null with `origin === "owner"`, `ownerRooted`, `attended`; `commsDepth === 1`;
  `chainRootThreadId === handoff.sourceThreadId`; `!chainNotOwner && !askerWake && !cardContinuation && !projectCardRun &&
  !sharedWorkRun`; not an automation thread; `directOwnerAudience` (`index.ts:16146-16150`); the thread is the bot's own main chat or
  task (`email/admission.ts:69-71`); D5's per-bot switch, engine and key checks for the dialling bot.
- **anything else**: not mounted.

`PhoneTurnRecord` gains `kind`, and for delegated: `handoffId`, `handoffGen`, `sourceThreadId`. Recorded exactly when mounted.

**Base exposure now (Fable 4, Astra cause):** at base `phoneMount` checks owner audience only (`index.ts:17516-17549`). Whether a
routine- or depth-2-started turn reaches it in shipped 1.0.20 is a live question outside D6a's landing order. QUESTIONS.md asks MAIN
for an owner to write that RED witness against `dev/1021` now.

### 5.3 Storage (producer; F2's store, additive) and migration/rollback (Astra 8, Fable 6)

`phone_calls` gains `handoff_id TEXT`, `report_thread TEXT`, `report TEXT CHECK (report IN ('owed','waiting','written','dropped'))`,
`report_anchor INTEGER`, `report_due INTEGER`, `report_attempts INTEGER NOT NULL DEFAULT 0`; all NULL/0 for direct and pre-1.0.21 rows.
New table `handoff_calls(handoff_id TEXT PRIMARY KEY, call_id TEXT NOT NULL, at INTEGER NOT NULL)` (5.5); never touched by D5 Delete;
rows older than 30 days pruned by the pass, 64 per pass.
Index `phone_calls_report_due ON phone_calls(report_due) WHERE report IN ('owed','waiting') AND report_due IS NOT NULL`.

- **Migration:** one transaction guarded by the phone DB `user_version`: `ALTER TABLE ... ADD COLUMN` (constant time in SQLite), create
  `handoff_calls`, create the partial index, bump `user_version`. An interrupted start rolls the whole step back and re-runs it (every
  statement `IF NOT EXISTS` / column-present checked). The partial index build reads `phone_calls` once (SQLite evaluates the predicate per
  row); `phone_calls` holds the owner's call history (one row per call), so this is a one-time O(calls) step, witnessed at 10,000 rows
  under 1 s (W14). It is not D5's constant-time empty index, and is named as such.
- **Downgrade:** the phone DB has its own path, `preservePhoneCallsForDowngrade` (`installation-memory-downgrade.ts:257`, called at
  `:288`, `:461`), not the app-schema gate. D6a's rule: the downgrade keeps the columns and `handoff_calls` (an older app ignores
  additive columns), so call history is never lost and OWED/WAITING obligations survive; on re-upgrade the start sweep resumes them and
  writes each line once (stable id). While an older app runs, no line is written; the older app's Phone calls page still shows the call.
  The downgrade is not refused for OWED rows (refusing a downgrade over a report line is out of proportion; parked for Sean).

### 5.4 Call-time fence (F-CALL, F-PLACE) and result reads

For a `delegated` record, `servePhoneTool` and `place` require `handoffLiveNow(record)` and a live record generation. Once the hand-off
finishes (row removed with the receipt, `delegations.ts:266-268`), is held, Stopped (held or confirmed), cancelled, redispatched or moves,
any `phone_call_place` from that turn gets `not_set_up`.

`phone_call_result` (Astra 1, W3): allowed only from a live generation of the same bot, and only for a call whose row has
`handoff_id = record.handoffId`. A delegate cannot read a call it did not place on this hand-off, nor a direct call. After the hand-off
ends there is no turn to read from; the report line carries the result.

**Stop.** Before the INSERT: refused (W4). After: not cancelled (Q1, unchanged from round 1; no Stop path reaches
`PhoneCallService.cancel` at base, `service.ts:238`); reported.

### 5.5 One hand-off, one call (D3; Astra 2, Astra 3)

- `intent = "handoff:" + handoffId` (never the prompt row id, generation or turn id).
- **Slot rule:** in F-PLACE's synchronous section, `place` inserts `handoff_calls(handoff_id, call_id)` together with the intent row.
  On a PK conflict: if the stored call's D5 request identity equals this one, return its stored `engineResult` (0 creates); otherwise
  return `already_called` with the stored call's `engineResult` (0 creates). A rephrased retry ("table for 4, Fri 7pm" vs "Friday 19:00,
  four people") therefore cannot create a second call. A second, different call needs a new owner request (a new hand-off).
- **D5 `liveByIdentity` reuse** is skipped for delegated places: a delegated place never attaches to a call owned by another hand-off
  or by a direct turn. If D5 would reuse one, the place returns `duplicate_live` (0 creates, no slot, no row) and Ember tells Sable a call
  for this is already in progress; the existing call keeps its own report (or none, for a direct call).
- **Delete:** owner Delete removes the call row only; `handoff_calls` stays, so a retry on the same live hand-off still gets
  `already_called`, not a new create.
- **Ask preview:** unchanged. The card shows before the slot check; a refused place after an allow is told to the engine
  (`already_called` / `duplicate_live` copy, 6.2), and nothing is created.
- **Boot cases are not retries (Astra 3).** On restart DELEG interrupts an accepted hand-off (`RESTART_RECEIPT`, `delegations.ts:1509`),
  holds an uncertain submitted one, and redispatches only one proven never submitted, which cannot have placed. Redispatch reuses the
  stamped prompt id. So the reachable repeat is the in-turn lost tool reply (transport drop, engine retries the tool), covered by the
  slot rule.

### 5.6 Report follow-up pass and start sweep (Fable 1, Astra 4)

- **Owned by the phone service**, started by `startPhoneCalls()` after listen; never started in a turn. One timer, single flight: it
  arms at `min(report_due)` (clamped to at most 1 h, so sleep or clock jumps are caught on the next fire); the OWED INSERT re-arms it only
  if its due is earlier. No pass overlaps another.
- **Initial due** = `anchor + GRACE`, persisted in the INSERT. **Before the anchor the pass makes no vendor read for the row** and writes
  no line. A D5 writer (owner refresh, owner cancel, D5 reconcile) can still land a final result before the anchor (e.g. the owner
  cancels Friday's call on Thursday); that goes through reportCall as usual.
- **Each pass** reads `report_due <= now ORDER BY report_due LIMIT 8` via the partial index. For each row (own try):
  1. fresh read; if `isFinal` -> `reportCall`;
  2. else if a vendor read is allowed (key present, budget left): one D5 `result` read under a 10 s deadline; a final result lands in
     the D5 terminal write and so in `reportCall`; a timeout or error is a miss, not a result;
  3. still not final: if `now >= anchor + LATE_AFTER` and `report = 'owed'`, write the interim line and set WAITING (stable id, once);
     next due = `now + min(60 s x 2^misses_since_anchor, 15 min)` for the first 24 h after anchor, then every 6 h; if
     `now >= anchor + READ_UNTIL`, `report_due = NULL` (the pass stops reading; the row stays WAITING and any later D5 writer still lands
     the real result).
  There is **no miss limit and no "lost" outcome**. Misses are counted only after the anchor.
- **Budget (Astra 4):** one shared budget of 8 vendor reads per pass interval across D5 reconcile and D6a (F3 exposes the counter);
  D6a takes at most 4 when D5 has pending reconcile work, otherwise up to 8. Oldest due first, so a starved row reaches the front.
- **No credential after restart (Astra 4):** no vendor read; rows stay in state; the interim line at anchor + 24 h tells the owner Murage
  can't check yet; when the key returns, the next pass resumes. A terminal local fact (owner cancel, D5 create failure) is still
  reported without a vendor read.
- **Start sweep:** the first pass after listen also takes OWED/WAITING rows that are already final (crash between terminal write and
  report), and rows whose due passed while the app was stopped or asleep (Vapi dials a scheduled call server-side even when Murage is off).
- **Cost:** history-independent: at most 8 rows and at most 8 vendor reads per pass whatever the number of past calls (W10).

### 5.7 Lines (F-DATA; Astra 7)

A Murage status line (`actorKind: 'murage'`, `murage: {kind:'status'}`, as `appendProjectCloseMessage`, `store.ts:4240-4244`) into
`report_thread`. Projection, the only inputs: `purpose` (enum), D5 outcome enum, D5 reason enum mapped to D5's localized reason copy
(never vendor free text), `{bot}` (dialling bot's display name from the store), `{business}`, `{time}`, `has_reference` (bool).
- `{time}` is **D5's validated structured result time** (the booked slot the business confirmed), never `when` (the dial time). If D5
  has no validated result time, the `bookedNoTime` key is used.
- `{business}` is D5's validated business label (single line, control characters stripped, at most 60 chars) if D5 stores one; else the
  dialled number as D5 formats it on the Ask card (the owner approved that number). Never model-written text that D5 did not validate.
- Sable reads the line as a Murage line on its next turn; no engine is woken; Ember's receipt stays as is.

### 5.8 Ask card answered after the delegate's turn ended (Fable 2; traced at base)

**What the card is at base.** The D5 Ask card is the engine permission request for `phone_call_place` (card text from `phoneAskLine`,
`drivers/phone-tool-schemas.ts:62-68`, used by every driver: `claude.ts:767`, `codex-hook.ts:1097`, `pi.ts:722`, `openai-chat.ts:1652`,
`acp/core.ts:4959`). It is registered as an `approval_records` row with `source_kind='engine'`, bound to the asking turn's generation,
and shown in the delegate's (Ember's) chat, with an attention notice to the owner (`index.ts:2936-2965`). The phone service only
learns of the call when the approved tool POST arrives.

**What happens when the turn ends first (base, traced):**
1. `turn.completed` for the generation retires its requests: success -> `completeDecisionGeneration`, otherwise
   `cancelRequests({kind:'generation'}, 'cancelled')` (`decision/implementation.ts:134-147`). The record settles `cancelled`; the card is
   patched `answered: 'Cancelled'`, `dismissed`, `orphaned` (`:494-510`); the client renders it closed (`src/components/OptionCard.tsx:11`)
   and the attention entry closes (`isOpen` reads state `open`, `index.ts:2945`). A restart settles every open engine record `expired`
   (`implementation.ts:709-710`).
2. A late Approve from a stale client: an allow on a record that is not `open`/`answered` is a no-op (`implementation.ts:529`); the
   engine route finds nobody waiting (`index.ts:10284-10296`, 404) or `answerRequest` returns `unavailable` (503 "The tool permission
   could not be delivered. Nothing was confirmed."). The engine process for that turn is gone, and F-GEN would refuse a tool POST
   anyway. **So a late approval can never place a call at base or under D6a.**
3. The gap: nothing tells the asking conversation. Sable's chat gets Ember's receipt ("stopped" / "interrupted by a restart" /
   Ember's last words, which may be "I'll call them now"). The owner, who is in Sable's chat, cannot tell whether a call was made. D4
   is broken (the report must be true and come back).

**Design (fail closed, no honouring):** a late approval is never honoured under a fresh fence. Honouring it would place a call after
the hand-off ended, against D2, and would need a turn-less execution path (new surface). Instead:
- **The hand-off-end line.** DELEG's `settleReceipted` (`delegations.ts:612`), the one place every hand-off ends (live finish, boot
  "interrupted", stranded sweep), calls one registered D6a hook inside its transaction, after the owed reply line (the same
  registration pattern as `owedReplyWriter`). The hook:
  - reads `handoff_calls` for the hand-off id: a row exists -> return (the call's own report covers it);
  - else reads the delegate turn's phone Ask records: `approval_records` with `thread_id = target_thread_id`, `source_kind='engine'`,
    `created_at >= started_at`, `state IN ('cancelled','expired')`, `answer IS NULL`, whose stored action names the place tool
    (`PHONE_PLACE_NAME`), via the `thread_id` prefix of `approval_chat_row`, `LIMIT 16` (bounded by the 30-day prune,
    `records.ts:95`);
  - one or more found -> append `phoneCalls.handoff.notCalled` into `source_thread_id` under stable id
    `"phone-notcalled-" + sha256(handoffId)`; none -> nothing (Ember never asked to call, or the owner denied: Ember's own reply says so).
  - It never throws into the settle: a read or append error is logged and the settle proceeds (the receipt is DELEG's obligation and is
    never held hostage by D6a). Fail-closed direction: a missing "no call" line is an omission, never a false claim.
- The builder confirms in RE-ANCHOR.md that `approval_records` and `pending_delegations` share the app DB transaction scope; if not, the
  hook runs `afterCommit` with the same stable id and the boot sweep re-runs it for hand-offs settled in the last 24 h (receipts file).
- Ember's card stays closed as base renders it. No new card, button or prompt (D6).
- In-turn answers are unchanged: allow -> F-CALL/F-PLACE; deny -> 0 creates, Ember's reply says so (W12).

## 6. Copy (every new owner-facing string; the builder's UI/copy owner adds keys and locales)

### 6.1 Outcome lines (`phoneCalls.handoff.*`)

| key | English | when (from D5's committed final result) |
|---|---|---|
| `booked` | {bot} booked {business} for {time}. The reference is on the Phone calls page. | `book`, outcome `done`, validated result time |
| `bookedNoTime` | {bot} booked {business}. The time and reference are on the Phone calls page. | `book`, `done`, no validated time |
| `cancelled` | {bot} cancelled your booking at {business}. | `cancel`, `done` |
| `asked` | {bot} called {business}. What they said is on the Phone calls page. | `ask`, `done` |
| `notDone` | {bot} called {business} but couldn't get it done: {reason}. | `not_done` (D5 reason copy) |
| `noAnswer` | {bot} called {business}, but nobody took the call. | `no_answer`, `busy`, `voicemail` |
| `failed` | {bot}'s call to {business} didn't go through. | `failed`, definitive create failure, vendor refusal |
| `stopped` | {bot}'s call to {business} was cancelled before it finished. | `cancelled`, `abandoned` with confirmed stop |
| `unclear` | Murage couldn't confirm how {bot}'s call to {business} went. Read the transcript on the Phone calls page. | D5 `unclear`, any unmapped outcome |

The mapping is total; anything unmapped is `unclear`, never `booked` (W8).

### 6.2 Other lines

| key | English | when |
|---|---|---|
| `waiting` | {bot}'s call to {business} hasn't reported back yet. Murage will post the result here when it does; the Phone calls page has the latest. | interim, 5.6 step 3 (at most once) |
| `notCalled` | {bot} didn't make the call: the call card closed before it was approved. Nothing was booked. Ask again if you still want it. | 5.8 |
| engine result `already_called` | "This request already placed a call. Its result is above; a different call needs a new request from the owner." | 5.5 |
| engine result `duplicate_live` | "A call for this is already in progress. Check the Phone calls page." | 5.5 |

### 6.3 Primer line

`phoneCalls.handoff.notHere`: "Phone calls on a hand-off need the owner's own request, one step away. Ask the owner to ask me
directly." Only on a hand-off turn that fails 5.2 for authority reasons when bot, key and engine would otherwise mount.

## 7. Witnesses (RED first on the builder's base; each has a mutant that must turn it RED)

All use the real `runTurn` mount, the real `/api/internal/phone/*` route, the real `handoff-dispatch` start and the D5 loopback fake
Vapi (`startFakeVapi`, C0) with a fake clock injected into the phone service. No hand-supplied ticket, no synthetic `startTurn`
(r7.3 T-P1). No real call.

**Isolation rule (Astra 3):** producer-boundary rows (who may mint `owner_rooted`) come from real `delegate` calls. Consumer-boundary
rows (5.1/5.2 checks) are written by DELEG's own store helpers with exactly one field varied from a valid row, so each mutant is killed
by its own fixture even where real end-to-end guards overlap. The builder states, per W2 case, which boundary it tests.

| row | case | pass condition | mutant |
|---|---|---|---|
| W1 | owner-rooted depth-1 attended hand-off books | tools listed on Ember's turn; one create; row has `handoff_id`, `report='owed'`, non-NULL `report_due`; fake ends `done` with sentinel reference and result time; Sable's chat has exactly one `booked` line with the result time | delegated predicate removed |
| W2 | not admitted (matrix) | `owner_rooted=0`; origin room/shared/legacy; depth 2; peer ask; unattended (routine); `chainNotOwner`; bot switch off; project card; root owner surface false; row missing; **held row (`started_at` NULL)**; **generation mismatch**; **Stop held**; **Stop confirmed**. Each: no tools (or `not_set_up` at call), no record, 0 vendor requests. Base-RED cases recorded | one mutant per check, each killed by its own fixture |
| W3 | hand-off ends mid-turn; result-read ownership | after mount, row removed / held / Stopped: next place `not_set_up`, 0 creates; `phone_call_result` answers only for the hand-off's own call and refuses a direct call id and another hand-off's call | `handoffLiveNow` dropped from F-CALL; ownership check dropped |
| W4 | late fence | barrier: Stop (held, then confirmed) lands after F-CALL, before the INSERT: 0 rows, 0 creates | F-PLACE recheck dropped |
| W5 | one hand-off, one call | (a) in-turn lost tool reply: transport drops the reply, engine retries identical args, then rephrased args: creates = 1, answers = stored result / `already_called`; (b) concurrent two places on one hand-off: creates = 1; (c) owner Deletes the call, retry: `already_called`, creates = 1; (d) boot cases: accepted -> interrupted receipt, held -> no redispatch, never-submitted -> redispatch with no prior call: total creates = 1 across all | slot table check removed; intent derived from request identity |
| W6 | owner data stays out | sentinel reference, transcript, vendor id, key, and private sentinels in adjacent free-text fields (goal, details, model-written business text) absent from Sable's rows, the real app SSE payload, Sable's next engine stdin, the receipt and Ember's tool result | builder reads `row.reference` or free-text business |
| W7 | exactly once across crashes | kill -9 (no shutdown handlers) (a) after terminal write, before append; (b) after append, before update; restart: one line, stable id; a live client receives it once via SSE on (b) | (a) start sweep removed; (b) random id; (c) no publish on dedupe hit |
| W8 | every writer reports truthfully, from the final result | drive `result`, owner refresh, owner `cancel`, `reconcileAbandoned` (confirmed, not_found), Archive fence, late-analysis `settle`, definitive create failure; each 6.1 outcome incl. unknown; ended-without-analysis stays OWED until D5's grace or the late analysis, then one line; owner Delete races report (no line); stale pass snapshot vs owner refresh (line chosen from fresh row) | hook only in `result`; default maps to `booked`; report on "ended" instead of `isFinal` |
| W9 | deleted source / deleted row | source deleted before final: `dropped`, thread not recreated; owner deletes row while OWED or WAITING: no line | `ownerDeletedThread` check dropped |
| W10 | pass finds the end, bounded, fair | turn ends while live; nobody reads; fake ends `done`; one line within its first due; 0, 1 and 100 bots with 3 OWED each plus 10 and 10,000 past rows: rows and vendor reads per pass at most 8, D6a at most 4 when D5 reconcile is pending; one fake read stalls: 10 s deadline, other rows still reported; no credential after restart: 0 vendor reads, local cancel still reported | full-table read; no deadline; budget not shared |
| W11 | **scheduled call** (replaces round-1 W11) | `when` = now + 3 days (fake clock): 0 pass vendor reads and 0 lines before `when`; first read at `when` + 60 s; fake ends `done` at `when` + 5 min: exactly one `booked` line. Variant: fake stays live until `when` + 30 h: one `waiting` line at `when` + 24 h, then the `booked` line when it lands; no "lost" line ever. Variant: reads stop at `when` + 7 d; owner refresh at day 9 lands `done`: one `booked` line | misses counted from `createdAt`; first due NULL; any give-up that writes a final line or blocks the late result |
| W12 | Ask card in-turn unchanged | No limits off: card on Ember's turn; deny: 0 creates, no row; allow: one create. No limits on: no card, one create | delegated turns skip the card |
| W13 | **Ask card outlives the turn** (new) | card open on Ember's turn; turn ends by (a) Stop, (b) restart (kill -9), (c) turn failure: card renders closed; a late Approve from a stale client returns 404/503 and makes 0 creates and no row; Sable's chat gets exactly one `notCalled` line after the receipt; a hand-off whose card was denied in-turn, or that never asked, gets no `notCalled` line; a hand-off that placed a call gets no `notCalled` line | hook not registered; hook ignores `handoff_calls`; late allow honoured |
| W14 | migration and downgrade | upgrade with 10,000 rows < 1 s; interrupted init (kill between statements) re-runs cleanly; downgrade via `preservePhoneCallsForDowngrade` keeps columns, OWED and `handoff_calls`; re-upgrade writes the line once | migration without `user_version` guard; downgrade drops columns |

Platform rows (Astra 8): W7 and W11 (app stopped across `when`, then started) and W13(b) run on Linux in the gate, and on Windows and
macOS through `_small/WINRUN-REQ` / MAIN's Mac relay before release; a laptop sleep across `when` is W11 with the timer clamp (5.6).
New test files go in `ci/gate-tests.txt` (W1, W2, W5, W7, W8, W11, W13) or `ci/extended-tests.txt` (the rest) in the same push.

## 8. Fail-closed defaults (one line each)

- Unreadable/missing hand-off row, generation record, Stop state or flag: no mount, no call.
- A HELD Stop refuses placement (stricter than the ruling's "fact once confirmed"; chosen because a call costs money).
- An OWED row always has a due time; a report never comes from a guess; nothing writes "lost".
- An unknown outcome is `unclear`; a late result gets one interim line, then its real line.
- A late Ask approval never places a call; the source hears `notCalled`.
- A deleted source gets no line and is not recreated. A report failure never undoes or hides a committed phone outcome.

## 9. Dependencies and order

C0 lands (its two Astra Highs fixed), then F1, F2, F3 (F3 must expose `isFinal`, the single terminal write and the read-budget
counter), then the D6a seat with RE-ANCHOR.md first. D6a's `index.ts` edit stays inside F1's phone hunk; the DELEG edit is one hook
registration in `settleReceipted`.

## 10. GAP-CHECK (one adversarial pass, GAP-CHECK-BAR.txt; round-1 fixed items stay fixed)

### Fixed (round 2)
- (b) failure path / D4: owner says "book it Friday" on Wednesday; round 1 counted 12 misses at a 15-minute cap and wrote "lost" the
  same afternoon, then dropped Friday's real result. Fixed: due from `anchor = max(createdAt, when)`, no miss before anchor, no miss
  limit, no "lost" outcome; interim line only at anchor + 24 h; real result always lands (5.6, 3; W11).
- (b) failure path: OWED inserted with no first due, invisible to the due query. Fixed: due persisted in the INSERT plus a CHECK (3, W1).
- (a) purpose gap / D4: Ember's turn ends (Stop, restart, failure) with the Ask card open; owner in Sable's chat cannot tell whether a
  call was made. Traced: a late approval can never place a call. Fixed: one `notCalled` line via the hand-off-end hook (5.8, W13).
- (d) authority: a held hand-off (phase started, `started_at` NULL) or a Stopped one passed the round-1 live predicate while a place was
  pending. Fixed: active start stamp, generation, Stop state, and the no-await check+INSERT section (5.1, 4; W2, W4).
- (d) money: a rephrased retry after a lost tool reply missed D5's identity lookup and created a second call. Fixed: per-hand-off slot
  table, no cross-owner reuse, Delete-proof (5.5, W5).
- (d) truth: the line used `when` (dial time) as the booked time. Fixed: D5's validated result time, `bookedNoTime` fallback, trusted
  business label (5.7, W6).
- (b) failure path: reporting on first "ended" froze an unclear line while D5 still awaited analysis or cancel confirmation; stale pass
  snapshot raced owner refresh. Fixed: `isFinal` + fresh read at one synchronous boundary (3, W8).
- (b) failure path: app-DB append failure after the phone commit stranded the line or hogged the page; dedupe hit sent no SSE. Fixed:
  per-row retry with backoff, isolation, publish on dedupe hit (3, W7, W10).
- (b) failure/scale: no deadline, no shared budget, no credential after restart. Fixed (5.6, W10).
- (c)/(d) migration: wrong downgrade path named; partial index cost unstated; OWED lost on downgrade. Fixed (5.3, W14).
- (c) witness integrity: W5's boot redispatch was unreachable and its mutant could not flip it. Fixed: reachable lost-reply repeat,
  boot cases split, isolation rule for W2 (5.5, 7).

### Parked (for Sean / MAIN; one line each)
- Q1 (Sean): Stop after placement does not cancel the call (parity with a direct turn). Unchanged from round 1.
- Downgrade is not refused for OWED rows; lines resume on re-upgrade (5.3). Refusing would be out of proportion.
- D5 K2 ("tell the owner when a scheduled call ends") is answered here for the delegated path only, plus a background pass with vendor
  reads and no owner present (Fable 5): MAIN records this; direct calls stay as D5 has them.
- Base exposure (Fable 4): needs an owner for a RED witness against `dev/1021` now (QUESTIONS.md).
- Honouring a late Ask approval under a fresh fence: rejected (places a call after the hand-off ended, D2; new turn-less surface).
- A "lost" outcome after 7 days: rejected; the row stays WAITING and the Phone calls page is the truth.
- Round-1 parked items (D8 ask-intent, D6b adopting the helper, waking Sable, two bots booking the same table, Sable's own switch,
  Ember's reply plus the line) stand unchanged.
