// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS v1 cut V1 + F2 (designs/NOLIMITS-V1-CUT.md): memory records and the outside mark, coarse. A record is "not proven
// clean" by test T when any of its evidence sources has no thread, or its thread had a marked turn that began at most 60 s
// after the source (or after the record was created); when it has a derivation row or rests on a brought-in source (O5);
// when it carries the bound outside origin (F2, memory_save on a marked turn); or when the lookup fails. One query per bundle.
import type { DatabaseSync } from "node:sqlite";
import { MEMORY_ORIGIN_KEY, markTurnOutside, notProvenClean, ownWrite, ownWritten } from "../email/external-marks.ts";

/** F2 (r4 O4): a memory saved while its thread's turn was marked (at any level). Data only: no fence, no hold. Read by record
 *  id, so every later version (approve, correct, keep) keeps it. The origin lives in the outside store (an own-write key, never
 *  cleared), not in memory_scope_bindings: a binding row there moves the learning fence, which held every grounded correction
 *  saved on a marked turn (and, with the store not ready, on every turn). The scope is not needed. */
export function markRecordOutsideDerived(_db: DatabaseSync, recordId: string, _scopeId?: string): void {
  ownWrite(`${MEMORY_ORIGIN_KEY}${recordId}`);
}
/** Whether the record carries the outside origin (store not ready: yes, fail closed). */
export function recordOutsideDerived(_db: DatabaseSync, recordId: string): boolean {
  return ownWritten(`${MEMORY_ORIGIN_KEY}${recordId}`);
}

/** 1.0.19 4.2 r3: the release of memory_search / memory_get marks the reading turn `memory` only when a returned record is
 *  not proven clean (the bundle rule below, which includes the outside origin of recordOutsideDerived; a failed lookup
 *  marks). Clean records never mark, and the call itself never does (outside-own.ts). True when it marked. */
export function markRecallRecords(db: DatabaseSync, threadId: string, records: ReadonlyArray<{ id: string; version: number }>): boolean {
  if (records.length === 0 || !memoryRecordsNotProvenClean(db, records)) return false;
  markTurnOutside(threadId, "memory");
  return true;
}

/** V1 bundle rule: whether any of these record versions is not proven clean by test T (fail closed on any lookup failure). */
export function memoryRecordsNotProvenClean(db: DatabaseSync, records: ReadonlyArray<{ id: string; version: number }>): boolean {
  if (records.length === 0) return false;
  try {
    const rows = db.prepare(`SELECT r.id AS id, r.version AS version, r.created_at AS recordAt, e.source_id AS sourceId, s.thread_id AS threadId,
        v.created_at AS sourceAt,
        EXISTS(SELECT 1 FROM memory_derivations d WHERE (d.child_id=r.id AND d.child_version=r.version) OR (d.parent_id=r.id AND d.parent_version=r.version)) AS derived,
        (e.source_id IS NOT NULL AND EXISTS(SELECT 1 FROM memory_source_origins o WHERE o.bring_in_id=e.source_id OR o.origin_id=e.source_id)) AS broughtIn
      FROM json_each(?) j
      JOIN memory_records r ON r.id=json_extract(j.value,'$[0]') AND r.version=json_extract(j.value,'$[1]')
      LEFT JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version
      LEFT JOIN memory_sources s ON s.id=e.source_id
      LEFT JOIN memory_source_versions v ON v.source_id=e.source_id AND v.revision=e.source_revision`)
      .all(JSON.stringify(records.map((record) => [record.id, record.version]))) as Array<Record<string, unknown>>;
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(`${String(row.id)}\u0000${Number(row.version)}`);
      if (Number(row.derived) || Number(row.broughtIn) || recordOutsideDerived(db, String(row.id))) return true;
      if (row.sourceId === null || row.sourceId === undefined) continue; // no evidence: the save's own turn is F2's binding
      const threadId = typeof row.threadId === "string" ? row.threadId : undefined;
      if (notProvenClean(threadId, typeof row.sourceAt === "number" ? row.sourceAt : undefined)) return true;
      if (notProvenClean(threadId, typeof row.recordAt === "number" ? row.recordAt : undefined)) return true;
    }
    return records.some((record) => !seen.has(`${record.id}\u0000${record.version}`));
  } catch {
    return true;
  }
}
