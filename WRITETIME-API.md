# WRITETIME-API: the S0 contract for the write-time privacy lane (Murage 1.0.2)

Design: `DESIGN-WRITETIME.md` (int102-gate). S0 fixes every name that slices S1 to S5 call across slice lines. A slice implements
only the bodies it owns and calls only the names below. Every stub fails closed:
- every lookup answers `{ state: "checking", reason: "not-built" }`, which means withheld;
- every write is a no-op that counts a call in `writetimeStubCalls()`.

Nothing in the app calls these stubs yet. Imports use the `.ts` suffix, as elsewhere in `server/`.

## Schema v10 (`server/memory/schema.ts`), S0 (done)

`MEMORY_SCHEMA_VERSION = 10`. `MEMORY_SCHEMA` is v10. `MEMORY_SCHEMA_V9` is the frozen RC text.

**Table names.** Every design table carries the `memory_` prefix, like every other memory object in `messages.db`. The validator,
the archive inspector, restore and the existing schema tests all recognise memory objects by that prefix.
`WRITETIME_TABLES` maps each design name to its real table name:

| Design name | Table | Notes |
|---|---|---|
| `memory_lsn` | `memory_lsn` | One row (`id=1`). `next` is the lsn the next object takes, starting at 1. |
| `memory_meta` keys | `memory_lineage_lsn_meta(key,value)` | Keys are `LINEAGE_META_KEYS`: `policy_bump_lsn`, `epoch_bump_lsn`, `deny_generation`, `lineage_upgrade_lsn`. All start at 0, except `lineage_upgrade_lsn`, which starts at 1. |
| `line_lineage` | `memory_line_lineage` | Unique index `memory_line_lineage_msg(thread_id,message_id)`. |
| `lineage_carry` | `memory_lineage_carry` | |
| `thread_flow` | `memory_thread_flow` | `from_thread` also takes `scope:<id>` (`scopeFlowNode`). |
| `line_capture` | `memory_line_capture` | |
| `session_lineage` | `memory_session_lineage` | |
| `scope_sets`, `scope_set_keys` | `memory_scope_sets`, `memory_scope_set_keys` | Set id 0 is `FOOTPRINT_STAR` (`*`) and never has a row. |
| `deny_line`, `deny_range`, `deny_session` | `memory_deny_line`, `memory_deny_range`, `memory_deny_session` | Each has a `_revoke` index on `revoke_id`. |
| `deny_memory` | `memory_deny_memory` | `version` is NOT NULL DEFAULT 0, and 0 means every version: a key column of a WITHOUT ROWID table cannot be NULL. `_revoke` index. |
| `deny_pending`, `deny_pending_scope` | `memory_deny_pending`, `memory_deny_pending_scope` | `thread_id '*'` = `PENDING_ALL_THREADS`. `_revoke` indexes. |
| `revoke_jobs`, `revoke_frontier`, `revoke_reached` | `memory_revoke_jobs`, `memory_revoke_frontier`, `memory_revoke_reached` | The frontier `node` is `encodeNode(FrontierNode)`. |
| `lineage_thread_ready` | `memory_lineage_thread_ready` | |
| `lineage_cert` | `memory_lineage_cert(id,phase,cursor,done,total,ready)` | A new file starts at `done`/ready 1. An upgraded file starts at `u1`/ready 0. |

**Upgrade step (v9, v6 or anything older to v10).** It creates every table empty inside the existing migration transaction, in
constant time, and seeds the counter, the meta keys and the certificate (`seedWritetime`).

**Validator.** The existing exact-text check now covers the v10 objects. It refuses a tampered, missing or extra index or trigger
with `MEMORY_SCHEMA_UNSUPPORTED`. It refuses a missing counter, meta key or certificate row with `INVALID_MEMORY_LINEAGE_META`.

**Downgrade from v10 to v9.** `downgradeMemorySchema(db, 9)` and the `memory-downgrade --to 9` command drop the v10 tables. While
any lineage row or mark exists, they refuse with `MEMORY_DOWNGRADE_LINEAGE_UNMARKED`, so nothing is shown that 1.0.2 withheld. S5
replaces that refusal with the sliced marking downgrade.

## Types (`server/memory/lineage-types.ts`), S0 (done)

**Brands.** These types carry a compile-time brand that only one module may create:
- `LineageToken {threadId, messageId, lsn}`: cast only in `lineage-write.ts`;
- `PromptPart {text, lineageOf}`: cast only in `prompt-parts.ts`;
- `BuiltPrompt {text, parts, denyGeneration}`: cast only in `prompt-parts.ts`;
- `ToolText {text, lineageOf}`: cast only in `prompt-parts.ts`.

**Keys and references:**
- `LineAuthor = "owner" | "person" | "generated"`;
- `LineKey {threadId, lsn}`;
- `SessionKey {threadId, driverInstance, nativeSession}`;
- `MemoryRef {kind: record|source|lesson|claim, id, version?, scopeId?}`, with `memoryRefKey(ref)`;
- `NoneReason`;
- `LineageRef`, one of these variants:
  - `line {threadId, messageId}`: a point carry;
  - `prefix {threadId, headLsn?}`;
  - `memory {ref}`;
  - `receipt {bundleId, lsn, scopeIds}`;
  - `none {reason}`.

**Carries and the marker queue:**
- `Carry`, `CarryKind`, `CarryChildKind`;
- `FrontierNode`: one of `line`, `range`, `record`, `source`, `receipt`, `session` or `scope`;
- `encodeNode(node): string` and `decodeNode(text): FrontierNode | null`. Both are pure and complete.
- `scopeFlowNode(scopeId)` and `PENDING_ALL_THREADS`.

**Revokes.** `RevokeRoot` is one of `line` (forget, hide, edit, delete, branch-switch, regenerate), `thread`, `bot`, `memory`,
`scope`, `receipt`, `session`, `policy` or `epoch`.

**Readers and verdicts:**
- `LineageReader {audience: null | {owner, scopeIds}}`;
- `LineageVerdict`: `shown`, `withheld {DenyReason}` or `checking {CheckingReason}`;
- `verdictShows(v)` and `worstVerdict(a, b)`.

**Pages and writes:**
- `PageLine {messageId, author, withheldFromBots?}` and `LinePage {threadId, lines}`;
- `LineInput {threadId, messageId, author}` and `LineageParents {turn?, refs?}`;
- `TurnLineage {threadId, turnId, turnLsn, parents, denyGeneration}`.

**Constants.** `FOOTPRINT_SCOPE_CAP` 32, `FOOTPRINT_STAR` 0, `COPY_HOPS` 8, `COPY_ORIGINS` 64, `DENY_RANGE_COALESCE` 64,
`MARKER_SLICE_MS` 8, `MARKER_SLICE_ROWS` 256 and `BACKFILL_SLICE_MS` 50.

**Stub tracking.** `noteWritetimeStub(name)` and `writetimeStubCalls()`. A count left after S5 means a stub is still live.

## Functions

Each section names the file and the slice that implements its bodies.

### Writers: `lineage-write.ts`, implemented by S1

**Live in S0:**
- `currentLsn(db): number`. It reads `memory_lsn.next` and is complete.

**Stubs:**
- `writeLineage(tx, line: LineInput, parents: LineageParents): LineageToken`
  - Writes the line's row, carries, flow edges and inherited marks in the writer's transaction. `writeMessage` (S1) requires the token.
  - Stub: lsn 0, no row, so the line reads checking.
  - Called by S1 (message-db, index.ts, room turns, copies, hand-off and ask results, evhand replays, imports, restore).
- `reserveLsns(tx, count): number`
  - Called by S5 (U1 lsn assignment).
- `internFootprint(tx, scopeIds): number`
  - Stub answers `FOOTPRINT_STAR`, the widest footprint.
  - Called by S1 and S5.
- `openTurnLineage(db, {threadId, turnId}): TurnLineage`
  - Called at prompt build, by S1 (index.ts) and S2 (room member prompts).
- `currentTurnLineage(threadId): TurnLineage | undefined`
  - Stub returns undefined. Outside any turn, nothing is recorded.
  - Called by S2 (tools: project `read_messages`, conversation reads, bring-in, memory tools) and S4 (bundle receipts).
- `closeTurnLineage(turn): void`
  - Called by S1.
- `addTurnParents(turn, refs: LineageRef[]): void`
  - Called by S2 (`buildPrompt`, tool handlers), S1 (steer quotes, which replace `addRootsToRunningTurn`) and S4 (recall receipts).
- `writeRecordLineage(tx, record: MemoryRef, turn): void`
  - Writes the prefix carry for notes, records, lessons, PIP claims and feedback.
  - Called by S2 (project-notes), S4 (lessons), S1 (PIP, feedback).
- `writeCaptureLineage(tx, {threadId, messageId}, sourceId): void`
  - Called by S3 (capture.ts).
- `writeSessionLineage(tx, session: SessionKey, turn): void`
  - Called by S1.

### Reads: `deny-read.ts`, implemented by S4

**Live in S0:**
- `denyGeneration(db): number`. It reads the meta key and returns -1 when the key is unreadable.
  - Called by S1 (`openTurnLineage`) and S4 (fence).

**Stubs (each answers checking):**
- `denyLookup(db, page: LinePage, reader): Map<messageId, LineageVerdict>`
  - The one read predicate.
  - Called by S2 (working-context, room-transcript, replay and owed lines, prompt builders), S4 (readable, disclosures, result-egress) and S1 (steer quote check).
- `memoryLookup(db, refs: MemoryRef[], reader): Map<memoryRefKey, LineageVerdict>`
  - Called by S4 (bundle, consolidate, lessons, msearch2 eligibility) and S2 (learned block, PIP identity).
- `sessionLookup(db, session, reader): LineageVerdict`
  - Not shown means the session resets.
  - Called by S4 (dispatch retained session).
- `refsLookup(db, refs: LineageRef[], reader): LineageVerdict`
  - Returns the worst verdict over the refs.
  - Called by S1 (steer under pending, refused with `MEMORY_CONTEXT_REVOKED`), S2 (tool texts) and S4.
- `fenceVerdict(db, built: BuiltPrompt, reader): LineageVerdict`
  - The send fence.
  - Called by S2 (driver submission and steer sends under `drivers/`) and S4 (dispatch).

### Revokes: `revoke-commit.ts`, implemented by S3

This file is an S0 addition, so that the revoke API has a single owner. S3 also owns `memory-revocation.ts`, where the marker
runs.

**Stubs:**
- `commitRevoke(tx, root: RevokeRoot): number`
  - Stub returns 0.
  - Called by S1 (`updateMessage`, `deleteMessage`, branch switch, regenerate), S3 (forget, revocation, capture), S4 (policy and epoch bumps through their owners) and the conversation and bot deletion paths.
- `undoRevoke(tx, revokeId): void`
  - Handles unhide.
  - Called by S3.
- `inheritMarks(tx, child: LineKey, refs: LineageRef[]): void`
  - Handles inheritance at write.
  - Called by S1 (`writeLineage`).

### Prompt parts: `prompt-parts.ts`, owned by S2

The constructors are already complete in S0: they only attach refs. S2 owns the file, the sink test and the driver types.
- `promptPart(text, lineageOf): PromptPart`
  - Called by S1 (index.ts prompt assembly) and S2.
- `toolText(text, lineageOf): ToolText`
  - Returned by every tool handler (S2).
- `buildPrompt(turn | undefined, parts, separator?): BuiltPrompt`
  - Adds every part's refs to the running turn through `addTurnParents`.
  - Called by S1 (index.ts, room turns) and S2.

### Upgrade: `lineage-backfill.ts`, implemented by S5

**Live in S0:**
- `lineageCertProgress(db): {phase, done, total, ready}`. It reads `memory_lineage_cert`.
  - Called by S5 (upgrade screen) and S1 (index.ts status).

**Stubs:**
- `lineageBackfillSlice(db, {budgetMs?, now?}): {more}`
  - Stub answers `{more: false}`, so no scheduler spins on it.
  - Called by S1 (index.ts wires it to the upgui recovery scheduler).
- `promoteLineageThread(threadId): void`
  - Moves the thread a turn arrives on to the front of the queue.
  - Called by S1.

S5 also owns the sliced v10 to v9 downgrade inside `downgradeMemorySchema` in `schema.ts`. That is the only part of `schema.ts`
S5 edits.

## Notes for slices

- **Ownership.** S1 owns the bodies in `lineage-write.ts`; S3 those in `revoke-commit.ts`; S4 those in `deny-read.ts`; S5 those in
  `lineage-backfill.ts`. S2 owns `prompt-parts.ts`. No slice edits `lineage-types.ts`. A needed type change goes back to S0 or the
  gate.
- **Record created lsn.** `deny_pending_scope since <= created lsn` needs a record's created lsn, which no v10 column holds. Until S3
  and S4 agree on where it lives, S4 treats it as unknown: under a pending scope the record reads checking.
- **`lineage_upgrade_lsn`.** It is seeded at 1. S5 decides how U1's lsns for old lines and the live writers' lsns interleave (risk
  7, lsn discipline), and moves this key if needed.

## Integration (S1 to S5 merged, storage audit folded in, 2026-10-12)

Changes to the contract above, made by the integrator:
- **Carries** (`lineage-types.ts`): one row per contiguous run of parent lines, `memory_lineage_carry(parent_thread_no, to_lsn, from_lsn,
  child_kind, child_ref, child_thread_no)`. Child kinds (codes): `line` 0 (child_ref = lsn), `turn` 1 (child_ref = turn_lsn: every line of
  the turn rests on it), `session` 2 (`driver\u0000native`), `record` 3 (`memoryRefKey`). Encode and decode only with `lineChildRef`,
  `turnChildRef`, `sessionChildRef`, `recordChildRef`, `decodeCarryChild`. Unknown positions: `UNKNOWN_LSN`; a prefix starts at `FIRST_LSN`.
- **Thread numbers** (`thread-no.ts`): `memory_thread_no`; line_lineage, carries, captures and receipt ranges key threads by number.
  `memory_line_lineage` has no `generated` column: a generated line is one with a `turn_lsn`.
- **MemoryRef kinds**: `note`, `card`, `summary`, `skill`, `file` besides record, source, lesson, claim (`MEMORY_REF_KINDS`).
- **Writers**: `writeObjectLineage(tx, ref, refs)` (an object written outside a turn), `noLineageToken`, `extendLineage`.
  `inheritMarks(tx, child: InheritChild, refs, ranges)`.
- **Revokes**: `commitRevoke(tx, root, { until?, inline? })` (inline: the marker runs within INLINE_REVOCATION right after the commit; U2
  passes false). Memory root cause `unprovable` (U2: a source captured from a line U1 could not prove; no watermark bump).
  `drainRevokeMarker(db)` (memory-revocation.ts) runs every revoke and bookkeeping job to its end.
- **Receipts** (`receipt-outputs.ts`, approved design): `memory_receipt_lines(bundle_id, thread_no, first_lsn, session_no)` and
  `memory_session_no`; `noteReceiptOutput`, `noteReceiptSession`, `receiptStart`. Every path that turns a receipt revoked is queued by the v10
  trigger `memory_receipt_flip` into `memory_receipt_flips` (readers: pending from its first output) and committed by the marker.
- **v10 triggers**: `memory_watermark_bump` (every policy or epoch bump moves the watermark), `memory_flow_*` (capture, evidence, derivation,
  bring-in, scope moves write their flow edges), `memory_receipt_flip`. `setScopeFlowEdgesRecorded(true)` at start (index.ts).
- **Engine input** (`contracts.ts`): `BuiltSendTurnInput`, `BuiltEngineInput`; `drivers/engine-input.ts` `fencedTurnInput`, `sendBuiltTurn`,
  `steerBuilt`, `builtEngineInput`, all fenced by `assertSendFence` (memory/send-fence.ts, re-exported by dispatch.ts; apart so drivers
  do not import the bundle and search modules). A "checking: pending" verdict first gets a bounded inline marker drain
  (`drainRevokeMarkerBounded`, SEND_FENCE_DRAIN); `buildMemoryBundle` drains first too (`drainMarkerForTurn`). A refusal reaches the turn's
  submission boundary (`EngineFence.onRefused`) so the turn is rebuilt once, after `settleRevokesForTurn` (bounded, yielding, up to 5 s).
- **Audience-only revokes**: a receipt whose state turned 'revoked' (cause `receipt-revoked`) binds audience readers only, as the RC
  judged it (`audience !== null && state === 'revoked'`): `memory_revoke_audience(revoke_id)` flags the revoke; content readers
  (`audience: null`: the owner's direct chat, rooms) and memory recall skip its marks and pending rows; its ranges coalesce apart (revoke
  `AUDIENCE_COALESCED` = -2). A receipt whose cited content is gone is cause `receipt-content` (every reader).
- **U2 bulk revokes**: every deny fact of a 1.0.1 file is a root of one of two bulk revokes (`openBulkRevoke`, `commitRevoke(..., { into })`,
  `activateBulkRevoke` when U2 drains): one walk, not one per fact.
- **Branch changes**: an edit's fork or a regenerate revokes the left head with `until` = the new branch's turn (the rerun's turn is
  admitted before the fork), and the marker's carry and capture reach in the root thread respects it.
- **Root sets**: never written (`ROOT_SETS_FROZEN`), never converted on upgrade; `root-set-reclaim.ts` drops them once certified and idle,
  armed by `setReadTimeJudgeRetired(true)` (S6). Meta key `root_sets_dropped`.

## S6 (retire the read-time judge, arm the reclaim, 2026-10-13)

- **Retired, not deleted.** `read-time-retired.ts readTimeRetired(db)` = `lineageLive(db)` (a line row exists) or the root sets were handed back
  (`root_sets_dropped`); monotone per connection. Once true, `replay-lineage.ts` answers from the write-time lookups: `replayExclusions` (content
  reader: `denyLookup`, copies followed to their originals; an audience reader keeps the caller's own `writetimeReplayWithheld`), `capturedMessageVerdict(s)`
  and `capturedMessageWithheld` (`denyLookup`, "checking" = withheld + unproven), `recordRestsOnWithheldMessage` (`memoryLookup` first),
  `sessionLineageBad` / `outputRootsBad` (false), `outputRootsFor` / `sessionOutputRoots` (empty), `messageMadeWithMemory` (the line's own row), the
  warmer (`lineageWarmStep`), the proof worker (`advanceRootSetProofs`), root-set collection (`maintainLineageStorage`). The positional read rule is
  off (`deny_range` replaces it). Nothing reads a root-set table. The code is still in the tree (the differential's frozen copy is under testing/);
  deleting it is a mechanical follow-up behind this gate. `continuationMemoryRevoked` asks `sessionLookup` first (a revoke bumps `deny_generation`,
  not the authority stamp a session hold rests on).
- **Temp triggers** (`authority-epoch.ts`, `provenance-stamp.ts`, `replay-lineage.ts` epoch schema) skip a root-set table that is gone
  (`withoutDroppedTableTriggers`), or the whole batch would fail and every write would move the stamp.
- **Reclaim** (`root-set-reclaim.ts`): armed at start (`setReadTimeJudgeRetired(true)` in index.ts). Sliced: rows out in batches sized to
  `RECLAIM_BATCH_MS` (40 ms), the emptied index and tables dropped, free pages given back by `incremental_vacuum` slices; the worker takes the write
  lock with no wait and naps between batches. The one VACUUM (a file not yet incremental) is the one unsliceable statement: last, owner idle >= 10 min,
  owner writes held asynchronously. `lastReclaimStats()` reports batches and the longest. **Hook for other lanes:** `registerRetiredObjects(owner,
  { indexes, tables })`. msearch2's `dropLegacyOwnerTailIndex` and hotpath's retired inbox tables are NOT in this branch: when those lanes merge they
  call it (`registerRetiredObjects("msearch2", { indexes: [...] })`, `registerRetiredObjects("hotpath", { tables: [...] })`) instead of dropping.
- **Imports re-sequence.** `message-db.ts importLegacy` writes the file in time order (stable sort on `at`), so lsn order is time order; the thread is
  ready (`lineage-write.ts readyImportedThread`) once the certificate is and its rows are in time order; `readyImportedThreads` runs in the
  transaction that drains U2 for threads imported while the upgrade ran. A thread written out of order stays not ready (fail closed).
- **U2 `until`.** `lineage-backfill.ts forgetBound`: a pre-upgrade owner forget with a time ends its range at 1 + the newest turn lsn that may have
  been put together before it. The range row carries the reason suffix `:until` (`revoke-marker.ts BOUNDED_RANGE`): the marker reads the bound back
  from the row (also in a bulk revoke, whose job row holds no root), a second root of the same revoke at the same line does not widen it
  (`writeRange`), and a bounded walk is not recorded as the thread's walk.
- **Differential gate.** Every range-based withhold of a line the RC shows is `proveRange`d (`testing/range-proof.ts`, own tests in
  `range-proof.test.ts`): `positional` (ancestor + time), or a counted `positional-branch`, `range-unplaced`, `range-coalesced`; otherwise unproven. The gate
  is 0 unsafe AND 0 unproven.
