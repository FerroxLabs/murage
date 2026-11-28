// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owner presence for warm engines (designs/WARM-W1-1022-presence.md P-SIG). Present = owner input in Murage within the
// activity window, or an owner turn in flight that no away edge has crossed. A lock or sleep report, and a server start, are
// away EDGES: everything warm is retired at that moment, and later owner input (the phone app, say) makes him present again.
// Memory only: never written to disk, never sent anywhere, logged without content. Separate from OwnerIdleClock (VACUUM).

import { countsAsOwnerAction } from "./owner-activity.ts";

/** Writes the app sends on its own that countsAsOwnerAction (the VACUUM clock) still counts: a chat marked read when a stream frame
 * lands in the open chat, the desktop's resource ticket on every SSE (re)connect, and /warm, which counts only with its gesture
 * flag (its route reads the body). None of them says the owner is at Murage (P-SIG 2). */
const NOT_PRESENCE_INPUT: readonly RegExp[] = [
  /^\/api\/bots\/[^/]+\/warm$/,
  /^\/api\/bots\/[^/]+\/read$/,
  /^\/api\/groups\/[^/]+\/read$/,
  /^\/api\/desktop\/resource-ticket$/,
];
/** True when this request, on an owner surface, is owner input in Murage (P-SIG 1a). */
export function countsAsPresenceInput(method: string | undefined, rawUrl: string | undefined): boolean {
  if (!countsAsOwnerAction(method, rawUrl)) return false;
  const path = (rawUrl ?? "/").split("?")[0]!.replace(/\/+$/, "") || "/";
  return !NOT_PRESENCE_INPUT.some((pattern) => pattern.test(path));
}

export type AwayCause = "idle" | "locked" | "asleep" | "restart";
type Cause = "input" | "turn" | AwayCause;

export interface OwnerPresenceDeps {
  now: () => number;
  /** The warm pool's activity window (MURAGE_WARM_ACTIVITY_WINDOW_MS, 15 min by default). */
  windowMs: () => number;
  log: (line: string) => void;
}

const DEFAULT_WINDOW_MS = 15 * 60_000;
/** An in-flight owner turn holds presence for at most this long (a run taken over without a release never pins it). */
const MAX_TURN_PRESENCE_MS = 6 * 60 * 60_000;
const envWindowMs = (): number => {
  const v = Number(process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_WINDOW_MS;
};

export function createOwnerPresence(overrides: Partial<OwnerPresenceDeps> = {}) {
  const d: OwnerPresenceDeps = { now: Date.now, windowMs: envWindowMs, log: (line) => console.info(line), ...overrides };
  let lastInput = -Infinity;
  /** Bumped by every away edge: an owner turn that began before the newest edge no longer holds presence. */
  let edge = 0;
  const inFlight = new Map<object, { edge: number; at: number }>();
  let state: "present" | "away" = "away";
  const awayListeners = new Set<(cause: AwayCause) => void>();

  const present = (): boolean => d.now() - lastInput < d.windowMs() || [...inFlight.values()].some((t) => t.edge === edge && d.now() - t.at < MAX_TURN_PRESENCE_MS);
  /** Logs a change only (content-free). Returns true when he just became present. */
  const settle = (cause: Cause): boolean => {
    const now = present() ? "present" : "away";
    if (now === state) return false;
    state = now;
    d.log(`presence warm state=${now} cause=${now === "present" ? (cause === "turn" ? "turn" : "input") : (cause === "input" || cause === "turn" ? "idle" : cause)}`);
    return now === "present";
  };
  const notifyAway = (cause: AwayCause) => { for (const cb of awayListeners) { try { cb(cause); } catch { /* a listener never breaks presence */ } } };
  /** P-SIG 4/5: wall-clock based. Input, a turn or a resume after he went away by the clock (a machine that slept 2 h, a late
   * timer) first retires what is left from before, so nothing kept from then survives into the new presence. */
  const sweepIfAway = () => { if (!present()) { settle("idle"); notifyAway("idle"); } };

  const api = {
    present(): boolean { settle("idle"); return state === "present"; },
    /** Owner input in Murage (P-SIG 1a). */
    input(): void {
      sweepIfAway();
      lastInput = d.now();
      settle("input");
    },
    /** An owner-origin turn began (P-SIG 1b); the returned end is its settle (P-SIG 1c). */
    turnBegan(): () => void {
      const token = {};
      sweepIfAway();
      lastInput = d.now();
      inFlight.set(token, { edge, at: d.now() });
      settle("turn");
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const startedAt = inFlight.get(token);
        inFlight.delete(token);
        // a lock or sleep during the turn wins: its settle does not make him present again
        if (startedAt?.edge === edge) lastInput = d.now();
        settle("turn");
      };
    },
    /** An away edge (P-SIG 3): the desktop locked or slept, or the server started. */
    away(cause: Exclude<AwayCause, "idle">): void {
      lastInput = -Infinity;
      edge++;
      settle(cause);
      // already away by the clock or not, the edge retires whatever is left
      notifyAway(cause);
    },
    /** Unlock or resume (P-SIG 5): re-check now, the pool's timer may fire late after OS sleep. */
    resumed(): void { sweepIfAway(); },
    onAway(cb: (cause: AwayCause) => void): () => void { awayListeners.add(cb); return () => { awayListeners.delete(cb); }; },
  };
  // P-SIG 3b: a server start is away (memory only, nothing pre-started at boot)
  d.log("presence warm state=away cause=restart");
  return api;
}

export type OwnerPresence = ReturnType<typeof createOwnerPresence>;
