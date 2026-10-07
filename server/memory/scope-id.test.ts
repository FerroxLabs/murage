// Scope ids are looked up on every captured message and access build; the
// statement that finds them must not be compiled and run per lookup.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { captureScopeId } from "./capture.ts";
import { ensureScope } from "./policy.ts";
import { scopeRow } from "./scope-id.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
/** Counts the RUNS (get, all, run) of statements whose SQL contains `needle`,
 * from the moment of the call on: a statement held and reused still counts. */
function runCounter(db: ReturnType<typeof database>, needle: string): () => number {
  const real = db.prepare.bind(db); let runs = 0;
  (db as any).prepare = (sql: string) => {
    const statement = real(sql);
    if (!sql.includes(needle)) return statement;
    return new Proxy(statement, { get(target, key) {
      const value = (target as any)[key];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => { if (key === "get" || key === "all" || key === "run" || key === "iterate") runs++; return value.apply(target, args); };
    } });
  };
  return () => runs;
}

it("5,000 scope id lookups run the kind-and-owner lookup at most once", () => {
  const db = database(), runs = runCounter(db, "SELECT id FROM memory_scopes WHERE kind=? AND owner_key=?");
  // a miss is never remembered, so each scope is created, then found once
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 50; i++) { ensureScope("bot", `bot${i}`); captureScopeId(db, `thread${i}`); }
  const before = runs();
  for (let i = 0; i < 5000; i++) { ensureScope("bot", `bot${i % 50}`); captureScopeId(db, `thread${i % 50}`); }
  expect(runs() - before).toBeLessThanOrEqual(1);
});

it("a renamed scope is not answered from memory under its old owner, and a deleted one is gone", () => {
  const db = database();
  const id = ensureScope("team", "Old");
  expect(scopeRow(db, "team", "Old")?.id).toBe(id);
  db.prepare("UPDATE memory_scopes SET owner_key='New' WHERE id=?").run(id);
  expect(scopeRow(db, "team", "Old")).toBeUndefined();
  expect(scopeRow(db, "team", "New")?.id).toBe(id);
  db.prepare("DELETE FROM memory_scopes WHERE id=?").run(id);
  expect(scopeRow(db, "team", "New")).toBeUndefined();
});

it("a scope created in a rolled-back transaction is not remembered", () => {
  const db = database();
  try { transaction(() => { ensureScope("bot", "ghost"); expect(scopeRow(db, "bot", "ghost")).toBeDefined(); throw new Error("roll back"); }); } catch { /* expected */ }
  expect(scopeRow(db, "bot", "ghost")).toBeUndefined();
});
