// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bounded recovery of a stop that could not be proven (design P2, C1-C5, T2, V4). A stop that is not proven keeps the bot refused and
// is re-attempted with bounded backoff for as long as it stays unproven; the bot is released ONLY by a proof (gone) from a current
// probe. There is no time-out release, no health release and no late-result release.
//   C2  re-prove on the next turn request and on 2 s, 10 s, 30 s, 60 s, then every 60 s (injected clock), one probe at a time per bot.
//   V4  every probe attempt is its own helper child; at the cap the attempt is UNKNOWN, that generation's abort fires and that
//       generation's helper alone is killed; unsettled 2 x cap after the abort it is ABANDONED (generation bumped, a later result is
//       discarded) so the token is released at the latest 3 x cap from the start and the next attempt runs on schedule. A helper still
//       alive after its forced settlement is a LEAK: one live leak per bot is allowed beside the next active probe, and a further probe
//       is refused while the bot already holds two live leaks or the process holds four (fail closed; probing resumes when one exits).
//   C3/C5  after the 3rd UNKNOWN, and on every alive proof, the platform kill is sent again (never a process group on desktop).
//   Health is decoupled from escalation: ONE item per bot per day at the first of 5 minutes UNKNOWN, any abandonment, 4 live leaks.
import type { Pair, StopRecord, Verdict } from "./mcp-stop-proof.ts";

export interface RecoveryClock { now(): number; setTimeout(fn: () => void, ms: number): () => void }
export const realRecoveryClock: RecoveryClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return () => clearTimeout(timer); },
};

export type ProbeOutcome = Verdict & { reparented?: Pair[] };
/** One probe attempt: its helper child. `result` resolves with the verdict; `kill()` ends THIS helper only; `exited` resolves when the helper process is gone. */
export interface ProbeHandle { readonly result: Promise<ProbeOutcome>; kill(): void; alive(): boolean; readonly exited: Promise<void> }
export interface RecoveryDeps {
  clock: RecoveryClock;
  /** Starts a helper child for one attempt. `signal` is that generation's abort. */
  launch(record: StopRecord, signal: AbortSignal): ProbeHandle;
  /** The platform kill (cgroup.kill, TerminateJobObject, or per-pair identity-verified signals). Never a group kill. */
  reKill(record: StopRecord): Promise<void>;
  /** Persist a REPARENTED flag or any union update before the next attempt. */
  save?(record: StopRecord): void;
  /** Called once, only on a proof of gone from a current probe. The record is already deleted by the caller of this hook. */
  release(record: StopRecord): void;
  health(item: { owner: string; reason: "unknown-5-minutes" | "probe-abandoned" | "leak-cap"; day: number }): void;
  log?(line: string): void;
  capMs?: number;
}

export const PROBE_CAP_MS = 10_000;
export const BACKOFF_MS = [2_000, 10_000, 30_000, 60_000] as const;
export const UNKNOWN_HEALTH_MS = 5 * 60_000;
export const MAX_BOT_LEAKS = 2; // one allowed beside the active probe, so a bot at two live leaks starts no further probe
export const MAX_PROCESS_LEAKS = 4;
export const ESCALATE_AFTER = 3;
const DAY_MS = 86_400_000;

interface Active { gen: number; handle: ProbeHandle; controller: AbortController; cancel: Array<() => void>; timedOut: boolean; startedAt: number; done: boolean }
interface Entry {
  record: StopRecord;
  key: string;
  gen: number;
  attempts: number;
  unknownCount: number;
  unknownSince: number | null;
  active: Active | null;
  leaks: Set<ProbeHandle>;
  cancelNext: (() => void) | null;
  cancelHealth: (() => void) | null;
  released: boolean;
  resolve: () => void;
  /** Attempt start times, for tests that assert there is no tight loop. */
  starts: number[];
  refused: boolean;
}

export class McpStopRecovery {
  readonly #deps: RecoveryDeps;
  readonly #entries = new Map<string, Entry>();
  readonly #healthSent = new Set<string>();
  readonly #leaks = new Set<ProbeHandle>();
  constructor(deps: RecoveryDeps) { this.#deps = deps; }

  get #cap(): number { return this.#deps.capMs ?? PROBE_CAP_MS; }
  #key(record: StopRecord): string { return `${record.owner}\0${record.generation}`; }

  /** True while any undeleted stop for this owner is unproven. */
  quarantined(owner: string): boolean { for (const entry of this.#entries.values()) if (!entry.released && entry.record.owner === owner) return true; return false; }
  /** Live leaks held by the process. */
  get processLeaks(): number { return this.#leaks.size; }
  /** Test and support read of one entry. */
  inspect(record: Pick<StopRecord, "owner" | "generation">): { attempts: number; unknownCount: number; gen: number; starts: number[]; leaks: number; active: boolean; refused: boolean } | undefined {
    const entry = this.#entries.get(this.#key(record as StopRecord));
    return entry && { attempts: entry.attempts, unknownCount: entry.unknownCount, gen: entry.gen, starts: [...entry.starts], leaks: entry.leaks.size, active: entry.active !== null, refused: entry.refused };
  }

  /** Quarantine the stop and keep re-proving it. Resolves ONLY when the stop is proven gone; never rejects. `immediate` starts the
   *  first proof now (a restart must prove at once); otherwise the first attempt waits the first backoff. */
  enroll(record: StopRecord, options: { immediate?: boolean } = {}): Promise<void> {
    const key = this.#key(record);
    const existing = this.#entries.get(key);
    if (existing && !existing.released) { existing.record = record; return new Promise<void>((resolve) => { const prior = existing.resolve; existing.resolve = () => { prior(); resolve(); }; }); }
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    const entry: Entry = { record, key, gen: 0, attempts: 0, unknownCount: 0, unknownSince: null, active: null, leaks: new Set(), cancelNext: null, cancelHealth: null, released: false, resolve, starts: [], refused: false };
    this.#entries.set(key, entry);
    if (options.immediate) void this.#attempt(entry); else this.#schedule(entry);
    return done;
  }

  /** The bot's next turn request: re-prove now (single flight, so a flood of requests is one probe). */
  requestProbe(owner: string): void {
    for (const entry of this.#entries.values()) if (!entry.released && entry.record.owner === owner && !entry.active) void this.#attempt(entry);
  }

  #schedule(entry: Entry): void {
    entry.cancelNext?.();
    if (entry.released) return;
    // after 0,1,2,3 attempts: 2 s, 10 s, 30 s, 60 s; every later attempt waits 60 s
    const wait = BACKOFF_MS[Math.min(entry.attempts, BACKOFF_MS.length - 1)]!;
    entry.cancelNext = this.#deps.clock.setTimeout(() => { entry.cancelNext = null; void this.#attempt(entry); }, wait);
  }

  #noteUnknown(entry: Entry): void {
    entry.unknownCount++;
    if (entry.unknownSince === null) {
      entry.unknownSince = this.#deps.clock.now();
      entry.cancelHealth?.();
      entry.cancelHealth = this.#deps.clock.setTimeout(() => { if (!entry.released) this.#raise(entry, "unknown-5-minutes"); }, UNKNOWN_HEALTH_MS);
    } else if (this.#deps.clock.now() - entry.unknownSince >= UNKNOWN_HEALTH_MS) this.#raise(entry, "unknown-5-minutes");
  }
  #raise(entry: Entry, reason: "unknown-5-minutes" | "probe-abandoned" | "leak-cap"): void {
    const day = Math.floor(this.#deps.clock.now() / DAY_MS);
    const key = `${entry.record.owner}\0${day}`;
    if (this.#healthSent.has(key)) return;
    this.#healthSent.add(key);
    this.#deps.health({ owner: entry.record.owner, reason, day });
  }

  async #attempt(entry: Entry): Promise<void> {
    if (entry.released || entry.active) return;
    entry.cancelNext?.(); entry.cancelNext = null;
    if (entry.leaks.size >= MAX_BOT_LEAKS || this.#leaks.size >= MAX_PROCESS_LEAKS) {
      // fail closed: the bot stays refused; probing resumes when a leaked helper exits
      entry.refused = true;
      if (this.#leaks.size >= MAX_PROCESS_LEAKS) this.#raise(entry, "leak-cap");
      this.#schedule(entry);
      return;
    }
    entry.refused = false;
    const gen = ++entry.gen;
    entry.attempts++;
    entry.starts.push(this.#deps.clock.now());
    const controller = new AbortController();
    let handle: ProbeHandle;
    try { handle = this.#deps.launch(entry.record, controller.signal); }
    catch { this.#noteUnknown(entry); this.#schedule(entry); return; }
    const active: Active = { gen, handle, controller, cancel: [], timedOut: false, startedAt: this.#deps.clock.now(), done: false };
    entry.active = active;
    // The cap: the attempt is UNKNOWN, this generation's abort fires and this generation's helper alone is killed.
    active.cancel.push(this.#deps.clock.setTimeout(() => {
      if (active.done || entry.active !== active) return;
      active.timedOut = true;
      this.#noteUnknown(entry);
      try { controller.abort(); } catch { /* already aborted */ }
      try { handle.kill(); } catch { /* already gone */ }
      // 2 x cap after the abort without settling: ABANDONED. Token released by generation; later results are discarded.
      active.cancel.push(this.#deps.clock.setTimeout(() => this.#abandon(entry, active), 2 * this.#cap));
    }, this.#cap));
    handle.result.then((outcome) => this.#settle(entry, active, outcome), () => this.#settle(entry, active, { v: "unknown", why: "the probe helper failed" }));
  }

  #finish(entry: Entry, active: Active): void {
    active.done = true;
    for (const cancel of active.cancel) cancel();
    if (entry.active === active) entry.active = null;
  }

  #abandon(entry: Entry, active: Active): void {
    if (active.done || entry.active !== active) return;
    this.#finish(entry, active);
    entry.gen++; // a late result of this generation is discarded
    this.#deps.log?.(`mcp stop probe for ${entry.record.owner} abandoned`);
    if (active.handle.alive()) {
      entry.leaks.add(active.handle); this.#leaks.add(active.handle);
      void active.handle.exited.then(() => { entry.leaks.delete(active.handle); this.#leaks.delete(active.handle); });
    }
    this.#raise(entry, "probe-abandoned");
    if (this.#leaks.size >= MAX_PROCESS_LEAKS) this.#raise(entry, "leak-cap");
    this.#schedule(entry);
  }

  #settle(entry: Entry, active: Active, outcome: ProbeOutcome): void {
    // a result that arrives after its generation was abandoned or superseded is discarded
    if (active.done || entry.active !== active || entry.gen !== active.gen || entry.released) return;
    this.#finish(entry, active);
    if (active.timedOut) { this.#schedule(entry); return; } // a timed-out probe can never release
    if (outcome.reparented?.length) {
      const flagged = new Set(outcome.reparented.map((pair) => `${pair.pid}:${pair.start}`));
      const desktop = entry.record.desktop;
      if (desktop) {
        entry.record = { ...entry.record, desktop: { ...desktop, pairs: desktop.pairs.map((pair) => flagged.has(`${pair.pid}:${pair.start}`) ? { ...pair, reparented: true } : pair) } };
        try { this.#deps.save?.(entry.record); } catch { /* the in-memory flag still holds */ }
      }
    }
    if (outcome.v === "gone") {
      entry.released = true;
      entry.cancelNext?.(); entry.cancelHealth?.();
      this.#entries.delete(entry.key);
      try { this.#deps.release(entry.record); } finally { entry.resolve(); }
      return;
    }
    if (outcome.v === "unknown") this.#noteUnknown(entry);
    const rekill = outcome.v === "alive" || (outcome.v === "unknown" && entry.unknownCount === ESCALATE_AFTER);
    const next = () => this.#schedule(entry);
    if (rekill) void this.#deps.reKill(entry.record).catch(() => undefined).then(next); else next();
  }
}
