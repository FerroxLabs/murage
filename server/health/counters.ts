// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sentinel producer counters (1.0.9, GAP-SENTINEL-109 sections 4.1, 6.4 and 9). In-memory, O(1) per event; the
// minute roll-up and its publication happen off the turn path (publisher.ts owns the timer and the files).
//
// API for producer hooks (keep calls on a turn or tool path to these four; each is an array increment or one bounded
// map operation and never throws):
//
//   recordCounter(detector, code, engineKind, sourceKey?, delta = 1, durationMs?)
//       Adds `delta` to the fixed (detector, code, engine) slot. Unknown detectors, codes and engines fall into the
//       contract's `other` members. `sourceKey` must already be an opaque token (deriveToken); anything else is
//       folded into the unkeyed slot. `durationMs` keeps the window's maximum for that slot.
//   recordFact(fact)
//       One correlation fact (obligation, isolation, io-minute, extraction-streak) for the current window. At most
//       HEALTH_LIMITS.factsPerRecord per window; overflow marks the affected detectors partial, never a guess.
//   noteTurn(scope, turn, engineKind, { refusal?, rebuildMs?, reset?, final? })
//       Per-turn deltas through the bounded correlation map (1,024 entries, 30 min expiry). Raw scope and turn ids go
//       in; only keyed tokens come out in facts. The final outcome is emitted once, then the entry is dropped.
//   extractionAdmitted(sourceKey, engineKind) / extractionSettled(sourceKey, engineKind, outcome, unusableCode?)
//       One admitted extraction attempt and its settlement (complete, unusable, cancelled, interrupted), counted under the
//       extractor's opaque sourceKey, plus the per-extractor streak fact (leading/trailing/longest unusable run) each window
//       carries. Attempts still in flight at an orderly stop settle as interrupted (setLifecycle("stopping")).
//   deriveToken(kind, raw)
//       The producer-owned keyed derivation for short-lived correlation (turn and launch tokens): HMAC-SHA256 under an
//       in-memory key made per epoch and never written anywhere, cut to 32 hex characters.
//   deriveStableToken(kind, raw)
//       The same derivation under the installation's own token key (DATA_DIR/health-key, publisher.ts loadHealthTokenKey),
//       which outlives a restart and is never published into health/. Use it for every token a fingerprint or a
//       persisted detector entry is keyed on (extractor source keys, scope tokens), so an issue opened before a restart
//       is still the same issue after it. Until the key is set it falls back to a key made once per process.
//
// setLifecycle(lifecycle) records suspend/resume/stop transitions; startEpoch() begins a new producer epoch with an
// incomplete baseline window; rollUp(now) returns the windows ready to publish (a quiet producer combines up to five
// zero windows into one, with explicit complete coverage).
import { createHmac, randomBytes } from "node:crypto";
import {
  COUNTER_CODES_BY_DETECTOR, DETECTOR_IDS, ENGINE_KINDS, FACT_DETECTORS, HEALTH_BOUNDS, HEALTH_LIMITS, HEALTH_SCHEMA_VERSION,
  HEALTH_TOKEN_PATTERN, TURN_FINALS, toEngineKind,
  type CounterRow, type CoverageValue, type DetectorName, type EngineKind, type Fact, type Lifecycle, type OperationalWindow, type Producer, type TurnFinal,
} from "../../shared/health-protocol.mjs";

/** The correlation map's ceiling and expiry (section 9: at most 1,024 active scope-correlation entries; 30 min). */
export const CORRELATION_ENTRIES = HEALTH_LIMITS.correlationEntries;
export const CORRELATION_EXPIRY_MS = 30 * 60_000;
/** Distinct sourceKey rows kept per window; further keys fold into the unkeyed slot (the aggregate stays exact). */
export const KEYED_ROWS_PER_WINDOW = 16;
/** Of those, at most this many are per-scope turn rows (S07/S08), so busy rooms never crowd out S03's per-source rows. */
export const KEYED_TURN_ROWS_PER_WINDOW = 8;
export const TOKEN_HEX = 32;
/** Extractors whose streak is followed at once; a further one marks extraction partial instead of guessing an order. */
export const EXTRACTION_STREAK_SOURCES = 8;
export type ExtractionSettlement = "complete" | "unusable" | "cancelled" | "interrupted";

// ---------------------------------------------------------------------------
// Fixed slot table: (detector, code) x engine. Built once; lookups are Map gets.
// ---------------------------------------------------------------------------
const ENGINE_INDEX = new Map<string, number>(ENGINE_KINDS.map((engine, index) => [engine, index]));
const ENGINES = ENGINE_KINDS.length;
const CODE_SLOTS = new Map<string, Map<string, number>>();
const SLOT_DETECTOR: DetectorName[] = [];
const SLOT_CODE: string[] = [];
for (const detector of DETECTOR_IDS) {
  const codes = new Map<string, number>();
  for (const code of COUNTER_CODES_BY_DETECTOR[detector]) { codes.set(code, SLOT_DETECTOR.length); SLOT_DETECTOR.push(detector); SLOT_CODE.push(code); }
  CODE_SLOTS.set(detector, codes);
}
const SLOT_COUNT = SLOT_DETECTOR.length * ENGINES;
const OTHER_SLOT = CODE_SLOTS.get("other")!.get("other")!;

function codeSlot(detector: string, code: string): number {
  const codes = CODE_SLOTS.get(detector);
  if (!codes) return OTHER_SLOT;
  return codes.get(code) ?? codes.get("other") ?? OTHER_SLOT;
}
const engineIndex = (engine: unknown): number => ENGINE_INDEX.get(toEngineKind(engine))!;
const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

interface TurnEntry { scopeToken: string; turnToken: string; engineKind: EngineKind; lastAt: number; refusal: number; rebuildMs: number; reset: number; final: TurnFinal | null; dirty: boolean }
interface KeyedRow { slot: number; sourceKey: string; value: number; maxDurationMs: number }
interface StreakEntry { sourceKey: string; engineKind: EngineKind; inFlight: number; settled: number; leading: number; leadingOpen: boolean; trailing: number; longest: number; orderComplete: boolean }
interface QuietRun { startAt: number; endAt: number; activeMs: number; windows: number; lifecycle: Lifecycle }
export interface TurnDelta { refusal?: number; rebuildMs?: number; reset?: number; final?: TurnFinal }

export interface HealthCountersOptions {
  producer: Producer;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Detectors this producer observes; each gets an explicit coverage value in every window. Default: all but `other`. */
  detectors?: readonly DetectorName[];
}

export class HealthCounters {
  readonly producer: Producer;
  private readonly now: () => number;
  private readonly detectors: readonly DetectorName[];
  private readonly values = new Float64Array(SLOT_COUNT);
  private readonly durations = new Float64Array(SLOT_COUNT);
  private readonly touched = new Int32Array(SLOT_COUNT);
  private readonly touchedFlag = new Uint8Array(SLOT_COUNT);
  private touchedCount = 0;
  private readonly keyed = new Map<string, KeyedRow>();
  private keyedTurnRows = 0;
  private facts: Fact[] = [];
  /** Rows lost this window, by detector, before publication (fact overflow, correlation eviction). */
  private lost = new Set<DetectorName>();
  private omitted = 0;
  private readonly turns = new Map<string, TurnEntry>();
  private readonly streaks = new Map<string, StreakEntry>();
  private key: Buffer = randomBytes(32);
  /** The installation's token key (setInstallationKey), or one made once per process until it is set. */
  private stableKey: Buffer = randomBytes(32);
  private installationId: string | null = null;
  private epoch = 0;
  private seq = 0;
  private started = false;
  private baseline = false;
  private windowStart: number;
  private lifecycle: Lifecycle = "running";
  private suspendedSince: number | null = null;
  private suspendedMs = 0;
  private discontinuity = false;
  private quiet: QuietRun | null = null;

  constructor(options: HealthCountersOptions) {
    this.producer = options.producer;
    this.now = options.now ?? Date.now;
    this.detectors = options.detectors ?? DETECTOR_IDS.filter(id => id !== "other");
    this.windowStart = this.now();
  }

  // -------------------------------------------------------------------------
  // Hot path
  // -------------------------------------------------------------------------

  recordCounter(detector: DetectorName | string, code: string, engineKind: EngineKind | string, sourceKey?: string, delta = 1, durationMs?: number): void {
    try {
      const amount = finite(delta);
      const duration = finite(durationMs);
      if (amount === 0 && duration === 0) return;
      const slot = codeSlot(detector, code) * ENGINES + engineIndex(engineKind);
      if (sourceKey !== undefined && HEALTH_TOKEN_PATTERN.test(sourceKey)) {
        const id = `${slot}|${sourceKey}`;
        const row = this.keyed.get(id);
        if (row) { row.value += amount; if (duration > row.maxDurationMs) row.maxDurationMs = duration; return; }
        const turnRow = detector === "dispatch-exhausted";
        if (this.keyed.size < KEYED_ROWS_PER_WINDOW && (!turnRow || this.keyedTurnRows < KEYED_TURN_ROWS_PER_WINDOW)) {
          this.keyed.set(id, { slot, sourceKey, value: amount, maxDurationMs: duration });
          if (turnRow) this.keyedTurnRows++;
          return;
        }
      }
      this.values[slot] += amount;
      if (duration > this.durations[slot]) this.durations[slot] = duration;
      if (!this.touchedFlag[slot]) { this.touchedFlag[slot] = 1; this.touched[this.touchedCount++] = slot; }
    } catch { /* telemetry never changes the operation it observes */ }
  }

  recordFact(fact: Fact): void {
    try {
      if (fact.kind === "io-minute" && (this.discontinuity || this.suspendedSince !== null)) fact = { ...fact, discontinuity: true };
      if (this.facts.length < HEALTH_LIMITS.factsPerRecord) { this.facts.push(fact); return; }
      this.loseFact(fact.kind);
    } catch { /* telemetry never changes the operation it observes */ }
  }

  noteTurn(scope: string, turn: string, engineKind: EngineKind | string, delta: TurnDelta): void {
    try {
      const turnToken = this.deriveToken("turn", turn);
      let entry = this.turns.get(turnToken);
      if (entry) this.turns.delete(turnToken); // re-insert: Map order is least recently touched first
      else {
        if (this.turns.size >= CORRELATION_ENTRIES) this.evictOldest();
        entry = { scopeToken: this.deriveStableToken("scope", scope), turnToken, engineKind: toEngineKind(engineKind), lastAt: 0, refusal: 0, rebuildMs: 0, reset: 0, final: null, dirty: false };
      }
      entry.lastAt = this.now();
      entry.refusal += finite(delta.refusal);
      entry.rebuildMs += finite(delta.rebuildMs);
      entry.reset += finite(delta.reset);
      if (delta.final !== undefined && entry.final === null) entry.final = (TURN_FINALS as readonly string[]).includes(delta.final) ? delta.final : "other";
      entry.dirty = true;
      this.turns.set(turnToken, entry);
    } catch { /* telemetry never changes the operation it observes */ }
  }

  /** An extraction attempt was admitted (its reservation committed). `sourceKey` is the extractor's opaque token. */
  extractionAdmitted(sourceKey: string, engineKind: EngineKind | string): void {
    try {
      this.recordCounter("extraction", "admitted", engineKind, sourceKey);
      const entry = this.streak(sourceKey, engineKind);
      if (entry) entry.inFlight++;
    } catch { /* telemetry never changes the operation it observes */ }
  }

  /** An admitted attempt settled. `unusableCode` is one of the contract's unusable codes (anything else counts as `other`). */
  extractionSettled(sourceKey: string, engineKind: EngineKind | string, outcome: ExtractionSettlement, unusableCode?: string): void {
    try {
      this.recordCounter("extraction", outcome, engineKind, sourceKey);
      if (outcome === "unusable") this.recordCounter("extraction", unusableCode ?? "other", engineKind, sourceKey);
      const entry = this.streak(sourceKey, engineKind);
      if (!entry) return;
      // Two attempts of one extractor in flight at once settle in an order nobody can vouch for: no streak proof this window.
      if (entry.inFlight > 1) entry.orderComplete = false;
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      entry.settled++;
      if (outcome === "unusable") {
        entry.trailing++;
        if (entry.leadingOpen) entry.leading++;
        if (entry.trailing > entry.longest) entry.longest = entry.trailing;
      } else { entry.trailing = 0; entry.leadingOpen = false; }
    } catch { /* telemetry never changes the operation it observes */ }
  }

  /** Opaque, installation-local token for a raw id. The key lives only in this process and changes every epoch. */
  deriveToken(kind: string, raw: string): string {
    return createHmac("sha256", this.key).update(kind).update("\0").update(String(raw)).digest("hex").slice(0, TOKEN_HEX);
  }

  /** Opaque token for a raw id that stays the same across epochs and restarts (the installation's token key). */
  deriveStableToken(kind: string, raw: string): string {
    return createHmac("sha256", this.stableKey).update(kind).update("\0").update(String(raw)).digest("hex").slice(0, TOKEN_HEX);
  }

  /** Sets the installation's persisted token key (32 bytes or more). Ignored when shorter. */
  setInstallationKey(key: Buffer): void {
    if (Buffer.isBuffer(key) && key.length >= 32) this.stableKey = Buffer.from(key);
  }

  // -------------------------------------------------------------------------
  // Lifecycle and epochs (publisher side)
  // -------------------------------------------------------------------------

  /** A new producer epoch: fresh token key, seq 0, and an incomplete baseline first window carrying `coverage: boot`.
   *  `previousEpoch` (from the last published record) keeps epochs strictly increasing across restarts. */
  startEpoch(installationId: string, previousEpoch = 0): number {
    if (!HEALTH_TOKEN_PATTERN.test(installationId)) throw new Error("HEALTH_INSTALLATION_ID_INVALID");
    const at = this.now();
    this.installationId = installationId;
    this.epoch = Math.min(HEALTH_BOUNDS.epoch, Math.max(Math.floor(at / 1000), Math.floor(previousEpoch) + 1));
    this.seq = 0;
    this.key = randomBytes(32);
    this.turns.clear();
    this.streaks.clear();
    this.quiet = null;
    this.started = true;
    this.baseline = true;
    this.windowStart = at;
    this.lifecycle = "running";
    this.suspendedSince = null;
    this.suspendedMs = 0;
    this.recordCounter("coverage", "boot", "none");
    return this.epoch;
  }

  get currentEpoch(): number { return this.epoch; }
  get isStarted(): boolean { return this.started; }
  /** Active correlation entries (tests and diagnostics). */
  get correlationSize(): number { return this.turns.size; }

  setLifecycle(lifecycle: Lifecycle): void {
    const at = this.now();
    if (lifecycle === "suspending" && this.suspendedSince === null) { this.suspendedSince = at; this.recordCounter("coverage", "suspend", "none"); }
    if (lifecycle === "resumed") {
      if (this.suspendedSince !== null) { this.suspendedMs += Math.max(0, at - this.suspendedSince); this.suspendedSince = null; }
      this.discontinuity = true;
      this.recordCounter("coverage", "resume", "none");
    }
    if (lifecycle === "stopping") {
      this.recordCounter("coverage", "shutdown", "none");
      // An attempt still waiting for its reply when the producer stops never settles: it is interrupted, never a guess.
      for (const entry of [...this.streaks.values()]) for (let open = entry.inFlight; open > 0; open--) this.extractionSettled(entry.sourceKey, entry.engineKind, "interrupted");
    }
    this.lifecycle = lifecycle;
  }

  /** Marks this window as broken by an outside gap (a clock jump, a deferred publication). */
  markGap(): void { this.discontinuity = true; this.recordCounter("coverage", "gap", "none"); }

  /** Closes the current window at `now` and returns what is ready to publish, oldest first. A quiet window (no rows,
   *  nothing lost, steady lifecycle) is held and combined with up to four following quiet windows. */
  rollUp(now = this.now()): OperationalWindow[] {
    if (!this.started || this.installationId === null) return [];
    if (now <= this.windowStart) return [];
    const out: OperationalWindow[] = [];
    let startAt = this.windowStart;
    let gap = false;
    if (now - startAt > HEALTH_LIMITS.maxWindowSpanMs) { startAt = now - HEALTH_LIMITS.maxWindowSpanMs; gap = true; }
    if (gap) this.recordCounter("coverage", "gap", "none");
    const suspendedMs = this.suspendedMs + (this.suspendedSince !== null ? Math.max(0, now - Math.max(this.suspendedSince, startAt)) : 0);
    const span = now - startAt;
    const activeMs = Math.max(0, Math.min(span, span - suspendedMs));
    this.expireTurns(now);
    const counters = this.drainCounters();
    const facts = this.drainFacts();
    const steady = this.lifecycle === "running" || this.lifecycle === "resumed";
    const broken = this.baseline || gap || this.discontinuity || this.suspendedSince !== null || suspendedMs > 0 || span > HEALTH_LIMITS.ioSampleMaxMs;
    const quiet = counters.length === 0 && facts.length === 0 && this.omitted === 0 && this.lost.size === 0 && !broken && steady;

    if (quiet) {
      if (this.quiet && now - this.quiet.startAt > HEALTH_LIMITS.maxWindowSpanMs) out.push(this.flushQuiet()!);
      if (this.quiet) { this.quiet.endAt = now; this.quiet.activeMs += activeMs; this.quiet.windows++; }
      else this.quiet = { startAt, endAt: now, activeMs, windows: 1, lifecycle: this.lifecycle };
      if (this.quiet.windows >= HEALTH_LIMITS.quietCombineWindows) out.push(this.flushQuiet()!);
    } else {
      const held = this.flushQuiet();
      if (held) out.push(held);
      const coverage: Partial<Record<DetectorName, CoverageValue>> = {};
      for (const detector of this.detectors) coverage[detector] = broken || this.lost.has(detector) ? "partial" : "complete";
      for (const detector of this.lost) if (!(detector in coverage)) coverage[detector] = "partial";
      out.push(this.window(startAt, now, activeMs, !broken && this.omitted === 0 && this.lost.size === 0, this.omitted, coverage, counters, facts));
    }
    this.windowStart = now;
    if (this.lifecycle === "resumed") this.lifecycle = "running";
    this.baseline = false;
    this.discontinuity = false;
    this.suspendedMs = 0;
    if (this.suspendedSince !== null) this.suspendedSince = now;
    this.omitted = 0;
    this.lost = new Set();
    return out;
  }

  /** Publishes whatever is held (the quiet run and the open window), for an orderly stop. */
  flush(now = this.now()): OperationalWindow[] {
    const out = this.rollUp(now);
    const held = this.flushQuiet();
    return held ? [...out, held] : out;
  }

  // -------------------------------------------------------------------------
  // Internals (all off the turn path)
  // -------------------------------------------------------------------------

  private window(startAt: number, endAt: number, activeMs: number, complete: boolean, omitted: number, coverageByDetector: Partial<Record<DetectorName, CoverageValue>>, counters: CounterRow[], facts: Fact[], lifecycle = this.lifecycle): OperationalWindow {
    return {
      schemaVersion: HEALTH_SCHEMA_VERSION, installationId: this.installationId!, producer: this.producer, epoch: this.epoch, seq: Math.min(HEALTH_BOUNDS.seq, this.seq++),
      startAt, endAt, activeMs, complete, omitted, coverageByDetector, counters, facts, lifecycle,
    };
  }

  private flushQuiet(): OperationalWindow | null {
    const run = this.quiet;
    if (!run) return null;
    this.quiet = null;
    const coverage: Partial<Record<DetectorName, CoverageValue>> = {};
    for (const detector of this.detectors) coverage[detector] = "complete";
    return this.window(run.startAt, run.endAt, Math.min(run.activeMs, run.endAt - run.startAt), true, 0, coverage, [], [], run.lifecycle);
  }

  private drainCounters(): CounterRow[] {
    const rows: CounterRow[] = [];
    for (let index = 0; index < this.touchedCount; index++) {
      const slot = this.touched[index]!;
      const value = Math.min(HEALTH_BOUNDS.count, Math.round(this.values[slot]!));
      const duration = Math.min(HEALTH_BOUNDS.durationMs, Math.round(this.durations[slot]!));
      rows.push(this.row(slot, value, duration));
      this.values[slot] = 0; this.durations[slot] = 0; this.touchedFlag[slot] = 0;
    }
    this.touchedCount = 0;
    for (const row of this.keyed.values()) {
      rows.push({ ...this.row(row.slot, Math.min(HEALTH_BOUNDS.count, Math.round(row.value)), Math.min(HEALTH_BOUNDS.durationMs, Math.round(row.maxDurationMs))), sourceKey: row.sourceKey });
    }
    this.keyed.clear();
    this.keyedTurnRows = 0;
    return rows;
  }

  private row(slot: number, value: number, duration: number): CounterRow {
    const codeIndex = Math.floor(slot / ENGINES);
    const out: CounterRow = { detector: SLOT_DETECTOR[codeIndex]!, engineKind: ENGINE_KINDS[slot % ENGINES]!, code: SLOT_CODE[codeIndex]!, value };
    if (duration > 0) out.maxDurationMs = duration;
    return out;
  }

  private drainFacts(): Fact[] {
    const facts = this.facts;
    this.facts = [];
    for (const [id, entry] of this.streaks) {
      if (entry.settled > 0) {
        if (facts.length >= HEALTH_LIMITS.factsPerRecord) this.loseFact("extraction-streak");
        else facts.push({
          kind: "extraction-streak", sourceKey: entry.sourceKey, engineKind: entry.engineKind,
          leadingUnusable: entry.leading, trailingUnusable: entry.trailing, maxConsecutiveUnusable: entry.longest, settledCount: entry.settled, orderComplete: entry.orderComplete,
        });
      }
      Object.assign(entry, { settled: 0, leading: 0, leadingOpen: true, trailing: 0, longest: 0, orderComplete: true });
      if (entry.inFlight === 0) this.streaks.delete(id);
    }
    for (const entry of this.turns.values()) {
      if (!entry.dirty) continue;
      // Only a refusal, rebuild, reset or exhaustion is a fact; a plain end of turn travels as a counter row.
      if (entry.refusal === 0 && entry.rebuildMs === 0 && entry.reset === 0 && entry.final !== "exhausted") {
        entry.dirty = false;
        if (entry.final !== null) this.turns.delete(entry.turnToken);
        continue;
      }
      if (facts.length >= HEALTH_LIMITS.factsPerRecord) { this.loseFact("turn-window"); continue; }
      facts.push({
        kind: "turn-window", scopeToken: entry.scopeToken, turnToken: entry.turnToken, engineKind: entry.engineKind, at: entry.lastAt,
        refusalDelta: Math.min(HEALTH_BOUNDS.count, Math.round(entry.refusal)), rebuildMsDelta: Math.min(HEALTH_BOUNDS.durationMs, Math.round(entry.rebuildMs)),
        resetDelta: Math.min(HEALTH_BOUNDS.count, Math.round(entry.reset)), final: entry.final,
      });
      entry.refusal = 0; entry.rebuildMs = 0; entry.reset = 0; entry.dirty = false;
      if (entry.final !== null) this.turns.delete(entry.turnToken);
    }
    return facts;
  }

  private streak(sourceKey: string, engineKind: EngineKind | string): StreakEntry | null {
    if (!HEALTH_TOKEN_PATTERN.test(sourceKey)) { this.lost.add("extraction"); return null; }
    const engine = toEngineKind(engineKind);
    const id = `${engine}|${sourceKey}`;
    let entry = this.streaks.get(id);
    if (!entry) {
      if (this.streaks.size >= EXTRACTION_STREAK_SOURCES) { this.lost.add("extraction"); return null; }
      entry = { sourceKey, engineKind: engine, inFlight: 0, settled: 0, leading: 0, leadingOpen: true, trailing: 0, longest: 0, orderComplete: true };
      this.streaks.set(id, entry);
    }
    return entry;
  }

  private loseFact(kind: Fact["kind"]): void {
    this.omitted++;
    for (const detector of FACT_DETECTORS[kind] ?? []) this.lost.add(detector);
  }

  private evictOldest(): void {
    const oldest = this.turns.keys().next();
    if (oldest.done) return;
    const entry = this.turns.get(oldest.value)!;
    this.turns.delete(oldest.value);
    // An evicted token can no longer prove a per-scope threshold or recovery: say so for this window.
    if (entry.dirty || entry.final === null) for (const detector of FACT_DETECTORS["turn-window"]) this.lost.add(detector);
  }

  private expireTurns(now: number): void {
    for (const [token, entry] of this.turns) {
      if (now - entry.lastAt <= CORRELATION_EXPIRY_MS) break; // least recently touched first
      this.turns.delete(token);
      if (entry.dirty) for (const detector of FACT_DETECTORS["turn-window"]) this.lost.add(detector);
    }
  }
}

// ---------------------------------------------------------------------------
// The server producer's counters, and the hook functions bound to them.
// ---------------------------------------------------------------------------
export const serverHealthCounters = new HealthCounters({ producer: "server" });

export function recordCounter(detector: DetectorName | string, code: string, engineKind: EngineKind | string, sourceKey?: string, delta = 1, durationMs?: number): void {
  serverHealthCounters.recordCounter(detector, code, engineKind, sourceKey, delta, durationMs);
}
export function recordFact(fact: Fact): void { serverHealthCounters.recordFact(fact); }
export function noteTurn(scope: string, turn: string, engineKind: EngineKind | string, delta: TurnDelta): void { serverHealthCounters.noteTurn(scope, turn, engineKind, delta); }
export function deriveToken(kind: string, raw: string): string { return serverHealthCounters.deriveToken(kind, raw); }
export function deriveStableToken(kind: string, raw: string): string { return serverHealthCounters.deriveStableToken(kind, raw); }
export function extractionAdmitted(sourceKey: string, engineKind: EngineKind | string): void { serverHealthCounters.extractionAdmitted(sourceKey, engineKind); }
export function extractionSettled(sourceKey: string, engineKind: EngineKind | string, outcome: ExtractionSettlement, unusableCode?: string): void {
  serverHealthCounters.extractionSettled(sourceKey, engineKind, outcome, unusableCode);
}
