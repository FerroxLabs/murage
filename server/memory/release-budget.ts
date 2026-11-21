// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LineageVerdict } from "./lineage-types.ts";

export const RELEASE_LIMITS = Object.freeze({ attempts: 4096, bytes: 64 * 1024 * 1024, work: 16_777_216, statements: 65_536 });
export const RELEASE_CHUNK_MAX = 64 * 1024;
export const UPSTREAM_EVENT_MAX = 1024 * 1024;
export const UPSTREAM_COLLECTION_MAX = 8 * 1024 * 1024;
export type ReleaseCost = Partial<Record<keyof typeof RELEASE_LIMITS, number>>;
export const BUDGET_VERDICT: LineageVerdict = Object.freeze({ state: "checking", reason: "retained-budget" });

/** Owned by one concrete generation. Counters cannot be renewed or refunded. */
export class ReleaseBudget {
  private readonly used = { attempts: 0, bytes: 0, work: 0, statements: 0 };
  private sealed = false;
  private terminalUsed = false;
  readonly refuse: (verdict: LineageVerdict) => void;
  constructor(refuse: (verdict: LineageVerdict) => void) { this.refuse = refuse; }
  get counts(): Readonly<typeof this.used> { return Object.freeze({ ...this.used }); }
  /** Context-free terminal control remains possible after any exhausted counter. */
  terminal(): boolean {
    if (this.terminalUsed) return false;
    this.terminalUsed = true;
    return true;
  }
  check(cost: ReleaseCost): void {
    const keys = Object.keys(RELEASE_LIMITS) as Array<keyof typeof RELEASE_LIMITS>;
    if (this.sealed || keys.some(key => !Number.isSafeInteger(cost[key] ?? 0) || (cost[key] ?? 0) < 0 || this.used[key] + (cost[key] ?? 0) > RELEASE_LIMITS[key])) {
      const first = !this.sealed;
      this.sealed = true;
      if (first) this.refuse(BUDGET_VERDICT);
      throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED", fence: BUDGET_VERDICT });
    }
  }
  charge(cost: ReleaseCost): void {
    this.check(cost);
    for (const key of Object.keys(RELEASE_LIMITS) as Array<keyof typeof RELEASE_LIMITS>) this.used[key] += cost[key] ?? 0;
  }
}

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
export function chargeUpstream(budgets: readonly ReleaseBudget[], bytes: number, pendingBytes: number, collection = false): void {
  reserveRelease(budgets, { bytes, work: 1 });
  if (pendingBytes > (collection ? UPSTREAM_COLLECTION_MAX : UPSTREAM_EVENT_MAX)) {
    reserveRelease(budgets, { bytes: RELEASE_LIMITS.bytes + 1 });
  }
}
