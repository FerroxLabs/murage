// Which conversation is on a call, window-wide.
//
// It lives in lib rather than inside the call UI because two very
// different places need it: the overlay that renders the call, and the SSE
// fold that decides whether a settled reply should be read aloud. Call
// mode does its own speaking, in order, around its own microphone — so
// auto-speak has to stand down for the bot that is on the line, and the
// two would deadlock over the speaker otherwise.
import { useSyncExternalStore } from "react";

import { speaker } from "./tts";

let current: string | null = null;
const watchers = new Set<() => void>();

function notify() {
  for (const fn of [...watchers]) fn();
}

/** The bot or room on a call, or null. Safe to read outside React. */
export function currentCall(): string | null {
  return current;
}

export function startCall(targetId: string) {
  if (current === targetId) return;
  // Switching calls must silence both halves before ownership changes; the
  // old overlay may not unmount until React's next render.
  speaker.stop();
  void window.muragebox?.speechStop();
  current = targetId;
  notify();
}

/** End the current call. A targetId makes cleanup ownership-safe: an async
 * teardown from call A cannot hang up a newer call B. */
export function endCall(targetId?: string): boolean {
  if (targetId && current !== targetId) return false;
  if (current === null) return false;
  current = null;
  speaker.stop();
  void window.muragebox?.speechStop();
  notify();
  return true;
}

/** React StrictMode probes effects with setup -> cleanup -> setup in
 * development. Defer ownership cleanup so that probe can remount first;
 * a genuine unmount remains inactive and releases the call. */
export function deferCallCleanup(targetId: string, isMounted: () => boolean): void {
  queueMicrotask(() => {
    if (!isMounted()) endCall(targetId);
  });
}

/** Somewhere other than the call button asked to call this bot (What's new's
 * "Call a bot"). The bot's own call button answers it once it is on screen,
 * by pressing itself, so a missing voice or microphone gets the same help it
 * would get from a click rather than a call that silently fails. */
let requested: string | null = null;

export function requestCall(targetId: string): void {
  requested = targetId;
  notify();
}

/** Claims the request for `targetId`: true once, then false. */
export function takeCallRequest(targetId: string): boolean {
  if (requested !== targetId) return false;
  requested = null;
  return true;
}

export function useCallRequest(): string | null {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => requested,
    () => requested,
  );
}

export function useOnCall(): string | null {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => current,
    () => current,
  );
}
