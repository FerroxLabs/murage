// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot email (BOT-EMAIL-MURAGE-109 5.4): a memory record that rests on a source captured from a marked row (one written after reading
// outside mail) reaches a later reader fenced, kind email-derived, and the reader's turn is marked in turn (marks are transitive).
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { fenceEmailDerived, markTurnEmailDerived } from "../email/external-marks.ts";

type Handle = { sourceId?: unknown; revision?: unknown };

/** Whether any of these evidence sources was captured from a marked row (its version's payload carries externalContent "email"). */
export function evidenceEmailDerived(db: DatabaseSync, evidence: readonly Handle[]): boolean {
  if (!evidence.length) return false;
  const one = db.prepare("SELECT 1 FROM memory_source_versions WHERE source_id=? AND revision=? AND json_extract(payload,'$.externalContent')='email' LIMIT 1");
  return evidence.some(handle => Boolean(one.get(String(handle.sourceId), Number(handle.revision))));
}

/** The binding that carries a record's external-mail origin: a memory the bot saved during a marked turn (one that read outside mail or
 *  carried a marked row) or that rests on a marked row. It outlives owner approval, so the record stays fenced wherever it is shown. */
const ORIGIN_SUBJECT = "record-origin";
export function markRecordEmailDerived(db: DatabaseSync, recordId: string, scopeId: string): void {
  db.prepare("INSERT OR IGNORE INTO memory_scope_bindings VALUES(?,?,?,?,0,'granted',?)").run(`${ORIGIN_SUBJECT}:${recordId}`, scopeId, ORIGIN_SUBJECT, recordId, JSON.stringify({ kind: "external-mail" }));
}
/** Whether a record carries the external-mail origin: its own origin binding, or evidence captured from a marked row. */
export function recordEmailDerived(db: DatabaseSync, recordId: string, version: number): boolean {
  return Boolean(db.prepare(`SELECT 1 WHERE EXISTS(SELECT 1 FROM memory_scope_bindings WHERE subject_type='${ORIGIN_SUBJECT}' AND subject_id=? AND state='granted')
    OR EXISTS(SELECT 1 FROM memory_evidence e JOIN memory_source_versions v ON v.source_id=e.source_id AND v.revision=e.source_revision
      WHERE e.record_id=? AND e.record_version=? AND json_extract(v.payload,'$.externalContent')='email')`).get(recordId, recordId, version));
}
/** A remembered-context frame line of an email-derived record, fenced kind email-derived (the id is stable, so the frame is too). */
export function fenceEmailDerivedLine(line: string, recordId: string, version: number): string {
  const id = createHash("sha256").update(`${recordId}\u0000${version}`).digest("hex").slice(0, 16);
  const origin = `memory-${recordId}`.replace(/[^\w.-]/g, "").slice(0, 64) || "unknown";
  return `<<page-content id=${id} origin=${origin} kind=email-derived>>\n${line}\n<<end page-content id=${id}>>`;
}

/** Records as a reader gets them: the text of each email-derived one fenced; the reader's turn marked when any was. */
export function fenceEmailDerivedRecords<T extends { id: string; version?: number; text: string; evidence: readonly Handle[] }>(db: DatabaseSync, records: T[], threadId: string | undefined): T[] {
  let carried = false;
  const out = records.map(record => {
    if (!record.text || record.text.startsWith("<<page-content ") || !(evidenceEmailDerived(db, record.evidence) || (record.version !== undefined && recordEmailDerived(db, record.id, record.version)))) return record;
    carried = true;
    return { ...record, text: fenceEmailDerived(record.text, `memory-${record.id}`) };
  });
  if (carried && threadId) markTurnEmailDerived(threadId);
  return out;
}
