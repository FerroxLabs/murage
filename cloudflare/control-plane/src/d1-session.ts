// SPDX-License-Identifier: AGPL-3.0-or-later
// D1 read replication, via the Sessions API. The D1 primary sits in one region (staging: APAC/SIN) and a Worker in
// another (Vercel iad1 callers land on EWR) pays a full ocean round trip per query: measured 260 ms each, so the 15
// sequential queries behind GET /v1/account/cloud cost 3.9 s. A replica next to the Worker answers in about 11 ms.
//
// Only the read-only customer GETs below read from a replica ("first-unconstrained"). The customer's own writes
// (/v1/account/*, /v1/billing/*) run on the primary in a session so their response can carry x-d1-bookmark, and a
// client that wants to read its own write sends the bookmark back and is served by a replica at least that fresh.
// Every other route (machines, B3, pairing, auth, the cron) gets the raw binding, exactly as before.
export const BOOKMARK_HEADER = "x-d1-bookmark";
export const REPLICA_READ_PATHS: ReadonlySet<string> = new Set(["/v1/account/cloud", "/v1/homes"]);

const BOOKMARK_SHAPE = /^[\w.-]{1,256}$/;

export interface D1Sessioned { db: D1Database; bookmark: () => string | null }

export function sessionFor(db: D1Database, request: Request): D1Sessioned {
  if (typeof db.withSession !== "function") return { db, bookmark: () => null };
  const sent = request.headers.get(BOOKMARK_HEADER);
  const { pathname } = new URL(request.url);
  const replicaOk = request.method === "GET" && REPLICA_READ_PATHS.has(pathname);
  const customerWrite = request.method !== "GET" && (pathname.startsWith("/v1/account/") || pathname.startsWith("/v1/billing/"));
  const bookmark = sent && BOOKMARK_SHAPE.test(sent) ? sent : null;
  if (!replicaOk && !customerWrite) return { db, bookmark: () => null };
  const constraint = replicaOk ? (bookmark ?? "first-unconstrained") : "first-primary";
  const session = db.withSession(constraint);
  // A binding look-alike: queries go through the session, exec() and dump() stay on the binding (Better Auth sniffs for them).
  const facade = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => session.prepare(sql);
      if (prop === "batch") return (statements: D1PreparedStatement[]) => session.batch(statements);
      // The raw binding, for the one write a read-only GET makes (see cloud-accounts.ts): a write inside the session would
      // pin every later read of the request to the primary.
      if (prop === "primary") return target;
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: facade, bookmark: () => { try { return session.getBookmark(); } catch { return null; } } };
}
