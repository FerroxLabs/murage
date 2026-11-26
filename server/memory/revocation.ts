// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Offline-safe: no runtime configuration, Store or provider imports (restore.ts uses it).
import type { DatabaseSync } from "node:sqlite";
import { deferRecordsScan, revokeRecordsBounded } from "./memory-revocation.ts";
import { commitRevoke, queuedFlipCites } from "./revoke-commit.ts";
import { wakeFlipMarker } from "./receipt-outputs.ts";
import { REF_MATCH } from "./revocation-ref-match.ts";
import { objectCarryThread } from "./lineage-types.ts";
import { threadNo } from "./thread-no.ts";

/** Disclosure receipt revocation, in three widths. Every writer that ends
 * receipts goes through here, so each event logs one line with ids and counts
 * only, never memory content.
 *
 * - global: a change to who may read what (policy, roster, identity of the
 *   owner or a team, a whole-memory restore). Every receipt on the machine ends.
 * - thread: a change to one conversation's transcript (a branch change). Every
 *   receipt of that thread ends.
 * - records: a change to specific records or sources (approve, correct,
 *   supersede, archive, restore an archived record, a learning undo, a
 *   tombstone). Only receipts that cite one of them, at any version, end; and
 *   receipts citing a record derived from one of them (memory_derivations,
 *   transitively), because a derived record's words rest on its parent's;
 *   and receipts citing an evidence source of any of those records, because
 *   the source carries the same words (a quoted reply, working context).
 *   A receipt that was never shown any of them still holds: what it cites is
 *   re-checked live on every continuation (disclosures.ts revokedReason). */
export type RevocationScope = "global" | "thread" | "records";

export function noteRevocation(scope: RevocationScope, cause: string, count: number): number {
  // stderr: a helper process that prints JSON on stdout (installation-selection) must stay parseable.
  console.warn(`memory receipts revoked scope=${scope} cause=${cause} count=${count}`);
  // The v10 flip trigger queued each receipt this just revoked; until the runner commits them as receipt roots their lines read "checking"
  // (a turn built meanwhile is refused at the send fence). Plain SQL here has no other wake, so the runner is woken (a no-op until started;
  // once the caller's transaction is over).
  if (count > 0) { try { wakeFlipMarker(); } catch { /* the next runner tick commits it */ } }
  return count;
}

/** The live receipts are the two states that are not 'revoked' (the CHECK on the column): written as a membership so the state index serves it
 * (a seek over the live rows) whether or not the late partial index memory_disclosures_live is built yet; `state!='revoked'` is a scan without it. */
const LIVE_REVOKE_SQL = "UPDATE memory_disclosures SET state='revoked' WHERE state IN ('prepared','delivered')";
export function revokeAllDisclosures(db: DatabaseSync, cause: string, options: { includeRevoked?: boolean } = {}): number {
  // write-time: the policy watermark (an audience reader loses every generated line whose ancestry used a receipt before now)
  commitRevoke(db, { kind: "policy", cause: "policy-bump" });
  const sql = options.includeRevoked ? "UPDATE memory_disclosures SET state='revoked'" : LIVE_REVOKE_SQL;
  return noteRevocation("global", cause, Number(db.prepare(sql).run().changes));
}

export function revokeThreadDisclosures(db: DatabaseSync, threadId: string, cause: string, options: { includeRevoked?: boolean } = {}): number {
  const sql = options.includeRevoked
    ? "UPDATE memory_disclosures SET state='revoked' WHERE thread_id=?"
    : "UPDATE memory_disclosures SET state='revoked' WHERE thread_id=? AND state!='revoked'";
  return noteRevocation("thread", cause, Number(db.prepare(sql).run(threadId).changes));
}

/** 1020 ROSTER: every live receipt that cites a record or a source held in one of `scopes` (an audience move of the bot or room that owns
 * them), in any thread. */
export function revokeScopeDisclosures(db: DatabaseSync, scopes: readonly string[], cause: string): number {
  const ids = JSON.stringify(scopes);
  return noteRevocation("records", cause, Number(db.prepare(`UPDATE memory_disclosures SET state='revoked' WHERE state IN ('prepared','delivered') AND (
    EXISTS (SELECT 1 FROM json_each(record_versions) j JOIN memory_records r ON r.id=json_extract(j.value,'$.id') WHERE r.scope_id IN (SELECT value FROM json_each(?1)))
    OR EXISTS (SELECT 1 FROM json_each(source_versions) j JOIN memory_sources s ON s.id=json_extract(j.value,'$.id') WHERE s.scope_id IN (SELECT value FROM json_each(?1))))`).run(ids).changes));
}

export function revokeRecordDisclosures(db: DatabaseSync, cause: string, affected: { recordIds?: readonly string[]; sourceIds?: readonly string[]; viaSources?: boolean; withdraws?: false;
  /** The one version of a record that was withdrawn, when its replacement keeps the same id (a changed notebook's chunks, import.ts): the
   * write-time revoke then names that version only, so the replacement is not denied with it. Receipts still end at any version (none can
   * cite the replacement yet: it is written in the same transaction). */
  versions?: Readonly<Record<string, number>>;
  /** 1.0.20 ctxrev-h1 (a changed notebook, import.ts): a receipt ends only by a record it cites, never by citing the notebook source or an
   * evidence source of an affected record. A notebook chunk's words reach a session only through a receipt that cites the chunk, so one
   * that cites only unchanged chunks keeps its turn; deny-read.ts contentReceiptVerdict still judges every source it cites live. */
  receiptsByRecordOnly?: true }): number {
  // A change that withdraws nothing any session was shown and adds nothing one must not keep (designs/MEMORY-CHANGED-RESET-106.md):
  // pinning (a mark is added, never removed), keeping a learned memory (its confirmation, not its words) and remembering a brand-new
  // record (nothing can cite an id that did not exist). No receipt ends and no write-time revoke is committed, so a warm engine
  // session stays warm; its next frame carries the change. Every other writer, unpin and undo included, keeps both.
  if (affected.withdraws === false) return noteRevocation("records", cause, 0);
  const recordIds = [...new Set(affected.recordIds ?? [])], sourceIds = [...new Set(affected.sourceIds ?? [])];
  if (!recordIds.length && !sourceIds.length) return noteRevocation("records", cause, 0);
  // write-time: what was shown from these records is withdrawn (a soft memory revoke per record: its citing receipts, those of the
  // records derived from it, their output lines and everything after them), unless the change shows nothing new (viaSources: false:
  // approving a candidate, a pin, a review keep). The record's own visibility stays its state's.
  let revokeId = 0;
  // 1.0.20 checkwin: a changed notebook's import withdraws chunks no session was shown (the storm: one import a minute, count=0). Each soft
  // revoke opens a "checking" window over every thread and scope until its marker closes it (revoke-commit.ts), so an unshown chunk opened
  // a window for nothing and, under a reclaim storm, kept every thread's recall withheld. An import revokes only what something was shown.
  const shown = cause === "import" ? importShownProbe(db, sourceIds) : null;
  if (affected.viaSources !== false) for (const id of recordIds) {
    if (typeof id !== "string") continue;
    if (shown && !shown(id)) continue;
    const version = affected.versions?.[id];
    const r = commitRevoke(db, { kind: "memory", ref: { kind: "record", id, ...(version !== undefined && version > 0 ? { version } : {}) }, cause: writetimeCause(cause) });
    revokeId ||= r;
  }
  // A record's words also travel in its evidence sources: a session may have
  // been shown the reply R was extracted from (a quoted reply, working
  // context, a :lookup companion) without ever citing R. So the receipts
  // that cite any evidence source of an affected record, at any version and
  // in any thread, end too. Only writers that change nothing a session was
  // shown (approving a candidate, a pin flag) pass viaSources: false.
  const viaSources = affected.viaSources !== false && !affected.receiptsByRecordOnly ? 1 : 0;
  if (affected.receiptsByRecordOnly) sourceIds.length = 0;
  // memory_disclosure_refs (schema v8) holds, for every receipt not yet
  // revoked, exactly the ids its JSON names, so this reads the receipts that
  // cite an affected id instead of parsing every receipt ever written (F6).
  // Same receipts, same transaction: the old scan is kept as
  // RECORD_REVOCATION_SCAN_SQL and the equivalence tests run both. The index
  // is read only once its backfill finished and was proven (ready), and only
  // for string ids: the index lookup is exact for those (see the statement),
  // and any other id, which no caller passes, takes the 1.0.1 scan.
  const indexed = revocationIndexReady(db) && recordIds.every(id => typeof id === "string") && sourceIds.every(id => typeof id === "string");
  // never the 1.0.1 scan of every receipt on a request: the request reads a bounded window of receipt rowids, and a durable job the
  // rest (memory-revocation.ts); the receipt checks re-test every cited record and source live meanwhile (disclosures.ts revokedReason)
  const deferred = indexed ? null : deferRecordsScan(db, { recordIds, sourceIds, via: viaSources as 0 | 1, cause });
  if (deferred) return noteRevocation("records", deferred.deferred ? `${cause}-deferred` : cause, deferred.revoked);
  if (!indexed) return noteRevocation("records", cause, Number(db.prepare(RECORD_REVOCATION_SCAN_SQL).run(JSON.stringify(recordIds), JSON.stringify(sourceIds), viaSources).changes));
  // through the index: the citing receipts of each affected id, INLINE_REVOCATION in this request and a durable job for the rest
  // (never one statement over every receipt that cites them); the receipt checks re-test what they cite live meanwhile
  return noteRevocation("records", cause, revokeRecordsBounded(db, cause, recordIds as string[], sourceIds as string[], viaSources === 1, revokeId || undefined));
}

/** Whether anything was ever shown a withdrawn import record (null: the file cannot tell, so every record is revoked, as before). A session
 * is shown a record only through a disclosure receipt (the file header); a live one is in memory_disclosure_refs (citing the record, or a
 * source its words travel in: the import's own sources and the record's evidence sources), a revoked one hangs a consumer edge on each item
 * it cites (revoke-commit.ts holdRevokedReceipt) or on the kind's wildcard, and one whose flip is not drained yet sits in
 * memory_receipt_flips (tested by what its receipt cites: revoke-commit.ts queuedFlipCites). A record derived from it carries its words
 * further: shown, fail closed. Any wildcard hold, or a queued flip that cannot be read, answers "shown" for every record (withholds more,
 * never less). Bounded: index seeks per record, never a scan of the receipts. */
function importShownProbe(db: DatabaseSync, sourceIds: readonly string[]): ((id: string) => boolean) | null {
  try {
    if (!revocationIndexReady(db)) return null;
    const carried = (kind: "record" | "source", id: string) => {
      const no = threadNo(db, objectCarryThread({ kind, id }));
      return no !== null && Boolean(db.prepare("SELECT 1 AS x FROM memory_lineage_carry WHERE parent_thread_no=? LIMIT 1").get(no));
    };
    if (carried("record", "*") || carried("source", "*")) return null;
    // 1.0.21 mem-f3 c: a queued flip is tested by what ITS receipt cites, not as "any flip": one flip waiting made every chunk of every
    // re-import "shown", so each changed chunk opened a machine-wide window. A flip that cannot be read still answers for everything (null).
    const flipped = queuedFlipCites(db);
    if (!flipped) return null;
    const live = db.prepare(`SELECT 1 AS x FROM memory_disclosure_refs x WHERE x.kind=?2 AND ${REF_MATCH("SELECT ?1")} LIMIT 1`);
    const sourceShown = new Map<string, boolean>();
    const source = (id: string) => {
      let v = sourceShown.get(id);
      if (v === undefined) sourceShown.set(id, v = Boolean(live.get(id, "source")) || flipped.sources.has(id) || carried("source", id));
      return v;
    };
    if (sourceIds.some(source)) return () => true;
    const evidence = db.prepare("SELECT DISTINCT source_id AS s FROM memory_evidence WHERE record_id=?");
    const derived = db.prepare("SELECT 1 AS x FROM memory_derivations WHERE parent_id=? LIMIT 1");
    return id => Boolean(live.get(id, "record")) || flipped.records.has(id) || carried("record", id) || Boolean(derived.get(id))
      || (evidence.all(id) as Array<{ s: unknown }>).some(row => typeof row.s !== "string" || source(row.s));
  } catch { return null; } // a table missing on an older file: revoke every record, as before
}
/** The write-time cause of a records revocation (lineage-types.ts RevokeRoot memory causes; none of these removes the record). */
function writetimeCause(cause: string): "archive" | "correct" | "revise" {
  if (cause === "archive") return "archive";
  return /correct/.test(cause) ? "correct" : "revise";
}
/** The affected record ids (?1, plus every record derived from one, transitively) and source
 * ids (?2, plus, when ?3=1, every evidence source of an affected record). */
const AFFECTED_CTE = `WITH RECURSIVE affected(id) AS (
      SELECT value FROM json_each(?1)
      UNION SELECT d.child_id FROM memory_derivations d JOIN affected a ON d.parent_id=a.id
    ), sources(id) AS (
      SELECT value FROM json_each(?2)
      UNION SELECT e.source_id FROM memory_evidence e WHERE ?3=1 AND e.record_id IN (SELECT id FROM affected)
    )`;
/** Whether memory_disclosure_refs is complete and proven equal to the receipts' JSON (schema v8,
 * memory_revocation_index_build.ready). False on an older file, during the start-up backfill after an
 * upgrade, and on any file without the flag row: revocation then reads the JSON as 1.0.1 did. */
export function revocationIndexReady(db: DatabaseSync): boolean {
  try { return Number(db.prepare("SELECT ready FROM memory_revocation_index_build WHERE id=1").get()?.ready) === 1; }
  catch { return false; } // no such table: a file below v8
}

/** How an index read stays the same comparison as the JSON scan. json_extract(...) has no affinity;
 * the untyped ref columns have BLOB affinity, and a comparison of a BLOB-affinity column with a TEXT
 * id column converts neither side, so a cited number 1 would no longer equal the record id '1'. Each
 * statement therefore compares `+x.ref_id` / `+x.ref_version` (the unary + drops the affinity) where
 * the scan compared json_extract, which makes the comparison identical. Those cannot use an index, so
 * each also requires CAST(x.ref_id AS TEXT) to equal the id, which the expression index answers. That
 * extra term is implied by the exact one whenever the ids it is compared with are text: under TEXT
 * affinity a cited value equals text t only when its text form is t, and with no conversion only when
 * it is that same text. Every id column is TEXT (a TEXT column stores no numbers), and the ids bound
 * from JS are checked to be strings above, so the term only narrows, never changes, the result. */
// (defined in revocation-ref-match.ts, a module with no imports: restore.ts builds SQL from it while it loads, and this module sits in an import cycle with restore.ts)
export { REF_MATCH };
/** Every live receipt that cites an affected record or source, at any version, through the index. */
export const RECORD_REVOCATION_SQL = `${AFFECTED_CTE} UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked' AND bundle_id IN (
      SELECT x.bundle_id FROM memory_disclosure_refs x WHERE x.kind='record' AND ${REF_MATCH("SELECT id FROM affected")}
      UNION SELECT x.bundle_id FROM memory_disclosure_refs x WHERE x.kind='source' AND ${REF_MATCH("SELECT id FROM sources")})`;
/** The 1.0.1 statement, a scan of every receipt's JSON. Not used at run time: the reference the
 * equivalence tests hold the indexed statement to. */
export const RECORD_REVOCATION_SCAN_SQL = `${AFFECTED_CTE} UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked' AND (
      EXISTS (SELECT 1 FROM json_each(memory_disclosures.record_versions) j WHERE json_extract(j.value,'$.id') IN (SELECT id FROM affected))
      OR EXISTS (SELECT 1 FROM json_each(memory_disclosures.source_versions) j WHERE json_extract(j.value,'$.id') IN (SELECT id FROM sources)))`;
/** One record's versions, and every version derived from one (bound: the record id). */
export const RECORD_TOMBSTONE_AFFECTED=`WITH RECURSIVE affected(id,version) AS (
      SELECT id,version FROM memory_records WHERE id=?
      UNION SELECT d.child_id,d.child_version FROM memory_derivations d JOIN affected a ON d.parent_id=a.id AND d.parent_version=a.version)`;
/** The 1.0.1 scan form of restore.ts RECORD_TOMBSTONE_REVOCATION_TAIL (after RECORD_TOMBSTONE_AFFECTED). */
export const RECORD_TOMBSTONE_REVOCATION_SCAN_TAIL = `UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked' AND (EXISTS (
    SELECT 1 FROM json_each(memory_disclosures.record_versions) j WHERE json_extract(j.value,'$.id') IN (SELECT id FROM affected))
    OR EXISTS (SELECT 1 FROM json_each(memory_disclosures.source_versions) j WHERE json_extract(j.value,'$.id') IN (
      SELECT e.source_id FROM memory_evidence e JOIN affected a ON e.record_id=a.id AND e.record_version=a.version)))`;
