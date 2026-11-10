// SPDX-License-Identifier: AGPL-3.0-or-later
// When the cached start-up picture is rewritten (FIRSTRUN-1019 section 2.2): debounced 2 s after the last change, at most once a
// minute, never while the welcome is up, and only when something the picture shows has actually changed.

import type { TipBot } from "./startup-tips";

export const PICTURE_DEBOUNCE_MS = 2000;
export const PICTURE_MIN_INTERVAL_MS = 60_000;

/** What the picture is made of: the Chief's name, colour, body and photo framing, the first two teammates (the only names a tip uses),
 * the language the words are in and whether the phone tip can show. null when there is no Chief: nothing to draw. */
export function pictureSignature(
  roster: { chief: (TipBot & Record<string, unknown>) | null; mates: ReadonlyArray<{ name: string }> },
  language: string,
  phoneAvailable: boolean,
): string | null {
  const chief = roster.chief;
  if (!chief) return null;
  return JSON.stringify([
    chief.name, chief.color ?? null, chief.mascotBody ?? null, chief.avatarUrl ?? null, chief.avatarCrop ?? null,
    chief.avatarZoom ?? null, chief.avatarFocusX ?? null, chief.avatarFocusY ?? null,
    roster.mates.slice(0, 2).map((bot) => bot.name), language, phoneAvailable,
  ]);
}

/** True while the picture must not be written: the setup view has not answered yet, or the welcome is up (first run is live and the
 * hello step is untouched, the same gate as FirstRunWelcome, FIRSTRUN-1019 section 1.8). */
export function pictureHeld(view: { firstRun: boolean; next: string | null } | null): boolean {
  return view === null || (view.firstRun === true && view.next === "hello");
}

export interface PictureSchedulerOptions {
  /** Compose and save the picture for this signature; true when it was written. A throw counts as false. */
  run: (signature: string, isCurrent: () => boolean) => Promise<boolean>;
  debounceMs?: number;
  minIntervalMs?: number;
}

export function createPictureScheduler({ run, debounceMs = PICTURE_DEBOUNCE_MS, minIntervalMs = PICTURE_MIN_INTERVAL_MS }: PictureSchedulerOptions) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let written: string | null = null;
  let lastRunAt = Number.NEGATIVE_INFINITY;
  let disposed = false;
  let busy = false;
  // Bumped by every update and by dispose: a write already composing checks it just before saving, so a change, the welcome opening
  // or an unmount while a photo loads can never end in a stale or forbidden save.
  let epoch = 0;

  let latest: { signature: string | null; suspended: boolean } = { signature: null, suspended: true };

  const cancel = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };

  const update = (signature: string | null, suspended: boolean) => {
    latest = { signature, suspended };
    epoch += 1;
    cancel();
    if (disposed || suspended || signature === null || signature === written) return;
    const wait = Math.max(debounceMs, lastRunAt + minIntervalMs - Date.now());
    timer = setTimeout(() => {
      timer = null;
      if (disposed || busy) return;
      busy = true;
      lastRunAt = Date.now();
      const mine = epoch;
      void run(signature, () => !disposed && epoch === mine).then((ok) => ok, () => false).then((ok) => {
        busy = false;
        // the minute is counted from when the write finished, so a slow photo load never shortens the gap between two saves
        lastRunAt = Date.now();
        if (ok) written = signature;
        // a change that arrived while this write was running is not lost: it waits its own debounce and minute
        // (or the same signature came back after the welcome or a change: the epoch moved, and a timer that fired while busy was dropped)
        if (!disposed && (epoch !== mine || latest.signature !== signature)) update(latest.signature, latest.suspended);
      });
    }, wait);
  };

  return {
    /** Call on every change of the inputs. `signature` null means nothing to draw; `suspended` is true while the welcome is up. */
    update,
    dispose() { disposed = true; epoch += 1; cancel(); },
  };
}
