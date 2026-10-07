// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "@/state/store";
import { createProjectClient, type ProjectRead } from "./project-client";
import { projectEvents } from "./project-events";

export const projectClient = createProjectClient(api);
interface Entry { value: ProjectRead | null; listeners: Set<() => void>; loading: boolean; again: boolean; loaded: boolean; stop?: () => void }
const entries = new Map<string, Entry>();
function entry(id: string): Entry {
  let held = entries.get(id);
  if (!held) { held = { value: null, listeners: new Set(), loading: false, again: false, loaded: false }; entries.set(id, held); }
  return held;
}
export async function refreshProject(id: string): Promise<void> {
  const held = entry(id);
  if (held.loading) { held.again = true; return; }
  held.loading = true;
  do {
    held.again = false;
    const result = await projectClient.project(id);
    held.value = result.ok && result.data?.settings && result.data?.strip ? result.data : null;
    held.loaded = true;
    for (const listener of held.listeners) listener();
  } while (held.again && held.listeners.size);
  held.loading = false;
}
export function useProject(id: string, enabled: boolean): ProjectRead | null {
  const value = useSyncExternalStore(
    useCallback((listener: () => void) => {
      if (!enabled) return () => {};
      const held = entry(id); held.listeners.add(listener);
      held.stop ??= projectEvents.subscribe(id, (change) => { if (change.strip || change.replayGap) void refreshProject(id); });
      return () => {
        held.listeners.delete(listener);
        if (!held.listeners.size) { held.stop?.(); held.stop = undefined; }
      };
    }, [id, enabled]),
    () => enabled ? entry(id).value : null,
    () => null,
  );
  useEffect(() => {
    if (enabled && !entry(id).loaded) void refreshProject(id);
  }, [enabled, id]);
  return value;
}
