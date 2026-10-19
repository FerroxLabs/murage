// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The words and data for routines Murage kept but could not read
// (server/routines.ts keepUnloaded), shown on the Routines page.

export interface UnloadableRoutine {
  id: string;
  name?: string;
  botId?: string;
  reason: "schedule" | "watch";
}

/** The plain note shown for one kept routine. */
export function unloadableRoutineNote(reason: UnloadableRoutine["reason"]): string {
  return reason === "watch"
    ? "This routine's file watch could not be read, so it will not run. Delete it, or update Murage to a version that can read it."
    : "This routine's schedule could not be read, so it will not run. Delete it, or update Murage to a version that can read it.";
}

/** The routines the scheduler kept without loading, from GET /api/routines. */
export function unloadableFromResponse(response: unknown): UnloadableRoutine[] {
  const list = (response as { unloadable?: unknown } | null)?.unloadable;
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is UnloadableRoutine =>
    Boolean(item) && typeof item.id === "string" && (item.reason === "schedule" || item.reason === "watch"));
}
