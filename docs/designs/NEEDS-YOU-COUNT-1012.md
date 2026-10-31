# Needs you count, 1.0.12: one approval card is one, and the Inbox layout stays 4

Status: revision 3, (A) only. Astra round 2 passed option (A) and raised its only High in fallback (B); the coordinator dropped (B) under the rule "cut a sub-feature at its first new High". See section 7.
Baseline: lane `fix/1011-needs-you-count` at `c1685d597` (merged into int/1011 as a9e4bbd45, then bounced on a HIGH).
Base of the lane: 1.0.10 candidate Y `49a54e2fae`. All line numbers below are the lane tree unless marked "base".
Design only. No code, no builds, no tests were run for this document.

## 1. The problem, in two parts

**The bug (Sean, from his own use).** A routine run that opens a card is set to `waiting` (`server/routines.ts:1467` cardOpened, `:2847` request.opened) or `needs-you` when its run limit comes or its turn ends on an open card (`:2240`, `:2869`). The run's own row lives in the conversation the routine reports to (`server/index.ts:13153` syncRoutineRunToSource writes the `routine.run` message to `source.threadId`), and the card lives in the run's execution thread. Both rows have a status in `INBOX_DECISION_STATUSES`, so the projection stores `decision=1` for both (base `server/inbox.ts:193` projectedRows, `:270-273` refreshItem) and the badge says "Needs you 2" for one approval.

**The lane's fix broke downgrade.** The lane moved the rule into the stored layout: `decision`, `segment` and `owed_or_over` are computed with `OWED` = decision status AND NOT run-on-card, and `listTerms("results")` gained a term. Every one of those strings is DDL text (the trigger bodies, the partial index WHERE clauses), so the lane bumped `PROJECTION_VERSION` 4 to 5. Consequences, from INT-1011.md:
- `memory-downgrade --to 10` never touches the inbox projection, so 1.0.2 is handed layout 5 objects: 23 `*_4` indexes missing, 23 `*_5` extra, 9 trigger bodies differ. `server/downgrade-102-schema.test.ts` (a GATE test, `ci/gate-tests.txt:577`) fails.
- Any older build (1.0.2, or 1.0.10 on a quick rollback) retires layout 5 and refills the whole Inbox from history, which breaks the "1.0.2 reads no history again" contract.
- If the `retired4_*` tables are not reclaimed yet (reclaim runs in idle slices, `reclaimRetiredInboxProjection`), they still own the `*_4` index names (`ALTER TABLE RENAME` keeps index names, `retireInboxProjection` `:456-468`), so the old build's `CREATE INDEX IF NOT EXISTS ..._4` is skipped and its `INDEXED BY` queries fail with "no such index".

## 2. Decision: option (A), dedupe at read time, no layout change

The rule "a run parked on a card is not a second thing owed" is a question about **what is counted and listed**, not about **what is stored**. Layout 4 already stores everything the rule needs on every item row: `kind`, `status`, `decision`, `segment`, `expired`, `live`, `snoozed_until`, `thread_id`. So the rule is applied in the SELECT statements that produce numbers and pages, exactly where the Inbox already applies a rule that the counters cannot know: snoozes that ran out (`inboxPage` load(), the `snoozed` read on `inbox_items_snoozed_4`, `:1129-1136`). This design adds one more read of the same shape and subtracts it the same way.

What is **unchanged**, byte for byte, from 1.0.10: `PROJECTION_VERSION = 4`, `projectedRows`, `refreshItem`, `listTerms`, `BADGES`, `COUNTERS`, `PROJECTION_DDL`, every trigger body, every index name and WHERE clause, `inbox_counts` columns, `retireInboxProjection`, `reclaimRetiredInboxProjection`, `registerRetiredObjects("hotpath", ... [0,1,2,3])`. A 1.0.12 database is a 1.0.10 database. There is nothing to downgrade.

Scope of that promise (Astra r1): it holds for every file that never ran layout 5. Layout 5 existed only on int/1011 candidates, which were never cut or published (`handoffs/INT-1011.md:6`, "NOT cut, NOT published"), so no owner's file has it. A lane or int/1011 test data dir that did open layout 5 is not carried forward: it is rebuilt from a fresh fixture. No recovery path ships, because no shipped build can produce the state it would recover.

### 2.1 The predicate (read-time only)

```ts
// shared/inbox.ts (kept from the lane; a TypeScript constant, never DDL)
export const INBOX_RUN_ON_CARD_STATUSES = ["waiting", "needs-you"] as const;

// server/inbox.ts, used in SELECT statements and in JS only. Never spliced into PROJECTION_DDL, listTerms, BADGES or COUNTERS.
const RUN_ON_CARD = (p = "") => `(${p}kind='routine.run' AND ${p}status IN ('waiting','needs-you') AND ${p}expired=0)`;
const runOnCardRow = (row: { kind: string; status: string; expired: number }) => row.kind === "routine.run" && runOnCard(row.status) && row.expired === 0;
```

`status` is the projected status column, which reads `routineRun.goalStatus` before `routineRun.status` (base `inbox.base-1010.ts:130`). A room goal that stopped to ask carries `goalStatus: "needs-input"`, so its row has status `needs-input`, not `waiting`, and stays owed (lane test "a room goal that stopped to ask is still owed").

**Why `expired=0` is part of the rule (r1 finding 4).** `expired` is `$.card.expired` for every kind (base `:93`). Our producer never writes a top-level `card` on a `routine.run` message: `syncRoutineRunToSource` writes `{ role, kind: "routine.run", text, routineRun }` and patches `{ text, routineRun }` only (`server/index.ts:13150` excerpt), so every run row it makes has `expired=0`. A run row with `expired=1` can only come from a message we did not write. Rather than subtract it from some numbers and not others, the rule leaves it out entirely: such a row is counted, listed and clearable exactly as in 1.0.10 in every number and every view, so its badge and its pages always agree. The oracle (`server/inbox.base-reference.ts:18`) gets the same `expired=0` term, and test 11 pins the behaviour.

In layout 4 a run on a card has, by the stored rules: `decision=1`, `kind_segment='routine'`, `segment='question'` (`:277`), `owed_or_over=1`, `expired=0`. So it sits in `inbox_items_v_decisions_4` (`ON inbox_items(decision DESC,at DESC,source_key) WHERE expired=0 AND decision=1`, the `listWhere("decisions", false)` index, base `:293,357-359`), and in the `l_`/`v_` questions and decisions indexes.

### 2.2 The correction read: one shared read per messages version (r1 High)

Round 1 read the `v_questions_4` index once per answer-cache key with the scope in SQL. Astra was right that this walks every decision-marked question row in the file (scope, kind, status, expiry, live and snooze are filtered after the `decision=1` prefix), including expired `pending` cards that grow with history, and that it repeats per (view, page, search, scope) key. Revision 2 changes both the index and the sharing:

```sql
-- runsOnCards(db): one read per messagesVersion(), shared by every view, page, search, scope and the snooze sweep
SELECT thread_id, live, snoozed_until, COUNT(*) AS n
  FROM inbox_items INDEXED BY inbox_items_v_decisions_4
 WHERE expired=0 AND decision=1                         -- the index's own WHERE, so the planner may use it
   AND kind='routine.run' AND status IN ('waiting','needs-you')
 GROUP BY thread_id, live, snoozed_until
```

- **No scope and no clock in SQL.** The result is memoised in a `WeakMap<DatabaseSync, { version, rows }>` keyed on `messagesVersion()` (the same key `heldFor` uses, `server/inbox.ts:1022-1027`; `updateInboxState` bumps it, `:1286`, so a clear or a snooze mark invalidates it). Each caller then filters the few result rows in JS: in scope = `threadsById(access.threads).has(thread_id)` (already a cached Map, `:941-946`); snoozed now = `snoozed_until !== null && snoozed_until > now`. A snooze that runs out with no write is therefore seen on the next call without a re-read (test 3b).
- **Uncached callers** (`listInbox`, `owedThreads` without the cache) run the same statement fresh, so tests that write without a version bump stay exact.
- **What is walked.** The partial index holds exactly the rows with `decision=1 AND expired=0` in the whole file. That is the `owed_open` population (base `:320`): call it `OWED_ALL = SUM(owed_open)` over every conversation. History is not in it: terminal rows have `decision=0`; expired cards (the `pending` ones Astra named) have `expired=1`; answered, dismissed, orphaned and missed cards are `resolved`/`missed`. Snoozed and cleared rows that are still owed and unexpired are in it, and so are owed rows outside the caller's scope: the read is global on purpose, so it is paid once for all scopes.
- **Per visited entry**: one table lookup (`kind` and `status` are not index columns). Output rows: at most `k` = runs on cards in the file.

### 2.3 Where the correction is applied (inside `inboxPage` load(), plus `owedThreads`)

Let `onCard` be `runsOnCards(db)` filtered to the scope. Every row in it is unexpired by construction. Define `live_now` = rows with `live=1` and not snoozed now (exactly the rows the `l_*` counters and badges count that the existing snoozed read has not already taken off).

| Number | Today (layout 4) | 1.0.12 |
|---|---|---|
| `decisions` badge | `SUM(o_decisions) - snoozed.decisions` | `... - SUM(onCard.n WHERE live_now)` |
| `questions` badge | `SUM(o_questions) - snoozed.questions` | `... - SUM(onCard.n WHERE live_now)` |
| `approvals`, `connections`, `toRead` | unchanged | unchanged (a run row is never in those) |
| `total` for view `decisions` or `questions`, not includeSnoozed | `SUM(l_<view>) - snoozed.total` | `... - SUM(onCard.n WHERE live_now)` |
| `total` for view `decisions` or `questions`, includeSnoozed | `SUM(v_<view>)` | `... - SUM(onCard.n)` (the `v_` counters count cleared and snoozed rows too) |
| `total` for `all`, `routines`, `to-read`, `results`, `approvals`, `connections` | unchanged | unchanged |
| `questionThreads[thread]` (decisions view only) | `o_questions - snoozed.questions` per thread | `... - onCard.n WHERE live_now` per thread; dropped at zero |
| search `total` | COUNT(*) with the page filter | the page filter carries the predicate (2.4); no further correction |
| `owedThreads` | threads with `owed_open>0` | `SELECT thread_id, owed_open FROM inbox_counts WHERE owed_open>0 AND SCOPE`, minus `SUM(onCard.n)` per thread over every row (owed_open has no live or snooze term), kept while `> 0` |

Astra r1 confirmed this arithmetic for live, snoozed and cleared rows with `expired=0`; the only change is that the expired case is now outside the rule on both sides.

### 2.4 Pages, items, clearing, order

- **Decisions and Questions pages.** The page `filter` gains ` AND NOT ${RUN_ON_CARD()}`. Query text only; the `INDEXED BY` stays the list's own index; the cursor path (`after`) and the Questions `decision=0` continuation are untouched. Among the rows that survive, order and cursors are exactly the layout 5 ones (Astra r1 confirmed).
- **`item()`** (`:952`): when `runOnCardRow(row)`, present `segment: "routine"`, `decision: false`. `clearable` stays on the stored flag (`row.decision !== 1`), so it is absent. Everything else about the item is unchanged.
- **Clear guard (revision 4; replaces the r1 finding 2 answer).** `updateInboxState` (`:1270-1272`) keeps the shipped rule: clearing a stored `decision=1` row gets 409, and a run on a card is a stored `decision=1` row. The reason is the first code review High: a receipt can turn from a run on a card into a real question with its original `at`, and a clear mark taken earlier would keep it `live=0` and hide that question. The counters still handle a cleared run, because a row cleared at a news status (`paused`, clearable since 1.0.10) keeps its mark if it comes under the rule: live=0 leaves the `l_`/`o_` counters, and the correction subtracts it only from `v_` totals and `owedThreads`. Test 4 tries the clear through `inboxRequest(... POST /api/inbox/state ...)`, the public route.
- **All and Routines order (r1 finding 3). Decision: keep the layout 4 order for those two views, and change the oracle to match.** In All and Routines a run on a card sorts with the owed rows (`ORDER BY decision DESC,at DESC,source_key` on the stored flag, `:1144`), and the cursor encodes the stored flag (`encodeCursor` reads the Row, `:997-998`), so each walk stays one index seek per page with no history-wide sort. This is what 1.0.10 shows today, and it reads right: the row says "Waiting on you" and sits next to the card it waits on. The oracle (`server/inbox.base-reference.ts:500-503`) orders by a `listed_decision` column = `status IN (DECISION_SQL)` (the layout 4 flag) instead of the corrected `decision`. For every row that is not a run on a card the two flags are equal, and runs on cards are filtered out of every other view that orders by decision, so this changes the oracle's order only in All and Routines, and only for runs on cards. The oracle's presented `decision` stays the corrected flag. Alternative rejected: merging runs on cards into the `decision=0` group needs either a sort over the whole list or a second ordered walk merged by `at`, for an ordering nobody asked for.
- **`routineFacts`** keeps the lane's TypeScript change (`failed` excludes runOnCard, `owed` includes it). The Routines roll-up verdict is `waiting` either way (r1 confirmed).
- **`results`**: no change. A run on a card has stored `decision=1`; results require `decision=0`. The lane's extra `listTerms("results")` term is dropped (it was DDL).
- **`server/inbox.base-reference.ts`** keeps the lane's rule plus `expired=0` and the `listed_decision` order above.
- **`server/project-goals.ts` `projectOwedBeyondCards`** stays as a named seam. It returns the same expression as before (`goals.length + deadWaitCards.length`, `:631-632`); it fixes no arithmetic and the design no longer claims it does. Its value is that the "approval cards are counted by the projection, never added again" rule is written once, with test 10 pinning it.

### 2.5 What the lane's commit must revert

`server/inbox.ts`: `PROJECTION_VERSION` 5 back to 4 and the comment; `OWED` removed from projectedRows, refreshItem (three places) and listTerms. `server/index.ts:31640`: `[0, 1, 2, 3, 4]` back to `[0, 1, 2, 3]` and the comment. `server/installation-database-snapshot.test.ts:110-111`: `_5` back to `_4`. The rest of the lane (shared constant, test file, project-goals seam, base-reference, routineFacts, the gate-tests row) stays. Astra r1 found no other schema-changing hunk.

## 3. Cost, against house rule 1 ("per-turn work grows with new work, never with history")

| Path | Today | Added by (A) | Bound |
|---|---|---|---|
| A turn (any engine) | nothing reads the Inbox in a turn; message writes fire the projection triggers | 0 | triggers unchanged |
| A message write | trigger bodies | 0 | unchanged DDL |
| Any Inbox or sweep call, same messages version | cache hit: 0 SQL | O(k) JS over the memoised rows | k = runs on cards in the file |
| First Inbox or sweep call after a version change | per key: `inbox_counts` SUM in scope + snoozed read + page | **once per version, for all keys and scopes**: one walk of `inbox_items_v_decisions_4` | `OWED_ALL` index entries + one lookup each |
| A page of `decisions` or `questions` | index walk to OFFSET + page rows (existing) | one predicate per walked row | + at most k skipped rows |
| A search | COUNT over the list index with the filter (existing) | one predicate per row | unchanged order of cost |
| Start, upgrade, downgrade, rollback | layout 4 kept, no retire, no refill | 0 | nothing to do |

**The honest bound.** The added SQL work after a write is one walk of `OWED_ALL` index entries, file-wide (not per scope, not per view). `OWED_ALL` is every item still owed and unexpired: open cards, pending connections, runs on cards, goals waiting for input, snoozed or cleared or outside the caller's scope included. It does not grow with answered, finished, expired or missed history. It does grow with things left unanswered, and since 1.0.8 cards never expire, so it is not bounded by a constant: an owner who never answers keeps adding to it. That is the same population the Needs you badge shows him (plus what he snoozed or cleared), so the cost grows with the thing he is being asked to act on, never with the archive. Growth tests below set the numbers and the action.

**Growth tests (build host lane container, never the Mac; `df -h` first, at most 2 containers).** Fixture: hotpath-r6 (200k rows) on a file database with the server's pragmas. Protocol for every timing: 20 warm-up calls, then 200 timed calls, statistic p95 (p50 recorded), one process, warm page cache; the baseline is the same protocol on 1.0.10 candidate Y `49a54e2fae`. Results and the sha go in the lane handoff.

| # | What grows | Points | Pass | Proves |
|---|---|---|---|---|
| G1 | `OWED_ALL` (k = 50 runs on cards) | 500 / 2,000 / 10,000 / 40,000 | correction read p95 ≤ 1 ms at 2,000, ≤ 5 ms at 10,000, ≤ 20 ms at 40,000 | cost is linear in owed rows and small at real sizes |
| G2 | history, `OWED_ALL` fixed at 2,000 | + 100k terminal rows (completed/failed runs, resolved cards), + 20k expired `pending` cards, + 5k cleared terminal rows | (deterministic) `SELECT COUNT(*) FROM inbox_items INDEXED BY inbox_items_v_decisions_4 WHERE expired=0 AND decision=1` equals `SUM(owed_open)` and is unchanged by the additions; (timing) p95 after ≤ 1.2 × p95 before | rule 1: history adds nothing to the walk |
| G3 | scopes, 1,800 of 2,000 owed rows outside the companion scope | 10 scopes × 4 views × 3 pages after one write | statements naming `inbox_items_v_decisions_4` executed = exactly 1 (counted by wrapping `db.prepare` in the test); every answer equals the oracle | one shared read per version, scope does not multiply it |
| G4 | cache invalidations | 1,000 rounds of (append one message; poll decisions for owner, companion and tray; `owedThreadsCached`) | correction reads = 1,000, not 4,000; summed correction time ≤ 1,000 × G1 p95 at 2,000 × 1.1 | repeated invalidation costs one read per write |
| G1k | k, runs on cards, with `OWED_ALL` = k + 2,000 cards | k = 50 / 500 / 2,000 / 10,000; runs spread over k/5 distinct (thread, live, snoozed_until) groups (many groups), a third of them snoozed and a tenth cleared; every run's `at` newer than every card, so all k runs sit before the requested page in the Decisions and Questions index order; the page reads are taken both default and with `includeSnoozed: true` (the `l_` indexes leave cleared runs out, so only the `v_` walk passes literally all k) | correction read p95 ≤ 2 ms at 500, ≤ 5 ms at 2,000, ≤ 25 ms at 10,000; cached JS filter (cache hit, owner and companion scope) p95 ≤ 0.5 ms at 2,000, ≤ 2 ms at 10,000; Decisions page 0 and Questions page 0 (the k runs skipped before the first card) p95 ≤ 1.0.10 baseline + 1 ms at 500, + 5 ms at 2,000, + 25 ms at 10,000; every answer equals the oracle | grouping, cached filtering and page skipping stay linear and small as k grows |
| G5 | end to end at `OWED_ALL` 2,000 | `listInboxCached` decisions cache miss; Questions page 0 and page 40 by offset; `owedThreadsCached` cache miss | each p95 ≤ the 1.0.10 baseline + 1 ms | the poll, the page and the sweep stay as fast as today |

**Action.** Any G row fails its p95 limit at build time: there is no fallback design. The lane leaves 1.0.12, 1.0.12 ships without this fix (the count stays as in 1.0.9 and 1.0.10, display only: one approval shows as 2; no data risk), and the numbers are reported. The train does not wait.

## 4. Why not the alternatives

- **Store it (the lane, layout 5).** Right rule, wrong layer: a read-time rule written into DDL forces a layout bump, and the bump broke downgrade (section 1). Excluded: the layout stays 4.
- **Fix it in routines.ts (never write `waiting` into the run message).** The run's status is product copy ("Waiting on you: ...", `routines.ts:99-100`) and the Routines verdict; existing rows would stay double-counted until they change.
- **Correct from in-memory cards (`openApprovals`).** They do not survive a restart. The status rule does.
- **An extra unversioned index (`WHERE kind='routine.run' AND status IN (...)`).** It would make the walk O(k), but it is a schema object 1.0.2 and 1.0.10 do not know, which is the class of change that broke the downgrade. Excluded.

**Fallback (B), candidate keys from the routine records: dropped in revision 3.** Astra round 2 found a High in it (its count rechecked the rule but its page, item and clear guard used the raw candidate keys, so a room goal at `needs-input` could be hidden and cleared). Under "cut a sub-feature at its first new High" it is removed, not fixed. If (A) misses its gates, the fix leaves 1.0.12 (section 3, Action).

## 5. Tests (all run on the build host in the lane container; never on the Mac)

Existing, kept as written (they test output, not layout): `server/inbox-needs-you-count.test.ts` all 7 cases; `server/inbox.test.ts`; `server/inbox-backup-notices.test.ts`; `server/inbox-access.test.ts`; the hotpath perf test `inbox.hotpath-r6`.

Now passing again, no edit: `server/downgrade-102-schema.test.ts` (both cases), `server/memory/downgrade-102-objects.test.ts`.

Edited back: `server/installation-database-snapshot.test.ts` (`_4` names).

New cases, in `server/inbox-needs-you-count.test.ts` (numbers 1 to 11) and the hotpath perf test (G1, G1k, G2 to G5, section 3):

1. **Layout stays 4.** After `initializeInbox` on a fresh file: `SELECT cursor FROM inbox_projection_state WHERE name='layout'` is 4; `sqlite_schema` holds no name ending `_5`; the inbox objects (type, name, tbl_name, whitespace-folded sql) equal the inbox objects in `server/testing/schema-1.0.2-fresh.json`.
2. **A filled layout 4 file reopens with no retire and no refill.** Seed through the public functions: open a file, `initializeInbox`, append a question card, a run on a card and 50 finished runs, run `fillInboxProjection` until `inboxProjectionReady` is true. Record `SELECT name,done,cursor FROM inbox_projection_state` (the `layout` row is 4, the `inbox` row is `done=1`) and `SELECT source_key, rowid FROM inbox_items`. Close the handle, open a new `DatabaseSync` on the same file (a restart), run `initializeInbox`. Assert: `SELECT name FROM sqlite_schema WHERE name LIKE 'retired%'` is empty (read through `sqlite_schema`, since `retiredTables` is private); both marker rows are unchanged; the item rows and their rowids are unchanged (nothing was refilled); `inboxProjectionReady` is true on the new handle with no fill step.
3. **Snoozed run on a card is not taken off twice.** Approval card (the lane fixture's `approval()`, a tool card, so segment `approval`) in `routine-run`, run `waiting` in `dm`, snooze the run row until NOW+1h via the public route: `decisions` 1, `approvals` 1, `questions` 0, `questionThreads` exactly `{}`, Decisions `total` 1; with `includeSnoozed` total 1. Repeat with the run at `needs-you`. **3b, snooze runs out with no write:** same setup through `listInboxCached`, then call again with `now` past the snooze and no message write: the same numbers (the run is never counted), and the shared read ran once (counter as in G3).
4. **A run on a card cannot be cleared, through the public route.** `POST /api/inbox/state {cleared:true}` on the run item and on the card item each return 409, the item has no `clearable`, and Needs you stays 1. **4b:** the same receipt then asks a real question with its original `at` (status `waiting`, `goalStatus` `needs-input`): cached and uncached, `decisions` 1, `questions` 1, `questionThreads` `{"dm": 1}`, the receipt is on the Decisions and Questions pages, `owedThreads` is `{"dm"}`. **4c, a row cleared at `paused` that then comes under the rule:** `decisions` 1, `approvals` 1, `questions` 0, `includeSnoozed` Decisions and Questions totals 1 and 0 (the `v_` path), `owedThreads` exactly `{"routine-run"}`. Also a run row both cleared and snoozed: same numbers. Also a real question card (no tool) added to the run's thread `dm`: `questionThreads` exactly `{"dm": 1}`, `decisions` 2, `questions` 1.
5. **Decisions and Questions pages and cursors.** 3 cards in three threads plus 2 runs on cards, pageSize 2: page 0 and page 1 hold cards only, `total` 3, the cursor path (`after`) yields the same rows; no run on a page. Questions view with 2 pending question cards then 2 missed question cards (the `decision=0` continuation) and a run on a card between them by time: the cursor crosses from pending to missed with no run and no duplicate. Two cards with equal `at`: order and cursor follow `source_key`.
6. **All and Routines order.** A run on a card at t=1, a completed run at t=2, a card at t=3: All page 0 order is card(3), run on card(1), completed run(2) (the stored layout 4 flag), the run item shows `segment: "routine"`, `decision: false`, no `clearable`; walking the production cursor path (`after`, page size 1 and 2) gives the same sequence; the oracle (which has no cursors, `inbox.base-reference.ts:357-363,551`) is read by offset with `listed_decision` order, and the concatenated production cursor walk equals the oracle's offset-ordered sequence row for row. Routines view: same relative order, roll-up verdict `waiting`.
7. **Search.** Search for the run's summary in view `decisions`: 0 rows, total 0; in view `routines`: the run, verdict `waiting`; in view `all`: the run with `segment: "routine"`, `decision: false`.
8. **Query plans.** `EXPLAIN QUERY PLAN` of the correction read: its one line for `inbox_items` uses `inbox_items_v_decisions_4` (SEARCH or SCAN of that partial index; the partial index is the bound) and there is no line that reads `inbox_items` any other way. Of the Decisions page read: the `inbox_items` line uses `inbox_items_l_decisions_4`; the `json_each` virtual-table scans (the scope list) are expected and not asserted against. The bound itself is asserted by G2's population count, not by an index name.
9. **Cost gates.** G1, G1k, G2 to G5 (section 3), with the action stated there.
10. **Project room across a restart, from the reconciled state.** Before: a project room with a work item `state='waiting'`, `waiting_on {"kind":"owner_approval"}`, its approval card message pending in the project thread, `openApprovals` = [that card], and a routine run `waiting` on it: Needs you 1, the card counted once by the projection, the work item not a dead wait (`deriveGroupedDecisions` admits only `restart`, `stopped`, `owner`, `project-goals.ts:654-670`). After: the state the restart path leaves on disk, written as it writes it: the card message gets `card.orphaned=1` (the boot sweep, `server/index.ts:14522`; base `inbox.base-1010.ts:117-119` makes it `resolved`); the work item gets `waiting_on {"kind":"restart"}` (`server/project-turn-engine.ts:180`); the routine run record goes `failed` with "Murage restarted while this routine was running" (`server/routines.ts:1221-1226`) and its message is re-synced to `failed`; `openApprovals` = []. Expect: Needs you 1 and questions 1 (the dead wait, through `projectOwedBeyondCards` in `GET /api/inbox`), the orphaned card 0, the failed run 0 and listed in Routines as failed. Variant: the run message left at `waiting` while its record is `failed`: still Needs you 1 (the status rule dedupes the stale row).
11. **Expired run row.** A `routine.run` message carrying `card.expired=1` with status `waiting` (not a shape our producer writes): counted in `decisions` and `questions` badges, listed in the Questions page, absent from the Decisions page (as 1.0.10), not clearable, not subtracted anywhere; badge and Questions total agree.

CI: scoped `ci/try` on the candidate sha, plus the 7 repo-wide structural files INT-1011 names (`downgrade-102-schema` among them), green before the lane is offered to int/1012. Check-Ahead per `handoffs/RELEASE-CHECK-AHEAD.md` before any cut.

## 6. House rules check (MURAGE-HOUSE-RULES.md v2)

Gap test: not a feature, a counting defect Sean reported from his own use (one report of a trust defect is enough). The simpler cut is the one chosen: a read-time predicate instead of a layout migration. Metric, threshold, window and action are set (section 3, G1, G1k, G2 to G5).
1. Works by default, every engine, every OS, any size: no setting, no engine dependence; per-turn work 0; per-write work 0; after a write, one shared walk bounded by owed-and-unexpired rows file-wide, which history does not grow (G2 proves it); start, upgrade and downgrade do nothing new.
2. Levels and never-list: not touched.
3. Hard limits in the harness: not touched.
4. No dead ends: the run row still shows "Waiting on you" with its link in All and Routines; the card is the one thing in Needs you, and answering it carries the run on.
5. Appetite first: this is the design pass after the lane's second failed review (INT-1011 HIGH). If the gates trip, the fix leaves 1.0.12 (no fallback); the train does not wait.
6. Derived data follows its source: the projection is still rebuilt from messages by the same DDL; no index or cache moves or alters a source row.
7. Every surface declares itself: no new surface, setting, hold or provider.
8. Nothing first found after the cut: the downgrade test is a GATE row and runs in the scoped ci/try; evidence names the sha and the build host numbers.
9. Say what it does: no product copy changes; release note line: "Needs you now counts an approval raised by a routine once."

## 7. Review record

**Build result (lane fix/1012-needs-you-count, base 49a54e2fa, build host, valid run 4).** G2 TIMING MISSED. Every other gate passed. p95 in ms, 1.0.10 tree / this lane.

| Gate | Limit | Result |
|---|---|---|
| G1 read at 2k / 10k / 40k | 1 / 5 / 20 | 0.28 / 2.15 / 9.90 |
| G1k read at k 500 / 2k / 10k | 2 / 5 / 25 | 0.62 / 1.59 / 8.61 |
| G1k filter, owner, at k 2k / 10k | 0.5 / 2 | 0.30 / 1.79 |
| G1k pages, worst of four, at k 500 / 2k / 10k | + 1 / + 5 / + 25 | + 0.85 / + 2.25 / + 14.65 |
| G2 deterministic | walked = `SUM(owed_open)`, unchanged | 2,000 = 2,000, before and after 125k items added |
| **G2 timing** | **after ≤ 1.2 × before** | **MISS: 0.280 to 0.347 = 1.24×** (earlier runs 1.38×, 1.34×) |
| G3 | 1 read, equals oracle | 1 read, equal over 10 scopes × 4 views × 3 pages |
| G4 | 1,000 reads, ≤ 303.6 ms summed | 1,000 reads, 274.9 ms |
| G5, worst of four | + 1 | + 0.36 |

G2 detail: the index walk alone is flat (0.053 to 0.054), so history adds no walked entries; what grew is the rest of the read, the per-entry row lookups and grouping, as `inbox_items` went from 2,000 to 127,000 rows. The same SQL on the 1.0.10 tree gives 1.25× (it is not run there in production). The limit and the fixture were not changed. Runs 1 to 3 had a fixture defect (a REAL-bound `%` made thread ids like `c7.0`, an empty audience), so their scoped numbers are void; G1 and G2 read SQL directly and were not affected. Under section 3, Action, a missed limit takes the fix out of 1.0.12 unless the coordinator rules otherwise.

**Ruling on G2 timing (MurageMain, coordinator, 2026-10-30): WAIVED for timing; the fix stays in 1.0.12.** The miss is 0.280 to 0.347 ms (1.24× against the 1.2× limit) after adding 125k items, while the index walk stays flat at 0.054 ms, so walked entries do not grow with history. The gate exists to catch history scaling, and a flat walk shows none. The waiver covers this one timing result. The limit and the fixture stay as they are, and the deterministic half of G2 stays binding. In the test, G2 timing is now report-only with this reason: `NYC_GROWTH=1` records the ratio against the stated 1.2× and does not fail on it. A 1.24× limit was not used because earlier valid-walk runs read 1.38× and 1.34×.

**Revision 4 (coordinator ruling, 2026-10-30): clearing a run on a card CUT.** Code review (Astra, gpt-6-astra, read-only, snapshot `scratchpad/astra-nyc-code-20261030144357`, commit `0c5321bdc`): BLOCK on one High. Clearing a run on a card left a clear mark that outlives the card; when the same receipt later asked a real question with its original `at`, `live` stayed 0 and the question left the badges and the default pages. Under "cut a sub-feature at its first new High" the shipped rule is back: raw `row.decision === 1` guards the clear and sets `clearable` (2.4, tests 4 and 6, new 4b and 4c; the oracle follows on `listed_decision`). Medium fixed: on the corrected tree G1k and G5 now fail when a baseline entry is missing, where they used to pass silently. Low (`projectOwedBeyondCards` not called by the route) and the test notes (3b cannot alone prove answer-cache expiry; G1k oracle comparison stops at k = 500) go to the follow-up list; they do not block.

Revision 4 evidence (build host, `d089468bc`): server tsc clean, 9 touched suites 152 of 152, growth gates 6 of 6 against a fresh 1.0.10 baseline, missing-baseline run fails G5 as required, G2 report-only at 1.21× with walked entries unchanged. Astra confirm on this change (snapshot `scratchpad/astra-nyc-confirm-20261030151538`): AGREE, no findings.

**Revision 3 (coordinator, 2026-10-30).** (B) dropped entirely (its round 2 High is gone with it; round 2 Medium 3 about (B)'s fixtures and assertions falls away too). Round 2 Medium 2 answered by G1k (k grows to 10,000, many groups, all runs before the requested page). Round 2 Low 4 answered in test 6 (production cursor walk compared with the oracle's offset order). If (A) misses a gate: ship 1.0.12 without this fix and report.

Round 3 (Astra, gpt-6-astra, read-only, snapshot `scratchpad/astra-nyc-r3-20261030133139`): **CONFIRM**, (A) stands alone with no Critical or High; no operative text depends on (B); test 6 and G1k coherent. Two Lows, both folded: G1k page reads also with `includeSnoozed: true`; the round 2 wording about (B) marked superseded.

Earlier status: Astra round 1 = REVISE; round 2 = REVISE with its only High in fallback (B).

Round 2 (Astra, gpt-6-astra, read-only, snapshot `scratchpad/astra-nyc-r2-20261030132357`, full text in `astra-r2.md` there). Astra finds option (A) sound: the walk is exactly `decision=1 AND expired=0` (= `owed_open`), the `OWED_ALL` bound is honest under rule 1, the 2.3 arithmetic is exact for live, snoozed, cleared and snooze-expired-without-write rows, and all five round 1 Mediums are resolved. No downgrade risk. Remaining findings:

1. **High, (B) only.** (B)'s count rechecks `RUN_ON_CARD` but its page predicate, `item()` and clear guard use the raw candidate keys. A room goal (record `status="waiting"`, `goalStatus="needs-input"`, `routines.ts:2960-2977`; projected status `needs-input`) is a candidate but not subtracted, so Decisions hides it and All lets it be cleared: a real question is hidden. Fix: (B) keeps only the keys that pass the SQL recheck and uses that one set everywhere, cached on both `messagesVersion()` and the routine-store revision (`routines.ts:1288-1290`); or drop (B).
2. **Medium.** G1 fixes k at 50; add run-heavy points (k growing, many groups, runs before the requested page).
3. **Medium.** G3 and test 8 name `inbox_items_v_decisions_4`, so they cannot run against (B); define (B)-specific assertions and give (B)'s fixtures `routineRuns` (the lane test passes none, `inbox-needs-you-count.test.ts:27-31`).
4. **Low.** Test 6: the oracle has no cursors (`inbox.base-reference.ts:357-363,551`); compare the production cursor walk with the oracle's offset order.

Round 1 (Astra, gpt-6-astra, read-only, snapshot `scratchpad/astra-nyc-20261030210911`, full text in `astra-r1.md` there). Astra agreed that the counting arithmetic in 2.2 to 2.3 matches all seven existing test cases, that 2.5 reverts every schema-changing hunk of the lane, and that triggers and the cache-hit path add zero work. Findings and how revision 2 answers them:

1. **High. Cost bound misstated.** The `v_questions_4` read walked every decision-marked question row file-wide, per cache key. **Answered in 2.2 and 3:** the read moves to `inbox_items_v_decisions_4` (population = owed and unexpired rows; history and expired cards are outside it), runs once per messages version for every key and scope, and filters scope and snooze in JS. The bound is stated as `OWED_ALL` file-wide, not "open cards in scope". Growth tests G1 to G5 carry points, statistic, window, thresholds and the action. (Round 2 wording, superseded by revision 3: (B) was then a fallback; it is now dropped.)
2. **Medium. Clear guard.** **Answered in 2.4:** the guard uses `runOnCardRow`; test 4 clears through the public route and checks the card still gets 409.
3. **Medium. All and Routines order.** **Answered in 2.4:** the layout 4 order is kept for All and Routines (no history-wide sort); the oracle orders by `listed_decision`; test 6.
4. **Medium. Expired run rows.** **Answered in 2.1:** `expired=0` is part of the rule everywhere (SQL, JS, oracle), so an expired run row is treated exactly as in 1.0.10 in every number and page; our producer never writes one; test 11.
5. **Medium. Test 10 restart state.** **Answered in 5:** built from the reconciled state the restart path writes (orphaned card, `restart` dead wait, failed run), with the stale-message variant.
6. **Medium. Tests 2 and 8.** **Answered in 5:** test 2 seeds markers and rows through the public functions, reopens, and reads `sqlite_schema`; test 8 asserts the `inbox_items` access path only and allows `json_each` scans; the bound is proved by G2's population count.

Also answered: the layout 5 file note (scoped in section 2, no shipped build ever had layout 5) and the `projectOwedBeyondCards` overstatement (2.4, now described as a named seam).
