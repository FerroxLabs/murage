# Delegated replies read "Reply withheld: it used something you deleted or changed" (1.0.2, 1.0.3 Critical)

Branch fix/103-reply-withheld, base fix/103-lineage-final ecef9150e. Written 2026-10-19.

## Root cause

1. A delegated reply leaves the worker through `releaseStoredResult` (server/result-egress.ts). Its write-time step asks
   `linesShown` -> `writetimeLinesShown` -> `denyLookup`, and `writetimeLinesShown` answers `every(state === "shown")`. deny-read.ts has
   three states: shown, withheld (a real mark: tombstone, own flag, deny-line, deny-range, watermark, footprint, thread-deny) and
   checking (an unknown: pending revoke window, thread-not-ready, no-lineage, lookup-error, footprint-wide). The gate collapses checking into
   withheld, and server/index.ts supplies the one fixed line `[Reply withheld: it used something you deleted or changed]`.
2. Every root revoke commit (a line, a thread, a bot, a memory object, a receipt, a session) writes an install-wide pending row
   (`markPending(tx, R, PENDING_ALL_THREADS, rootLsn)`, revoke-commit.ts) that stays until the marker has walked that revoke. Policy and
   epoch roots write no pending row (commitRevoke returns after setting the watermark); the receipt flips they cause do: every policy bump
   (`revokeAllDisclosures`: creating a bot, a new team, changing a bot's permissions, "talk to everyone", settings) flips receipts to
   revoked, and the marker drains those flips into an audience bulk revoke (revoke-commit.ts drainFlipsIntoBulk) whose roots each write a
   '*' row. The marker yields while any turn is live (memory-revocation.ts `busy`, REVOCATION_MAX_YIELD_MS 10 s, then budgeted slices),
   which is exactly the state during a delegation. Before 1.0.3 rw-cap the pending check had no cap: a reply generated after the row
   (lsn >= since) read `checking("pending")` when the leader's finalizer released it, whenever its turn began. On Sean's data the upgrade
   leaves 4 to 8 '*' rows for about 3 h of drain, so every delegated reply was held for hours.
3. `runFinalizeDelegationWatch` (handoff-boundary.ts) writes the gate's first answer durably: the leader's row `dres-<id>` and the receipt
   both get the withheld line, the copy link is dropped, and nothing ever judges the reply again. A transient unknown becomes permanent.

Fresh installs versus Sean's: a fresh user creates the team (policy bump) and delegates right away, inside the open window; Lee_J's
permission change opened a new window each time. Sean's roster is stable, so no window is open when his teams talk. The same code is on
int/1.0.3: commit d49b9b7b9 exempted the owner's own chat from the policy *watermark* only; the pending window still applies, and the
revoke-storm work made the marker yield to live turns more, not less. fix/103-lineage-final adds `doorShown` to the same gate with the same
`verdictShows` (state === "shown"), so it keeps the defect. The strict anchor rule (murageAnchor, rules 23 and 24) judges memory sources and
records on memoryLookup and receipt paths; the delegated reply's line verdict (lookupPage) never consults it. It is not the cause and it does
not need to change for this fix.

"no-lineage" on a fresh reply: a generated row gets no memory_line_lineage row only when its copyOf names more than COPY_ORIGINS originals
(deliberate), when the line write's savepoint failed (disk full or busy, warned), or when a pre-v10 build wrote it. writeMessage requires the
token in the same transaction, so a reply written by 1.0.2 or 1.0.3 has its row; the repro test asserts it. No-lineage is not the trigger here;
the contract still classes it as checking, and the hold covers the failed-write case.

An upgraded install hits the same defect during "Checking earlier memory": until memory_lineage_cert is ready every generated line reads
checking("thread-not-ready"), so every delegated reply in that window would be frozen as "deleted or changed". The contract covers it.

## Contract

C1. The gate tells shown, withheld and checking apart. `ReleasedResult` gains `{ kind: "checking"; line; held? }`. Only a verdict of
    withheld (a real mark on the walk: a deleted or forgotten source, a flagged row, a deny mark, the watermark, a footprint the reader lacks,
    a copy whose original is withheld, a partition refusal) produces the "deleted or changed" line. Every checking reason (pending,
    thread-not-ready, no-lineage, lookup-error, footprint-wide, a walked row flagged `withheldFromBots: "checking"`, an unproven captured
    verdict) produces checking. withheld beats checking beats shown. `linesShown` and `doorShown` return the verdict state, not a boolean.
    checking: pending holds a generated line only when its turn began before the revoke's commit, the cap the marker's ranges and session
    stage use; a line of a later turn is outside the window. In deny-read.ts terms: a pending row holds a line when since <= lsn and
    coalesce(turn_lsn, 0) < the job's started_lsn. A bulk still seeding, a row with no job, a hold written after the commit (an inherit
    hold for a derived post-commit line, since past the cap) and a receipt flip not yet drained have no cap. activateBulkRevoke moves a
    bulk's started_lsn to a slot of its own, taken in the transaction that opens, fills and activates a flip drain's bulk. A line with no
    turn_lsn stays held; a line written over a merged turn takes the lowest turn lsn. The cap applies to '*' rows and to thread flow and
    inherit rows alike, with no owner-chat exemption.
C2. A checking result is never written as withheld. Nothing of the reply reaches a bot while it is checking: bots read
    `[Reply left out until earlier memory is checked]` (ROOM_REPLY_CHECKING, already the room's line for this state).
C3. Hold (owner audience): the delegation finalizer and the shared-work delivery write the reply row into the source conversation with its
    words and copy link, flagged `withheldFromBots: "checking"`, under the stable id (`dres-<id>`). The owner reads the words with the
    existing note "Bots will see this reply once earlier memory is checked"; the leader's turn reads the checking line (external delivery,
    replay and the door already render that flag). The receipt keeps the words, the copy link and `held: true`. A hold row
    (`delegation_holds`: handoff id, source thread, message id, worker, request, since, last judged) keeps it durable across restarts.
    Not-owner audience: no words are written anywhere, the checking line is the result (as the withheld path does today), no hold.
C4. Settle: held rows are judged again through the same gate when the marker finishes a revoke, when the certificate becomes ready, when a
    thread's lineage warms, at boot, and by a sweep every 30 s while any hold exists; at most 256 rows a pass, each row at most once per
    30 s. shown: the flag clears, the receipt's held mark goes, the delegating bot is woken as a reply arrival wakes it
    (markTaskContextExternallyUpdated / unread, the same ports the finalizer uses) so the words reach its next turn. withheld: the flag
    becomes true (or "forgotten"), the receipt's result becomes the withheld line, the copy link stays for the owner. checking: it stays
    held. A hold that never settles never hangs anything: the leader's turn is never blocked, it reads the checking line and goes on; the
    words never reach a bot; the owner sees them with the note. After HOLD_STALE_MS (24 h) the owner's note says the check did not finish.
C5. Recovery: a one-time boot slice (resumable by meta key) finds frozen rows: `dres-` rows whose text is the fixed withheld line, from a
    done receipt or on their own. The worker's prompt row is `dlg-<handoff id>` (handoff-stamp.ts); it is sought in the worker's threads,
    and the turn's own replies after it (bot text, not a copy, up to the next owner row) are judged again through the gate as the owner's
    audience. shown: the row gets the words and copy link, the receipt follows, the conversation is marked unread. checking: the row is held
    (C3). withheld or worker rows gone: the row is left as it is. The worker's words are still stored in 1.0.2 (the finalizer dropped only the
    copy link), so recovery is expected to restore them; a deleted worker conversation is the case where they are not kept.
C6. wait_delegation / check_delegation on a held receipt returns status done with the checking line, never "withheld"; ask_bot returning
    inside a live turn returns the checking line and its mirror row in the asker's conversation is held (C3).

## State x event list (one test each)

| # | State | Event | Expected |
|---|---|---|---|
| S0 | fresh reply, lineage live, no marks | finalize | shown, words in the leader's row, copy link kept |
| S1 | a revoke committed while the workers are mid-turn (their prompts built first), marker not yet run | finalize two replies | both held: owner row has words + "checking", bots read the checking line; marker drains; settle; both shown; leader woken |
| S1b | a revoke committed before the worker's prompt is built (an upgrade's receipt flips, a roster, permission or settings change), marker not yet run | finalize | the reply's turn began after the commit: outside the window, shown at finalize with no hold; words and copy link in the leader's row |
| S2 | pending revoke that, drained, marks the reply (the reply used the revoked line) | finalize, then drain | held, then withheld: "deleted or changed", receipt result withheld |
| S3 | the reply's source forgotten or deleted before release | finalize | withheld at once (existing test stays green) |
| S4 | certificate not ready (upgrade running) | finalize, cert ready | held, then shown |
| S5 | reply with no lineage row (copy past COPY_ORIGINS) | finalize, sweeps | held, never "deleted"; owner note; sweep cost bounded |
| S6 | not-owner audience, checking | finalize | checking line, no words written, no hold row |
| S7 | deny tables unreadable (lookup-error) | finalize | held |
| S8 | held, process restarts | boot | hold row re-judged, settles as S1 |
| S9 | held receipt | wait_delegation / check_delegation | done + checking line, never withheld |
| S10 | 1.0.2 frozen dres- row, worker reply still stored and now shown | boot recovery | words restored, copy link set, unread |
| S11 | 1.0.2 frozen dres- row, worker conversation deleted | boot recovery | left as is, counted |
| S12 | walked node flagged withheldFromBots "checking" | release | checking, not withheld |
| S13 | door (lineage-final doorShown) verdict checking | release | checking, not withheld |
| S14 | held row, 24 h with no settle | sweep | still held, owner note says the check did not finish, no leak, no "deleted" |
| S15 | ask_bot inside a live turn, checking | ask | checking line returned, mirror row held, settles later |
| S16 | process dies after the hold row and the held reply committed, before any settle | boot | the hold row and the flagged row are one transaction with the receipt (finishHandoff); boot settles it (S8); a receipt that reached disk without the commit replays the held reply (handoff-reply.ts recovery) as held, never as shown |
| S17 | held, the owner presses Stop on the leader or the worker | stop | the hold is untouched (a hold is not a running turn); the leader's next turn still reads the checking line; settle still delivers |
| S18 | held, the worker bot is deleted (its conversations revoked) | settle | withheld (the originals are gone or denied): flag true, receipt withheld line; no words reach a bot; the hold row goes |
| S19 | held, the leader's conversation is deleted | settle | the hold row goes with nothing written (no source conversation); bounded |
| S20 | recovery on a database with 10,000 frozen rows | boot | runs in slices under the boot budget, resumable by meta cursor, each row judged once (idempotent: a restored or held row is never touched again) |
| S21 | recovery, frozen row in a not-owner conversation (a person's thread) or a receipt with notOwnerAudience | boot | nothing restored, nothing held: the row is left as it is |
| S22 | copy: every new line | review | no em dashes, none of the three words the house rules ban |

Hold durability: the hold row is written in the finalizer's transaction (finishHandoff), beside the receipt and the flagged reply row, so there
is no state in which one exists without the others. The settle runs through `store.patchMessage` and the receipt update in one transaction
per row. A hold row that names a row or a conversation that no longer exists is removed on its next judgement.

## Revision 2 (Astra design round 1, 11 items, all taken)

R1 (C1) Three states survive every check on the walk: `copyOriginWithheld`, `capturedMessageWithheld`, `partitionAllowed`, `linesShown`,
    `doorShown` may each answer a boolean (true/false as today) or a `LineVerdictState`; an unproven captured or copy-origin check, a
    partition check past its budget, a walk past its depth or node limit, and an exception anywhere in the walk read checking. Only a
    cycle and a real mark read withheld. index.ts wires `copyOriginVerdict` and `capturedMessageVerdict` (both carry `unproven`).
R2 (C2, C4) "checking" is never a stored verdict. The owner's note (`withheldFromBots`) holds final verdicts only: `true`, `"forgotten"`
    or none; `syncOwnerWithheldNotes` leaves a row's note as it was while the row's context is still being checked. "checking" is read
    live, from the open windows and unknowns (deny-read.ts), by every bot-facing reader. A row left flagged `"checking"` on disk (1.0.2,
    or a 1.0.3 process restarted before its revokes drained) is read as no note by every reader (deny-read, the chain judge, the result
    walk, search, the project page, the working context): the row is judged live on its own marks and windows, copies included, so a
    clean reply of the first minutes after an upgrade is never "being checked" for good (rehearsal 4, 1.0.3). A row of an earlier
    build's hold is retired or restored from its receipt at start (held-replies.ts, frozen-replies.ts), never judged from its flag.
R3 (C3, S16) Persistence protocol, in order: (1) the receipt with `held: { messageId, since }` and the owed reply `{ text, held: { copyOf } }`
    reaches the receipts file; (2) the row and the hand-off's settle commit in the database. Receipt on disk and no row: the owed reply is
    replayed as a held row (handoff-reply.ts) by the next settle. Row committed and no receipt (the file write failed): the boot recovery
    (C5) treats a `dres-` row flagged "checking" with a copy link as held and re-registers it. Held receipts are exempt from the count and
    age pruning (as owing receipts are) until settled or older than HELD_MAX_AGE_MS (24 h); a receipt past that is settled finally as
    checking: the row keeps its flag (no words reach a bot), its request completes with the checking line, and the owner's note says the
    check did not finish.
R4 (C4) What settle judges: the worker's originals (`receipt.copyOf`) for the recorded request, worker, source conversation and the owner
    audience, through `releaseStoredResult`; the held mirror row is never on the walk. Outcomes: text = shown (flag cleared); withheld =
    flag true; gone = flag true and the receipt's result "result_unavailable"; refused = flag true and the receipt's result the refusal
    line; checking = stays held. The owner keeps the words in every outcome (they are the owner's own data); bots read the line.
R5 (C4) Delivery after settle is the same as a reply arrival: a direct hand-off marks the task's external update and the bot unread; a room
    hand-off's request is NOT completed at finalize while held (the asker's wait reads the receipt: done, checking line) and is completed
    at settle (`completeRoomAsk` + `afterRoomCompletion`, the wakes follow the commit). The settle writes the row's flag and the receipt
    in that order; a crash between them leaves the receipt held, so the next pass judges again (idempotent) and notifies then.
R6 (C5) Frozen rows are matched by shape: a `dres-` row with no copy link whose words are the delegated-reply wrapper ending in the fixed
    withheld line (a 1.0.2 plain row) or whose kept status is `replied_to_task` with the fixed line as its reply (a 1.0.3 row).
R7 (C5) Provenance is proven or the row is left alone: the worker is the row's `from.botId`; the hand-off's prompt row `dlg-<id>` must be
    stored in one of that bot's conversations; the first bot text row after it must carry a `turnId`, and the originals are
    `turnReplyOriginals(thread, turnId)` (the turn's own replies through the line index, no branch or boundary crossing). The destination
    must be the owner's own conversation (`isWorkspaceOwner(threadHumanPrincipal)`), with no receipt marked notOwnerAudience.
R8 (C5) Classification stays sticky: a frozen Murage-voice row is never rewritten into a bot row. Recovery appends the worker's row beside
    it under the stable id `dres-<id>-restored` (role bot, from the worker, copyOf, the wrapper words), flagged "checking" when the gate
    reads checking (then held, R3). The frozen row stays. A restored row that exists already means the frozen row is done (idempotent).
R9 (C3, C6) Durable identities: a direct or room hand-off holds under its hand-off id (receipt id = task id, row `dres-<id>`); a shared
    delivery holds under its request id (receipt id = request id, the terminal row written by runDeliverSharedResult); a synchronous
    ask_bot inside a live turn is consumed by that turn, so it gets the checking line and the pair-room mirror is the checking line,
    with no hold (S15 revised: nothing durable to settle later).
R10 (C1, C6) Every gate consumer names its checking behaviour: wait/check_delegation and a continuation wake answer the checking line;
    a stored answer replay answers the checking line; a card result writes the room's checking status line under the card's stable line id
    (no mirror, no summary) and is judged again on the executor's next attempt; a card note and a quoted activity row are left out (as
    withheld is today); an ask answers the checking line.
R11 (C4) Fair selection: held receipts are judged least-recently-judged first (never judged before any judged), at most 256 a pass, none
    twice within 30 s; a permanently checking row cannot occupy a pass ahead of a newer one.

Extra cases: S23 shared delivery (runDeliverSharedResult) holds and settles like S1; S24 a held row with no receipt (file write lost) is
re-registered by the boot recovery; S25 a held room hand-off completes its request only at settle, and the asker's wait meanwhile reads
done + checking line; S26 exception inside the walk reads checking, a cycle reads withheld.

## Delta round (Astra delta BLOCK on e74afc653, 2026-10-20)

Fixed: High 1, a bulk a pre-1.0.3 build activated keeps its opening slot as its cap; every open raises it to the highest end of its own range
rows (schema.ts repairBulkRevokeCaps), the shape activateBulkRevoke gives a 1.0.3 bulk, so the window and the walk share one cap. High 2, the
carried-range pending lookup reads every matching window (no row limit). Medium 5 and Medium 6, an unknown lineage, text with no original and a
copy chain whose proof is still being built read checking (C1 as written; C4 covers a hold that never settles). Medium 9, a turn lsn of 0 is kept.
Found in this round: the reader door (ownFlag false) skipped a row's own "checking" flag; deny-read.ts now holds such a row for every reader (R2).
Astra re-check: the repair keys on a range row above the cap, not on root_lsn (a root added to a bulk lowers it); the door's chain judge
reports a chain that failed only on a checking source, so a copy of a held row reads checking at the door and at the gate (C1, C4).

## Follow-ups (not in 1.0.3)

- High 3 (handoff-boundary.ts:343): a shared delivery whose pair-room write throws after the held row commits leaves the row held with no settle obligation; the retry writes a non-held receipt.
- Medium 4 (result-egress.ts:225): a copy-walk limit or read error on a shared delivery (no recorded text) returns checking with no hold, so its words are never restored to the owner.
- Medium 7 (frozen-replies.ts:179): recovery does not copy the request identity onto the restored row, so a lost receipt cannot rebuild shared-request authorization.
- Medium 8 (frozen-replies.ts:168): settleHeldReceipt ignores a failed receipts write; recovery still appends the restored row and advances its cursor.
- Item 10 (deny-read.ts:572,525): prefix and session verdicts stay uncapped by choice; a fresh session and the line-based prompt are the escape paths.


## Revision 3b: activation inside the v10 to v11 step (replaces Revisions 3 and 3a and the cap repair of the delta round)

History. The delta round derived a 1.0.2 bulk's cap from its range rows (schema.ts repairBulkRevokeCaps) and missed caps that live only
in a cursor or a coalesced -1 row. Revision 3 activated each legacy bulk once and marked it (`"cap":1`); Astra blocked it
(lanes/codex-jobs/astra-103-rw-legacy-design/REPORT.md, High 1): the mark survives a downgrade to v10, 1.0.2 folds an inherit hold into an
older row of the same revoke (e66f707e1 revoke-marker.ts:99, by revoke id, no side), and the re-upgrade skipped the marked bulk.
Revision 3a moved the activation into the v10 to v11 schema step and clamped flow rows to the cap; Astra blocked it
(lanes/codex-jobs/astra-103-rw-legacy-design-3a/REPORT.md): High 1, the flow clamp is unsound for a patched routine card; High 2, a file an
earlier 1.0.3 build already moved to v12; Medium 3 to 5 and Low 6, wording, tests and cost. Revision 3b keeps 3a's step, drops the clamp,
states the scope that makes High 2 unreachable, and fixes the wording, tests and cost.

Scope assumption (release fact, coordinator, checked 2026-10-20 04:33 +07). No 1.0.3 build has ever been released: FerroxLabs/murage-releases
has 1.0.2 as latest and no 1.0.3 release or draft. RC builds ran only on disposable test copies; Sean's live install runs 1.0.2. So every
memory file a customer holds is at v10 or below, and the first 1.0.3 build that opens it is the one with this step. A v12 file made by an
earlier 1.0.3 build (53d2336b0 or any RC) is out of scope: 3a High 2 has no reachable path under this assumption. Operator repair for such a
file (a test copy): `murage memory-downgrade --data-dir <dir> --to 10`, then start this build; the reopen is a v10 to v12 open and runs the
step below.

State. No new state: no mark, no flag. repairBulkRevokeCaps and its two call sites (the current-version open, schema.ts:2482, and the end
of every upgrade, schema.ts:2625) go. A new step, schema.ts activateRevokesAtUpgrade, runs inside migrateMemorySchema's `exists && from <
11` block (schema.ts:2611), in the migration's single transaction (BEGIN IMMEDIATE schema.ts:2506 to COMMIT schema.ts:2640), after the
meta-table rebuild (DOOR_EPOCH_UP_COPY, schema.ts:2529, which brings memory_lineage_lsn_meta and its deny_generation row over) and before
the structural validation. 1.0.2 writes v10 and opens formats 1 to 10 (e66f707e1 schema.ts:1760); a downgrade below 10 drops the writetime
tables with every job (schema.ts:2739), so the only file that carries jobs back is a v10 one; so every file
1.0.2 has written to since its last 1.0.3 open reaches 1.0.3 through this step (boot database.ts:332, restore and import preparation
installation-restore-preparation.ts:320, merge restore.ts:187): the first upgrade from 1.0.2 and every re-upgrade after a
round trip. A current-version open (from = 12) and the v11 to v12 step (from = 11, a development file 1.0.2 cannot open) never run it.

The step:
1. Probe: `SELECT 1 FROM memory_revoke_jobs WHERE state='active' LIMIT 1` (only when the table exists). Nothing found: nothing is written
   and no slot is taken.
2. S = takeCommitLsn(tx) (lineage-write.ts:188, `UPDATE memory_lsn SET next=next+1 RETURNING next-1`); after it memory_lsn.next = S + 1.
3. `UPDATE memory_revoke_jobs SET started_lsn=S WHERE state='active'`.
4. deny_generation + 1 (a verdict cached against an old cap is not reused, deny-read.ts denyGeneration).

Scope of the step: every job in state 'active', of every kind (bulk, line, thread, bot, memory, scope, receipt, session, inherit), not only
bulks. Astra's fold path needs only an active job, a pending row of it older than a 1.0.2 write, and a 1.0.2 inherit hold folded beneath
that row; 1.0.2 folds by revoke id whatever the kind, and any job's walk can mark a carry child of any turn (revoke-marker.ts carryChild).
Left alone: 'seeding' (no cap, read fail closed, deny-read.ts:105; 1.0.3's U2 resumes it and activateBulkRevoke takes its own slot above
every root), 'undoing' (its cap is still read by pendingWindows, deny-read.ts:102, but undo deletes every mark of its id,
revoke-marker.ts:518, and inheritMarks skips it, revoke-commit.ts:440, so no line is marked under it), 'done' and 'undone' (no pending rows: tidyStep deletes them;
a later reopen is covered below).

Invariant I. When the step commits, with S the slot it took (memory_lsn.next read at the end of the step is S + 1), for every job J in state
'active': (i) started_lsn(J) = S, and every lsn position stored in the file is at most S (the UNKNOWN_LSN sentinels,
lineage-write.ts:263,627, are not positions and are excepted): every pending since, every line lsn and turn lsn, every
range end, every cursor `c.until`, every session first_lsn and last_lsn; every allocated line lsn is below S; (ii) every cap the walk of J
uses from here on is at most S; (iii) every line the walk of J can mark that was stored before the step reads checking from the commit of
the step until it is marked or J finishes.

Proof sketch.
- (i) The counter only grows. Every lsn a build allocates is below the counter after the allocation; a value a build stores without
  allocating is at most the counter at that write: 1.0.2 stores `currentLsn` (the counter, not reserved) as a range end
  (e66f707e1 revoke-commit.ts:91, revoke-marker.ts:260), so a range end can equal the counter and so equal S. A root's `until ?? now` is
  currentLsn (1.0.2) or a taken slot (1.0.3); a forget bound is a stored turn lsn + 1; a coalesced -1 row is the max of rows already
  written (revoke-marker.ts:142); a cursor's `c.until` is the range end it was written with; a pending since is a root lsn, a line lsn or a
  taken slot; a turn lsn is the head its prompt was built on, below its line. 1.0.2's writes in a round trip all happened before this
  open, and S is the counter's value when the step runs. So every stored value is at most S and every allocated line is below S; step 3
  makes started_lsn(J) = S.
- (iii), lines stored before the step. pendingWindows (deny-read.ts:105) caps a row at started_lsn when since <= started_lsn, else reads it
  uncapped. Every pending row of J has since <= S, so each is capped at S, and every stored line has turn lsn < S (a line with no turn lsn
  counts from 0). So every stored line at or after a row's since reads checking under it: the same set 1.0.2's uncapped read held. Nothing
  1.0.2 held is released by the re-upgrade, whatever 1.0.2 folded: Astra's copy is held by the very row its hold was folded into. This is
  bounded by PENDING_READ_LIMIT (known limit 2 below), where the read is wider, never narrower.
- Lines written after the step. The step runs at open, before any read or turn (database.ts:332 at boot, restore.ts:187,
  installation-restore-preparation.ts:320 all migrate first). A prompt built after it has a head at or above S (lineage-write.ts:475), so its lines
  have turn lsn >= S and are outside every capped window of J (a window holds turn lsn < cap). The walk of J marks a line of a turn after S only as a carry child: its ranges end at
  S or below and mark only lines of turns before the end (deny-read.ts range rule), its session stage caps at `c.until` or S, and its line
  roots are lines stored before their commits. A carry child written after the step is written by 1.0.3, whose coverage rule for a job is
  the one Astra accepted for 1.0.3 jobs (C1, rw-cap): inheritMarks (revoke-commit.ts:400-450) finds its parent under a window of J and
  writes a hold on the after side of markPending, never folded into a capped row, read with no cap; and the flow rows, which this revision
  no longer clamps, are read as 1.0.3 reads them today. The step puts every job active at the open into the shape of a 1.0.3 job committed
  at S; it changes no rule for lines written after it.
- Walk caps (ii). From the step, rangeNode writes until = min(currentLsn, max(S, rootCap)) (revoke-marker.ts:272), and a root's bound row
  ends at or below S, so until <= S; a cursor resumed after the open keeps `c.until` <= S; the session stage uses `c.until` or
  min(currentLsn, S) (revoke-marker.ts:328); a bounded line root keeps its `until` <= S.
- 1.0.2's session stage. 1.0.2 marks a session of a reached thread when `last_lsn > a`, with no bound on the session's start
  (e66f707e1 revoke-marker.ts:309); 1.0.3's stage tests `last_lsn >= a` (revoke-marker.ts:329). A session begun after J's old cap, while
  1.0.2 ran, can hold a durable session mark of J. The mark stays (a session reset: more held, never less). I does not depend on these
  marks, and no claim is made that the two stages mark the same set.
- Repeated round trips. Each v10 to v12 open takes a fresh S above everything every build stored before it. A 1.0.3 job that survived a
  round trip is moved again: its cap only moves later.
- A file that never left v12 after the step. Its opens are current-version opens: no step, no slot, no started_lsn or generation change.
  Its jobs keep the caps 1.0.3 gave them (this step's slot, commitRevoke's own slot, activateBulkRevoke's slot, an inherit slot).
- A reopen. A done job reopened by inheritMarks after the step has no pending rows from before; its new holds are at lines written after
  the step, read with no cap. A done job reopened by 1.0.2 during a round trip is 'active' at the next step and moves.

Flow rows (3a finding b, dropped). Revision 3a clamped a thread node's flow row to started_lsn(J). Astra showed it unsound: a routine
card patched after the step keeps its lsn L and turn but takes its hold at the inherit slot F > L (lineage-write.ts:346,364;
revoke-commit.ts:412-421,446), so the flow row at L (flowStep seeds max(edge.first_lsn, item.since), revoke-marker.ts:198, and the patch's
flow edge uses L, lineage-write.ts:297,364) is its only hold; a clamp makes that row capped and the card reads shown while the walk can mark
it. Revision 3b changes nothing in flowStep: a flow row above started_lsn stays uncapped, exactly as today.

Known limits (stated costs, not defects of this revision).
1. A thread holding a row of J above started_lsn(J) is read with no cap: a flow row from an edge made after the step (or after a 1.0.3
   commit), and an inherit hold written for a derived post-commit line (revoke-commit.ts:446). The replies of every later turn in that
   thread, delegated replies and unrelated replies included, read checking until J's drain finishes and tidy removes the row.
2. More than PENDING_READ_LIMIT (256) pending rows on one thread (its own plus the `*` rows) collapse into one uncapped window from the
   lowest since (deny-read.ts:93,103): the same cost, replies of later turns in that thread read checking until the drain brings the
   count back to 256 or below.
Both hold more, never less; neither releases a line the walk can mark.

Failure cases.
- Crash mid-upgrade: the step is part of the migration's one transaction (schema version, slot, every started_lsn, the generation).
  Before COMMIT nothing is on disk and the next open is again a v10 open that repeats it; after COMMIT the file is v12 and no later open
  runs it.
- Round trip, Astra's path: active bulk B (cap c), its row on T at since t <= c; downgrade to v10; 1.0.2 writes a copy L in T (turn >= c)
  carrying a line B reaches; its hold is folded into T's row; re-upgrade: S > L, started_lsn(B) = S, T's row is capped at S, L (turn < S)
  reads checking until B's walk marks it or B finishes. Same for an ordinary revoke and an inherit job.
- Several round trips: each re-upgrade is a v10 open and repeats the step.
- Seeding bulks: untouched; their rows hold every line in their window until activateBulkRevoke (fail closed).
- Downgrade below v10: the writetime tables go with every job; the upgrade from there makes them empty and the probe finds nothing.
- A root added to an active bulk: no caller does it (the U2 seed adds roots only while its bulk seeds, lineage-backfill.ts:758; the flip
  drain opens, fills and activates its bulk in one transaction, revoke-commit.ts:486-489); not changed here.
- A v12 file from an earlier 1.0.3 build: out of scope (scope assumption); operator repair above.

Cost.
- The probe and the update: memory_revoke_jobs has no index on state, so both read the job table whole, once per v10 to v12 open, inside
  the upgrade transaction. The table holds unfinished jobs plus at most one finished row (pruneFinished keeps the highest-numbered
  finished row; a policy or epoch commit deletes finished rows below its own). The cost is linear in the jobs in flight at the downgrade;
  no absolute bound in time or bytes is claimed. The step writes the counter row, the generation row and one row per active job.
- Behaviour: the walk of a job active at the step writes ranges and session marks up to S, so a line of a turn begun between its old cap
  and the upgrade, in a thread the walk reaches, may be marked (bounded ranges, resumed cursors and threads already reached keep their
  narrower work, revoke-marker.ts:255,261,277), and a session begun in that span on a reached thread is reset (more held,
  never less). Replies of turns begun after the upgrade are not held by these jobs except through their own write-time holds and the two
  known limits above.

Tests. Red first: each of T1 to T7 fails on 53d2336b0 and passes after (where one case also pins existing behaviour, its red assertion
is named).
- T1 Astra's path through the real downgrade: a 1.0.3 data dir (database()), an active bulk B with a '*' row and a T row, downgrade with
  downgradeInstallationMemorySchema(DATA_DIR, 10) (the downgrade-102-data-dir.test.ts driver), then 1.0.2's writes on the v10 file: a copy
  line in T of a turn after B's cap, its hold folded by 1.0.2's markPending (frozen from e66f707e1 in the test); database() again:
  started_lsn(B) = memory_lsn.next - 1 read after the open, every stored lsn is <= started_lsn(B), and the copy reads checking("pending");
  a turn begun after the open reads shown.
- T2 the same round trip with an ordinary line revoke (commitRevoke with the runner stopped) and an inherit job: both move to S.
- T3 opens that run no step: a v12 file with an active bulk whose range row ends above its cap (the shape repairBulkRevokeCaps rewrote) is
  left as it is across two opens: memory_lsn.next, every started_lsn and deny_generation unchanged (red: 53d2336b0 raises the cap). Also
  pinned (guards, green on both): a v10 file with no active job takes no slot and no generation; a v11 development file is moved to v12
  with no slot taken.
- T4 a seeding bulk beside an active job: the step moves the active job (red) and leaves the seeding bulk's started_lsn and state as they
  were; its later activateBulkRevoke takes its own slot.
- T5 crash: the test wraps the handle's exec so that right after DOOR_EPOCH_UP_COPY runs (the meta-table rebuild) it installs a TEMP
  trigger on main.memory_lineage_lsn_meta that raises ABORT on the deny_generation bump; the upgrade throws, and the file is back at v10
  with every started_lsn, memory_lsn.next and deny_generation as they were (the trigger dies with the connection); the next open runs the
  step and commits (red: 53d2336b0 has no bump, so the upgrade commits). The fixture has
  no range row above any cap, so 53d2336b0's repair writes no generation bump that the trigger could catch.
- T6 the patched card after the step: a moved job J (round trip as T1), a line in T of a turn between J's old cap and S reads checking
  (red); then the shape a routine card patched after the step leaves (a line at L > S of a turn after S, and the patch's flow edge into T
  at first_lsn L, lineage-write.ts:297,364): J's flow phase seeds T's row at L, not clamped to S, read uncapped, and the card reads
  checking("pending").
- T7 the walk after the step: a fresh range of a moved job ends at S (no range end above S) and marks a line of a turn between the old cap
  and S in the reached thread (red); a session begun before S on that thread is reset and one begun at S is not; a turn begun after the
  open reads shown. (A resumed cursor keeps its stored `c.until`, at most S by I(i); not separately tested.)
- Gate, a real 1.0.2 round trip (scratchpad dg/gate.mjs, real 1.0.2 build in old/ and this branch in new/): 1.0.2 seeds, 1.0.3 migrates
  and writes, memory-downgrade --to 10, 1.0.2 opens and writes turns, 1.0.3 starts again; data complete, verdicts match, and every job
  active after the last open has started_lsn = (memory_lsn.next read at the end of that open's step) - 1 and every stored lsn at or below it.
