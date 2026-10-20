// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Deterministic work accounting for the revoke-window cost tests (revoke-window.test.ts T4-T6): what a commit or a slice asks SQLite
// to do, counted instead of timed. Every execution (run, get, all, iterate) of every prepared statement while `work` runs is counted,
// cached ones included, with the rows it returned and the rows it changed (total_changes(), triggers included); every distinct
// statement's EXPLAIN QUERY PLAN, and the plan of every trigger body on a table it writes, is checked for a full scan of a table.
// node:sqlite has no sqlite3_stmt_status or scanstatus, so "no full scan of a table, and no more statements and rows for the large
// file than for the smaller one" is the flat proof, the same on every OS and on a loaded runner. Test-only; never imported by the product.
import type { DatabaseSync, StatementSync } from "node:sqlite";

export interface SqlWork { statements: number; returned: number; changed: number; sqls: Map<string, number> }
type Method = "run" | "get" | "all" | "iterate";
const METHODS: Method[] = ["run", "get", "all", "iterate"];

let current: SqlWork | null = null;
/** sqlWorkPerRun: statements per synchronous run (one runner slice is one run: it never awaits). */
let runs: number[] | null = null, runOpen = false;
let installed = false;
const returnedOf = (result: unknown) => Array.isArray(result) ? result.length : result === undefined ? 0 : 1;
function install(db: DatabaseSync) {
  if (installed) return;
  installed = true;
  const proto = Object.getPrototypeOf(db.prepare("SELECT 1")) as Record<Method, (...args: unknown[]) => unknown>;
  for (const method of METHODS) {
    const original = proto[method]!;
    proto[method] = function (this: StatementSync, ...args: unknown[]) {
      const result = original.apply(this, args);
      if (runs) {
        if (!runOpen) { runOpen = true; runs.push(0); setImmediate(() => { runOpen = false; }); }
        runs[runs.length - 1]!++;
      }
      const work = current;
      if (work) {
        work.statements++;
        if (method !== "iterate") work.returned += returnedOf(result);
        const sql = this.sourceSQL;
        work.sqls.set(sql, (work.sqls.get(sql) ?? 0) + 1);
      }
      return result;
    };
  }
}
const changes = (db: DatabaseSync) => Number((db.prepare("SELECT total_changes() AS n").get() as { n: number | bigint }).n);

/** Counts the statements `work` runs on any connection, the rows they returned, and the rows changed on `db`. */
export function sqlWork<T>(db: DatabaseSync, work: () => T): { result: T; work: SqlWork } {
  install(db);
  const outer = current;
  const mine: SqlWork = { statements: 0, returned: 0, changed: 0, sqls: new Map() };
  const before = (current = null, changes(db));
  current = mine;
  try {
    const result = work();
    return { result, work: mine };
  } finally {
    current = null;
    mine.changed = changes(db) - before;
    if (outer) { outer.statements += mine.statements; outer.returned += mine.returned; outer.changed += mine.changed; for (const [sql, n] of mine.sqls) outer.sqls.set(sql, (outer.sqls.get(sql) ?? 0) + n); }
    current = outer;
  }
}

/** Statements executed in each synchronous run while `work` is awaited (a runner's slices, each between two turns of the loop). */
export async function sqlWorkPerRun<T>(db: DatabaseSync, work: () => Promise<T>): Promise<{ result: T; runs: number[] }> {
  install(db);
  const mine: number[] = [];
  runs = mine; runOpen = false;
  try { return { result: await work(), runs: mine }; } finally { runs = null; }
}

const planOf = (db: DatabaseSync, sql: string): string[] => {
  const was = current; current = null;
  try { return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(row => String(row.detail)); }
  finally { current = was; }
};
const tablesOf = (db: DatabaseSync) => new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
/** A trigger body's statements, NEW./OLD. columns as parameters and RAISE() as NULL, so EXPLAIN QUERY PLAN accepts them. */
function triggerStatements(sql: string): string[] {
  const body = sql.replace(/^[\s\S]*?\bBEGIN\b/i, "").replace(/\bEND\s*;?\s*$/i, "");
  return body.replace(/\b(?:NEW|OLD)\.("?\w+"?)/gi, "?").replace(/RAISE\s*\([^)]*\)/gi, "NULL").split(";").map(part => part.trim()).filter(Boolean);
}
function writtenTable(sql: string): string | null {
  const match = /^\s*(?:WITH[\s\S]*?\)\s*)?(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+("?[\w.]+"?)/i.exec(sql);
  return match ? match[1]!.replace(/"/g, "").replace(/^main\./, "") : null;
}

/** Every full scan of a table (a `SCAN <table>` plan row) in the statements counted, and in the triggers on the tables they write.
 * Scans of table-valued functions (json_each), CTEs, subqueries and constant rows are not tables and are not listed. */
export function fullScans(db: DatabaseSync, sqls: Iterable<string>): { scans: string[]; unexplained: string[] } {
  const tables = tablesOf(db), out: string[] = [], unexplained: string[] = [], seen = new Set<string>();
  const check = (sql: string, where: string) => {
    if (seen.has(sql)) return;
    seen.add(sql);
    for (const detail of planOf(db, sql)) {
      const scan = /^SCAN (\w+)/.exec(detail);
      if (scan && tables.has(scan[1]!)) out.push(`${where}: ${detail} :: ${sql.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  };
  for (const sql of sqls) {
    check(sql, "statement");
    const table = writtenTable(sql);
    if (!table) continue;
    for (const trigger of db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").all(table) as Array<{ name: string; sql: string }>)
      for (const body of triggerStatements(String(trigger.sql))) { try { check(body, `trigger ${trigger.name}`); } catch (error) { unexplained.push(`trigger ${trigger.name}: ${error instanceof Error ? error.message : String(error)} :: ${body.slice(0, 160)}`); } }
  }
  return { scans: out, unexplained };
}
