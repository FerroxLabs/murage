// SPDX-License-Identifier: AGPL-3.0-or-later
// The 103,935-message copy for the SMOOTH-FTS-MERGE qualification tests (search-merge-r6-103k-*.test.ts). CI has no copy and skips them.
// FTS_QUAL_103K_DIR names a folder holding one FRESH copy per test file (`<dir>/<name>/messages.db`, made with
// `cp -a rh3-data/pristine/messages.db* <dir>/<name>/` before the run; never the pristine files). The copy is MOVED into this test
// file's DATA_DIR (the run sets TMPDIR on the same filesystem so the move is a rename), so every run starts from a fresh copy.
import { existsSync, renameSync, copyFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "../config.ts";

export const COPY_ROOT = process.env.FTS_QUAL_103K_DIR ?? "";
export const haveCopy = (name: string) => COPY_ROOT !== "" && existsSync(join(COPY_ROOT, name, "messages.db"));

/** Moves the named fresh copy into DATA_DIR as messages.db (with its -wal and -shm when present). */
export function takeCopy(name: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = join(COPY_ROOT, name, `messages.db${suffix}`), to = join(DATA_DIR, `messages.db${suffix}`);
    if (!existsSync(from)) continue;
    try { renameSync(from, to); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error; copyFileSync(from, to); }
  }
}
