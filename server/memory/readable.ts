// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one answer to "may this reader read this record version now". memory_get (routes.ts), bundle hydration
// (bundle.ts) and every search path (search.ts: helper, word index, recent fallback, keyword fallback, historical)
// call readableMemoryRecord and nothing else decides. Before this, search re-implemented the checks one at a time and
// kept missing some (msearch review rounds 1 and 2: identity ownership, derivation ancestry, evidence scope, evidence
// presence and span, source tombstones, failed tools).
//
// Modes differ only in what history means, never in authorization:
//  - current:    the active version, its evidence at the source's current revision, its ancestry standing now;
//  - disclosed:  as current, and an archived version a turn was already shown (a rolled thread checkpoint);
//  - historical: active, archived or superseded versions, evidence at the revision it was taken from (the source
//                retired or edited since, never deleted or forgotten), ancestors archived or superseded since.
// In every mode a forgotten record, a forgotten ancestor, a forgotten or deleted source, evidence in a scope the reader
// cannot reach, a failed tool's output as a fact, a broken span, a withheld reply and another bot's private identity
// are refused.
import type { MemoryEvidenceHandle } from "../../shared/memory.ts";
import { database } from "../database.ts";
import { humanMayReadRecord } from "../human-principals.ts";
import { unsettledIntention } from "./checkpoints.ts";
import { isPipKind } from "./pip-kinds.ts";
import { assertMemoryAccess, identityRecordReadable, type MemoryAccess } from "./policy.ts";
import { derivationAncestryCurrent, recordRestsOnWithheldMessage } from "./replay-lineage.ts";

export type MemoryReadMode = "current" | "disclosed" | "historical";
export type MemoryRefusal = "MEMORY_RECORD_UNAVAILABLE" | "MEMORY_SCOPE_DENIED" | "MEMORY_EVIDENCE_UNAVAILABLE";
export interface ReadableMemory {
  row: Record<string, unknown>;
  details?: { partition: unknown; confidence_basis: unknown };
  evidence: MemoryEvidenceHandle[];
  /** The `occurredAt` of each evidence source version, in `evidence` order (search shows it; memory_get does not). */
  occurredAt: unknown[];
  sourceOutcome?: "failed";
}
export interface MemoryReadOptions {
  mode?: MemoryReadMode;
  /** A bot's own tools (memory_get, memory_search): owner-authored continuity reaches the bot only through the frame (PIP A1). */
  agent?: boolean;
  /** The reader's transcript rule (disclosures.ts readerWithheldMessage): a line it may not be shown is not read either. */
  withheldMessage?: (threadId: string, messageId: string) => boolean;
}

/** The version lookup per mode: the state filter is part of the statement (the session checks count these by text). */
const RECORD_SQL: Record<MemoryReadMode, string> = {
  current: "SELECT * FROM memory_records WHERE id=? AND version=? AND state='active'",
  disclosed: "SELECT * FROM memory_records WHERE id=? AND version=? AND state IN ('active','archived')",
  historical: "SELECT * FROM memory_records WHERE id=? AND version=? AND state IN ('active','archived','superseded')",
};
const FAILED_KINDS = new Set(["source", "fact", "checkpoint"]);

/** The record version as this reader may read it, or why not. Revocation of the reader itself (capability, policy
 * revision, deletion epoch) and a record outside the reader's scopes throw (fail closed: a hit in a scope the reader
 * was never given is an integrity fault, not a miss); every other refusal is returned. */
export function readableMemoryRecord(id: string, version: number, access: MemoryAccess, options: MemoryReadOptions = {}): ReadableMemory | MemoryRefusal {
  const mode = options.mode ?? "current";
  assertMemoryAccess(access);
  const db = database();
  const row = db.prepare(RECORD_SQL[mode]).get(id, version);
  if (!row) return "MEMORY_RECORD_UNAVAILABLE";
  if (db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(id, version)) return "MEMORY_RECORD_UNAVAILABLE";
  if (!derivationAncestryCurrent(db, id, version, row.supersedes_id, mode === "historical")) return "MEMORY_RECORD_UNAVAILABLE";
  assertMemoryAccess(access, String(row.scope_id));
  if (!humanMayReadRecord(db, id, version, access.humanPrincipal)) return "MEMORY_SCOPE_DENIED";
  const details = db.prepare("SELECT partition,confidence_basis FROM memory_record_details WHERE record_id=? AND record_version=?").get(id, version);
  if (details?.partition === "identity" && !identityRecordReadable(String(row.scope_id), access)) return "MEMORY_SCOPE_DENIED";
  const evidence = db.prepare("SELECT source_id AS sourceId,source_revision AS revision,start_byte AS startByte,end_byte AS endByte FROM memory_evidence WHERE record_id=? AND record_version=?").all(id, version) as unknown as MemoryEvidenceHandle[];
  if (!evidence.length && row.assertion !== "owner-statement") return "MEMORY_EVIDENCE_UNAVAILABLE";
  const occurredAt: unknown[] = [];
  // The span is checked against the stored text's UTF-8 length in SQL: no payload is parsed in JS per hit.
  const sourceRead = db.prepare(`SELECT s.scope_id,s.state,s.revision,s.kind,s.outcome,json_type(v.payload,'$.text') AS text_type,
      length(CAST(json_extract(v.payload,'$.text') AS BLOB)) AS text_bytes,json_extract(v.payload,'$.occurredAt') AS occurred_at,
      EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=s.id AND (t.revision IS NULL OR t.revision=v.revision)) AS tombstoned
    FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=? WHERE s.id=?`);
  for (const handle of evidence) {
    const source = sourceRead.get(handle.revision, handle.sourceId);
    if (!source || Number(source.tombstoned)) return "MEMORY_EVIDENCE_UNAVAILABLE";
    // Current reads stand on the source as it is now; history reads the revision the record was taken from, unless deleted.
    if (mode === "historical" ? source.state === "deleted" : source.state !== "active" || source.revision !== handle.revision) return "MEMORY_EVIDENCE_UNAVAILABLE";
    if (FAILED_KINDS.has(String(row.kind)) && (source.kind === "tool-outcome" || source.kind === "activity") && source.outcome === "failed") return "MEMORY_EVIDENCE_UNAVAILABLE";
    // Evidence-scope authorization: the words a record rests on are read too, so their scope must be the reader's
    // (a lesson in the bot's own scope resting on a room it has left is not readable).
    try { assertMemoryAccess(access, String(source.scope_id)); }
    catch (error) { if (error instanceof Error && error.message === "MEMORY_SCOPE_DENIED") return "MEMORY_SCOPE_DENIED"; throw error; }
    if (source.text_type !== "text" || !Number.isSafeInteger(handle.startByte) || !Number.isSafeInteger(handle.endByte) || handle.startByte < 0 || handle.endByte <= handle.startByte || handle.endByte > Number(source.text_bytes)) return "MEMORY_EVIDENCE_UNAVAILABLE";
    occurredAt.push(source.occurred_at ?? null);
  }
  // A record resting on a generated message that is withheld (replay-lineage.ts) does not bring that reply back.
  if (recordRestsOnWithheldMessage(id, version)) return "MEMORY_EVIDENCE_UNAVAILABLE";
  if (options.agent && isPipKind(String(row.kind))) return "MEMORY_RECORD_UNAVAILABLE";
  if (options.withheldMessage && recordRestsOnWithheldMessage(id, version, options.withheldMessage)) return "MEMORY_EVIDENCE_UNAVAILABLE";
  // A captured chunk keeps its source's settlement (checkpoints.ts): an unsettled intention is not current evidence
  // (history and a disclosed version keep it); a failed tool output is recallable only as a failure.
  let sourceOutcome: "failed" | undefined;
  if (row.kind === "source") {
    const sources = db.prepare("SELECT s.speaker,s.outcome,s.turn_id,s.thread_id FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=? AND e.record_version=?").all(id, version);
    if (mode === "current" && row.owner_pinned !== 1 && sources.some(source => unsettledIntention(db, source))) return "MEMORY_EVIDENCE_UNAVAILABLE";
    if (sources.some(source => source.speaker === "tool" && source.outcome === "failed")) sourceOutcome = "failed";
  }
  return { row, ...(details ? { details: { partition: details.partition, confidence_basis: details.confidence_basis } } : {}), evidence, occurredAt, ...(sourceOutcome ? { sourceOutcome } : {}) };
}

/** Of these record versions, the ones that readableMemoryRecord could still accept, decided for all of them by ONE indexed
 * statement: a version that does not exist in this mode, a forgotten record, a record resting on no evidence (and not an owner
 * statement), evidence whose source version is missing, forgotten or no longer what the mode needs. Each of those is refused
 * to every reader, so the answer never depends on who asks and a refused candidate costs a few index probes instead of a
 * full hydration. A version in a scope the reader does not hold is NOT dropped here: readableMemoryRecord throws for it
 * (an integrity fault), and that must stay loud. The survivors still go through readableMemoryRecord; this only spares it
 * the certain refusals (msearch review round 5: 1,000 refused candidates cost ~465 ms of one synchronous step). */
export function plausiblyReadable(refs: ReadonlyArray<{ id: string; version: number }>, scopeIds: readonly string[], mode: MemoryReadMode = "current"): Set<string> {
  const survivors = new Set<string>();
  if (!refs.length) return survivors;
  const states = mode === "current" ? "('active')" : mode === "disclosed" ? "('active','archived')" : "('active','archived','superseded')";
  const sourceBad = mode === "historical" ? "s.state='deleted'" : "(s.state!='active' OR s.revision!=e.source_revision)";
  const rows = database().prepare(`SELECT r.id,r.version FROM json_each(?1) j JOIN memory_records r ON r.id=json_extract(j.value,'$[0]') AND r.version=json_extract(j.value,'$[1]')
    WHERE r.state IN ${states}
      AND (r.scope_id NOT IN (SELECT value FROM json_each(?2)) OR (
        NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=r.id AND (t.revision IS NULL OR t.revision=r.version))
        AND (r.assertion='owner-statement' OR EXISTS (SELECT 1 FROM memory_evidence x WHERE x.record_id=r.id AND x.record_version=r.version))
        AND NOT EXISTS (SELECT 1 FROM memory_evidence e LEFT JOIN memory_sources s ON s.id=e.source_id LEFT JOIN memory_source_versions v ON v.source_id=e.source_id AND v.revision=e.source_revision
          WHERE e.record_id=r.id AND e.record_version=r.version AND (s.id IS NULL OR v.source_id IS NULL OR ${sourceBad}
            OR EXISTS (SELECT 1 FROM memory_tombstones st WHERE st.target_type='source' AND st.target_id=s.id AND (st.revision IS NULL OR st.revision=v.revision))))))`)
    .all(JSON.stringify(refs.map(ref => [ref.id, ref.version])), JSON.stringify(scopeIds));
  for (const row of rows) survivors.add(`${row.id}:${row.version}`);
  return survivors;
}
