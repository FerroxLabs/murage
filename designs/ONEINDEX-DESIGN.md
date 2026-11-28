# ONEINDEX: one shared recall index, visibility at query time (1.0.23, STEP 1)

Owners: design + STEP 2 build = q1023-oneindex; schema version / downgrade side = q1023-oneindex (the 1.0.19-1.0.22 readers of
`memory_recall_*` are shipped code, no owner change); review = the Fable seat MAIN names; rulings = MAIN.
Status: STEP 1 (design + measurement). Nothing here is built. STEP 2 starts only on a MAIN GO.

## PURPOSE
Recall reads one incremental index (the FTS5/BM25 tables of memory-index.db plus postings and vectors) and decides at query time
what a reader may see. The per-view copies (`memory_recall_view_*` and their siblings) and their per-generation rebuilds go.

## USER PROMISES
- P1. A bot or the owner never recalls a memory it could not read before this change. Every deny, revoke, forget and PIP rule
  holds exactly, with the same tests green.
- P2. A memory change rewrites only that memory's own index rows. Nothing is rebuilt per bot, per roster change or per
  authority epoch.
- P3. Recall answers fast and writes nothing: p95 < 150 ms for owner and bot recall on the real 11-26 data, 0 writes per query.
- P4. After an upgrade the first turn shows no rebuild banner. Idle writes stay under 1 MB/min and a turn stays at or under 20 MB.

## What STEP 1 found that the order assumed differently
1. The FTS5/BM25 index is a separate file, memory-index.db (`server/memory/index.ts:278-287`: `entries`, `lexical` fts5,
   `vectors`, `lexical_keys`, `index_meta`; postings at `postings.ts:74-81`). The main DB snapshot has no FTS5 table.
   The query-time join already exists: the reader attaches the main DB read-only as `authority` (`index-reader.ts:60-72`).
2. Deny is already applied at query time today, not by the views: `DENIED_RECORD_SCOPE` / `DENIED_SOURCE` (`deny.ts:26-37`)
   inside `CURRENT_MEMORY` / `HISTORICAL_MEMORY` (`eligibility.ts:13-18`), plus `REACHABLE_RECORD` (`eligibility.ts:21-22`),
   evidence standing and direct ancestry (`index-reader.ts:364-375`). The views only add the scope-membership cut and a
   PIP-kind filter on their own copies.
3. The revoke state is not small. On the snapshot `memory_deny_memory` holds 13.2 M rows (8.5 M `record`, 4.7 M `source`)
   and `memory_deny_session` holds 117 k. They are read by primary-key seek per hit (`deny-read.ts:254` `denyLookup`,
   `:714` `sessionLookup`), never scanned. The design keeps that seek pattern and never joins them as a set.
   Measured in the bench: a join that drives the seek from the 13.5 k-row `memory_revoke_audience` set instead of from each hit
   cost > 400 ms per query (SQLite chose it on its own), so STEP 2 keeps per-hit seeks and never adds such a set join.
4. Owner-audience turn recall is not "every scope". It is the bot's membership set (`recall-membership.ts:68-160`), from 1 to
   87 scopes on the snapshot (127 ready views, mean 2.5 scopes). "All scopes" (1171) is measured as the upper bound and is the
   owner memory list case (`owner-list.ts:178`, already view-free).
5. The 1.0.19-1.0.22 schema validator accepts either the exact `memory_recall_*` object set or NONE (`schema.ts:2133-2143`).
   A partial drop is refused (`MEMORY_SCHEMA_UNSUPPORTED`). This decides the migration (below).

## Shape
- Index: unchanged memory-index.db tables. One row set per record version: `entries`, `lexical`, `postings`, `vectors`.
  Written by the existing index worker on the record's own change (`worker.ts`, `purgeRecords`). There is no view, generation or
  reader column.
- Reader scope set: computed per turn from the committed roster and bindings by `recallMembershipSteps`
  (`recall-membership.ts:68`), held on the access object, and NEVER persisted. The cost is O(roster) per turn, the same walk
  that today decides which view to build. A roster change or epoch bump changes the next computed set and writes nothing.
- Query: `lexicalPage` (`index-reader.ts:321`, `RECALL_SEARCH_SQL :54`, `scope_id IN json_each(set)`) with `recallTerms` /
  `planRecall` rare-word selection. For narrow sets (≤ 10 scopes) candidates come from `postings(term, scope)`
  (`index-reader.ts:111-140`). Then the eligibility scan `scanEligibleSql` (`index-reader.ts:374`) on `authority`, then
  `readableMemoryRecord` for the reader-specific rules (lineage, withheld lines, identity, sessions).
- Visibility tables read at query time (all by key): `memory_deny` (110 rows), `memory_deny_memory` / `_session` / `_line` /
  `_range` (seek), `memory_tombstones` (8.7 k), `memory_scopes` / `memory_scope_bindings`, and the exclusion list (below).

## Contract with q1023-denyrule (MAIN-RULING 2026-11-26T14:58:27Z)
Owners: the reader scope set + index + query plan side = q1023-oneindex; the revoke/deny storage + its per-hit predicate side =
q1023-denyrule. ONEINDEX needs exactly one thing from the deny side: a per-hit predicate (record or source id+version, reader
session) that answers by key seek, with no set join and no per-reader copy. Today that is `denyLookup`/`sessionLookup` over
`memory_deny_memory`/`_session` (13.2 M rows, 44 rows per object). If denyrule replaces those rows with rules, only the
predicate body changes. This design's scope cut, index and migration do not depend on how deny is stored, and the R3 witnesses
are shared by both lanes.

## Every reader/writer of the views and its replacement
| site (file:line) | today | replacement |
|---|---|---|
| `recall-view.ts` build/oracle `:249` `:341`, applier `:790` `:1667`, publish `:990`, hydrate `:1069`, prepare `:1248`, roster prep `:1570`, idle upkeep `:1904`, reclaim/quota `:2016` `:2165-2351` `:2401`, migrations M3/M4 `:686` `:699` | builds and maintains per-view copies | deleted (whole file) |
| `recall-view-index.ts` eligible `:75`, recent `:81`, pending `:88`, catch-up `:112`, lexical `:126`, frame `:176` | page readers over view copies | eligible -> `eligibleAfter` scope branch (`eligibility.ts:39`, `:63`); lexical -> `lexicalPage`; recent/frame -> `memory_records ... scope_id IN set`; pending -> `pendingProjectionRefsAfter` scope-array overload (`projection.ts:48`); file deleted |
| `eligibility.ts:58,60,75,76` | view branch | scope branch only (`:63`) |
| `search.ts:120,368,383` (turn + tool recall) | view handle | scope set from the access object |
| `recent.ts:52,81,137` | view recent | scoped recent |
| `bundle.ts:329` (PIP identity frame) | view frame | scoped non-FTS read of PIP kinds on `authority` (PIP never enters the index) |
| `bundle.ts:706` (membership) | view scopes | computed set |
| `projection.ts:49` | view pending | scope overload |
| `jobs.ts:264-275` (turn catch-up claim) | view jobs | `memoryClaimIndex.recent(scopeIds)` (`jobs.ts:277`) |
| `worker-query.ts:28` | budget class | budget class without view |
| `policy.ts:599-601`, `:714-715`, `:729-738`, `:760-764`, `:845-852` | thread readers, room flag, `memoryAccess`, revalidate, `assertMemoryAccess` | computed set + room flag on the access object; `memoryReaderDenied` (`deny.ts:44`) unchanged |
| `deny-read.ts:1275` `lineageAudienceHasScope` | probes `view_scopes` | probes the computed set |
| `session-proof.ts:115,188,215` | room_reader, epoch, `recallViewContains` | room flag + computed set; containment = set inclusion |
| `store.ts:1891,1896,1899,1997`, `capture.ts:443`, `policy.ts:399,401`, `index.ts:3940,3946,7119,7127` | rebuild triggers / rebuild waits | deleted (nothing to rebuild; no banner) |
| `memory-revocation.ts:916-920` | drains view terms on forget | deleted; the index purge of the record stays |
| `scope-insert.ts:19` | undoes epoch bump | deleted with the epoch trigger |
| `recall-producers.ts:77,118,133,143`, `worker-controller.ts:154,2339,2383`, `memory-revocation.ts:290` | journal feed for the applier | deleted with `memory_recall_changes` |
| `readable.ts:73`, `recall-membership.ts:128` | read `memory_recall_excluded` | read `memory_excluded_threads` (same trigger-maintained content, see Migration) |
| `audience-cache.ts:36,43,50`, `wake.ts:287-309,524`, `pip-reflect.ts:761-766`, `policy.ts:832-834,1019`, `store.ts:2062-2127` | read authority_epoch / roster revision | roster revision stays the in-memory counter (`store.ts:1993`) for cache keys; `authority_epoch` reads move to `memory_meta.policy_revision`/`deletion_epoch`, which already move on every authority change (`recall-view-schema.ts:76`) |
| open/restore/downgrade `schema.ts:4,2677,2827,2909,2942`, `restore.ts:170-173`, `database.ts:497`, `installation-memory-downgrade.ts:549`, `session-collector-matrix.ts:176` | ensure/validate/drop view schema | see Migration |

## Rules preserved (each with its witness; all must stay GREEN in STEP 2)
| rule | enforced after the change | witnesses at the recall API |
|---|---|---|
| R1 scope membership (owner vs bot vs person, room, grants, exclusions) | computed set, `scope_id IN set` in `RECALL_SEARCH_SQL` and `scanEligibleSql` | `recall-both-ways.test.ts` (all 8), `xthread-audience-recall.test.ts:37,67`, `shared-bots-leak.test.ts:84`, `recall-partitions.test.ts:28,100`, `recall-membership-nonowner-1021.test.ts:192,221` |
| R2 deny (deleted thread/bot/scope) | `DENIED_RECORD_SCOPE`, `DENIED_SOURCE`, `memoryReaderDenied`: unchanged | `bot-deletion-scoped.test.ts:67,83,165`, `xthread-audience-recall.test.ts:107` |
| R3 revoke (receipts, sessions, lines, ranges) | `denyLookup` / `sessionLookup` seeks, unchanged; `lineageAudienceHasScope` on the computed set | `revoke-targeted.test.ts:104,125,136`, `roster-scoped-revokes.test.ts:200,267`, `deny-read.test.ts:80`, `audience-late-revoke-lastresort.test.ts`, `recall-store-revocations.test.ts:27` |
| R4 forget / delete (record + source tombstones, deleted source, ancestry) | `REACHABLE_RECORD`, `evidenceStanding`, `DIRECT_ANCESTRY`, `readableMemoryRecord`; index purge of the record | `forget-scrub.test.ts` S1-S5, `lam-forget-r5.test.ts` 1-6, `forget-pin.test.ts:82-121`, `forget-epoch-bump.test.ts` E1/E2, `recall-authority-pins.test.ts:54`, final `searchMemory` assertion of `recall-view-deleted-source.test.ts:20` (kept, retargeted) |
| R5 PIP kinds never recalled through search | `kind NOT IN PIP_ALL_KINDS_SQL` in `CURRENT_MEMORY`; `purgeRecords(pipRecordIds())` (`worker.ts:625`) keeps them out of the index | `pip-p2-b1.test.ts:249`, `recall-authority-pins.test.ts:50`, `recall-f062b-identity.test.ts:24` |
| R6 owner thread exclusion | `memory_excluded_threads` (renamed, same trigger) | the `EXCLUDED_THREAD_SOURCE` users' tests (listed in STEP 2 SITES.md) |

Retargeted (not deleted): `shared-bots-leak.test.ts:97`, `deny-read-pass.test.ts:100` and `recall-store-revocations.test.ts:73`
read `view_scopes` and move to the computed set. The census in `pip-p2-b1.test.ts:123` drops the two recall-view files.
Retired with the code: `recall-view*.test.ts`, `recall-reclaim*`, `recall-upkeep*`, `recallperf-1022`, `recall-change-set`,
`migration-v2-kill*` (M4) and `upgrade-catchup*`. API tests that use `prepareRecallContextSync` only as a fixture get a fixture
swap. The total is 123 test files referencing views; the STEP 2 SITES.md lists each one as RETIRED, RETARGETED or FIXTURE-SWAP.

## Measured (11-26 snapshot copy, read-only; scratch index built from its 109,574 active+candidate records)
Method: the production SQL text (`RECALL_SEARCH_SQL`, `scanEligibleSql(false)` with `CURRENT_MEMORY`, `REACHABLE_RECORD`,
evidence, ancestry) was extracted from this tree, not retyped, and run on node:sqlite. Queries are the 300 most recent real
owner messages. Reader sets are the production-computed sets of the snapshot's ready views plus the all-scopes upper bound.
The limit is 20 eligible hits in pages of 50. Bench and logs live in the lane job dir (not in the tree).

| reader (scopes) | path | p50 ms | p95 ms | max ms |
|---|---|---|---|---|
| owner, all scopes (1171) | page + rare words | 10.7 | 15.8 | 17.4 |
| bot view (87) | page + rare words | 12.3 | 17.9 | 30.2 |
| bot view (42) | page + rare words | 18.3 | 33.2 | 52.3 |
| bot view (5) | page + rare words | 57.4 | 92.4 | 112.8 |
| bot view (1) | page + rare words | 57.2 | 91.0 | 100.5 |
| bot view (5) | postings + rare words | 4.9 | 20.3 | 31.7 |
| bot view (1) | postings + rare words | 2.0 | 6.9 | 13.0 |
| bot view (1-5) | page, ALL words (no rare-word cut) | 160-162 | 218-221 | 328 |

Writes per query: 0. Both handles are read-only with `query_only`, and file size and mtime were unchanged across 4,200 queries.
Requirement that follows: narrow readers MUST use the rare-word plan and postings. The plain all-words page misses the target
(p95 ≈ 220 ms) because FTS5 ranks the whole cross-scope match set before the scope cut.
Not measured: the vector half (no embedding model in the bench). Vectors are scored over the eligible set already
(`index.ts:71-85`, resident cap 64 MiB) and are unchanged by this design. STEP 2 adds a turn-level p95 row that includes them.

## Write cost per memory change
Unit of work = one record version changed (insert, edit, forget). Rows written: its `entries` row, its FTS5 doclist entries,
its `postings(term, scope, seq)` rows (one per distinct word), its vectors, and the delete of the old version's rows.
Nothing else is written, for any number of readers. Measured on a writable scratch copy of the index (206 MB), WAL frames
of 4 KiB pages: 1 edit = 32 frames (132 KiB). 10 edits in one transaction = 666 frames (270 KiB/edit). 100 edits = 4,472
frames (184 KiB/edit). FTS5 segment merges dominate, and merges are already metered by `index_meta merge_owed` (`index.ts:261`).
For comparison, today one change fans out to 31.4 `view_terms` rows per record per view × 1.24 views per scope (max 10)
plus records/pending/jobs rows (61,653 `view_jobs` rows on the snapshot), and every authority-epoch or roster bump rebuilds
whole views (520,396 term rows on the snapshot).
Trigger paths (DESIGNS rule), one witness row each in STEP 2, fixtures N=10 and N=1000 records:
warm hit (no write), miss (no write), foreign commit (no write), record edit (own rows only), forget (own rows purged,
`secure_delete` as today), roster change (0 index writes), authority/epoch change (0 index writes), restart (0 index writes, no
banner), upgrade from 1.0.22 (one drop, below), downgrade to 1.0.22 (it recreates its views and rebuilds them itself).
Idle-write budget: index writes happen only on record changes. Idle upkeep, reclaim and quota loops are deleted, so idle =
0 B/min absent memory changes. STEP 2 measures this with the existing idle-writes harness (< 1 MB/min) and the turn harness (≤ 20 MB).

## Migration: drop every view object in one step at open
- At open (`schema.ts`, the same-version and upgrade paths), in ONE transaction: create `memory_excluded_threads` and fill it
  from the owner-settings binding (the `recall-view-schema.ts:344` statement), with its trigger (`:66-67` body). Then drop EVERY
  `memory_recall_*` table, index and trigger, including the external triggers on `memory_records` / `memory_scopes` /
  `memory_scope_bindings` / `memory_meta` / `team_identities` / `project_settings` (`recall-view-schema.ts:51-76`, `:406-416`,
  i.e. `dropRecallViewSchema` `:397`) and the TEMP `recall_built_1022_*` triggers.
  Then delete the `transcript_index_state` view notes. Bump `MEMORY_SCHEMA_VERSION` 13 -> 14 (`schema.ts:1607`).
  (Proposal: `authority_epoch` readers move to `memory_meta.policy_revision`/`deletion_epoch`. STEP 2 SITES.md proves each
  one per site, or keeps a non-`memory_recall_` epoch row.)
- Forget safety: dropping `memory_recall_view_terms` removes the only per-view word copies. To match `dropLeftoverRecallViews`
  (`:292-319`), the drop runs with `secure_delete` on. While forget work is owed (`forgetWorkOwed`, `recall-view-schema.ts`) it still drops.
  There is no copy left to scrub, so deferral is not needed. Freed pages are zeroed by `secure_delete`, so a forgotten record's
  words do not survive in free pages.
- Downgrade (1.0.22 and older): the file has no `memory_recall_*` object, which the old validator accepts
  (`schema.ts:2133-2143`). It recreates and rebuilds its views itself. `memory_excluded_threads` is ignored by old builds;
  they rebuild `memory_recall_excluded` from the binding (`:344`). NOT VERIFIED in STEP 1: how a 1.0.22 build treats
  `schema_version` 14. STEP 2 adds the 14 -> 13 row to `installation-memory-downgrade.ts:549` and witness W9 runs it.
- Failure path: a crash mid-migration rolls the one transaction back, so the file stays at 13 with views intact. The next open
  retries. Disk-full fails closed to the same state (the open fails as any schema error does today; STEP 2 witnesses the
  owner-visible outcome). It never leaves a half-dropped schema.

## STEP 2 witness list (all RED on base 0e6228fcf8, through the production entry point)
W1 no view table after open (open -> `sqlite_schema` has no `memory_recall_*`). W2 roster change then turn: 0 index writes, no
banner. W3 epoch bump then turn: 0 writes, no banner. W4 record edit writes only its own rows (`entries`/`postings` diff
N=10, N=1000). W5 first turn after restart shows no banner. W6 idle writes < 1 MB/min. W7 turn ≤ 20 MB. W8 recall p95 < 150 ms
on the real copy (owner + narrow bot). W9 downgrade-open by the 1.0.22 validator accepts the file. R1-R6 tests stay GREEN.
Mutants per witness: targeted + REVERT/NOOP/DROP, receipts machine-checked (receipts.tsv).

## GAP-CHECK (one pass)
Fixed:
- (b) failure path. A crash mid-drop would leave a partial `memory_recall_*` set that every old build refuses. Fix: one
  transaction plus the schema bump (Migration).
- (d) data/privacy. Dropping the term copies while forget work is owed could leave forgotten words in free pages. Fix:
  `secure_delete` on the drop (Migration).
- (a) purpose gap. A narrow reader on the plain page path misses P3 (measured p95 ≈ 220 ms). Fix: rare-word plan + postings
  are required for narrow sets (Measured).
- (d) data. Dropping `memory_recall_excluded` would lose the owner's exclusion list for `readable.ts:73`. Fix: renamed
  table with the same trigger (Migration, R6).
Parked:
- Vector-half latency is not in the bench (no model offline). It is unchanged by this design and measured in STEP 2 W8.
- Whether `memory_recall_epoch` / `memory_recall_roster_proof` readers outside recall need a non-recall home is listed per site in
  STEP 2 SITES.md. All of them are inside the `memory_recall_*` drop, so none can stay under its old name.

## STEP 2 revision: FABLE ONEINDEX 62856597bf BLOCK (4 High, 4 Medium) + MAIN rulings, folded (supersedes the sections above where they differ)
Owners: unchanged (header). These rulings postdate the STEP 2 GO and win over the GO text where they differ (the GO said 13 -> 14).
- H2 (RULING) NO schema version bump and NO new table. `MEMORY_SCHEMA_VERSION` stays 13 (a 1.0.22 build throws MEMORY_SCHEMA_NEWER
  above 13, `schema.ts:2173-2178`). `memory_excluded_threads` is DROPPED from this design: both readers of `memory_recall_excluded`
  read the committed owner-settings binding directly (`deny.ts` `threadExcluded`). DONE for `recall-membership.ts` `excluded`.
  OPEN for `readable.ts` `EXCLUDED_THREAD_SOURCE`: the inline binding/json_each form turned `room-session-proof.test.ts`
  "T-LONG acp 3000" RED ("fixture reference was not recalled"; GREEN on d7545553b3 and again once reverted), so it stays on
  `memory_recall_excluded` until a per-row-cheap form is found (e.g. the excluded list bound once per read as a json parameter). The drop of every `memory_recall_*` object stays legal for 1.0.22
  (none-or-exact, `schema.ts:2133-2143`); W9 = open with the 1.0.22 validator after a 1.0.23 open.
- H1 (RULING) mid-turn revoke fence. The `memory_recall_epoch` triggers (`recall-view-schema.ts:62-76`, `:406-407`) move under a
  non-recall name with the same events, re-checked in every `assertMemoryAccess`. With H2 (no new table) the row lives in an EXISTING
  table: proposal `transcript_index_state` row name `memory-authority-epoch` (`cursor` = epoch), triggers `memory_authority_epoch_*`.
  OPEN for STEP 2 (verify before building): the 1.0.22 validator must accept extra non-`memory_recall_` triggers on
  `memory_scopes` / `memory_scope_bindings` / `memory_meta`; if it does not, this is FABLE-DESIGN NEEDED (no fail-closed one-liner).
  Witness: a revoke committed mid-turn -> the next read of that turn returns no hit of the revoked scope.
- H3 (RULING) lineage-only scopes: recall reads records of `lineage_only=0` scopes only. DONE in `oneindex.ts` (`RecallScopeSet.scopes`
  = full reach; `.lineage` is only for `recallScopesHave(..., lineage=true)` probes), equal to the view's records phase
  (`recall-view.ts:946` `v.lineage_only=0`). Witness still owed: a person lineage scope never reaches bot recall.
- H4 (RULING) index readiness: when `memoryIndexReaderState()` is missing/unreadable/blocked or the scope is owed postings, recall
  answers from a bounded message-text keyword search (same RecallWorkBudget), never empty, never the left-out banner. Measure the
  real index state on the copy first. Witness: index missing at start -> first owner turn recall not empty, no banner.
- M5 keep the issued-AND-current scope intersection (`policy.ts:767-768`, `:849`): `recallScopesNotWider` (oneindex.ts) is its
  computed-set form. M6 measure 11+ scopes and the 64-scope cap on a 2x synthetic store. M7 measure drop-at-open with
  `secure_delete` and owed forget work; WAL under 512 MiB, chunk if needed. M8 idle witness starts from a store WITH index debt and
  reports idle bytes until the debt is 0 and after.

### STEP 2 status (seat q1023-oneindex-r3, PARTIAL)
- Built: `server/memory/oneindex.ts` (computed reader scope set, 0 writes; recent/frame/eligible/pending scope-set pages) with
  `oneindex.test.ts` proving each equals the view reader it replaces (R1, direct + room, owner + not-owner). The membership exclusion reader moved
  to the binding (H2); `readable.ts` stays (see H2). NOT yet wired: `MemoryAccess.view` is still issued from a built view; SITES.md (lane job dir) lists 87 production
  rows (32 UNCOVERED by the table above) and 139 test files.
- Real-copy base RED (bannergate rig, resume-active, base 0e6228fcf8): recall=held 12/12, left-out-log 3, turn writes 94.2 MiB/min,
  idle 867 MiB in 10 min; starts 1+2 exit 0 (witness (d) is a regression guard: GREEN on base).
