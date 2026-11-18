// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: the scope creators that look the (kind, owner) row up first (policy.ts ensureScope, capture.ts captureScopeId, lessons.ts
// ensureBotScope, human-principals.ts scope); consumer owner: recall-scope (the recall epoch, issued views and the freshness mark).
// A leaf module (no runtime imports), so any importer stays out of the human-principals import cycle.
// Validity and freshness are apart: the epoch stays, so a view issued before stays valid for the scopes it cites; recall-view.ts scopeMark sees
// the new row, so a view built before it is rebuilt before it is issued to a new reader (it may be a scope that reader is eligible for).
// The workspace bootstrap inserts (learning-ledger, deny, schema) are not routed here and still move the epoch: fail closed.
import type { DatabaseSync } from "node:sqlite";
/** Creates the scope row `id` (MAIN RULINGS 2026-11-16T19:52Z S12-Q1: an unrelated scope insert must not invalidate an issued view). A scope
 * that did not exist is cited by no issued view, so the one recall epoch step its insert trigger takes is taken back in the same write
 * transaction, and only while no view cites the id. Any scope update or delete, and a raw insert by another connection, still move the
 * epoch (recall-view-races A8). `ignore`: INSERT OR IGNORE; false when the row already existed. */
export function insertScope(db: DatabaseSync, id: string, kind: string, owner: string, ignore = false): boolean {
  db.exec("SAVEPOINT memory_scope_insert");
  try {
    const made = Number(db.prepare(`INSERT ${ignore ? "OR IGNORE " : ""}INTO memory_scopes VALUES(?,?,?,'[]',0)`).run(id, kind, owner).changes) > 0;
    if (made && db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='memory_recall_scope_insert'").get())
      db.prepare("UPDATE memory_recall_epoch SET epoch=epoch-1 WHERE id=1 AND NOT EXISTS(SELECT 1 FROM memory_recall_view_scopes WHERE scope_id=?)").run(id);
    db.exec("RELEASE memory_scope_insert");
    return made;
  } catch (error) { db.exec("ROLLBACK TO memory_scope_insert; RELEASE memory_scope_insert"); throw error; }
}
