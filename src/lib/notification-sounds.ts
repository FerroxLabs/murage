// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Whether desktop notifications on THIS computer may play a sound. The server
// still decides what is worth a notification; this only decides whether it
// makes a sound when it lands. Kept per device, like notification permission:
// a laptop on a call and a desk machine can differ. Ported from upstream
// OpenMausBot #1274 (someone on a call with a bot heard it talk, then the
// chime for the same reply).
//
// A choice made this session survives blocked or full storage, and another
// window's change supersedes it.
import { useSyncExternalStore } from "react";

export const NOTIFICATION_SOUNDS_KEY = "murage.notificationSounds";

let sessionChoice: boolean | undefined;
const listeners = new Set<() => void>();

function storage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** True unless this computer muted notification sounds. A plain function,
 * not a hook, because notifications are shown outside React. */
export function notificationSoundsEnabled(): boolean {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    return storage()?.getItem(NOTIFICATION_SOUNDS_KEY) !== "0";
  } catch {
    return true;
  }
}

function changed() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== NOTIFICATION_SOUNDS_KEY && event.key !== null) return;
  sessionChoice = undefined;
  changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function setNotificationSounds(enabled: boolean): void {
  sessionChoice = enabled;
  try {
    storage()?.setItem(NOTIFICATION_SOUNDS_KEY, enabled ? "1" : "0");
  } catch {
    // Private windows and full storage refuse the write; the choice still
    // holds for this session.
  }
  changed();
}

export function useNotificationSounds(): boolean {
  return useSyncExternalStore(subscribe, notificationSoundsEnabled, () => true);
}
