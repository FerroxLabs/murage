// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-K K1 (138): a chat with no model of its own follows its bot.
// `task.modelSelection` absent = follows the bot's model. A chat keeps a
// model of its own only when the owner picked one in that chat.
//
// The one-time cleanup at the first 1.0.4 load: every chat before 1.0.4 was
// born with a copy of its bot's model (the old backfill and clones), so a
// copy that still equals the bot's model was never a pick and is dropped.
// A different pick stays. Equality must be proved; anything else keeps the pin.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import type { ModelSelection } from "./contracts.ts";

export const FOLLOW_MODEL_MARKER = ".threads-follow-model-v1";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = canonical(item);
    }
    return out;
  }
  return value;
}

/** Deep equality of two selections (key order and absent keys do not count). */
export function sameSelection(a: ModelSelection | undefined, b: ModelSelection | undefined): boolean {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  try { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); } catch { return false; }
}

interface FollowBot { modelSelection: ModelSelection; tasks?: Array<{ modelSelection?: ModelSelection }> }

/** Drops every chat pin that equals its bot's model. Returns how many were dropped. */
export function clearFollowingPins(bots: readonly FollowBot[]): number {
  let cleared = 0;
  for (const bot of bots) for (const task of bot.tasks ?? []) {
    if (task.modelSelection !== undefined && sameSelection(task.modelSelection, bot.modelSelection)) { delete task.modelSelection; cleared++; }
  }
  return cleared;
}

export function followMarkerPath(dataDir: string): string { return join(dataDir, FOLLOW_MODEL_MARKER); }
export function followCleanupDone(dataDir: string): boolean { return existsSync(followMarkerPath(dataDir)); }
/** Written only after the cleanup's save landed: a crash before it repeats the (idempotent) cleanup. */
export function markFollowCleanupDone(dataDir: string): void { writeFileAtomic(followMarkerPath(dataDir), `${Date.now()}\n`, { mode: 0o600 }); }
