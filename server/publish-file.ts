// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { linkSync, lstatSync, renameSync } from "node:fs";

/** Errors a filesystem without hard links answers link() with: exFAT and
 * FAT32 (USB sticks and SD cards) on macOS and Linux, many network shares.
 * Windows reports ERROR_INVALID_FUNCTION, which Node surfaces as EISDIR or
 * UNKNOWN. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EINVAL", "EMLINK", "EXDEV", "EISDIR", "UNKNOWN"]);

/** Publish a finished private file under its final name without ever
 * replacing an existing file. A hard link is atomic and refuses an existing
 * name; where the drive has no hard links (0.1.60 audit W-A2) the file,
 * already complete and flushed beside the target, is renamed into place
 * after checking the name is free. The source is gone afterwards in that
 * case, which callers allow for: it always sits in their own scratch folder,
 * removed straight after. */
export function publishNoReplace(source: string, target: string): void {
  try { linkSync(source, target); return; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !NO_HARD_LINKS.has(code)) throw error;
    // EPERM on a drive that does support links is a permission refusal;
    // the rename below then fails the same way and is reported as such.
  }
  let exists = true;
  try { lstatSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
  if (exists) throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
  renameSync(source, target);
}
