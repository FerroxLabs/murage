import { beginWrite, endWrite, undoWrite } from "./write-tx.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";

export const ROUTINE_LINK_OBJECTS = Object.freeze({
  tables: ["routine_link_members", "routine_link_nodes", "routine_link_ready"],
  indexes: ["routine_link_member_order"],
  triggers: ["routine_link_before_insert", "routine_link_after_insert", "routine_link_before_update", "routine_link_after_update", "routine_link_before_delete"],
});

const key = (depth: number, expression: string) => `'${String(depth).padStart(2, "0") }:' || substr(${expression},1,${depth})`;
// Child ranges use the parent prefix within the next depth namespace.
const childRange = (depth: number, expression: string) => {
  const prefix = `'${String(depth + 1).padStart(2, "0")}:' || substr(${expression},1,${depth})`;
  return `node BETWEEN (${prefix} || '0') AND (${prefix} || 'f')`;
};
const erase = (row: string) => {
  const oldKey = `(SELECT rowkey FROM routine_link_members WHERE thread_id=${row}.thread_id AND id=${row}.id)`;
  let sql = `DELETE FROM routine_link_nodes WHERE thread_id=${row}.thread_id AND node=('16:' || ${oldKey});`;
  for (let depth = 15; depth >= 0; depth--) sql += `INSERT OR REPLACE INTO routine_link_nodes(thread_id,node,max_at) SELECT ${row}.thread_id,${key(depth, oldKey)},MAX(max_at) FROM routine_link_nodes WHERE thread_id=${row}.thread_id AND ${childRange(depth, oldKey)} HAVING ${oldKey} IS NOT NULL;`;
  return sql + `DELETE FROM routine_link_members WHERE thread_id=${row}.thread_id AND id=${row}.id;`;
};
const rowkey = "printf('%016x',NEW.rowid)";
/** The exact trigger text builds before the append guard wrote. Archives made
 * by those builds still carry it; the snapshot validator accepts exactly this
 * text and the first open replaces it. */
export const ROUTINE_LINK_BEFORE_INSERT_PREVIOUS_DDL = `CREATE TRIGGER routine_link_before_insert BEFORE INSERT ON messages BEGIN ${erase("NEW")} END`;
// A new key has no path to erase. In particular, do not run the sixteen
// ancestor reads for every append. REPLACE still erases its existing key.
const beforeInsert = `CREATE TRIGGER routine_link_before_insert BEFORE INSERT ON messages WHEN EXISTS(SELECT 1 FROM routine_link_members WHERE thread_id=NEW.thread_id AND id=NEW.id) BEGIN ${erase("NEW")} END`;

/** A storage-order radix tree with a maximum timestamp at each prefix.
 * Sixteen bounded child reads find the first qualifying stored row, including
 * non-monotonic clocks. SQL triggers update it in the message transaction;
 * import, replacement, edit, deletion and rollback have identical semantics.
 * The once-only migration completes before the database serves callers. */
export function initializeRoutineMessageLinks(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS routine_link_members(thread_id TEXT NOT NULL,id TEXT NOT NULL,rowkey TEXT NOT NULL,PRIMARY KEY(thread_id,id));
    CREATE INDEX IF NOT EXISTS routine_link_member_order ON routine_link_members(thread_id,rowkey);
    CREATE TABLE IF NOT EXISTS routine_link_nodes(thread_id TEXT NOT NULL,node TEXT NOT NULL,max_at REAL,PRIMARY KEY(thread_id,node)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS routine_link_ready(version INTEGER PRIMARY KEY);`);
  const ready = Boolean(db.prepare("SELECT version FROM routine_link_ready WHERE version=1").get());
  if (ready) {
    // Upgrade only the exact earlier trigger, without rebuilding its derived
    // tree or changing any message. Interrupted DDL rolls back atomically.
    if (db.prepare("SELECT sql FROM sqlite_schema WHERE name='routine_link_before_insert'").get()?.sql !== ROUTINE_LINK_BEFORE_INSERT_PREVIOUS_DDL) return;
    beginWrite(db, "routine_link_insert_guard");
    try {
      db.exec(`DROP TRIGGER routine_link_before_insert; ${beforeInsert}`);
      endWrite(db, "routine_link_insert_guard");
    } catch (error) { undoWrite(db, "routine_link_insert_guard"); throw error; }
    return;
  }
  let insert = `INSERT OR REPLACE INTO routine_link_members VALUES(NEW.thread_id,NEW.id,${rowkey});
    INSERT OR REPLACE INTO routine_link_nodes VALUES(NEW.thread_id,'16:' || ${rowkey},CASE WHEN typeof(NEW.at) IN ('integer','real') THEN NEW.at END);`;
  for (let depth = 15; depth >= 0; depth--) insert += `INSERT OR REPLACE INTO routine_link_nodes(thread_id,node,max_at) SELECT NEW.thread_id,${key(depth, rowkey)},MAX(max_at) FROM routine_link_nodes WHERE thread_id=NEW.thread_id AND ${childRange(depth, rowkey)};`;
  beginWrite(db, "routine_link_migration");
  try {
    db.exec(`DELETE FROM routine_link_members; DELETE FROM routine_link_nodes;
      INSERT INTO routine_link_members SELECT thread_id,id,printf('%016x',rowid) FROM messages;
      INSERT INTO routine_link_nodes SELECT thread_id,'16:' || printf('%016x',rowid),CASE WHEN typeof(at) IN ('integer','real') THEN at END FROM messages;`);
    for (let depth = 15; depth >= 0; depth--) {
      const child = String(depth + 1).padStart(2, "0") + ":";
      db.prepare(`INSERT INTO routine_link_nodes SELECT thread_id,? || substr(node,4,?),MAX(max_at) FROM routine_link_nodes WHERE node>=? AND node<? GROUP BY thread_id,substr(node,4,?)`)
        .run(String(depth).padStart(2, "0") + ":", depth, child, child + "g", depth);
    }
    db.exec(`${beforeInsert};
      CREATE TRIGGER routine_link_after_insert AFTER INSERT ON messages BEGIN ${insert} END;
      CREATE TRIGGER routine_link_before_update BEFORE UPDATE OF thread_id,id,at ON messages BEGIN ${erase("OLD")} END;
      CREATE TRIGGER routine_link_after_update AFTER UPDATE OF thread_id,id,at ON messages BEGIN ${insert} END;
      CREATE TRIGGER routine_link_before_delete BEFORE DELETE ON messages BEGIN ${erase("OLD")} END;
      INSERT INTO routine_link_ready VALUES(1);`);
    endWrite(db, "routine_link_migration");
  } catch (error) { undoWrite(db, "routine_link_migration"); throw error; }
}

export function routineMessageAnchor(db: DatabaseSync, threadId: string, at: number): string | undefined {
  if (Number.isFinite(at)) {
    let prefix = "";
    for (let depth = 1; depth <= 16; depth++) {
      const stem = `${String(depth).padStart(2, "0")}:${prefix}`;
      const row = db.prepare("SELECT node FROM routine_link_nodes WHERE thread_id=? AND node>=? AND node<=? AND max_at>=? ORDER BY node LIMIT 1")
        .get(threadId, stem + "0", stem + "f", at) as { node: string } | undefined;
      if (!row) break;
      prefix = row.node.slice(3);
      if (depth === 16) return (db.prepare("SELECT id FROM routine_link_members WHERE thread_id=? AND rowkey=?").get(threadId, prefix) as { id: string } | undefined)?.id;
    }
  }
  return (db.prepare("SELECT id FROM routine_link_members WHERE thread_id=? ORDER BY rowkey DESC LIMIT 1").get(threadId) as { id: string } | undefined)?.id;
}
