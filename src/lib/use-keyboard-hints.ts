// Whether the call screen's keyboard hints ("Space interrupts · Esc hangs
// up") have a keyboard to point at. A phone has none: the phone app, and any
// browser whose primary pointer is a finger, hide them. The decision is a
// pure function; the hook only feeds it the live answers.
import { useSyncExternalStore } from "react";

import { inNativeShell } from "./native-shell";

export const COARSE_POINTER_QUERY = "(pointer: coarse)";

/** Keyboard hints show only where a keyboard is the ordinary way in: not in
 *  the phone app, not where the primary pointer is a finger. */
export function showKeyboardHints({ coarsePointer, nativeShell }: { coarsePointer: boolean; nativeShell: boolean }): boolean {
  return !coarsePointer && !nativeShell;
}

function coarseQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(COARSE_POINTER_QUERY) : null;
}

function subscribe(onChange: () => void): () => void {
  const query = coarseQuery();
  if (!query) return () => {};
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function snapshot(): boolean {
  return showKeyboardHints({ coarsePointer: coarseQuery()?.matches ?? false, nativeShell: inNativeShell() });
}

/** Live: a tablet that gains a trackpad, or loses it, flips the answer. */
export function useKeyboardHints(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}
