// SPDX-License-Identifier: AGPL-3.0-or-later
// A disk and CPU watchdog. The 0.1.58 Inbox poll burned about 20 MB/s of
// SQLite temp files for days and nothing in the product noticed. This samples
// the process once a minute and, when it is writing or spinning far beyond
// what an idle app should, says so in the log with the statements that cost
// the most and asks the pollers to back off. It only ever LOGS and SLOWS
// POLLS. It never stops, cancels or delays a turn, a routine or a write.
import type { DatabaseSync } from "node:sqlite";

export const IO_BUDGET_INTERVAL_MS = 60_000;
export const IO_BUDGET_BYTES_PER_MINUTE = 50 * 1024 * 1024;
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

  constructor(options: IoBudgetOptions = {}) {
    this.read = options.read ?? readProcess;
    this.log = options.log ?? ((line) => console.warn(line));
    this.onScale = options.onScale ?? (() => {});
    this.bytesPerMinute = options.bytesPerMinute ?? IO_BUDGET_BYTES_PER_MINUTE;
    this.cpuFraction = options.cpuFraction ?? IO_BUDGET_CPU_FRACTION;
    this.cpuMinutes = options.cpuMinutes ?? IO_BUDGET_CPU_MINUTES;
  }

  /** Replace the listener told when the scale changes. */
  setOnScale(listener: (scale: number) => void): void { this.onScale = listener; }

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

  /** Take one sample and judge the minute since the last. Returns the verdict for tests. */
  tick(): { writeBytesPerMinute: number; cpu: number; tripped: boolean } | null {
    let reading: IoReading;
    try { reading = this.read(); } catch { return null; }
    const previous = this.last;
    this.last = reading;
    if (!previous || reading.at <= previous.at) return null;
    const minutes = (reading.at - previous.at) / 60_000;
    const writeBytesPerMinute = ((reading.fsWriteBlocks - previous.fsWriteBlocks) * BLOCK_BYTES) / minutes;
    const cpu = (reading.cpuMicros - previous.cpuMicros) / 1000 / (reading.at - previous.at);
    this.hotCpuMinutes = cpu > this.cpuFraction ? this.hotCpuMinutes + 1 : 0;
    const writing = writeBytesPerMinute > this.bytesPerMinute;
    const spinning = this.hotCpuMinutes >= this.cpuMinutes;
    const tripped = writing || spinning;
    if (tripped) {
      this.calmMinutes = 0;
      const top = this.topStatements().map(cost => `${Math.round(cost.ms)}ms x${cost.calls} ${cost.sql}`).join(" | ") || "none recorded";
      const next = Math.min(IO_BUDGET_MAX_SCALE, this.scale * 2);
      this.log(`[io-budget] ${writing ? `writing ${(writeBytesPerMinute / 1048576).toFixed(1)} MB/min (budget ${(this.bytesPerMinute / 1048576).toFixed(0)})` : ""}`
        + `${writing && spinning ? ", " : ""}${spinning ? `cpu ${(cpu * 100).toFixed(0)}% for ${this.hotCpuMinutes} min` : ""}; top statements: ${top}; poll rate x1/${next}`);
      this.setScale(next);
      this.statements.clear();
      if (spinning) this.hotCpuMinutes = 0;
    } else if (this.scale > 1 && ++this.calmMinutes >= IO_BUDGET_CALM_MINUTES) {
      this.calmMinutes = 0;
      this.setScale(Math.max(1, this.scale / 2));
    }
    return { writeBytesPerMinute, cpu, tripped };
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
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** The text a statement is filed under. Done once per prepare, not per run:
 *  the Inbox projection is ten kilobytes of SQL. */
export function statementKey(sql: string): string { return sql.replace(/\s+/g, " ").trim().slice(0, 160); }

/** The process-wide watchdog. index.ts starts it; database.ts feeds it. */
export const ioBudget = new IoBudget();

/** Time every statement run through this handle, so a trip can name the culprits. */
export function instrumentDatabase(db: DatabaseSync, budget: IoBudget = ioBudget): void {
  const prepare = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    const statement = prepare(sql);
    const key = statementKey(sql);
    for (const method of ["get", "all", "run"] as const) {
      const original = statement[method].bind(statement) as (...args: unknown[]) => unknown;
      (statement as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        const started = performance.now();
        try { return original(...args); } finally { budget.note(key, performance.now() - started, true); }
      };
    }
    return statement;
  };
}
