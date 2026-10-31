// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sleep is not silence (1.0.10 C3). A laptop that sleeps with a card open or
// a quiet tool running used to wake to a denied card or a stopped turn: the
// deny deadlines and the stall watchdog compared wall-clock time, and the
// whole sleep read as the owner not answering or the engine going quiet.
//
// The server measures its own sleep. A frozen process runs no timers, so a
// gap between two ticks of a short interval, well past the interval, is time
// the process was not running. The gap is also read by every deadline at the
// moment it fires (`observe`), because on wake Node runs the expired timers
// before anything else, the tick and Electron's resume message included.
// Electron's powerMonitor adds `suspend`/`resume` (electron/main.mjs): a
// suspension the process kept running through (Windows modern standby) is
// counted from the suspend to the resume.
//
// `sleptMs()` only grows. A deadline remembers how much of it it has already
// added to itself; the watchdog remembers how much it has already shifted by.
// An event loop blocked past the slack also counts: a deadline then moves
// later by that much, which never ends anything early. While a suspension is
// open the tick counts no gaps, so the two sources never count one stretch
// twice.

const TICK_MS = 2_000;
const SLACK_MS = 1_000;

export interface SleepClockOptions {
  now?: () => number;
  tickMs?: number;
  /** A gap this much past the tick is counted as sleep. */
  slackMs?: number;
}

export class SleepClock {
  #slept = 0;
  #lastTick = 0;
  #suspendedAt: number | undefined;
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #now: () => number;
  readonly #tickMs: number;
  readonly #slackMs: number;

  constructor(options: SleepClockOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#tickMs = Math.max(1, options.tickMs ?? TICK_MS);
    this.#slackMs = Math.max(0, options.slackMs ?? SLACK_MS);
  }

  /** Begin counting. Before this nothing is counted (a plain import, a test). */
  start(): void {
    if (this.#timer) return;
    this.#lastTick = this.#now();
    this.#timer = setInterval(() => this.observe(), this.#tickMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  get started(): boolean {
    return this.#timer !== null;
  }

  /** Count the gap since the last tick as sleep when it is well past the tick. */
  observe(): void {
    if (!this.#timer) return;
    const at = this.#now();
    if (this.#suspendedAt === undefined) {
      // The whole interval since the last tick counts, not only its excess: the
      // awake moments before the freeze (at most one tick) are counted as sleep
      // too, so a deadline can only move later, never fire early.
      const since = at - this.#lastTick;
      if (since - this.#tickMs > this.#slackMs) this.#slept += since;
    }
    this.#lastTick = at;
  }

  /** The OS is suspending (Electron powerMonitor). */
  suspend(): void {
    if (!this.#timer || this.#suspendedAt !== undefined) return;
    this.observe();
    this.#suspendedAt = this.#now();
  }

  /** The OS resumed: the suspension counts as sleep. A resume with no suspend
   * heard (the process froze first) is covered by the tick gap. */
  resume(): void {
    if (!this.#timer) return;
    if (this.#suspendedAt === undefined) { this.observe(); return; }
    const at = this.#now();
    this.#slept += Math.max(0, at - this.#suspendedAt);
    this.#suspendedAt = undefined;
    this.#lastTick = at;
  }

  /** The clock this one counts against (the wall clock unless a test set one). */
  now(): number {
    return this.#now();
  }

  /** Total sleep counted so far, a suspension still in progress included. */
  sleptMs(): number {
    this.observe();
    return this.#slept + (this.#suspendedAt === undefined ? 0 : Math.max(0, this.#now() - this.#suspendedAt));
  }
}

/** The server's one clock (started in server/index.ts). */
export const sleepClock = new SleepClock();

export interface WakeAwareTimer {
  clear(): void;
}

/** A timeout that runs `fn` after `ms` of AWAKE time. When it fires with no
 * sleep counted since it was armed, it runs `fn` (the timer's own clock is
 * right). Otherwise, armed at wall time `a` with sleep `s0` and firing at `t`
 * with sleep `s`, the awake time elapsed is `(t - a) - (s - s0)`; it runs `fn`
 * once that reaches `ms`, else waits exactly the remainder. A 15-minute deadline with 10 awake minutes and a
 * 20-minute sleep runs 5 awake minutes after the wake. */
export function wakeAwareTimeout(fn: () => void, ms: number, clock: SleepClock = sleepClock): WakeAwareTimer {
  const armedAt = clock.now();
  const sleptAtArm = clock.sleptMs();
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (delay: number) => {
    timer = setTimeout(check, Math.max(0, delay));
    timer.unref?.();
  };
  const check = () => {
    if (done) return;
    const sleptSince = clock.sleptMs() - sleptAtArm;
    // No sleep since it was armed: the timer's own clock is right, as before.
    if (sleptSince > 0) {
      const awake = clock.now() - armedAt - sleptSince;
      if (awake < ms) { arm(ms - awake); return; }
    }
    done = true;
    fn();
  };
  arm(ms);
  return {
    clear() {
      done = true;
      if (timer) clearTimeout(timer);
    },
  };
}
