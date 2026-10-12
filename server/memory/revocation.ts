// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Offline-safe: no runtime configuration, Store or provider imports (restore.ts uses it).
import type { DatabaseSync } from "node:sqlite";

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
  return count;
}

export function revokeAllDisclosures(db: DatabaseSync, cause: string, options: { includeRevoked?: boolean } = {}): number {
  const sql = options.includeRevoked ? "UPDATE memory_disclosures SET state='revoked'" : "UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked'";
  return noteRevocation("global", cause, Number(db.prepare(sql).run().changes));
}

export function revokeThreadDisclosures(db: DatabaseSync, threadId: string, cause: string, options: { includeRevoked?: boolean } = {}): number {
  const sql = options.includeRevoked
    ? "UPDATE memory_disclosures SET state='revoked' WHERE thread_id=?"
    : "UPDATE memory_disclosures SET state='revoked' WHERE thread_id=? AND state!='revoked'";
  return noteRevocation("thread", cause, Number(db.prepare(sql).run(threadId).changes));
}

export function revokeRecordDisclosures(db: DatabaseSync, cause: string, affected: { recordIds?: readonly string[]; sourceIds?: readonly string[]; viaSources?: boolean }): number {
  const recordIds = [...new Set(affected.recordIds ?? [])], sourceIds = [...new Set(affected.sourceIds ?? [])];
  if (!recordIds.length && !sourceIds.length) return noteRevocation("records", cause, 0);
  // A record's words also travel in its evidence sources: a session may have
  // been shown the reply R was extracted from (a quoted reply, working
  // context, a :lookup companion) without ever citing R. So the receipts
  // that cite any evidence source of an affected record, at any version and
  // in any thread, end too. Only writers that change nothing a session was
  // shown (approving a candidate, a pin flag) pass viaSources: false.
  const viaSources = affected.viaSources !== false ? 1 : 0;
  // memory_disclosure_refs (schema v8) holds, for every receipt not yet
  // revoked, exactly the ids its JSON names, so this reads the receipts that
  // cite an affected id instead of parsing every receipt ever written (F6).
  // Same receipts, same transaction: the old scan is kept as
  // RECORD_REVOCATION_SCAN_SQL and the equivalence tests run both. The index
  // is read only once its backfill finished and was proven (ready), and only
  // for string ids: the index lookup is exact for those (see the statement),
  // and any other id, which no caller passes, takes the 1.0.1 scan.
  const indexed = revocationIndexReady(db) && recordIds.every(id => typeof id === "string") && sourceIds.every(id => typeof id === "string");
  const result = db.prepare(indexed ? RECORD_REVOCATION_SQL : RECORD_REVOCATION_SCAN_SQL).run(JSON.stringify(recordIds), JSON.stringify(sourceIds), viaSources);
  return noteRevocation("records", cause, Number(result.changes));
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
export const REF_MATCH = (ids: string) => `CAST(x.ref_id AS TEXT) IN (${ids}) AND +x.ref_id IN (${ids})`;
/** Every live receipt that cites an affected record or source, at any version, through the index. */
export const RECORD_REVOCATION_SQL = `${AFFECTED_CTE} UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked' AND bundle_id IN (
      SELECT x.bundle_id FROM memory_disclosure_refs x WHERE x.kind='record' AND ${REF_MATCH("SELECT id FROM affected")}
      UNION SELECT x.bundle_id FROM memory_disclosure_refs x WHERE x.kind='source' AND ${REF_MATCH("SELECT id FROM sources")})`;
/** The 1.0.1 statement, a scan of every receipt's JSON. Not used at run time: the reference the
 * equivalence tests hold the indexed statement to. */
export const RECORD_REVOCATION_SCAN_SQL = `${AFFECTED_CTE} UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked' AND (
      EXISTS (SELECT 1 FROM json_each(memory_disclosures.record_versions) j WHERE json_extract(j.value,'$.id') IN (SELECT id FROM affected))
      OR EXISTS (SELECT 1 FROM json_each(memory_disclosures.source_versions) j WHERE json_extract(j.value,'$.id') IN (SELECT id FROM sources)))`;
