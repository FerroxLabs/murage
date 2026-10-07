// The open-time JSON shape check keeps a marker (memory schema version, revision of the shapes list, newest
// rowid per column): the next open reads only rows added since; a malformed new row is still refused; an app
// version change alone does NOT re-read old rows, a schema or shapes-list change does; a file from outside this
// installation is always read in full.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { validateMemorySchema } from "./schema.ts";

const saved = process.env.MURAGE_APP_VERSION;
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); process.env.MURAGE_APP_VERSION = "1.0.0"; reconcileMemoryRoster({ bots: [{ id: "bot", threadId: "chat" }], groups: [] }); });
afterEach(() => { if (saved === undefined) delete process.env.MURAGE_APP_VERSION; else process.env.MURAGE_APP_VERSION = saved; closeDatabase(); });

function seed(from: number, count: number) {
  const db = database(), scope = ensureScope("bot", "bot");
  db.exec("BEGIN");
  for (let i = from; i < from + count; i++) {
    db.prepare("INSERT INTO memory_sources VALUES(?,?,'chat',?,NULL,1,?,'text','owner','recorded',NULL,'active')").run(`s${i}`, scope, `m${i}`, `h${i}`);
    db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)").run(`s${i}`, `h${i}`, JSON.stringify({ text: "x" }));
  }
  db.exec("COMMIT");
}
/** The shape selects that ran, split into full ones and ones past a mark. */
function shapeSelects(run: () => void) {
  const db = database(), real = db.prepare.bind(db), seen: string[] = [];
  (db as any).prepare = (sql: string) => { if (sql.includes("json_type(")) seen.push(sql); return real(sql); };
  try { run(); } finally { (db as any).prepare = real; }
  return { full: seen.filter(sql => !sql.includes("rowid>?")).length, seeks: seen.filter(sql => sql.includes("rowid>?")).length };
}
const open = () => validateMemorySchema(database(), { incrementalShapes: true });

it("the second check seeks past the mark; an app version change does not re-read; a foreign file is always read in full", () => {
  seed(0, 50);
  expect(shapeSelects(open).full).toBe(6);  // first time: everything
  expect(shapeSelects(open)).toEqual({ full: 0, seeks: 6 });
  seed(50, 5);
  expect(shapeSelects(open)).toEqual({ full: 0, seeks: 6 });
  process.env.MURAGE_APP_VERSION = "1.0.1";
  expect(shapeSelects(open)).toEqual({ full: 0, seeks: 6 });
  expect(shapeSelects(() => { validateMemorySchema(database()); }).full).toBe(6);
});

it("a malformed row added since the last check is still refused, and so is one above the mark after an app version change", () => {
  seed(0, 5);
  open();
  process.env.MURAGE_APP_VERSION = "1.0.1";
  database().prepare("INSERT INTO memory_source_versions VALUES('s0',2,'h',?,1)").run(JSON.stringify([1, 2]));
  expect(open).toThrow("INVALID_MEMORY_JSON_SHAPE");
});

const marker = () => JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-shape-check'").get()?.intent));
const setMarker = (value: unknown) => database().prepare("UPDATE memory_scope_bindings SET intent=? WHERE id='memory-shape-check'").run(JSON.stringify(value));
/** A row whose JSON is valid (CHECK passes) but whose shape is wrong, planted below the mark. */
const plantBad = () => database().prepare("UPDATE memory_source_versions SET payload='[]' WHERE source_id='s1'").run();

it("an app version change alone does not re-read rows below the mark; a changed shapes revision finds them", () => {
  seed(0, 5);
  open();
  plantBad();
  process.env.MURAGE_APP_VERSION = "9.9.9";
  expect(shapeSelects(open)).toEqual({ full: 0, seeks: 6 });
  expect(marker().app).toBeUndefined();
  setMarker({ ...marker(), shapes: "an-older-list" });
  expect(open).toThrow("INVALID_MEMORY_JSON_SHAPE");
});

it("a marker in the old {schema, app, marks} format with a matching schema is accepted and upgraded", () => {
  seed(0, 5);
  open();
  const { schema, marks } = marker();
  setMarker({ schema, app: "0.9.0", marks });
  plantBad();
  expect(shapeSelects(open)).toEqual({ full: 0, seeks: 6 });
  // (the marker row itself is a memory_scope_bindings row, so that table's mark may advance by it)
  expect(marker()).toMatchObject({ schema, shapes: expect.any(String) });
  expect(marker().app).toBeUndefined();
  expect(shapeSelects(open)).toEqual({ full: 0, seeks: 6 });
});

it("an old-format marker for another schema version is read in full and catches a bad row", () => {
  seed(0, 5);
  open();
  const { schema, marks } = marker();
  setMarker({ schema: schema - 1, app: "1.0.0", marks });
  plantBad();
  expect(() => open()).toThrow("INVALID_MEMORY_JSON_SHAPE");
});

it("a changed schema version in the marker forces the full read", () => {
  seed(0, 5);
  open();
  setMarker({ ...marker(), schema: 0 });
  expect(shapeSelects(() => open()).full).toBe(6);
  plantBad();
  setMarker({ ...marker(), schema: 0 });
  expect(open).toThrow("INVALID_MEMORY_JSON_SHAPE");
});

it("a table whose newest rowid fell below its mark is read in full", () => {
  seed(0, 5);
  open();
  plantBad();
  const m = marker();
  setMarker({ ...m, marks: { ...m.marks, "memory_source_versions.payload": 1000 } });
  expect(open).toThrow("INVALID_MEMORY_JSON_SHAPE");
});
