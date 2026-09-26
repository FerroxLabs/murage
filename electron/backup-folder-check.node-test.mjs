// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 audit W-A2: which folders can hold backups, decided when the folder
// is chosen. Windows needs this computer's own NTFS drive; macOS and Linux
// take any folder (a drive without hard links is published by rename).
import assert from "node:assert/strict";
import test from "node:test";
import { backupFolderRefusal, BACKUP_FOLDER_REFUSALS } from "./backup-folder-check.mjs";

test("Windows: only a folder on this computer's own NTFS drive", () => {
  const on = (type, format) => ({ platform: "win32", drive: () => ({ type, format }) });
  assert.equal(backupFolderRefusal("C:\\Users\\Sam Lee\\Documents\\Murage Backups", on("Fixed", "NTFS")), null);
  assert.equal(backupFolderRefusal("E:\\Backups", on("Removable", "exFAT")), "BACKUP_FOLDER_REMOVABLE");
  assert.equal(backupFolderRefusal("E:\\Backups", on("Removable", "NTFS")), "BACKUP_FOLDER_REMOVABLE");
  assert.equal(backupFolderRefusal("F:\\Backups", on("Fixed", "exFAT")), "BACKUP_FOLDER_NOT_NTFS");
  assert.equal(backupFolderRefusal("F:\\Backups", on("Fixed", "FAT32")), "BACKUP_FOLDER_NOT_NTFS");
  assert.equal(backupFolderRefusal("Z:\\Backups", on("Network", "NTFS")), "BACKUP_FOLDER_NETWORK");
  assert.equal(backupFolderRefusal("\\\\server\\share\\Backups", on("Fixed", "NTFS")), "BACKUP_FOLDER_NETWORK");
  assert.equal(backupFolderRefusal("C:\\x", { platform: "win32", drive: () => null }), "BACKUP_FOLDER_UNCHECKED");
});

test("macOS and Linux accept any folder, USB drives included", () => {
  for (const platform of ["darwin", "linux"]) assert.equal(backupFolderRefusal("/Volumes/USB STICK/Backups", { platform, drive: () => { throw Error("never asked"); } }), null);
});

test("every refusal has a plain sentence without codes or em dashes", () => {
  for (const code of ["BACKUP_FOLDER_REMOVABLE", "BACKUP_FOLDER_NETWORK", "BACKUP_FOLDER_NOT_NTFS", "BACKUP_FOLDER_UNCHECKED"]) {
    assert.match(BACKUP_FOLDER_REFUSALS[code], /\.$/);
    assert.doesNotMatch(BACKUP_FOLDER_REFUSALS[code], /[A-Z]{2,}_[A-Z_]+|—/);
  }
});
