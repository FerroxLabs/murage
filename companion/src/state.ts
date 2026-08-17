// Where the sidecar keeps its own state, and how it writes it.
//
// Its own directory, not the harness's. The two processes have separate
// lifecycles and separate concerns, and a sidecar that writes into
// ~/.openmausbot would be reaching into somebody else's data layout — the
// exact coupling this design exists to avoid. If the harness reorganises its
// files tomorrow, nothing here notices.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** OMB_COMPANION_DIR isolates a test rig from a real paired fleet. */
export const DATA_DIR = process.env.OMB_COMPANION_DIR ?? join(homedir(), ".openmausbot-companion");

/** The directory, owner-only.
 *
 * What lives here is the paired fleet: one record per phone, each holding a
 * hash rather than a token. A hash is not a credential, so this is posture
 * rather than a hole — but the default 0755 publishes to every other account
 * on the machine which phones someone owns and when they last used them, and
 * there is no reason for that to be readable. */
export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  // mkdirSync's mode applies only to a directory it creates, and an install
  // from before this line already has a 0755 one.
  try {
    chmodSync(DATA_DIR, 0o700);
  } catch {
    /* someone else's directory, or a filesystem with no such notion */
  }
}

/**
 * Durable, atomic file replace: write a sibling temp file, fsync it, then
 * rename over the target. `rename(2)` is atomic on the same filesystem, so a
 * crash mid-write can never leave a truncated file behind — a reader sees
 * either the complete old contents or the complete new ones.
 *
 * It matters more here than it looks. This file holds the paired devices; a
 * half-written one fails to parse on next boot and is silently treated as
 * empty, which would sign every phone out with no way to tell why.
 */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    // 0600 on the temp file, so the mode is right from the moment it exists
    // and survives the rename — a chmod after the fact leaves a window where
    // the contents are already there and world-readable.
    fd = openSync(tmp, "w", 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
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
