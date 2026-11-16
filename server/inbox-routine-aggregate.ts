// SPDX-License-Identifier: AGPL-3.0-or-later
import { failureCause, STALLED_UPSTREAM_MS, rollUpRoutineRuns, type RoutineRollup, type RoutineRunFact, type RoutineVerdict } from "./inbox-rollup.ts";

export const ROUTINE_DAY_MS = 86_400_000;
export const ROUTINE_WINDOW_MS = 14 * ROUTINE_DAY_MS;
export const ROUTINE_ROW_LIMIT = 2_000;

/** The input's stable position, encoded in lexicographic order. Card positions
 * precede record positions. This preserves the old stable-sort tie rules. */
export interface OrderedRoutineFact { id: string; position: string; fact: RoutineRunFact }
interface Summary {
  runs: number;
  failed: number;
  latest: RoutineRunFact;
  first: string;
  since: number | null;
  causes: number;
  connectionAt: number | null;
}
interface Node { children: Map<string, Node>; summary?: Summary }
const causeBit = (fact: RoutineRunFact) => ({ upstream: 1, unknown: 2, connection: 4 })[failureCause(fact.detail)];
const leaf = ({ fact, position }: OrderedRoutineFact): Summary => ({
  runs: 1, failed: Number(fact.failed), latest: fact, first: position,
  since: fact.failed ? fact.at : null, causes: fact.failed ? causeBit(fact) : 0,
  connectionAt: fact.failed && causeBit(fact) === 4 ? fact.at : null,
});
/** An associative chronological fold. A success cuts off the failure tail;
 * waiting is a non-failure too, exactly as in rollUpRoutineRuns. */
function join(a: Summary | undefined, b: Summary | undefined): Summary | undefined {
  if (!a) return b;
  if (!b) return a;
  const extendsTail = b.failed === b.runs;
  return {
    runs: a.runs + b.runs, failed: a.failed + b.failed, latest: b.latest,
    first: a.first < b.first ? a.first : b.first,
    since: extendsTail && a.latest.failed ? a.since : b.since,
    causes: extendsTail ? a.causes | b.causes : b.causes,
    connectionAt: extendsTail
      ? a.connectionAt === null ? b.connectionAt : b.connectionAt === null ? a.connectionAt : Math.max(a.connectionAt, b.connectionAt)
      : b.connectionAt,
  };
}

/** Sortable finite IEEE-754 number. The key width is fixed, independent of
 * retained history. Negative timestamps and fractional milliseconds work too. */
export function routineNumberKey(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Inbox aggregate timestamp must be finite");
  const buffer = new ArrayBuffer(8), view = new DataView(buffer);
  view.setFloat64(0, Object.is(value, -0) ? 0 : value);
  let bits = view.getBigUint64(0);
  bits = bits >> 63n ? ~bits & 0xffff_ffff_ffff_ffffn : bits ^ 0x8000_0000_0000_0000n;
  return bits.toString(16).padStart(16, "0");
}
const dayKey = (at: number) => routineNumberKey(Math.floor(at / ROUTINE_DAY_MS));
const timeKey = (at: number) => dayKey(at) + routineNumberKey(at);
const entryKey = (entry: OrderedRoutineFact) => timeKey(entry.fact.at) + (entry.fact.failed ? "0" : "1") + entry.position;

/** A day-prefixed radix aggregate. Every day node stores run/failure counters
 * and the chronological fold of that day. Removing an expired day drops its
 * entire contribution; the partial boundary day follows only the cutoff's
 * radix path. No read, update or expiry walks records. */
class DayCounters {
  private readonly root: Node = { children: new Map() };
  private readonly visit: () => void;
  constructor(visit: () => void) { this.visit = visit; }
  private fold(node: Node): void {
    let summary: Summary | undefined;
    // Sixteen children at most, independent of history.
    for (const digit of "0123456789abcdef") summary = join(summary, node.children.get(digit)?.summary);
    node.summary = summary;
  }
  set(key: string, summary?: Summary): void {
    const path: Node[] = [this.root];
    let node = this.root;
    for (const digit of key) {
      this.visit();
      let child = node.children.get(digit);
      if (!child) {
        if (!summary) return;
        child = { children: new Map() };
        node.children.set(digit, child);
      }
      node = child; path.push(node);
    }
    node.summary = summary;
    for (let i = key.length - 1; i >= 0; i--) {
      const parent = path[i]!, child = path[i + 1]!;
      if (!child.summary) parent.children.delete(key[i]!);
      this.fold(parent);
    }
  }
  /** Inclusive lower bound. Whole expired day subtrees contribute nothing.
   * Only the partial cutoff day follows a radix path; day totals beyond it
   * are joined directly. Keeping the retained source counters also makes a
   * backwards wall-clock adjustment exact without a history rebuild. */
  window(cutoff: string): Summary | undefined {
    const descend = (node: Node, depth: number): Summary | undefined => {
      this.visit();
      if (depth === cutoff.length) return node.summary;
      const digit = cutoff[depth]!;
      let summary: Summary | undefined;
      const child = node.children.get(digit);
      if (child) summary = descend(child, depth + 1);
      for (const candidate of "0123456789abcdef") {
        if (candidate > digit) summary = join(summary, node.children.get(candidate)?.summary);
      }
      return summary;
    };
    return descend(this.root, 0);
  }
  get summary(): Summary | undefined { this.visit(); return this.root.summary; }
}

/** Maintained from source deltas, never from a snapshot in the badge path.
 * Startup owns the sole bounded rebuild. The source retains only the same
 * capped population as the old computation. */
export class IncrementalRoutineRollup {
  private readonly routines = new Map<string, DayCounters>();
  private readonly entries = new Map<string, { key: string; routine: string }>();
  private connectionDays = new DayCounters(() => { this.work.nodes++; });
  private readonly connectionKeys = new Map<string, string>();
  private connectionOrder = 0;
  /** For badge purposes a stuck routine needs a connection exactly until the
   * last connection failure in its unbroken tail leaves the window. Maintain
   * those endpoints too, so deleted/historical routine IDs never add work to
   * a badge read. Full rows are materialised only for a view that needs them. */
  private refreshConnection(routine: string, counters?: DayCounters): void {
    const old = this.connectionKeys.get(routine);
    if (old) { this.connectionDays.set(old); this.connectionKeys.delete(routine); }
    const summary = counters?.summary;
    if (!summary || !summary.latest.failed || summary.latest.owed === true || summary.connectionAt === null) return;
    const position = routineNumberKey(this.connectionOrder++);
    const entry: OrderedRoutineFact = { id: routine, position, fact: {
      ...summary.latest, at: summary.connectionAt, failed: true, owed: false, detail: "401 unauthorized",
    } };
    const key = entryKey(entry);
    this.connectionDays.set(key, leaf(entry));
    this.connectionKeys.set(routine, key);
  }
  needsConnection(now: number): boolean {
    const latest = this.connectionDays.summary?.latest;
    return latest !== undefined && latest.at >= now - ROUTINE_WINDOW_MS;
  }
  /** A small work seam; tests also instrument collection operations so a
   * hidden scan cannot pass merely by omitting an increment here. */
  readonly work = { nodes: 0, updates: 0, rebuilt: 0 };

  upsert(entry: OrderedRoutineFact): void {
    const key = entryKey(entry), routine = entry.fact.routineKey;
    this.remove(entry.id);
    let counters = this.routines.get(routine);
    if (!counters) this.routines.set(routine, counters = new DayCounters(() => { this.work.nodes++; }));
    // Copy at the boundary: later caller mutations cannot change a cached fold.
    counters.set(key, leaf({ ...entry, fact: { ...entry.fact, ...(entry.fact.link ? { link: { ...entry.fact.link } } : {}) } }));
    this.entries.set(entry.id, { key, routine });
    this.refreshConnection(routine, counters);
    this.work.updates++;
  }
  remove(id: string): void {
    const old = this.entries.get(id);
    if (!old) return;
    const counters = this.routines.get(old.routine);
    counters?.set(old.key);
    if (counters && !counters.summary) this.routines.delete(old.routine);
    this.entries.delete(id);
    this.refreshConnection(old.routine, this.routines.get(old.routine));
    this.work.updates++;
  }
  rebuild(entries: readonly OrderedRoutineFact[], now: number, assert = process.env.NODE_ENV === "test"): void {
    // Cards and records each had their own 2,000-row limit before merging.
    if (entries.length > 2 * ROUTINE_ROW_LIMIT) throw new Error("Inbox rollup rebuild exceeds source limits");
    this.routines.clear(); this.entries.clear();
    this.connectionDays = new DayCounters(() => { this.work.nodes++; });
    this.connectionKeys.clear(); this.connectionOrder = 0;
    for (const entry of entries) this.upsert(entry);
    this.work.rebuilt++;
    if (assert) this.assertConsistent(entries, now);
  }
  read(now: number): RoutineRollup[] {
    const cutoff = now - ROUTINE_WINDOW_MS;
    const rows: Array<{ row: RoutineRollup; first: string }> = [];
    for (const [routineKey, counters] of this.routines) {
      const summary = counters.window(timeKey(cutoff));
      if (!summary) continue;
      const { latest, failed, runs } = summary;
      const verdict: RoutineVerdict = latest.owed === true ? "waiting" : latest.failed ? "stuck" : failed ? "recovered" : "ok";
      const cause = verdict === "stuck" ? summary.causes & 4 ? "connection" : summary.causes & 2 ? "unknown" : "upstream" : null;
      const failingSince = verdict === "stuck" ? summary.since : null;
      rows.push({ first: summary.first, row: {
        routineKey, routineName: latest.routineName, botLabel: latest.botLabel, runs, failed,
        lastAt: latest.at, verdict, cause, failingSince,
        stalled: verdict === "stuck" && cause === "upstream" && now - (failingSince ?? latest.at) >= STALLED_UPSTREAM_MS,
        ...(latest.link ? { link: { ...latest.link } } : {}),
      } });
    }
    const rank = { waiting: 0, stuck: 1, recovered: 2, ok: 3 };
    rows.sort((a, b) => rank[a.row.verdict] - rank[b.row.verdict] || b.row.lastAt - a.row.lastAt || (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
    return rows.map(({ row }) => row);
  }
  assertConsistent(entries: readonly OrderedRoutineFact[], now: number): void {
    // Dynamic import would make reads asynchronous. The oracle is only used
    // by this explicit test/startup diagnostic, never by read().
    const facts = [...entries].sort((a, b) => a.position < b.position ? -1 : a.position > b.position ? 1 : 0)
      .filter(entry => entry.fact.at >= now - ROUTINE_WINDOW_MS).map(entry => entry.fact);
    const expected = rollUpRoutineRuns(facts, now);
    if (JSON.stringify(this.read(now)) !== JSON.stringify(expected)
      || this.needsConnection(now) !== expected.some(row => row.verdict === "stuck" && row.cause === "connection")) {
      throw new Error("Inbox routine rollup consistency check failed");
    }
  }
}

