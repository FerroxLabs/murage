// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.12: the real thing, not a stand-in. Run with MURAGE_TEST_SMALL_VOLUME_A and
// _B naming two small, separate, empty volumes (a Linux tmpfs of 48 MB and 6 MB).
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { backupFixture, testAgeKeys } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { initializeEmailTables } from "./email/email-store.ts";

const volumeA = process.env.MURAGE_TEST_SMALL_VOLUME_A, volumeB = process.env.MURAGE_TEST_SMALL_VOLUME_B;
const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;
const MAIL_ROW = "INSERT INTO email_payloads(send_id, part, size, sha256, data) VALUES (?, 0, 1048576, 'fixture', randomblob(1048576))";

/** The database file is `databaseMegabytes` long. Mail rows are live pages the clean-up
 * pass has to rewrite; a dropped table leaves free pages that are only ever copied. */
function installationOn(volume: string, databaseMegabytes: number, padding: "free" | "mail" = "free", fileMegabytes = 0) {
  const f = backupFixture();
  const parent = mkdtempSync(join(volume, "run-")), data = join(parent, "installation");
  mkdirSync(data);
  for (const name of readdirSync(f.data)) if (["config.json", "bots.json", "messages.db", "messages.db-wal"].includes(name)) copyFileSync(join(f.data, name), join(data, name));
  const db = new DatabaseSync(join(data, "messages.db"));
  initializeEmailTables(db);
  if (padding === "free") db.exec("CREATE TABLE padding(v BLOB)");
  const insert = db.prepare(padding === "free" ? "INSERT INTO padding VALUES (randomblob(1048576))" : MAIL_ROW);
  for (let index = 0; index < databaseMegabytes; index++) insert.run(...(padding === "free" ? [] : [`mail-${index}`]));
  if (padding === "free") db.exec("DROP TABLE padding");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  mkdirSync(join(data, "workspaces"));
  writeFileSync(join(data, "workspaces", "video.bin"), randomBytes(fileMegabytes * 1024 ** 2));
  return { parent, data, cleanup: () => { f.db.close(); removeTempDirSync(f.parent); removeTempDirSync(parent); } };
}

describe.skipIf(!volumeA || !volumeB)("a backup on a drive that really fills up", () => {
  it("during the database copy", async () => {
    const f = installationOn(volumeA!, 20), keys = testAgeKeys();
    try {
      const caught = await writeEncryptedInstallationBackup(f.data, join(f.parent, "x.age"), { ...keys, selection }).catch(error => error);
      expect(caught).toMatchObject({ code: "BACKUP_DISK_FULL", captureStep: "stage" });
    } finally { f.cleanup(); }
  });
  it("during the clean-up pass over the copied database", async () => {
    const f = installationOn(volumeA!, 14, "mail"), keys = testAgeKeys();
    try {
      const caught = await writeEncryptedInstallationBackup(f.data, join(f.parent, "x.age"), { ...keys, selection }).catch(error => error);
      expect(caught).toMatchObject({ code: "BACKUP_DISK_FULL", captureStep: "stage" });
    } finally { f.cleanup(); }
  });
  it("during encryption, on the backup folder's drive", async () => {
    const f = installationOn(volumeA!, 1, "free", 8), keys = testAgeKeys();
    try {
      const folder = mkdtempSync(join(volumeB!, "backups-"));
      const caught = await writeEncryptedInstallationBackup(f.data, join(folder, "x.age"), { ...keys, selection }).catch(error => error);
      expect(caught).toMatchObject({ code: "BACKUP_DISK_FULL", captureStep: "encrypt" });
      removeTempDirSync(folder);
    } finally { f.cleanup(); }
  });
  it("the same run, with room on both drives, succeeds", async () => {
    const f = installationOn(volumeA!, 2), keys = testAgeKeys();
    try {
      const folder = mkdtempSync(join(volumeB!, "backups-"));
      const archive = join(folder, "x.age");
      expect((await writeEncryptedInstallationBackup(f.data, archive, { ...keys, selection })).path).toBe(archive);
      removeTempDirSync(folder);
    } finally { f.cleanup(); }
  });
});
