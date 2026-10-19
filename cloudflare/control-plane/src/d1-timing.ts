// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-request D1 timing for the Server-Timing header: how many round trips a request made and how long they took.
// A Proxy over the D1 binding; statements are unwrapped again before db.batch() so D1 sees only its own objects.
export interface D1Stats { queries: number; batches: number; ms: number }

export function timeD1(db: D1Database): { db: D1Database; stats: D1Stats } {
  const stats: D1Stats = { queries: 0, batches: 0, ms: 0 };
  const real = new WeakMap<object, D1PreparedStatement>();
  const timed = async <T>(run: () => Promise<T>, kind: "query" | "batch"): Promise<T> => {
    const t0 = Date.now();
    try { return await run(); } finally {
      stats.ms += Date.now() - t0;
      if (kind === "batch") stats.batches++; else stats.queries++;
    }
  };
  const wrapStatement = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => wrapStatement(target.bind(...args));
        if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
          return (...args: unknown[]) => timed(() => (target[prop] as (...a: unknown[]) => Promise<unknown>)(...args), "query");
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    real.set(proxy, stmt);
    return proxy;
  };
  const unwrap = (s: D1PreparedStatement) => real.get(s) ?? s;
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrapStatement(target.prepare(sql));
      if (prop === "batch") return (statements: D1PreparedStatement[]) => timed(() => target.batch(statements.map(unwrap)), "batch");
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: wrapped, stats };
}

export const serverTiming = (stats: D1Stats, totalMs: number) =>
  `d1;dur=${stats.ms};desc="${stats.queries}q+${stats.batches}b", total;dur=${totalMs}`;
