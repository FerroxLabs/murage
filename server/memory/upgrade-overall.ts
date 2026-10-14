// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one measure of how far a whole launch's upgrade has got (`overall`, 0 to 1), which never goes backwards, not even across a restart: its
// high-water mark is kept in a small file beside the data (not in messages.db, because the first part of the upgrade runs inside one
// transaction and the file must survive its rollback). Two trackers share it: the blocking stage before the server listens covers the first
// part of the range (STARTING_SHARE), the background stage after it covers the rest (upgrade-progress.ts takes the window).
import { renameSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const UPGRADE_OVERALL_FILE = "memory-upgrade-overall.json";
/** The share of the whole range the blocking stage covers (it is meant to take seconds; the background work takes most of the time). */
export const STARTING_SHARE = 0.15;
/** A high-water mark older than this belongs to an upgrade that was given up. */
const STALE_MS = 14 * 24 * 3600 * 1000;

/** Where a previous run of this same upgrade (same memory version) got to, or 0. */
export function readOverallFloor(dataDir: string, schema: number, now = Date.now()): number {
  try {
    const saved = JSON.parse(readFileSync(join(dataDir, UPGRADE_OVERALL_FILE), "utf8")) as { schema?: unknown; overall?: unknown; at?: unknown };
    if (saved.schema !== schema || typeof saved.overall !== "number" || typeof saved.at !== "number" || now - saved.at > STALE_MS) return 0;
    return Math.max(0, Math.min(1, saved.overall));
  } catch { return 0; }
}
/** Paced writer of the high-water mark: at most once a second and only for a visible step. Never throws. It returns the highest value that is on disk
 * (the floor it started from until the first successful write), so a caller publishes only what a restart would read back. */
export function overallWriter(dataDir: string, schema: number, now: () => number = Date.now, floor = 0): (overall: number, force?: boolean) => number {
  let lastAt = 0, lastValue = -1, saved = floor;
  return (overall, force = false) => {
    const at = now();
    if (!force && (at - lastAt < 1000 || overall - lastValue < 0.005)) return saved;
    const file = join(dataDir, UPGRADE_OVERALL_FILE), temp = `${file}.${process.pid}.tmp`;
    try { writeFileSync(temp, JSON.stringify({ v: 1, schema, overall, at }), { mode: 0o600 }); renameSync(temp, file); lastAt = at; lastValue = overall; saved = Math.max(saved, overall); }
    catch { try { rmSync(temp, { force: true }); } catch { /* absent */ } }
    return saved;
  };
}
/** The upgrade is complete: the next one starts from nothing. */
export function clearOverall(dataDir: string): void { try { rmSync(join(dataDir, UPGRADE_OVERALL_FILE), { force: true }); } catch { /* absent */ } }
