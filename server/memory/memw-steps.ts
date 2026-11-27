// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMW (1.0.18 Part A, spec sections 1.1, 1.5, 1.8): the pure arithmetic every index write is admitted by. Nothing here opens a file
// or writes a row: the index writer (index.ts, age-index.ts) asks these functions how much one step, unit, group or merge may take,
// and the WAL core (index-wal.ts) checks afterwards that it took no more. Every figure is in bytes of write-ahead log unless named.

import { helperEnforced, helperReliefPlan } from "./helper-admission.ts";
import { FTS_SEGMENT_LIMIT } from "./segment-limit.ts";

const MiB = 1024 * 1024;
// The WAL core's constants have ONE source, index-wal.ts (the lower layer); re-exported here for index.ts and T2.
import { runtimeStepWalBytes, runtimeMergeWalBytes, MEMW_W_STEP_BYTES, MEMW_W_MERGE_BYTES, MEMW_C_BYTES, MEMW_STEP_ADMIT_BYTES, MEMW_TICK_TRUNCATE_BYTES, MEMW_SEAL_FRAMES, MEMW_HDR_RETRIES, WAL_HEADER_BYTES } from "./index-wal.ts";
export { MEMW_W_STEP_BYTES, MEMW_W_MERGE_BYTES, MEMW_C_BYTES, MEMW_STEP_ADMIT_BYTES, MEMW_TICK_TRUNCATE_BYTES, MEMW_SEAL_FRAMES, MEMW_HDR_RETRIES, WAL_HEADER_BYTES };

// 1.1 constants (re-exported by index.ts, read by T2).
export const MEMW_CALL_MS = 250;
export const MEMW_SEGMENT_GATE = 48;
export const MEMW_SEGMENT_CEILING = 80;
export const MEMW_MERGE_PAGES = 64;
export function runtimeMergePages():number {
  return Math.max(1,Math.floor(MEMW_MERGE_PAGES*runtimeMergeWalBytes()/MEMW_W_MERGE_BYTES));
}
export const MEMW_SEGMENT_READ_WRITES = 16;
export const MEMW_SEGMENT_STEP_STOP = 63;
export const MEMW_GATE_HOLD_MS = 5_000;
/** T2-measured maximum rise of the `open` txn + 10% (PIN-T2: provisional until the T2 base run pins it). */
export const MEMW_OPEN_RESERVE = 4 * MiB;
/** R_row: the per-row term of the sizer's X [r22 2.1] (T2 pins). */
export const MEMW_ROW_BYTES = 512;
/** Fixed frames an inserting / removing step or unit may add beyond its byte terms [r20 D9]. */
export const MEMW_F_INS_FRAMES = 64;
export const MEMW_F_DEL_FRAMES = 32;
export const MEMW_CHARGE_MAX_RECORDS = 65_536;
export const MEMW_K_PIN = 0.052;
/** Sizer floors (WAL bytes per input byte). DELETE: max(3.1, the T2(13) scattered-delete maximum) (PIN-T2). */
export const MEMW_FLOOR_FILL = 3.11;
export const MEMW_FLOOR_DELETE = 3.1;
export const MEMW_FLOOR_TEXTLESS = 8;
/** Unit byte multipliers R_w (written bytes) and R_d (removed stored bytes), each <= 8 (T2 pins; 8 until then). */
export const MEMW_R_W = 8;
export const MEMW_R_D = 8;
/** Groups [r22 3.3]. */
export const MEMW_GROUP_MAX_UNITS = 16;
export const MEMW_GROUP_MAX_WRITES = 32;
export const MEMW_GROUP_AIM_MS = 100;
/** D3 steps: aim per call, and the call time past which the next step of the kind is halved [r20 D3]. */
export const MEMW_STEP_AIM_MS = 100;
export const MEMW_STEP_SLOW_MS = 150;
export const MEMW_STEP_RECOVER_CALLS = 8;
export const MEMW_STEP_MAX_ROWS = 16_384;
export const MEMW_KEYS_MAX_ROWS = 50_000;
/** Sizer history length (steps, groups, merges). */
export const MEMW_HISTORY = 8;

/** The remedy line sets [r22 3.8]: a BUILD-TIME choice, never run time. Level 0 ships; C, the merge line, W_merge and N never halve. */
export const MEMW_REMEDY_LEVEL: 0 | 1 | 2 = 0;
export interface MemwLines { tickTruncate: number; stepAdmit: number; wStep: number; controllerRecords: number; c: number; mergeAdmit: number; wMerge: number; mergePages: number; sealAfterMerge: boolean }
export function memwLines(level: 0 | 1 | 2 = MEMW_REMEDY_LEVEL): MemwLines {
  const d = 2 ** level;
  return { tickTruncate: MEMW_TICK_TRUNCATE_BYTES / d, stepAdmit: MEMW_STEP_ADMIT_BYTES / d, wStep: runtimeStepWalBytes() / d, controllerRecords: 16 / d,
    c: MEMW_C_BYTES, mergeAdmit: MEMW_STEP_ADMIT_BYTES, wMerge: runtimeMergeWalBytes(), mergePages: runtimeMergePages(), sealAfterMerge: level > 0 };
}

/** One frame of the log: page plus its 24-byte frame header. */
export const frameBytes = (pageSize: number) => pageSize + 24;
/** Log length for `log` frames [r20 D9 MEASURE]. */
export const walLength = (log: number, pageSize: number) => WAL_HEADER_BYTES + log * frameBytes(pageSize);
/** S: the slack every admission keeps, 4 frames. */
export const admitSlack = (pageSize: number) => 4 * frameBytes(pageSize);
/** The tier ceiling: C - 32 B - F_del [r22 3.2b]. 27.87 MiB at 4 KiB pages. */
export const tierCeiling = (pageSize: number) => MEMW_C_BYTES - WAL_HEADER_BYTES - MEMW_F_DEL_FRAMES * frameBytes(pageSize);

export const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

// 1.5 sizer for D3 steps -----------------------------------------------------------------------------------------------------------

export type StepKind = "fill" | "keys" | "stage_drop" | "delete";
const FLOOR: Record<StepKind, number> = { fill: MEMW_FLOOR_FILL, delete: MEMW_FLOOR_DELETE, keys: MEMW_FLOOR_TEXTLESS, stage_drop: MEMW_FLOOR_TEXTLESS };
/** F_k: inserting kinds carry F_ins, removing kinds F_del. */
export const stepFixedFrames = (kind: StepKind) => (kind === "fill" || kind === "keys" ? MEMW_F_INS_FRAMES : MEMW_F_DEL_FRAMES);
/** mult_k = min(2^k, 8) after the k-th reset for the kind that overran; computed from the shipped base each time, never compounded [r32 A13]. */
export const resetMultiplier = (resets: number) => (resets <= 0 ? 1 : Math.min(2 ** resets, 8));
/** OVERRUN_K_UNKNOWN (shared with WP3): a missing index_overrun row or a missing/bad overrun_k value reads as k = 3, multiplier 8. index_meta `overrun_k:<kind>` (written by handleReset in the `open` txn; 0 written by the open txn when absent). A missing or bad
 * value is the most conservative k: multiplier 8. */
export const OVERRUN_K_UNKNOWN = 3;
export function overrunK(value: string | null | undefined): number {
  if (value === null || value === undefined || !/^\d+$/.test(value)) return OVERRUN_K_UNKNOWN;
  return Number(value);
}
/** X of one row: UTF-8 bytes of text+id+scope + R_row; textless rows: key bytes + R_row. */
export const rowX = (row: { text?: string; id: string; scope?: string }, textless = false) =>
  (textless ? utf8(row.id) : utf8(row.text ?? "") + utf8(row.id) + utf8(row.scope ?? "")) + MEMW_ROW_BYTES;

/** What one committed step reports (F9 evidence: every step logs these). */
export interface StepRecord { kind: StepKind; x: number; rows: number; predictedFrames: number; actualFrames: number; rise: number; ms: number; perRowTerm: number; metaTerm: number; inputBytes: number }

/** Sizer state for one helper run: the last 8 steps per kind, the first-step quarter, the time halving. */
export class StepSizer {
  private history = new Map<StepKind, StepRecord[]>();
  private started = new Set<StepKind>();
  private timeFactor = new Map<StepKind, number>();
  private fastRun = new Map<StepKind, number>();
  readonly pageSize: number; private readonly resets: (kind: StepKind) => number; readonly w: number;
  constructor(pageSize: number, resets: (kind: StepKind) => number = () => 0, w: number = memwLines().wStep) { this.pageSize = pageSize; this.resets = resets; this.w = w; }
  /** rho_k = max(floor_k x mult_k, max over last 8 steps of (rise - F_k)/X). */
  rho(kind: StepKind): number {
    const fk = stepFixedFrames(kind) * frameBytes(this.pageSize);
    let rho = FLOOR[kind] * resetMultiplier(this.resets(kind));
    for (const s of this.history.get(kind) ?? []) if (s.x > 0) rho = Math.max(rho, (s.rise - fk) / s.x);
    return rho;
  }
  /** X_budget = (0.8 x W - F_k)/rho_k, quartered on the kind's first step after open, halved per slow call. */
  budget(kind: StepKind): number {
    const fk = stepFixedFrames(kind) * frameBytes(this.pageSize);
    let x = (0.8 * this.w - fk) / this.rho(kind);
    if (!this.started.has(kind)) x /= 4;
    x *= this.timeFactor.get(kind) ?? 1;
    return Math.max(0, x);
  }
  maxRows(kind: StepKind): number { return kind === "keys" ? MEMW_KEYS_MAX_ROWS : MEMW_STEP_MAX_ROWS; }
  /** Take rows while the running X stays within the budget; the crossing row is deferred unless it is the first; never < 1 row. */
  take<R>(kind: StepKind, rows: Iterable<R>, xOf: (row: R) => number): { rows: R[]; x: number; budget: number } {
    const budget = this.budget(kind), cap = this.maxRows(kind), out: R[] = [];
    let x = 0;
    for (const row of rows) {
      if (out.length >= cap) break;
      const rx = xOf(row);
      if (out.length && x + rx > budget) break;
      out.push(row); x += rx;
    }
    return { rows: out, x, budget };
  }
  /** Predicted WAL bytes of a step of X: F_k + rho x X. */
  predict(kind: StepKind, x: number): { bytes: number; frames: number; metaTerm: number; perRowTerm: (rows: number) => number } {
    const fz = frameBytes(this.pageSize), fk = stepFixedFrames(kind) * fz, rho = this.rho(kind);
    const bytes = fk + rho * x;
    return { bytes, frames: Math.ceil(bytes / fz), metaTerm: fk, perRowTerm: rows => rows * MEMW_ROW_BYTES * rho };
  }
  /** Records a committed step: history, first-step flag, the time halving (> 150 ms halves; <= 100 ms lifts back toward 1). */
  record(kind: StepKind, step: { x: number; rows: number; rise: number; ms: number; inputBytes?: number }): StepRecord {
    const p = this.predict(kind, step.x), fz = frameBytes(this.pageSize);
    const rec: StepRecord = { kind, x: step.x, rows: step.rows, predictedFrames: p.frames, actualFrames: Math.ceil(step.rise / fz), rise: step.rise, ms: step.ms,
      perRowTerm: p.perRowTerm(step.rows), metaTerm: p.metaTerm, inputBytes: step.inputBytes ?? step.x - step.rows * MEMW_ROW_BYTES };
    const h = this.history.get(kind) ?? [];
    h.push(rec); if (h.length > MEMW_HISTORY) h.shift();
    this.history.set(kind, h);
    this.started.add(kind);
    // r20 D3 + MEMW owner ruling (11-08): halve after any call > 150 ms; double back toward 1 (capped) only after 8 CONSECUTIVE calls
    // <= 100 ms; any call > 100 ms resets the run (hysteresis: no oscillation).
    const f = this.timeFactor.get(kind) ?? 1;
    if (step.ms > MEMW_STEP_AIM_MS) this.fastRun.set(kind, 0);
    if (step.ms > MEMW_STEP_SLOW_MS) this.timeFactor.set(kind, Math.max(1 / 1024, f / 2));
    else if (step.ms <= MEMW_STEP_AIM_MS) {
      const run = (this.fastRun.get(kind) ?? 0) + 1;
      if (run >= MEMW_STEP_RECOVER_CALLS && f < 1) { this.timeFactor.set(kind, Math.min(1, f * 2)); this.fastRun.set(kind, 0); }
      else this.fastRun.set(kind, run);
    }
    return rec;
  }
  last(kind: StepKind): readonly StepRecord[] { return this.history.get(kind) ?? []; }
}

// 1.5 units and groups -------------------------------------------------------------------------------------------------------------

/** One record of a batch as the group former sees it. `stored`: the stored row's id+scope_id+text bytes (read by PK in the unit), 0 if absent. */
export interface UnitInput { id: string; scopeId: string; text: string; deleted: boolean; stored: number }
/** writes(u,t) per FTS table, against the current txn state: previous row, squatter delete, insert, squatter re-insert (<= 4). */
export interface UnitWrites { previous: boolean; squatter: boolean; insert: boolean; squatterReinsert: boolean }
export const writesOf = (w: UnitWrites) => Number(w.previous) + Number(w.squatter) + Number(w.insert) + Number(w.squatterReinsert);
/** Unit cost [r20 D9][r21 3.3]: bytes(new) x R_w + bytes(stored) x R_d + F_ins (inserts) + F_del (removes). */
export function unitCost(u: UnitInput, pageSize: number, inserts = !u.deleted, removes = u.stored > 0 || u.deleted): number {
  const fz = frameBytes(pageSize);
  const written = u.deleted ? 0 : utf8(u.id) + utf8(u.scopeId) + utf8(u.text);
  return written * MEMW_R_W + u.stored * MEMW_R_D + (inserts ? MEMW_F_INS_FRAMES * fz : 0) + (removes ? MEMW_F_DEL_FRAMES * fz : 0);
}
export interface GroupUnit { cost: number; writes: Record<string, number> }
/** Forms the next group from units[from..]: longest run, <= 16 units, sum writes <= 32 per table, L + sum(cost) + S <= C, predicted time
 * <= 100 ms; never < 1 unit. `fitsAlone` false: the first unit does not fit even alone (DRAIN, 1.11). */
export function formGroup(units: readonly GroupUnit[], from: number, state: { L: number; pageSize: number; msPerCostByte: number; c?: number }): { count: number; cost: number; fitsAlone: boolean } {
  const c = state.c ?? MEMW_C_BYTES, s = admitSlack(state.pageSize);
  let count = 0, cost = 0;
  const writes = new Map<string, number>();
  for (let i = from; i < units.length && count < MEMW_GROUP_MAX_UNITS; i++) {
    const u = units[i];
    const nextCost = cost + u.cost;
    let over = state.L + nextCost + s > c || (helperEnforced()&&nextCost>runtimeStepWalBytes(state.pageSize)&&!(count===0&&helperReliefPlan()));
    for (const [t, n] of Object.entries(u.writes)) if ((writes.get(t) ?? 0) + n > MEMW_GROUP_MAX_WRITES) over = true;
    if (count && state.msPerCostByte * nextCost > MEMW_GROUP_AIM_MS) over = true;
    if (over) { if (!count) return { count: 0, cost: 0, fitsAlone: false }; break; }
    count++; cost = nextCost;
    for (const [t, n] of Object.entries(u.writes)) writes.set(t, (writes.get(t) ?? 0) + n);
  }
  return { count, cost, fitsAlone: count > 0 };
}
/** Row-work ms per cost byte: the max over the last 8 groups. Fixed transaction I/O is not row work. */
export class GroupClock {
  private h: number[] = [];
  record(ms: number, cost: number) { if (cost > 0) { this.h.push(ms / cost); if (this.h.length > MEMW_HISTORY) this.h.shift(); } }
  msPerCostByte(): number { return this.h.length ? Math.max(...this.h) : 0; }
}

// 1.5 admission ------------------------------------------------------------------------------------------------------------------

export type AdmitKind = "group" | "fill" | "keys" | "stage_drop" | "delete" | "merge" | "tier" | "seal" | "open" | "stop";
/** Admission of a non-seal txn: no batch held (except R1 maintenance), no drain, L + reserve + S <= C; fill/delete/textless/units and
 * merges also L <= 16 MiB; tier only at L = 32 B (1.8 O2). Pure: the IndexWal applies the same rule (WP1); WP2 asks before sizing. */
export function admits(kind: AdmitKind, reserve: number, st: { L: number; pageSize: number; held?: boolean; drain?: boolean; maintenance?: boolean; lines?: MemwLines }): boolean {
  if (kind === "seal") return true;
  const lines = st.lines ?? memwLines();
  if (st.drain) return false;
  if (st.held && !st.maintenance) return false;
  if (kind === "tier") return st.L <= WAL_HEADER_BYTES && reserve <= tierCeiling(st.pageSize);
  if (st.L + reserve + admitSlack(st.pageSize) > lines.c) return false;
  if (kind === "merge") return st.L <= lines.mergeAdmit;
  if (kind === "fill" || kind === "keys" || kind === "stage_drop" || kind === "delete" || kind === "group") return st.L <= lines.stepAdmit;
  return true;
}

// 1.5 segments ---------------------------------------------------------------------------------------------------------------------

/** The segment count from an FTS5 structure record (`<table>_data` id=10): cookie, optional version marker, varint levels, varint segments. */
export function structureSegments(bytes: Uint8Array | null | undefined): number | null {
  if (!bytes) return null;
  let at = 4;
  if (bytes[at] === 0xff && bytes[at + 1] === 0 && bytes[at + 2] === 0 && bytes[at + 3] === 1) at += 4;
  const varint = (): number | null => { let value = 0; for (let n = 0; n < 8 && at < bytes.length; n++) { const b = bytes[at++]; value = value * 128 + (b & 0x7f); if (!(b & 0x80)) return value; } return null; };
  if (varint() === null) return null;
  return varint();
}
/** Input leaf pages of the next merge. SQLite's fixed segment limit bounds this walk, including inherited files above the new-write ceiling. */
export function structureMergePages(bytes: Uint8Array | null | undefined): number | null {
  if (!bytes || bytes.length < 7) return null;
  const v2 = bytes[4] === 0xff && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 1;
  let at = v2 ? 8 : 4;
  const next = (): number | null => {
    let value = 0;
    for (let n = 0; n < 9; n++) {
      if (at >= bytes.length) return null;
      const b = bytes[at++];
      value = value * (n === 8 ? 256 : 128) + (n === 8 ? b : b & 127);
      if (!Number.isSafeInteger(value)) return null;
      if (n === 8 || b < 128) return value;
    }
    return null;
  };
  const levels = next(), total = next(), writes = next();
  if (levels === null || total === null || writes === null || levels >= FTS_SEGMENT_LIMIT || total >= FTS_SEGMENT_LIMIT) return null;
  let seen = 0, largest = 0, chosen = 0, merging: number | null = null;
  for (let level = 0; level < levels; level++) {
    const merge = next(), count = next();
    if (merge === null || count === null || merge > count || seen + count > total) return null;
    let pages = 0, activePages = 0;
    for (let s = 0; s < count; s++) {
      const id = next(), first = next(), last = next();
      if (id === null || first === null || last === null || last < first) return null;
      const n = first === 0 ? 0 : last - first + 1;
      pages += n;
      if (s < merge) activePages += n;
      if (v2) for (let k = 0; k < 5; k++) if (next() === null) return null;
    }
    seen += count;
    if (merge > 0 && merging === null) merging = activePages;
    if (count > largest) { largest = count; chosen = pages; }
  }
  return seen === total ? merging ?? chosen : null;
}
/** No group and no non-merge step starts while any written table holds > 48. */
export const segmentGateOpen = (counts: Iterable<number>) => { for (const n of counts) if (n > MEMW_SEGMENT_GATE) return false; return true; };
/** D3 steps: re-read the structure every 16 FTS row writes; end the step at a read showing >= 63 (bound 79). */
export class SegmentWatch {
  private writes = 0;
  stopped = false;
  private readonly read: () => number;
  constructor(read: () => number) { this.read = read; }
  /** Call after each FTS row write; true while the step may write on. */
  wrote(n = 1): boolean {
    this.writes += n;
    if (this.writes >= MEMW_SEGMENT_READ_WRITES) { this.writes = 0; if (this.read() >= MEMW_SEGMENT_STEP_STOP) this.stopped = true; }
    return !this.stopped;
  }
}

// The writer seam ----------------------------------------------------------------------------------------------------------------

/** The part of index-wal.ts IndexWal (spec 4, r3.2.2 D1) the index writer uses: write() is sync and leaves a check owed; check() is
 * awaited after every write. MemoryIndex takes the real one (index-wal.ts IndexWalWriter). */
export interface IndexWriter {
  readonly pageSize: number; readonly stopped: boolean;
  L(): number; admit(kind: AdmitKind, reserve: number): boolean;
  write<T>(kind: AdmitKind, reserve: number, body: (meta: (key: string, value: string) => void) => T): T;
  checkOwed(): boolean; check(): Promise<void>; sealAndTruncate(): Promise<{ truncated: boolean }>; prepareExit(): Promise<import("./index-wal.ts").ExitSealOutcome>;
}
// 1.8 merges and tier --------------------------------------------------------------------------------------------------------------

/** pred = k_t x T_t + 2 x 64 frames; k_t = max(K_PIN x mult, max last-8 rise/T_t). */
export class MergePredictor {
  private h = new Map<string, number[]>();
  private pageHistory = new Map<string, number[]>();
  readonly pageSize: number; private readonly resets: () => number;
  constructor(pageSize: number, resets: () => number = () => 0) { this.pageSize = pageSize; this.resets = resets; }
  k(table: string): number {
    let k = MEMW_K_PIN * resetMultiplier(this.resets());
    for (const r of this.h.get(table) ?? []) k = Math.max(k, r);
    return k;
  }
  pred(table: string, textBytes: number, inputPages?: number): number {
    const text = this.k(table) * textBytes + 2 * MEMW_MERGE_PAGES * frameBytes(this.pageSize);
    if (inputPages === undefined) return text;
    const rate = Math.max(2, ...this.pageHistory.get(table) ?? []);
    return Math.max(text, (rate * inputPages + 2 * MEMW_MERGE_PAGES + 16) * frameBytes(this.pageSize));
  }
  record(table: string, rise: number, textBytes: number, inputPages = 0) {
    if (inputPages > 0) {
      const h = this.pageHistory.get(table) ?? [];
      h.push(rise / frameBytes(this.pageSize) / inputPages);
      if (h.length > MEMW_HISTORY) h.shift();
      this.pageHistory.set(table, h);
    }
    if (textBytes <= 0) return;
    const h = this.h.get(table) ?? []; h.push(rise / textBytes); if (h.length > MEMW_HISTORY) h.shift(); this.h.set(table, h);
  }
}
/** O1 admit at <= 12 MiB; O2/O3 tier at <= C - 32 - F_del; O4 floor beyond. */
export function mergeRoute(pred: number, pageSize: number, wMerge = MEMW_W_MERGE_BYTES): "merge" | "tier" | "floor" {
  if (pred <= wMerge) return "merge";
  if (pred <= tierCeiling(pageSize)) return "tier";
  return "floor";
}
/** Gate hold R1: maintenance merges while elapsed + 250 + 2 x 250 ms <= 5,000 ms. */
export const gateHoldMayMerge = (elapsedMs: number) => elapsedMs + MEMW_CALL_MS + 2 * MEMW_CALL_MS <= MEMW_GATE_HOLD_MS;
