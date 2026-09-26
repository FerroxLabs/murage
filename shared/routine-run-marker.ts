// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One conversation per routine: every run of a bot routine works in the
// routine's own conversation, so the server writes a marker row where each
// run begins ("Run now: Log tick", "Scheduled run: Log tick"). The
// transcripts show it as a divider between runs, visible with Tool calls
// off. And because every run starts with the same standing instruction, the
// engine is told that it is a new run, so a history full of the same request
// does not read as the owner asking again and again.
//
// Shared with the renderer, so no node: imports here.

export type RoutineRunMarkerTrigger = "manual" | "schedule";

const LABEL: Record<RoutineRunMarkerTrigger, string> = { manual: "Run now", schedule: "Scheduled run" };

/** The marker row's name, as the server writes it. */
export function routineRunMarkerName(trigger: RoutineRunMarkerTrigger, routineName: string): string {
  return `${LABEL[trigger]}: ${routineName}`;
}

/** The marker a row carries, or undefined. Only the server's own row counts:
 * a settled activity from the bot with no provider turn, so a tool call a
 * turn made can never pass for one whatever it is called. */
export function routineRunMarker(message: {
  role: string;
  kind: string;
  turnId?: string;
  tool?: { name: string; ok?: boolean };
}): { trigger: RoutineRunMarkerTrigger; routineName: string } | undefined {
  if (message.role !== "bot" || message.kind !== "activity" || message.turnId || message.tool?.ok !== true) return undefined;
  const match = /^(Run now|Scheduled run): (.+)$/s.exec(message.tool.name);
  if (!match || !match[2]!.trim()) return undefined;
  return { trigger: match[1] === "Run now" ? "manual" : "schedule", routineName: match[2]! };
}

/** What the engine reads ahead of a run's instruction. */
export function routineRunPromptNote(trigger: RoutineRunMarkerTrigger, routineName: string): string {
  const which = trigger === "manual"
    ? `a new run of the routine "${routineName}" that the owner started with Run now`
    : `a new scheduled run of the routine "${routineName}"`;
  return `[This is ${which}. The routine's standing instruction follows. Copies of it earlier in this conversation started earlier runs; they are not the owner repeating a request. Do this run's work once.]`;
}

/** How an earlier run's instruction reads in a replayed history. */
export function routineRunHistoryLabel(trigger: RoutineRunMarkerTrigger, routineName: string): string {
  return trigger === "manual"
    ? `[Earlier run of the routine "${routineName}", started with Run now]`
    : `[Earlier scheduled run of the routine "${routineName}"]`;
}
