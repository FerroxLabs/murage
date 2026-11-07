// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SMOOTH-FTS-MERGE R6 T9: a backup's staged messages.db settles itself before it is inspected, digested and published. The
// source's search index is owed (tombstones of a deleted thread in a mixed segment, merges held as R6 batch 1 holds them); the
// published file has no tombstone page, no orphan, no deleted trigram bytes, journal_mode DELETE and no side file.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initializeMessageTables } from "./message-tables.ts";
import { snapshotInstallationDatabase } from "./installation-database-snapshot.ts";
import { inspectInstallationArchive, writeInstallationArchive } from "./installation-archive.ts";
import { ftsSettled, SCRATCH_OWNER_FILE, sweepStaleCopyScratch, UNOWNED_SCRATCH_STALE_MS } from "./settle-copy.ts";
import { DELETED_TEXT, deleteThreadRows, fileHolds, ftsBlocksHold, headerIsRollback, holdMerges, indexRows, keptRows, seedMixed, sidecarsOf } from "./testing/fts-copy-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const root of roots.splice(0)) removeTempDirSync(root);
});

function fixture() {
  const scratch = mkdtempSync(join(tmpdir(), "murage-settle-backup-"));
  roots.push(scratch);
  const data = join(scratch, "installation");
  mkdirSync(data);
  const db = new DatabaseSync(join(data, "messages.db"));
  databases.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  initializeMessageTables(db);
  holdMerges(db);
  seedMixed(db, { keptThread: "kept", deletedThread: "gone", kept: 300, deleted: 60, text: DELETED_TEXT.zh });
  seedMixed(db, { keptThread: "kept", deletedThread: "gone", kept: 200, deleted: 40, text: DELETED_TEXT.zh });
  deleteThreadRows(db, "gone");
  // the precondition every case starts from: the source index is owed and its raw blocks still hold the deleted trigram
  expect(ftsSettled(db)).toBe("owed");
  expect(ftsBlocksHold(db, DELETED_TEXT.zh)).toBe(true);
  return { scratch, data, db, target: join(scratch, "snapshot.db") };
}

function expectSettledFile(path: string, ...deleted: string[]) {
  expect(sidecarsOf(path)).toEqual([]);
  expect(headerIsRollback(path)).toBe(true);
  for (const text of deleted) expect(fileHolds(path, text), text).toBe(false);
  const copy = new DatabaseSync(path, { readOnly: true });
  databases.push(copy);
  expect(ftsSettled(copy)).toBe("settled");
  for (const text of deleted) expect(ftsBlocksHold(copy, text), text).toBe(false);
  expect(copy.prepare("SELECT 1 AS x FROM messages_fts_data WHERE id >= 9007199254740992 LIMIT 1").get()).toBeUndefined();
  expect(copy.prepare("SELECT 1 AS x FROM messages_fts_docsize d WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.rowid=d.id)").get()).toBeUndefined();
  copy.close(); databases.splice(databases.indexOf(copy), 1);
  // a read-only open of the published file creates no side file
  expect(sidecarsOf(path)).toEqual([]);
}

it("T9: a backup taken while the index is owed publishes a settled file with every kept row and no deleted bytes", async () => {
  const f = fixture();
  expect(await snapshotInstallationDatabase(f.data, f.target)).toMatchObject({ status: "copied" });
  expectSettledFile(f.target, DELETED_TEXT.zh);
  const copy = new DatabaseSync(f.target, { readOnly: true }); databases.push(copy);
  expect(keptRows(copy, "kept")).toBe(500);
  expect(keptRows(copy, "gone")).toBe(0);
  expect(indexRows(copy)).toBe(500);
  // kept rows are still found by the index
  expect(Number(copy.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?").get('"alp"')?.n)).toBe(500);
  // the source is untouched: still owed
  expect(ftsSettled(f.db)).toBe("owed");
  expect(readdirSync(f.scratch).filter(name => name.startsWith(".murage-"))).toEqual([]);
});

it("T9: after an edit (the old text replaced in the index) the published file holds the new text and not the old", async () => {
  const f = fixture();
  seedMixed(f.db, { keptThread: "kept", deletedThread: "edited", kept: 100, deleted: 20, text: DELETED_TEXT.shcha });
  for (const row of f.db.prepare("SELECT rowid AS r FROM messages WHERE thread_id='edited'").all()) {
    f.db.exec("BEGIN");
    f.db.prepare("DELETE FROM messages_fts WHERE rowid=?").run(Number(row.r));
    f.db.prepare("INSERT INTO messages_fts(rowid,t) VALUES (?,?)").run(Number(row.r), "edited words");
    const message = JSON.parse(String(f.db.prepare("SELECT json FROM messages WHERE rowid=?").get(Number(row.r))?.json));
    f.db.prepare("UPDATE messages SET text='edited words', json=? WHERE rowid=?").run(JSON.stringify({ ...message, text: "edited words" }), Number(row.r));
    f.db.exec("COMMIT");
  }
  expect(ftsBlocksHold(f.db, DELETED_TEXT.shcha)).toBe(true);
  expect(await snapshotInstallationDatabase(f.data, f.target)).toMatchObject({ status: "copied" });
  expectSettledFile(f.target, DELETED_TEXT.zh, DELETED_TEXT.shcha);
  const copy = new DatabaseSync(f.target, { readOnly: true }); databases.push(copy);
  expect(Number(copy.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?").get('"edi"')?.n)).toBe(20);
});

it("T9: with the email tables the email rows go in the same settle (one VACUUM) and the index is settled too", async () => {
  const { EmailStore } = await import("./email/email-store.ts");
  const f = fixture();
  const store = new EmailStore(f.db);
  store.putPayload("snd-1", [{ part: 0, name: null, contentType: "text/plain", size: 26, sha256: "0".repeat(64), data: new TextEncoder().encode("Frozen body canary 7Q2Z") }]);
  expect(await snapshotInstallationDatabase(f.data, f.target)).toMatchObject({ status: "copied" });
  expectSettledFile(f.target, DELETED_TEXT.zh, "Frozen body canary 7Q2Z");
  const copy = new DatabaseSync(f.target, { readOnly: true }); databases.push(copy);
  expect(Number(copy.prepare("SELECT count(*) AS n FROM email_payloads").get()?.n)).toBe(0);
});

it("T9: a file with no search index at all still gets its VACUUM (freed pages of deleted rows gone)", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "murage-settle-backup-")); roots.push(scratch);
  const data = join(scratch, "installation"); mkdirSync(data);
  const db = new DatabaseSync(join(data, "messages.db")); databases.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  initializeMessageTables(db);
  db.exec("DROP TABLE messages_fts");
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES (?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < 200; i++) {
    const text = i % 4 ? "kept words" : DELETED_TEXT.ef;
    insert.run(i % 4 ? "kept" : "gone", `m${i}`, i, "user", "text", text, JSON.stringify({ id: `m${i}`, at: i, role: "user", kind: "text", text }));
  }
  db.exec("COMMIT");
  db.exec("DELETE FROM messages WHERE thread_id='gone'");
  const target = join(scratch, "snapshot.db");
  expect(await snapshotInstallationDatabase(data, target)).toMatchObject({ status: "copied" });
  expect(fileHolds(target, DELETED_TEXT.ef)).toBe(false);
  expect(headerIsRollback(target)).toBe(true);
});

it("T9: a stale scratch folder a killed earlier snapshot left in the destination's parent is removed before publishing", async () => {
  const f = fixture();
  scratchFolder(f.scratch, ".murage-database-snapshot-Ab12Cd", { pid: GONE_PID, host: hostname() });
  expect(await snapshotInstallationDatabase(f.data, f.target)).toMatchObject({ status: "copied" });
  expect(readdirSync(f.scratch).filter(name => name.startsWith(".murage-"))).toEqual([]);
});

/** No process has this id on any system: an owner record naming it is a run that is gone. */
const GONE_PID = 2_147_483_646;
/** A scratch folder as a run leaves it: a raw copy inside, and the owner record when `owner` is given. */
function scratchFolder(parent: string, name: string, owner?: { pid: number; host: string }, nested = "source") {
  const path = join(parent, name);
  mkdirSync(join(path, nested), { recursive: true });
  writeFileSync(join(path, nested, "messages.db"), DELETED_TEXT.zh);
  if (owner) writeFileSync(join(path, SCRATCH_OWNER_FILE), JSON.stringify({ ...owner, at: 0 }));
  return path;
}

it("T9: a killed state snapshot's stage (a database snapshot's raw scratch nested inside) is removed when its owner is gone", () => {
  const f = fixture();
  scratchFolder(f.scratch, ".murage-state-snapshot-Qw12Er", { pid: GONE_PID, host: hostname() }, "state/.murage-database-snapshot-Ty34Ui/source");
  sweepStaleCopyScratch(f.scratch);
  expect(readdirSync(f.scratch).filter(name => name.startsWith(".murage-"))).toEqual([]);
});

it("T9: the sweep never removes another installation's scratch that may be live: a live owner, another machine, or a young folder with no owner", () => {
  const f = fixture();
  // another installation's backup into the same folder, in a process that is running (this test's own parent process stands in for it)
  scratchFolder(f.scratch, ".murage-archive-write-Li1vE0", { pid: process.ppid, host: hostname() });
  scratchFolder(f.scratch, ".murage-database-snapshot-Li1vE1", { pid: process.ppid, host: hostname() });
  // a run on another machine writing to a shared folder: its liveness cannot be checked here
  scratchFolder(f.scratch, ".murage-damaged-export-Ot4erH", { pid: GONE_PID, host: `${hostname()}-elsewhere` });
  // no owner record and young: an older build's run that may still be going
  scratchFolder(f.scratch, ".murage-state-snapshot-N0own1");
  // a record that cannot be read as an owner: kept
  const odd = scratchFolder(f.scratch, ".murage-archive-write-0ddRec");
  writeFileSync(join(odd, SCRATCH_OWNER_FILE), "not json");
  // no owner record and older than a day: no run lasts that long, so it is removed
  const old = scratchFolder(f.scratch, ".murage-database-snapshot-0ldOne");
  const past = (Date.now() - UNOWNED_SCRATCH_STALE_MS - 60_000) / 1000;
  utimesSync(old, past, past);
  sweepStaleCopyScratch(f.scratch);
  expect(readdirSync(f.scratch).filter(name => name.startsWith(".murage-")).sort()).toEqual([
    ".murage-archive-write-0ddRec", ".murage-archive-write-Li1vE0", ".murage-damaged-export-Ot4erH", ".murage-database-snapshot-Li1vE1", ".murage-state-snapshot-N0own1",
  ]);
});

it("T9: a backup run's own live stage survives the archive write's sweep, and no owner record reaches the archive", async () => {
  const f = fixture();
  writeFileSync(join(f.data, "config.json"), '{"profile":{"name":"Fixture owner"}}');
  writeFileSync(join(f.data, "bots.json"), '[{"id":"bot","threadId":"thread","name":"Fixture"}]');
  f.db.exec("INSERT INTO thread_state VALUES ('kept', NULL)");
  const archive = join(f.scratch, "own.murage-backup.zip");
  await writeInstallationArchive(f.data, archive);
  const inspected = await inspectInstallationArchive(archive, f.scratch);
  try { expectSettledFile(join(inspected.directory, "state", "messages.db"), DELETED_TEXT.zh); }
  finally { removeTempDirSync(inspected.directory); }
  // nothing of the run is left behind, and no owner record reached the archive
  expect(readdirSync(f.scratch).filter(name => name.startsWith(".murage-"))).toEqual([]);
  expect(fileHolds(archive, SCRATCH_OWNER_FILE)).toBe(false);
});

it("T9: the zip backup carries the settled messages.db", async () => {
  const f = fixture();
  writeFileSync(join(f.data, "config.json"), '{"profile":{"name":"Fixture owner"}}');
  writeFileSync(join(f.data, "bots.json"), '[{"id":"bot","threadId":"thread","name":"Fixture"}]');
  f.db.exec("INSERT INTO thread_state VALUES ('kept', NULL)");
  const archive = join(f.scratch, "fixture.murage-backup.zip");
  await writeInstallationArchive(f.data, archive);
  expect(fileHolds(archive, DELETED_TEXT.zh)).toBe(false);
  const inspected = await inspectInstallationArchive(archive, f.scratch);
  try { expectSettledFile(join(inspected.directory, "state", "messages.db"), DELETED_TEXT.zh); }
  finally { removeTempDirSync(inspected.directory); }
});
