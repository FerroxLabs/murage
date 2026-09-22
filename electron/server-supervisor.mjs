// WHAT TO DO WHEN THE ENGINE DIES.
//
// THE DEFECT THIS EXISTS FOR. `main.mjs` forked the server child and watched
// it exit without ever replacing it. The exit handler was written as though a
// replacement were coming — it clears the desktop surface secret because "the
// secret belonged to THAT child. A replacement mints its own", and clears the
// browser capabilities "before any replacement child receives the browser
// descriptor" — and nothing made one.
//
// So on 2026-09-22 a single unhandled WebSocket error killed the server at
// 02:58:16Z and the app sat there, window open and looking perfectly healthy,
// until the owner relaunched it by hand at 03:51:31. Fifty-three minutes. In
// that time every bot, memory, every tool, the browser and the phone were
// gone, and nothing on screen said so. The Chief of Staff diagnosed "tools and
// memory and browser are broken", because that is what it looks like from
// inside: not a dead engine, a dozen broken features.
//
// The decision is kept here, away from Electron, so it can be tested against a
// clock instead of against a crash.
//
// THREE RULES.
//
// 1. A clean exit is a DECISION. Code 0 means the child meant it, and a
//    supervisor that argues with an intentional shutdown is a bug that fights
//    the quit button.
// 2. A crash gets a replacement, with a widening gap. The first is almost
//    always a one-off like the one above, and should cost the owner a blink.
// 3. A crash that keeps happening must STOP and say so. Restarting for ever is
//    worse than staying down: it burns the machine, rewrites logs over the
//    evidence, and presents as a flicker rather than a fault.

/** How long a crash counts against the loop guard. */
export const CRASH_WINDOW_MS = 120_000;

/** Crashes allowed inside that window before the supervisor gives up. The
 *  fourth death in two minutes is a fault, not bad luck. */
export const MAX_CRASHES_IN_WINDOW = 3;

/** Widening gaps. The first restart is fast because the overwhelmingly common
 *  case is a one-off fault and the owner should barely notice; later ones back
 *  off so a fault that recurs cannot become a spin. */
export const RESTART_DELAYS_MS = [500, 2_000, 8_000];

/**
 * @typedef {{ action: "restart", delayMs: number, attempt: number }
 *   | { action: "stay-down", reason: "intentional" | "clean-exit" }
 *   | { action: "give-up", reason: "crash-loop", crashes: number }} SupervisorDecision
 */

export function createServerSupervisor({ now = () => Date.now() } = {}) {
  /** @type {number[]} timestamps of recent abnormal exits */
  let crashes = [];
  let givenUp = false;

  const forget = (at) => { crashes = crashes.filter((when) => at - when < CRASH_WINDOW_MS); };

  return {
    /**
     * @param {{ code: number | null | undefined, intentional?: boolean, at?: number }} exit
     * @returns {SupervisorDecision}
     */
    decide({ code, intentional = false, at = now() }) {
      // The quit button, a relaunch, a port handover. Never argue with these.
      if (intentional) return { action: "stay-down", reason: "intentional" };
      if (code === 0) return { action: "stay-down", reason: "clean-exit" };

      forget(at);
      crashes.push(at);
      if (crashes.length > MAX_CRASHES_IN_WINDOW) {
        givenUp = true;
        return { action: "give-up", reason: "crash-loop", crashes: crashes.length };
      }
      const attempt = crashes.length;
      return {
        action: "restart",
        attempt,
        delayMs: RESTART_DELAYS_MS[Math.min(attempt - 1, RESTART_DELAYS_MS.length - 1)],
      };
    },

    /**
     * A child that has been answering for longer than the window is not part
     * of a loop, so its predecessors stop counting against the next one. Call
     * this when a replacement has proven itself, never on spawn: a child that
     * dies during boot is exactly the loop this guards.
     */
    settled(at = now()) { forget(at); },

    /** True once the guard has refused to keep trying. */
    exhausted() { return givenUp; },

    /** Crashes still inside the window. For the message shown to a person. */
    recentCrashes(at = now()) { forget(at); return crashes.length; },
  };
}
