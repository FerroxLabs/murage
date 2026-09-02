import { useEffect, useState } from "react";

import { knownSurface, surface, type SurfaceAnswer } from "./surface";

/** Which door this renderer came through, as a React value.
 *
 * `src/lib/surface.ts` owns the answer; this owns the re-render. It exists
 * because the same question is now asked by five screens, and each one that
 * copied the four-line effect was one more place that could get the
 * `undefined` case wrong.
 *
 * THREE states, and the third is the important one:
 *
 *   true       confirmed desktop — the local app, on loopback
 *   false      confirmed remote  — a phone, through the browser door
 *   undefined  not asked yet
 *
 * `undefined` must render the NEUTRAL thing, never the desktop thing. A phone
 * that shows the welcome gate, the phone-setup wizard or an engine installer
 * for one frame has already shipped the bug this seam exists to prevent, and
 * on a phone that frame is what the user photographs.
 */
export function useDesktopSurface(): boolean | undefined {
  const [answer, setAnswer] = useState<SurfaceAnswer | undefined>(() => knownSurface());
  useEffect(() => {
    if (answer !== undefined) return;
    let live = true;
    void surface().then((next) => {
      if (live) setAnswer(next);
    });
    return () => {
      live = false;
    };
  }, [answer]);
  return resolveDesktopSurface(answer, (globalThis as { muragebox?: unknown }).muragebox);
}

/** The one synchronous signal that can only ever be a TRUE positive.
 *
 * `window.muragebox` is the Electron preload bridge. Its ABSENCE proves
 * nothing — the desktop renderer running against the Vite dev server has no
 * bridge at all, which is exactly why `surface.ts` refuses to use it as the
 * test and asks the harness instead. Its PRESENCE cannot be manufactured
 * through the browser door: the door serves the built bundle over HTTP to a
 * mobile browser, and an HTTP response cannot install a preload script. So it
 * is read here in one direction only, and never to answer "remote".
 *
 * Why it is worth the extra concept: the first-run welcome gate is a DESKTOP
 * thing, so it may only render on a CONFIRMED desktop. Without this, the
 * packaged app's very first launch would paint the shell and then pop the
 * welcome screen a fetch later — a visible regression on the one surface this
 * change is forbidden to alter. With it, the packaged desktop answers "yes"
 * on the first render, exactly as it did before, and only the dev server
 * waits for `/api/config`.
 *
 * Stated as a table rather than inferred from a render: no React and no
 * globals in here, so the three-state decision can be tested directly. */
export function resolveDesktopSurface(
  answer: SurfaceAnswer | undefined,
  bridge: unknown,
): boolean | undefined {
  if (answer !== undefined) return answer === "desktop";
  // Not asked yet. The bridge is the only thing that can still say "desktop"
  // truthfully; nothing may say "remote" from here, because "no bridge" is
  // also what the desktop dev server looks like.
  return bridge ? true : undefined;
}
