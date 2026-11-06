// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SMOOTH-FTS-MERGE R6 section 3, restore: an archive made by a build before the copy rule carries a messages.db whose search index
// still holds a deleted thread. After the restore transaction's COMMIT and close, and before activation, the candidate settles
// itself; a throw fails the restore and nothing is left to activate.
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { ZipFile } from "yazl";
import { afterEach, expect, it, vi } from "vitest";
import { initializeMessageTables } from "./message-tables.ts";
import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { ftsSettled } from "./settle-copy.ts";
import { DELETED_TEXT, deleteThreadRows, fileHolds, ftsBlocksHold, headerIsRollback, holdMerges, keptRows, seedMixed, sidecarsOf } from "./testing/fts-copy-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [];
afterEach(() => { vi.doUnmock("./settle-copy.ts"); for (const root of roots.splice(0)) removeTempDirSync(root); });
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A hash-valid archive whose messages.db is a raw copy with an owed index (what a pre-R6 backup could hold). */
async function preR6Archive() {
  const parent = mkdtempSync(join(tmpdir(), "murage-settle-restore-")); roots.push(parent);
  const source = join(parent, "source.db");
  const db = new DatabaseSync(source);
  let counts;
  try {
    initializeMessageTables(db);
    holdMerges(db);
    seedMixed(db, { keptThread: "kept", deletedThread: "gone", kept: 300, deleted: 60, text: DELETED_TEXT.zh });
    deleteThreadRows(db, "gone");
    db.exec("INSERT INTO thread_state VALUES ('kept', NULL)");
    expect(ftsSettled(db)).toBe("owed");
    expect(ftsBlocksHold(db, DELETED_TEXT.zh)).toBe(true);
    counts = inspectInstallationDatabase(db);
  } finally { db.close(); }
  const bytes = readFileSync(source);
  const files = [{ path: "bots.json", text: Buffer.from("[]") }, { path: "messages.db", text: bytes }];
  const manifest = {
    format: "murage.installation", version: 1, snapshotId: randomUUID(), createdAt: new Date().toISOString(), restorePolicy: "paused-review-required",
    files: files.map(file => ({ path: file.path, bytes: file.text.length, sha256: sha(file.text) })),
    omitted: [], missing: [], database: { status: "copied", ...counts, bytes: bytes.length, sha256: sha(bytes) },
  };
  const archive = join(parent, "old.murage-backup.zip");
  const zip = new ZipFile();
  const output = pipeline(zip.outputStream as Readable, createWriteStream(archive));
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json", { compress: false });
  for (const file of files) zip.addBuffer(file.text, `state/${file.path}`, { compress: false, mode: 0o100600 });
  zip.end();
  await output;
  return { parent, archive };
}

it("restore: a pre-R6 archive's messages.db is settled before the candidate can be activated", async () => {
  const a = await preR6Archive();
  const { prepareInstallationRestore } = await import("./installation-restore-preparation.ts");
  const result = await prepareInstallationRestore(a.archive, a.parent);
  const candidate = join(result.stateDirectory, "messages.db");
  expect(sidecarsOf(candidate)).toEqual([]);
  expect(headerIsRollback(candidate)).toBe(true);
  expect(fileHolds(candidate, DELETED_TEXT.zh)).toBe(false);
  const db = new DatabaseSync(candidate, { readOnly: true });
  try { expect(ftsSettled(db)).toBe("settled"); expect(keptRows(db, "kept")).toBe(300); } finally { db.close(); }
  expect(sidecarsOf(candidate)).toEqual([]); // a read-only open (activation's settleDatabase) creates none
});

it("restore: when the settle throws the restore fails and no candidate is left", async () => {
  const a = await preR6Archive();
  vi.resetModules();
  vi.doMock("./settle-copy.ts", async importOriginal => ({ ...await importOriginal<typeof import("./settle-copy.ts")>(), settleFtsCopy: () => { throw new Error("settle refused"); } }));
  const { prepareInstallationRestore } = await import("./installation-restore-preparation.ts");
  await expect(prepareInstallationRestore(a.archive, a.parent)).rejects.toMatchObject({ code: "RESTORE_PREPARATION_FAILED" });
  expect(readdirSync(a.parent).filter(name => name.startsWith(".murage-"))).toEqual([]);
});
