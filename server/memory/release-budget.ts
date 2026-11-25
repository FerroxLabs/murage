// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LineageVerdict } from "./lineage-types.ts";

/** 1.0.21 cause22 (MAIN-RULING cause22-no-transport-caps, Sean 2026-11-22): no size or count of what a turn moves is a limit. The byte
 * budget (64 MiB) and the attempt count (4096) are gone, on every turn: bytes and attempts are still counted (`counts`), never limited.
 * The two limits left bound bookkeeping work and SQL statements of one window. */
export const RELEASE_LIMITS = Object.freeze({ work: 16_777_216, statements: 65_536 });
export const RELEASE_CHUNK_MAX = 64 * 1024;
/** Kept as names only (other files import them); no reader stops at them any more (upstream-reader.ts, cause22-no-transport-caps). */
export const UPSTREAM_EVENT_MAX = 1024 * 1024;
export const UPSTREAM_COLLECTION_MAX = 8 * 1024 * 1024;
export const UPSTREAM_OWNER_HARD_MAX = 64 * 1024 * 1024;
export const UPSTREAM_OVERSIZE_CODE = "UPSTREAM_OVERSIZE_CUT";
export type UpstreamOversize = "event" | "body" | "cut";
type Counter = "attempts" | "bytes" | keyof typeof RELEASE_LIMITS;
const COUNTERS: readonly Counter[] = ["attempts", "bytes", "work", "statements"];
export type ReleaseCost = Partial<Record<Counter, number>>;
export const BUDGET_VERDICT: LineageVerdict = Object.freeze({ state: "checking", reason: "retained-budget" });

/** Owned by one concrete generation. Counters cannot be refunded.
 *
 * 1.0.21 cause4: the limits bound one WINDOW of the generation, not its whole life. A long turn that keeps releasing ordinary,
 * individually bounded frames used to cross a lifetime counter (every release re-reads the live ledger and pays statements and work for
 * it: the cost grows with the turn's length and the ledger's size, not with anything revoked) and was refused as
 * checking:retained-budget, which stopped the turn and replaced its whole reply with the refusal line although nothing had been revoked.
 * A crossing now opens a fresh window when, and only when, this window holds a fenced release that was accepted (`accepted()`, called
 * by the release boundary after the retained fence passed against the live ledger and the destination took the frame). What still
 * refuses, for good:
 *  - a cost that is not a non-negative safe integer;
 *  - one non-transport cost above a whole limit (an async scope charges work LIMIT + 1);
 *  - a non-transport crossing (SQL work or statements) in a window with no accepted release;
 *  - a sealed budget (any earlier refusal).
 * A new window skips no check: every release still runs the retained fence (send-fence.ts assertRetainedFence).
 *
 * 1.0.21 cause22 (Sean, No limits: an owner turn is never stopped for memory bookkeeping). A budget bound to the owner's own turn
 * (`keepOwner`, lineage-write.ts bindRetainedTurn: the same turns the 1.0.20 owner keep rule covers) does not refuse on a crossing in a
 * window with no accepted release (about 16 MiB of tool output before a reply is delivered, or replies held and then dropped while
 * memory stays checking:pending). It DEGRADES: the hook runs once (the turn records why), a new window opens and the turn
 * continues. The limits then bound each window, no longer the turn: what still bounds the turn is every release's own retained fence,
 * the retained caps (retained-over). Still refused on an owner turn, as on every other: an invalid cost and a sealed budget.
 * cause22 caps: one cost above a whole limit no longer refuses an owner turn (owner-turn-caps.ts: no size stops it); the window is
 * renewed and the crossing recorded like any other. Every other turn keeps the behaviour above.
 * cause22 r2: the upstream structural caps (one event over 1 MiB, one collected body over 8 MiB) no longer end an owner turn either:
 * see UPSTREAM_OWNER_HARD_MAX and upstream-reader.ts UpstreamAccounting.
 * cause22-no-transport-caps: a TRANSPORT charge (one that moves bytes or makes an attempt: a release, an upstream read, a request) is
 * counted and never refused for its size or count, on any turn: the work it carries scales with the bytes moved, so it is not charged
 * against the work limit either. Still refused, as before: an invalid cost and a sealed budget. Every release still runs its retained
 * fence (send-fence.ts), so a real memory change still revokes. */
export class ReleaseBudget {
  private readonly used = { attempts: 0, bytes: 0, work: 0, statements: 0 };
  private sealed = false;
  private terminalUsed = false;
  private releases = 0;
  private opened = 1;
  private ownerDegrade: ((crossed: readonly string[]) => void) | undefined;
  private degradedWindows = 0;
  private degradedBy: readonly string[] = [];
  private ownerOversize: ((kind: UpstreamOversize) => void) | undefined;
  private readonly oversizeSeen = { event: 0, body: 0, cut: 0 };
  readonly refuse: (verdict: LineageVerdict) => void;
  constructor(refuse: (verdict: LineageVerdict) => void) { this.refuse = refuse; }
  /** bytes and attempts: the turn's totals (never reset, never limited); work and statements: the current window's. */
  get counts(): Readonly<typeof this.used> { return Object.freeze({ ...this.used }); }
  /** Accepted fenced releases in the current window (a crossing opens another window only when there is one). */
  get acceptedReleases(): number { return this.releases; }
  /** How many windows this budget has opened (1 until a limit is first crossed after an accepted release). */
  get windows(): number { return this.opened; }
  /** True once this budget itself refused its turn (checking:retained-budget). */
  get refused(): boolean { return this.sealed; }
  /** cause22: set once an owner turn's crossing was kept instead of refused: the counters first crossed and the windows opened that way. */
  get degraded(): Readonly<{ crossed: readonly string[]; windows: number }> | undefined {
    return this.degradedWindows ? Object.freeze({ crossed: this.degradedBy, windows: this.degradedWindows }) : undefined;
  }
  /** cause22: the owner's own turn. Bound once, before any release, by the code that owns the turn; never by a caller of charge(). */
  keepOwner(degrade: (crossed: readonly string[]) => void, oversize?: (kind: UpstreamOversize) => void): void {
    if (this.ownerDegrade || this.sealed || typeof degrade !== "function") return;
    this.ownerDegrade = degrade;
    if (typeof oversize === "function") this.ownerOversize = oversize;
  }
  /** cause22 r2: true while this budget is bound to the owner's own turn and has not refused. The upstream reader asks before it treats a
   * structural cap as a stop (upstream-reader.ts): only when EVERY budget of the read is owner-kept does the read stream past the cap. */
  get ownerKept(): boolean { return this.ownerDegrade !== undefined && !this.sealed; }
  /** cause22 r2: how many upstream events / collected bodies of this owner turn went past their cap, and how many the 64 MiB ceiling cut. */
  get oversized(): Readonly<{ event: number; body: number; cut: number }> { return Object.freeze({ ...this.oversizeSeen }); }
  /** cause22 r2: an owner turn's upstream read went past a structural cap and continued ("event", "body"), or the 64 MiB ceiling cut that
   * one event or body ("cut"). Recorded quietly: a count, one log line per kind (fixed words and numbers only), the turn's own record. */
  noteOversize(kind: UpstreamOversize): void {
    if (!this.ownerKept || !(kind in this.oversizeSeen)) return;
    if (++this.oversizeSeen[kind] === 1) {
      console.warn(kind === "cut"
        ? `[memory] upstream over the ${UPSTREAM_OWNER_HARD_MAX}-byte ceiling: that one event or body was cut; the owner turn continues`
        : `[memory] upstream ${kind} over its cap (${kind === "event" ? UPSTREAM_EVENT_MAX : UPSTREAM_COLLECTION_MAX} bytes) streamed on; the owner turn continues`);
    }
    try { this.ownerOversize?.(kind); } catch { /* the turn continues either way */ }
  }
  /** Context-free terminal control remains possible after any exhausted counter. */
  terminal(): boolean {
    if (this.terminalUsed) return false;
    this.terminalUsed = true;
    return true;
  }
  /** The release boundary only: a frame passed the retained fence and its destination accepted it. Never authority by itself. */
  accepted(): void { if (!this.sealed) this.releases++; }
  check(cost: ReleaseCost): void {
    const keys = Object.keys(RELEASE_LIMITS) as Array<keyof typeof RELEASE_LIMITS>;
    const invalid = COUNTERS.some(key => !Number.isSafeInteger(cost[key] ?? 0) || (cost[key] ?? 0) < 0);
    // cause22-no-transport-caps: a transport charge crosses nothing (see the class comment); only validity and the seal apply to it.
    const crossed = invalid || transport(cost) ? [] : keys.filter(key => this.used[key] + (cost[key] ?? 0) > RELEASE_LIMITS[key]);
    if (!this.sealed && !invalid && !crossed.length) return;
    const bounded = !this.sealed && !invalid && (transport(cost) || keys.every(key => (cost[key] ?? 0) <= RELEASE_LIMITS[key]));
    // cause22 caps: on the owner's own turn one cost above a whole limit (a 64 MiB frame delivered as one write) is not a refusal
    // either: no size stops that turn. An invalid cost is a bug, not a size, and still refuses; so does a sealed budget.
    const ownerOversize = !bounded && !this.sealed && !invalid && this.ownerDegrade !== undefined;
    if ((bounded && this.releases === 0 || ownerOversize) && this.ownerDegrade) {
      if (ownerOversize) this.releases = 0;
      // cause22: bookkeeping never stops the owner's turn. Counter names and counts only: never a ref, an id or text.
      this.opened++;
      if (++this.degradedWindows === 1) {
        this.degradedBy = Object.freeze([...crossed]);
        console.warn(`[memory] release budget degraded cause=checking:retained-budget (crossed ${crossed.join(",")} with no delivered reply); the owner turn continues`);
        try { this.ownerDegrade(this.degradedBy); } catch { /* the turn continues either way */ }
      } else if (this.degradedWindows % 64 === 0) console.warn(`[memory] release budget degraded windows=${this.degradedWindows}; the owner turn continues`);
      for (const key of keys) this.used[key] = 0;
      return;
    }
    if (bounded && this.releases > 0) {
      this.opened++;
      // counter names and counts only: never a ref, an id or text
      console.warn(`[memory] release budget window=${this.opened} opened (crossed ${crossed.join(",")} after ${this.releases} releases); the turn continues`);
      this.releases = 0;
      for (const key of keys) this.used[key] = 0;
      return;
    }
    const first = !this.sealed;
    this.sealed = true;
    if (first) this.refuse(BUDGET_VERDICT);
    throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED", fence: BUDGET_VERDICT });
  }
  charge(cost: ReleaseCost): void {
    this.check(cost);
    if (transport(cost)) { this.used.attempts += cost.attempts ?? 0; this.used.bytes += cost.bytes ?? 0; return; }
    for (const key of Object.keys(RELEASE_LIMITS) as Array<keyof typeof RELEASE_LIMITS>) this.used[key] += cost[key] ?? 0;
  }
}
/** A charge that moves bytes or makes an attempt. */
function transport(cost: ReleaseCost): boolean { return (cost.bytes ?? 0) > 0 || (cost.attempts ?? 0) > 0; }

// Synchronous scopes only: never carry a mutable ambient budget across an await.
let active: readonly ReleaseBudget[] = [];
export function withReleaseBudgets<T>(budgets: readonly ReleaseBudget[], work: () => T): T {
  const prior = active;
  active = [...new Set([...prior, ...budgets])];
  try {
    const result = work();
    if (result && typeof (result as { then?: unknown }).then === "function") {
      reserveRelease(active, { work: RELEASE_LIMITS.work + 1 });
      throw new Error("ASYNC_RELEASE_BUDGET_SCOPE");
    }
    return result;
  } finally { active = prior; }
}
/** Bounded bookkeeping that releases nothing (send-fence.ts keepOwnerTurn re-judging held refs one by one) runs outside the ambient budgets,
 * so an exhausted budget cannot turn keeping the owner's turn into stopping it. Synchronous only. */
export function outsideReleaseBudgets<T>(work: () => T): T {
  const prior = active;
  active = [];
  try { return work(); } finally { active = prior; }
}
export function chargeReleaseWork(work = 1): void { reserveRelease(active, { work }); }
export function chargeReleaseStatement(): void { reserveRelease(active, { statements: 1, work: 1 }); }
export function accountedPrepare<T extends object>(db: { prepare(sql: string): T }, sql: string): T {
  chargeReleaseWork();
  return accountedStatement(db.prepare(sql));
}

/** Charge all concrete members even when an earlier member refuses. */
export function reserveRelease(budgets: readonly ReleaseBudget[], cost: ReleaseCost): void {
  let failure: unknown;
  for (const budget of new Set(budgets)) {
    try { budget.charge(cost); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

/** Preflight mutations without charging an emitted attempt. The actual writer
 * must still reserve immediately before enqueue, after all validation. */
export function checkReleaseAvailable(budgets: readonly ReleaseBudget[], cost: ReleaseCost): void {
  let failure: unknown;
  for (const budget of new Set(budgets)) {
    try { budget.check(cost); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

/** Cache this wrapper with the prepared statement, not its reservation. Each
 * execution and each attempted row advance pays before entering SQLite. */
const meteredStatements = new WeakSet<object>();
export function accountedStatement<T extends object>(statement: T): T {
  if (meteredStatements.has(statement)) return statement;
  const wrapped = new Proxy(statement, { get(target, name) {
    const value = Reflect.get(target, name, target);
    if (typeof value !== "function") return value;
    if (!["get", "all", "run", "iterate"].includes(String(name))) return value.bind(target);
    return (...args: unknown[]) => {
      // Outside a release scope preserve the caller's SQLite method and its
      // existing I/O instrumentation. Cached wrappers decide at execution,
      // so the same statement still charges every row inside a later scope.
      // Iterators keep their wrapper: next() may enter a later budget scope.
      if (!active.length && name !== "iterate") return value.apply(target, args);
      chargeReleaseStatement();
      if (name === "all" || name === "iterate") {
        const iterate = Reflect.get(target, "iterate", target);
        if (typeof iterate === "function") {
          const source = iterate.apply(target, args);
          const rows = { [Symbol.iterator]() { return this; }, next() {
            try {
              chargeReleaseWork();
              return source.next();
            } catch (error) {
              // A failed reservation must release a live SQLite cursor too.
              // Iterator consumers need not call return() when next() throws.
              try { source.return?.(); } catch { /* preserve the refusal */ }
              throw error;
            }
          }, return() { return source.return?.() ?? { done: true }; } };
          return name === "all" ? Array.from(rows) : rows;
        }
      }
      chargeReleaseWork();
      const result = value.apply(target, args);
      if (name === "all") chargeReleaseWork(result.length);
      return result;
    };
  } });
  meteredStatements.add(wrapped);
  return wrapped;
}

const meteredDatabases = new WeakMap<object, object>();
/** Delegated marker helpers share this handle so their SQL cannot bypass the
 * caller's generation scope. Native methods retain the real SQLite receiver. */
export function accountedDatabase<T extends object>(db: T): T {
  const known = meteredDatabases.get(db);
  if (known) return known as T;
  const wrapped = new Proxy(db, { get(target, name) {
    const value = Reflect.get(target, name, target);
    if (typeof value !== "function") return value;
    if (name === "prepare") return (...args: unknown[]) => { chargeReleaseWork(); return accountedStatement(value.apply(target, args)); };
    if (name === "exec") return (...args: unknown[]) => { chargeReleaseStatement(); return value.apply(target, args); };
    return value.bind(target);
  } });
  meteredDatabases.set(db, wrapped); meteredDatabases.set(wrapped, wrapped);
  return wrapped;
}

/** Must be called on raw bytes, before TextDecoder, JSON parsing or buffer concatenation. */
/** cause22-no-transport-caps: no event or collection size refuses (the pending/collection arguments are kept for callers, unused). */
export function chargeUpstream(budgets: readonly ReleaseBudget[], bytes: number, _pendingBytes = 0, _collection = false): void {
  reserveRelease(budgets, { bytes, work: 1 });
}
