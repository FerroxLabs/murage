// The frame loop every animated avatar shares: AuraTicker's single
// requestAnimationFrame at 30 frames a second, paused while the document is
// hidden and, unlike the call screen's aura, while the window is blurred (an
// avatar nobody is looking at has no reason to run).
import { AuraTicker, type TickerHost } from "./aura-ticker";

export const avatarHost = (): TickerHost => ({
  request: (fn) => window.requestAnimationFrame(fn),
  cancel: (handle) => window.cancelAnimationFrame(handle),
  hidden: () => typeof document !== "undefined" && (document.hidden || !document.hasFocus()),
  onVisibility: (fn) => {
    document.addEventListener("visibilitychange", fn);
    window.addEventListener("focus", fn);
    window.addEventListener("blur", fn);
    return () => {
      document.removeEventListener("visibilitychange", fn);
      window.removeEventListener("focus", fn);
      window.removeEventListener("blur", fn);
    };
  },
  now: () => performance.now(),
});

let shared: AuraTicker | undefined;
export const avatarTicker = (): AuraTicker => (shared ??= new AuraTicker(avatarHost()));

export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
