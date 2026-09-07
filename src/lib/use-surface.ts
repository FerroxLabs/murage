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
 *   false      remote or transient fail-closed fallback
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
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    const resolve = async () => {
      const next = await surface();
      if (!live) return;
      setAnswer(next);
      // A transient fallback is safe to render, but is not confirmation.
      // Keep mounted screens recoverable while the harness starts. A real
      // remote answer stops here, including on the browser door.
      if (knownSurface() === undefined) {
        timer = setTimeout(resolve, delay);
        delay = Math.min(delay * 2, 10_000);
      }
    };
    void resolve();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);
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
  // The bridge is checked FIRST, and it wins.
  //
  // It used to be checked only when the fetched answer had not arrived, which
  // reads as harmless and is not: `/api/config` can answer "remote" to the
  // real desktop. It did. The harness began requiring a per-launch secret to
  // prove the desktop, and a renderer served as a production bundle by a
  // harness it did not fork has no way to hold that secret — so Sean's own
  // desktop asked "am I the desktop?", was told no, and hid Connections,
  // Engines, Phone and Local VM from the machine that owns them.
  //
  // Ordering is the whole fix. The bridge is a TRUE POSITIVE that cannot be
  // manufactured through the door — the door serves HTTP to a browser, and an
  // HTTP response cannot install a preload script — so where it disagrees with
  // the fetch, the bridge is right and the fetch is a plumbing failure. The
  // asymmetry stays: absence still proves nothing, because the desktop dev
  // server has no bridge either.
  if (bridge) return true;
  if (answer !== undefined) return answer === "desktop";
  return undefined;
}
