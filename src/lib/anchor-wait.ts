// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Waiting for a deep link's anchor to appear on a page. A card that lives behind a
// status fetch (Memory's monthly limit sits in Advanced and renders once the status
// has arrived) mounts when the network answers, not after a fixed number of frames,
// so the wait is bounded in time. If the anchor never mounts the opener gives up and
// the caller lands the person at the top of the page.

/** Long enough for a slow status answer, short enough that a missing card does not hold the opener. */
export const ANCHOR_WAIT_MS = 5000;

export interface AnchorWait<E> {
  find(): E | null;
  onFound(element: E): void;
  onGiveUp(): void;
  /** When the wait began; a re-run of the same wait passes the original start so the bound does not restart. */
  startedAt?: number;
  limitMs?: number;
  now?: () => number;
  /** Runs `callback` on the next frame and returns its cancel. */
  schedule?: (callback: () => void) => () => void;
}

const nextFrame = (callback: () => void) => { const id = requestAnimationFrame(callback); return () => cancelAnimationFrame(id); };

/** Looks every frame until the anchor is found or the time bound passes. Returns a cancel. */
export function waitForAnchor<E>({ find, onFound, onGiveUp, startedAt, limitMs = ANCHOR_WAIT_MS, now = Date.now, schedule = nextFrame }: AnchorWait<E>): () => void {
  const start = startedAt ?? now();
  let stopped = false, cancel: (() => void) | null = null;
  const look = () => {
    if (stopped) return;
    const element = find();
    if (element) { onFound(element); return; }
    if (now() - start >= limitMs) { onGiveUp(); return; }
    cancel = schedule(look);
  };
  look();
  return () => { stopped = true; cancel?.(); };
}
