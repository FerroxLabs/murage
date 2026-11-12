// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SMOOTH-FTS-MERGE R6 T11: the copy of messages.db taken before the boot-time project-row prune settles itself (VACUUM INTO the
// `.partial`, settleFtsCopy, rename). A file already under the final name is kept only when settled with no side file; the boot
// sweep removes a killed copy's `.partial` and side files and side files beside a final copy, never the final `.db`.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { initializeMessageTables } from "./message-tables.ts";
import { ftsSettled, settleFtsCopy } from "./settle-copy.ts";
import { classifyDataDirEntry } from "./data-dir-inventory.ts";
import { seedCopyIntents, DELETED_TEXT, deleteThreadRows, fileHolds, headerIsRollback, holdMerges, keptRows, seedMixed, sidecarsOf } from "./testing/fts-copy-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
let home = "";
afterEach(async () => {
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } }
  if (home) {
    const { closeMessageDb } = await import("./message-db.ts"); closeMessageDb();
    const { closeDatabase } = await import("./database.ts"); closeDatabase();
    vi.unstubAllEnvs(); vi.doUnmock("./settle-copy.ts"); vi.restoreAllMocks();
    removeTempDirSync(home); home = "";
  }
  for (const root of roots.splice(0)) removeTempDirSync(root);
});
const NOW = 1_790_000_000_000;

/** A standalone live file with an owed index (no store): for the copy itself. */
function liveFile() {
  const dir = mkdtempSync(join(tmpdir(), "murage-settle-prune-")); roots.push(dir);
  const db = new DatabaseSync(join(dir, "messages.db")); databases.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  initializeMessageTables(db);
  holdMerges(db);
  seedMixed(db, { keptThread: "kept", deletedThread: "gone", kept: 300, deleted: 60, text: DELETED_TEXT.ef });
  deleteThreadRows(db, "gone");
  expect(ftsSettled(db)).toBe("owed");
  return { dir, db, target: join(dir, `project-rows-before-prune-${NOW}.db`) };
}
async function expectSettled(path: string) {
  expect(sidecarsOf(path)).toEqual([]);
  expect(headerIsRollback(path)).toBe(true);
  expect(fileHolds(path, DELETED_TEXT.ef)).toBe(false);
  const copy = new DatabaseSync(path, { readOnly: true });
  try { expect(ftsSettled(copy)).toBe("settled"); expect(keptRows(copy, "kept")).toBe(300); } finally { copy.close(); }
  expect(sidecarsOf(path)).toEqual([]);
}

it("T11: the pre-prune copy is settled before it gets its final name", async () => {
  const f = liveFile();
  const { snapshotProjectRows } = await import("./project-migration.ts");
  expect(snapshotProjectRows(f.db, NOW, f.dir)).toBe(true);
  await expectSettled(f.target);
  expect(readdirSync(f.dir).filter(name => name.includes(".partial"))).toEqual([]);
});

it("T11: an unsettled file under the final name is remade", async () => {
  const f = liveFile();
  f.db.prepare("VACUUM INTO ?").run(f.target); // what an older build left: a raw copy
  expect(fileHolds(f.target, DELETED_TEXT.ef)).toBe(true);
  const { snapshotProjectRows } = await import("./project-migration.ts");
  expect(snapshotProjectRows(f.db, NOW, f.dir)).toBe(true);
  await expectSettled(f.target);
});

it("T11: a settled final file in WAL mode is remade (the probe's read-only open made side files)", async () => {
  const f = liveFile();
  f.db.prepare("VACUUM INTO ?").run(f.target);
  settleFtsCopy(f.target, { check: false });
  const wal = new DatabaseSync(f.target); wal.exec("PRAGMA journal_mode=WAL"); wal.close();
  expect(headerIsRollback(f.target)).toBe(false);
  expect(sidecarsOf(f.target)).toEqual([]);
  const { snapshotProjectRows } = await import("./project-migration.ts");
  expect(snapshotProjectRows(f.db, NOW, f.dir)).toBe(true);
  await expectSettled(f.target);
});

it("T11: a settled final file with a side file beside it is remade; a settled one with none is kept as it is", async () => {
  const f = liveFile();
  const { snapshotProjectRows } = await import("./project-migration.ts");
  expect(snapshotProjectRows(f.db, NOW, f.dir)).toBe(true);
  const before = statSync(f.target), bytes = readFileSync(f.target);
  expect(snapshotProjectRows(f.db, NOW, f.dir)).toBe(true);
  const kept = statSync(f.target);
  expect([kept.ino, kept.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
  expect(readFileSync(f.target).equals(bytes)).toBe(true);
  writeFileSync(`${f.target}-shm`, Buffer.alloc(0));
  expect(snapshotProjectRows(f.db, NOW, f.dir)).toBe(true);
  await expectSettled(f.target);
});

it("T11: the boot sweep removes a killed copy's .partial and its three side files, never a final .db nor a side file beside one (R6.2)", async () => {
  const f = liveFile();
  const { snapshotProjectRows, sweepPrePruneLeftovers } = await import("./project-migration.ts");
  expect(snapshotProjectRows(f.db, NOW, f.dir)).toBe(true);
  const partial = join(f.dir, `project-rows-before-prune-${NOW + 1}.db.partial`);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) writeFileSync(`${partial}${suffix}`, DELETED_TEXT.ef);
  writeFileSync(`${f.target}-wal`, DELETED_TEXT.ef);
  writeFileSync(`${f.target}-journal`, DELETED_TEXT.ef);
  sweepPrePruneLeftovers(f.dir);
  expect(readdirSync(f.dir).filter(name => name.startsWith("project-rows-before-prune-")).sort())
    .toEqual([`project-rows-before-prune-${NOW}.db`, `project-rows-before-prune-${NOW}.db-journal`, `project-rows-before-prune-${NOW}.db-wal`]);
  expect(readFileSync(`${f.target}-wal`, "utf8")).toBe(DELETED_TEXT.ef);
  // this start's own name with a side file beside it is remade by the keep rule (R6), which removes the side files with it
  expect(snapshotProjectRows(f.db, NOW, f.dir)).toBe(true);
  expect(readdirSync(f.dir).filter(name => name.startsWith("project-rows-before-prune-"))).toEqual([`project-rows-before-prune-${NOW}.db`]);
  await expectSettled(f.target);
});

it("R6.2: a removal killed after the final .db was unlinked (R2-H1) leaves a non-empty -wal and -shm; the next start's sweep removes them", async () => {
  const f = liveFile();
  const { snapshotProjectRows, sweepPrePruneLeftovers } = await import("./project-migration.ts");
  // the state removeCopy leaves when killed between its unlinks: the main file gone, its side files still there
  const gone = join(f.dir, `project-rows-before-prune-${NOW - 86_400_000}.db`);
  writeFileSync(`${gone}-wal`, DELETED_TEXT.ef);
  writeFileSync(`${gone}-shm`, DELETED_TEXT.ef);
  writeFileSync(`${gone}.partial-settle-wal`, DELETED_TEXT.ef);
  expect(snapshotProjectRows(f.db, NOW, f.dir)).toBe(true);
  sweepPrePruneLeftovers(f.dir); // the next start
  expect(readdirSync(f.dir).filter(name => name.startsWith("project-rows-before-prune-"))).toEqual([`project-rows-before-prune-${NOW}.db`]);
  await expectSettled(f.target);
});

it("R6.2: an earlier start's final copy is left byte for byte by the sweep and by this start's copy (the shipped rule)", async () => {
  const f = liveFile();
  const older = join(f.dir, `project-rows-before-prune-${NOW - 86_400_000}.db`);
  f.db.prepare("VACUUM INTO ?").run(older); // what an older build left: a raw copy
  const before = statSync(older), bytes = readFileSync(older);
  const { snapshotProjectRows, sweepPrePruneLeftovers } = await import("./project-migration.ts");
  sweepPrePruneLeftovers(f.dir);
  expect(snapshotProjectRows(f.db, NOW, f.dir)).toBe(true);
  sweepPrePruneLeftovers(f.dir);
  const after = statSync(older);
  expect([after.ino, after.mtimeMs, after.size]).toEqual([before.ino, before.mtimeMs, before.size]);
  expect(readFileSync(older).equals(bytes)).toBe(true);
  expect(sidecarsOf(older)).toEqual([]);
});

it("T11: every pre-prune name has an inventory row: the .db and its side files, the .partial and its side files", () => {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    expect(classifyDataDirEntry(`project-rows-before-prune-${NOW}.db${suffix}`)?.backup, suffix).toBe("excluded");
    expect(classifyDataDirEntry(`project-rows-before-prune-${NOW}.db.partial${suffix}`)?.backup, `.partial${suffix}`).toBe("excluded");
  }
});

/** The real boot path (reconcileProjectRecords) over a store whose deleted group's rows are pruned. */
async function bootWithDeletedGroup(mockSettle?: () => void) {
  home = mkdtempSync(join(tmpdir(), "murage-settle-prune-boot-"));
  vi.resetModules();
  vi.stubEnv("MURAGE_DATA_DIR", join(home, "data"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  if (mockSettle) vi.doMock("./settle-copy.ts", async importOriginal => ({ ...await importOriginal<typeof import("./settle-copy.ts")>(), settleFtsCopy: mockSettle }));
  const { Store } = await import("./store.ts");
  const migration = await import("./project-migration.ts");
  const { database } = await import("./database.ts");
  const records = await import("./project-records.ts");
  const store = new Store(() => ({ instanceId: "claude", model: "m" }));
  const bot = store.createBot({ name: "Finch" }, { seedMessages: false });
  const keep = store.createGroup("Keep", [bot!.id]);
  const gone = store.createGroup("Gone", [bot!.id]);
  for (const g of [keep, gone]) store.patchGroup(g.id, { channelProject: { goal: g.name, status: "active", startedAt: NOW, updatedAt: NOW } });
  migration.migrateChannelProjects(store);
  const db = database();
  holdMerges(db);
  seedMixed(db, { keptThread: "kept", deletedThread: "gone-thread", kept: 300, deleted: 60, text: DELETED_TEXT.ef });
  deleteThreadRows(db, "gone-thread");
  expect(ftsSettled(db)).toBe("owed");
  const file = join(home, "data", "groups.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Array<{ id: string }>;
  writeFileSync(file, JSON.stringify(raw.filter(g => g.id !== gone.id)));
  const { recordOwnerDeletion, groupDeletionKey } = await import("./owner-deletions.ts");
  recordOwnerDeletion(db, groupDeletionKey(gone.id));
  const cold = new Store(() => ({ instanceId: "claude", model: "m" }));
  return { migration, records, db, cold, gone, data: join(home, "data") };
}

it("T11: at boot the prune's copy is settled; an earlier final .db and the -wal beside it are left as they are (R6.2)", async () => {
  const b = await bootWithDeletedGroup();
  const earlier = join(b.data, "project-rows-before-prune-1700000000000.db");
  writeFileSync(earlier, "an earlier copy");
  writeFileSync(`${earlier}-wal`, DELETED_TEXT.ef);
  mkdirSync(join(b.data, "unrelated"), { recursive: true });
  b.migration.reconcileProjectRecords(b.cold);
  expect(b.records.projectSettingsFor(b.db, b.gone.id)).toBeNull();
  expect(readFileSync(earlier, "utf8")).toBe("an earlier copy");
  expect(readFileSync(`${earlier}-wal`, "utf8")).toBe(DELETED_TEXT.ef);
  const made = readdirSync(b.data).filter(name => name.startsWith("project-rows-before-prune-") && !name.startsWith("project-rows-before-prune-1700000000000.db"));
  expect(made).toHaveLength(1);
  const copy = new DatabaseSync(join(b.data, made[0]), { readOnly: true });
  try { expect(ftsSettled(copy)).toBe("settled"); expect(keptRows(copy, "kept")).toBe(300); } finally { copy.close(); }
  expect(fileHolds(join(b.data, made[0]), DELETED_TEXT.ef)).toBe(false);
});

it("T11: a settle failure skips the prune: the rows stay and no copy is left under any name", async () => {
  const b = await bootWithDeletedGroup(() => { throw new Error("settle refused"); });
  b.migration.reconcileProjectRecords(b.cold);
  expect(b.records.projectSettingsFor(b.db, b.gone.id)).not.toBeNull();
  expect(readdirSync(b.data).filter(name => name.startsWith("project-rows-before-prune-"))).toEqual([]);
});

it("T-COPY-PROJECT: real private-copy caller removes retired postings", async () => {
  vi.doUnmock("./settle-copy.ts"); vi.resetModules();
  const f = liveFile();
  seedCopyIntents(f.db);
  f.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(t, tokenize='trigram', content='', contentless_delete=1, detail=none); ALTER TABLE messages_fts RENAME TO messages_fts_retired; CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(t, tokenize='trigram', content='', contentless_delete=1, detail=none); INSERT INTO messages_fts_retired(rowid,t) VALUES(9999999,'qzxretiredcanary')");
  const { snapshotProjectRows } = await import("./project-migration.ts"); expect(snapshotProjectRows(f.db, NOW, f.dir)).toBe(true);
  const copy = new DatabaseSync(f.target, { readOnly: true });
  try { expect(copy.prepare("SELECT * FROM search_intents").all()).toEqual([]); expect(copy.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'messages_fts_retired%'").all()).toEqual([]); }
  finally { copy.close(); }
  expect(readFileSync(f.target).includes(Buffer.from("qzx"))).toBe(false);
});

it.each(["retired", "queue", "shadow"])("T-COPY-RETRY %s: remake an existing final copy with no legacy index or sidecars", async debt => {
  const f = liveFile();
  f.db.prepare("VACUUM INTO ?").run(f.target);
  const old = new DatabaseSync(f.target);
  try {
    old.exec("DROP TABLE messages_fts");
    if (debt === "queue") seedCopyIntents(old);
    else if (debt === "shadow") old.exec("CREATE TABLE messages_fts_retired_8_data(id INTEGER PRIMARY KEY, block BLOB); INSERT INTO messages_fts_retired_8_data VALUES(11,x'717A78')");
    else old.exec("CREATE VIRTUAL TABLE messages_fts_retired USING fts5(t, tokenize='trigram', content='', contentless_delete=1, detail=none); INSERT INTO messages_fts_retired(rowid,t) VALUES(9999999,'qzx')");
  } finally { old.close(); }
  expect(sidecarsOf(f.target)).toEqual([]);
  const { snapshotProjectRows } = await import("./project-migration.ts");
  expect(snapshotProjectRows(f.db, NOW, f.dir)).toBe(true);
  await expectSettled(f.target);
  const copy = new DatabaseSync(f.target, { readOnly: true });
  try {
    expect(copy.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'messages_fts_retired%'").all()).toEqual([]);
    if (copy.prepare("SELECT 1 FROM sqlite_schema WHERE name='search_intents'").get()) expect(copy.prepare("SELECT * FROM search_intents").all()).toEqual([]);
  } finally { copy.close(); }
  const clean = readFileSync(f.target);
  expect(snapshotProjectRows(f.db, NOW, f.dir)).toBe(true);
  expect(readFileSync(f.target)).toEqual(clean);
});
