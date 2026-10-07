// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// What is kept of a settled turn's helpers (sub agents) with the turn itself:
// a label, how it ended, how long it took, how many tools it used. Nothing the
// helper read, ran or returned. One shape for the server (which writes it onto
// the turn's closing message) and the client (which reads it back on load).

export interface TurnHelper {
  label: string;
  status: "done" | "failed";
  durationMs: number;
  toolCount: number;
}

const MAX_HELPERS = 64;
const MAX_LABEL = 160;

/** The persistable summary of a helper list. Accepts the live `Subtask` rows
 * or an already stored list; any field not named in `TurnHelper` is dropped,
 * and a helper still open reads as failed (it never finished). */
export function settledTurnHelpers(rows: unknown, now = Date.now()): TurnHelper[] {
  if (!Array.isArray(rows)) return [];
  const out: TurnHelper[] = [];
  for (const raw of rows) {
    if (out.length >= MAX_HELPERS) break;
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const label = typeof row.label === "string" ? row.label.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL) : "";
    const toolCount = typeof row.toolCount === "number" && Number.isFinite(row.toolCount) && row.toolCount >= 0 ? Math.floor(row.toolCount) : 0;
    let durationMs: number;
    if (typeof row.durationMs === "number") durationMs = row.durationMs;
    else if (typeof row.startedAt === "number") durationMs = (typeof row.endedAt === "number" ? row.endedAt : now) - row.startedAt;
    else continue;
    if (!Number.isFinite(durationMs)) continue;
    const status = row.status === "done" ? "done" : "failed";
    out.push({ label: label || "Helper", status, durationMs: Math.max(0, Math.round(durationMs)), toolCount });
  }
  return out;
}

/** What may be stored with a turn: the summary for the workspace owner's own
 * thread, nothing for anyone else's (a channel or shared-room audience never
 * sees a bot's helpers, live or afterwards). */
export function turnHelpersForThread(isOwnerThread: boolean, rows: unknown): TurnHelper[] {
  return isOwnerThread ? settledTurnHelpers(rows) : [];
}
