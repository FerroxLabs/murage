# murage#18 (a) and (b): narrowing a line revoke, and the 1.0.2 cascade marks - design r1 (2026-10-26)

Branch fix/107-memory-recall-hydration (after the recall fix, which goes READY on its own). Rule from Main: agreed by Fable AND Grok before
any build; if it lands before the 1.0.7 publish it folds into v13 (no v14) and upgrade + downgrade are re-proven on the data copy; otherwise
1.0.8 as v14. (b) changes nothing until its rule is proven.

## (a) What the code does (int/107, verified)
- revoke-commit.ts line case: seeds the thread [T, rootLsn] (:173) and, when the message has a source, `scope:S` at rootLsn (:170-171).
- The explicit scope seed is redundant: schema.ts:264 memory_flow_capture writes T -> scope:S (first_lsn = the first capture) for every
  source captured from T, so the flow phase (revoke-marker.ts flowStep) reaches scope:S from the thread seed with since = max(first_lsn,
  rootLsn). Deleting :170-171 alone changes nothing measurable.
- The widening is the flow model itself: an edge X -> Y carries only first_lsn, so ANY edge whose first flow predates the revoke is followed,
  even when nothing flowed over it after since(X). From scope:S the closure then reaches every thread that ever read S (scope -> thread edges
  from lineage-write.ts carryOnto), and each gets a pending window: the whole bot reads "checking" until the last mark.
- After the 1.0.7 recall fix a scope window holds only objects created at or after its since, so this is now a freshness cost (new memory and
  new lines held during a revoke), not empty recall.

## (a) Design: the last flow of each edge (v13)
1. New v13 objects (beside memory_source_lsn, dropped by the same v13 -> v12 step, trigger first):
   `memory_thread_flow_last(from_thread TEXT NOT NULL, to_thread TEXT NOT NULL, last_lsn INTEGER NOT NULL, PRIMARY KEY(from_thread,to_thread)) WITHOUT ROWID`
   `memory_thread_flow_last_insert BEFORE INSERT ON memory_thread_flow BEGIN INSERT INTO memory_thread_flow_last VALUES(NEW.from_thread,NEW.to_thread,NEW.first_lsn) ON CONFLICT(from_thread,to_thread) DO UPDATE SET last_lsn=max(last_lsn,excluded.last_lsn); END`
   A BEFORE INSERT trigger runs for every row an `INSERT OR IGNORE` attempts, also when the row is then ignored as a duplicate, so every
   writer (lineage-write.ts SQL.flow, the six v10 memory_flow_* triggers, lineage-backfill.ts U1) records each flow's lsn without any v10
   object changing. NEW.first_lsn is the flow's own lsn for every writer (live: the lsn now; U1: the historic lsn). TO VERIFY in review:
   every writer passes the flow's lsn, never an older one.
2. flowStep follows an edge X -> Y unless its last row exists AND last_lsn < since(X). No row (an edge with no flow since the migration or
   the last re-upgrade) = unknown = followed, exactly as today. Soundness: content of X tainted from since(X) exists only at lsns >= since(X),
   so it can only have flowed over the edge at an lsn >= since(X); last_lsn < since(X) proves no such flow happened before the walk.
3. A flow over a skipped edge AFTER the flow phase: its writer is a lineage writer (carryOnto / captures / inheritEdge, DRAIN-104 2.11), which
   holds or marks the new child under the revoke from X's own pending row or marks at write (inheritMarks). TO VERIFY in review: every
   writer that inserts memory_thread_flow also runs inheritance for the same child in the same transaction (lineage-write.ts carryOnto does
   at :306; the v10 memory_flow_* triggers fire on capture, evidence, derivation, bring-in and scope moves: each must have an inheritEdge
   call site). Any writer without one keeps its edges always followed (excluded from the skip by from/to node shape).
4. Remove revoke-commit.ts:170-171 (redundant with the thread seed; with 2 it would re-open the scope the edge rule proved untouched).
   The source captured from the line is still reached exactly by the mark walk (line -> range -> captures -> source -> its records).
5. Downgrade v13 -> v12: drop trigger, then table. v12 writes flows without rows; the re-upgrade starts the table empty, so every edge is
   unknown = followed (never too low a last_lsn after a downgrade window).
6. Failure list: N1 a flow over an edge at lsn >= since keeps Y held. N2 an edge whose last flow < since is skipped and Y reads shown for
   objects that did not come from X. N3 a flow after the flow phase over a skipped edge holds the new child (inheritance) until the mark.
   N4 duplicate INSERT OR IGNORE moves last_lsn up. N5 no row = followed. N6 v13 -> v12 -> v13 starts empty, every edge followed. N7 the
   validator refuses a v13 file missing the table or trigger. N8 a line revoke of a captured line still marks its source and the records
   resting on it. N9 Sean's copy: windows reached before/after (counts only).

## (b) What 1.0.2 left (verified)
keepall-unwedge.ts repairs only audience-only deny_session marks on owner direct chats. It keeps non-audience session marks on purpose
(:16-18): a session begun after a commit may also be marked because it carried the revoked content, and the rows do not say which. The
issue's cascade also left deny_memory / deny_line / deny_range rows of 1.0.2 cascade revokes (the copy holds 6.7M deny_memory rows) that
nothing ever repairs, so memory a branch-switch never touched stays withheld for good.

## (b) Proposed rule (for Fable to accept, replace or reject; no deletion until agreed and proven)
A mark row of revoke R is removable only when R is provably a 1.0.2 cascade AND the row is provably not needed:
- R is cascade-born: its job row is gone or done, R is not audience-only, and R is an inherit job or one whose root cause is a line-kind
  owner action (branch-switch / regenerate / edit), as recorded in memory_revoke_jobs.root while the row existed. (OPEN: 1.0.2 keeps only
  the last job row; without the root most R are unattributable, and unattributable stays kept.)
- The row is not needed: re-deriving it with the 1.0.7 walker from R's root lines (the deny_line rows of R at their lsns, which 1.0.2 wrote
  first) does not produce it. Rows the re-walk produces stay; the rest go, in bounded slices, idempotent, logged with counts only.
If attribution cannot be proven for a row, it stays. Expected outcome to measure on the copy before any build: how many rows are
attributable at all. If the answer is "almost none", (b) becomes: keep every row, and make the withheld memory visible to the owner as
"held by an old revoke" with a one-click re-check that runs the re-walk for that one object (owner action, logged).

## Ask
Fable and Grok: AGREE / AGREE-WITH-CHANGES / BLOCK on (a) 1-6 and on whether the (b) rule is provable; name any flow writer that breaks (a) 3.

## r2 (Fable AGREE-WITH-CHANGES, Grok AGREE-WITH-CHANGES on r1; overrides r1 where they differ)
- R2.1 The stamp is the lsn counter AT THE FLOW, never the writer's lsn: some writers pass an old line lsn (an existing line quoted later,
  lineage-write.ts extendLineage / redelivery, Grok H1), currentLsn-1 (session and turn reads, Grok H2) or a sentinel (U1 OLD_EDGE_LSN /
  STALE_MEM_LSN / OLD_SESSION_LAST_LSN, Fable 1, Grok H3). Trigger body ignores NEW.first_lsn:
    `UPDATE memory_thread_flow_last SET last_lsn=max(last_lsn,(SELECT next FROM memory_lsn WHERE id=1)) WHERE from_thread=NEW.from_thread AND to_thread=NEW.to_thread;`
    `INSERT INTO memory_thread_flow_last(from_thread,to_thread,last_lsn) SELECT NEW.from_thread,NEW.to_thread,next FROM memory_lsn WHERE id=1 AND NOT EXISTS (SELECT 1 FROM memory_thread_flow_last WHERE from_thread=NEW.from_thread AND to_thread=NEW.to_thread);`
  Two statements that can never conflict (no UPSERT inside the trigger: an outer OR IGNORE or ON CONFLICT would override the inner conflict
  policy, Fable 4). Soundness: tainted content of X has lsn >= since(X) and < next at the moment it flows, so a flow of it stamps
  last_lsn >= next > since(X) - 1, i.e. last_lsn >= since(X): never skipped. A U1 edge inserted after v13 stamps "now": followed by every
  revoke whose since is at or below now, and skipped only by a later revoke, after which no historic flow can carry its content.
- R2.2 Keep revoke-commit.ts:170-171 (both reviewers): after a scope move the edge path gives since(newS) = move lsn, above the source's
  created lsn, so the recall fix would not hold the moved source; the seed costs one row.
- R2.3 scope -> scope edges (memory_flow_source_scope, memory_flow_record_scope, U1m) are always followed: those writers have no inheritEdge
  site (Grok Low, Fable 3). The skip applies only when from_thread or to_thread is not a `scope:` node.
- R2.4 Validator: the v13 accepted schema holds memory_thread_flow_last and memory_thread_flow_last_insert; a v13 file missing either is
  refused (N7). Downgrade v13 -> v12 drops trigger then table (beside memory_source_lsn).
- R2.5 Tests add: N4 a duplicate INSERT OR IGNORE and the backfill's outer ON CONFLICT DO UPDATE both raise last_lsn; N10 a writer passing an
  old lsn (quote of an existing line) or a sentinel still stamps the counter now; N11 a scope -> scope edge is followed whatever its last.
- R2.6 (b): NOT provable (both reviewers): job roots are pruned to the newest, deny_memory / deny_session carry no reason, inherit jobs carry
  cause "inherit" only. Every mark stays; keepall-unwedge.ts is unchanged. The fallback (owner-visible "held by an old revoke" plus a
  per-object re-check) is a new owner feature: a decision for Main/Sean, not built in this lane.

## r3 (build notes; Fable AGREE-WITH-CHANGES on r2, Grok r2 Highs answered by tests)
- Fable r2: trigger guarded `WHEN EXISTS (SELECT 1 FROM memory_lsn WHERE id=1)` (no counter: no row, followed; the writer's statement never
  fails); skip test strict, `last_lsn < since(X)`; the proof line is "last_lsn >= since(X) whenever tainted content flowed".
- Grok r2 High 1 (a duplicate INSERT OR IGNORE or the backfill's ON CONFLICT DO UPDATE does not run the trigger) and High 2 (a flow written
  inside a memory_flow_* trigger body does not fire it with recursive_triggers off): both disproved on SQLite as shipped, pinned by tests
  N4 (duplicate OR IGNORE and the FLOW_MIN upsert both move last_lsn up) and N4b (memory_flow_capture's own insert is stamped, also on a
  repeat capture). recursive_triggers governs a trigger firing itself, not one trigger's statement firing another table's trigger.
- Edges stored before v13 have no row and are followed (the skip never reads first_lsn).
