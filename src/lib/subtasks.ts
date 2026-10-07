// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Helpers (sub agents) as the chat shows them. One engine-neutral contract:
// the `turn.subtask` live event and the `subtasks` snapshot on the running
// task (lanes/bgturn SUBTASK-EVENTS.md). Nothing here knows which engine
// started a helper.
import type { Subtask } from "../../server/contracts";
import { formatElapsed } from "@/lib/working-time";
import { t } from "@/lib/i18n";

export type { Subtask };

export interface HelperState {
  /** the running turn's helpers per thread (whole list, latest event wins) */
  live: Record<string, Subtask[]>;
  /** helpers of settled turns per thread, oldest first, newest 12 kept */
  runs: Record<string, Subtask[][]>;
}
export const EMPTY_HELPERS: HelperState = { live: {}, runs: {} };
const KEEP_RUNS = 12;

const STATUSES = new Set(["started", "running", "done", "failed"]);

/** Only well formed rows get on screen; a bad frame never breaks the chat. */
export function normalizeSubtasks(value: unknown): Subtask[] | null {
  if (!Array.isArray(value)) return null;
  const rows: Subtask[] = [];
  for (const raw of value) {
    const row = raw as Partial<Subtask> | null;
    if (!row || typeof row.id !== "string" || !STATUSES.has(row.status as string) || typeof row.startedAt !== "number") continue;
    rows.push({
      id: row.id,
      label: typeof row.label === "string" && row.label.trim() ? row.label : "Helper",
      status: row.status as Subtask["status"],
      startedAt: row.startedAt,
      ...(typeof row.endedAt === "number" ? { endedAt: row.endedAt } : {}),
      toolCount: typeof row.toolCount === "number" && row.toolCount >= 0 ? row.toolCount : 0,
    });
  }
  return rows;
}

export function isWorking(row: Subtask): boolean {
  return row.status === "started" || row.status === "running";
}

/** The helper state after one runtime event. Any event that changes nothing
 * returns the same object so the caller can skip the re-render. */
export function helpersAfterEvent(
  state: HelperState,
  event: { type?: unknown; threadId?: unknown; subtasks?: unknown },
): HelperState {
  if (typeof event.threadId !== "string") return state;
  const threadId = event.threadId;
  if (event.type === "turn.subtask") {
    const rows = normalizeSubtasks(event.subtasks);
    if (!rows) return state;
    return { ...state, live: { ...state.live, [threadId]: rows } };
  }
  if (event.type !== "turn.started" && event.type !== "turn.completed" && event.type !== "session.exited") return state;
  const live = state.live[threadId];
  if (!live) return state;
  const { [threadId]: _dropped, ...rest } = state.live;
  if (event.type !== "turn.completed" || live.length === 0) return { ...state, live: rest };
  // The server ends every helper before turn.completed; one still open here
  // means a lost frame, and reads as failed rather than working forever.
  const settled = live.map((row) => (isWorking(row) ? { ...row, status: "failed" as const, endedAt: row.endedAt ?? Date.now() } : row));
  const past = [...(state.runs[threadId] ?? []), settled].slice(-KEEP_RUNS);
  return { live: rest, runs: { ...state.runs, [threadId]: past } };
}

/** How far along a list is: terminal rows weigh most, then tool calls. */
function progress(rows: Subtask[]): number {
  return rows.reduce((sum, row) => sum + (isWorking(row) ? 0 : 1000) + row.toolCount, 0);
}

/** After a reconnect the task snapshot and the last live event can differ.
 * The one further along wins; with no live events, the snapshot is the view. */
export function pickSubtasks(live: Subtask[] | undefined, snapshot: unknown): Subtask[] {
  const fromSnapshot = normalizeSubtasks(snapshot) ?? [];
  if (!live || live.length === 0) return fromSnapshot;
  if (fromSnapshot.length === 0) return live;
  if (fromSnapshot.length !== live.length) return fromSnapshot.length > live.length ? fromSnapshot : live;
  return progress(fromSnapshot) > progress(live) ? fromSnapshot : live;
}

export function workingCount(rows: Subtask[]): number {
  return rows.filter(isWorking).length;
}

/** The quiet line under the working indicator. */
export function helperLine(rows: Subtask[]): string {
  const working = workingCount(rows);
  if (working > 0) return working === 1 ? t("helpers.line.workingOne") : t("helpers.line.working", { n: working });
  return rows.length === 1 ? t("helpers.line.doneOne") : t("helpers.line.done", { n: rows.length });
}

export function statusLabel(row: Subtask): string {
  return t(isWorking(row) ? "helpers.status.working" : row.status === "failed" ? "helpers.status.failed" : "helpers.status.done");
}

export function elapsedText(row: Subtask, now = Date.now()): string {
  return formatElapsed((row.endedAt ?? now) - row.startedAt);
}

export function toolsText(row: Subtask): string {
  return row.toolCount === 1 ? t("helpers.toolsOne") : t("helpers.tools", { n: row.toolCount });
}
