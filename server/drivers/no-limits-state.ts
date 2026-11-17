// SPDX-License-Identifier: AGPL-3.0-or-later
import { cpSync, lstatSync, mkdirSync, readlinkSync, renameSync, statSync, symlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

/** Keep the same native sessions across a permission-level change. Permission
 * files are never among these state entries. Preserve an earlier scoped copy
 * before merging it, including any colliding native session files. */
export function linkNoLimitsState(scopedHome: string, stateHome: string, names: readonly string[]): void {
  for (const name of names) {
    const source = join(stateHome, name), scoped = join(scopedHome, name);
    let directory = true;
    try { directory = statSync(source).isDirectory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; mkdirSync(source, { recursive: true }); }
    let existing = false;
    try {
      const stat = lstatSync(scoped);
      if (stat.isSymbolicLink() && resolve(scopedHome, readlinkSync(scoped)) === resolve(source)) continue;
      existing = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const saved = existing ? `${scoped}.before-state-share-${randomUUID()}` : undefined;
    if (saved) {
      renameSync(scoped, saved);
      cpSync(saved, source, { recursive: true, force: false, errorOnExist: false, dereference: true });
    }
    try { symlinkSync(source, scoped, directory ? process.platform === "win32" ? "junction" : "dir" : "file"); }
    catch (error) { if (saved) renameSync(saved, scoped); throw error; }
  }
}
