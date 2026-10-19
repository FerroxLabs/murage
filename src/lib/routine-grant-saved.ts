// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AMEND-13 Rule 82d: after the server saved "Always allow for this routine",
// the conversation says "Saved for [Routine name]" and lists what was saved.
// The card itself leaves once answered, so the line lives here, per thread,
// until the owner closes it.
import { useSyncExternalStore } from "react";
import { savedForWords } from "@/lib/routine-grant-words";

export interface RoutineSaved { title: string; items: string[] }

const saved = new Map<string, RoutineSaved>();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

/** Record what the server saved (its own `saved` list, never the client's). */
export function noteRoutineSaved(threadId: string, routineName: string, keys: readonly string[]): void {
  if (!keys.length) return;
  if (saved.size >= 50 && !saved.has(threadId)) saved.delete(saved.keys().next().value!);
  saved.set(threadId, savedForWords(routineName, keys));
  emit();
}

export function clearRoutineSaved(threadId: string): void {
  if (saved.delete(threadId)) emit();
}

export function routineSavedFor(threadId: string): RoutineSaved | undefined {
  return saved.get(threadId);
}

export function useRoutineSaved(threadId: string | undefined): RoutineSaved | undefined {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => (threadId ? saved.get(threadId) : undefined),
    () => undefined,
  );
}
