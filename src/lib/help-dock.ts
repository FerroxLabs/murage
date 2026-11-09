// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where help is drawn right now: the panel, or its frame while the panel loads. A control that must stay
// reachable whatever is open (the dictation Stop bar) draws inside it, so it can never sit behind help.
import { useLayoutEffect, useSyncExternalStore, type RefObject } from "react";

let dock: HTMLElement | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => dock;

function setDock(next: HTMLElement | null) {
  if (dock === next) return;
  dock = next;
  for (const listener of [...listeners]) listener();
}

/** The element help is drawn in, or null while help is closed. */
export function useHelpDock(): HTMLElement | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/** Help's panel and frame call this with their own element while they are mounted. */
export function useRegisterHelpDock(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    setDock(el);
    return () => { if (dock === el) setDock(null); };
  }, [ref]);
}
