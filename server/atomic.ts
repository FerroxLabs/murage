// Durable, atomic file replace: write to a sibling temp file, fsync it, then
// rename over the target. rename(2) is atomic on the same filesystem, so a
// crash or power loss mid-write can never leave a truncated file behind — a
// reader always sees either the complete old contents or the complete new
// ones. Without this, an interrupted writeFileSync produces half-written JSON
// that fails to parse on next boot and is silently treated as empty state.
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

// Windows refuses a rename onto an existing path while anything else holds a
// handle to either file, and a virus scanner or the search indexer opening a
// just-closed file for a few milliseconds is enough. It surfaces as EPERM,
// EACCES or EBUSY from a replacement that would succeed a moment later, and
// every caller treats a throw as a failed save. Only those codes, and only on
// Windows, are retried: on POSIX the same codes are a real permission or mount
// problem that a delay would hide without fixing. Worst case is ~155 ms over
// six attempts, spent synchronously because every caller is a synchronous
// save path — and only ever on the Windows failure path.
const RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80] as const;
const RETRYABLE_WINDOWS_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* blocking wait not allowed on this thread: retry at once */
  }
}

/** Rename `from` over `to`, retrying only a transient Windows refusal.
 * `rename`, `platform` and `sleep` are injectable for tests: no portable way
 * exists to make a real filesystem produce a transient EPERM on demand. */
export function renameWithRetry(
  from: string,
  to: string,
  rename: (from: string, to: string) => void = renameSync,
  platform: NodeJS.Platform = process.platform,
  sleep: (ms: number) => void = sleepSync,
): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (platform !== "win32" || typeof code !== "string" || !RETRYABLE_WINDOWS_RENAME_CODES.has(code) || delay === undefined) {
        throw error;
      }
      sleep(delay);
    }
  }
}

export function writeFileAtomic(path: string, data: string, options: { mode?: number } = {}): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    // Apply sensitive-file permissions to the temporary inode itself. The
    // final rename preserves them and never leaves a broader-permission
    // config file visible between the write and a later chmod.
    fd = openSync(tmp, "w", options.mode);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameWithRetry(tmp, path);
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort cleanup */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}

/** Owner state written by a release that passed no mode (or loosened by hand)
 * is tightened to 0600 on load, as upstream #1620 does for the registries.
 * Best effort: a file that cannot be tightened must never stop Murage from
 * loading, and its next save replaces it with a 0600 one anyway. Windows has
 * no POSIX mode bits. Returns whether the mode changed. */
export function tightenOwnerOnlyFile(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return false;
  try {
    // Only a plain file: a directory or link in a record's place is damaged
    // state for recovery to report, and chmod would follow a link.
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) === 0) return false;
    chmodSync(path, 0o600);
    return true;
  } catch {
    return false; /* absent, or not ours to change */
  }
}
