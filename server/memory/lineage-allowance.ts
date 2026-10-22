// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 lineage-cold: the lineage work one piece of work may do, owned by the work.
//
// Every history read of the replay checks (a receipt group, a cited record, a source, a stored root set) is paid for from ONE
// allowance, and the allowance is a parameter: a reader that takes none does not compile. The first design kept it in an
// AsyncLocalStorage and switched it off with a phase marker, so a reader that ran after the marker (or outside the wrapper)
// silently read without limit. Here a closed allowance is the opposite of unlimited: spending on it stops the read with the
// limit error (MEMORY_REPLAY_LIMIT), which every check already turns into "not proven, so not shown".
import type { ReadMeter } from "./root-set-handles.ts";

/** Index rows one node of the allowance pays for. A node is a judgement (a record read, a group, a source); a row of an index scan is
 * a small share of one, but never free: a read of the history is paid for by the rows it reads. */
export const ROWS_PER_NODE = 16;
/** Lineage work one turn may spend in all: its setup (index.ts startTurn) holds one allowance, whatever checks it makes. */
export const TURN_LINEAGE_NODES = 3000;
let turnNodesOverride: number | null = null;
/** Wall-clock time one turn's lineage reads may take in all (1.0.2 lineage-cold r3, the 48 GB rig): 3,000 nodes bound the count of reads, not
 * their time (a few ms of SQL each on an overloaded machine is seconds). Past it the checks stop as when the nodes run out ("checking"). */
export const TURN_LINEAGE_MS = 50;
/** A check made outside a turn's setup (a bot's own memory tool, a route) on the same thread. */
export const TOOL_LINEAGE_MS = 100;
let timeOverride: number | null | undefined;
/** Tests set the time budget of the default allowances (null: none). Unset, a test run has none, so a slow runner does not change what the
 * existing suites prove; the time tests set it. */
export function setLineageTimeBudgetForTest(ms: number | null | undefined): void { timeOverride = ms; }
const defaultMs = (ms: number): number => timeOverride !== undefined ? (timeOverride ?? Infinity) : process.env.VITEST ? Infinity : ms;
/** Tests lower the allowance to reach the warming path; null is the real one. */
export function setTurnLineageNodesForTest(nodes: number | null): void { turnNodesOverride = nodes; }

export type AllowanceScope = "turn" | "room" | "tool" | "warm" | "steer" | "writer";

/** What the module that owns the lineage state does when an allowance is spent (kept out of here so this file has no imports of it). */
export const allowanceHooks = {
  /** The allowance ran out (or was closed) while `thread` was being checked: the thread wants warming, and the check is unfinished. */
  exhausted: (_thread: string): void => {},
  /** The allowance was refused work it could not pay for: the thread wants warming. */
  wanted: (_thread: string): void => {},
  /** A read made progress a later call can build on. */
  progress: (): void => {},
};

export class LineageAllowance {
  readonly scope: AllowanceScope;
  /** Why a writer's allowance exists (a writer that reads one stored set whole, bounded by the root ceiling), for grep. */
  readonly reason: string | undefined;
  remaining: number;
  spent = 0;
  /** Set once the allowance ran out or refused work: what it withheld may be only unproven, not bad. A renewal (renew) clears it. */
  get hit(): boolean { return this.hitNow; }
  set hit(value: boolean) { this.hitNow = value; if (value) this.everHit = true; }
  private hitNow = false;
  /** Whether the allowance ever ran out or refused work, renewals included (the warmer's guaranteed slice follows this). */
  everHit = false;
  /** How many times the allowance was renewed (renew): at most once. */
  private renewals = 0;
  /** Rows read and not yet paid for (a node pays for ROWS_PER_NODE rows). */
  debt = 0;
  closed = false;
  /** The wall-clock budget, the time already spent inside timed reads, and the start of the timed read in progress. */
  private readonly msBudget: number;
  private msUsed = 0;
  private sectionAt = 0;
  private depth = 0;
  /** Receipts per thread, counted once for the whole allowance (a strategy figure, never a verdict). */
  counts?: Map<string, number>;

  /** The nodes the allowance started with (a renewal restores them). */
  private readonly nodesAtStart: number;
  private constructor(scope: AllowanceScope, nodes: number, reason?: string, msBudget = Infinity) {
    this.scope = scope; this.remaining = nodes; this.nodesAtStart = nodes; this.reason = reason; this.msBudget = msBudget;
  }
  private static nodes(nodes?: number): number { return nodes ?? turnNodesOverride ?? TURN_LINEAGE_NODES; }
  /** A direct turn's setup (startTurn): one allowance for working context, replay, recall, the continuation check and output roots. */
  static turn(nodes?: number): LineageAllowance { return new LineageAllowance("turn", LineageAllowance.nodes(nodes), undefined, nodes === undefined ? defaultMs(TURN_LINEAGE_MS) : Infinity); }
  /** A room member's turn (runGroupMemberTurn). */
  static room(nodes?: number): LineageAllowance { return new LineageAllowance("room", LineageAllowance.nodes(nodes), undefined, nodes === undefined ? defaultMs(TURN_LINEAGE_MS) : Infinity); }
  /** A check made outside a turn (a tool, a route, a procedure check, consolidation, skills). */
  static tool(nodes?: number): LineageAllowance { return new LineageAllowance("tool", LineageAllowance.nodes(nodes), undefined, nodes === undefined ? defaultMs(TOOL_LINEAGE_MS) : Infinity); }
  /** A steer folded into a running turn. */
  static steer(nodes?: number): LineageAllowance { return new LineageAllowance("steer", LineageAllowance.nodes(nodes), undefined, nodes === undefined ? defaultMs(TURN_LINEAGE_MS) : Infinity); }
  /** One slice of the warmer. */
  static warm(nodes: number): LineageAllowance { return new LineageAllowance("warm", nodes); }
  /** For the writers that record what a turn was shown: they read ONE stored root set whole, and a stored set is never past the
   * root ceiling, so `nodes` (replay-lineage.ts writerAllowance: what a set at the ceiling costs) bounds the read by construction.
   * There is no unlimited allowance: every read of the history is paid for (grep `writerAllowance(`). */
  static writer(reason: string, nodes: number): LineageAllowance { return new LineageAllowance("writer", nodes, reason); }

  /** Runs a lineage read, its time counted against the wall-clock budget (nested reads count once). */
  timed<T>(work: () => T): T {
    if (this.depth++ === 0) this.sectionAt = performance.now();
    try { return work(); }
    finally { if (--this.depth === 0) this.msUsed += performance.now() - this.sectionAt; }
  }
  /** Whether the timed reads have used the wall-clock budget. */
  overTime(): boolean {
    if (this.msBudget === Infinity) return false;
    return this.msUsed + (this.depth > 0 ? performance.now() - this.sectionAt : 0) >= this.msBudget;
  }
  /** Stops the allowance: whatever spends on it later is refused, never free. */
  close(): void { this.closed = true; }
  /** 1.0.3 resume race (RESUME-RACE-DESIGN.md Part A): a turn whose resumed session was just reset (fail closed) rebuilds its replay and
   * memory block on this allowance. When recall or the check spent it first, that rebuild withheld everything it could not pay for and
   * the bot forgot the conversation. Renewing gives the rebuild a fresh budget, ONCE per allowance (a loop of resets cannot refill it),
   * so a turn's lineage work is at most two allowances, the second only on the reset path. It decides nothing about resuming: every
   * revoke and forget check still runs, and a line that cannot be paid for is still withheld. A closed allowance (setup over) and one
   * renewed before are refused: false. */
  renew(): boolean {
    if (this.closed || this.renewals >= 1 || this.depth > 0) return false;
    this.renewals++;
    this.remaining = this.nodesAtStart;
    this.debt = 0; this.msUsed = 0; this.hitNow = false;
    return true;
  }

  /** What may still be spent (0: closed or spent). */
  room(): number { return this.closed || this.overTime() ? 0 : Math.max(0, this.remaining); }
  /** Whether nothing more can be paid for. */
  spentOut(): boolean { return this.closed || this.remaining <= 0 || this.overTime(); }

  private exhaust(thread: string): never {
    this.hit = true;
    if (thread) allowanceHooks.exhausted(thread);
    throw new Error("MEMORY_REPLAY_LIMIT");
  }
  /** Notes that work was refused because it could not be paid for (the caller decides what it does next). */
  refuse(thread: string): void { this.hit = true; if (thread) allowanceHooks.wanted(thread); }
  /** Pays `count` nodes; stops with the limit error when it cannot. */
  spendNodes(thread: string, count: number): void {
    if (this.closed || this.overTime()) this.exhaust(thread);
    // what is charged never passes what the allowance held: a charge that does not fit is paid up to the room left, and the read it was for is not made
    this.spent += Math.min(count, Math.max(0, this.remaining)); this.remaining -= count;
    if (this.remaining < 0) this.exhaust(thread);
  }
  /** Pays for `rows` index rows read outside a judge. With no room left nothing is read: it stops first. */
  spendRows(thread: string, rows: number): void {
    if (this.closed || this.overTime()) this.exhaust(thread);
    if (this.remaining <= 0) this.exhaust(thread);
    this.debt += rows;
    const nodes = Math.floor(this.debt / ROWS_PER_NODE);
    if (!nodes) return;
    this.debt -= nodes * ROWS_PER_NODE;
    this.spendNodes(thread, nodes);
  }
  /** Reserves a read BEFORE it is made: stops (the limit error) unless what is left can pay for up to `rows` rows. The read then pays
   * for the rows it actually read (spendRows), so a bounded read is never started that the allowance could not cover, and a small
   * read is not charged as a large one. */
  reserveRows(thread: string, rows: number): void {
    if (this.closed || this.overTime() || this.remaining * ROWS_PER_NODE - this.debt < rows) this.exhaust(thread);
  }
  /** How many rows a read of `want` rows may take now: the most the room left can pay for. With no room left nothing is read. */
  rowRoom(thread: string, want: number): number {
    if (this.closed || this.overTime()) this.exhaust(thread);
    if (this.remaining <= 0) this.exhaust(thread);
    return Math.min(want, this.remaining * ROWS_PER_NODE);
  }
  /** Stops as an allowance does: a read found more rows than the allowance could pay for. */
  readTooBig(thread: string): never { this.exhaust(thread); }
  /** The reads of a stored root set's chain (root-set-handles.ts), paid for from this allowance. */
  meter(thread: string): ReadMeter {
    return {
      room: () => this.room() * ROWS_PER_NODE,
      take: rows => { this.spendRows(thread, rows); allowanceHooks.progress(); },
    };
  }
}
