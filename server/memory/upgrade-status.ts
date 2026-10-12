// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The memory upgrade runs inside the server child before it listens, and it is
// synchronous, so the child cannot answer /api/health or speak over its
// parent port while it works. The desktop shell therefore watches this small
// file instead: it says whether an upgrade is running (and how big the copy
// is, so the shell can read progress from the growing `.partial` file), or
// why the upgrade stopped. Read side: electron/memory-upgrade-status.mjs.
// Holds numbers and a code from a closed set; no path, no secret.
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDiskFullError, MemoryMigrationError, type MemoryMigrationPhase } from "./schema.ts";
import type { StartupStorageEvent } from "./root-set-compaction.ts";
import type { RevocationIndexEvent } from "./revocation-index.ts";
import { startBlockingHeartbeat, type BlockingHeartbeat, type BlockingStep } from "./blocking-heartbeat.ts";

export const MEMORY_UPGRADE_STATUS_FILE = "memory-upgrade-status.json";
/** The most often a counted progress note is rewritten. */
export const PROGRESS_NOTE_INTERVAL_MS = 500;

export type MemoryUpgradeStatus = {
  v: 1;
  state: "upgrading" | "blocked";
  /** Set when blocked. */
  code?: "MEMORY_MIGRATION_DISK_SPACE" | "MEMORY_SCHEMA_NEWER" | "MEMORY_MIGRATION_FAILED";
  phase?: MemoryMigrationPhase["phase"] | StartupStorageEvent["phase"] | RevocationIndexEvent["phase"] | "indexing" | "repairing";
  /** Root sets converted (phase "converting"), or receipts indexed (phase "indexing"), so far, of total. */
  done?: number;
  total?: number;
  from?: number;
  pid: number;
  startedAt: number;
  updatedAt: number;
  dbBytes?: number;
  copyBytes?: number;
  needBytes?: number;
  freeBytes?: number | null;
  shortBytes?: number;
  newerVersion?: number;
  /** While a statement that cannot be cut into slices runs (the server thread is blocked): which step, and how long it has run. The
   * note is then rewritten by a heartbeat thread of the same process, so it stops moving only when the server does. */
  step?: BlockingStep;
  stepElapsedMs?: number;
  /** Basename of the growing copy, so progress is the size of that file over copyBytes. */
  partialName?: string;
};

function write(dataDir: string, status: MemoryUpgradeStatus) {
  const file = join(dataDir, MEMORY_UPGRADE_STATUS_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(status), { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* absent */ }
    // A full disk is exactly when this write fails; the upgrade's own error carries the message.
    if (!isDiskFullError(error)) throw error;
  }
}

/** Tracks one upgrade attempt. Every method swallows its own failure: a status
 * note never decides whether memory upgrades. */
export function memoryUpgradeReporter(dataDir: string, partialNameOf: (path: string) => string) {
  const startedAt = Date.now();
  let lastWrite = 0, lastPhase = "";
  // true (and the clock moves) when a counted progress note is due: a new phase at once, then at most one per interval
  const due = (phase: string) => { const now = Date.now(); if (phase === lastPhase && now - lastWrite < PROGRESS_NOTE_INTERVAL_MS) return false; lastPhase = phase; lastWrite = now; return true; };
  return {
    phase(event: MemoryMigrationPhase) {
      try {
        write(dataDir, {
          v: 1, state: "upgrading", phase: event.phase, from: event.from, pid: process.pid, startedAt, updatedAt: Date.now(),
          dbBytes: event.dbBytes, copyBytes: event.copyBytes, needBytes: event.needBytes, freeBytes: event.freeBytes,
          ...(event.partialPath ? { partialName: partialNameOf(event.partialPath) } : {}),
        });
      } catch { /* see above */ }
    },
    /** The work after the upgrade: the revocation index backfill (memory v8), the output-lineage
     * conversion and the space hand-back (memory v7). */
    storage(event: StartupStorageEvent | RevocationIndexEvent) {
      try {
        write(dataDir, { v: 1, state: "upgrading", phase: event.phase, pid: process.pid, startedAt, updatedAt: Date.now(),
          ...(event.phase === "reclaiming" ? { dbBytes: event.dbBytes } : { done: event.done, total: event.total }) });
      } catch { /* see above */ }
    },
    /** A stretch of the upgrade whose statements cannot report (they block the server thread): the note is kept moving by a heartbeat
     * thread until `end()`. */
    blocking(first: BlockingStep, from?: number, intervalMs?: number): BlockingHeartbeat {
      const base = { v: 1, state: "upgrading", phase: "migrating", ...(from !== undefined ? { from } : {}), pid: process.pid, startedAt };
      return startBlockingHeartbeat(join(dataDir, MEMORY_UPGRADE_STATUS_FILE), base, first, intervalMs);
    },
    /** The one-time index over the message history (server/message-tables.ts). With a count
     * (rows scanned of rows to scan) the shell moves its bar; without one it shows a steady figure.
     * Calls with a count are written at most twice a second, so a fast scan never costs more in
     * note writes than in reads; the first call, and one without a count, always write. */
    indexing(progress?: { done: number; total: number }) {
      if (progress && !due("indexing")) return;
      try { write(dataDir, { v: 1, state: "upgrading", phase: "indexing", pid: process.pid, startedAt, updatedAt: Date.now(), ...(progress ? { done: progress.done, total: progress.total } : {}) }); } catch { /* see above */ }
    },
    /** Memory validation that has to read the whole file (a changed schema or shape list), announced before it starts. */
    checking() {
      // called again between the slices of a long read: the first call of the phase, then at most one per interval
      if (!due("checking")) return;
      try { write(dataDir, { v: 1, state: "upgrading", phase: "checking", pid: process.pid, startedAt, updatedAt: Date.now() }); } catch { /* see above */ }
    },
    /** The output-lineage repair (server/memory/schema.ts), threads finished of threads to do. It runs on any start
     * while the repair marker is absent, so the note is written on every such start, not only the first. */
    repairing(progress: { done: number; total: number }) {
      // the first note of a repair (nothing finished yet) is always written; later ones are paced
      if (progress.done !== 0 ? !due("repairing") : (lastPhase = "repairing", lastWrite = Date.now(), false)) return;
      try { write(dataDir, { v: 1, state: "upgrading", phase: "repairing", pid: process.pid, startedAt, updatedAt: Date.now(), done: progress.done, total: progress.total }); } catch { /* see above */ }
    },
    blocked(error: unknown) {
      try {
        const known = error instanceof MemoryMigrationError ? error : null;
        write(dataDir, {
          v: 1, state: "blocked", code: known?.code ?? "MEMORY_MIGRATION_FAILED", pid: process.pid, startedAt, updatedAt: Date.now(),
          ...(known?.needBytes !== undefined ? { needBytes: known.needBytes } : {}),
          ...(known?.freeBytes !== undefined ? { freeBytes: known.freeBytes } : {}),
          ...(known?.shortBytes !== undefined ? { shortBytes: known.shortBytes } : {}),
          ...(known?.newerVersion !== undefined ? { newerVersion: known.newerVersion } : {}),
        });
      } catch { /* see above */ }
    },
    done() { try { rmSync(join(dataDir, MEMORY_UPGRADE_STATUS_FILE), { force: true }); } catch { /* absent */ } },
  };
}
