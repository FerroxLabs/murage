// SPDX-License-Identifier: AGPL-3.0-or-later
// ONE per-home serializer for every billing operation (refunds, cancellation and renewal, the day-15 move, duplicate handling, terms
// enforcement, Stripe events, checkout, top-up, withdrawal): a D1 lease, the pattern cloud-v2/b4 uses for its per-home operation journal
// (b4-flux.ts "Per-home operation journal and lease"). The journal entries are the operations' own durable rows (refund_ops, sub_mutations,
// consents, terms_change_notices); each writes its intent before any Stripe call. A step is complete only after Stripe reads back the end
// state.
//
// FENCING. A lease token is {homeId, holder, generation}; the generation grows on every acquisition. The clock is the DATABASE's (a worker's
// Date.now() can be minutes off, and two workers must never disagree about who holds the lease). Every write to a billing table goes through
// `fencedRun` / `fencedBatch`, which add the lease predicate to the write itself, in the same statement or the same transaction: a worker
// that lost the lease in the middle of a Stripe call can finish the call but its write affects nothing (LeaseLost), so the next holder
// reconciles from Stripe's actual state and nothing stale is ever written back.
// D1 plus a lease rather than a Durable Object: the control plane has no DO binding.
import { heldBillingLease } from "./step-up-op";

export const BILLING_LEASE_MS = 2 * 60_000;
export class HomeBusy extends Error { constructor() { super("home_busy"); } }
export class LeaseLost extends Error { constructor() { super("lease_lost"); } }
export interface HomeLease { homeId: string; holder: string; generation: number }
/** A statement and its binds. Billing writes are passed around in this form and prepared only by the fenced writer. */
export type Q = [sql: string, binds?: unknown[]];
export const q = (sql: string, ...binds: unknown[]): Q => [sql, binds];
/** Milliseconds since the epoch, on the database's clock. */
export const DB_NOW = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const HELD = `EXISTS (SELECT 1 FROM billing_home_leases WHERE home_id=? AND holder=? AND generation=? AND lease_until>=${DB_NOW})`;
const heldBinds = (l: HomeLease) => [l.homeId, l.holder, l.generation];

export async function acquireHomeLease(env: Env, homeId: string, holder: string): Promise<HomeLease | null> {
  await env.DB.prepare("INSERT OR IGNORE INTO billing_home_leases (home_id,holder,lease_until) VALUES (?,NULL,NULL)").bind(homeId).run();
  const r = await env.DB.prepare(`UPDATE billing_home_leases SET holder=?,lease_until=${DB_NOW}+?,generation=generation+1
    WHERE home_id=? AND (holder IS NULL OR lease_until<${DB_NOW} OR holder=?)`).bind(holder, BILLING_LEASE_MS, homeId, holder).run();
  if (r.meta.changes !== 1) return null;
  const row = await env.DB.prepare("SELECT generation FROM billing_home_leases WHERE home_id=? AND holder=?").bind(homeId, holder).first<{ generation: number }>();
  return row ? { homeId, holder, generation: row.generation } : null;
}
/** Extends the lease; throws LeaseLost if it expired and someone else took it. Call before every Stripe mutation. */
export async function fence(env: Env, lease: HomeLease): Promise<void> {
  const r = await env.DB.prepare(`UPDATE billing_home_leases SET lease_until=${DB_NOW}+? WHERE home_id=? AND holder=? AND generation=? AND lease_until>=${DB_NOW}`)
    .bind(BILLING_LEASE_MS, lease.homeId, lease.holder, lease.generation).run();
  if (r.meta.changes !== 1) throw new LeaseLost();
}
/** For a fenced batch: extends the lease in the same transaction as the batch's writes (the batch's guard has just checked it is held). */
export const renewLeaseStatement = (lease: HomeLease): Q =>
  q(`UPDATE billing_home_leases SET lease_until=${DB_NOW}+? WHERE home_id=? AND holder=? AND generation=?`, BILLING_LEASE_MS, ...heldBinds(lease));
const stillHeld = async (env: Env, lease: HomeLease) =>
  (await env.DB.prepare(`SELECT 1 AS x WHERE ${HELD}`).bind(...heldBinds(lease)).first()) !== null;

/** Adds the lease condition to a write. UPDATE/DELETE: appended to the WHERE. INSERT ... VALUES: becomes INSERT ... SELECT ... WHERE. */
function fenceSql(sql: string, binds: unknown[], lease: HomeLease): [string, unknown[]] {
  const s = sql.trim().replace(/;$/, "");
  if (/^(UPDATE|DELETE)\b/i.test(s)) {
    if (!/\bWHERE\b/i.test(s)) throw new Error("fenced_write_needs_where");
    return [`${s} AND ${HELD}`, [...binds, ...heldBinds(lease)]];
  }
  const m = /^(INSERT\b[\s\S]*?)\bVALUES\s*\(([\s\S]*?)\)(\s*ON CONFLICT[\s\S]*)?$/i.exec(s);
  if (!m) throw new Error("fenced_write_unsupported");
  const tail = m[3] ?? "";
  // Bind order follows the text: the values, then the lease condition, then whatever the ON CONFLICT clause binds.
  const n = (m[2].match(/\?/g) ?? []).length;
  return [`${m[1]}SELECT ${m[2]} WHERE ${HELD}${tail}`, [...binds.slice(0, n), ...heldBinds(lease), ...binds.slice(n)]];
}
/** THE writer for billing tables: applies only while `lease` is still the home's lease (checked in the statement itself, on database time).
 *  Returns the rows changed. 0 rows because the lease is gone throws LeaseLost; 0 rows for any other reason (nothing matched) returns 0. */
export async function fencedRun(env: Env, lease: HomeLease, sql: string, ...binds: unknown[]): Promise<number> {
  const [s, b] = fenceSql(sql, binds, lease);
  const r = await env.DB.prepare(s).bind(...b).run();
  if (r.meta.changes === 0 && !(await stillHeld(env, lease))) throw new LeaseLost();
  return r.meta.changes;
}
/** Several writes as one transaction that rolls back whole when the lease is gone (a guard row whose value is the lease count, under the
 *  table's CHECK(ok=1)). Statements may refer to the previous one with changes(). Returns one result per statement. */
export async function fencedBatch(env: Env, lease: HomeLease, stmts: (Q | D1PreparedStatement)[]): Promise<D1Result[]> {
  const g = crypto.randomUUID();
  const guard = env.DB.prepare(`INSERT INTO cloud_write_guards VALUES (?,(SELECT COUNT(*) FROM billing_home_leases WHERE home_id=? AND holder=? AND generation=? AND lease_until>=${DB_NOW}))`)
    .bind(`${g}-lease`, ...heldBinds(lease));
  try {
    const res = await env.DB.batch([guard, ...stmts.map((st) => Array.isArray(st) ? env.DB.prepare(st[0]).bind(...(st[1] ?? [])) : st),
      env.DB.prepare("DELETE FROM cloud_write_guards WHERE id LIKE ?").bind(`${g}-%`)]);
    return res.slice(1, -1);
  } catch (e) {
    if (!(await stillHeld(env, lease))) throw new LeaseLost();
    throw e;
  }
}
export async function releaseHomeLease(env: Env, lease: HomeLease): Promise<void> {
  await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id=? AND holder=? AND generation=?").bind(lease.homeId, lease.holder, lease.generation).run();
}
/** Runs `work` holding the home's lease. Re-entrant: a caller already holding it (passed as `held`) keeps it. Busy: throws HomeBusy.
 *  A claimed step-up operation (step-up-op.ts) runs AS the holder of the lease its claim acquired atomically with consuming the approval:
 *  that lease is used (never released here; the operation's finalization does), and another home is refused. */
export async function withHomeLease<T>(env: Env, homeId: string, work: (lease: HomeLease) => Promise<T>, held?: HomeLease | null): Promise<T> {
  if (held && held.homeId === homeId) { await fence(env, held); return work(held); }
  const claimed = heldBillingLease(env, homeId);
  if (claimed) { await fence(env, claimed); return work(claimed); }
  const lease = await acquireHomeLease(env, homeId, crypto.randomUUID());
  if (!lease) throw new HomeBusy();
  try { return await work(lease); } finally { await releaseHomeLease(env, lease); }
}

// ---- the step-up claim (step-up-email.ts): the lease taken in the same batch that consumes an emailed approval --------------------------

/** No live holder of the home's lease other than `previous` (the superseded runner of the same step-up operation), on DB time. */
export const homeLeaseFree = (homeId: string, previous: string | null) => ({
  sql: `NOT EXISTS (SELECT 1 FROM billing_home_leases l WHERE l.home_id=? AND l.holder IS NOT NULL AND l.lease_until>=${DB_NOW} AND l.holder IS NOT ?)`,
  binds: [homeId, previous] as unknown[] });
/** The home's lease for `holder` (a new generation), applied only when `cond` holds (the claim took): the batch is all or nothing. */
export const claimHomeLeaseStatements = (db: D1Database, homeId: string, holder: string, cond: { sql: string; binds: unknown[] }): D1PreparedStatement[] => [
  db.prepare(`INSERT OR IGNORE INTO billing_home_leases (home_id,holder,lease_until) SELECT ?,NULL,NULL WHERE ${cond.sql}`).bind(homeId, ...cond.binds),
  db.prepare(`UPDATE billing_home_leases SET holder=?,lease_until=${DB_NOW}+?,generation=generation+1 WHERE home_id=? AND ${cond.sql}`)
    .bind(holder, BILLING_LEASE_MS, homeId, ...cond.binds),
];
/** Releases the lease only if `holder` still holds it (never anybody else's). */
export const releaseHomeLeaseOf = (db: D1Database, homeId: string, holder: string): D1PreparedStatement =>
  db.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id=? AND holder=?").bind(homeId, holder);
