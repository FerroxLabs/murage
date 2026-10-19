// SPDX-License-Identifier: AGPL-3.0-or-later
// Room for new attachments and Files copies follows the disk itself (1.0.3).
// A fixed lifetime ceiling refused a 243 KB photo on a heavy install with
// hundreds of GB free. The only refusal now is a disk that is nearly full:
// a floor of free space stays untouched for the database and the system.
import { statfsSync } from "node:fs";
import { DISK_FULL_MESSAGE, DISK_UNKNOWN_MESSAGE } from "../shared/attachment-storage.ts";

/** Free space every new attachment or Files copy leaves on the disk. */
export const DISK_FLOOR_BYTES = 1024 * 1024 * 1024;

type FreeProbe = (path: string) => number;
const statfsProbe: FreeProbe = (path) => {
  const stat = statfsSync(path);
  return Number(stat.bavail) * Number(stat.bsize);
};
let probe: FreeProbe = statfsProbe;

/** Bytes promised to uploads still streaming. Attachments add and release
 * them; Files subtracts them too, so the two stores cannot both take the
 * same last free gigabyte. */
let outstanding = 0;

export function addOutstandingBytes(delta: number): void {
  outstanding = Math.max(0, outstanding + delta);
}
export function outstandingBytes(): number {
  return outstanding;
}

export type DiskSpaceError = Error & { status: 507; code: "disk-full" | "disk-unknown" };

export function diskSpaceError(code: "disk-full" | "disk-unknown"): DiskSpaceError {
  return Object.assign(new Error(code === "disk-full" ? DISK_FULL_MESSAGE : DISK_UNKNOWN_MESSAGE), { status: 507 as const, code });
}

/** The free bytes a new write may still use: the disk's free space minus the
 * floor and minus what streaming uploads already hold. Fails closed: a disk
 * whose free space cannot be read admits nothing. */
export function availableForNewBytes(path: string): number {
  let free: number;
  try {
    free = probe(path);
  } catch {
    throw diskSpaceError("disk-unknown");
  }
  if (!Number.isFinite(free)) throw diskSpaceError("disk-unknown");
  return Math.max(0, free - DISK_FLOOR_BYTES - outstanding);
}

/** Free disk bytes for reporting, or null when they cannot be read. */
export function freeDiskBytes(path: string): number | null {
  try {
    const free = probe(path);
    return Number.isFinite(free) ? free : null;
  } catch {
    return null;
  }
}

/** A write that ran out of disk is the same refusal as a full disk. */
export function isNoSpaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOSPC" || code === "EDQUOT";
}

/** Test-only: replace the free-space reading. Pass undefined to restore. */
export function __setFreeDiskProbeForTests(next: FreeProbe | undefined): void {
  probe = next ?? statfsProbe;
}
export function __resetOutstandingBytesForTests(): void {
  outstanding = 0;
}
