// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";
import { rateLimited } from "./observe.ts";

/** Checkpoint budget for a secondary connection: TRUNCATE holds the writer lock while it waits for readers, so
 * the wait is capped and a blocked checkpoint is logged, not waited out (PROPOSAL-v2 10.3). */
export const CHECKPOINT_BUSY_MS = 50;

/** `PRAGMA wal_checkpoint(TRUNCATE)` with at most CHECKPOINT_BUSY_MS of lock wait. Returns true when the log was
 * fully checkpointed and truncated; false when a reader or writer blocked it (the next checkpoint takes it). */
export function checkpointTruncate(db: DatabaseSync, op = "checkpoint", restoreBusyMs = 5000): boolean {
  let blocked = false;
  try {
    db.exec(`PRAGMA busy_timeout=${CHECKPOINT_BUSY_MS}`);
    const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number } | undefined;
    blocked = Number(row?.busy ?? 0) !== 0;
  } catch { blocked = true; }
  finally { try { db.exec(`PRAGMA busy_timeout=${restoreBusyMs}`); } catch { /* closed */ } }
  if (blocked) rateLimited(`sqlite-checkpoint:${op}`, 60_000, suppressed => `[sqlite] busy op=${op} waited=${CHECKPOINT_BUSY_MS} holder=reader${suppressed ? ` more=${suppressed}` : ""}`);
  return !blocked;
}
