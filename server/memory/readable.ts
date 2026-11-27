import { RecallWorkBudget } from './recall-view-index.ts';
import type { RecallViewHandle } from './recall-view.ts';
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
import { CURRENT_CHECKPOINT_SQL, unsettledIntention } from "./checkpoints.ts";
import { isPipKind } from "./pip-kinds.ts";
import { assertMemoryAccess, identityRecordReadable, type MemoryAccess } from "./policy.ts";
import { checkpointLinesOnWithheldMessage, derivationAncestryCurrent, recordRestsOnWithheldMessage, type LineageAllowance } from "./replay-lineage.ts";
import { DENIED_RECORD_SCOPE, DENIED_SOURCE } from "./deny.ts";
import { memoryLookup } from "./deny-read.ts";
import { AUDIENCE_COALESCED, memoryRefKey, type MemoryRef } from "./lineage-types.ts";
import { readerWithheldMessage } from "./disclosures.ts";
import { redactSecretsInText } from "../redact.ts";

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
  workBudget?: RecallWorkBudget;
  mode?: MemoryReadMode;
  /** Search discovery selects current family heads; explicit citations keep their exact version. */
  discovery?: boolean;
  /** A bot's own tools (memory_get, memory_search): owner-authored continuity reaches the bot only through the frame (PIP A1). */
  agent?: boolean;
  /** The reader's transcript rule (disclosures.ts readerWithheldMessage): a line it may not be shown is not read either. Left out, a reader
   * whose audience is not the owner gets readerWithheldMessage(access) (withReaderRule), so no caller can read past it by omission. null
   * says the caller judges each record it reads with that rule itself (bundle.ts buildMemoryBundle): the read does not judge it twice. */
  withheldMessage?: ((threadId: string, messageId: string, allowance: LineageAllowance, verdict?: { checking?: boolean }) => boolean) | null;
  /** 1.0.23 fencebundle: a thread checkpoint is read with the lines that may not be shown left out (each line quotes one evidence handle,
   * memory_checkpoint_members order), not refused whole for them. A line whose source is withheld or still "checking" is left out (fail
   * closed for exactly that line); the record's own deny mark stands aside only when an omitted line carries the same revoke. `disclosed`:
   * the sources an earlier receipt already showed; a line left out that quotes one of them refuses the record whole (that session saw the
   * words). The read sets `omitted` (lines left out), `checking` (one was left out as not known now) and `settledEmpty` (it refused the record
   * because every line was left out for a settled reason: owner-denied, gone or ruled out, none checking). Pass a fresh object per read. */
  checkpointLines?: CheckpointLines;
}
export interface CheckpointLines { disclosed?: ReadonlySet<string>; omitted?: number; checking?: boolean; settledEmpty?: boolean }

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
export const EXCLUDED_THREAD_SOURCE = (alias: string) => `EXISTS (SELECT 1 FROM memory_recall_excluded xt WHERE xt.thread_id=${alias}.thread_id)`;
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
  const reading = {...withReaderRule(access, options),workBudget:options.workBudget??new RecallWorkBudget()};
  const read = options.allowance.timed(() => readRecord(id, version, access, reading));
  if (typeof read === "string" && options.allowance.hit) throw new Error("MEMORY_REPLAY_LIMIT");
  return read;
}
function readRecord(id: string, version: number, access: MemoryAccess, options: MemoryReadOptions): ReadableMemory | MemoryRefusal {
  const mode = options.mode ?? "current";
  assertMemoryAccess(access);
  const db = database();
  if (options.workBudget) {
    const size=db.prepare('SELECT octet_length(text) AS n FROM memory_records WHERE id=? AND version=?').get(id,version);
    if(size && !options.workBudget.text(Number(size.n)))throw new Error('MEMORY_REPLAY_LIMIT');
  }
  const row = db.prepare(options.discovery
    ? `${RECORD_SQL[mode].replace('memory_records WHERE','memory_records r WHERE')} AND ${CURRENT_CHECKPOINT_SQL}`
    : RECORD_SQL[mode]).get(id, version);
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
  const lines = options.checkpointLines && row.kind === "checkpoint" ? options.checkpointLines : undefined;
  const omitted = new Set<MemoryEvidenceHandle>();
  /** A line that may not be shown: refused whole, or (a checkpoint read by lines) left out. */
  const refuse = (handle: MemoryEvidenceHandle, refusal: MemoryRefusal): MemoryRefusal | undefined => { if (!lines) return refusal; omitted.add(handle); return undefined; };
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
  const shownAt = new Map<MemoryEvidenceHandle, unknown>();
  // The span is checked against the stored text's UTF-8 length in SQL: no payload is parsed in JS per hit.
  const sourceRead = db.prepare(`SELECT s.scope_id,s.state,s.revision,s.kind,s.outcome,json_type(v.payload,'$.text') AS text_type,
      length(CAST(json_extract(v.payload,'$.text') AS BLOB)) AS text_bytes,json_extract(v.payload,'$.occurredAt') AS occurred_at,
      EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=s.id AND (t.revision IS NULL OR t.revision=v.revision)) AS tombstoned,
      ${DENIED_SOURCE("s")} AS denied,${EXCLUDED_THREAD_SOURCE("s")} AS excluded
    FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=? WHERE s.id=?`);
  let previousSource: string | undefined, previousRevision: number | undefined;
  let source: ReturnType<typeof sourceRead.get>;
  for (const handle of evidence) {
    // Evidence is ordered by source/revision, so one paid lookup serves all its spans inside this synchronous read.
    if(handle.sourceId!==previousSource || handle.revision!==previousRevision) {
      // the source, its version and its tombstone: paid for before the lookup
      allowance.reserveRows("", SOURCE_LOOKUP_ROWS);
      allowance.spendRows("", SOURCE_LOOKUP_ROWS);
      if(options.workBudget) {
        const size=db.prepare('SELECT octet_length(payload) AS n FROM memory_source_versions WHERE source_id=? AND revision=?').get(handle.sourceId,handle.revision);
        if(size && !options.workBudget.text(Number(size.n)))throw new Error('MEMORY_REPLAY_LIMIT');
      }
      source = sourceRead.get(handle.revision, handle.sourceId);
      previousSource=handle.sourceId;previousRevision=handle.revision;
    }
    if (!source || Number(source.tombstoned) || Number(source.denied)) { const refusal = refuse(handle, "MEMORY_EVIDENCE_UNAVAILABLE"); if (refusal) return refusal; continue; }
    // A thread the owner excluded from memory is not read in any mode: excluding it retires its sources, and history (which reads
    // retired sources) would otherwise still bring its words back.
    if (Number(source.excluded)) { const refusal = refuse(handle, "MEMORY_EVIDENCE_UNAVAILABLE"); if (refusal) return refusal; continue; }
    // Current reads stand on the source as it is now; history reads the revision the record was taken from, unless deleted.
    if (mode === "historical" ? source.state === "deleted" : source.state !== "active" || source.revision !== handle.revision) { const refusal = refuse(handle, "MEMORY_EVIDENCE_UNAVAILABLE"); if (refusal) return refusal; continue; }
    if (FAILED_KINDS.has(String(row.kind)) && (source.kind === "tool-outcome" || source.kind === "activity") && source.outcome === "failed") { const refusal = refuse(handle, "MEMORY_EVIDENCE_UNAVAILABLE"); if (refusal) return refusal; continue; }
    // Evidence-scope authorization: the words a record rests on are read too, so their scope must be the reader's
    // (a lesson in the bot's own scope resting on a room it has left is not readable).
    try { assertMemoryAccess(access, String(source.scope_id)); }
    catch (error) { if (error instanceof Error && error.message === "MEMORY_SCOPE_DENIED") { const refusal = refuse(handle, "MEMORY_SCOPE_DENIED"); if (refusal) return refusal; continue; } throw error; }
    if (source.text_type !== "text" || !Number.isSafeInteger(handle.startByte) || !Number.isSafeInteger(handle.endByte) || handle.startByte < 0 || handle.endByte <= handle.startByte || handle.endByte > Number(source.text_bytes)) { const refusal = refuse(handle, "MEMORY_EVIDENCE_UNAVAILABLE"); if (refusal) return refusal; continue; }
    occurredAt.push(source.occurred_at ?? null);
    shownAt.set(handle, source.occurred_at ?? null);
  }
  // The write-time marks (S4): the record and each evidence source by deny_memory, tombstones, denied scopes, the pending scope window, and
  // (while a revoke is in flight) a source supporting a forgotten record. Withheld is a refusal; "checking" is not known now: the limit
  // error, which every caller takes as withheld for now and none persists.
  const ref = { kind: "record" as const, id, version, scopeId: String(row.scope_id) };
  const refusal = lines ? checkpointLineRefusal(db, ref, evidence, omitted, lines) : writetimeRecordRefusal(db, ref, evidence);
  if (refusal) return refusal;
  // A line resting on a withheld message (the reader's own rule included) is left out like a line whose source is withheld; the whole-record
  // checks below would read the record's own mark, which checkpointLineRefusal has already judged.
  if (lines) for (const handle of checkpointLinesOnWithheldMessage(options.allowance, evidence.filter(handle => !omitted.has(handle)), options.withheldMessage ?? undefined, lines)) omitted.add(handle);
  let shown = row, kept = evidence, keptAt = occurredAt;
  if (lines && omitted.size) {
    kept = evidence.filter(handle => !omitted.has(handle));
    keptAt = kept.map(handle => shownAt.get(handle) ?? null);
    const shownBefore = [...omitted].some(handle => lines.disclosed?.has(String(handle.sourceId)));
    // r3: every line left out for a settled reason (none still checking, none an earlier receipt showed): nothing is left to show and nothing
    // is pending, so the caller leaves the record out as it leaves out a settled line, without telling it (CheckpointLines.settledEmpty).
    if (!kept.length && !lines.checking && !shownBefore) lines.settledEmpty = true;
    if (!kept.length || shownBefore) return "MEMORY_EVIDENCE_UNAVAILABLE";
    const text = checkpointTextWithout(db, id, version, String(row.text), omitted);
    if (text === undefined) return "MEMORY_RECORD_UNAVAILABLE";
    shown = { ...row, text };
  }
  if (lines) { lines.omitted = omitted.size; }
  // A record resting on a generated message that is withheld (replay-lineage.ts) does not bring that reply back.
  if (!lines && recordRestsOnWithheldMessage(options.allowance, id, version)) return "MEMORY_EVIDENCE_UNAVAILABLE";
  if (options.agent && isPipKind(String(row.kind))) return "MEMORY_RECORD_UNAVAILABLE";
  if (!lines && options.withheldMessage && recordRestsOnWithheldMessage(options.allowance, id, version, options.withheldMessage)) return "MEMORY_EVIDENCE_UNAVAILABLE";
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
  return { row: shown, ...(details ? { details: { partition: details.partition, confidence_basis: details.confidence_basis } } : {}), evidence: kept, occurredAt: keptAt, ...(sourceOutcome ? { sourceOutcome } : {}) };
}

/** The write-time verdicts of a checkpoint read by lines (CheckpointLines): a line whose source is withheld or "checking" joins `omitted`.
 * The record's own verdict: shown passes; "checking" is the limit error, as for any record; withheld by a deny mark (deny-memory) stands
 * aside only when the record derives from no other record and every explicit revoke marking it also marks the source of a line left out
 * (the revoke walk marks a line's source, then each record citing it: revoke-marker.ts). Any other withheld record is refused whole.
 * r3: the explicit marks are read from the store's own mark table. Schema 14 (1.0.23 deny rule, deny-rule-schema.ts) drops
 * memory_deny_memory, keeps only the marks the rule does not imply in memory_deny_object, and withholds a record through an evidence source
 * by rule: here that can only be a line already left out (every line kept reads shown), so a 14 record with no explicit mark stands aside;
 * a 13 record is withheld by deny-memory only through a mark, so it needs one (no mark explains nothing). */
function checkpointLineRefusal(db: ReturnType<typeof database>, record: MemoryRef & { version: number }, evidence: readonly MemoryEvidenceHandle[], omitted: Set<MemoryEvidenceHandle>, lines: CheckpointLines): MemoryRefusal | undefined {
  const kept = evidence.filter(handle => !omitted.has(handle));
  const sources: MemoryRef[] = kept.map(handle => ({ kind: "source", id: String(handle.sourceId), version: Number(handle.revision) }));
  const verdicts = memoryLookup(db, [record, ...sources], { audience: null });
  kept.forEach((handle, index) => {
    const verdict = verdicts.get(memoryRefKey(sources[index]!));
    if (verdict?.state === "shown") return;
    if (verdict?.state !== "withheld") lines.checking = true;
    omitted.add(handle);
  });
  const own = verdicts.get(memoryRefKey(record));
  if (own?.state === "shown") return undefined;
  if (own?.state !== "withheld") throw new Error("MEMORY_REPLAY_LIMIT");
  if (own.reason !== "deny-memory" || !omitted.size || db.prepare("SELECT 1 FROM memory_derivations WHERE child_id=? AND child_version=? LIMIT 1").get(record.id, record.version)) return "MEMORY_RECORD_UNAVAILABLE";
  const ruled = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_deny_object'").get());
  const table = ruled ? "memory_deny_object" : "memory_deny_memory";
  const marks = db.prepare(`SELECT DISTINCT revoke_id FROM ${table} WHERE kind='record' AND id=? AND version IN (0,?)`).all(record.id, record.version);
  const explained = new Set(db.prepare(`SELECT DISTINCT revoke_id FROM ${table} WHERE kind='source' AND id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify([...omitted].map(handle => String(handle.sourceId)))).map(row => Number(row.revoke_id)));
  return (marks.length || ruled) && marks.every(mark => explained.has(Number(mark.revoke_id))) ? undefined : "MEMORY_RECORD_UNAVAILABLE";
}

/** A checkpoint's text without the lines quoting `omitted`: line 0 is the heading, line i+1 quotes handle i of memory_checkpoint_members
 * (consolidate.ts writes both in one order). undefined when the stored lines and handles do not line up, an omitted handle names no line,
 * or a legacy seeded row's lines cannot each be bound to one handle by their own words: then no line can be told apart and the caller
 * refuses the record whole. */
function checkpointTextWithout(db: ReturnType<typeof database>, id: string, version: number, text: string, omitted: ReadonlySet<MemoryEvidenceHandle>): string | undefined {
  let member: Record<string, unknown> | undefined, handles: unknown;
  try {
    member = db.prepare("SELECT handles,family_id=record_id AS seeded FROM memory_checkpoint_members WHERE record_id=? AND record_version=?").get(id, version);
    handles = JSON.parse(String(member?.handles ?? "null"));
  } catch { return undefined; }
  const lines = text.split("\n");
  if (!Array.isArray(handles) || lines.length !== handles.length + 1) return undefined;
  const key = (handle: { sourceId?: unknown; revision?: unknown; startByte?: unknown; endByte?: unknown }) => JSON.stringify([String(handle.sourceId), Number(handle.revision), Number(handle.startByte), Number(handle.endByte)]);
  // 1.0.23 fencebundle r3 (the owner's real store: every busy thread's checkpoint is one): a row the schema upgrade seeded for a legacy checkpoint
  // (checkpoint-schema.ts: family id = record id) lists its handles by source id, not in the text's order, so each line is bound by its words.
  const ordered = Number(member?.seeded) ? legacyLineHandles(db, lines.slice(1), handles as Array<Record<string, unknown>>) : handles as Array<Record<string, unknown>>;
  if (!ordered) return undefined;
  const gone = new Set([...omitted].map(key)), named = new Set(ordered.map(key));
  if ([...gone].some(handle => !named.has(handle))) return undefined;
  return [lines[0]!, ...lines.slice(1).filter((_, index) => !gone.has(key(ordered[index]!)))].join("\n");
}

/** The handle each line of a legacy checkpoint quotes, in line order. A line quotes a handle when it ends with the handle's words as the
 * writer rendered them (`<label> (<outcome>): <JSON string>`, consolidate.ts), as stored or as redactSecretsInText left them. Handles with
 * the same words (the owner said it twice: the real store has such rows) match the same lines; they are bound in order only when they match
 * exactly as many lines as there are of them and those lines are byte-identical, so whichever is left out the text kept is the same. Any
 * other shape (a line no handle quotes, words changed since, a masked marker, matches that overlap or differ) is undefined: fail closed, the
 * record is refused whole as before. */
function legacyLineHandles(db: ReturnType<typeof database>, lines: readonly string[], handles: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> | undefined {
  const words = db.prepare("SELECT substr(CAST(json_extract(payload,'$.text') AS BLOB),?,?) AS excerpt FROM memory_source_versions WHERE source_id=? AND revision=?");
  const matched: number[][] = [];
  for (const handle of handles) {
    const start = Number(handle.startByte), end = Number(handle.endByte);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return undefined;
    const bytes = words.get(start + 1, end - start, String(handle.sourceId), Number(handle.revision))?.excerpt;
    if (!(bytes instanceof Uint8Array) || bytes.length !== end - start) return undefined;
    let literal: string;
    try { literal = JSON.stringify(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return undefined; }
    const ends = [`): ${literal}`, `): ${redactSecretsInText(literal)}`];
    matched.push(lines.flatMap((line, index) => ends.some(tail => line.endsWith(tail)) ? [index] : []));
  }
  const ordered: Array<Record<string, unknown> | undefined> = lines.map(() => undefined);
  const groups = new Map<string, number[]>();
  matched.forEach((indexes, handle) => { const key = indexes.join(","); groups.set(key, [...groups.get(key) ?? [], handle]); });
  for (const [key, members] of groups) {
    const indexes = key ? key.split(",").map(Number) : [];
    if (indexes.length !== members.length || indexes.some(index => ordered[index] !== undefined || lines[index] !== lines[indexes[0]!])) return undefined;
    indexes.forEach((index, n) => { ordered[index] = handles[members[n]!]; });
  }
  return ordered.every(handle => handle !== undefined) ? ordered as Array<Record<string, unknown>> : undefined;
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
export function plausiblyReadable(refs: ReadonlyArray<{ id: string; version: number }>, scopeIds: readonly string[] | RecallViewHandle, mode: MemoryReadMode = "current", ownerReader = false): Set<string> {
  const survivors = new Set<string>();
  if (!refs.length) return survivors;
  const states = mode === "current" ? "('active')" : mode === "disclosed" ? "('active','archived')" : "('active','archived','superseded')";
  const sourceBad = mode === "historical" ? "s.state='deleted'" : "(s.state!='active' OR s.revision!=e.source_revision)";
  const view=Array.isArray(scopeIds)?undefined:scopeIds as RecallViewHandle;
  // Real recall pages raw references first. Evidence is read only by readRecord's paid, paged allowance.
  if(view) {
    const rows=database().prepare(`SELECT r.id,r.version FROM json_each(?) j JOIN memory_records r ON r.id=json_extract(j.value,'$[0]') AND r.version=json_extract(j.value,'$[1]') WHERE r.state IN ${states}`)
      .all(JSON.stringify(refs.map(ref=>[ref.id,ref.version])));
    for(const row of rows)survivors.add(`${row.id}:${row.version}`);return survivors;
  }
  const membership='r.scope_id IN (SELECT value FROM json_each(?2))';
  const rows = database().prepare(`SELECT r.id,r.version FROM json_each(?1) j JOIN memory_records r ON r.id=json_extract(j.value,'$[0]') AND r.version=json_extract(j.value,'$[1]')
    WHERE r.state IN ${states}
      ${mode === "historical" ? "AND NOT EXISTS (SELECT 1 FROM memory_record_details d WHERE d.record_id=r.id AND d.record_version=r.version AND d.claim_status='provisional')" : ""}
      AND (NOT (${membership}) OR (
        NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=r.id AND (t.revision IS NULL OR t.revision=r.version))
        AND NOT EXISTS (SELECT 1 FROM memory_deny_memory dm WHERE dm.kind='record' AND dm.id=r.id AND dm.version IN (0,r.version)
          ${ownerReader ? `AND dm.revoke_id NOT IN (SELECT revoke_id FROM memory_revoke_audience) AND dm.revoke_id<>${AUDIENCE_COALESCED}` : ""})
        AND NOT ${DENIED_RECORD_SCOPE("r")}
        AND (r.assertion='owner-statement' OR EXISTS (SELECT 1 FROM memory_evidence x WHERE x.record_id=r.id AND x.record_version=r.version))
        AND NOT EXISTS (SELECT 1 FROM memory_evidence e LEFT JOIN memory_sources s ON s.id=e.source_id LEFT JOIN memory_source_versions v ON v.source_id=e.source_id AND v.revision=e.source_revision
          WHERE e.record_id=r.id AND e.record_version=r.version AND (s.id IS NULL OR v.source_id IS NULL OR ${sourceBad} OR ${DENIED_SOURCE("s")}
            OR ${EXCLUDED_THREAD_SOURCE("s")}
            OR EXISTS (SELECT 1 FROM memory_tombstones st WHERE st.target_type='source' AND st.target_id=s.id AND (st.revision IS NULL OR st.revision=v.revision))))))`)
    .all(JSON.stringify(refs.map(ref => [ref.id, ref.version])),JSON.stringify(scopeIds));
  for (const row of rows) survivors.add(`${row.id}:${row.version}`);
  return survivors;
}
