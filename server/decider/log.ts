// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One row per decision call at <DATA_DIR>/decider-log/YYYY-MM.ndjson, mode
// 0600: when, which seam, the outcome, the chosen option's key and numbers,
// latency, input tokens and a 16-character hash of the state. Never room
// text, descriptions or a key. Separate from decision-log.ts (approvals).
// The folder is runtime state: excluded from backups (data-dir-inventory.ts).
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { DATA_DIR } from "../config.ts";
import type { DeciderFailure, DeciderProvider, DeciderSeam } from "./types.ts";

export const DECIDER_LOG_DIR = "decider-log";
export const DECIDER_LOG_RETENTION_DAYS = 180;

export interface DeciderLogRow {
  at: string;
  seam: DeciderSeam;
  provider: DeciderProvider;
  ok: boolean;
  reason?: DeciderFailure;
  status?: number;
  choice: string | null;
  pTop: number | null;
  margin: number | null;
  latencyMs: number;
  inputTokens: number | null;
  stateHash: string;
}

export function hashState(state: unknown): string {
  let json = "";
  try {
    json = JSON.stringify(state) ?? "";
  } catch {
    json = "";
  }
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

let tail: Promise<unknown> = Promise.resolve();
let inFlight = 0;
const swept = new Set<string>();

async function sweep(dir: string, now: number): Promise<void> {
  const cutoff = now - DECIDER_LOG_RETENTION_DAYS * 86_400_000;
  for (const name of await readdir(dir)) {
    const match = /^(\d{4})-(\d{2})\.ndjson$/.exec(name);
    if (!match) continue;
    // A month file is expired once its last day is past the cutoff.
    const monthEnd = Date.UTC(Number(match[1]), Number(match[2]), 1);
    if (monthEnd < cutoff) await rm(join(dir, name), { force: true });
  }
}

/** Fire and forget; a logging failure never reaches the caller. */
export function appendDeciderLog(row: DeciderLogRow, dataDir: string = DATA_DIR, now: number = Date.now()): void {
  inFlight++;
  tail = tail.then(async () => {
    try {
      const dir = join(dataDir, DECIDER_LOG_DIR);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${new Date(now).toISOString().slice(0, 7)}.ndjson`);
      await appendFile(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      if (process.platform !== "win32") await chmod(file, 0o600);
      if (!swept.has(dir)) {
        swept.add(dir);
        await sweep(dir, now);
      }
    } catch {
      // never let a log write change a decision
    } finally {
      inFlight--;
    }
  });
}

/** For tests: wait for queued writes. */
export async function flushDeciderLog(_dataDir?: string): Promise<void> {
  await tail;
  while (inFlight > 0) await tail;
}
