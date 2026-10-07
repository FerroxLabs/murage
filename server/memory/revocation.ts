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
  const result = db.prepare(`WITH RECURSIVE affected(id) AS (
      SELECT value FROM json_each(?1)
      UNION SELECT d.child_id FROM memory_derivations d JOIN affected a ON d.parent_id=a.id
    ), sources(id) AS (
      SELECT value FROM json_each(?2)
      UNION SELECT e.source_id FROM memory_evidence e WHERE ?3=1 AND e.record_id IN (SELECT id FROM affected)
    ) UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked' AND (
      EXISTS (SELECT 1 FROM json_each(memory_disclosures.record_versions) j WHERE json_extract(j.value,'$.id') IN (SELECT id FROM affected))
      OR EXISTS (SELECT 1 FROM json_each(memory_disclosures.source_versions) j WHERE json_extract(j.value,'$.id') IN (SELECT id FROM sources)))`)
    .run(JSON.stringify(recordIds), JSON.stringify(sourceIds), viaSources);
  return noteRevocation("records", cause, Number(result.changes));
}
