// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One clock for every "5 min ago" on screen (adapted from OpenMausBot #1854,
// Apache-2.0): a single 30-second tick shared by all rows, resting while the
// window is hidden and catching up the moment it shows again. Rows hold no
// timers of their own.
import { useSyncExternalStore } from "react";

export const RELATIVE_TICK_MS = 30_000;

let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

function tick() {
  if (!visible()) return;
  now = Date.now();
  for (const listener of listeners) listener();
}

export function subscribeRelativeNow(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(tick, RELATIVE_TICK_MS);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", tick);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size || !timer) return;
    clearInterval(timer);
    timer = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", tick);
  };
}

export function readRelativeNow(): number {
  // Before any row subscribes, the clock is not ticking: a first render must
  // not read a time left over from long ago. Refreshing only once a tick is
  // due keeps repeated reads within one render equal, as React requires.
  if (!timer && Date.now() - now >= RELATIVE_TICK_MS) now = Date.now();
  return now;
}

/** The current time for relative labels, re-read every 30 seconds. */
export function useRelativeNow(): number {
  return useSyncExternalStore(subscribeRelativeNow, readRelativeNow, readRelativeNow);
}

/** Tests only. */
export function resetRelativeNowForTests() {
  if (timer) {
    clearInterval(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", tick);
  }
  timer = null;
  listeners.clear();
  now = Date.now();
}
