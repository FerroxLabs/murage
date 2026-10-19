// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// reconcilePipStances reads the stance bindings through an index (never a scan of every binding): the same statements and rows with 10 and with
// 100,000 other bindings (a file of 90,000 bindings stalled the main thread for 5-33 s per call).
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";

const { DATA_DIR } = await import("../config.ts");
const { closeDatabase, database } = await import("../database.ts");
const { reconcilePipStances } = await import("./pip-stance.ts");

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

function fill(others: number): void {
  const db = database();
  db.exec("PRAGMA foreign_keys=OFF"); // the bindings need no scope here: only their number matters
  db.exec("BEGIN");
  const insert = db.prepare("INSERT OR IGNORE INTO memory_scope_bindings VALUES(?,?,?,?,0,'granted',?)");
  for (let n = 0; n < others; n++) insert.run(`other-${n}`, "scope-x", "bot", `subject-${n}`, "{}");
  db.exec("COMMIT");
}

const PLANS = ["SELECT id,intent FROM memory_scope_bindings WHERE id=?", "SELECT id,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='pip-stance'"];

it("the stance lookups use an index and read the same at 10 and at 100,000 bindings", () => {
  const db = database();
  for (const sql of PLANS) {
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(sql.includes("id=?") ? ["pip-stance:bot"] : [])) as Array<{ detail: string }>).map(row => row.detail);
    expect(plan.some(line => /^SCAN memory_scope_bindings/.test(line)), plan.join(" | ")).toBe(false);
  }
  const counted: number[] = [];
  for (const others of [10, 100_000]) {
    fill(others);
    let rows = 0;
    const original = db.prepare.bind(db);
    (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
      const statement = original(sql);
      if (!/memory_scope_bindings WHERE (id=\?|subject_type)/.test(sql)) return statement;
      return new Proxy(statement, { get(target, key) { const value = (target as never)[key]; return key === "all" ? (...args: unknown[]) => { const out = (value as (...a: unknown[]) => unknown[]).apply(target, args); rows += out.length; return out; } : typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value; } });
    };
    try { reconcilePipStances(db); reconcilePipStances(db, "bot"); } finally { (db as unknown as { prepare: unknown }).prepare = original; }
    counted.push(rows);
  }
  expect(counted[1]).toBe(counted[0]);
});
