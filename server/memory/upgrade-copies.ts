// SPDX-License-Identifier: AGPL-3.0-or-later
// q1022-disk: the copies of messages.db a memory upgrade takes first (messages.pre-memory-v2/v3/v4.db, schema.ts) are a
// hand-rollback aid, not data: messages.db stays the authority. Each copy goes once the upgraded store has opened cleanly on
// MIN_CLEAN_OPENS launches after it was seen AND COPY_KEEP_MS has passed since the upgrade, never before. A copy that changes
// (size or time, a newer upgrade's copy under the same name) starts its count again. Until it goes, Storage shows its size.
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_PRE_V2_SNAPSHOT, MEMORY_PRE_V3_SNAPSHOT, MEMORY_PRE_V4_SNAPSHOT } from "./schema.ts";

export const UPGRADE_COPY_NAMES = [MEMORY_PRE_V2_SNAPSHOT, MEMORY_PRE_V3_SNAPSHOT, MEMORY_PRE_V4_SNAPSHOT] as const;
export const UPGRADE_COPY_NOTE = "memory-upgrade-copies.json";
export const MIN_CLEAN_OPENS = 2;
export const COPY_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

type Seen = { size: number; mtimeMs: number; opens: number; since: number };
let countedThisLaunch = false;

function readNote(dataDir: string): Record<string, Seen> {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, UPGRADE_COPY_NOTE), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, Seen> : {};
  } catch { return {}; }
}
function writeNote(dataDir: string, note: Record<string, Seen>): void {
  const file = join(dataDir, UPGRADE_COPY_NOTE);
  if (!Object.keys(note).length) { rmSync(file, { force: true }); return; }
  writeFileSync(`${file}.tmp`, JSON.stringify(note), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
const statOf = (path: string) => { try { const s = statSync(path); return s.isFile() ? s : null; } catch { return null; } };

/** Called by database.ts once the memory tables opened without migrating, on a writable start. Counts one clean open per
 * launch (process) and removes each copy that has had its opens and its days. Never throws: a failure keeps the copy. */
export function noteCleanMemoryOpen(dataDir: string, now: number): string[] {
  if (countedThisLaunch) return [];
  countedThisLaunch = true;
  const removed: string[] = [];
  try {
    const prior = readNote(dataDir), next: Record<string, Seen> = {};
    for (const name of UPGRADE_COPY_NAMES) {
      const stat = statOf(join(dataDir, name));
      if (!stat) continue;
      const was = prior[name];
      const same = was && was.size === stat.size && was.mtimeMs === stat.mtimeMs && Number.isFinite(was.since) && Number.isSafeInteger(was.opens);
      const seen: Seen = same ? { ...was, opens: was.opens + 1 } : { size: stat.size, mtimeMs: stat.mtimeMs, opens: 1, since: now };
      // its age runs from the upgrade that wrote it (the copy's time) or from when this release first saw it, whichever is
      // earlier; the clean launches are counted only from that first sight
      if (seen.opens >= MIN_CLEAN_OPENS && now - Math.min(seen.since, seen.mtimeMs) >= COPY_KEEP_MS) {
        for (const suffix of ["-wal", "-shm", "-journal", ""]) rmSync(join(dataDir, name + suffix), { force: true });
        removed.push(name);
        continue;
      }
      next[name] = seen;
    }
    writeNote(dataDir, next);
  } catch { /* the copies stay as they are; the next launch tries again */ }
  return removed;
}

/** What Storage shows: the bytes the upgrade copies still hold. */
export function upgradeCopiesUsage(dataDir: string): { bytes: number; count: number } {
  let bytes = 0, count = 0;
  for (const name of UPGRADE_COPY_NAMES) {
    const stat = statOf(join(dataDir, name));
    if (stat) { bytes += stat.size; count += 1; }
  }
  return { bytes, count };
}

export function resetUpgradeCopiesForTests(): void { countedThisLaunch = false; }
