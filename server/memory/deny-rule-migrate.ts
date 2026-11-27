/** Memory schema 13 <-> 14 for the 1.0.23 deny rule (BUILD-PLAN R5, R6; MAIN-RULING OPUS DENYRULE H2, H5, D-1, M6).
 *
 * 13 -> 14 (denyRuleUpgradeRows, inside the one schema transaction of migrateMemorySchema, before the server listens) is a RENAME-CARRY
 * (D1): both 1.0.22 mark tables are renamed in place with their indexes, no row is copied, every row keeps its own revoke id.
 *   line mark (thread, lsn, R)   memory_deny_line is RENAMED to memory_deny_point; a row is deleted only when the line is generated (its
 *                                lineage row has a turn_lsn, as lineOf() decides it) and a range row of R on that thread covers it
 *                                (from_lsn < lsn AND turn_lsn < until_turn_lsn). Always kept: a row at FIRST_LSN (the start-up replay
 *                                receipt of a deleted conversation, capture.ts), every 'delete-conversation' and 'hide-reply' row (read
 *                                back by reason), a line with no lineage row, and every row of a bulk job (a root added to it later may
 *                                rewrite its range row with a lower bound: revoke-marker.ts rangeDeniesLine).
 *   object mark (kind, id, v, R) memory_deny_memory is RENAMED to memory_deny_object; EVERY row stays explicit (none is filtered out,
 *                                so nothing an unfinished bulk job or a later lowered range would need is lost).
 *   the walk queue               its rows are unchanged here. Nothing is walked by the step or by the open that commits it (MAIN-RULING
 *                                2026-11-26T22:27:29Z D2: the start never waits on a walk): the paced runner ends the carried jobs in the
 *                                background, and the owner's own turn reads the durable deny rows directly (LineageReader.settled).
 * 14 -> 13 (denyRuleDowngrade14to13, one transaction of its own): the two 1.0.22 mark tables come back with their exact text, explicit rows
 * are copied, and every mark the rule implies is written out per revoke id (a line row for each generated line inside a range window; a
 * source row for each source whose anchor line has a line row; a record row for each (id, version) with an evidence source that has a
 * source row), so a 1.0.22 reader
 * withholds what 1.0.23 withheld. A failure rolls back: the file stays at 14, which 1.0.22 refuses to open.
 *
 * Imports nothing from schema.ts (schema.ts imports this module). */
import type { DatabaseSync } from "node:sqlite";
import { DENY_RULE_ADDED_TABLES, DENY_RULE_DROPPED_TABLES, DENY_RULE_V13_SQL, DENY_RULE_V14_SQL } from "./deny-rule-schema.ts";

/** lineage-types.ts FIRST_LSN (not imported: this module stays a leaf). */
const FIRST = Number.MIN_SAFE_INTEGER;
/** Whether the lineage row (thread `T`, lsn `L`) is a generated line inside a range row of revoke `R` on that thread. No lineage row, or
 * a line with no turn_lsn: the comparison is NULL, so not implied. One seek of the range key, one of the thread number, one of the line. */
const generatedInRange = (T: string, L: string, R: string) => `EXISTS (SELECT 1 FROM memory_deny_range r WHERE r.thread_id=${T} AND r.from_lsn<${L} AND r.revoke_id=${R}
   AND (SELECT g.turn_lsn FROM memory_line_lineage g WHERE g.thread_no=(SELECT n.no FROM memory_thread_no n WHERE n.thread_id=${T}) AND g.lsn=${L})<r.until_turn_lsn)`;
/** 13 -> 14 by RENAME-CARRY (D1, MAIN-RULING 2026-11-26T22:27:29Z; 3.06 s on the measured real store against 34 s set-based and 60 s
 * row by row), the statements in order (also run as plain SQL against a copy for the timing in the lane's evidence). The two renames move
 * no row and keep both revoke indexes (deny-rule-schema.ts); every 1.0.22 object row stays explicit under its own revoke id (the reader
 * gives an explicit row and an implied one of the same revoke id one verdict: it collects revoke ids). `point` deletes in place the line
 * rows the rule implies. */
export const DENY_RULE_UP_SQL = {
  rename: "ALTER TABLE memory_deny_line RENAME TO memory_deny_point",
  renameObject: "ALTER TABLE memory_deny_memory RENAME TO memory_deny_object",
  point: `DELETE FROM memory_deny_point
 WHERE lsn<>${FIRST} AND reason NOT IN ('delete-conversation','hide-reply')
  AND NOT EXISTS (SELECT 1 FROM memory_revoke_jobs j WHERE j.revoke_id=memory_deny_point.revoke_id AND j.kind='bulk')
  AND ${generatedInRange("memory_deny_point.thread_id", "memory_deny_point.lsn", "memory_deny_point.revoke_id")}`,
} as const;
/** 14 -> 13, the statements in order: copies, then the marks the rule implies (lines from ranges, sources from line marks, records from
 * the source marks through memory_evidence: one read of the evidence table, a key seek per row), then the queue. */
export const DENY_RULE_DOWN_SQL = {
  line: "INSERT INTO memory_deny_line(thread_id,lsn,revoke_id,mark_lsn,reason) SELECT thread_id,lsn,revoke_id,mark_lsn,reason FROM memory_deny_point",
  memory: "INSERT INTO memory_deny_memory(kind,id,version,revoke_id) SELECT kind,id,version,revoke_id FROM memory_deny_object",
  // every generated line inside a range window gets its line mark back under the range's revoke id (1.0.22 wrote one per line it walked).
  // mark_lsn is the counter now, as writeLine stamps it (nothing reads it). A 'hide-reply' reason is not copied to these rows: 1.0.22 reads
  // that reason at a line to say the owner hid that reply itself.
  lineFromRange: `INSERT OR IGNORE INTO memory_deny_line(thread_id,lsn,revoke_id,mark_lsn,reason)
 SELECT w.thread_id,a.lsn,w.revoke_id,coalesce((SELECT next FROM memory_lsn WHERE id=1),0),CASE WHEN w.reason='hide-reply' THEN 'range' ELSE w.reason END
 FROM memory_deny_range w JOIN memory_thread_no n ON n.thread_id=w.thread_id JOIN memory_line_lineage a ON a.thread_no=n.no AND a.lsn>w.from_lsn
 WHERE a.turn_lsn IS NOT NULL AND a.turn_lsn<w.until_turn_lsn`,
  // a source whose anchor line now has a line mark (copied or written just above) gets its source mark under that revoke id
  source: `INSERT OR IGNORE INTO memory_deny_memory(kind,id,version,revoke_id)
 SELECT 'source',s.id,0,l.revoke_id FROM memory_deny_line l
 JOIN memory_thread_no n ON n.thread_id=l.thread_id JOIN memory_line_lineage a ON a.thread_no=n.no AND a.lsn=l.lsn
 JOIN memory_sources s ON s.thread_id=l.thread_id AND s.message_id=a.message_id
 WHERE l.reason<>'hide-reply'`,
  record: `INSERT OR IGNORE INTO memory_deny_memory(kind,id,version,revoke_id)
 SELECT 'record',e.record_id,e.record_version,sm.revoke_id FROM memory_evidence e
 JOIN memory_deny_memory sm ON sm.kind='source' AND sm.id=e.source_id AND sm.version IN (0,e.source_revision)
 WHERE e.record_version>0`,
} as const;

/** Tests only: called as the last step inside the transaction of either direction (a throw is a crash before the commit). */
export const DENY_RULE_MIGRATE_TESTING: { beforeCommit: ((direction: "up" | "down") => void) | null } = { beforeCommit: null };

const hasTable = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type='table' AND name=?").get(name));
const metaVersion = (db: DatabaseSync): number | null => hasTable(db, "memory_meta") ? Number(db.prepare("SELECT schema_version AS v FROM memory_meta WHERE id=1").get()?.v) : null;

/** Runs `drop` with secure_delete off on this connection and puts the previous setting back, also when `drop` throws. Only for tables
 * that hold ids, lsns and revoke numbers, never words (D-1): with secure_delete on, freeing them rewrites every page with zeros
 * (measured 3.16 GiB of log for the two mark tables of a real store). The pragma takes effect inside an open transaction. */
export function withoutSecureDelete(db: DatabaseSync, drop: () => void): void {
  const before = Number((db.prepare("PRAGMA secure_delete").get() as Record<string, unknown> | undefined)?.secure_delete ?? 1);
  db.exec("PRAGMA secure_delete=OFF");
  try { drop(); } finally { db.exec(`PRAGMA secure_delete=${before === 2 ? "FAST" : before === 0 ? "OFF" : "ON"}`); }
}

/** The 13 -> 14 row step. The caller holds the write transaction and has run the schema 14 text (the three new tables exist, empty);
 * this function runs it again, so it is also correct on its own. A file with none of the four 1.0.22 tables (a fresh file, a file older
 * than schema 10) has nothing to carry. Returns the row counts carried and dropped. */
export function denyRuleUpgradeRows(db: DatabaseSync): { point: number; object: number; dropped: number; droppedTables: number } {
  if (!db.isTransaction) throw new Error("MEMORY_DENY_RULE_NO_TRANSACTION");
  const out = { point: 0, object: 0, dropped: 0, droppedTables: 0 };
  const old = DENY_RULE_DROPPED_TABLES.filter(name => hasTable(db, name));
  if (!old.length) return out;
  // the two leave together or not at all: a file with only some of them was not written by any build, and nothing is guessed from it
  if (old.length !== DENY_RULE_DROPPED_TABLES.length) throw new Error("MEMORY_DENY_RULE_TABLES_INCOMPLETE");
  // the empty schema 14 tables the caller's schema text made (in this transaction) step aside for the renamed 1.0.22 tables. Their
  // indexes were not made: the 1.0.22 ones hold the same names (CREATE INDEX IF NOT EXISTS skipped them) and follow the rename.
  for (const name of DENY_RULE_ADDED_TABLES) {
    if (!hasTable(db, name)) continue;
    if (db.prepare(`SELECT 1 AS x FROM ${name} LIMIT 1`).get()) throw new Error("MEMORY_DENY_RULE_TABLES_INCOMPLETE");
    db.exec(`DROP TABLE ${name}`);
  }
  db.exec(DENY_RULE_UP_SQL.rename);
  db.exec(DENY_RULE_UP_SQL.renameObject);
  out.droppedTables = old.length;
  out.dropped = Number(db.prepare(DENY_RULE_UP_SQL.point).run().changes);
  out.point = Number(db.prepare("SELECT count(*) AS n FROM memory_deny_point").get()!.n);
  out.object = Number(db.prepare("SELECT count(*) AS n FROM memory_deny_object").get()!.n);
  // nothing is left to make on a whole 1.0.22 file; a file that had lost an index gets it here
  db.exec(DENY_RULE_V14_SQL);
  DENY_RULE_MIGRATE_TESTING.beforeCommit?.("up");
  return out;
}

/** The 14 -> 13 row step, inside the caller's write transaction: the 1.0.22 tables come back filled, the three schema 14 tables go. */
export function denyRuleDowngradeRows(db: DatabaseSync): { line: number; memory: number; materialized: number } {
  if (!db.isTransaction) throw new Error("MEMORY_DENY_RULE_NO_TRANSACTION");
  for (const name of DENY_RULE_ADDED_TABLES) if (!hasTable(db, name)) throw new Error("MEMORY_DENY_RULE_TABLES_INCOMPLETE");
  for (const name of DENY_RULE_DROPPED_TABLES) if (hasTable(db, name)) throw new Error("MEMORY_DENY_RULE_TABLES_INCOMPLETE");
  // the two revoke indexes hold their 1.0.22 names on the schema 14 tables (D1): they go first, so the 1.0.22 text below makes them on
  // the 1.0.22 tables. The step back COPIES (it does not rename back): a renamed table's text is stored with its name quoted, and the
  // shipped 1.0.22 validator compares the unquoted text exactly, so a renamed-back file would be refused by the build it is made for.
  db.exec("DROP INDEX IF EXISTS memory_deny_line_revoke; DROP INDEX IF EXISTS memory_deny_memory_revoke;");
  db.exec(DENY_RULE_V13_SQL);
  const run = (sql: string) => Number(db.prepare(sql).run().changes);
  const line = run(DENY_RULE_DOWN_SQL.line), memory = run(DENY_RULE_DOWN_SQL.memory);
  const materialized = run(DENY_RULE_DOWN_SQL.lineFromRange) + run(DENY_RULE_DOWN_SQL.source) + run(DENY_RULE_DOWN_SQL.record);
  for (const name of DENY_RULE_ADDED_TABLES) db.exec(`DROP TABLE ${name}`);
  DENY_RULE_MIGRATE_TESTING.beforeCommit?.("down");
  return { line, memory, materialized };
}

/** Rewrites memory_meta's version CHECK and its row from `from` to `to` inside the caller's transaction, keeping every other object on
 * the table (its triggers leave with the old table and are made again from their own stored text). */
function restampMeta(db: DatabaseSync, from: number, to: number): void {
  const objects = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='memory_meta' AND sql IS NOT NULL ORDER BY type='table' DESC,rowid").all() as Array<{ type: string; name: string; sql: string }>;
  const table = objects.find(object => object.type === "table" && object.name === "memory_meta");
  const check = `CHECK(schema_version=${from})`;
  if (!table || !table.sql.includes(check)) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  db.exec("ALTER TABLE memory_meta RENAME TO memory_meta_restamp");
  db.exec(table.sql.replace(check, `CHECK(schema_version=${to})`));
  const columns = (db.prepare("SELECT name FROM pragma_table_info('memory_meta')").all() as Array<{ name: string }>).map(column => column.name);
  db.exec(`INSERT INTO memory_meta(${columns.join(",")}) SELECT ${columns.map(name => name === "schema_version" ? String(to) : name).join(",")} FROM memory_meta_restamp`);
  db.exec("DROP TABLE memory_meta_restamp");
  for (const object of objects) if (object !== table) db.exec(object.sql);
}

function inOwnTransaction<T>(db: DatabaseSync, run: () => T): T {
  if (db.isTransaction) throw new Error("MEMORY_DENY_RULE_IN_TRANSACTION");
  db.exec("BEGIN IMMEDIATE");
  try { const result = run(); db.exec("COMMIT"); return result; }
  catch (error) { if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } } throw error; }
}

/** The whole 13 -> 14 deny-rule step on its own: one transaction (rows, drops, version). False when the file is not at 13 (nothing is
 * written). migrateMemorySchema does not call this: it runs denyRuleUpgradeRows inside its own transaction, which also stamps the version. */
export function denyRuleMigrate13to14(db: DatabaseSync): boolean {
  if (metaVersion(db) !== 13) return false;
  inOwnTransaction(db, () => { db.exec(DENY_RULE_V14_SQL); denyRuleUpgradeRows(db); restampMeta(db, 13, 14); });
  return true;
}
/** The whole 14 -> 13 deny-rule step: one transaction (the 1.0.22 tables rebuilt with every implied mark, the new tables dropped, the
 * version). False when the file is not at 14. Any failure leaves the file at 14, untouched (privacy wins: 1.0.22 refuses 14). */
export function denyRuleDowngrade14to13(db: DatabaseSync): boolean {
  if (metaVersion(db) !== 14) return false;
  inOwnTransaction(db, () => { denyRuleDowngradeRows(db); restampMeta(db, 14, 13); });
  return true;
}
