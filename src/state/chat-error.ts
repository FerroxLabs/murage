// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from OpenMausBot #2461, Apache-2.0 (see NOTICE).
// One clock for the error banner. Every new error restarts the six seconds,
// so an older error's timer can never wipe a newer one early, and the clock
// holds while the pointer is over the banner so its Details stay readable.
import { useEffect, useSyncExternalStore } from "react";

export const CHAT_ERROR_CLEAR_MS = 6000;

let transientError: string | null = null;
/** Show an error that clears itself (a failed send, save or card write). Any other
 * error stays until the person dismisses it, as before. */
export function raiseTransientError(dispatch: (action: { type: "error"; message: string }) => void, message: string): void {
  transientError = message;
  dispatch({ type: "error", message });
}
export function isTransientError(message: string | null): boolean {
  return message !== null && message === transientError;
}

export interface ErrorClock {
  /** Show `error` (or nothing): restarts the clock. */
  arm(error: string | null): void;
  hold(held: boolean): void;
  stop(): void;
}

/** The clock itself, free of React so it can be tested with fake timers. */
export function createErrorClock(clear: () => void, ms: number = CHAT_ERROR_CLEAR_MS): ErrorClock {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: string | null = null;
  let held = false;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const start = () => {
    cancel();
    if (!current || held) return;
    timer = setTimeout(() => { timer = null; clear(); }, ms);
  };
  return {
    arm(error) { current = error; start(); },
    hold(next) { if (held === next) return; held = next; start(); },
    stop() { cancel(); current = null; },
  };
}

let holding = false;
const listeners = new Set<() => void>();
/** The banner calls this on pointer enter and leave. */
export function holdChatError(held: boolean): void {
  if (holding === held) return;
  holding = held;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Clear `error` six seconds after it last changed, unless the pointer is on the banner. */
export function useChatErrorClear(error: string | null, clear: () => void): void {
  const held = useSyncExternalStore(subscribe, () => holding, () => false);
  useEffect(() => {
    if (!error) { holdChatError(false); return; }
    if (!isTransientError(error)) return;
    const clock = createErrorClock(clear);
    clock.hold(held);
    clock.arm(error);
    return () => clock.stop();
    // `clear` is a stable dispatch wrapper; the clock restarts on a new error text or hold change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error, held]);
}
