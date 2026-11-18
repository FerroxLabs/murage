// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SMOOTH-FTS-MERGE R6 T12: the pre-memory copy (messages.pre-memory-v*.db) settles itself before verifySnapshot and its rename,
// and an existing final file is kept only when settled with no side file beside it; otherwise it is made again. A failing copy
// still cleans up.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { MEMORY_PRE_V3_SNAPSHOT, MEMORY_SCHEMA_V2, migrateMemorySchema } from "./memory/schema.ts";
import { DEFAULT_MEMORY_LEARNING_V1 } from "./memory/learning-policy.ts";
import { ftsSettled, settleFtsCopy } from "./settle-copy.ts";
import { seedCopyIntents, DELETED_TEXT, deleteThreadRows, fileHolds, headerIsRollback, holdMerges, keptRows, seedMixed, sidecarsOf } from "./testing/fts-copy-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [];
const open: DatabaseSync[] = [];
afterEach(() => {
  for (const db of open.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const root of roots.splice(0)) removeTempDirSync(root);
});

/** A memory v2 messages.db (0.1.61 shape) with a search index whose deleted thread left tombstones in a mixed segment. */
function buildV2() {
  const root = mkdtempSync(join(tmpdir(), "murage-settle-premem-")); roots.push(root);
  const db = new DatabaseSync(join(root, "messages.db")); open.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  db.exec("CREATE VIRTUAL TABLE messages_fts USING fts5(t, tokenize='trigram', content='', contentless_delete=1, detail=none)");
  holdMerges(db);
  seedMixed(db, { keptThread: "kept", deletedThread: "gone", kept: 300, deleted: 60, text: DELETED_TEXT.shcha });
  deleteThreadRows(db, "gone");
  db.exec(MEMORY_SCHEMA_V2);
  db.prepare("INSERT INTO memory_meta VALUES(1,2,?,4,5,6,'active')").run(randomUUID());
  db.prepare("INSERT INTO memory_learning_config VALUES(1,3,?)").run(JSON.stringify({ ...DEFAULT_MEMORY_LEARNING_V1, reviewMode: false }));
  expect(ftsSettled(db)).toBe("owed");
  return { root, db, snapshot: join(root, MEMORY_PRE_V3_SNAPSHOT) };
}
const migrate = (f: ReturnType<typeof buildV2>, copy?: (db: DatabaseSync, path: string) => void) =>
  migrateMemorySchema(f.db, "off", { snapshotV2Path: f.snapshot, freeBytes: () => 1024 ** 4, ...(copy ? { copy } : {}) });
function expectSettledCopy(path: string) {
  expect(sidecarsOf(path)).toEqual([]);
  expect(headerIsRollback(path)).toBe(true);
  expect(fileHolds(path, DELETED_TEXT.shcha)).toBe(false);
  const copy = new DatabaseSync(path, { readOnly: true });
  try {
    expect(ftsSettled(copy)).toBe("settled");
    expect(keptRows(copy, "kept")).toBe(300);
    expect(Number(copy.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version)).toBe(2);
  } finally { copy.close(); }
  expect(sidecarsOf(path)).toEqual([]);
}
/** A v2 copy under the final name as an older build left it (VACUUM INTO, never settled). */
const rawCopy = (f: ReturnType<typeof buildV2>) => { f.db.prepare("VACUUM INTO ?").run(f.snapshot); };

it("T12: the pre-memory copy is settled before verifySnapshot and its rename", () => {
  const f = buildV2();
  let seen: string | undefined;
  migrate(f, (db, path) => { db.prepare("VACUUM INTO ?").run(path); seen = path; });
  expect(seen).toBe(`${f.snapshot}.partial`);
  expectSettledCopy(f.snapshot);
  expect(readdirSync(f.root).filter(name => name.includes(".partial"))).toEqual([]);
});

it("T12: an unsettled final file is remade", () => {
  const f = buildV2();
  rawCopy(f);
  expect(fileHolds(f.snapshot, DELETED_TEXT.shcha)).toBe(true);
  migrate(f);
  expectSettledCopy(f.snapshot);
});

it("T12: a side file beside a settled final file makes it remade", () => {
  const f = buildV2();
  rawCopy(f); settleFtsCopy(f.snapshot, { check: false });
  writeFileSync(`${f.snapshot}-wal`, Buffer.alloc(0));
  migrate(f);
  expectSettledCopy(f.snapshot);
});

it("T12: a settled final file with no side files is kept as it is", () => {
  const f = buildV2();
  rawCopy(f); settleFtsCopy(f.snapshot, { check: false });
  const before = statSync(f.snapshot), bytes = readFileSync(f.snapshot);
  migrate(f);
  const after = statSync(f.snapshot);
  expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
  expect(readFileSync(f.snapshot).equals(bytes)).toBe(true);
  expectSettledCopy(f.snapshot);
});

it("T12: a failing copy still cleans up: no partial, no side file, no final name, and the upgrade does not run", () => {
  const f = buildV2();
  expect(() => migrate(f, (db, path) => { db.prepare("VACUUM INTO ?").run(path); writeFileSync(`${path}-journal`, "x"); throw new Error("disk went away"); }))
    .toThrow(/MEMORY_SCHEMA_SNAPSHOT_FAILED/);
  expect(readdirSync(f.root).filter(name => name.startsWith("messages.pre-memory"))).toEqual([]);
  expect(Number(f.db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version)).toBe(2);
  expect(existsSync(f.snapshot)).toBe(false);
});

it("T-COPY-MEMORY: real private-copy caller removes retired postings", () => {
  const f = buildV2();
  seedCopyIntents(f.db);
  f.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(t, tokenize='trigram', content='', contentless_delete=1, detail=none); ALTER TABLE messages_fts RENAME TO messages_fts_retired; CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(t, tokenize='trigram', content='', contentless_delete=1, detail=none); INSERT INTO messages_fts_retired(rowid,t) VALUES(9999999,'qzxretiredcanary')");
  migrate(f);
  const copy = new DatabaseSync(f.snapshot, { readOnly: true });
  try { expect(copy.prepare("SELECT * FROM search_intents").all()).toEqual([]); expect(copy.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'messages_fts_retired%'").all()).toEqual([]); }
  finally { copy.close(); }
  expect(readFileSync(f.snapshot).includes(Buffer.from("qzx"))).toBe(false);
});

it.each(["retired", "queue", "shadow"])("T-COPY-RETRY %s: remake an existing final copy with no legacy index or sidecars", async debt => {
  const f = buildV2();
  f.db.prepare("VACUUM INTO ?").run(f.snapshot);
  const old = new DatabaseSync(f.snapshot);
  try {
    old.exec("DROP TABLE messages_fts");
    if (debt === "queue") seedCopyIntents(old);
    else if (debt === "shadow") old.exec("CREATE TABLE messages_fts_retired_8_data(id INTEGER PRIMARY KEY, block BLOB); INSERT INTO messages_fts_retired_8_data VALUES(11,x'717A78')");
    else old.exec("CREATE VIRTUAL TABLE messages_fts_retired USING fts5(t, tokenize='trigram', content='', contentless_delete=1, detail=none); INSERT INTO messages_fts_retired(rowid,t) VALUES(9999999,'qzx')");
  } finally { old.close(); }
  expect(sidecarsOf(f.snapshot)).toEqual([]);

  migrate(f);
  expectSettledCopy(f.snapshot);
  const copy = new DatabaseSync(f.snapshot, { readOnly: true });
  try {
    expect(copy.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'messages_fts_retired%'").all()).toEqual([]);
    if (copy.prepare("SELECT 1 FROM sqlite_schema WHERE name='search_intents'").get()) expect(copy.prepare("SELECT * FROM search_intents").all()).toEqual([]);
  } finally { copy.close(); }
  const clean = readFileSync(f.snapshot);
  migrate(f);
  expect(readFileSync(f.snapshot)).toEqual(clean);
});
