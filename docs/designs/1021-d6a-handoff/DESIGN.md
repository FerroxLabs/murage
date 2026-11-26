# DESIGN (round 1): DELEG D6a hand-off producer: "have my secretary book a table", 1.0.21

Owners, one per side (OWNERSHIP rule; every contract below names both sides):
- This document: lane d6a-design-1021-wf1121 (designer, round 1), for SCOPE-1021 §H row "DELEG r5, r7.3 and D6a" (SCOPE-1021.md:158).
- **Producer side** (phone side: the delegated mount input, the call-time hand-off fence, the call-to-hand-off link, the report-back
  writer, the report follow-up pass, the copy): **the D6a builder seat. OPEN NO-OWNER until MAIN names it.** Recommended: one seat
  after the D5 slices F1, F2 and F3 land, because it edits F1's `index.ts` phone hunk, F2's `CallStore` and F3's terminal write.
- **Consumer side** (DELEG side: the read of `pending_delegations` that proves a hand-off is owner-rooted, started and live, and the
  hand-off's stable intent key): **DELEG owner. OPEN NO-OWNER** (the L5b lanes that built r7.3 have finished, and no DELEG lane is live).
  Recommended: the same D6a seat writes the one read helper (section 5.1). DELEG semantics are read, never changed. A DELEG reviewer
  signs the end-to-end rows.
- The D5 phone pack (`docs/designs/1021-phone-businesses/DESIGN.md` at `70141d6a02`, AGREED round 5) owns placement, the Ask card, booking
  and cancel rules, storage, reconcile and every vendor rule. This design adds nothing to the D5 invariants I1-I13. It only adds a second
  admitted turn kind (an owner-rooted hand-off) and a report back to the conversation that asked.
- Bot fence and trusted Ask context: C0 `fix/1021-phone-c0` @ `50f0bd8077` (pushed; Astra BLOCKed it on 2 Highs, and it is not in `dev/1021`).
  D6a depends on C0 as it lands and does not edit it.
- Delegated email (D6b) owns `server/email/**`. D6a uses its predicate as the pattern (`email/admission.ts:74-81`, `:144-146`) and edits
  no email file.
- Real-call gate: Sean (as D5 P27). No D6a test places a real call or spends money.

Base read for every anchor: hub `dev/1021` @ `ce13438869baecb709e495f572bff879c940e740`. Anchors also name the symbol, because D5
slices will move the lines.

## 0. PURPOSE and USER PROMISES

**PURPOSE.** The owner tells one bot "have my secretary book a table at Corner Bistro for four on Friday at 7". The secretary bot takes
the hand-off with the context it needs and phones the business on the owner's own Vapi account (D5). The owner gets the true result in
the conversation where they asked, without having to open another bot or page.

**USER PROMISES**
- D1 **One sentence to the bot the owner is talking to.** The owner never re-types the request to the secretary. The secretary gets the
  hand-off note and the r7.3 context pack, and can ask the sender for a missing fact through the existing peer ask.
- D2 **Only the owner's own request can make a bot phone through a hand-off.** The call is allowed only when all of these hold: the
  hand-off was queued from a turn the owner was proven to have started (`owner_rooted`); it is one hop deep; it is attended; and it is
  still live when the call is placed. The bot that dials must be one the owner allows (D5 I2). The D5 Ask card applies unchanged.
- D3 **One request, one call.** A hand-off that is retried, redispatched, rebuilt or resumed after a restart never places a second
  call or books twice.
- D4 **The report comes back, once, and it is true.** The asking conversation gets exactly one plain line for each delegated call:
  booked only when the business confirmed (D5 U4); otherwise the actual outcome, or that Murage could not tell. The line comes back
  after a crash, a restart or a turn that ended before the call did. It never says "booked" on a guess.
- D5 **The owner's data stays theirs.** The report never carries the booking reference, transcript or vendor key (D5 U7). No engine
  sees them.
- D6 **Nothing new to approve.** No new prompt, card or setting. Every control stays where D5 put it (the Phone calls page, the per-bot
  switch, the Ask card).

## 1. Scope

In: the delegated phone mount (owner-rooted, depth one, attended); the call-time hand-off fence; the hand-off's stable intent; the
durable link from a call to its hand-off; one report line in the source conversation; the follow-up pass that makes sure the report
is written; restart recovery of that link; copy; witnesses.

Out (unchanged, owned elsewhere): D5 placement, number policy, booking and cancel, Ask card, storage layout beyond the additive
columns in 5.3; DELEG queue, pack, receipt and Stop semantics; delegated email (D6b); phone ask-intent owner proof (D8: until it lands,
a hand-off started from a paired-phone ask-intent is not owner-rooted, so it cannot phone, as r7.3 section 2 requires); the paired-handset
`server/phones/**` integration (a different "phone").

## 2. The flow (simple path)

1. Owner, in Sable's chat: "Have Ember book a table at Corner Bistro for four on Friday at 7."
2. Sable calls `delegate` (shipped). `queueDelegation` (`delegations.ts:1202`) writes the `pending_delegations` row. `owner_rooted = 1`
   because the turn carries the owner's `PackAuthority` (`:1250-1259`). The r7.3 pack is enqueued.
3. The dispatcher starts Ember's hand-off turn (`handoff-dispatch.ts:716-746`): `delegationRun`, `chainRootThreadId = source`,
   `commsDepth = item.depth + 1 = 1`, `unattended` taken from the sender.
4. `runTurn` mounts the phone tools on Ember's turn **only through the delegated predicate (5.2)**. It records the phone turn as
   `{ kind: "delegated", botId, threadId, intent: "handoff:<id>", handoffId, sourceThreadId }`.
5. Ember calls `phone_call_place {purpose:"book", to, goal, details, when}`. The D5 Ask card shows on Ember's turn as it does today
   (no card under No limits). `servePhoneTool` checks the hand-off fence (5.4) at entry. `place` checks it again immediately before
   the durable intent insert. The insert writes the row with `handoff_id`, `report_thread = source` and `report = 'owed'` in the same
   statement (5.3).
6. Ember gets the D5 `engineResult` (no reference). Ember replies ("Calling Corner Bistro now"), or waits with `phone_call_result`. The
   reply goes back to Sable's chat through the shipped receipt.
7. Whenever and however the call reaches a terminal state, the **single terminal path** (section 3) writes one Murage status line into
   Sable's chat: "Ember booked Corner Bistro for Fri 7:00 PM. The reference is on the Phone calls page."

## 3. State machine (the only state that crosses turns and restarts)

The state is the call row's `report` column (phone-calls.db). The hand-off row and the in-memory phone-turn record are authority only:
nothing after step 5 depends on them, and both may be gone by the time the call ends.

```
            (direct-turn call: report NULL, never enters this machine)

  place(): durable intent insert, same statement
                 |
                 v
            +---------+   call terminal (any writer) ---> reportCall(row) --+--> append ok -----------> WRITTEN (final)
            |  OWED   |                                                    +--> source deleted ------> DROPPED (final)
            +---------+   follow-up gives up (5.6)  ---> reportCall(row, lost)   (same two exits)
                 |
                 +-- owner deletes the call row (D5 Delete) -> row gone, nothing written (owner's choice; nothing restored)
```

- **OWED** is written in the same `INSERT` as the D5 intent row, so a call without its link cannot exist, and neither can a link
  without its call.
- **Terminal statuses** are D5's: `ended` (any outcome, including `unclear`), `cancelled`, and `abandoned` with `abandonCancel`
  settled (`confirmed` or `not_found`). A live or uncertain row stays OWED.
- **The single terminal path.** `reportCall(row, reason?)` is the only function that leaves OWED, and every caller is listed here:
  1. the `CallStore` terminal write that every D5 writer goes through (`result`, owner refresh, owner `cancel`, `reconcileAbandoned`,
     bot fence and Archive, late analysis `settle`). F3 owns that write. D6a adds one call after its commit. If F3 keeps several terminal
     writes, D6a adds the call to the one helper they all use; a witness (W8) drives every writer;
  2. the follow-up pass (5.6), with `reason = "lost"`, only after its stop rule;
  3. the start sweep after listen (5.6), for OWED terminal rows left by a crash.
- **WRITTEN and DROPPED are final.** No path moves a row back to OWED, and none writes a second line.
- **Idempotence across the two databases.** The status line lives in the app database and the row lives in phone-calls.db, so one
  transaction cannot cover both. `reportCall` appends with
  `stableId = "phone-report-" + sha256([handoffId, callId])`, using the shipped stable-id dedupe (`Store.appendMessage`,
  `store.ts:4266`; the `appendProjectCloseMessage` pattern, `:4240-4244`). It then sets `report = 'written'` with
  `WHERE id=? AND report='owed'`. A crash between the two leaves OWED, and the next sweep re-appends: the stable id returns the stored
  row, so the conversation still has one line.
- **Restart.** Phone-turn records are in memory and die with the process, so no old generation can place a call after a restart (fail
  closed). OWED rows persist. The start sweep and the follow-up pass resume them. DELEG's own boot settle
  (`settleStartedDelegations`, `delegations.ts:1728`) decides the hand-off (receipt or redispatch). A redispatched turn mounts again
  with a new generation and the **same intent** (5.5), so it cannot place a second call.

## 4. Fences (each fails closed)

| Fence | Where | Checks | On failure |
|---|---|---|---|
| F-MOUNT | `runTurn` phone mount (`index.ts:17517`, `phoneVerdict`) | 5.2 predicate, from one primary-key read of the hand-off row | no tools listed, `forgetPhoneThread`, primer line 6.2 |
| F-CALL | `servePhoneTool` entry (`service.ts:403`, moved to `admission.ts` by C0) | the record is `delegated`; 5.4 `handoffLive` and `ownerRooted` read now; D5 per-bot switch for the dialling bot | `not_set_up`, 0 vendor requests |
| F-PLACE | inside `place`, immediately before the durable intent insert (the C0 late-fence point) | the same 5.4 reads again, in the same synchronous section as the insert | `not_set_up`, no row, 0 vendor requests |
| F-GEN | phone-turn record by capability generation (`phone-turns.ts:12`) | revoked with the generation's claims (shipped); one live generation per thread | no record, so `not_set_up` |
| F-REPORT | `reportCall` | stable id; `report='owed'` guard; source not deleted (`ownerDeletedThread`) | no line; DROPPED |
| F-DATA | report line builder | only server fields: purpose, outcome, reason, D5 `{business}`, `when`, `has_reference`; never `reference`, transcript, vendor ids or key | not a runtime branch: the builder has no access to those fields (W6) |

Every check reads current state. A read that throws or a missing row counts as "not authority" (the `authorizeEmailCall` rule,
`email/admission.ts:151-153`).

## 5. Design of the new parts

### 5.1 Hand-off authority read (consumer contract; `server/handoff-authority.ts`, new, read-only)

```ts
export interface HandoffAuthority { id: string; origin: DelegationOrigin; ownerRooted: boolean; attended: boolean; sourceThreadId: string }
/** At mount: one PK read of pending_delegations. Null if the row is missing, unreadable or not started on this destination for this bot. */
export function handoffAuthorityAt(run: { id: string }, at: { botId: string; threadId: string; unattended: boolean }): HandoffAuthority | null;
/** At every call: the row is started, target_thread_id = threadId, to_bot_id = botId, owner_rooted = 1, origin = 'owner'. */
export function handoffLiveNow(handoffId: string, at: { botId: string; threadId: string }): boolean;
```

- It reads `id, source_thread_id, to_bot_id, origin, phase, target_thread_id, owner_rooted` by primary key: constant cost at any history
  size. It writes nothing.
- `attended = !opts.unattended`. `unattended` already merges the item flag and the sender's state (`handoff-dispatch.ts:727`).
- It satisfies the shape of the email `EmailCallLive.handoffLive` and `ownerRooted` hooks (`email/admission.ts:116-119`). Today those
  hooks have no production implementation, so delegated email fails closed at base. Whether D6b adopts this helper is D6b's choice
  (parked, section 9).

### 5.2 Delegated mount predicate (producer; `phoneMount` input, F1's admission module)

`phoneMount` gains `handoff?: HandoffAuthority | null` and `handoffTurn: boolean`, plus `commsDepth`, `chainRootThreadId`,
`chainNotOwner`, `askerWake`, `cardContinuation` and `sharedWorkRun`. The turn kind is decided once:

- **direct** (D5 I1, unchanged): `!handoffTurn && !chainRootThreadId && (commsDepth ?? 0) === 0 && !askerWake && !cardContinuation`,
  plus D5's existing conditions.
- **delegated** (new): every one of these must hold:
  - `handoffTurn`;
  - `handoff` is non-null, `origin === "owner"`, `ownerRooted === true` and `attended === true`;
  - `commsDepth === 1`, and `chainRootThreadId === handoff.sourceThreadId`;
  - `!chainNotOwner`, `!askerWake`, `!cardContinuation`, `!projectCardRun` and `!sharedWorkRun`;
  - not an automation thread;
  - `directOwnerAudience`, which includes the root's owner surface (`index.ts:16146-16150`);
  - the bot's thread is its own main chat or one of its own tasks (the `ownThread` rule, `email/admission.ts:69-71`);
  - D5's per-bot switch for **this** (dialling) bot, and its engine and key checks.
- **anything else**: not mounted. This covers a peer ask (`commsDepth >= 1` without `delegationRun`), depth 2 or more, room, shared and
  legacy origins, a hand-off with no owner root (including the phone ask-intent case until D8), an unattended hand-off (a routine's;
  Q-P6 keeps owner routines refused), and a hand-off whose row is gone.

The record (`PhoneTurnRecord`, F1 adds `intent`) gains `kind: "direct" | "delegated"`, plus `handoffId` and `sourceThreadId` for
the delegated kind. It is recorded exactly when the turn is mounted (D5 5.1). Otherwise `forgetPhoneThread` runs (shipped).

### 5.3 Call-to-hand-off link (producer; F2's store, additive columns)

`phone_calls` gains `handoff_id TEXT`, `report_thread TEXT` and `report TEXT CHECK (report IN ('owed','written','dropped'))`, all NULL
for direct calls and for every pre-1.0.21 row. It also gains
`CREATE INDEX phone_calls_report_owed ON phone_calls(report_due) WHERE report = 'owed'`, plus `report_due INTEGER` and
`report_misses INTEGER NOT NULL DEFAULT 0` for 5.6. These are schema additions only: no backfill, and the downgrade gate gets their
names (the `installation-app-schema-downgrade` pattern used for `owner_rooted`, `installation-app-schema-downgrade.ts:404`).

### 5.4 Call-time hand-off fence (F-CALL, F-PLACE)

For a `delegated` record, `servePhoneTool` and `place` additionally require `handoffLiveNow(record.handoffId, {botId, threadId})`. Once
the hand-off finishes (its row is removed with the receipt, `delegations.ts:266-268`), is Stopped, is cancelled for deletion or moves
away, any later `phone_call_place` from that turn gets `not_set_up`. `phone_call_result` for a call this bot already placed stays
allowed, as D5 allows it.

**Stop.** Before placement, a confirmed Stop on the hand-off removes or changes the row, so F-PLACE refuses (W4). After placement,
Stop does not cancel the vendor call. That matches a direct turn's Stop at base (no Stop path reaches `PhoneCallService.cancel`), and
the call card already offers Cancel. The report line still comes back. See QUESTIONS.md Q1.

### 5.5 Stable intent (D3)

D5 I5 keys "one request, one call" on `intent`, which is the owner message id the turn answers. For a delegated turn,
**`intent = "handoff:" + handoffId`**: it is never taken from the prompt row's id, a generation or the turn id. A hand-off retried after
a failed start, redispatched after a crash, rebuilt after a memory refusal, or resumed with a new generation keeps the same intent. So
D5's `byIntent` returns the first call's stored `engineResult` with 0 vendor creates. A new owner request is a new hand-off with a new
id, so it may book again (the D5 rule).

### 5.6 Report follow-up and start sweep (D4 when nobody is watching)

D5 learns a call's end only when someone calls `result`, opens the owner page, or runs the reconcile passes started by `place` and
`result`. D5 has no timer. A delegate whose turn ended before the call did may never call `result` again. So:

- **One pass, owned by the phone service** and started by `startPhoneCalls()` after listen (D5 5.4 "Service start"). It is never
  started in a turn. It is armed only while `SELECT 1 ... WHERE report='owed' LIMIT 1` finds a row, and re-armed by the insert that
  writes OWED.
- **Each pass** reads `report_due <= now ORDER BY report_due LIMIT 8` through the partial index, and shares D5's budget of 8 vendor
  reads per pass. A terminal row goes straight to `reportCall`. A live row gets one shipped `result` read, which lands in the D5 terminal
  write and so in `reportCall`. A row still live afterwards gets
  `report_due = now + min(60 s x 2^misses, 15 min)` and `misses + 1`.
- **Stop rule:** 12 misses, or 24 h after `max(createdAt, when)`. Then `reportCall(row, "lost")` writes the "lost track" line. The D5
  row is not changed: the owner page still refreshes it, and D5 decides its truth. A later terminal write finds `report <> 'owed'` and
  writes nothing. "Lost track" is the one line (D4: one line per call).
- **Start sweep:** the first pass after listen also takes OWED rows that are already terminal (a crash between terminal write and
  report). Same function, same stable id.
- Cost: the passes are history-independent. They read at most 8 rows and 8 vendor reads, whatever the number of past calls (W10).

### 5.7 Report line (F-DATA)

A Murage status line (`actorKind: 'murage'`, `murage: {kind: 'status'}`, as `appendProjectCloseMessage` writes it) goes into
`report_thread`. Its fixed copy has the keys in 6.1, filled only from server fields. Sable reads it as a Murage line on its next turn.
No engine is woken by it, and the receipt Ember's turn already wrote stays as it is.

## 6. Copy (every new owner-facing string; the builder's UI/copy owner adds keys and locales)

### 6.1 Report lines (`phoneCalls.handoff.*`)

| key | English | when |
|---|---|---|
| `booked` | {bot} booked {business} for {time}. The reference is on the Phone calls page. | `book`, outcome `done` with reference |
| `cancelled` | {bot} cancelled your booking at {business}. | `cancel`, outcome `done` |
| `asked` | {bot} called {business}. What they said is on the Phone calls page. | `ask`, outcome `done` |
| `notDone` | {bot} called {business} but couldn't get it done: {reason}. | outcome `not_done` (D5 reason copy) |
| `noAnswer` | {bot} called {business}, but nobody took the call. | `no_answer`, `busy`, `voicemail` |
| `failed` | {bot}'s call to {business} didn't go through. | `failed`, vendor refusal, `abandoned` never created |
| `stopped` | {bot}'s call to {business} was cancelled before it finished. | `cancelled`, `abandoned` with confirmed stop |
| `unclear` | Murage couldn't confirm how {bot}'s call to {business} went. Read the transcript on the Phone calls page. | D5 `unclear`, unknown outcome |
| `lost` | Murage lost track of {bot}'s call to {business}. Check the Phone calls page. | 5.6 stop rule |

The mapping is total. An outcome outside the table maps to `unclear`, never to `booked` (W8).

### 6.2 Primer line

`phoneCalls.handoff.notHere`: "Phone calls on a hand-off need the owner's own request, one step away. Ask the owner to ask me
directly." It is shown on a hand-off turn that fails 5.2 only for authority reasons, when the bot, key and engine would otherwise
mount. Otherwise the primer line is null, as D5 has it.

## 7. Witnesses (RED first on the builder's base; each has a mutant that must turn it RED)

All witnesses use the real `runTurn` mount, the real `/api/internal/phone/*` route, the real `handoff-dispatch` start, and the D5 loopback
fake Vapi (`startFakeVapi`, C0). None uses a hand-supplied ticket or a synthetic `startTurn` (the r7.3 T-P1 rule). No real call is made.

| row | case | pass condition | mutant |
|---|---|---|---|
| W1 | owner-rooted depth-1 attended hand-off books | Sable's owner turn delegates; Ember's turn lists the phone tools; one vendor create; the row has `handoff_id`, `report='owed'`; after the fake ends `done` with a sentinel reference, Sable's chat has exactly one `booked` line with the time | delegated predicate removed (only direct turns mount) |
| W2 | not admitted: matrix | each of: `owner_rooted=0`; origin room, shared, legacy; depth 2; peer ask (`askBotAndWait`, no `delegationRun`); unattended (routine sender); `chainNotOwner`; dialling bot switched off; project card; root owner surface false; hand-off row missing at mount. Each gives no tools listed, no record, POST `not_set_up`, 0 vendor requests. The builder records which cases are already RED at base (a delegate turn mounts through `directOwnerAudience` alone) | one mutant per check, each killed by its own fixture |
| W3 | hand-off ends mid-turn | the hand-off's row is removed (receipt) or Stopped after mount; the next `phone_call_place` from the same generation gets `not_set_up`, 0 creates; `phone_call_result` for an already placed call still answers | `handoffLiveNow` dropped from F-CALL |
| W4 | late fence | barrier: Stop confirms after F-CALL passed but before the intent insert; 0 rows, 0 creates | F-PLACE recheck dropped |
| W5 | one request, one call across retries | the first attempt places, then the hand-off is redispatched (process killed and restarted; then a memory-refusal rebuild) and repeats the identical request; vendor creates total 1; the second answer is the stored `engineResult` | `intent = userMessage.id` (or the generation) for delegated turns |
| W6 | report keeps owner data | the sentinel reference and transcript are absent from Sable's chat rows, Sable's next engine stdin capture, the delegation receipt and Ember's tool result | report builder reads `row.reference` |
| W7 | report exactly once across crashes | (a) kill after the terminal write, before append; (b) kill after append, before `report='written'`; restart each: exactly one line, id = stable id | (a) start sweep removed; (b) random id instead of the stable id |
| W8 | every terminal writer reports, truthfully | drive `result`, owner refresh, owner `cancel`, `reconcileAbandoned` (confirmed and not_found), bot Archive fence, late-analysis `settle`; and each outcome of 6.1 including an unknown one; each gives one line with the mapped key; none gives `booked` unless `done` with a reference | (a) hook only in `result`; (b) default branch maps to `booked` |
| W9 | deleted source, deleted row | source thread deleted before terminal: no line, `report='dropped'`, the thread is not recreated; owner deletes the call row while OWED: no line | `ownerDeletedThread` check dropped |
| W10 | follow-up finds the end and stays bounded | Ember's turn ends while the call is `scheduled`; nobody calls `result`; the fake moves to ended `done`; the pass writes the line within its first due; then stores with 10 and 10,000 past rows plus 3 OWED: rows read per pass equal and at most 8 | (a) pass not armed by the OWED insert; (b) full-table read |
| W11 | stop rule | the fake never ends a live call: after 12 misses (fake clock), exactly one `lost` line; a later `done` writes nothing more | stop rule removed (the pass runs for ever) or a second line on the late end |
| W12 | Ask card unchanged | No limits off: the D5 card appears on Ember's turn and a denial gives 0 creates and `report` never written; No limits on: no card, one create | delegated turns skip the card when No limits is off |

New test files are listed in `ci/gate-tests.txt` in the same push. W1, W2, W5, W7 and W8 are gate rows. The DELEG reviewer signs
W1, W2 and W5 (end-to-end owner chain), as r7.3/scope-deleg-r section 15 requires of D6a ("an isolated nonbillable action and real
result return").

## 8. Fail-closed defaults (one line each)

- Any unreadable or missing hand-off row, generation record or flag: no mount and no call.
- A call with a hand-off but no report thread cannot exist (one INSERT).
- An unknown outcome is reported as `unclear`. A call Murage cannot follow is reported as `lost`. It is never reported as booked.
- A deleted source conversation gets no line, and it is not recreated.
- A restart revokes every pre-restart phone authority. Only a new mount, on a still-started hand-off, can place a call.
- A hand-off that cannot phone hears the primer line (6.2). The model is not left to guess.

## 9. Dependencies and order

C0 lands (its two Astra Highs fixed), then F1 (admission, `intent`, `botMayPhone`), F2 (store), F3 (terminal write, `settle`), then the
D6a seat. D6a's `index.ts` edit is inside F1's phone hunk only. If F1 is not merged when D6a starts, the D6a seat rebases onto it and
never forks it.

## 10. GAP-CHECK (one adversarial pass, GAP-CHECK-BAR.txt)

### Fixed
- (d) money: a hand-off redispatched after a crash or a refusal rebuild gets a new prompt row and generation. Under D5's
  `intent = userMessage.id`, the identical booking could be placed and billed twice. Fixed by 5.5 (intent = hand-off id), W5.
- (b) failure path: Ember's turn ends while the call is still scheduled, and the owner never opens the Phone calls page. D5 has no
  timer, so the result is never read and Sable's chat never hears back. Fixed by 5.6 (owned follow-up pass, bounded, with a stop
  rule and a `lost` line), W10, W11.
- (b) failure path: the process dies after the call ended but before the report line. The line would be lost, or duplicated on
  replay. Fixed by OWED written in the intent INSERT, a stable message id and the start sweep, W7.
- (d) authority: a routine delegates to Ember, and the hand-off turn passes `directOwnerAudience` through its chain root. At base
  Ember could phone, which would launder Q-P6 (owner routines refused). Fixed by `attended === true` in 5.2, W2 (unattended).
- (d) authority: a peer ask or a depth-2 chain reaches a bot whose turn is owner-audience. At base `phoneMount` checks no depth.
  Fixed by `commsDepth === 1` and `handoffTurn` in 5.2, W2.
- (d) authority: the owner Stops the hand-off while Ember waits on the Ask card. At base the record still admits the place. Fixed by
  F-CALL and F-PLACE, W3, W4.
- (d) data: the report quoting the booking reference into Sable's chat would put it in every later Sable engine context. Fixed by
  F-DATA (6.1 has no reference field), W6.
- (a) purpose gap: the report could fan out through every terminal writer (cancel, Archive, late analysis), with lines missing or
  doubled. Fixed by one `reportCall` behind F3's single terminal write, W8.
- (e) cheap enhancement: a hand-off that cannot phone used to stay silent, so the delegate guessed. Fixed by one primer line (6.2).

### Parked (for Sean / MAIN; one line each)
- Owner Stop on a hand-off after the call was placed does not cancel the call (parity with a direct turn). Q1 in QUESTIONS.md.
- Phone ask-intent ("ask Sable from the paired phone") cannot phone through a hand-off until D8's owner proof lands. That is the r7.3
  section 2 ruling, not a new choice.
- D6b adopting `handoff-authority.ts` for delegated email's `handoffLive`/`ownerRooted` hooks: D6b's lane decides. Out of scope here.
- Waking Sable to restate the result in its own words: a new behaviour. The status line already reports truthfully (D4).
- Two different bots booking the same table from two separate owner requests: D5 identity is per bot by design. That is not a hand-off
  gap.
- Sable's own per-bot phone switch does not gate Ember's call. U2's "only a bot the owner allows" names the dialling bot, and the
  Ask card still applies. Rejected as a finding: no broken promise.
- Ember's reply and the report line may both state the outcome when the call ends inside Ember's turn. Accepted: the status line is
  the truth line (U4), and suppressing it would need a cross-database race rule. Over 20% of the design.
