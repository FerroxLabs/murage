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

export const MEMORY_UPGRADE_STATUS_FILE = "memory-upgrade-status.json";

export type MemoryUpgradeStatus = {
  v: 1;
  state: "upgrading" | "blocked";
  /** Set when blocked. */
  code?: "MEMORY_MIGRATION_DISK_SPACE" | "MEMORY_SCHEMA_NEWER" | "MEMORY_MIGRATION_FAILED";
  phase?: MemoryMigrationPhase["phase"] | StartupStorageEvent["phase"];
  /** Root sets converted so far, of total (phase "converting"). */
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
    /** The output-lineage conversion and space hand-back after the upgrade (memory v7). */
    storage(event: StartupStorageEvent) {
      try {
        write(dataDir, { v: 1, state: "upgrading", phase: event.phase, pid: process.pid, startedAt, updatedAt: Date.now(),
          ...(event.phase === "converting" ? { done: event.done, total: event.total } : { dbBytes: event.dbBytes }) });
      } catch { /* see above */ }
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
