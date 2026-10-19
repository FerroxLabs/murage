// SPDX-License-Identifier: AGPL-3.0-or-later
// r7: server instance fence. Every server process mints one id and publishes it, atomically, to a file
// only the app user can write. The root browser launcher re-reads it after taking a browser id's lock and
// refuses a launch requested by an older server process. See CANARY-DESIGN.md.
import { randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { cloudHomeInternal } from "./copy.ts";

/** Minted once per process start. Also what /api/health reports as `instance`. */
export const SERVER_INSTANCE = randomBytes(16).toString("base64url");
/** The app user owns /data/server-home (0700); the browser user cannot even traverse it. */
export const SERVER_INSTANCE_FILE = "/data/server-home/.server-instance";
/** The root launcher exits with this when the requesting server is not the current one. */
export const STALE_INSTANCE_EXIT = 76;
export const SERVER_INSTANCE_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

export interface InstanceFs {
  open: typeof openSync; write: typeof writeSync; fsync: typeof fsyncSync; close: typeof closeSync; rename: typeof renameSync; unlink: typeof unlinkSync;
}
const realFs: InstanceFs = { open: openSync, write: writeSync, fsync: fsyncSync, close: closeSync, rename: renameSync, unlink: unlinkSync };

/** Writes `<id>\n` to a temp file beside `file`, fsyncs it, then renames it over `file`. Throws on any failure. */
export function writeServerInstance(file = SERVER_INSTANCE_FILE, id = SERVER_INSTANCE, fs: InstanceFs = realFs): void {
  if (!SERVER_INSTANCE_PATTERN.test(id)) throw new Error(cloudHomeInternal.invalidServerInstance);
  const temp = join(dirname(file), `.server-instance.${process.pid}.tmp`);
  try { fs.unlink(temp); } catch { /* none left over */ }
  const fd = fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { fs.write(fd, `${id}\n`); fs.fsync(fd); } finally { fs.close(fd); }
    fs.rename(temp, file);
  } catch (error) {
    try { fs.unlink(temp); } catch { /* nothing to clean */ }
    throw error;
  }
}

let published = false;
/** Idempotent per process. Cloud home only: elsewhere there is no launcher to fence. */
export function ensureServerInstancePublished(env: NodeJS.ProcessEnv = process.env, write: () => void = () => writeServerInstance()): void {
  if (env.MURAGE_CLOUD_ROLE !== "home" || published) return;
  write();
  published = true;
}
export function resetServerInstanceForTests(): void { published = false; }
