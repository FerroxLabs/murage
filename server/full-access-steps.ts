// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Full access answers almost every step a bot takes once engines route their
// asks to Murage (the stop line needs them to), so its approvals fold into one
// quiet line per run of steps: "Approved 12 steps (Full access)", counting up,
// opening to list the steps (src/components/ApprovedStepsRow.tsx). The
// decision log keeps one row per step regardless.
import type { Message } from "./store.ts";

export const FULL_ACCESS_STEPS_KEPT = 200;

export type StepLevel = "Full access" | "No limits";

export function fullAccessStepsLabel(count: number, level: StepLevel = "Full access"): string {
  return `Approved ${count} ${count === 1 ? "step" : "steps"} (${level})`;
}

/** The tool patch that adds `step` to the current line, or null when a new
 * line must start: the bot said something, a card or another approval chip
 * came in between, or this is another turn. Tool chips in between do not
 * break the run; they are the steps being approved. */
export function extendStepLine(messages: readonly Message[], lineId: string | undefined, turnId: string | undefined, step: string, level: StepLevel = "Full access"): NonNullable<Message["tool"]> | null {
  const at = lineId ? messages.findIndex((message) => message.id === lineId) : -1;
  const line = at >= 0 ? messages[at] : undefined;
  if (!line?.tool?.steps || line.turnId !== turnId || !line.tool.name.endsWith(`(${level})`)) return null;
  const quiet = messages.slice(at + 1).every((message) =>
    message.kind === "activity" && message.tool?.steps === undefined && !/^auto-approved /.test(message.tool?.name ?? ""));
  if (!quiet) return null;
  const count = (line.tool.stepCount ?? line.tool.steps.length) + 1;
  return { ...line.tool, name: fullAccessStepsLabel(count, level), steps: [...line.tool.steps, step].slice(-FULL_ACCESS_STEPS_KEPT), stepCount: count };
}

export function newStepLine(step: string, level: StepLevel = "Full access"): NonNullable<Message["tool"]> {
  return { name: fullAccessStepsLabel(1, level), ok: true, steps: [step], stepCount: 1 };
}
