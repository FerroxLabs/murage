// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 audit W-A3: "Save the downloaded off-site copy to a folder" published
// with a hard link, which exFAT and FAT32 (USB sticks) don't have, so it
// always failed there and left Murage-backup-<id>/backup.partial and
// receipt.json behind. It now renames the finished copy into place where
// links are missing, and a failed export removes what it made.
//
// Needs an exFAT volume: MURAGE_TEST_EXFAT names its mount point (see
// server/backup-exfat.test.ts). The clean-up case runs everywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { exportRemoteBackup } from "./backup-remote-export.mjs";

const mount = process.env.MURAGE_TEST_EXFAT;
function source(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "murage-export-exfat-"))); t.after(() => safeWipeSync(root));
  const job = path.join(root, "job"); mkdirSync(job, { mode: 0o700 });
  const bytes = Buffer.from("age-encrypted-bytes"), receipt = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  writeFileSync(path.join(job, "backup.age"), bytes, { mode: 0o600 }); writeFileSync(path.join(job, "receipt.json"), JSON.stringify(receipt), { mode: 0o600 });
  return { root, bytes, copy: { state: "downloaded-verified", snapshotId: "a".repeat(64), receipt, archivePath: path.join(job, "backup.age"), receiptPath: path.join(job, "receipt.json") } };
}

test("a verified download saves to a folder on an exFAT drive", { skip: !mount || !existsSync(mount) || process.platform === "win32" }, t => {
  const f = source(t), target = mkdtempSync(path.join(mount, "t-"));
  t.after(() => safeWipeSync(target));
  const result = exportRemoteBackup(f.copy, target, { sourceRoot: f.root, excludedRoots: [] });
  assert.equal(result.saved, true);
  assert.deepEqual(readFileSync(result.archivePath), f.bytes);
  assert.deepEqual(readdirSync(result.directory).filter(name => !name.startsWith("._")).sort(), ["backup.age", "receipt.json"]);
});

test("a failed export leaves nothing behind in the chosen folder", { skip: process.platform === "win32" && "owner checks are POSIX-only" }, t => {
  const f = source(t), target = path.join(f.root, "downloads"); mkdirSync(target, { mode: 0o700 });
  writeFileSync(f.copy.archivePath, Buffer.alloc(f.bytes.length)); // no longer matches its receipt
  assert.throws(() => exportRemoteBackup(f.copy, target, { sourceRoot: f.root, excludedRoots: [] }), /BACKUP_REMOTE_EXPORT_UNCONFIRMED/);
  assert.deepEqual(readdirSync(target), []);
});
