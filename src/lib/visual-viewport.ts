/** The visual viewport height as a CSS variable, plus the keyboard inset.
 *
 * iOS does not resize the layout viewport for the software keyboard, so a
 * bottom-docked composer inside a 100%-height column ends up behind it.
 * `window.innerHeight`, `100vh`, `100dvh` and `height: 100%` all keep their
 * pre-keyboard values; only `window.visualViewport` shrinks. Every other
 * approach (scrollIntoView on focus, position:fixed, a window resize listener)
 * fails on one of: rubber-band, a rotated device, or a hardware keyboard
 * attached mid-session. visualViewport is the only signal correct in all three.
 */

import { useEffect, useState } from "react";

/** Taller than any URL-bar collapse, shorter than any software keyboard. */
export const KEYBOARD_INSET_THRESHOLD = 80;

/** How much of the layout viewport the keyboard is covering.
 *
 * `offsetTop` matters when the page is pinch-zoomed: the visual viewport can be
 * scrolled within the layout viewport, and the inset is what is left below it.
 * Never negative — Safari briefly reports a visual viewport taller than the
 * layout viewport mid-rotation. */
export function keyboardInset(v: {
  innerHeight: number;
  height: number;
  offsetTop: number;
}): number {
  const inset = v.innerHeight - v.height - v.offsetTop;
  return Number.isFinite(inset) ? Math.max(0, inset) : 0;
}

/** Where the transcript has to be scrolled to after the pane changes height so
 * the row the reader was looking at does not slide out from under them.
 *
 * The pane is `min-h-0 flex-1` inside a column that just shrank by the keyboard
 * height, so its clientHeight drops while scrollHeight is unchanged: leaving
 * scrollTop alone scrolls the content up out of view by exactly that amount.
 * Anchoring on distance-from-bottom (rather than scrollTop) is what keeps the
 * message stable, because the growth is all at the bottom edge. */
export function anchoredScrollTop(next: {
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
}): number {
  return Math.max(0, next.scrollHeight - next.clientHeight - next.distanceFromBottom);
}

/** Publish `--vvh`, `--kb` and `data-keyboard` on <html>. Returns a teardown.
 * Call once for the app, not per component. */
export function trackVisualViewport(): () => void {
  const vv = typeof window === "undefined" ? undefined : window.visualViewport;
  if (!vv) return () => {}; // desktop Firefox pre-91, and old Electron
  let frame = 0;
  const apply = () => {
    frame = 0;
    const root = document.documentElement;
    const inset = keyboardInset({
      innerHeight: window.innerHeight,
      height: vv.height,
      offsetTop: vv.offsetTop,
    });
    root.style.setProperty("--vvh", `${vv.height}px`);
    root.style.setProperty("--kb", `${inset}px`);
    root.dataset.keyboard = inset > KEYBOARD_INSET_THRESHOLD ? "open" : "closed";
  };
  // iOS fires resize+scroll many times through the keyboard animation; one
  // frame's worth of writes is enough and keeps the layout out of a thrash.
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  // The visualViewport events alone are not enough to keep an ABSOLUTE pixel
  // height honest. `schedule` defers through requestAnimationFrame, which does
  // not run while the window is occluded or minimised, so a resize the app
  // sleeps through never reaches `apply` — and every consumer of --vvh (the
  // shell and a dozen overlays) is then sized to a window that no longer
  // exists. The layout-viewport resize and the return from occlusion are the
  // two moments that catch it.
  window.addEventListener("resize", schedule);
  document.addEventListener("visibilitychange", schedule);
  window.addEventListener("pageshow", schedule);
  apply();
  return () => {
    vv.removeEventListener("resize", schedule);
    vv.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    document.removeEventListener("visibilitychange", schedule);
    window.removeEventListener("pageshow", schedule);
    if (frame) cancelAnimationFrame(frame);
  };
}

/** The keyboard inset as React state, for the one consumer that needs to react
 * to the transition rather than just be laid out by it: the transcript, which
 * has to re-pin or re-anchor when the pane changes height. Separate from
 * trackVisualViewport so the CSS variables keep working with React unmounted. */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let frame = 0;
    const apply = () => {
      frame = 0;
      setInset(
        keyboardInset({ innerHeight: window.innerHeight, height: vv.height, offsetTop: vv.offsetTop }),
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    apply();
    return () => {
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return inset;
}
