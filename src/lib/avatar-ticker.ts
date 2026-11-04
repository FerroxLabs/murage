// The frame loop every animated avatar shares: AuraTicker's single
// requestAnimationFrame at 30 frames a second, paused while the document is
// hidden. Focus is not a gate: document.hasFocus() is false in an embedded
// frame, with devtools focused and in some remote or automated browsers, and an
// avatar stuck still there reads as broken.
import { AuraTicker, type TickerHost } from "./aura-ticker";

export const avatarHost = (): TickerHost => ({
  request: (fn) => window.requestAnimationFrame(fn),
  cancel: (handle) => window.cancelAnimationFrame(handle),
  hidden: () => typeof document !== "undefined" && document.hidden,
  onVisibility: (fn) => {
    document.addEventListener("visibilitychange", fn);
    return () => {
      document.removeEventListener("visibilitychange", fn);
    };
  },
  now: () => performance.now(),
});

let shared: AuraTicker | undefined;
export const avatarTicker = (): AuraTicker => (shared ??= new AuraTicker(avatarHost()));

/** Subscribes a face to the loop. While the tab is hidden the loop sleeps,
 *  so the face is settled and drawn once first: eyes never wait for the tab to show. */
export const runAvatar = (settle: () => void, step: (now: number) => void): (() => void) => {
  if (avatarHost().hidden()) settle();
  return avatarTicker().subscribe(step);
};

export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
