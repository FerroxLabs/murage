// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A counter for "something that waits for the owner changed" (PROPOSAL-v2
// 9.3). Temp triggers on this connection bump it when a record enters or
// leaves the waiting state, and when the Later list is rewritten. They live in
// the connection's temp schema, so the validated memory_* schema is untouched
// (Phase 0 adds no memory_* object). The boot id tells a client that a counter
// that went back to a small number is a new run, not an old answer.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const WAITING_BOOT = randomUUID().slice(0, 8);

const SCHEMA = `
CREATE TEMP TABLE IF NOT EXISTS waiting_epoch(id INTEGER PRIMARY KEY CHECK(id=1), n INTEGER NOT NULL);
INSERT OR IGNORE INTO temp.waiting_epoch VALUES(1,0);
CREATE TEMP TRIGGER IF NOT EXISTS waiting_records_i AFTER INSERT ON main.memory_records WHEN NEW.state='candidate'
 BEGIN UPDATE waiting_epoch SET n=n+1; END;
CREATE TEMP TRIGGER IF NOT EXISTS waiting_records_u AFTER UPDATE OF state ON main.memory_records
 WHEN OLD.state IS NOT NEW.state AND (OLD.state='candidate' OR NEW.state='candidate') BEGIN UPDATE waiting_epoch SET n=n+1; END;
CREATE TEMP TRIGGER IF NOT EXISTS waiting_records_d AFTER DELETE ON main.memory_records WHEN OLD.state='candidate'
 BEGIN UPDATE waiting_epoch SET n=n+1; END;
CREATE TEMP TRIGGER IF NOT EXISTS waiting_later_i AFTER INSERT ON main.memory_scope_bindings WHEN NEW.id='memory-review-later'
 BEGIN UPDATE waiting_epoch SET n=n+1; END;
CREATE TEMP TRIGGER IF NOT EXISTS waiting_later_u AFTER UPDATE ON main.memory_scope_bindings WHEN NEW.id='memory-review-later'
 BEGIN UPDATE waiting_epoch SET n=n+1; END;
`;

const ready = new WeakMap<object, boolean>();

/** Install the triggers on this handle once. False when the memory tables do not exist yet or the install failed. */
export function ensureWaitingEpoch(db: DatabaseSync): boolean {
  if (ready.get(db) === true) return true;
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_records'").get()) return false;
    db.exec(SCHEMA);
    ready.set(db, true);
    return true;
  } catch { return false; }
}

/** The counter, or null when the triggers are not installed on this handle. */
export function waitingEpoch(db: DatabaseSync): number | null {
  if (!ensureWaitingEpoch(db)) return null;
  const row = db.prepare("SELECT n FROM temp.waiting_epoch WHERE id=1").get();
  return row ? Number(row.n) : null;
}

/** What a client compares: the boot, then the counter. */
export function waitingRevision(db: DatabaseSync): { boot: string; revision: number } {
  return { boot: WAITING_BOOT, revision: waitingEpoch(db) ?? 0 };
}
