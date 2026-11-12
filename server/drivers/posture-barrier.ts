// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export const POSTURE_CONTINUATION = 'Your permission level has changed. Continue from where you stopped and retry the stopped action.';
/** Interrupt at the next item boundary, with a hard deadline for blocked items.
 * Old asks remain answerable: callers must never await this in their answer path. */
export class PostureBarrier {
 private pending?: { done: Promise<void>; start: () => void; timer: ReturnType<typeof setTimeout> };
 wait() { return this.pending?.done ?? Promise.resolve(); }
 get changing() { return this.pending !== undefined; }
 change(restart: () => Promise<void>): Promise<void> {
  if (this.pending) return this.pending.done;
  let resolve!: () => void, reject!: (e: unknown) => void;
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  let started = false;
  const start = () => {
   if (started) return; started = true;
   clearTimeout(this.pending!.timer);
   void restart().then(() => { this.pending = undefined; resolve(); }, error => { this.pending = undefined; reject(error); });
  };
  const timer = setTimeout(start, 10_000); timer.unref?.();
  this.pending = { done, start, timer }; return done;
 }
 boundary() { this.pending?.start(); }
}
