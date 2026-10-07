// The record-details anti-join (a record with no details row) was a full scan of memory_records on every open.
// It now keeps its newest-rowid mark in the same marker as the JSON shapes and the assertion check: the first open
// reads in full, later opens seek past the mark, and a record added without details is still refused.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { validateMemorySchema } from "./schema.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster({ bots: [{ id: "bot", threadId: "chat" }], groups: [] } as any); });
afterEach(() => closeDatabase());

function records(from: number, count: number) {
  const db = database(), scope = ensureScope("bot", "bot");
  db.exec("BEGIN");
  const put = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'assistant-inference','active',0,1,NULL,NULL,1)");
  for (let i = from; i < from + count; i++) put.run(`r${i}`, scope, `a fact about thing ${i}`);
  db.exec("COMMIT");
}
function detailSelects(run: () => void) {
  const db = database(), real = db.prepare.bind(db), seen: string[] = [];
  (db as any).prepare = (sql: string) => { if (sql.includes("d.record_id IS NULL")) seen.push(sql); return real(sql); };
  try { run(); } finally { (db as any).prepare = real; }
  return { full: seen.filter(sql => !sql.includes("rowid>?")).length, seeks: seen.filter(sql => sql.includes("rowid>?")).length };
}
const open = () => validateMemorySchema(database(), { incrementalShapes: true });
const marker = () => JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-shape-check'").get()?.intent));
const setMarker = (value: unknown) => database().prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify(value), "memory-shape-check");

it("with 20,000 records the first open reads them once and later opens seek", () => {
  records(0, 20000);
  expect(detailSelects(open)).toEqual({ full: 1, seeks: 0 });
  expect(detailSelects(open)).toEqual({ full: 0, seeks: 1 });
  records(20000, 10);
  expect(detailSelects(open)).toEqual({ full: 0, seeks: 1 });
  expect(marker().marks["memory_records.details"]).toBe(20010);
  expect(detailSelects(() => { validateMemorySchema(database()); })).toEqual({ full: 1, seeks: 0 });
});

it("a record added since the last open without details is still refused, and no mark is saved past it", () => {
  records(0, 100);
  open();
  records(100, 1);
  database().prepare("DELETE FROM memory_record_details WHERE record_id='r100'").run();
  expect(open).toThrow("INVALID_MEMORY_RECORD_DETAILS");
  expect(marker().marks["memory_records.details"]).toBe(100);
  expect(open).toThrow("INVALID_MEMORY_RECORD_DETAILS");
});

it("a marker without the key reads in full once, and so does a table whose newest rowid fell below the mark", () => {
  records(0, 100);
  open();
  const { schema, shapes, marks } = marker();
  const { ["memory_records.details"]: _gone, ...old } = marks;
  setMarker({ schema, shapes, marks: old });
  expect(detailSelects(open)).toEqual({ full: 1, seeks: 0 });
  expect(detailSelects(open)).toEqual({ full: 0, seeks: 1 });
  setMarker({ schema, shapes, marks: { ...marker().marks, "memory_records.details": 5000 } });
  expect(detailSelects(open)).toEqual({ full: 1, seeks: 0 });
  expect(marker().marks["memory_records.details"]).toBe(100);
});
