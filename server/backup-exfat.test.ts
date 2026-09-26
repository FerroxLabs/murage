// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 audit W-A2: a backup folder on an exFAT or FAT32 drive (the usual USB
// stick) failed every time on macOS and Linux, because the finished file was
// published with a hard link and those drives have none. It is now renamed
// into place there, after checking the name is free (server/publish-file.ts).
//
// Needs an exFAT volume: set MURAGE_TEST_EXFAT to its mount point (on macOS:
// `hdiutil create -size 64m -fs ExFAT -volname T exfat.dmg` then
// `hdiutil attach exfat.dmg -mountpoint <dir> -nobrowse`). Skipped otherwise.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeEncryptedInstallationBackup, restoreEncryptedInstallationNew } from "./installation-encrypted-backup.ts";
import { writeInstallationArchive } from "./installation-archive.ts";
import { backupFixture, testAgeKeys } from "./testing/backup-fixture.ts";

const mount = process.env.MURAGE_TEST_EXFAT;
const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;
const visible = (folder: string) => readdirSync(folder).filter(name => !name.startsWith("._")).sort();

it.skipIf(!mount || !existsSync(mount) || !process.env.MURAGE_BACKUP_TEST_AGE_DIR)("a backup into a folder on an exFAT drive is written, verified and restorable", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  writeFileSync(join(f.data, "about-me.md"), "I keep bees.\n");
  const folder = mkdtempSync(join(mount!, "Murage Backups-"));
  try {
    const saved = await writeEncryptedInstallationBackup(f.data, join(folder, "backup.age"), { ...keys, selection });
    expect(visible(folder)).toEqual(["backup.age"]);
    const restored = join(f.parent, "restored");
    await restoreEncryptedInstallationNew(restored, join(folder, "backup.age"), saved.sha256, keys);
    expect(readFileSync(join(restored, "about-me.md"), "utf8")).toBe("I keep bees.\n");
  } finally { f.db.close(); rmSync(folder, { recursive: true, force: true }); rmSync(f.parent, { recursive: true, force: true }); }
}, 60_000);

it.skipIf(!mount || !existsSync(mount))("an older-style .zip recovery file can be saved to an exFAT drive", async () => {
  const f = backupFixture();
  const folder = mkdtempSync(join(mount!, "Murage Backups-"));
  try {
    await writeInstallationArchive(f.data, join(folder, "recovery.zip"));
    expect(visible(folder)).toEqual(["recovery.zip"]);
  } finally { f.db.close(); rmSync(folder, { recursive: true, force: true }); rmSync(f.parent, { recursive: true, force: true }); }
}, 60_000);

it.skipIf(!mount || !existsSync(mount) || !process.env.MURAGE_BACKUP_TEST_AGE_DIR)("an existing file of the same name on an exFAT drive is never replaced", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  const folder = mkdtempSync(join(mount!, "Murage Backups-"));
  writeFileSync(join(folder, "backup.age"), "someone else's bytes");
  try {
    const refused = await writeEncryptedInstallationBackup(f.data, join(folder, "backup.age"), { ...keys, selection }).then(() => "made", (error: { code?: string }) => error.code);
    expect(refused).toBe("DESTINATION_EXISTS");
    expect(readFileSync(join(folder, "backup.age"), "utf8")).toBe("someone else's bytes");
    expect(visible(folder)).toEqual(["backup.age"]);
  } finally { f.db.close(); rmSync(folder, { recursive: true, force: true }); rmSync(f.parent, { recursive: true, force: true }); }
}, 60_000);
