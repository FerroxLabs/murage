// "At the desk" for the desktop app (E1, 2026-09-29). Kept out of main.mjs so
// it can be tested without Electron; main.mjs supplies powerMonitor and the
// harness call.
//
// The rule: Murage is running, the screen is unlocked, and the keyboard or
// mouse was used in the last 120 s, whether or not the Murage window is
// visible, focused or minimised. The window's own visibility was the old
// signal, and Electron reports a window covered by a terminal as hidden, so
// the phones buzzed while Sean sat at the Mac. Browser tabs through the door
// keep the visible-tab rule (src/lib/presence.ts); phones never report.

/** "Used the keyboard or mouse in the last 120 s." */
export const DESK_IDLE_SECONDS = 120;
/** A third of the host's 90 s window (server/mobile-presence.ts), as the
 * renderer beats. */
export const DESK_BEAT_MS = 30_000;
/** How often the idle time is read between beats, so walking away (or coming
 * back) is reported within seconds rather than at the next beat. Lock, unlock,
 * sleep and wake are events and are reported at once. */
export const DESK_POLL_MS = 5_000;
/** A report that has not answered by then is abandoned (see the queue). */
export const DESK_POST_TIMEOUT_MS = 10_000;

/** @typedef {"active" | "idle" | "locked" | "asleep" | "unknown"} DeskState */

/** Only "active" is at the desk. An idle time the system cannot read
 * ("unknown") errs toward buzzing the phone, as the host does after a restart.
 * @param {{ idle: string, locked: boolean, asleep: boolean }} input
 * @returns {DeskState} */
export function deskState({ idle, locked, asleep }) {
  if (asleep) return "asleep";
  if (locked || idle === "locked") return "locked";
  if (idle === "active" || idle === "idle") return idle;
  return "unknown";
}

/**
 * Reports the desk to the harness's POST /api/presence as one client for the
 * life of this process, beside (not instead of) any browser tab's report.
 *
 * @param {{
 *   clientId: string,
 *   post: (body: { clientId: string, visible: boolean, seq: number }) => Promise<unknown>,
 *   idleState: (thresholdSeconds: number) => string,
 *   onPower: (listener: (event: string) => void) => () => void,
 *   every: (fn: () => void, ms: number) => () => void,
 *   log?: (line: string) => void,
 * }} deps
 * @returns {() => void} stop, which reports absent: the app is no longer running.
 */
export function startDeskPresence(deps) {
  // One report in flight at a time, and only the newest state waits behind
  // it; each carries a rising seq so the host drops one that arrives late.
  // The same queue as the renderer's (src/lib/presence.ts).
  let inFlight = false;
  /** @type {boolean | null} */
  let next = null;
  let seq = 0;
  const flush = () => {
    if (inFlight || next === null) return;
    const visible = next;
    next = null;
    inFlight = true;
    seq += 1;
    let pending;
    try {
      pending = Promise.resolve(deps.post({ clientId: deps.clientId, visible, seq }));
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending.catch(() => {}).finally(() => {
      inFlight = false;
      flush();
    });
  };
  const send = (visible) => {
    next = visible;
    flush();
  };

  let locked = false;
  let asleep = false;
  /** @type {DeskState | null} */
  let last = null;
  let stopped = false;
  const note = (line) => {
    try {
      deps.log?.(line);
    } catch { /* a trace that cannot be written is not a failure */ }
  };
  /** A change is reported at once; a beat renews presence while active. */
  const evaluate = (beat) => {
    if (stopped) return;
    const state = deskState({ idle: deps.idleState(DESK_IDLE_SECONDS), locked, asleep });
    const present = state === "active";
    const changed = last === null || (last === "active") !== present;
    if (state !== last) note(`presence source=desk-activity state=${state}`);
    last = state;
    if (changed || (beat && present)) send(present);
  };

  const stopPower = deps.onPower((event) => {
    if (event === "lock-screen") locked = true;
    else if (event === "unlock-screen") locked = false;
    else if (event === "suspend") asleep = true;
    else if (event === "resume") asleep = false;
    else return;
    evaluate(false);
  });
  const stopPoll = deps.every(() => evaluate(false), DESK_POLL_MS);
  const stopBeat = deps.every(() => evaluate(true), DESK_BEAT_MS);
  evaluate(false);

  return () => {
    if (stopped) return;
    stopped = true;
    stopPower();
    stopPoll();
    stopBeat();
    send(false);
  };
}
