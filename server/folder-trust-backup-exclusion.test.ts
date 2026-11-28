// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: producer FUIGO-TRUST-V2 store seat (folder-trust-activity.ts); consumer backup and restore (installation-database-snapshot.ts,
// restore-prep-core.ts). MAIN ruling 1.0.21 fuigo-trust Q36/Q44: the latest folder-trust observation, its instance, generation and
// destination, and the once-only notice claim are left out of every backup and never restored. A booted profile still backs up.
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { ZipFile } from "yazl";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { folderTrustKeyDigest, initializeFolderTrustActivity, recordActivity } from "./folder-trust-activity.ts";
import { inspectInstallationDatabase, InstallationSnapshotError, snapshotInstallationDatabase } from "./installation-database-snapshot.ts";
import { prepareInstallationRestore } from "./installation-restore-preparation.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";

const roots: string[] = [];
afterEach(async () => { closeDatabase(); await stopWalMaintenance(); for (const root of roots.splice(0)) removeTempDirSync(root); });

const KEY = folderTrustKeyDigest("/neutral/project-a");
const OTHER = folderTrustKeyDigest("/neutral/project-b");

/** A messages.db written by the real initializers, then given the folder-trust table the booted server creates. */
async function fixture(populated: boolean) {
  const root = mkdtempSync(join(tmpdir(), "ft-backup-")); roots.push(root);
  const data = join(root, "data"), file = join(data, "messages.db");
  mkdirSync(data); mkdirSync(DATA_DIR, { recursive: true });
  database(); closeDatabase(); await stopWalMaintenance();
  copyFileSync(join(DATA_DIR, "messages.db"), file);
  const db = new DatabaseSync(file);
  try {
    initializeFolderTrustActivity(db);
    if (populated) {
      // both stored activity values, with the identity and destination metadata
      expect(recordActivity("thread-a", "saved-choice-sent", "rev-1", KEY, "saved-choice-sent", "none", db, { instanceId: "instance-a", generation: 2, destination: "own-local-home" })).toBe(true);
      expect(recordActivity("thread-b", "configuration-withheld", "rev-1", OTHER, "configuration-withheld", "saved-decline", db, { instanceId: "instance-a", generation: 2, destination: "cloud-home" })).toBe(true);
    }
  } finally { db.close(); }
  return { root, data, file };
}
const activityObjects = (db: DatabaseSync) => db.prepare("SELECT type, name FROM sqlite_schema WHERE tbl_name='thread_folder_trust_activity' ORDER BY name").all().map(row => `${row.type}:${row.name}`);
// the custody schema must SURVIVE an accepted backup/restore (empty, same tables), unlike the folder-trust table
const custodyTables = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'mailbox_sealed_%' ORDER BY name").all().map(row => String(row.name));
// the media ledger and its cursor (mailbox/media-custody.ts) are custody too: created with it, accepted empty, refused populated
const CUSTODY = ["mailbox_sealed_media", "mailbox_sealed_media_cursor", "mailbox_sealed_rows", "mailbox_sealed_threads"];
const rowCount = (db: DatabaseSync) => Number(db.prepare("SELECT count(*) AS n FROM thread_folder_trust_activity").get()!.n);

it.each([false, true])("a booted profile with the folder-trust table backs up (populated=%s)", async populated => {
  const f = await fixture(populated);
  const db = new DatabaseSync(f.file, { readOnly: true });
  try {
    expect(activityObjects(db)).toContain("table:thread_folder_trust_activity");
    expect(() => inspectInstallationDatabase(db), `populated=${populated}`).not.toThrow();
  } finally { db.close(); }
});

it.each([false, true])("the backup copy leaves the folder-trust activity out; the live profile keeps it (populated=%s)", async populated => {
  const f = await fixture(populated);
  const staged = join(f.root, "staged.db");
  const snapshot = await snapshotInstallationDatabase(f.data, staged).catch((error: unknown) => error);
  expect(snapshot, `folder-trust activity populated=${populated}`).toMatchObject({ status: "copied" });
  const copy = new DatabaseSync(staged, { readOnly: true });
  try { expect(activityObjects(copy)).toEqual([]); expect(custodyTables(copy), `custody schema kept in the backup copy populated=${populated}`).toEqual(CUSTODY); } finally { copy.close(); }
  // the staged file is vacuumed after the drop: no key digest or engine instance survives in a freed page
  const bytes = readFileSync(staged);
  for (const secret of [KEY, OTHER, "instance-a"]) expect(bytes.includes(Buffer.from(secret))).toBe(false);
  const live = new DatabaseSync(f.file, { readOnly: true });
  try { expect(rowCount(live)).toBe(populated ? 2 : 0); } finally { live.close(); }
});

it("restore never writes folder-trust activity back, so the once-only notice may show again", async () => {
  // an archive that still carries the table (an older build of this release wrote it)
  const f = await fixture(true);
  const bytes = readFileSync(f.file), hash = createHash("sha256").update(bytes).digest("hex"), archive = join(f.root, "carried.zip");
  const manifest = { format: "murage.installation", version: 1, snapshotId: randomUUID(), createdAt: new Date().toISOString(), restorePolicy: "paused-review-required",
    files: [{ path: "messages.db", bytes: bytes.length, sha256: hash }], omitted: [], missing: [], database: { status: "copied", messages: 0, threads: 0, bytes: bytes.length, sha256: hash } };
  const zip = new ZipFile(), output = pipeline(zip.outputStream as Readable, createWriteStream(archive));
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json", { compress: false });
  zip.addBuffer(bytes, "state/messages.db", { compress: false, mode: 0o100600 });
  zip.end(); await output;
  const preparation = prepareInstallationRestore(archive, f.root);
  await expect(preparation).resolves.toMatchObject({ stateDirectory: expect.any(String) });
  const prepared = await preparation;
  const db = new DatabaseSync(join(prepared.stateDirectory, "messages.db"));
  try {
    expect(activityObjects(db)).toEqual([]);
    expect(custodyTables(db)).toEqual(CUSTODY);
    // the claim was not restored: the same tuple is a first observation again
    expect(recordActivity("thread-a", "saved-choice-sent", "rev-1", KEY, "saved-choice-sent", "none", db)).toBe(true);
  } finally { db.close(); }
});

it.each([
  ["a pending seal", "INSERT INTO mailbox_sealed_threads (thread_id, generation, state) VALUES ('thread-a', 1, 'pending')"],
  ["a canonical row", "INSERT INTO mailbox_sealed_rows (thread_id, message_id, json) VALUES ('thread-a', 'message-a', '{}')"],
  ["a held media row", "INSERT INTO mailbox_sealed_media (thread_id, name, sha256, bytes) VALUES ('thread-a', 'media-a.png', 'aa', 1)"],
])("SFX-CUSTODY backs up an empty custody schema and refuses %s", async (custody, insert) => {
  const f = await fixture(false);
  const outcome = (target: string) => snapshotInstallationDatabase(f.data, target).then(result => result.status, (error: unknown) => {
    if (!(error instanceof InstallationSnapshotError)) throw error;
    return error.code;
  });
  const emptyCopy = join(f.root, "empty.db");
  const empty = await outcome(emptyCopy);
  expect(empty, `empty custody schema is accepted (${custody})`).toBe("copied");
  const copy = new DatabaseSync(emptyCopy, { readOnly: true });
  try { expect(custodyTables(copy), `accepted empty custody schema is kept in the backup copy (${custody})`).toEqual(CUSTODY); } finally { copy.close(); }
  const db = new DatabaseSync(f.file);
  try { db.exec(insert); } finally { db.close(); }
  const held = join(f.root, "held.db");
  expect([empty, await outcome(held), existsSync(held)], custody).toEqual(["copied", "DATABASE_SCHEMA_UNSUPPORTED", false]);
});
