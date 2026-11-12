// SPDX-License-Identifier: AGPL-3.0-or-later
// The root-only volume preparation of a Cloud home start, as the executable spec of its Python port in
// deploy/cloud-home/murage-home-launch.py (LANE-G-UPDATE-STATE-MACHINE r3 sec. 1, 7). Since r3 no release-slot byte runs as uid 0:
// the image-owned launcher binds /data, makes the engine homes and the approval broker directory and only then drops privileges and
// execs the slot supervisor. These functions are therefore never loaded at runtime on a home; they are kept here, unchanged, so the
// T-P5 test can run both implementations against the same scratch tree and diff the result.
import { cloudHomeCopy } from "./copy.ts";
import { chmodSync, chownSync, closeSync, constants, existsSync, fchmodSync, fchownSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLOUD_BROKER_DIR, CLOUD_ENGINES } from "./turn-process.ts";
import type { HomeIdentity } from "./supervisor.ts";

/** Engine homes are root:murage-eng-<engine> 2770: neither the server uid nor the
 * raw turn uid holds the group, so only the launcher (which adds exactly one
 * engine group inside bwrap) can reach a home. */
export function prepareEngineHomes(identity: Pick<HomeIdentity, "engineGids">, root = "/data/engine-homes", chown: (path: string, uid: number, gid: number) => void = chownSync): void {
  mkdirSync(root, { recursive: true, mode: 0o711 });
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error(cloudHomeCopy.invalidEngineHomeRoot);
  chown(root, 0, 0); chmodSync(root, 0o711);
  for (const engine of CLOUD_ENGINES) {
    for (const directory of [`${root}/${engine}`, `${root}/${engine}/tmp`]) {
      mkdirSync(directory, { recursive: true, mode: 0o2770 });
      if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error(cloudHomeCopy.invalidEngineHomeDirectory);
      chown(directory, 0, identity.engineGids[engine]); chmodSync(directory, 0o2770);
    }
  }
}

/** Claude's approval sockets live in a root:murage-turn 3770 directory (setgid, plus the sticky bit so a turn cannot unlink a socket it does not own): the server
 * (a murage-turn member) binds them, and the launcher binds only this directory
 * into Claude turns. Nothing is created inside any engine home. */
export function prepareBrokerDir(identity: Pick<HomeIdentity, "turnGid">, directory = CLOUD_BROKER_DIR, chown: (path: string, uid: number, gid: number) => void = chownSync): void {
  mkdirSync(directory, { recursive: true, mode: 0o3770 });
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error(cloudHomeCopy.invalidEngineHomeDirectory);
  chown(directory, 0, identity.turnGid); chmodSync(directory, 0o3770);
}

export function validateVolumeMarker(stat: { isFile(): boolean; uid: number; mode: number; size: number }, value: string, machineId: string): void {
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o077) || stat.size > 130 || value !== `${machineId}\n`) throw new Error(cloudHomeCopy.homeVolumeBelongsToAnotherMachineOrItsBindingIsInvalid);
}

export function assertUnboundVolumeEmpty(dataDir: string): void {
  if (!existsSync(join(dataDir, ".murage-home-machine")) && readdirSync(dataDir).some(name => name !== "lost+found")) throw new Error(cloudHomeCopy.unboundHomeVolumeIsNotEmpty);
}

export function bindHomeVolume(dataDir: string, machineId: string, uid: number, gid: number, proxyUid: number, proxyGid: number): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o711 });
  if (!lstatSync(dataDir).isDirectory() || lstatSync(dataDir).isSymbolicLink()) throw new Error(cloudHomeCopy.homeVolumeMustBeADirectory);
  assertUnboundVolumeEmpty(dataDir);
  const marker = join(dataDir, ".murage-home-machine");
  let fd: number;
  try {
    fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, `${machineId}\n`); } finally { closeSync(fd); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  fd = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    validateVolumeMarker(stat, readFileSync(fd, "utf8"), machineId);
  } finally { closeSync(fd); }
  // The shared data-dir lease (electron/data-dir-lease.mjs) lives beside the
  // data folder, so the server uid must be able to create files in /data. The
  // sticky bit keeps it from unlinking or renaming anything it does not own
  // (the machine marker, engine homes, browser, proxy); others keep traversal.
  chownSync(dataDir, 0, gid);
  chmodSync(dataDir, 0o1771);
  for (const [name, owner, group, mode] of [
    ["home", uid, gid, 0o700], ["home/secrets", uid, gid, 0o700], ["server-home", uid, gid, 0o700],
    ["proxy", uid, proxyGid, 0o2750], ["caddy", proxyUid, proxyGid, 0o700], ["browser", 0, 0, 0o711],
  ] as const) {
    const path = join(dataDir, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error(cloudHomeCopy.invalidHomeStorageDirectory);
    chownSync(path, owner, group); chmodSync(path, mode);
  }
  prepareHealthProbeDir(dataDir);
  prepareHomeEventsDir(dataDir, gid);
}

/** The data-write readiness probe's directory (deploy/cloud-home/murage-control DATA_PROBE_DIR): a top-level entry of the bound volume,
 *  root:root 0700, the only /data path murage-control.service may write. Made here, as root, only after the binding marker is valid
 *  (bindHomeVolume), so an unbound volume never holds it (assertUnboundVolumeEmpty), and before the launcher drops privileges, so no murage
 *  process can create the name first; /data's sticky bit then keeps the murage group from replacing it. Idempotent. The final component is
 *  created with mkdir (which never follows a symlink) and opened O_NOFOLLOW|O_DIRECTORY, then owner and mode are set on that descriptor;
 *  a symlink, a non-directory or a directory on another device is refused. Excluded from backups (server/data-dir-inventory.ts). */
export const HEALTH_PROBE_DIR_NAME = ".murage-health";
export function prepareHealthProbeDir(dataDir: string, chown: (fd: number, uid: number, gid: number) => void = fchownSync): void {
  const path = join(dataDir, HEALTH_PROBE_DIR_NAME);
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); } catch { throw new Error(cloudHomeCopy.invalidHomeStorageDirectory); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory() || stat.dev !== statSync(dataDir).dev) throw new Error(cloudHomeCopy.invalidHomeStorageDirectory);
    chown(fd, 0, 0);
    fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
}

/** The server's ops-event spool (server/home-events.ts): /data/.murage-events, made here as root before the server drops privileges. Root owned (so the
 *  server cannot rename or replace it, and root reading it by path cannot be redirected), group = the server's, mode 01770 (the server adds its own files,
 *  nothing else may). Created with mkdir (never follows a link) and opened O_NOFOLLOW|O_DIRECTORY; a symlink, a non-directory or another device is refused.
 *  murage-control (root) collects and removes the files. Excluded from backups. */
export const HOME_EVENTS_FOLDER = ".murage-events"; // the same name as server/home-events.ts HOME_EVENTS_DIR_NAME (a test pins it)
export function prepareHomeEventsDir(dataDir: string, gid: number, chown: (fd: number, uid: number, gid: number) => void = fchownSync): void {
  const path = join(dataDir, HOME_EVENTS_FOLDER);
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); } catch { throw new Error(cloudHomeCopy.invalidHomeStorageDirectory); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory() || stat.dev !== statSync(dataDir).dev) throw new Error(cloudHomeCopy.invalidHomeStorageDirectory);
    chown(fd, 0, gid);
    fchmodSync(fd, 0o1770);
  } finally { closeSync(fd); }
}


/** J4c: the Cloud data-ops lock (/run/murage-data-ops.lock, taken exclusive by murage-backup and murage-commands) is created by those root writers with UMask 0077, so
 * root:root 0600, which the server (the murage uid after setuid) cannot open: its restore arm probe would report busy forever and refuse every restore. Root makes it
 * root:<murage gid> 0660 before the drop, so the server can open it, probe it (shared, non-blocking) and hold it exclusive across a restore. The root writers open it
 * "a" and keep the mode. Created with O_NOFOLLOW; a symlink or a non-file is refused. */
export const CLOUD_DATA_OPS_LOCK_PATH = "/run/murage-data-ops.lock";
export function prepareDataOpsLock(identity: Pick<HomeIdentity, "gid">, path = CLOUD_DATA_OPS_LOCK_PATH, chown: (fd: number, uid: number, gid: number) => void = fchownSync): void {
  let fd: number;
  try { fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NOCTTY, 0o660); } catch { throw new Error(cloudHomeCopy.invalidHomeStorageDirectory); }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(cloudHomeCopy.invalidHomeStorageDirectory);
    chown(fd, 0, identity.gid);
    fchmodSync(fd, 0o660);
  } finally { closeSync(fd); }
}
