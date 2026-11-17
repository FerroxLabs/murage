// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture measurement owner: c3-memory. Checked statement producer: sfx-fixture.
export interface SqlReadObserver {
  call(sql: string, method: string, args: unknown[]): void;
  rows?(count: number): void;
  includeRuns?: boolean;
}
const observed = new WeakMap<object, Set<SqlReadObserver>>();

/** Checked all() consumes iterate() to charge before each row. Observe that
 * physical entry too, so statement/row caps and bound-argument audits still
 * measure the actual reads. Reused prepared statements are wrapped once. */
export function observeSqlReads<T extends object>(statement: T, sql: string, observer: SqlReadObserver): T {
  let watchers = observed.get(statement);
  if (!watchers) observed.set(statement, watchers = new Set());
  if (watchers.has(observer)) return statement;
  watchers.add(observer);
  const target = statement as Record<string, (...args: unknown[]) => any>;
  for (const method of ["get", "all", "iterate", ...(observer.includeRuns ? ["run"] : [])]) {
    const original = target[method]?.bind(statement);
    if (!original) continue;
    target[method] = (...args: unknown[]) => {
      observer.call(sql, method, args);
      const value = original(...args);
      if (method === "get") observer.rows?.(value ? 1 : 0);
      else if (method === "all") observer.rows?.(value.length);
      else if (method === "iterate") {
        const source = value as IterableIterator<unknown>;
        return {
          next() { const row = source.next(); if (!row.done) observer.rows?.(1); return row; },
          return(value?: unknown) { return source.return?.(value) ?? { done: true, value }; },
          [Symbol.iterator]() { return this; },
        };
      }
      return value;
    };
  }
  return statement;
}
