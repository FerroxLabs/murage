// Moves the browser door once Tailscale turns up after Murage started.
//
// The door learns where it should listen, and which names it answers to,
// from Tailscale at startup. A computer that starts Murage at login can get
// there before Tailscale has connected. The door then comes up on loopback
// with no MagicDNS name and no Serve front in its host list, and every phone
// request through `tailscale serve` is refused as an unexpected host. Until
// now only "Check Tailscale again" or a restart moved it.
//
// This watcher rechecks while the door has no tailnet route: often at first,
// then at most once a minute, then every ten minutes once a quarter of an hour
// has passed, and straight away after the computer wakes. It
// stops only when the route is really there (a Serve front adopted, or the
// socket bound to the tailnet), not merely when a name has been read. It
// never starts for a door that already has a route.

/** Whether the door has a way in from the tailnet: a Serve front it has
 * adopted, or a socket bound somewhere other than loopback. */
export function doorRouteReady(boundHost: string | null, front: unknown): boolean {
  return front !== null || (boundHost !== null && boundHost !== "127.0.0.1");
}

export interface LateTailscaleOptions {
  /** True while the door has no tailnet route. */
  waiting: () => boolean;
  /** Ask Tailscale again and move the door if it now can. Expected not to
   * throw; a throw is logged and the watch carries on. */
  recheck: () => Promise<void>;
  /** Wall clock in ms. A gap far longer than one beat means the computer slept. */
  now?: () => number;
  log?: (line: string) => void;
}

export interface LateTailscaleWatch {
  /** Start watching if the door is waiting. A door that is not waiting is
   * left alone and no timer is made. */
  start: () => void;
  stop: () => void;
  /** One beat of the timer. Exposed for tests; the interval calls the same code. */
  beat: () => Promise<void>;
  running: () => boolean;
}

/** Gaps between rechecks: quick while Tailscale is likely still connecting,
 * then capped at a minute. Whole seconds, so a one-second beat lands on them. */
export const RECHECK_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000] as const;
/** After this long waiting with no route, Tailscale is probably not coming on
 * its own (no Serve set up, or no Tailscale at all), so the watch slows down. */
export const SLOW_AFTER_MS = 15 * 60_000;
/** The gap once slowed. Waking the computer, or pressing "Check Tailscale
 * again", still checks straight away. */
export const SLOW_DELAY_MS = 10 * 60_000;
/** How often the timer wakes to look at the clock. Reading the clock is free. */
export const BEAT_MS = 1_000;
/** A beat that arrives this late means the computer was asleep. */
export const WAKE_GAP_MS = 30_000;

export function createLateTailscaleWatch(options: LateTailscaleOptions): LateTailscaleWatch {
  const now = options.now ?? Date.now;
  const log = (line: string) => {
    try {
      options.log?.(line);
    } catch {
      /* a logger that throws must not end the watch */
    }
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let step = 0;
  let lastBeat = 0;
  let dueAt = 0;
  let phaseStart = 0;
  let inflight = false;

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const schedule = (from: number) => {
    lastBeat = from;
    dueAt = from + (from - phaseStart >= SLOW_AFTER_MS ? SLOW_DELAY_MS : RECHECK_DELAYS_MS[step]);
    step = Math.min(step + 1, RECHECK_DELAYS_MS.length - 1);
  };

  const beat = async (): Promise<void> => {
    if (!timer || inflight) return;
    inflight = true;
    try {
      const at = now();
      const woke = at - lastBeat > WAKE_GAP_MS;
      lastBeat = at;
      // A wake starts the quick phase again: Tailscale reconnects right after.
      if (woke) {
        step = 0;
        phaseStart = at;
      }
      if (!woke && at < dueAt) return;
      if (options.waiting()) await options.recheck();
      if (!timer) return;
      if (!options.waiting()) {
        log("browser door: Tailscale route found; rechecks stopped");
        stop();
        return;
      }
      schedule(now());
    } catch (error) {
      log(`browser door: Tailscale recheck failed: ${error instanceof Error ? error.message : String(error)}`);
      if (timer) schedule(now());
    } finally {
      inflight = false;
    }
  };

  return {
    start: () => {
      if (timer) return;
      try {
        if (!options.waiting()) return;
      } catch {
        return;
      }
      step = 0;
      phaseStart = now();
      schedule(phaseStart);
      log("browser door: waiting for Tailscale; will check again on its own");
      timer = setInterval(() => {
        beat().catch(() => {});
      }, BEAT_MS);
      // A recheck must never be what keeps the process alive.
      timer.unref?.();
    },
    stop,
    beat,
    running: () => timer !== null,
  };
}
