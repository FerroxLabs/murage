// SPDX-License-Identifier: AGPL-3.0-or-later
// D4 (0.1.60 Windows re-test 3): Windows staged plaintext inside the backup
// folder. It now uses .murage-backup-work beside the data folder like Mac and
// Linux; on Windows that folder is made owner-only by ACL and checked on
// every backup.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { backupWorkRoot, createBackupWork, removeBackupWork } from "./backup-local-work.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-work-win-"))); roots.push(root); const data = join(root, ".murage"); mkdirSync(data); return { root, data }; }

it("Windows: the work folder is restricted to the owner when it isn't already, then reused as is", () => {
  const f = fixture(); const checked: string[] = [], restricted: string[] = []; let ownerOnly = false;
  const acl = { ownerOnly: (folder: string) => { checked.push(folder); return ownerOnly; }, restrict: (folder: string) => { restricted.push(folder); ownerOnly = true; } };
  const run = createBackupWork(f.data, { acl, platform: "win32" });
  const top = dirname(backupWorkRoot(f.data));
  // On a Windows host the product case-folds canonical paths (NTFS names are case-insensitive).
  const folded = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  expect(folded(top)).toBe(folded(join(f.root, ".murage-backup-work"))); expect(run.startsWith(backupWorkRoot(f.data))).toBe(true);
  expect(restricted).toEqual([top]); expect(checked).toEqual([top]);
  removeBackupWork(run);
  createBackupWork(f.data, { acl, platform: "win32" }); expect(restricted).toEqual([top]); expect(checked).toEqual([top, top]);
});
it("Windows: a work folder that can't be made owner-only refuses the backup", () => {
  const f = fixture();
  expect(() => createBackupWork(f.data, { acl: { ownerOnly: () => false, restrict: () => { throw new Error("BACKUP_WINDOWS_ACL_FAILED"); } }, platform: "win32" })).toThrow(/BACKUP_FOLDER_NOT_WRITABLE/);
});
it("Mac and Linux keep mode 0700 and never call the Windows ACL tools", () => {
  const f = fixture(); const acl = { ownerOnly: () => { throw new Error("not on POSIX"); }, restrict: () => { throw new Error("not on POSIX"); } };
  const run = createBackupWork(f.data, { acl, platform: "linux" }); removeBackupWork(run);
});
