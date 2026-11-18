// SPDX-License-Identifier: AGPL-3.0-or-later
// Child-side helpers for the boot-tolerance rows that need a NORMAL start whose disk then falls under the checkpointer worker's floor (ACCEPTANCE.md C1
// setup): a data dir on the small filesystem, a real database with its real worker, a ballast that takes the free space under 64 MiB, and the wait for
// the worker's verdict. Imported only by children spawned from those tests; they set MURAGE_DATA_DIR before the first import of the server modules.
import { closeSync, mkdirSync, openSync, rmSync, statfsSync, writeSync } from "node:fs";

const MiB = 1024 * 1024;
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export function dataDirOf(guard: string): string {
  const dataDir = process.env.MURAGE_DATA_DIR;
  if (!dataDir || !process.env[guard]) { process.stderr.write("refusing: not started by its test\n"); process.exit(2); }
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}
/** Free space on the data dir's volume, in bytes. */
export function freeOf(dir: string): number { const s = statfsSync(dir); return s.bavail * s.bsize; }
/** Grows `file` until `dir`'s volume has at most `targetFree` bytes. */
export function ballastTo(dir: string, file: string, targetFree: number): void {
  const fd = openSync(file, "a"); const buf = Buffer.alloc(MiB, 1);
  try {
    for (;;) {
      const left = freeOf(dir) - targetFree; if (left <= 0) break;
      try { writeSync(fd, buf, 0, Math.min(MiB, Math.max(left, 1))); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOSPC") break; throw e; }
    }
  } finally { closeSync(fd); }
}
export function removeBallast(file: string): void { rmSync(file, { force: true }); }
/** Polls `check` (true = done) every `everyMs` up to `tries` times. */
export async function until(check: () => boolean, tries = 400, everyMs = 50): Promise<boolean> {
  for (let i = 0; i < tries; i++) { if (check()) return true; await sleep(everyMs); }
  return false;
}
