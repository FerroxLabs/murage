// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One engine-neutral record of the sub agents and background tasks of a turn.
// Each driver feeds it from its own protocol; the result is the `turn.subtask`
// event (server/contracts.ts). Pure bookkeeping: no timers, no I/O.
import type { Subtask } from "./contracts.ts";

const LABEL_MAX = 160;
const TASKS_MAX = 64;

export class SubtaskTracker {
  private tasks = new Map<string, Subtask>();

  private label(raw: unknown, fallback: string): string {
    const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
    return (text || fallback).slice(0, LABEL_MAX);
  }

  /** Register a task; a repeat of a known id changes nothing. */
  start(id: string, label: unknown, now = Date.now()): Subtask | null {
    if (this.tasks.has(id) || this.tasks.size >= TASKS_MAX) return null;
    const task: Subtask = { id, label: this.label(label, "Helper"), status: "started", startedAt: now, toolCount: 0 };
    this.tasks.set(id, task);
    return { ...task };
  }

  progress(id: string, patch: { label?: unknown; toolCount?: unknown }): Subtask | null {
    const task = this.tasks.get(id);
    if (!task || task.status === "done" || task.status === "failed") return null;
    task.status = "running";
    if (typeof patch.toolCount === "number" && Number.isFinite(patch.toolCount)) task.toolCount = Math.max(task.toolCount, patch.toolCount);
    if (patch.label !== undefined) task.label = this.label(patch.label, task.label);
    return { ...task };
  }

  end(id: string, ok: boolean, now = Date.now()): Subtask | null {
    const task = this.tasks.get(id);
    if (!task || task.status === "done" || task.status === "failed") return null;
    task.status = ok ? "done" : "failed";
    task.endedAt = now;
    return { ...task };
  }

  /** Mark everything still open as failed; the changed tasks. */
  endAll(ok: boolean, now = Date.now()): Subtask[] {
    return [...this.tasks.keys()].map((id) => this.end(id, ok, now)).filter((task): task is Subtask => task !== null);
  }

  has(id: string): boolean {
    return this.tasks.has(id);
  }

  openCount(): number {
    let open = 0;
    for (const task of this.tasks.values()) if (task.status === "started" || task.status === "running") open += 1;
    return open;
  }

  snapshot(): Subtask[] {
    return [...this.tasks.values()].map((task) => ({ ...task }));
  }
}

/** How long an engine's turn stays open for its sub agents after the engine
 * first said it was done. Default 30 minutes, bounded to 1 minute through 2
 * hours. MURAGE_BACKGROUND_CAP_MIN_MS lowers the floor for tests. */
export const BACKGROUND_CAP_DEFAULT_MS = 30 * 60_000;
export const BACKGROUND_CAP_MAX_MS = 2 * 60 * 60_000;
export function backgroundWaitCapMs(configured?: number): number {
  const floorEnv = Number(process.env.MURAGE_BACKGROUND_CAP_MIN_MS ?? process.env.MURAGE_CLAUDE_BACKGROUND_CAP_MIN_MS);
  const floor = Number.isFinite(floorEnv) && floorEnv > 0 ? floorEnv : 60_000;
  const envCap = Number(process.env.MURAGE_BACKGROUND_CAP_MS);
  const wanted = configured ?? (Number.isFinite(envCap) && envCap > 0 ? envCap : BACKGROUND_CAP_DEFAULT_MS);
  return Math.min(BACKGROUND_CAP_MAX_MS, Math.max(floor, wanted));
}
/** The plain note a turn ends with when the cap passes (shown to the owner and
 * kept in the thread the bot reads next turn). */
export function backgroundCapNote(capMs: number): string {
  const minutes = Math.max(1, Math.round(capMs / 60_000));
  return `Stopped waiting: some helpers were still running after ${minutes} minutes, so I ended this turn and stopped them. Ask me to run them again if their results are still needed.`;
}
