// SPDX-License-Identifier: AGPL-3.0-or-later
// One owner-first admission gate for background work (F9, A7, O8; 1.0.2).
//
// On an overloaded laptop, what the owner is doing comes first. Background
// engine work (memory extraction, PIP reflection and continuity,
// consolidation, the idle learning lanes, maintenance) and automatic routine
// starts ask this gate before they begin, and wait while:
//  - an owner turn is anywhere between its slot and the end of its reply
//    (admitted, preparing, sending or streaming);
//  - the owner is typing or has just focused a conversation (the composer's
//    warm-up signal);
//  - the whole computer is overloaded (system-load.ts: load average above the
//    core count, or every core busy; children and other apps included).
// Waiting backs off with jitter, and never starves: work that has waited
// MAX_DEFER_MS is admitted anyway. Deferrals are logged once per minute per
// kind of work, with counts and reasons, never per attempt.
//
// Every hold and the bound itself are measured on a monotonic clock
// (performance.now), never the wall clock: a clock set back an hour (a time
// zone fix, NTP, the owner) must not hold background work for that hour.
import { systemLoad, type SystemLoad } from "./system-load.ts";

export const OWNER_FIRST_MAX_DEFER_MS = 120_000;
/** How long one typing or focus signal keeps background work back. */
export const OWNER_INTERACTION_HOLD_MS = 8_000;
export const OWNER_FIRST_BACKOFF_BASE_MS = 500;
export const OWNER_FIRST_BACKOFF_MAX_MS = 10_000;
export const OWNER_FIRST_LOG_WINDOW_MS = 60_000;

export type OwnerFirstReason = "owner-turn" | "owner-typing" | "system-load";
export type Admission = { admitted: true; forced: boolean } | { admitted: false; reason: OwnerFirstReason; retryInMs: number };

export interface OwnerFirstOptions {
  /** A MONOTONIC clock in ms (default performance.now). Never the wall clock: see the header. */
  now?: () => number;
  random?: () => number;
  log?: (line: string) => void;
  load?: Pick<SystemLoad, "overloaded" | "reading">;
  maxDeferMs?: number;
}

interface Streak { since: number; attempts: number }
interface LogWindow { start: number; deferred: number; forced: number; reasons: Set<OwnerFirstReason>; longestMs: number }

export class OwnerFirstGate {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly log: (line: string) => void;
  private readonly load: Pick<SystemLoad, "overloaded" | "reading">;
  private readonly maxDeferMs: number;
  private ownerTurns: () => number = () => 0;
  private localTurns = 0;
  private interactionUntil = 0;
  private streaks = new Map<string, Streak>();
  private windows = new Map<string, LogWindow>();

  constructor(options: OwnerFirstOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.random = options.random ?? Math.random;
    this.log = options.log ?? (line => console.log(line));
    this.load = options.load ?? systemLoad;
    this.maxDeferMs = options.maxDeferMs ?? OWNER_FIRST_MAX_DEFER_MS;
  }

  /** Where owner turns are counted (index.ts: the direct runs admitted as the owner's own sends). */
  setOwnerTurns(count: () => number): void { this.ownerTurns = count; }
  /** Count one owner turn by hand (tests, and callers without a run registry). Returns its release. */
  beginOwnerTurn(): () => void {
    this.localTurns++;
    let released = false;
    return () => { if (!released) { released = true; this.localTurns = Math.max(0, this.localTurns - 1); } };
  }
  /** The owner is typing or just focused a conversation. */
  noteOwnerInteraction(holdMs = OWNER_INTERACTION_HOLD_MS): void { this.interactionUntil = Math.max(this.interactionUntil, this.now() + holdMs); }

  /** Why background work should wait right now, or null. */
  pressure(): OwnerFirstReason | null {
    let turns = this.localTurns;
    try { turns += this.ownerTurns(); } catch { /* a registry that cannot answer holds nothing back */ }
    if (turns > 0) return "owner-turn";
    if (this.now() < this.interactionUntil) return "owner-typing";
    try { if (this.load.overloaded()) return "system-load"; } catch { /* unknown load admits */ }
    return null;
  }

  /** Admit `kind` now, or say how long to wait. `waitedMs` is how long this piece of work has already waited
   * (a routine since it was first held back, measured monotonically by its caller); without it the kind's
   * current streak of deferrals counts. */
  admit(kind: string, options: { waitedMs?: number } = {}): Admission {
    const now = this.now();
    const reason = this.pressure();
    const streak = this.streaks.get(kind);
    if (!reason) { this.streaks.delete(kind); return { admitted: true, forced: false }; }
    const waited = options.waitedMs;
    const since = waited !== undefined && Number.isFinite(waited) ? now - Math.max(0, waited) : streak?.since ?? now;
    if (now - since >= this.maxDeferMs) {
      // Never starve: past the bound the work goes ahead, and the next deferral starts a new streak.
      this.streaks.delete(kind);
      this.note(kind, now, reason, now - since, true);
      return { admitted: true, forced: true };
    }
    const attempts = (streak?.attempts ?? 0) + 1;
    this.streaks.set(kind, { since: streak?.since ?? now, attempts });
    const base = Math.min(OWNER_FIRST_BACKOFF_MAX_MS, OWNER_FIRST_BACKOFF_BASE_MS * 2 ** Math.min(attempts - 1, 10));
    // Jitter: half to one and a half times the step, so deferred kinds do not all come back at once.
    const retryInMs = Math.max(50, Math.min(this.maxDeferMs - (now - since), Math.round(base * (0.5 + this.random()))));
    this.note(kind, now, reason, now - since, false);
    return { admitted: false, reason, retryInMs };
  }

  /** Resolve once `kind` is admitted (forced at the bound at the latest). Rejects when `signal` aborts. */
  async wait(kind: string, signal?: AbortSignal): Promise<Admission & { admitted: true; waitedMs: number }> {
    const started = this.now();
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const admission = this.admit(kind, { waitedMs: this.now() - started });
      if (admission.admitted) return { ...admission, waitedMs: this.now() - started };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, admission.retryInMs);
        timer.unref?.();
        const onAbort = () => { clearTimeout(timer); reject(signal!.reason ?? new Error("aborted")); };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  private note(kind: string, now: number, reason: OwnerFirstReason, waitedMs: number, forced: boolean): void {
    let window = this.windows.get(kind);
    if (window && now - window.start >= OWNER_FIRST_LOG_WINDOW_MS) { this.flush(kind, window); window = undefined; }
    if (!window) {
      window = { start: now, deferred: 0, forced: 0, reasons: new Set(), longestMs: 0 };
      this.windows.set(kind, window);
      // The first deferral of a window is said at once; the rest of the window is one summary line.
      this.log(`[owner-first] deferring ${kind}: ${this.describe(reason)}`);
    }
    if (forced) window.forced++; else window.deferred++;
    window.reasons.add(reason);
    window.longestMs = Math.max(window.longestMs, waitedMs);
    if (forced) this.log(`[owner-first] ${kind} waited ${Math.round(waitedMs / 1000)} s (the most it may): admitted while ${this.describe(reason)}`);
  }
  private flush(kind: string, window: LogWindow): void {
    if (window.deferred > 1 || window.forced) this.log(`[owner-first] ${kind}: deferred ${window.deferred} times in ${Math.round(OWNER_FIRST_LOG_WINDOW_MS / 1000)} s (${[...window.reasons].join(", ")}), longest wait ${Math.round(window.longestMs / 1000)} s${window.forced ? `, admitted at the bound ${window.forced} times` : ""}`);
    this.windows.delete(kind);
  }
  private describe(reason: OwnerFirstReason): string {
    if (reason === "owner-turn") return "an owner turn is running";
    if (reason === "owner-typing") return "the owner is typing";
    let why = "";
    try { why = this.load.reading()?.why ?? ""; } catch { /* no reading */ }
    return `the computer is overloaded${why ? ` (${why})` : ""}`;
  }
}

/** The process-wide gate. index.ts tells it where owner turns are and starts the load sampler. */
export const ownerFirst = new OwnerFirstGate();
