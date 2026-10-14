// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy: interned thread numbers (STORAGE-AUDIT 3). memory_line_lineage, memory_lineage_carry, memory_line_capture and
// memory_receipt_lines key a thread by a small integer instead of its text id (a 36-byte UUID stored twice, in the table and in its index,
// on every message). A number is taken once per thread, in the writer's transaction, and never changes or is reused.
//
// No cache: a number read inside a transaction that later rolls back would name no row (and the next thread could take it), so every
// lookup is one primary-key or unique-index seek, prepared once per connection.
import type { DatabaseSync, StatementSync } from "node:sqlite";

const statements = new WeakMap<DatabaseSync, { byId: StatementSync; byNo: StatementSync; take: StatementSync }>();
function prepared(db: DatabaseSync) {
  let held = statements.get(db);
  if (!held) {
    held = {
      byId: db.prepare("SELECT no FROM memory_thread_no WHERE thread_id=?"),
      byNo: db.prepare("SELECT thread_id FROM memory_thread_no WHERE no=?"),
      take: db.prepare("INSERT INTO memory_thread_no(thread_id,no) VALUES(?,(SELECT coalesce(max(no),0)+1 FROM memory_thread_no)) RETURNING no"),
    };
    statements.set(db, held);
  }
  return held;
}

/** The thread's number, or null when the thread has none yet (nothing of it was ever written to the lineage tables). One seek. */
export function threadNo(db: DatabaseSync, threadId: string): number | null {
  const row = prepared(db).byId.get(threadId);
  return row ? Number(row.no) : null;
}

/** The thread's number, taken now (in the caller's transaction) when it has none. */
export function ensureThreadNo(db: DatabaseSync, threadId: string): number {
  const held = threadNo(db, threadId);
  if (held !== null) return held;
  const row = prepared(db).take.get(threadId);
  if (!row) throw new Error("INVALID_MEMORY_LINEAGE_META: memory_thread_no");
  return Number(row.no);
}

/** The thread a number names, or null for a number no row holds. One seek. */
export function threadIdOf(db: DatabaseSync, no: number): string | null {
  const row = prepared(db).byNo.get(no);
  return row ? String(row.thread_id) : null;
}
