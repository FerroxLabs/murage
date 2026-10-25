// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What an upgrade reports about itself, in one shape, wherever it is read: the start-up note (upgrade-status.ts), the 503 answer the
// pre-listen health responder gives while the server thread is busy (upgrade-health.ts), and `memoryIntegrity` in /api/health once the
// server listens. A leaf module (no database or schema imports) so a worker thread's source and the tests can share it.
//
// This file carries no screen copy. `label` is a short plain name for the phase; the screen has its own words and consumes the ids and
// numbers. Counts come from counters that cost nothing (max(rowid), a small table's count), never from a scan of the history.
import type { DatabaseSync } from "node:sqlite";
import { overlayCounts, type ExactCounts } from "./upgrade-counts.ts";
import { bootLaunchId } from "./boot-nonce.ts";
import { AWAKE_GAP_CAP_MS, COUNTED_UNITS, PHASE_IDS, buildUpgradeState, restampUpgradeState, unknownUpgradeState, type UpgradeState, type StorageState, type StoredMode, type Tri, type OnOff } from "../../shared/upgrade-contract.mjs";

export interface UpgradeCounts {
  /** Conversations (rows of thread_state). null until counted exactly. */
  conversations: number | null;
  /** Messages (rows of messages). null until counted exactly. */
  messages: number | null;
  /** Memory records. null until counted exactly. */
  memoryRecords: number | null;
  /** Memory receipts. null until counted exactly. */
  receipts: number | null;
  /** When the oldest message was written (ms since the epoch); null until counted, or when there is none. */
  firstMessageAt: number | null;
  /** Size of messages.db in bytes. */
  dbBytes: number | null;
  /** True once the figures above are exact (counted by upgrade-counts.ts on its own read-only connection, or cached for a file nothing has written to since). Until then they are all null: a screen shows no number. */
  exact: boolean;
}
export type PhaseState = "pending" | "running" | "done";
export interface UpgradePhase { id: string; label: string; state: PhaseState; done: number; total: number; weight: number;
  /** What `done` and `total` count; "steps" for a phase whose figures are positions, not things (a screen shows no "done of total" for those). */
  unit: string;
  /** Things actually handled so far (rows walked), where a phase counts them exactly; null otherwise. Only a phase named in COUNTED_UNITS may use it. */
  counted: number | null }
/** The part of the whole launch's range one tracker covers, and where an earlier run of the same upgrade had got to. */
/** `persist` returns the highest value now on disk: the tracker never publishes more than a restart would read back. */
export interface LaunchWindow { from: number; to: number; floor?: number; persist?: (overall: number, force?: boolean) => number | void }
export interface UpgradeProgress {
  /** The phase running now (its id), or "" when none. `phaseId` is the same value under the name the screen reads. */
  phase: string;
  phaseId: string;
  /** Key of the screen's text for the phase (the screen owns the words and the translations). */
  labelKey: string;
  label: string;
  counts: UpgradeCounts;
  phases: UpgradePhase[];
  /** Done and total of the running phase, in the unit its `label` implies (rows, receipts, tables, sets). */
  done: number;
  total: number;
  /** 0 to 1 over every phase of this stage. */
  fraction: number;
  /** What `done` and `total` of the running phase count ("messages", "steps", ...). */
  unit: string;
  /** 0 to 1 over the whole launch (the blocking stage and the background work together). It never goes backwards, within a launch or across a restart. */
  overall: number;
  /** Seconds left, from throughput measured so far; null until that throughput is steady. */
  etaSeconds: number | null;
  /** Milliseconds left. With `etaStable` false the figure is a first guess (from the rates a previous upgrade measured) or null; a screen shows it only when stable. */
  etaMs: number | null;
  etaStable: boolean;
  /** When this snapshot was taken, and when a figure above last changed: a heartbeat that says "still working" is separate from progress. */
  stillWorkingAt: number;
  progressAt: number;
  /** Measured units per second of each phase that has run long enough to measure, for calibrating later estimates. */
  rates: Record<string, number>;
  /** True while closing Murage would stop the upgrade making progress (the pre-listen stage), or leave background work waiting for the next start. */
  keepOpen: boolean;
  /** The stage: "starting" is before the server listens (Murage is not usable), "background" is after (it is). */
  stage: "starting" | "background";
  /** The same reading in the one shape every screen reads (shared/upgrade-contract.mjs). The fields above are this tracker's own working figures. */
  upgrade: UpgradeState;
}

/** What the tracker cannot know on its own: whether the whole upgrade is over, whether memory is held, what the owner has memory set to, and the storage conversion. */
export interface UpgradeOutside { complete: Tri; held: Tri; holdKey: string | null; capture: OnOff; recall: OnOff; storedMode: StoredMode; storage: StorageState; checking: Tri }
export const UNKNOWN_OUTSIDE: UpgradeOutside = { complete: "unknown", held: "unknown", holdKey: null, capture: "unknown", recall: "unknown", storedMode: "unknown", storage: "unknown", checking: "unknown" };
let sequence = 0;
/** Increases for every reading made in this process, so a screen can drop an answer that arrives after a newer one. */
export function nextUpgradeSeq(): number { return ++sequence; }

export const PHASE_LABELS: Record<string, string> = {
  checking: "Checking your memory",
  copying: "Making a backup copy",
  migrating: "Upgrading memory tables",
  "search-index": "Indexing messages for search",
  masking: "Masking bank and card numbers in earlier memory",
  settling: "Settling earlier memory",
  "output-index": "Checking memory receipts",
  references: "Checking memory links",
  shapes: "Checking how memory is stored",
  learning: "Checking what Murage learned",
  lineage: "Rebuilding reply history",
  writetime: "Checking earlier memory",
  marker: "Settling earlier memory",
  storage: "Converting stored history",
  "message-index": "Indexing your messages",
};

/** The counts before anything has been counted: no figure at all (a rowid high-water mark is not a count, and a cheap guess is not shown as one). The exact figures are counted off the server thread (upgrade-counts.ts) and merged in by the tracker once they exist. */
export function upgradeCounts(_db: DatabaseSync | null, dbBytes: number | null = null): UpgradeCounts {
  return { conversations: null, messages: null, memoryRecords: null, receipts: null, firstMessageAt: null, dbBytes, exact: false };
}

const SAMPLE_WINDOW_MS = 60_000;
/** A gap this long between two progress samples means the machine slept: the estimate starts again. */
export const SLEEP_GAP_MS = 30_000;
/** Tracks one stage of an upgrade: which phases it has, how far each is, and how fast the whole is going. */
export class UpgradeProgressTracker {
  private phases: UpgradePhase[];
  private samples: Array<{ at: number; fraction: number }> = [];
  private readonly now: () => number;
  private high = 0;
  private progressAt: number;
  private started = new Map<string, { at: number; done: number }>();
  private measured: Record<string, number> = {};
  // (no parameter properties: the server runs as TypeScript with types stripped, which cannot express them)
  readonly stage: UpgradeProgress["stage"];
  private counts: UpgradeCounts;
  private priorRates: Record<string, number>;
  private launch: LaunchWindow;
  private overallHigh: number;
  private savedHigh = 0;
  constructor(stage: UpgradeProgress["stage"], counts: UpgradeCounts, phases: Array<{ id: string; weight?: number; total?: number; unit?: string }>, now: () => number = Date.now, priorRates: Record<string, number> = {}, launch: LaunchWindow = { from: 0, to: 1 }) {
    this.stage = stage; this.counts = counts; this.priorRates = priorRates; this.launch = launch;
    this.overallHigh = Math.max(0, Math.min(1, launch.floor ?? 0)); this.savedHigh = this.overallHigh;
    this.now = now; this.progressAt = now();
    this.phases = phases.map(phase => ({ id: phase.id, label: PHASE_LABELS[phase.id] ?? phase.id, state: "pending" as PhaseState, done: 0, total: phase.total ?? 0, weight: phase.weight ?? 1, unit: phase.unit ?? "steps", counted: null }));
    this.touchedAt = now();
  }
  // Time awake, per phase: each touch adds the gap since the last one, capped (a machine asleep for ten minutes adds a few seconds, not ten minutes).
  private awake = new Map<string, number>();
  private touchedAt: number;
  private touching = "";
  private outside: () => Partial<UpgradeOutside> = () => UNKNOWN_OUTSIDE;
  /** Where the facts the tracker cannot know come from; read at every snapshot. */
  setOutside(source: (() => Partial<UpgradeOutside>) | null) { this.outside = source ?? (() => UNKNOWN_OUTSIDE); }
  private touch(phase: string) {
    const at = this.now();
    if (this.touching) this.awake.set(this.touching, (this.awake.get(this.touching) ?? 0) + Math.max(0, Math.min(AWAKE_GAP_CAP_MS, at - this.touchedAt)));
    this.touchedAt = at; this.touching = phase;
  }
  /** Where the exact counts come from (the counting thread's block); read at every snapshot. */
  private exactSource: (() => ExactCounts | null) | null = null;
  setCountsSource(source: (() => ExactCounts | null) | null) { this.exactSource = source; }
  /** The size a phase was given when the tracker was made (0 when none). */
  totalOf(id: string): number { return this.phases.find(phase => phase.id === id)?.total ?? 0; }
  setCounts(counts: UpgradeCounts) { this.counts = counts; }
  /** Moves a phase. Earlier phases still pending are closed (a phase that had nothing to do). */
  update(id: string, done: number, total: number, finished = false, counted: number | null = null): void {
    const at = this.phases.findIndex(phase => phase.id === id);
    if (at < 0) return;
    this.touch(id);
    for (let i = 0; i < at; i++) if (this.phases[i]!.state !== "done") { this.phases[i]!.state = "done"; this.phases[i]!.done = this.phases[i]!.total; }
    const phase = this.phases[at]!;
    phase.counted = counted !== null && Number.isFinite(counted) && counted >= 0 ? Math.floor(counted) : null;
    phase.total = Math.max(0, total); phase.done = Math.max(0, Math.min(phase.total || done, done));
    phase.state = finished || (phase.total > 0 && phase.done >= phase.total) ? "done" : "running";
    if (phase.state === "done") phase.done = phase.total;
    // the phase's own rate (units per second since it began), once it has run long enough to mean something
    const began = this.started.get(id) ?? (this.started.set(id, { at: this.now(), done: phase.done }), this.started.get(id)!);
    const elapsed = this.now() - began.at;
    if (elapsed >= 2_000 && phase.done > began.done) this.measured[id] = (phase.done - began.done) / (elapsed / 1000);
    this.progressAt = this.now();
    this.sample();
  }
  finishAll(): void { this.touch(""); for (const phase of this.phases) { phase.state = "done"; phase.done = phase.total; } this.sample(); }
  private fractionNow(): number {
    const sum = this.phases.reduce((a, p) => a + p.weight, 0) || 1;
    let got = 0;
    for (const p of this.phases) got += p.weight * (p.state === "done" ? 1 : p.state === "running" && p.total > 0 ? Math.min(1, p.done / p.total) : 0);
    return Math.max(0, Math.min(1, got / sum));
  }
  private sample(): void {
    const at = this.now(), fraction = this.fractionNow();
    const last = this.samples[this.samples.length - 1];
    // a long gap between two samples is the machine asleep (or the process stopped): the rate before it says nothing about the rate after
    if (last && at - last.at > SLEEP_GAP_MS) { this.samples = []; this.started.clear(); }
    if (!last || fraction !== last.fraction) this.samples.push({ at, fraction });
    while (this.samples.length > 2 && at - this.samples[0]!.at > SAMPLE_WINDOW_MS) this.samples.shift();
  }
  /** Seconds left, or null until the rate is steady: at least 6 samples over 5 seconds, 3% done, and the rate of the second half of the window within 40% of the first half's. */
  eta(): number | null {
    const s = this.samples, n = s.length;
    if (n < 6) return null;
    const first = s[0]!, last = s[n - 1]!, span = last.at - first.at;
    if (span < 5_000 || last.fraction < 0.03 || last.fraction >= 1) return null;
    const mid = s[Math.floor(n / 2)]!;
    const early = (mid.fraction - first.fraction) / Math.max(1, mid.at - first.at), late = (last.fraction - mid.fraction) / Math.max(1, last.at - mid.at);
    if (!(early > 0) || !(late > 0) || Math.abs(late - early) / early > 0.4) return null;
    const rate = (last.fraction - first.fraction) / span;
    return Math.max(1, Math.round((1 - last.fraction) / rate / 1000));
  }
  /** The estimate starts again (the machine woke, or a long pause). */
  resetRate(): void { this.samples = []; this.started.clear(); }
  /** A first guess from the rates a previous upgrade measured: the time the remaining units of each phase would take. */
  private guess(): number | null {
    let seconds = 0;
    for (const phase of this.phases) {
      if (phase.state === "done") continue;
      const rate = this.priorRates[phase.id];
      if (!rate || !(phase.total > 0)) return null;
      seconds += (phase.total - phase.done) / rate;
    }
    return seconds > 0 ? Math.round(seconds * 1000) : null;
  }
  snapshot(keepOpen: boolean): UpgradeProgress {
    const current = this.phases.find(p => p.state === "running") ?? this.phases.find(p => p.state === "pending");
    // never backwards within a launch: a phase that learns its real size later does not pull the bar back
    this.high = Math.max(this.high, this.fractionNow());
    // Over the whole launch: this stage's share of the range, starting where an earlier run of the same upgrade had got to, never lower than anything shown before.
    const window = this.launch, start = Math.min(window.to, Math.max(window.from, window.floor ?? 0));
    const overall = Math.max(this.overallHigh, Math.min(1, start + (window.to - start) * this.high));
    if (overall > this.overallHigh) this.overallHigh = overall;
    // Published only once persisted: what is shown never exceeds what a restart reads back, so a crash cannot make the bar go 60 then 40. The last
    // value (the work is over) is written at once; the others at the writer's pace.
    if (window.persist) {
      try { const saved = window.persist(this.overallHigh, this.overallHigh >= 1); this.savedHigh = Math.max(this.savedHigh, typeof saved === "number" ? saved : this.overallHigh); } catch { /* the mark is best effort: the last saved value stays the published one */ }
    } else this.savedHigh = this.overallHigh;
    const id = current?.id ?? "";
    // an open-ended phase (its total slides with its done) has no real fraction, so it gets no time left either
    const open = Object.hasOwn(COUNTED_UNITS, id) && COUNTED_UNITS[id] === "open";
    const stable = open || this.now() - this.progressAt > SLEEP_GAP_MS ? null : this.eta(), guess = stable === null && !open ? this.guess() : null;
    this.touch(id);
    const exact = this.exactSource?.() ?? null;
    const progress = overlayCounts({
      phase: id, phaseId: id, labelKey: id ? `upgrade.phase.${id}` : "", label: current?.label ?? "", counts: this.counts, phases: this.phases.map(p => ({ ...p })),
      done: current?.done ?? 0, total: current?.total ?? 0, unit: current?.unit ?? "steps", fraction: this.high, overall: this.savedHigh, etaSeconds: stable, etaMs: stable !== null ? stable * 1000 : guess, etaStable: stable !== null,
      stillWorkingAt: this.now(), progressAt: this.progressAt, rates: { ...this.measured }, keepOpen, stage: this.stage,
    } as Omit<UpgradeProgress, "upgrade">, exact);
    // The contract's reading is made last and never stops the progress: a reading the contract refuses (a phase it has no name for, say) is replaced by one that says nothing is known.
    let upgrade: UpgradeState;
    try { upgrade = this.contractState(progress, current, exact, stable, keepOpen); }
    catch { upgrade = unknownUpgradeState({ launch: bootLaunchId(), seq: nextUpgradeSeq(), source: "note", stage: this.stage, complete: this.stage === "starting" ? false : "unknown", keepOpen, heartbeatAt: this.now() }); }
    return { ...progress, upgrade };
  }
  /** The reading in the contract's shape. A counted step is only ever made from figures that are exact: conversations of a list already in hand, sets of the
   * compaction row, messages walked against the exactly counted total. Every other phase is a step with no "done of total". */
  private contractState(progress: Omit<UpgradeProgress, "upgrade">, current: UpgradePhase | undefined, exact: ExactCounts | null, stable: number | null, keepOpen: boolean): UpgradeState {
    const phaseId = current?.id ?? "";
    const unit = Object.hasOwn(COUNTED_UNITS, phaseId) ? COUNTED_UNITS[phaseId]! : null;
    let step: Record<string, unknown> = { awakeElapsedMs: Math.round(this.awake.get(phaseId) ?? 0), unit: "none" };
    if (current && unit === "conversations" && current.total > 0) step = { ...step, unit, done: Math.floor(Math.min(current.done, current.total)), total: current.total };
    else if (current && unit === "sets" && current.total > 0) step = { ...step, unit, done: Math.min(current.done, current.total), total: current.total };
    else if (current && unit === "open") step = { ...step, unit, done: Math.floor(current.done) };
    else if (current && unit === "messages" && current.counted !== null && exact && exact.messages > 0) step = { ...step, unit, done: current.counted, total: Math.max(exact.messages, current.counted) };
    const outside = { ...UNKNOWN_OUTSIDE, ...(this.stage === "starting" ? { complete: false as Tri } : {}), ...this.outside() };
    return buildUpgradeState({
      v: 2, launch: bootLaunchId(), seq: nextUpgradeSeq(), source: "note", stage: this.stage, phase: phaseId === "" ? "none" : PHASE_IDS.includes(phaseId as never) ? phaseId : "unknown", overall: progress.overall, ...outside,
      counts: exact ? { exact: true, messages: exact.messages, conversations: exact.conversations, memoryRecords: exact.memoryRecords, firstMessageAt: exact.firstMessageAt } : { exact: false },
      keepOpen, step, eta: stable !== null ? { stable: true, ms: stable * 1000 } : { stable: false }, heartbeatAt: this.now(), progressAt: this.progressAt, blocked: null,
    });
  }
}

/** The state when there is nothing running: explicit, so a screen never reads an absence. */
export function idleUpgradeState(outside: Partial<UpgradeOutside>, now: number = Date.now()): UpgradeState {
  return buildUpgradeState({
    v: 2, launch: bootLaunchId(), seq: nextUpgradeSeq(), source: "note", stage: "idle", phase: "none", overall: 1, ...UNKNOWN_OUTSIDE, ...outside, counts: { exact: false }, keepOpen: false,
    step: { awakeElapsedMs: 0, unit: "none" }, eta: { stable: false }, heartbeatAt: now, progressAt: null, blocked: null,
  });
}
/** The state for a blocked start: the code, nothing else claimed. */
export function blockedUpgradeState(code: string, now: number = Date.now()): UpgradeState {
  return buildUpgradeState({
    v: 2, launch: bootLaunchId(), seq: nextUpgradeSeq(), source: "note", stage: "blocked", phase: "none", overall: "unknown", ...UNKNOWN_OUTSIDE, complete: false, counts: { exact: false }, keepOpen: false,
    step: { awakeElapsedMs: 0, unit: "none" }, eta: { stable: false }, heartbeatAt: now, progressAt: null, blocked: { code },
  });
}
/** The same state as another producer would send it: its own source and clock, everything else as it was. */
export function restampedUpgrade(state: UpgradeState, patch: Partial<UpgradeState>): UpgradeState { return restampUpgradeState(state, patch); }
/** What a note says when no tracker is attached yet: the start of an upgrade, nothing more claimed. */
export function startingUnknownState(now: number = Date.now()): UpgradeState {
  return unknownUpgradeState({ launch: bootLaunchId(), seq: nextUpgradeSeq(), source: "note", stage: "starting", complete: false, keepOpen: true, heartbeatAt: now });
}
