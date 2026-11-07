// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SMOOTH-FTS-MERGE R6.1 (MurageMain 11-03): a copy settles through VACUUM INTO a private sibling file (`<partial>-settle`, made
// empty with mode 0600) renamed over the partial, never an in-place VACUUM; the free disk (the .db plus its -wal) is checked before the
// first write and a short disk writes nothing (R6.2); a killed settle's `-settle` file is removed by the next settle and by every sweep that covers the partial.
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { initializeMessageTables } from "./message-tables.ts";
import { classifyDataDirEntry } from "./data-dir-inventory.ts";
import { isDiskFullError } from "./memory/schema.ts";
import { ftsSettled, SETTLE_INTO_SUFFIX, settleCopyIo, SettleCopySpaceError, settleFtsCopy, settleNeedBytes } from "./settle-copy.ts";
import { DELETED_TEXT, deleteThreadRows, fileHolds, headerIsRollback, holdMerges, keptRows, seedMixed, sidecarsOf } from "./testing/fts-copy-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const realFreeBytes = settleCopyIo.freeBytes;
afterEach(() => {
  settleCopyIo.freeBytes = realFreeBytes;
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const root of roots.splice(0)) removeTempDirSync(root);
});
const NOW = 1_790_000_000_000;

/** A live file with an owed index and a raw VACUUM INTO copy of it at `partial` (what every copy site hands the helper). */
function rawPartial() {
  const dir = mkdtempSync(join(tmpdir(), "murage-settle-r61-")); roots.push(dir);
  const db = new DatabaseSync(join(dir, "messages.db")); databases.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  initializeMessageTables(db);
  holdMerges(db);
  seedMixed(db, { keptThread: "kept", deletedThread: "gone", kept: 300, deleted: 60, text: DELETED_TEXT.ef });
  deleteThreadRows(db, "gone");
  expect(ftsSettled(db)).toBe("owed");
  const partial = join(dir, "copy.db.partial");
  db.prepare("VACUUM INTO ?").run(partial);
  expect(fileHolds(partial, DELETED_TEXT.ef)).toBe(true);
  return { dir, db, partial };
}
const expectSettled = (path: string) => {
  expect(sidecarsOf(path)).toEqual([]);
  expect(existsSync(`${path}${SETTLE_INTO_SUFFIX}`)).toBe(false);
  expect(headerIsRollback(path)).toBe(true);
  expect(fileHolds(path, DELETED_TEXT.ef)).toBe(false);
  const copy = new DatabaseSync(path, { readOnly: true });
  try { expect(ftsSettled(copy)).toBe("settled"); expect(keptRows(copy, "kept")).toBe(300); } finally { copy.close(); }
};

it("R6.1: the settled copy is a new file renamed over the partial (no in-place VACUUM), owner-only, with nothing left beside it", () => {
  const f = rawPartial();
  const before = statSync(f.partial).ino;
  const seen: number[] = [];
  settleCopyIo.freeBytes = path => { seen.push(statSync(path).size); return realFreeBytes(path); };
  settleFtsCopy(f.partial, { check: false });
  expect(statSync(f.partial).ino).not.toBe(before);
  if (process.platform !== "win32") expect(statSync(f.partial).mode & 0o777).toBe(0o600);
  expect(seen).toHaveLength(1); // the disk was checked once, before the first write (R6.2)
  expectSettled(f.partial);
  expect(readdirSync(f.dir).filter(name => name.includes(SETTLE_INTO_SUFFIX))).toEqual([]);
});

it("R6.1: a killed earlier settle's -settle file and its side files are removed before the next settle writes its own", () => {
  const f = rawPartial();
  for (const suffix of ["", "-journal", "-wal", "-shm"]) writeFileSync(`${f.partial}${SETTLE_INTO_SUFFIX}${suffix}`, DELETED_TEXT.ef);
  settleFtsCopy(f.partial, { check: false });
  expectSettled(f.partial);
  expect(readdirSync(f.dir).filter(name => name.includes(SETTLE_INTO_SUFFIX))).toEqual([]);
});

it("R6.2: a short disk writes nothing: the check runs before the first write, SettleCopySpaceError (reads as a full disk), the unpublished partial goes", () => {
  const f = rawPartial();
  // R6.2: the check runs before the read-write open, so at that moment the partial is byte for byte as the copy site made it and no
  // -settle file exists; the free figure is one byte short of what the partial's size needs
  const made = readFileSync(f.partial);
  let size = -1, unchanged = false, settleFileThen = true;
  settleCopyIo.freeBytes = path => {
    size = statSync(path).size;
    unchanged = readFileSync(path).equals(made) && sidecarsOf(path).length === 0;
    settleFileThen = existsSync(`${path}${SETTLE_INTO_SUFFIX}`);
    return settleNeedBytes(size) - 1;
  };
  let caught: unknown;
  try { settleFtsCopy(f.partial, { check: false }); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(SettleCopySpaceError);
  expect((caught as SettleCopySpaceError).code).toBe("FTS_COPY_DISK_SPACE");
  expect(size).toBe(made.length);
  expect(unchanged).toBe(true);
  expect(settleFileThen).toBe(false);
  expect((caught as SettleCopySpaceError).needBytes).toBe(settleNeedBytes(size));
  expect((caught as SettleCopySpaceError).freeBytes).toBe(settleNeedBytes(size) - 1);
  expect(isDiskFullError(caught)).toBe(true);
  expect(readdirSync(f.dir).filter(name => name.startsWith("copy.db"))).toEqual([]);
  // exactly enough room proceeds; an unreadable volume (null) does not block
  for (const exact of [true, false]) {
    const g = rawPartial();
    settleCopyIo.freeBytes = path => exact ? settleNeedBytes(statSync(path).size) : null;
    settleFtsCopy(g.partial, { check: false });
    expectSettled(g.partial);
  }
  expect(settleNeedBytes(0)).toBe(64 * 1048576);
  expect(settleNeedBytes(7_000_000_000)).toBe(7_700_000_000);
});

it("R6.2: the needed bytes count a -wal beside the partial (a damaged export's raw copy), checked before the -wal is folded in", () => {
  const f = rawPartial();
  // a raw copy of a WAL file with frames still in its -wal, as the damaged export takes it
  const src = join(f.dir, "wal-source.db"), partial = join(f.dir, "walcopy.db");
  const live = new DatabaseSync(src); databases.push(live);
  live.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(x); INSERT INTO t VALUES (randomblob(200000));");
  copyFileSync(src, partial); copyFileSync(`${src}-wal`, `${partial}-wal`);
  const db = statSync(partial).size, wal = statSync(`${partial}-wal`).size;
  expect(wal).toBeGreaterThan(0);
  const seen: Array<{ need: number; walThen: number }> = [];
  settleCopyIo.freeBytes = path => { seen.push({ need: settleNeedBytes(db + wal), walThen: statSync(`${path}-wal`).size }); return settleNeedBytes(db + wal) - 1; };
  let caught: unknown;
  try { settleFtsCopy(partial, { check: true }); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(SettleCopySpaceError);
  expect((caught as SettleCopySpaceError).needBytes).toBe(settleNeedBytes(db + wal));
  expect(seen).toEqual([{ need: settleNeedBytes(db + wal), walThen: wal }]);
  expect(readdirSync(f.dir).filter(name => name.startsWith("walcopy.db"))).toEqual([]);
  // exactly enough room: the -wal is folded in and the copy settles
  copyFileSync(src, partial); copyFileSync(`${src}-wal`, `${partial}-wal`);
  settleCopyIo.freeBytes = () => settleNeedBytes(db + wal);
  settleFtsCopy(partial, { check: true });
  expect(sidecarsOf(partial)).toEqual([]);
  const copy = new DatabaseSync(partial, { readOnly: true });
  try { expect(copy.prepare("SELECT count(*) AS n FROM t").get()?.n).toBe(1); } finally { copy.close(); }
});

it("R6.2: a short disk at boot: no pre-prune copy is made (the prune waits, with a warning); an earlier start's copy is left exactly as it is", async () => {
  const f = rawPartial();
  const older = join(f.dir, `project-rows-before-prune-${NOW - 86_400_000}.db`);
  f.db.prepare("VACUUM INTO ?").run(older); // an older build's raw copy
  const bytes = readFileSync(older);
  settleCopyIo.freeBytes = () => 1024;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { snapshotProjectRows, sweepPrePruneLeftovers } = await import("./project-migration.ts");
  sweepPrePruneLeftovers(f.dir);
  expect(snapshotProjectRows(f.db, NOW, f.dir)).toBe(false);
  expect(readFileSync(older).equals(bytes)).toBe(true);
  expect(readdirSync(f.dir).filter(name => name.startsWith("project-rows-before-prune-"))).toEqual([`project-rows-before-prune-${NOW - 86_400_000}.db`]);
  expect(warn.mock.calls.some(call => /free disk space/.test(String(call[0])))).toBe(true);
  // room again: the next start makes this start's copy; the earlier one is still untouched (the shipped rule, R6.2)
  settleCopyIo.freeBytes = realFreeBytes;
  sweepPrePruneLeftovers(f.dir);
  expect(snapshotProjectRows(f.db, NOW, f.dir)).toBe(true);
  expectSettled(join(f.dir, `project-rows-before-prune-${NOW}.db`));
  expect(readFileSync(older).equals(bytes)).toBe(true);
});

it("R6.1: the boot sweep removes a killed pre-prune settle's .partial-settle and its side files; every -settle name has an inventory row", async () => {
  const f = rawPartial();
  const partial = join(f.dir, `project-rows-before-prune-${NOW}.db.partial`);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) writeFileSync(`${partial}${SETTLE_INTO_SUFFIX}${suffix}`, DELETED_TEXT.ef);
  const { sweepPrePruneLeftovers } = await import("./project-migration.ts");
  sweepPrePruneLeftovers(f.dir);
  expect(readdirSync(f.dir).filter(name => name.startsWith("project-rows-before-prune-"))).toEqual([]);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    expect(classifyDataDirEntry(`project-rows-before-prune-${NOW}.db.partial-settle${suffix}`)?.backup, suffix).toBe("excluded");
    expect(classifyDataDirEntry(`messages.pre-memory-v3.db.partial-settle${suffix}`)?.backup, suffix).toBe("excluded");
  }
});
