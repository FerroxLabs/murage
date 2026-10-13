// SPDX-License-Identifier: AGPL-3.0-or-later
// The work that starts once the port is open, run so the first /api/health is
// answered before any of it.
//
// The listen callback used to start a dozen jobs back to back. Each one's
// synchronous part was small, but together they held the event loop for over
// a second, and the window waiting on /api/health waited for all of them. Now
// each step runs in its own turn of the event loop, after the first health
// answer (or a short fallback when nobody asks), and each is named for the
// stall line while it runs.
import { heldStep } from "./observe.ts";
import { startupMark } from "./startup-trace.ts";

export interface AfterListenStep { name: string; run: () => unknown }

/** How long the steps wait for a first health check before starting anyway
 *  (a headless run nobody asks). Nothing in the list is urgent, so this is
 *  generous, and it is not a deadline on a slow boot: see `LOOP_BUSY_MS`. */
export const AFTER_LISTEN_FALLBACK_MS = 5_000;
/** A fallback timer that fires this late means the event loop is still busy
 *  booting, and the window's first health request may be queued behind that
 *  work: the steps keep waiting, up to AFTER_LISTEN_MAX_WAIT_MS in all. */
export const LOOP_BUSY_MS = 100;
export const AFTER_LISTEN_MAX_WAIT_MS = 60_000;

let healthAnswered: (() => void) | undefined;
let healthSeen = false;
const firstHealth = new Promise<void>((resolve) => { healthAnswered = resolve; });

/** Called by the health route once its answer is sent. */
export function noteHealthAnswered(): void {
  if (healthSeen) return;
  healthSeen = true;
  startupMark("health.answered");
  healthAnswered?.();
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Run the steps one per event-loop turn, starting after the first health
 *  answer or the fallback. A step that throws is reported and the rest run. */
export async function runAfterListen(steps: readonly AfterListenStep[], options: { fallbackMs?: number; first?: Promise<void>; busyMs?: number; maxWaitMs?: number } = {}): Promise<void> {
  const fallbackMs = options.fallbackMs ?? AFTER_LISTEN_FALLBACK_MS;
  const busyMs = options.busyMs ?? LOOP_BUSY_MS, maxWaitMs = options.maxWaitMs ?? AFTER_LISTEN_MAX_WAIT_MS;
  const first = options.first ?? firstHealth;
  let timer: ReturnType<typeof setTimeout> | undefined, answered = false;
  void first.then(() => { answered = true; });
  const begun = performance.now();
  const fallback = new Promise<void>((resolve) => {
    const arm = () => {
      const armed = performance.now();
      timer = setTimeout(() => {
        // Late: the loop was held, so a health request may be waiting behind
        // that work. Wait for it rather than start the memory worker now.
        const late = performance.now() - armed - fallbackMs;
        if (!answered && late > busyMs && performance.now() - begun < maxWaitMs) arm();
        else resolve();
      }, fallbackMs);
      timer.unref?.();
    };
    arm();
  });
  await Promise.race([first, fallback]);
  if (timer) clearTimeout(timer);
  for (const step of steps) {
    await nextTurn();
    try { heldStep(`startup.${step.name}`, step.run); }
    catch (error) { console.warn(`Start-up step ${step.name} could not finish: ${error instanceof Error ? error.message : String(error)}`); }
    startupMark(`deferred.${step.name}`);
  }
  startupMark("deferred.done");
}
