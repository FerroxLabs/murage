// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where an encrypted backup keeps its plaintext working files (0.1.60 second
// audit, #1). The backup folder may be a USB stick formatted exFAT or FAT32,
// which keeps no permissions: anything written there is readable by every
// account and survives a crash or a pulled stick. So NO plaintext byte goes
// there: the staged records, the database snapshot and the readback's
// decrypted archive live in an owner-only folder beside Murage's data folder
// (the same volume, like the closed-app control folder), and only the
// ciphertext is written into the backup folder.
//
// Space: this needs, on the data folder's drive, about the size of the
// backup (the readback decrypts it once) plus the database and records,
// for the duration of one backup.
//
// Each run folder is named with its process id. A folder whose process is
// gone (a crash, a forced quit) is removed the next time a backup starts and
// when the server starts, so a crash leaves plaintext on the owner's own
// disk, owner-only, only until then.
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { InstallationSnapshotError } from "./installation-database-snapshot.ts";

const RUN = /^run-(\d{1,10})-[A-Za-z0-9]{6}$/;

/** The owner-only folder for one installation's backup work. */
export function backupWorkRoot(dataDir: string): string {
  const root = dataDirLeasePaths(dataDir).canonicalDataDir;
  return join(dirname(root), ".murage-backup-work", createHash("sha256").update(root).digest("hex").slice(0, 32));
}

function privateFolder(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && stat.uid !== process.getuid?.())) throw new InstallationSnapshotError("BACKUP_FOLDER_NOT_WRITABLE");
  if (process.platform !== "win32" && (stat.mode & 0o077)) chmodSync(path, 0o700);
}

const alive = (pid: number) => {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

/** Remove run folders whose process has gone. Never throws. */
export function sweepBackupWork(dataDir: string): number {
  let removed = 0;
  try {
    const root = backupWorkRoot(dataDir);
    for (const name of readdirSync(root)) {
      const match = RUN.exec(name);
      if (!match || alive(Number(match[1]))) continue;
      try { rmSync(join(root, name), { recursive: true, force: true }); removed++; } catch { /* next time */ }
    }
  } catch { /* nothing to sweep */ }
  return removed;
}

/** A fresh owner-only run folder for one backup, after sweeping dead ones. */
export function createBackupWork(dataDir: string): string {
  const root = backupWorkRoot(dataDir);
  privateFolder(dirname(root)); privateFolder(root);
  sweepBackupWork(dataDir);
  const run = mkdtempSync(join(root, `run-${process.pid}-`));
  if (process.platform !== "win32") chmodSync(run, 0o700);
  return run;
}

/** Remove one run folder, then the empty folders above it. */
export function removeBackupWork(run: string): void {
  rmSync(run, { recursive: true, force: true });
  for (const folder of [dirname(run), dirname(dirname(run))]) { try { rmdirSync(folder); } catch { return; } }
}
