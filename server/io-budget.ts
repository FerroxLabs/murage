// SPDX-License-Identifier: AGPL-3.0-or-later
// A disk and CPU watchdog with application byte accounting. Periodic work
// consults its source's backoff before starting. Turns, routines, user actions,
// claimed jobs and owner-requested writes always proceed; it never stops a turn.
// CPU is judged on the whole computer too (system-load.ts: load average and all
// cores busy, children and other apps included), not only Murage's own process.
import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { endianness } from "node:os";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { turnTraceEnabled } from "./turn-trace.ts";
import { activeTaskName, oldestLongOp, rateLimited, reportSlowSql, SLOW_SQL_MS } from "./observe.ts";
import { systemLoad } from "./system-load.ts";

export const IO_BUDGET_INTERVAL_MS = 60_000;
export const IO_BUDGET_BYTES_PER_MINUTE = 50 * 1024 * 1024;
export const IO_BUDGET_IDLE_BYTES_PER_MINUTE = 1024 * 1024;
export const IO_BUDGET_CPU_FRACTION = 0.8;
export const IO_BUDGET_CPU_MINUTES = 3;
export const IO_BUDGET_MAX_SCALE = 8;
/** Calm minutes in a row before the poll scale is halved back. */
export const IO_BUDGET_CALM_MINUTES = 10;
/** resourceUsage().fsWrite counts block-output operations; 512 bytes each is the unit getrusage reports in. (The memory helper
 * reports its own fsWrite count to its controller, which charges it here in the same unit.) */
export const BLOCK_BYTES = 512;

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
  /** The whole computer is overloaded (default: the system-load sampler, which reads nothing until started). */
  systemOverloaded?: () => { overloaded: boolean; why: string } | null;
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
  private systemOverloaded: () => { overloaded: boolean; why: string } | null;
  private deferredSource: string | null = null;
  private deferUntil = 0;
  /** Bytes written in the last minute under a budget of their own (the revoke marker's, revoke-budget.ts): planned, capped there, and
   *  taken off the minute's writes before the verdict, so a walk at its allowance is not reported as a fault and punished with a slower poll
   *  rate for everything else (SELF-OVERLOAD-105 item 1b). */
  private plannedBytes: (() => number) | null = null;
  /** The most the planned reader is believed for in one minute: its own budget plus a margin. A reader that claims more hides nothing. */
  private plannedCap = Number.POSITIVE_INFINITY;
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
    this.systemOverloaded = options.systemOverloaded ?? (() => systemLoad.reading());
  }

  /** Replace the listener told when the scale changes. */
  setOnScale(listener: (scale: number) => void): void { this.onScale = listener; }
  setIsIdle(read: () => boolean): void { this.isIdle = read; }
  setOnMemoryWork(listener: () => void): void { this.onMemoryWork = listener; }
  /** A reader of the bytes a writer with its own budget wrote in the last minute (null: none), and the most it is believed for (its budget
   *  plus a margin): the exemption is for a writer that keeps to its plan, never a blank cheque. */
  setPlannedBytes(read: (() => number) | null, capBytesPerMinute = Number.POSITIVE_INFINITY): void { this.plannedBytes = read; this.plannedCap = capBytesPerMinute > 0 ? capBytesPerMinute : Number.POSITIVE_INFINITY; }
  notifyMemoryWork(): void { try { this.onMemoryWork?.(); } catch { /* notifications do not change a write's result */ } }

  noteBytes(source: string, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.bytes.set(source, (this.bytes.get(source) ?? 0) + bytes);
  }

  /** Bytes charged to `source` in the current minute so far (tests and diagnostics; the tick reads and clears them). */
  pendingBytes(source: string): number { return this.bytes.get(source) ?? 0; }

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

  /** A source for the synchronous part of a call only (withSyncSource); an inner withSource takes over while it runs. */
  private syncSource: string | undefined;
  withSource<T>(source: string, operation: () => T): T {
    const outer = this.syncSource;
    this.syncSource = undefined;
    try { return this.sourceContext.run(source, operation); } finally { this.syncSource = outer; }
  }
  /** Names the SYNCHRONOUS part of `operation` only: the timers and promises it starts do not inherit the source (an after-listen step
   *  starts long-lived loops, whose later slices must keep their own source, or none). */
  withSyncSource<T>(source: string, operation: () => T): T {
    const outer = this.syncSource;
    this.syncSource = source;
    try { return operation(); } finally { this.syncSource = outer; }
  }
  currentSource(): string | undefined { return this.syncSource ?? this.sourceContext.getStore(); }

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
    if (keyed && ms > SLOW_SQL_MS) reportSlowSql(shortStatement(key), ms, this.currentSource() ?? statementSource(key) ?? (key.startsWith(EXEC_PREFIX) ? execSource(key.slice(EXEC_PREFIX.length)) : undefined) ?? unclaimedStatementSource());
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
    let planned = 0;
    if (this.plannedBytes) { try { planned = Math.min(this.plannedCap * minutes, Math.max(0, Number(this.plannedBytes()) || 0)); } catch { planned = 0; } }
    const writeBytesPerMinute = Math.max(0, Math.max(osBytes, applicationBytes) - planned) / minutes;
    const cpu = (reading.cpuMicros - previous.cpuMicros) / 1000 / (reading.at - previous.at);
    let system: { overloaded: boolean; why: string } | null = null;
    try { system = this.systemOverloaded(); } catch { /* unknown load: Murage's own CPU decides */ }
    const systemHot = system?.overloaded === true;
    this.hotCpuMinutes = cpu > this.cpuFraction || systemHot ? this.hotCpuMinutes + 1 : 0;
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
      this.log(`[io-budget] ${writing ? `writing ${(writeBytesPerMinute / 1048576).toFixed(1)} MB/min (budget ${(budget / 1048576).toFixed(0)}${planned > 0 ? `, ${(planned / minutes / 1048576).toFixed(1)} MB/min planned not counted` : ""})` : ""}`
        + `${writing && spinning ? ", " : ""}${spinning ? `cpu ${(cpu * 100).toFixed(0)}%${systemHot ? ` (computer: ${system!.why})` : ""} for ${this.hotCpuMinutes} min` : ""}; source: ${this.deferredSource}; top statements: ${top}; poll rate x1/${next}`);
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

/** The lineage checks (memory/replay-lineage.ts) run for whichever caller asks, under no source of their own.
 *  Their statements are known by the tables only they read, so a slow one is reported as `lineage`. */
const LINEAGE_SQL = /\b(?:memory_disclosure_outputs|memory_output_roots|memory_session_roots|memory_root_set\w*|lineage_(?:dirty|epoch|structure))\b|^WITH (?:RECURSIVE )?direct\(b\)/i;
/** The source a statement with no source of its own is reported under, when its text says. */
export function statementSource(key: string): string | undefined { return LINEAGE_SQL.test(key) ? "lineage" : undefined; }

/** The source a request's statements are filed under: `route:<METHOD> <path>`, with id-like segments (long, or holding a digit) as `:id`, cut at 80 characters. */
export function routeSource(method: string | undefined, url: string | undefined): string {
  const path = (url ?? "/").split(/[?#]/)[0].split("/").map(part => (part.length > 24 || /\d/.test(part) ? ":id" : part)).join("/");
  return `route:${method ?? "GET"} ${path}`.slice(0, 80);
}
/** The label of a db.exec: its first words, with literals gone, so a long DDL, checkpoint or backfill names itself in the stall log. */
const EXEC_PREFIX = "exec: ";
export function execSource(sql: string): string { return `exec:${shortStatement(sql).slice(0, 40)}`; }

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

// The lock wait each handle runs with now (database.ts setBusy keeps it). A statement that waited on the write lock with no budget below the
// handle's default is the bug the stall work hunts (database.ts invariant 4): it is named, with its caller, by `[sqlite] busy ... budget=none`.
const busyNow = new WeakMap<object, number>();
export function noteBusyTimeout(db: object, ms: number): void { busyNow.set(db, ms); }
/** The lock wait (ms) the handle has now; undefined for a handle database.ts never set. */
export function currentBusy(db: object): number | undefined { return busyNow.get(db); }
interface BusyWitness { defaultMs: number; /** the background wait (BACKGROUND_BUSY_MS) */ holdMs: number; held: () => boolean; /** the ambient source is a background one (db-busy.ts BACKGROUND_SOURCES) */ background: () => boolean; transactionEnded: (db: object) => void }
let busyWitness: BusyWitness | null = null;
/** database.ts registers what the witness needs from it (the default wait, whether a writer hold is in force, the end-of-transaction hook). */
export function setBusyWitness(witness: BusyWitness): void { busyWitness = witness; }
const BEGIN_WRITE = /^\s*BEGIN\s+(?:IMMEDIATE|EXCLUSIVE)\b/i;
const END_TRANSACTION = /^\s*(?:COMMIT|END|ROLLBACK)\b(?!\s+TO\b)/i;
const isBusyFailure = (error: unknown): boolean => {
  const e = error as { errcode?: unknown; message?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (typeof e.errcode === "number" && (e.errcode & 0xff) === 5) return true;
  return typeof e.message === "string" && /database is locked|SQLITE_BUSY/i.test(e.message);
};
/** The database layer's own frames, by FUNCTION name: the packaged server is one bundled index.js, where no frame carries database.ts or
 *  io-budget.ts as its file, so the file test below matches nothing there. A bundler that renames a function on a name clash appends digits
 *  (transaction2), which the match allows. The instrumented exec and statement methods are named functions for this reason. */
export const LAYER_FUNCTIONS: ReadonlySet<string> = new Set([
  "waitCaller", "witnessWait", "traceWrite", "instrumentedExec", "instrumentedStatement", "lowerForHold", "restoreAfterHold",
  "transaction", "withBusyBudget", "backgroundWrite", "beginBackground", "beginForSource", "setBusy", "unclaimedStatementSource",
]);
/** The label of a slow statement no source claims, so no slow line or stall holder is ever `unattributed` (rc13 real-data run: a 1032 ms and a
 *  714 ms holder with no name): the named step running (observe.ts heldStep), else `caller:` and the first frames outside the database layer
 *  (`function@index.js:line` in the bundle). A stack is read only for a statement over SLOW_SQL_MS. */
function unclaimedStatementSource(): string {
  const task = activeTaskName();
  if (task) return `step:${task}`;
  const limit = Error.stackTraceLimit;
  let stack = "";
  Error.stackTraceLimit = 30;
  try { stack = new Error().stack ?? ""; } finally { Error.stackTraceLimit = limit; }
  // IoBudget.note is a method, so its frame is dropped here by name (LAYER_FUNCTIONS lists function declarations only)
  return `caller:${waitCaller(stack.split("\n").filter(line => frameFunction(line) !== "note").join("\n"))}`;
}
const LAYER_FILE = /(?:^|[\\/(])(?:database|db-busy|io-budget|observe)\.ts:|node:|internal\//;
/** The function a stack line names (`at DatabaseSync.instrumentedExec [as exec] (...)` gives instrumentedExec), digits a bundler added cut. */
function frameFunction(line: string): string {
  const named = /^\s*at (?:async )?(?:new )?([^\s(]+)(?: \[as [^\]]+\])? \(/.exec(line);
  if (!named) return "";
  const last = named[1]!.split(".").pop() ?? "";
  return last.replace(/\d+$/, "");
}
/** `file.ts:line` (in the bundle `name@index.js:line`) of the first two frames outside the database layer: who asked for the wait. */
export function waitCaller(stack?: string): string {
  if (stack === undefined) {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 30;
    try { stack = new Error().stack ?? ""; } finally { Error.stackTraceLimit = limit; }
  }
  const frames: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    if (LAYER_FILE.test(line)) continue;
    const name = frameFunction(line);
    if (name && LAYER_FUNCTIONS.has(name)) continue;
    const at = /([^\\/( ]+\.[cm]?[jt]s):(\d+)/.exec(line);
    if (!at) continue;
    // a bundle has one file name for every frame: the function's name is what says where the frame is
    const bundled = !/\.ts$/.test(at[1]!) && name && name !== "<anonymous>" && name !== "Object";
    frames.push(`${bundled ? `${name}@` : ""}${at[1]}:${at[2]}`);
    if (frames.length === 2) break;
  }
  return frames.length ? frames.join("<") : "unknown";
}
/** A statement over SLOW_SQL_MS that waited on the write lock (a BEGIN IMMEDIATE, or one that ended in SQLITE_BUSY) while the handle still had
 *  its default wait: `[sqlite] busy op= waited= holder= budget=none at=<caller>`. The stack is read only here, rate limited per op and caller. */
function witnessWait(db: object, sql: string, ms: number, failed: unknown, budget: IoBudget): void {
  const witness = busyWitness;
  if (!witness || ms <= SLOW_SQL_MS || busyNow.get(db) !== witness.defaultMs) return;
  if (!BEGIN_WRITE.test(sql) && !isBusyFailure(failed)) return;
  const op = shortStatement(sql).slice(0, 60), at = waitCaller();
  let holder: string;
  try { holder = witness.held() ? "writer-hold" : oldestLongOp() ?? "other-connection"; } catch { holder = "other-connection"; }
  const source = budget.currentSource();
  rateLimited(`sqlite-unbudgeted:${op}:${at}`, 60_000, suppressed => `[sqlite] busy op=${op} waited=${Math.round(ms)} holder=${holder} budget=none at=${at}${source ? ` source=${source}` : ""}${suppressed ? ` more=${suppressed}` : ""}`);
}

// Statement reuse for a synchronous pass that runs the same few statements thousands of times (a session's receipts are
// checked record by record: ~60,000 prepares for one check). While a pass is open, preparing the same SQL again on the same
// handle returns the statement already made. Statements are only shared inside the pass, which is synchronous, so no two users
// ever hold one at the same time; the cache is dropped when the next outermost pass opens.
let reuseDepth = 0, reuseGeneration = 0;
export function withStatementReuse<T>(work: () => T): T {
  if (reuseDepth++ === 0) reuseGeneration++;
  try { return work(); } finally { reuseDepth--; }
}
const REUSE_LIMIT = 512;
// Every write through an instrumented handle moves its counter (conservatively: a statement that can write, or any exec). A memo
// that only needs to know "did this connection write since I looked" reads it instead of asking SQLite for total_changes().
const writeCounts = new WeakMap<object, number>();
export const writeStamp = (db: object): number | undefined => writeCounts.get(db);
const wrote = (db: object) => writeCounts.set(db, (writeCounts.get(db) ?? 0) + 1);
// A second counter that moves only when a write names the tables the shared-bot rows are built from (room requests, team identities).
// Every statement on the handle goes through the instrumented prepare and exec below, so no writer can skip it, and a cascade from
// a parent delete needs no hook because the rows that matter are deleted by a statement that names them. Cross-connection writers do
// not exist for these tables (the only other connections to messages.db are read-only or touch other tables).
const sharedRowCounts = new WeakMap<object, number>();
export const sharedRowsStamp = (db: object): number | undefined => sharedRowCounts.get(db);
const SHARED_ROW_TABLES = /\b(?:room_requests|team_identities)\b/i;
const wroteSharedRows = (db: object) => sharedRowCounts.set(db, (sharedRowCounts.get(db) ?? 0) + 1);
// A third counter for the memory_scope_bindings table alone (a thread's human binding is read by about every route and moves rarely): it
// moves when a write names the table, and on every undo. No foreign key cascades into the table; another connection's commit is not seen
// here (a memo built on it must also end with the synchronous run that made it).
const bindingRowCounts = new WeakMap<object, number>();
export const bindingRowsStamp = (db: object): number | undefined => bindingRowCounts.get(db);
const BINDING_TABLE = /\bmemory_scope_bindings\b/i;
const wroteBindingRows = (db: object) => bindingRowCounts.set(db, (bindingRowCounts.get(db) ?? 0) + 1);
// Undoing writes (ROLLBACK, ROLLBACK TO, an aborted transaction) reports no changes but changes what a reader would see: it moves the
// general stamp and the shared-rows stamp, so a memo built from rows read inside the rolled-back transaction is never reused.
const UNDO_EXEC = /\bROLLBACK\b/i;
const undid = (db: object) => { wrote(db); wroteSharedRows(db); wroteBindingRows(db); };
// Statements that really write (INSERT, UPDATE, DELETE, REPLACE, a write transaction's BEGIN), per handle: the start-up witness counts them
// between listen and the first health answer (index.ts), where there should be none.
const writeStatements = new WeakMap<object, number>();
const WRITE_EXEC = /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b|^\s*BEGIN\s+(?:IMMEDIATE|EXCLUSIVE)\b/i;
// While traced (the start-up witness, listen until the first health answer) every counted write also notes who made it.
let writeTrace: Map<string, number> | null = null;
function traceWrite(): void { if (writeTrace) { const at = waitCaller(); writeTrace.set(at, (writeTrace.get(at) ?? 0) + 1); } }
const countWrite = (db: object) => { writeStatements.set(db, (writeStatements.get(db) ?? 0) + 1); traceWrite(); };
/** Starts noting the caller of every counted write; stopWriteTrace() hands back `caller xN` pairs, most first, and stops. */
export function startWriteTrace(): void { writeTrace = new Map(); }
export function stopWriteTrace(): string {
  const trace = writeTrace; writeTrace = null;
  if (!trace) return "";
  return [...trace].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([at, n]) => `${at}x${n}`).join(",");
}
/** A write about to start outside a transaction (an autocommit statement, a bare BEGIN IMMEDIATE), on a handle at its default wait, while the
 *  process's own writer hold is in force (a CREATE INDEX, the VACUUM) or under a background source: it waits the background budget, never the
 *  owner's 1 s on the serving thread (database.ts invariants 1 and 2). Owner writes were gated before a hold (gateWriteRequest, the turn start,
 *  the delivery gate), and background work treats the busy failure as "try later". True when the wait was lowered (the caller restores it). */
function lowerForHold(db: DatabaseSync, exec: (sql: string) => void): boolean {
  const witness = busyWitness;
  try {
    if (!witness || busyNow.get(db) !== witness.defaultMs || db.isTransaction || !(witness.held() || witness.background())) return false;
    exec(`PRAGMA busy_timeout=${witness.holdMs}`); busyNow.set(db, witness.holdMs);
    return true;
  } catch { return false; }
}
function restoreAfterHold(db: DatabaseSync, exec: (sql: string) => void, sql: string, ms: number, failed: unknown): void {
  const witness = busyWitness;
  if (!witness) return;
  try { if (db.isOpen) { exec(`PRAGMA busy_timeout=${witness.defaultMs}`); busyNow.set(db, witness.defaultMs); } } catch { /* closed */ }
  if (failed !== undefined && isBusyFailure(failed)) {
    const op = shortStatement(sql).slice(0, 60), at = waitCaller();
    let holder: string;
    try { holder = witness.held() ? "writer-hold" : oldestLongOp() ?? "other-connection"; } catch { holder = "other-connection"; }
    rateLimited(`sqlite-lowered:${op}:${at}`, 60_000, suppressed => `[sqlite] busy op=${op} waited=${Math.round(ms)} holder=${holder} budget=${witness.holdMs} at=${at}${suppressed ? ` more=${suppressed}` : ""}`);
  }
}
/** How many writing statements this handle has run (0 for a handle that is not instrumented). */
export const writeStatementCount = (db: object): number => writeStatements.get(db) ?? 0;
/** Whether a synchronous pass is open (the data folder cannot be swapped under it). */
export const inStatementReusePass = () => reuseDepth > 0;
/** Identifies the open pass (0 when none), so a memo made inside one is never read in another. */
export const statementReusePassId = () => reuseDepth > 0 ? reuseGeneration : 0;

/** Time every statement run through this handle, so a trip can name the culprits. `bytes: false` for a handle that never writes
 * (the memory index reader): its file's log is another process's writing, charged by that process's own report, not read here twice. */
export function instrumentDatabase(db: DatabaseSync, budget: IoBudget = ioBudget, options: { bytes?: boolean } = {}): () => void {
  const prepare = db.prepare.bind(db);
  const file = prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file;
  const source = file ? `database:${file}` : "";
  const unregister = source && options.bytes !== false ? budget.registerByteSource(source, walFrameReader(String(file))) : () => {};
  let transactionSource = source;
  const sample = (name: string) => { if (source) budget.sampleByteSource(source, name); };
  const exec = db.exec.bind(db);
  writeCounts.set(db, 0);
  sharedRowCounts.set(db, 0);
  bindingRowCounts.set(db, 0);
  const instrumentedExec = (sql: string) => {
    const inTransaction = db.isTransaction;
    if (!inTransaction) sample(source);
    const writing = WRITE_EXEC.test(sql);
    // (an exec cannot report its changes: a statement that can write moves the stamps, a pragma or a read does not)
    if (writing || /\b(?:CREATE|DROP|ALTER)\b/i.test(sql)) {
      wrote(db);
      if (SHARED_ROW_TABLES.test(sql)) wroteSharedRows(db);
      if (BINDING_TABLE.test(sql)) wroteBindingRows(db);
    }
    if (writing) countWrite(db);
    const lowered = writing && lowerForHold(db, exec);
    const started = performance.now();
    let failed: unknown;
    try { exec(sql); } catch (error) { failed = error; throw error; }
    finally {
      // A rollback reports no changes yet undoes rows a memo may have read inside the transaction: it always moves every stamp (a
      // ROLLBACK, a ROLLBACK TO, or SQLite aborting the transaction itself when a statement fails and the handle is no longer in one).
      if (inTransaction && (UNDO_EXEC.test(sql) || (failed !== undefined && !db.isTransaction))) undid(db);
      const ms = performance.now() - started;
      if (lowered) restoreAfterHold(db, exec, sql, ms, failed);
      budget.note(EXEC_PREFIX + statementKey(sql), ms, true);
      if (!lowered && ms > SLOW_SQL_MS) witnessWait(db, sql, ms, failed, budget);
      // the end of a transaction: database.ts puts back what a background slice relaxed for its commit (synchronous)
      if (inTransaction && END_TRANSACTION.test(sql)) { try { if (!db.isTransaction) busyWitness?.transactionEnded(db); } catch { /* closed */ } }
    }
    if (!db.isTransaction) sample(budget.currentSource() ?? (inTransaction ? transactionSource : statementKey(sql)));
  };
  db.exec = instrumentedExec;
  const reuse = new Map<string, StatementSync>();
  let reuseSeen = -1;
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    if (reuseDepth > 0) {
      if (reuseSeen !== reuseGeneration) { reuse.clear(); reuseSeen = reuseGeneration; }
      const known = reuse.get(sql);
      if (known) return known;
    }
    const statement = prepare(sql);
    const key = statementKey(sql);
    const tokens = sql.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
    const writes = /\b(?:INSERT|UPDATE|REPLACE|DELETE)\b/i.test(tokens);
    const sharedTable = writes && SHARED_ROW_TABLES.test(tokens);
    // (matched on the statement as written, quotes and comments included: `UPDATE 'memory_scope_bindings'` names the table too)
    const bindingTable = writes && BINDING_TABLE.test(sql);
    // a prepared ROLLBACK or ROLLBACK TO undoes rows a memo may have read, as the exec form does
    const undoes = UNDO_EXEC.test(tokens);
    const memoryWork = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\s+(?:OR\s+\w+\s+)?|REPLACE\s+INTO)\s*["`\[]?(?:main["`\]]?\s*\.\s*["`\[]?)?memory_(?:jobs|projection_receipts|scope_bindings)["`\]]?(?=\s|\(|$)/i.test(tokens);
    for (const method of ["get", "all", "run"] as const) {
      const original = statement[method].bind(statement) as (...args: unknown[]) => unknown;
      const instrumentedStatement = (...args: unknown[]) => {
        const lowered = writes && method === "run" && lowerForHold(db, exec);
        const inTransactionBefore = db.isTransaction;
        const started = performance.now();
        let failed: unknown;
        try {
          const result = original(...args);
          if (writes) {
            transactionSource = budget.currentSource() ?? key;
            if (!db.isTransaction) sample(transactionSource);
          }
          // the stamps move only when rows really changed: a DELETE that matched nothing (the idle push-notification prune) leaves them
          if (writes) {
            const changed = method === "run" ? Number((result as { changes: number | bigint }).changes) > 0 : true;
            if (changed) { wrote(db); if (sharedTable) wroteSharedRows(db); if (bindingTable) wroteBindingRows(db); }
          }
          if (memoryWork && method === "run" && Number((result as {changes:number|bigint}).changes) > 0) budget.notifyMemoryWork();
          return result;
        } catch (error) { failed = error; throw error; }
        finally {
          // a failed statement that made SQLite abort the whole transaction undid every write in it
          if (failed !== undefined && inTransactionBefore && !db.isTransaction) undid(db);
          // a failed binding write may keep what it changed before it failed (UPDATE OR FAIL): it moves the binding stamp all the same
          if (failed !== undefined && bindingTable) { wrote(db); wroteBindingRows(db); }
          if (undoes && inTransactionBefore) undid(db);
          if (writes && method === "run") countWrite(db);
          const ms = performance.now() - started;
          budget.note(key, ms, true);
          if (lowered) restoreAfterHold(db, exec, sql, ms, failed);
          else if (failed !== undefined && writes && ms > SLOW_SQL_MS) witnessWait(db, sql, ms, failed, budget);
        }
      };
      (statement as unknown as Record<string, unknown>)[method] = instrumentedStatement;
    }
    // iterate() runs the statement as its rows are pulled (an UPDATE ... RETURNING writes there): every pull and the end of the iteration
    // move the stamps the statement could move, whether it changed rows or failed
    if (writes || undoes) {
      const iterate = statement.iterate.bind(statement) as (...args: unknown[]) => IterableIterator<unknown>;
      const touched = () => { if (writes) { wrote(db); if (sharedTable) wroteSharedRows(db); if (bindingTable) wroteBindingRows(db); } if (undoes) undid(db); };
      // a pull that made SQLite abort the whole transaction (a schema-level ON CONFLICT ROLLBACK on a row it inserted into another table)
      // undid every write in it, binding rows included: the same abort test as get/all/run, around every pull and the end
      const pulled = <R>(pull: () => R): R => {
        const inTransactionBefore = db.isTransaction;
        try { return pull(); } finally { touched(); try { if (inTransactionBefore && !db.isTransaction) undid(db); } catch { undid(db); } }
      };
      (statement as unknown as Record<string, unknown>).iterate = (...args: unknown[]) => {
        const inner = iterate(...args);
        const wrapped: IterableIterator<unknown> = {
          next: (...more: [] | [unknown]) => pulled(() => inner.next(...more)),
          return: (value?: unknown) => pulled(() => inner.return ? inner.return(value) : { done: true, value }),
          [Symbol.iterator]() { return wrapped; },
        };
        return wrapped;
      };
    }
    if (reuseDepth > 0 && reuse.size < REUSE_LIMIT) reuse.set(sql, statement);
    return statement;
  };
  return unregister;
}
