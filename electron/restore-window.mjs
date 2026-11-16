// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// J5 (Fable J3/J4 Medium 1): the desktop's BackupCoordinator lives in the Electron host, outside the server process, so it reads the restore job's
// journal itself. A restore window is open while restore-job.json says armed, captured or swapped (server/email/restore-job.ts OPEN), and
// FAILS CLOSED when the journal is there but cannot be trusted (not a plain file, too big, bad JSON, unknown phase). No journal = closed.
// This reads only the journal (never the database marks), so it can refuse a backup slightly longer than the server's own windowOpen, never shorter.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OPEN = new Set(["armed", "captured", "swapped"]);
const PHASES = new Set(["armed", "captured", "swapped", "prepared", "aborted"]);

export function restoreWindowOpenOnDisk(installation) {
  let text;
  try {
    const file = join(installation, "restore-job.json");
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 64 * 1024) return true;
    text = readFileSync(file, "utf8");
  } catch (error) { return error?.code === "ENOENT" ? false : true; }
  try {
    const job = JSON.parse(text);
    if (job?.version !== 1 || !PHASES.has(job.phase)) return true;
    return OPEN.has(job.phase);
  } catch { return true; }
}
