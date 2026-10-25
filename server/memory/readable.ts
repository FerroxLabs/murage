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
import { derivationAncestryCurrent, recordRestsOnWithheldMessage, type LineageAllowance } from "./replay-lineage.ts";
import { DENIED_RECORD_SCOPE, DENIED_SOURCE } from "./deny.ts";
import { memoryLookup } from "./deny-read.ts";
import { AUDIENCE_COALESCED, memoryRefKey, type MemoryRef } from "./lineage-types.ts";
import { readerWithheldMessage } from "./disclosures.ts";

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
  /** What the read may spend on checking the lineage of the replies a record rests on (REQUIRED: a read with none does not compile). */
  allowance: LineageAllowance;
  mode?: MemoryReadMode;
  /** A bot's own tools (memory_get, memory_search): owner-authored continuity reaches the bot only through the frame (PIP A1). */
  agent?: boolean;
  /** The reader's transcript rule (disclosures.ts readerWithheldMessage): a line it may not be shown is not read either. Left out, a reader
   * whose audience is not the owner gets readerWithheldMessage(access) (withReaderRule), so no caller can read past it by omission. null
   * says the caller judges each record it reads with that rule itself (bundle.ts buildMemoryBundle): the read does not judge it twice. */
  withheldMessage?: ((threadId: string, messageId: string, allowance: LineageAllowance) => boolean) | null;
}

/** These read options with the reader's transcript rule filled in: a reader whose audience is not the owner and whose caller passed no
 * rule is judged by readerWithheldMessage(access), the same rule every recall path passes (1.0.4 U28). A rule the caller passed is kept,
 * and so is null (the caller judges with it itself); an owner audience has none (its rule is the content rule alone). */
export function withReaderRule<T extends { allowance: LineageAllowance; withheldMessage?: MemoryReadOptions["withheldMessage"] }>(access: MemoryAccess, options: T): T {
  if (options.withheldMessage !== undefined) return options;
  const rule = readerWithheldMessage(access);
  return rule ? { ...options, withheldMessage: rule } : options;
}

/** The version lookup per mode: the state filter is part of the statement (the session checks count these by text). */
const RECORD_SQL: Record<MemoryReadMode, string> = {
  current: "SELECT * FROM memory_records WHERE id=? AND version=? AND state='active'",
  disclosed: "SELECT * FROM memory_records WHERE id=? AND version=? AND state IN ('active','archived')",
  historical: "SELECT * FROM memory_records WHERE id=? AND version=? AND state IN ('active','archived','superseded')",
};
/** A source captured in a thread the owner excluded from memory (settings.ts configure: excludedThreadIds). */
const EXCLUDED_THREAD_SOURCE = (alias: string) => `EXISTS (SELECT 1 FROM memory_scope_bindings xb,json_each(xb.intent,'$.excludedThreadIds') xt WHERE xb.id='memory-owner-settings' AND xt.value=${alias}.thread_id)`;
const FAILED_KINDS = new Set(["source", "fact", "checkpoint"]);
/** Evidence handles read per page, and the rows one source lookup reads (the source, its version, its tombstone): what the
 * allowance pays for before each read. */
const EVIDENCE_PAGE = 16, SOURCE_LOOKUP_ROWS = 3;

/** The record version as this reader may read it, or why not. Revocation of the reader itself (capability, policy
 * revision, deletion epoch) and a record outside the reader's scopes throw (fail closed: a hit in a scope the reader
 * was never given is an integrity fault, not a miss); every other refusal is returned. */
export function readableMemoryRecord(id: string, version: number, access: MemoryAccess, options: MemoryReadOptions): ReadableMemory | MemoryRefusal {
  // A read the allowance could not pay for is not made, and a refusal reached once the allowance has run out may rest on a check that only
  // could not finish (a reply unproven, a walk not paid for): either way the answer is "not known now", the limit error, which every caller
  // takes as withheld for now and none writes down as a definite refusal (1.0.2 lineage-cold r3: a continuation check persisted such a
  // refusal as a revoked receipt, and the session reset on every later turn).
  const reading = withReaderRule(access, options);
  const read = options.allowance.timed(() => readRecord(id, version, access, reading));
  if (typeof read === "string" && options.allowance.hit) throw new Error("MEMORY_REPLAY_LIMIT");
  return read;
}
function readRecord(id: string, version: number, access: MemoryAccess, options: MemoryReadOptions): ReadableMemory | MemoryRefusal {
  const mode = options.mode ?? "current";
  assertMemoryAccess(access);
  const db = database();
  const row = db.prepare(RECORD_SQL[mode]).get(id, version);
  if (!row) return "MEMORY_RECORD_UNAVAILABLE";
  // forgotten (a record tombstone), or in a deleted bot's scope (deny.ts: refused from the deletion's commit, before its job marks it)
  if (db.prepare("SELECT 1 WHERE EXISTS(SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=?1 AND (revision IS NULL OR revision=?2)) OR EXISTS(SELECT 1 FROM memory_deny WHERE kind='scope' AND id=?3)").get(id, version, String(row.scope_id))) return "MEMORY_RECORD_UNAVAILABLE";
  if (!derivationAncestryCurrent(options.allowance, db, id, version, row.supersedes_id, mode === "historical")) return "MEMORY_RECORD_UNAVAILABLE";
  assertMemoryAccess(access, String(row.scope_id));
  if (!humanMayReadRecord(db, id, version, access.humanPrincipal)) return "MEMORY_SCOPE_DENIED";
  const details = db.prepare("SELECT partition,confidence_basis,claim_status FROM memory_record_details WHERE record_id=? AND record_version=?").get(id, version);
  // A version that was only ever a candidate (waiting, or edited away before it was kept) is not history: nothing ever vouched for it.
  if (mode === "historical" && details?.claim_status === "provisional") return "MEMORY_RECORD_UNAVAILABLE";
  if (details?.partition === "identity" && !identityRecordReadable(String(row.scope_id), access)) return "MEMORY_SCOPE_DENIED";
  // Every read of the evidence is paid for BEFORE it is made (1.0.2 lineage-cold r3): a page of EVIDENCE_PAGE handles at a time, in
  // the primary key's order, then each source lookup. A read the allowance cannot pay for is not made: the limit error stops the
  // read, and every caller takes that as "not readable now" (withheld), never as a record that has no evidence.
  const allowance = options.allowance;
  const evidence: MemoryEvidenceHandle[] = [];
  const page = db.prepare(`SELECT source_id AS sourceId,source_revision AS revision,start_byte AS startByte,end_byte AS endByte FROM memory_evidence
    WHERE record_id=? AND record_version=? AND (source_id,source_revision,start_byte)>(?,?,?) ORDER BY source_id,source_revision,start_byte LIMIT ?`);
  for (let after: [string, number, number] = ["", -1, -1]; ;) {
    allowance.reserveRows("", EVIDENCE_PAGE);
    const rows = page.all(id, version, after[0], after[1], after[2], EVIDENCE_PAGE) as unknown as MemoryEvidenceHandle[];
    allowance.spendRows("", Math.max(1, rows.length));
    evidence.push(...rows);
    if (rows.length < EVIDENCE_PAGE) break;
    const last = rows[rows.length - 1]!;
    after = [String(last.sourceId), Number(last.revision), Number(last.startByte)];
  }
  if (!evidence.length && row.assertion !== "owner-statement") return "MEMORY_EVIDENCE_UNAVAILABLE";
  const occurredAt: unknown[] = [];
  // The span is checked against the stored text's UTF-8 length in SQL: no payload is parsed in JS per hit.
  const sourceRead = db.prepare(`SELECT s.scope_id,s.state,s.revision,s.kind,s.outcome,json_type(v.payload,'$.text') AS text_type,
      length(CAST(json_extract(v.payload,'$.text') AS BLOB)) AS text_bytes,json_extract(v.payload,'$.occurredAt') AS occurred_at,
      EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=s.id AND (t.revision IS NULL OR t.revision=v.revision)) AS tombstoned,
      ${DENIED_SOURCE("s")} AS denied,${EXCLUDED_THREAD_SOURCE("s")} AS excluded
    FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=? WHERE s.id=?`);
  for (const handle of evidence) {
    // the source, its version and its tombstone: paid for before the lookup
    allowance.reserveRows("", SOURCE_LOOKUP_ROWS);
    allowance.spendRows("", SOURCE_LOOKUP_ROWS);
    const source = sourceRead.get(handle.revision, handle.sourceId);
    if (!source || Number(source.tombstoned) || Number(source.denied)) return "MEMORY_EVIDENCE_UNAVAILABLE";
    // A thread the owner excluded from memory is not read in any mode: excluding it retires its sources, and history (which reads
    // retired sources) would otherwise still bring its words back.
    if (Number(source.excluded)) return "MEMORY_EVIDENCE_UNAVAILABLE";
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
  // The write-time marks (S4): the record and each evidence source by deny_memory, tombstones, denied scopes, the pending scope window, and
  // (while a revoke is in flight) a source supporting a forgotten record. Withheld is a refusal; "checking" is not known now: the limit
  // error, which every caller takes as withheld for now and none persists.
  const refusal = writetimeRecordRefusal(db, { kind: "record", id, version, scopeId: String(row.scope_id) }, evidence);
  if (refusal) return refusal;
  // A record resting on a generated message that is withheld (replay-lineage.ts) does not bring that reply back.
  if (recordRestsOnWithheldMessage(options.allowance, id, version)) return "MEMORY_EVIDENCE_UNAVAILABLE";
  if (options.agent && isPipKind(String(row.kind))) return "MEMORY_RECORD_UNAVAILABLE";
  if (options.withheldMessage && recordRestsOnWithheldMessage(options.allowance, id, version, options.withheldMessage)) return "MEMORY_EVIDENCE_UNAVAILABLE";
  // A captured chunk keeps its source's settlement (checkpoints.ts): an unsettled intention is not current evidence
  // (history and a disclosed version keep it); a failed tool output is recallable only as a failure.
  let sourceOutcome: "failed" | undefined;
  if (row.kind === "source") {
    allowance.reserveRows("", evidence.length * SOURCE_LOOKUP_ROWS);
    allowance.spendRows("", evidence.length * SOURCE_LOOKUP_ROWS);
    const sources = db.prepare("SELECT s.speaker,s.outcome,s.turn_id,s.thread_id FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=? AND e.record_version=?").all(id, version);
    if (mode === "current" && row.owner_pinned !== 1 && sources.some(source => unsettledIntention(db, source))) return "MEMORY_EVIDENCE_UNAVAILABLE";
    if (sources.some(source => source.speaker === "tool" && source.outcome === "failed")) sourceOutcome = "failed";
  }
  return { row, ...(details ? { details: { partition: details.partition, confidence_basis: details.confidence_basis } } : {}), evidence, occurredAt, ...(sourceOutcome ? { sourceOutcome } : {}) };
}

/** The write-time verdicts of a record and its evidence (one memoryLookup: a few seeks per ref): a refusal when one is withheld, the limit
 * error (not known now) when one reads "checking", undefined when all are shown. */
export function writetimeRecordRefusal(db: ReturnType<typeof database>, record: MemoryRef, evidence: readonly MemoryEvidenceHandle[]): MemoryRefusal | undefined {
  const sources: MemoryRef[] = evidence.map(handle => ({ kind: "source", id: String(handle.sourceId), version: Number(handle.revision) }));
  const verdicts = memoryLookup(db, [record, ...sources], { audience: null });
  let checking = false;
  for (const ref of [record, ...sources]) {
    const verdict = verdicts.get(memoryRefKey(ref));
    if (verdict?.state === "withheld") return ref === record ? "MEMORY_RECORD_UNAVAILABLE" : "MEMORY_EVIDENCE_UNAVAILABLE";
    if (verdict?.state !== "shown") checking = true;
  }
  if (checking) throw new Error("MEMORY_REPLAY_LIMIT");
  return undefined;
}

/** Of these record versions, the ones that readableMemoryRecord could still accept, decided for all of them by ONE indexed
 * statement: a version that does not exist in this mode, a forgotten record, a record resting on no evidence (and not an owner
 * statement), evidence whose source version is missing, forgotten or no longer what the mode needs. Each of those is refused
 * to every reader, so the answer never depends on who asks and a refused candidate costs a few index probes instead of a
 * full hydration. A version in a scope the reader does not hold is NOT dropped here: readableMemoryRecord throws for it
 * (an integrity fault), and that must stay loud. The survivors still go through readableMemoryRecord; this only spares it
 * the certain refusals (msearch review round 5: 1,000 refused candidates cost ~465 ms of one synchronous step). `ownerReader`:
 * the owner's own audience, for whom a mark of an audience-only revoke (a flipped receipt, or the coalesced audience row) is not a
 * refusal: it binds audience readers only (deny-read.ts), so the owner keeps a record marked at its write under a flip (DRAIN-104 2.11).
 * Every other reader, and a caller that does not say, keeps every mark as a refusal, as before. */
export function plausiblyReadable(refs: ReadonlyArray<{ id: string; version: number }>, scopeIds: readonly string[], mode: MemoryReadMode = "current", ownerReader = false): Set<string> {
  const survivors = new Set<string>();
  if (!refs.length) return survivors;
  const states = mode === "current" ? "('active')" : mode === "disclosed" ? "('active','archived')" : "('active','archived','superseded')";
  const sourceBad = mode === "historical" ? "s.state='deleted'" : "(s.state!='active' OR s.revision!=e.source_revision)";
  const rows = database().prepare(`SELECT r.id,r.version FROM json_each(?1) j JOIN memory_records r ON r.id=json_extract(j.value,'$[0]') AND r.version=json_extract(j.value,'$[1]')
    WHERE r.state IN ${states}
      ${mode === "historical" ? "AND NOT EXISTS (SELECT 1 FROM memory_record_details d WHERE d.record_id=r.id AND d.record_version=r.version AND d.claim_status='provisional')" : ""}
      AND (r.scope_id NOT IN (SELECT value FROM json_each(?2)) OR (
        NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=r.id AND (t.revision IS NULL OR t.revision=r.version))
        AND NOT EXISTS (SELECT 1 FROM memory_deny_memory dm WHERE dm.kind='record' AND dm.id=r.id AND dm.version IN (0,r.version)
          ${ownerReader ? `AND dm.revoke_id NOT IN (SELECT revoke_id FROM memory_revoke_audience) AND dm.revoke_id<>${AUDIENCE_COALESCED}` : ""})
        AND NOT ${DENIED_RECORD_SCOPE("r")}
        AND (r.assertion='owner-statement' OR EXISTS (SELECT 1 FROM memory_evidence x WHERE x.record_id=r.id AND x.record_version=r.version))
        AND NOT EXISTS (SELECT 1 FROM memory_evidence e LEFT JOIN memory_sources s ON s.id=e.source_id LEFT JOIN memory_source_versions v ON v.source_id=e.source_id AND v.revision=e.source_revision
          WHERE e.record_id=r.id AND e.record_version=r.version AND (s.id IS NULL OR v.source_id IS NULL OR ${sourceBad} OR ${DENIED_SOURCE("s")}
            OR ${EXCLUDED_THREAD_SOURCE("s")}
            OR EXISTS (SELECT 1 FROM memory_tombstones st WHERE st.target_type='source' AND st.target_id=s.id AND (st.revision IS NULL OR st.revision=v.revision))))))`)
    .all(JSON.stringify(refs.map(ref => [ref.id, ref.version])), JSON.stringify(scopeIds));
  for (const row of rows) survivors.add(`${row.id}:${row.version}`);
  return survivors;
}
