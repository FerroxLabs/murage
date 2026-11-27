/** Memory schema 14 (1.0.23 deny rule, BUILD-PLAN R4): the tables of explicit deny marks and of durable walk seeds.
 *
 * 1.0.22 (schema 13) wrote one mark per object per revoke into memory_deny_line / memory_deny_memory through a durable queue
 * (memory_revoke_frontier) and a durable visited table (memory_revoke_reached). Schema 14 keeps only the marks the read-time rule does
 * not already imply, under the same revoke id:
 *   memory_deny_point   the columns and key of memory_deny_line    (explicit line marks; the same table, renamed)
 *   memory_deny_object  the columns and key of memory_deny_memory  (explicit object marks; the same table, renamed)
 * The two 1.0.22 mark tables are not part of 14. Every other deny table and the walk queue are unchanged.
 *
 * This module imports nothing from schema.ts (schema.ts imports it): the texts below are matched against the frozen v13 text by exact
 * string, and a text that no longer matches throws at module load instead of producing a schema that silently keeps an old table. */

/** The 1.0.22 statements, exactly as schema 10 to 13 define them (WRITETIME_SCHEMA in schema.ts). The 14 -> 13 step runs them again. */
export const DENY_RULE_V13_TABLES = {
  memory_deny_line: `CREATE TABLE IF NOT EXISTS memory_deny_line (thread_id TEXT NOT NULL, lsn INTEGER NOT NULL, revoke_id INTEGER NOT NULL, mark_lsn INTEGER NOT NULL,
 reason TEXT NOT NULL, PRIMARY KEY(thread_id,lsn,revoke_id)) WITHOUT ROWID;`,
  memory_deny_line_revoke: "CREATE INDEX IF NOT EXISTS memory_deny_line_revoke ON memory_deny_line(revoke_id);",
  memory_deny_memory: `CREATE TABLE IF NOT EXISTS memory_deny_memory (kind TEXT NOT NULL CHECK(kind IN ('record','source','lesson','claim','note','card','summary','skill','file')), id TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), revoke_id INTEGER NOT NULL, PRIMARY KEY(kind,id,version,revoke_id)) WITHOUT ROWID;`,
  memory_deny_memory_revoke: "CREATE INDEX IF NOT EXISTS memory_deny_memory_revoke ON memory_deny_memory(revoke_id);",
} as const;
/** The schema 14 statements that take their place (same columns, same keys, same checks). */
export const DENY_RULE_V14_TABLES = {
  // the name is quoted on purpose: 13 -> 14 RENAMES memory_deny_line (its rows stay in place, 4.7 M of them in a real store) and SQLite
  // stores a renamed table's name quoted, so a new file and an upgraded one hold one text, which is what the validator compares
  memory_deny_point: `CREATE TABLE IF NOT EXISTS "memory_deny_point" (thread_id TEXT NOT NULL, lsn INTEGER NOT NULL, revoke_id INTEGER NOT NULL, mark_lsn INTEGER NOT NULL,
 reason TEXT NOT NULL, PRIMARY KEY(thread_id,lsn,revoke_id)) WITHOUT ROWID;`,
  // D1 (MAIN-RULING 2026-11-26T22:27:29Z, rename-carry): the two revoke indexes keep their 1.0.22 NAMES in schema 14, on the renamed
  // tables. SQLite cannot rename an index, and building one again reads every row (5.1 s for the line marks of a real store); an index
  // follows its table through ALTER TABLE RENAME with the table's name rewritten quoted, so the texts below are what an upgraded file
  // holds and what a new file is given: one text for both, which the validator compares.
  memory_deny_line_revoke: 'CREATE INDEX IF NOT EXISTS memory_deny_line_revoke ON "memory_deny_point"(revoke_id);',
  // quoted for the same reason as memory_deny_point: 13 -> 14 RENAMES memory_deny_memory (every 1.0.22 object row stays in place)
  memory_deny_object: `CREATE TABLE IF NOT EXISTS "memory_deny_object" (kind TEXT NOT NULL CHECK(kind IN ('record','source','lesson','claim','note','card','summary','skill','file')), id TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), revoke_id INTEGER NOT NULL, PRIMARY KEY(kind,id,version,revoke_id)) WITHOUT ROWID;`,
  memory_deny_memory_revoke: 'CREATE INDEX IF NOT EXISTS memory_deny_memory_revoke ON "memory_deny_object"(revoke_id);',
} as const;
/** The two 1.0.22 mark tables schema 14 has no more: 13 -> 14 renames them (their rows and their two indexes stay in place, D1). The walk queue (memory_revoke_frontier, memory_revoke_reached)
 * is unchanged in this step. */
export const DENY_RULE_DROPPED_TABLES = ["memory_deny_line", "memory_deny_memory"] as const;
/** The two tables schema 14 adds. */
export const DENY_RULE_ADDED_TABLES = ["memory_deny_point", "memory_deny_object"] as const;
/** Which v13 statement each v14 statement replaces in the schema text. */
const REPLACED: ReadonlyArray<readonly [keyof typeof DENY_RULE_V13_TABLES, string]> = [
  ["memory_deny_line", DENY_RULE_V14_TABLES.memory_deny_point], ["memory_deny_line_revoke", DENY_RULE_V14_TABLES.memory_deny_line_revoke],
  ["memory_deny_memory", DENY_RULE_V14_TABLES.memory_deny_object], ["memory_deny_memory_revoke", DENY_RULE_V14_TABLES.memory_deny_memory_revoke],
];
/** The deny-rule part of the 13 -> 14 schema text: each 1.0.22 statement is replaced where it stands. The version CHECK is NOT touched
 * here (schema.ts sets it once for every lane that shares the bump to 14). */
export function denyRuleSchemaText(v13: string): string {
  let text = v13;
  for (const [name, next] of REPLACED) {
    const old = DENY_RULE_V13_TABLES[name];
    const at = text.indexOf(old);
    if (at < 0 || text.indexOf(old, at + old.length) >= 0) throw new Error("MEMORY_SCHEMA_V14_TEXT");
    text = text.slice(0, at) + next + text.slice(at + old.length);
  }
  // no 1.0.22 TABLE name is left; the two index names are (D1: they stay on the renamed tables)
  if (/memory_deny_line(?!_revoke)|memory_deny_memory(?!_revoke)/.test(text.replace(/\/\*[\s\S]*?\*\//g, ""))) throw new Error("MEMORY_SCHEMA_V14_TEXT");
  return text;
}
/** The schema 14 statements as one text (CREATE ... IF NOT EXISTS: running it on a file that has them changes nothing). */
export const DENY_RULE_V14_SQL = Object.values(DENY_RULE_V14_TABLES).join("\n");
/** The 1.0.22 statements as one text, for the step back. */
export const DENY_RULE_V13_SQL = Object.values(DENY_RULE_V13_TABLES).join("\n");
