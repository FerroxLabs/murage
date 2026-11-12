// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The Cloud home data-ops lock: probe (arm gate, J4b) and exclusive hold (restore, J4c). No config import, so tests and children load it alone.
import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";

/** The Cloud home lock that murage-backup (the nightly restic run, deploy/cloud-home/murage-backup OPS_LOCK) and murage-commands (reset, undo, export, pre-reset snapshot: ops_lock) hold for the whole of any write to /data or the backup repository. */
export const CLOUD_DATA_OPS_LOCK = "/run/murage-data-ops.lock";

/** r3.4d J4b: true while any Cloud home data operation holds the shared lock, or when that cannot be told. A non-blocking shared flock is tried and let go at once (the holders take it exclusive): exit 0 means nobody holds it. Any other result (held, flock missing, unreadable path, killed, timed out) is busy: fail closed. Node has no flock call, so util-linux flock does it. */
export function cloudDataOpsBusy(lockPath: string = CLOUD_DATA_OPS_LOCK, flockBinary = "/usr/bin/flock"): boolean {
  try {
    const r = spawnSync(flockBinary, ["-n", "-s", lockPath, "true"], { stdio: "ignore", timeout: 5000 });
    return r.error !== undefined || r.signal !== null || r.status !== 0;
  } catch { return true; }
}

/** r3.4d J4c: HOLD the Cloud data-ops lock exclusive, for the restore. The lock descriptor is opened here and util-linux flock takes the lock on it (`flock -n -x <fd>`):
 * a flock belongs to the open file description, so it stays held after the short flock child exits, for as long as this process keeps the descriptor open. Held
 * means murage-backup and murage-commands (which wait on it) wait. release() closes the descriptor; a crash or exit of this process releases it too (the kernel drops
 * it). The descriptor is close-on-exec, so no turn, browser or other child inherits it. null = not taken (held by someone, flock missing, unreadable path): fail closed. */
export interface DataOpsHold { release(): void }
export function holdCloudDataOpsLock(lockPath: string = CLOUD_DATA_OPS_LOCK, flockBinary = "/usr/bin/flock"): DataOpsHold | null {
  let fd: number;
  try { fd = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NOCTTY); } catch { return null; }
  let ok = false;
  try {
    const r = spawnSync(flockBinary, ["-n", "-x", "3"], { stdio: ["ignore", "ignore", "ignore", fd], timeout: 5000 });
    ok = r.error === undefined && r.signal === null && r.status === 0;
  } catch { ok = false; }
  if (!ok) { try { closeSync(fd); } catch { /* closed */ } return null; }
  let open = true;
  return { release() { if (!open) return; open = false; try { closeSync(fd); } catch { /* closed */ } } };
}

