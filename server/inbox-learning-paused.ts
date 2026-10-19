// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "LEARNING PAUSED FOR THE REST OF THE MONTH", IN NEEDS YOU (Settings L6).
//
// When this month's learning ledger reaches the stored ceiling, learning
// waits for the next month and the owner is asked once: double the limit and
// resume, or leave it paused. The row is DERIVED on every read from
// `learningCeilingStatus` (server/memory/settings.ts), never stored, so:
//   - a raise (configure with `ceiling`) clears it on the next read;
//   - the next month's ledger starts empty, so it clears itself;
//   - "Leave paused" sets it aside for this month only. It is kept in a small
//     file in the data folder holding that one month, so a restart keeps the
//     choice; the file is read against the current month, so it clears itself
//     when the month changes.
// It counts once in `decisions`, the number the sidebar and the tab read.
// Tokens only; no money figure.
import type { InboxLearningPaused } from "../shared/inbox.ts";
import { learningCeilingStatus } from "./memory/settings.ts";
import { readMemoryLearning } from "./memory/learning-policy.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export type { InboxLearningPaused };

type MemoryDb = Parameters<typeof learningCeilingStatus>[0];

const LEFT_FILE = () => join(DATA_DIR, "learning-paused-left.json");

/** The month the owner chose to leave paused, as stored; an empty set when none or unreadable. */
function storedLeftMonths(): ReadonlySet<string> {
  try {
    const month = (JSON.parse(readFileSync(LEFT_FILE(), "utf8")) as { month?: unknown }).month;
    return new Set(typeof month === "string" ? [month] : []);
  } catch { return new Set(); }
}

/** Set this month's pause aside. Returns the month, or null when learning is not paused. */
export function leaveLearningPaused(db: MemoryDb, at = Date.now()): string | null {
  const row = learningPausedRow(db, at, new Set());
  if (!row) return null;
  // One month only: writing replaces whatever an earlier month left.
  writeFileAtomic(LEFT_FILE(), JSON.stringify({ month: row.month }), { mode: 0o600 });
  return row.month;
}

export function resetLeftLearningPaused(): void {
  try { if (existsSync(LEFT_FILE())) rmSync(LEFT_FILE(), { force: true }); } catch { /* nothing stored */ }
}

/** The row, or null when learning is running, was left paused, or memory is not ready. */
export function learningPausedRow(db: MemoryDb, at = Date.now(), left?: ReadonlySet<string>): InboxLearningPaused | null {
  try {
    const settings = readMemoryLearning(db);
    const ceiling = learningCeilingStatus(db, settings.ceiling, at);
    // A limit of 0 is the owner switching learning off, which Memory says in its own words; nothing doubles from 0.
    if (!ceiling.paused || ceiling.input <= 0 || ceiling.output <= 0 || (left ?? storedLeftMonths()).has(ceiling.month)) return null;
    return { month: ceiling.month, input: ceiling.input, output: ceiling.output, inputUsed: ceiling.inputUsed, outputUsed: ceiling.outputUsed, learningRevision: settings.revision };
  } catch { return null; }
}

/** The Inbox read with the paused-learning row attached and counted once as owed. Unchanged when nothing is paused. */
export function withLearningPaused<T extends { decisions?: number }>(body: T, row: InboxLearningPaused | null): T & { learningPaused?: InboxLearningPaused } {
  if (!row) return body;
  return { ...body, learningPaused: row, ...(typeof body.decisions === "number" ? { decisions: body.decisions + 1 } : {}) };
}
