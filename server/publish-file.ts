// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { closeSync, fstatSync, linkSync, lstatSync, openSync, renameSync, unlinkSync } from "node:fs";

/** Errors a filesystem without hard links answers link() with: exFAT and
 * FAT32 (USB sticks and SD cards) on macOS and Linux, many network shares.
 * Windows reports ERROR_INVALID_FUNCTION, which Node surfaces as EISDIR or
 * UNKNOWN. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EINVAL", "EMLINK", "EXDEV", "EISDIR", "UNKNOWN"]);

/** Publish a finished private file under its final name without ever
 * replacing an existing file. A hard link is atomic and refuses an existing
 * name. Where the drive has no hard links (0.1.60 audit W-A2) the name is
 * first reserved with an exclusive create, so no other writer can take it,
 * and the finished file, complete and flushed, is renamed over that
 * reservation only while it is still ours (second audit #3). On any failure
 * only our own reservation is removed. The source is gone afterwards in the
 * rename case, which callers allow for: it sits in their own scratch folder. */
export function publishNoReplace(source: string, target: string, testing: { link?: typeof linkSync; afterReserve?: () => void } = {}): void {
  try { (testing.link ?? linkSync)(source, target); return; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !NO_HARD_LINKS.has(code)) throw error;
  }
  const reservation = openSync(target, "wx", 0o600); // EEXIST if the name is taken
  let reserved: { dev: number; ino: number } | null;
  try { const stat = fstatSync(reservation); reserved = { dev: stat.dev, ino: stat.ino }; } finally { closeSync(reservation); }
  const ours = () => { try { const now = lstatSync(target); return now.isFile() && now.dev === reserved!.dev && now.ino === reserved!.ino && now.size === 0; } catch { return false; } };
  try {
    testing.afterReserve?.();
    // Someone replaced the reservation: never rename over their file.
    if (!ours()) throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
    renameSync(source, target);
    reserved = null;
  } finally {
    if (reserved && ours()) try { unlinkSync(target); } catch { /* left empty; never someone else's */ }
  }
}
