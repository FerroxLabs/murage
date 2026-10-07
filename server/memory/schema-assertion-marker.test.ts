// The open-time assertion check (a record whose assertion is not one of the four known words) was a full scan of
// memory_records on every start: 1.8 s on the live store. It now keeps its newest-rowid mark in the same marker as
// the JSON shape checks, so the next open reads only records added since; markers written before it stay valid for
// the JSON shapes, and a table whose newest rowid fell below its mark is read in full again.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { validateMemorySchema } from "./schema.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster({ bots: [{ id: "bot", threadId: "chat" }], groups: [] }); });
afterEach(() => closeDatabase());

function records(from: number, count: number, assertion = "assistant-inference") {
  const db = database(), scope = ensureScope("bot", "bot");
  db.exec("BEGIN");
  const put = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,?,'active',0,1,NULL,NULL,1)");
  for (let i = from; i < from + count; i++) put.run(`r${i}`, scope, `a fact about thing ${i}`, assertion);
  db.exec("COMMIT");
}
/** The assertion selects that ran, split into whole-table ones and ones past a mark. */
function assertionSelects(run: () => void) {
  const db = database(), real = db.prepare.bind(db), seen: string[] = [];
  (db as any).prepare = (sql: string) => { if (sql.includes("assertion NOT IN")) seen.push(sql); return real(sql); };
  try { run(); } finally { (db as any).prepare = real; }
  return { full: seen.filter(sql => !sql.includes("rowid>?")).length, seeks: seen.filter(sql => sql.includes("rowid>?")).length };
}
const open = () => validateMemorySchema(database(), { incrementalShapes: true });
const marker = () => JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-shape-check'").get()?.intent));
const setMarker = (value: unknown) => database().prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify(value), "memory-shape-check");

it("with 20,000 records the first open reads them once and later opens only the new ones", () => {
  records(0, 20000);
  expect(assertionSelects(open)).toEqual({ full: 1, seeks: 0 });
  expect(assertionSelects(open)).toEqual({ full: 0, seeks: 1 });
  records(20000, 10);
  expect(assertionSelects(open)).toEqual({ full: 0, seeks: 1 });
  expect(marker().marks["memory_records.assertion"]).toBe(20010);
  // a file read without the incremental marker is always read in full
  expect(assertionSelects(() => { validateMemorySchema(database()); })).toEqual({ full: 1, seeks: 0 });
});

it("a record added since the last open with an unknown assertion is still refused", () => {
  records(0, 100);
  open();
  records(100, 1, "made-up");
  expect(open).toThrow("INVALID_MEMORY_ASSERTION");
});

it("a marker written before this check keeps the JSON shape marks valid and records the assertion mark once", () => {
  records(0, 100);
  open();
  const { schema, shapes, marks } = marker();
  const { ["memory_records.assertion"]: _gone, ...old } = marks;
  setMarker({ schema, shapes, marks: old });
  const db = database(), real = db.prepare.bind(db); let jsonFull = 0;
  (db as any).prepare = (sql: string) => { if (sql.includes("json_type(") && !sql.includes("rowid>?")) jsonFull++; return real(sql); };
  try { expect(assertionSelects(open)).toEqual({ full: 1, seeks: 0 }); } finally { (db as any).prepare = real; }
  expect(jsonFull).toBe(0);
  expect(marker().marks["memory_records.assertion"]).toBe(100);
  expect(assertionSelects(open)).toEqual({ full: 0, seeks: 1 });
});

it("records deleted below the mark (rowids reused) make the next open read the table in full", () => {
  records(0, 200);
  open();
  database().exec("DELETE FROM memory_records WHERE rowid>150");
  expect(assertionSelects(open)).toEqual({ full: 1, seeks: 0 });
  expect(marker().marks["memory_records.assertion"]).toBe(150);
});
