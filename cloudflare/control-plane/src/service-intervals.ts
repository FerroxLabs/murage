// SPDX-License-Identifier: AGPL-3.0-or-later
// Service actually supplied (withdrawal deductions count only this), as intervals per home and contract (service_intervals).
//
// service_intervals is billing state: it is written ONLY under the home's billing lease (fencedBatch). The lifecycle (b3-control) never
// writes it. Its state changes append to its own journal, service_interval_log, in the same batch as the state change (so nothing is
// lost and the order is kept), and the journal is applied to service_intervals under the lease: right after the transition when the home
// is not busy, by every billing operation that reads the intervals (it holds the lease and applies first), and by the billing sweep.
import { fencedBatch, HomeBusy, LeaseLost, q, withHomeLease, type HomeLease } from "./billing-lease";

/** States where the home is served (the canary passed) and states where it stops being served. */
export const SERVICE_STARTS = ["ready"];
export const SERVICE_ENDS = ["suspended", "stopped", "deleting", "deleted", "failed"];

/** The lifecycle's journal entry for a state change (to be put in the transition's own batch), or null when the state does not start or
 *  end service. The contract is READ from the billing record at that moment; nothing is written to a billing table. */
export function serviceLogStatement(db: D1Database, homeId: string, state: string, now: number): D1PreparedStatement | null {
  const kind = SERVICE_STARTS.includes(state) ? "start" : SERVICE_ENDS.includes(state) ? "end" : null;
  if (!kind) return null;
  return db.prepare(`INSERT INTO service_interval_log (home_id,kind,at,subscription_id,created_at)
    VALUES (?,?,?,(SELECT subscription_id FROM billing_subscriptions WHERE home_id=?),?)`).bind(homeId, kind, now, homeId, now);
}

interface LogRow { id: number; kind: "start" | "end"; at: number; subscription_id: string | null }

/** Applies the home's pending journal entries to service_intervals, in order, under `lease`. Each entry is applied and marked in ONE fenced
 *  transaction: a worker that lost the lease applies nothing. Idempotent. */
export async function applyServiceLog(env: Env, lease: HomeLease): Promise<number> {
  const rows = await env.DB.prepare("SELECT id,kind,at,subscription_id FROM service_interval_log WHERE home_id=? AND applied_at IS NULL ORDER BY id LIMIT 100")
    .bind(lease.homeId).all<LogRow>();
  for (const r of rows.results) {
    const apply = r.kind === "start"
      // One open interval per home: a start while one is open (a replacement contract opened its own) changes nothing.
      ? q(`INSERT INTO service_intervals (home_id,started_at,subscription_id) SELECT ?,?,? WHERE NOT EXISTS
          (SELECT 1 FROM service_intervals WHERE home_id=? AND ended_at IS NULL)`, lease.homeId, r.at, r.subscription_id, lease.homeId)
      // Service stopped at `at`: the interval running at that moment ends there (also one already closed later by a replacement claim).
      : q("UPDATE service_intervals SET ended_at=? WHERE home_id=? AND started_at<=? AND (ended_at IS NULL OR ended_at>?)", r.at, lease.homeId, r.at, r.at);
    await fencedBatch(env, lease, [apply, q("UPDATE service_interval_log SET applied_at=? WHERE id=? AND applied_at IS NULL", Date.now(), r.id)]);
  }
  return rows.results.length;
}

/** Best effort right after a lifecycle transition: apply now if the home's billing lease is free; a busy home is applied by its holder or the
 *  billing sweep. Never fails the transition. */
export async function applyServiceLogSoon(env: Env, homeId: string): Promise<void> {
  // The transition is already committed: whatever happens here (a busy home, a lost lease, an error), the journal stays and is applied later.
  try { await withHomeLease(env, homeId, (lease) => applyServiceLog(env, lease)); }
  catch (e) { if (!(e instanceof HomeBusy || e instanceof LeaseLost)) console.warn("service_log_apply_deferred"); }
}
