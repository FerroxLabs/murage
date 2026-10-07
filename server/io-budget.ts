// SPDX-License-Identifier: AGPL-3.0-or-later
// A disk and CPU watchdog with application byte accounting. Periodic work
// consults its source's backoff before starting. Turns, routines, user actions,
// claimed jobs and owner-requested writes always proceed; it never stops a turn.
import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { endianness } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { turnTraceEnabled } from "./turn-trace.ts";

export const IO_BUDGET_INTERVAL_MS = 60_000;
export const IO_BUDGET_BYTES_PER_MINUTE = 50 * 1024 * 1024;
export const IO_BUDGET_IDLE_BYTES_PER_MINUTE = 1024 * 1024;
export const IO_BUDGET_CPU_FRACTION = 0.8;
export const IO_BUDGET_CPU_MINUTES = 3;
export const IO_BUDGET_MAX_SCALE = 8;
/** Calm minutes in a row before the poll scale is halved back. */
export const IO_BUDGET_CALM_MINUTES = 10;
/** resourceUsage().fsWrite counts block-output operations; 512 bytes each is the unit getrusage reports in. */
const BLOCK_BYTES = 512;

/** What one reading of the process looks like. All values are cumulative. */
export interface IoReading { at: number; fsWriteBlocks: number; cpuMicros: number }
export interface StatementCost { sql: string; calls: number; ms: number }

export interface IoBudgetOptions {
  read?: () => IoReading;
  log?: (line: string) => void;
  /** Called whenever the poll scale changes. 1 = normal; 2 = half as often; and so on. */
  onScale?: (scale: number) => void;
  bytesPerMinute?: number;
  cpuFraction?: number;
  cpuMinutes?: number;
  isIdle?: () => boolean;
  onMemoryWork?: () => void;
}

export function readProcess(): IoReading {
  const usage = process.resourceUsage();
  return { at: Date.now(), fsWriteBlocks: usage.fsWrite, cpuMicros: usage.userCPUTime + usage.systemCPUTime };
}

export class IoBudget {
  private readonly read: () => IoReading;
  private readonly log: (line: string) => void;
  private onScale: (scale: number) => void;
  private readonly bytesPerMinute: number;
  private readonly cpuFraction: number;
  private readonly cpuMinutes: number;
  private last: IoReading | null = null;
  private hotCpuMinutes = 0;
  private calmMinutes = 0;
  private scale = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private statements = new Map<string, StatementCost>();
  private bytes = new Map<string, number>();
  private byteSources = new Map<string, {read: () => number; last: number}>();
  private sourceContext = new AsyncLocalStorage<string>();
  private isIdle: () => boolean;
  private onMemoryWork?: () => void;
  private deferredSource: string | null = null;
  private deferUntil = 0;
  /** Totals at the last statement-trace line, so each line is one minute's cost. */
  private traced = new Map<string, { calls: number; ms: number }>();
  private traceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: IoBudgetOptions = {}) {
    this.read = options.read ?? readProcess;
    this.log = options.log ?? ((line) => console.warn(line));
    this.onScale = options.onScale ?? (() => {});
    this.bytesPerMinute = options.bytesPerMinute ?? IO_BUDGET_BYTES_PER_MINUTE;
    this.cpuFraction = options.cpuFraction ?? IO_BUDGET_CPU_FRACTION;
    this.cpuMinutes = options.cpuMinutes ?? IO_BUDGET_CPU_MINUTES;
    this.isIdle = options.isIdle ?? (() => false);
    this.onMemoryWork = options.onMemoryWork;
  }

  /** Replace the listener told when the scale changes. */
  setOnScale(listener: (scale: number) => void): void { this.onScale = listener; }
  setIsIdle(read: () => boolean): void { this.isIdle = read; }
  setOnMemoryWork(listener: () => void): void { this.onMemoryWork = listener; }
  notifyMemoryWork(): void { try { this.onMemoryWork?.(); } catch { /* notifications do not change a write's result */ } }

  noteBytes(source: string, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.bytes.set(source, (this.bytes.get(source) ?? 0) + bytes);
  }

  /** Readers return cumulative bytes. Register once before the source starts. */
  registerByteSource(name: string, read: () => number): () => void {
    let last = 0;
    try { last = read(); } catch { /* an absent child starts at zero */ }
    const source = { read, last };
    this.byteSources.set(name, source);
    // Release what the reader holds (walFrameReader's shm descriptor) when its owner lets go,
    // even if a later registration under the same name replaced this entry in the map.
    return () => {
      if (this.byteSources.get(name) === source) this.byteSources.delete(name);
      try { (read as { close?: () => void }).close?.(); } catch { /* releasing is best effort */ }
    };
  }

  /** Observe a writer at a transaction boundary, or leave it to the minute tick. */
  sampleByteSource(name: string, attribution = name): void {
    const source = this.byteSources.get(name);
    if (!source) return;
    try {
      const current = source.read();
      if (!Number.isFinite(current) || current < 0) return;
      this.noteBytes(attribution, Math.max(0, current - source.last));
      source.last = current;
    } catch { /* a child or file may disappear between samples */ }
  }

  /** Pending application bytes in this window, including newly observed files. */
  sampleBytes(): number {
    for (const name of this.byteSources.keys()) this.sampleByteSource(name);
    return [...this.bytes.values()].reduce((sum, bytes) => sum + bytes, 0);
  }

  withSource<T>(source: string, operation: () => T): T { return this.sourceContext.run(source, operation); }
  currentSource(): string | undefined { return this.sourceContext.getStore(); }

  shouldDefer(source: string): boolean {
    if (source !== this.deferredSource || this.scale === 1) return false;
    try { return this.read().at < this.deferUntil; } catch { return false; }
  }

  /** Milliseconds until `source`'s deferral window ends (0 when it is not deferred). */
  deferredForMs(source: string): number {
    if (source !== this.deferredSource || this.scale === 1) return 0;
    try { return Math.max(0, this.deferUntil - this.read().at); } catch { return 0; }
  }

  /** 1 normally; doubles each time the budget is blown, up to 8. Pollers multiply their interval by this. */
  pollScale(): number { return this.scale; }

  /** Record one statement's cost. Cheap: a Map update. Keyed by the first 160
   *  characters of the text; pass `keyed` when the text already is that key. */
  note(sql: string, ms: number, keyed = false): void {
    const key = keyed ? sql : statementKey(sql);
    const cost = this.statements.get(key);
    if (cost) { cost.calls++; cost.ms += ms; }
    else {
      if (this.statements.size >= 500) this.statements.clear();
      this.statements.set(key, { sql: key, calls: 1, ms });
    }
  }

  topStatements(count = 3): StatementCost[] {
    return [...this.statements.values()].sort((a, b) => b.ms - a.ms).slice(0, count);
  }

  /** The statements that cost the most since the last call, as trace lines (MURAGE_TURN_TRACE=1
   *  only). Text is the statement shortened with its literals stripped; never a bound value. */
  traceTopStatements(sink: (line: string) => void = line => console.log(line), count = 5): void {
    if (!turnTraceEnabled()) return;
    const window: StatementCost[] = [];
    for (const cost of this.statements.values()) {
      const before = this.traced.get(cost.sql);
      const ms = Math.max(0, cost.ms - (before?.ms ?? 0)), calls = Math.max(0, cost.calls - (before?.calls ?? 0));
      if (calls > 0) window.push({ sql: cost.sql, calls, ms });
    }
    this.traced = new Map([...this.statements.values()].map(cost => [cost.sql, { calls: cost.calls, ms: cost.ms }]));
    window.sort((a, b) => b.ms - a.ms).slice(0, count).forEach((cost, index) =>
      sink(`[turn-trace] phase=sql.top rank=${index + 1} ms=${Math.round(cost.ms)} calls=${cost.calls} sql="${shortStatement(cost.sql)}"`));
  }

  /** Take one sample and judge the minute since the last. Returns the verdict for tests. */
  tick(): { writeBytesPerMinute: number; cpu: number; tripped: boolean; source: string | null } | null {
    let reading: IoReading;
    try { reading = this.read(); } catch { return null; }
    const previous = this.last;
    this.last = reading;
    const applicationBytes = this.sampleBytes();
    if (!previous) { this.bytes.clear(); return null; }
    if (reading.at <= previous.at) return null;
    const minutes = (reading.at - previous.at) / 60_000;
    const osBytes = Math.max(0, (reading.fsWriteBlocks - previous.fsWriteBlocks) * BLOCK_BYTES);
    const writeBytesPerMinute = Math.max(osBytes, applicationBytes) / minutes;
    const cpu = (reading.cpuMicros - previous.cpuMicros) / 1000 / (reading.at - previous.at);
    this.hotCpuMinutes = cpu > this.cpuFraction ? this.hotCpuMinutes + 1 : 0;
    let idle = false;
    try { idle = this.isIdle(); } catch { /* startup uses the active budget */ }
    const budget = idle ? IO_BUDGET_IDLE_BYTES_PER_MINUTE : this.bytesPerMinute;
    const writing = writeBytesPerMinute > budget;
    const spinning = this.hotCpuMinutes >= this.cpuMinutes;
    const tripped = writing || spinning;
    if (tripped) {
      this.calmMinutes = 0;
      const top = this.topStatements().map(cost => `${Math.round(cost.ms)}ms x${cost.calls} ${cost.sql}`).join(" | ") || "none recorded";
      const next = Math.min(IO_BUDGET_MAX_SCALE, this.scale * 2);
      this.deferredSource = [...this.bytes].sort((a,b) => b[1]-a[1])[0]?.[0] ?? this.topStatements(1)[0]?.sql ?? "process";
      this.deferUntil = reading.at + next * IO_BUDGET_INTERVAL_MS;
      this.log(`[io-budget] ${writing ? `writing ${(writeBytesPerMinute / 1048576).toFixed(1)} MB/min (budget ${(budget / 1048576).toFixed(0)})` : ""}`
        + `${writing && spinning ? ", " : ""}${spinning ? `cpu ${(cpu * 100).toFixed(0)}% for ${this.hotCpuMinutes} min` : ""}; source: ${this.deferredSource}; top statements: ${top}; poll rate x1/${next}`);
      this.setScale(next);
      this.statements.clear(); this.traced.clear();
      if (spinning) this.hotCpuMinutes = 0;
    } else if (this.scale > 1 && ++this.calmMinutes >= IO_BUDGET_CALM_MINUTES) {
      this.calmMinutes = 0;
      this.setScale(Math.max(1, this.scale / 2));
      if (this.scale === 1) this.deferredSource = null;
    }
    this.bytes.clear();
    return { writeBytesPerMinute, cpu, tripped, source: this.deferredSource };
  }

  private setScale(next: number): void {
    if (next === this.scale) return;
    this.scale = next;
    try { this.onScale(next); } catch { /* backing off is advisory */ }
  }

  start(): void {
    if (this.timer) return;
    this.last = null;
    this.tick();
    this.timer = setInterval(() => { try { this.tick(); } catch { /* a watchdog never throws into the app */ } }, IO_BUDGET_INTERVAL_MS);
    this.timer.unref?.();
    if (turnTraceEnabled() && !this.traceTimer) {
      this.traceTimer = setInterval(() => { try { this.traceTopStatements(); } catch { /* tracing never throws into the app */ } }, IO_BUDGET_INTERVAL_MS);
      this.traceTimer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.traceTimer) clearInterval(this.traceTimer);
    this.traceTimer = null;
  }
}

/** The text a statement is filed under. Done once per prepare, not per run:
 *  the Inbox projection is ten kilobytes of SQL. */
export function statementKey(sql: string): string { return sql.replace(/\s+/g, " ").trim().slice(0, 160); }

/** A statement for a trace line: literals (quoted text, numbers) replaced by ?, cut at 80 characters. */
export function shortStatement(sql: string): string {
  return statementKey(sql).replace(/[xX]'(?:[^']|'')*'|'(?:[^']|'')*'|\b\d+(?:\.\d+)?\b/g, "?").slice(0, 80);
}

/** The process-wide watchdog. index.ts starts it; database.ts feeds it. */
export const ioBudget = new IoBudget();

/** File growth is cumulative across truncation and recreation between samples.
 * Existing bytes form the baseline. In-place rewrites need explicit counters. */
export function fileGrowthReader(paths: readonly string[]): () => number {
  const size = (path: string) => { try { return statSync(path).size; } catch { return 0; } };
  const previous = paths.map(size);
  let total = 0;
  return () => {
    paths.forEach((path,index) => {
      const current = size(path);
      total += Math.max(0, current - previous[index]);
      previous[index] = current;
    });
    return total;
  };
}

/** WAL frames appended, read from the wal-index header in `<db>-shm`. A WAL
 * that has reached its working size is rewritten in place after each
 * checkpoint, so its file size stops growing while writes continue; the
 * header's frame count and salt keep counting them. Falls back to file growth
 * when the header cannot be read consistently. */
export function walFrameReader(databaseFile: string): (() => number) & { close(): void; fd(): number | undefined } {
  const growth = fileGrowthReader([`${databaseFile}-wal`]);
  // The -shm file is the one SQLite maps and takes POSIX locks on in this very
  // process. Closing ANY descriptor on a file drops every lock the process holds
  // on it, so an open/read/close here let another process run wal-index recovery
  // and truncate the shm under SQLite's live mapping (SIGBUS). Keep one read-only
  // descriptor per shm inode and never close it while that inode is current.
  const shm = `${databaseFile}-shm`;
  let held: { fd: number; ino: number | bigint; dev: number | bigint } | undefined;
  let closed = false;
  const header = (): { salt: string; frames: number; frameBytes: number } | null => {
    // After close() nothing reads or reopens a descriptor; callers fall back to WAL file growth.
    if (closed) return null;
    try {
      const now = statSync(shm);
      if (held && (held.ino !== now.ino || held.dev !== now.dev)) {
        // A different file now: the old inode is no longer SQLite's, closing it drops no live lock.
        try { closeSync(held.fd); } catch { /* already closed */ }
        held = undefined;
      }
      if (!held) held = { fd: openSync(shm, "r"), ino: now.ino, dev: now.dev };
      const raw = Buffer.alloc(96);
      if (readSync(held.fd, raw, 0, 96, 0) < 96 || !raw.subarray(0, 48).equals(raw.subarray(48, 96)) || raw[12] !== 1) return null;
      const little = endianness() === "LE";
      const page = little ? raw.readUInt16LE(14) : raw.readUInt16BE(14);
      const frames = little ? raw.readUInt32LE(16) : raw.readUInt32BE(16);
      return { salt: raw.subarray(32, 40).toString("hex"), frames, frameBytes: (page === 1 ? 65536 : page) + 24 };
    } catch { return null; }
  };
  let last = header(), total = 0, grown = growth();
  const read = () => {
    const fileBytes = growth() - grown;
    grown += fileBytes;
    const next = header();
    if (next && last) total += (next.salt === last.salt ? Math.max(0, next.frames - last.frames) : next.frames) * next.frameBytes;
    else total += fileBytes;
    if (next) last = next;
    return total;
  };
  // Call only after the database handle is closed: closing any descriptor on the shm
  // drops the process's locks on it. Idempotent; held is cleared before closing so a
  // second call cannot close a reused descriptor number.
  const close = () => {
    closed = true;
    const fd = held?.fd;
    held = undefined;
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  };
  return Object.assign(read, { close, fd: () => held?.fd });
}

/** Time every statement run through this handle, so a trip can name the culprits. */
export function instrumentDatabase(db: DatabaseSync, budget: IoBudget = ioBudget): () => void {
  const prepare = db.prepare.bind(db);
  const file = prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file;
  const source = file ? `database:${file}` : "";
  const unregister = source ? budget.registerByteSource(source, walFrameReader(String(file))) : () => {};
  let transactionSource = source;
  const sample = (name: string) => { if (source) budget.sampleByteSource(source, name); };
  const exec = db.exec.bind(db);
  db.exec = (sql: string) => {
    const inTransaction = db.isTransaction;
    if (!inTransaction) sample(source);
    exec(sql);
    if (!db.isTransaction) sample(budget.currentSource() ?? (inTransaction ? transactionSource : statementKey(sql)));
  };
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    const statement = prepare(sql);
    const key = statementKey(sql);
    const tokens = sql.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
    const writes = /\b(?:INSERT|UPDATE|REPLACE|DELETE)\b/i.test(tokens);
    const memoryWork = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\s+(?:OR\s+\w+\s+)?|REPLACE\s+INTO)\s*["`\[]?(?:main["`\]]?\s*\.\s*["`\[]?)?memory_(?:jobs|projection_receipts|scope_bindings)["`\]]?(?=\s|\(|$)/i.test(tokens);
    for (const method of ["get", "all", "run"] as const) {
      const original = statement[method].bind(statement) as (...args: unknown[]) => unknown;
      (statement as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        const started = performance.now();
        try {
          const result = original(...args);
          if (writes) {
            transactionSource = budget.currentSource() ?? key;
            if (!db.isTransaction) sample(transactionSource);
          }
          if (memoryWork && method === "run" && Number((result as {changes:number|bigint}).changes) > 0) budget.notifyMemoryWork();
          return result;
        } finally { budget.note(key, performance.now() - started, true); }
      };
    }
    return statement;
  };
  return unregister;
}
