// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-scan and per-day resource budgets for the Sentinel scanner (1.0.9, GAP-SENTINEL-109 section 9).
//
// ScanBudget is the cooperative arbiter for one scan: descriptor-listed files, stat operations, read bytes, records,
// sealed-stats queries and rows, plus scanner CPU (250 ms) and RSS (128 MiB). Every reader asks before it spends and
// stops at the first refusal; what it could not read is reported as an omitted interval, never as an observed zero.
// The separate 5 s wall deadline belongs to the supervisor (a stuck synchronous call cannot check a budget).
//
// WriteBucket is the rolling-24h output write token bucket: 32 MiB capacity refilling continuously over 24 h, with the
// last 64 KiB reserved for an unavailable/budget status. A normal commit may not dip into the reserve.
import { HEALTH_LIMITS } from "../../shared/health-protocol.mjs";

export type BudgetResource = "files" | "stats" | "bytes" | "records" | "queries" | "rows" | "cpu" | "rss";

export interface ScanBudgetOptions {
  /** Process CPU used so far in microseconds (user + system). Injectable for tests. */
  cpuMicros?: () => number;
  /** Resident set size in bytes. Injectable for tests. */
  rssBytes?: () => number;
  limits?: Partial<ScanLimits>;
}

export interface ScanLimits {
  files: number; stats: number; bytes: number; chunkBytes: number; records: number; queries: number; rows: number; cpuMs: number; rssBytes: number;
}

export const SCAN_LIMITS: Readonly<ScanLimits> = Object.freeze({
  files: HEALTH_LIMITS.inputFilesPerScan,
  stats: HEALTH_LIMITS.statOpsPerScan,
  bytes: HEALTH_LIMITS.readBytesPerScan,
  chunkBytes: HEALTH_LIMITS.readChunkBytes,
  records: HEALTH_LIMITS.recordsPerScan,
  queries: HEALTH_LIMITS.statsQueriesPerScan,
  rows: HEALTH_LIMITS.statsRowsPerScan,
  cpuMs: HEALTH_LIMITS.scanCpuMs,
  rssBytes: HEALTH_LIMITS.scanRssBytes,
});

const defaultCpu = () => { const usage = process.cpuUsage(); return usage.user + usage.system; };
const defaultRss = () => process.memoryUsage.rss();

/** One scan's cooperative budget. Every `take*` answers false once the resource is spent; the first refusal is kept as
 * `stopReason` so the scan can report which limit it met. */
export class ScanBudget {
  readonly limits: ScanLimits;
  private readonly cpu: () => number;
  private readonly rss: () => number;
  private readonly cpuStart: number;
  readonly used = { files: 0, stats: 0, bytes: 0, records: 0, queries: 0, rows: 0 };
  stopReason: BudgetResource | null = null;

  constructor(options: ScanBudgetOptions = {}) {
    this.limits = { ...SCAN_LIMITS, ...(options.limits ?? {}) };
    this.cpu = options.cpuMicros ?? defaultCpu;
    this.rss = options.rssBytes ?? defaultRss;
    this.cpuStart = this.cpu();
  }

  private refuse(resource: BudgetResource): false {
    if (this.stopReason === null) this.stopReason = resource;
    return false;
  }

  private take(resource: "files" | "stats" | "records" | "queries" | "rows", amount = 1): boolean {
    if (this.used[resource] + amount > this.limits[resource]) return this.refuse(resource);
    this.used[resource] += amount;
    return true;
  }

  takeFile(): boolean { return this.take("files"); }
  takeStat(count = 1): boolean { return this.take("stats", count); }
  takeRecord(): boolean { return this.take("records"); }
  takeQuery(): boolean { return this.take("queries"); }
  takeRows(count: number): boolean { return this.take("rows", count); }

  /** Bytes still readable this scan, capped at one chunk. */
  chunkAllowance(): number { return Math.max(0, Math.min(this.limits.chunkBytes, this.limits.bytes - this.used.bytes)); }
  /** Charges bytes actually read. Answers false (and records the stop) once the scan total is reached. */
  chargeBytes(count: number): boolean {
    this.used.bytes += Math.max(0, count);
    if (this.used.bytes >= this.limits.bytes) { this.refuse("bytes"); return this.used.bytes <= this.limits.bytes; }
    return true;
  }
  get bytesLeft(): number { return Math.max(0, this.limits.bytes - this.used.bytes); }

  /** CPU and RSS check: false once either ceiling is reached (stop cooperatively). */
  withinRuntime(): boolean {
    if ((this.cpu() - this.cpuStart) / 1000 >= this.limits.cpuMs) return this.refuse("cpu");
    if (this.rss() >= this.limits.rssBytes) return this.refuse("rss");
    return true;
  }

  get exhausted(): boolean { return this.stopReason !== null; }
}

// ---------------------------------------------------------------------------
// Rolling-24h write ledger
// ---------------------------------------------------------------------------

export const DAY_MS = 24 * 60 * 60_000;
export const HOUR_MS = 60 * 60_000;
/** Hour slots kept: the current hour and the 23 before it. */
export const LEDGER_HOURS = 24;

/** Persisted spend per UTC hour: [hourIndex, bytes] pairs, at most LEDGER_HOURS + 1 of them. Every byte charged counts
 * against the 32 MiB ceiling for the next 24 to 25 hours, so no rolling day can ever spend more than the ceiling (a
 * continuously refilled token bucket would allow up to twice that). */
export interface WriteBucketState { hours: ReadonlyArray<readonly [number, number]> }

export const fullBucket = (_now: number): WriteBucketState => ({ hours: [] });

const hourOf = (t: number) => Math.floor(t / HOUR_MS);
/** Slots that still count at `now`: the last 24 hours, and any hour from a clock that later moved backwards. */
const live = (state: WriteBucketState, now: number) => state.hours.filter(([hour]) => hour > hourOf(now) - LEDGER_HOURS);

/** Bytes charged in the rolling 24 hours ending now. */
export function spentInDay(state: WriteBucketState, now: number): number {
  return live(state, now).reduce((total, [, bytes]) => total + bytes, 0);
}

/** Can `bytes` be charged now? A normal write must leave the 64 KiB reserve; a status write may use it. */
export function canCharge(state: WriteBucketState, bytes: number, now: number, useReserve = false): boolean {
  const ceiling = HEALTH_LIMITS.outputHardBytesPerDay - (useReserve ? 0 : HEALTH_LIMITS.outputReserveBytes);
  return spentInDay(state, now) + Math.max(0, bytes) <= ceiling;
}

/** Charges `bytes` to the current hour. The caller has checked canCharge. */
export function charge(state: WriteBucketState, bytes: number, now: number): WriteBucketState {
  const hour = hourOf(now);
  const hours = live(state, now).map(([h, b]) => [h, b] as [number, number]);
  const slot = hours.find(([h]) => h === hour);
  if (slot) slot[1] += Math.max(0, bytes);
  else hours.push([hour, Math.max(0, bytes)]);
  hours.sort((a, b) => a[0] - b[0]);
  return { hours: hours.slice(-(LEDGER_HOURS + 1)) };
}

/** The stored ledger. A stored token bucket from an earlier build counts what it had spent against its hour; anything
 * malformed reads as nothing spent. */
export function parseBucket(value: unknown, now: number): WriteBucketState {
  const v = value as { hours?: unknown; tokens?: unknown; at?: unknown } | null;
  if (v && Array.isArray(v.hours)) {
    const hours = v.hours.filter((pair): pair is [number, number] => Array.isArray(pair) && pair.length === 2 && pair.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0))
      .map(([h, b]) => [Math.floor(h), Math.min(HEALTH_LIMITS.outputHardBytesPerDay, b)] as [number, number]);
    return { hours: live({ hours }, now).sort((a, b) => a[0] - b[0]).slice(-(LEDGER_HOURS + 1)) };
  }
  if (v && typeof v.tokens === "number" && typeof v.at === "number" && Number.isFinite(v.tokens) && Number.isFinite(v.at)) {
    const spent = HEALTH_LIMITS.outputHardBytesPerDay - Math.min(HEALTH_LIMITS.outputHardBytesPerDay, Math.max(0, v.tokens));
    return spent > 0 ? { hours: live({ hours: [[hourOf(v.at), spent]] }, now) } : fullBucket(now);
  }
  return fullBucket(now);
}
