// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra round 6, finding 2: every write to a billing table goes through the lease-fenced writer, and a stale holder's write changes nothing.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { acquireHomeLease, fencedBatch, fencedRun, LeaseLost, q } from "../src/billing-lease";
import { defaultNotifier } from "../src/b5-billing";
import { DISPUTE_HELD_CODES, WAKE_HELD_BY_HOLD_SQL } from "../src/dispute-sql";
import billing from "../src/b5-billing.ts?raw";
import refunds from "../src/legal-refunds.ts?raw";
import routes from "../src/legal-routes.ts?raw";
import flows from "../src/legal-flows.ts?raw";
import intervals from "../src/service-intervals.ts?raw";

/** Tables whose rows are the billing state of a home. */
const BILLING_TABLES = ["billing_subscriptions", "refund_ops", "refund_invoice_ledger", "first_month_refunds", "withdrawals", "checkout_consents", "open_checkouts",
  "terms_change_notices", "terms_notice_obligations", "topup_settings", "topup_events", "cloud_payment_inbox", "abuse_closures", "sub_mutations", "first_invoice_holds", "billing_notices", "stripe_events", "billing_home_leases",
  // Astra round 10: service supplied is billing state (withdrawal deductions); the lifecycle only journals into service_interval_log.
  "service_intervals"];
const SOURCES: Record<string, string> = { "b5-billing.ts": billing, "legal-refunds.ts": refunds, "legal-routes.ts": routes, "legal-flows.ts": flows,
  "service-intervals.ts": intervals };
/** Unfenced writes that are allowed, each with its reason. Anything else fails. Each entry is the COMPLETE statement as written in the source
 *  (whitespace collapsed; a template's ${...} kept as written), compared for equality, never as a prefix (Astra MAILRETRY-3): a new clause
 *  appended to an allowed statement (or a different statement sharing its start) fails until it is reviewed and pinned here. */
const ALLOWED_WRITES: { file: string; sql: string; reason: string }[] = [
  { file: "b5-billing.ts", sql: "INSERT INTO stripe_events (id,type,payload,received_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING",
    reason: "receiving a webhook stores the raw event before any home is known; it changes no billing state" },
  // Lane C design 3: the only unfenced stripe_events updates (A1, A4/§5, A6, and the miss settlement of Astra MAILRETRY-3).
  { file: "b5-billing.ts", sql: "UPDATE stripe_events SET next_attempt_at=? WHERE id=? AND processed_at IS NULL AND COALESCE(next_attempt_at,received_at)<=?",
    reason: "the sweep's claim before an attempt: scheduling metadata only (the due time of a still-pending, due event), never attempts, error or completion" },
  { file: "b5-billing.ts", sql: "UPDATE stripe_events SET processed_at=?,error=?,next_attempt_at=NULL WHERE id=? AND processed_at IS NULL",
    reason: "the checkpoint of an outcome that is a property of the event itself (ignored_type, ignored_mode); never over a completed event" },
  { file: "b5-billing.ts", sql: "UPDATE stripe_events SET processed_at=?,error=?,next_attempt_at=NULL WHERE id=? AND processed_at IS NULL"
      + " AND NOT EXISTS (SELECT 1 FROM billing_subscriptions WHERE customer_id=?) AND NOT EXISTS (SELECT 1 FROM refund_ops WHERE id=? OR stripe_refund_id=?)"
      + " AND NOT EXISTS (SELECT 1 FROM refund_coverage WHERE payment_intent=?)",
    reason: "the checkpoint of a lookup miss settled by evidence or age, applied only while the binding / ledger row it missed is still absent (atomic re-check); never over a completed event" },
  { file: "b5-billing.ts", sql: "UPDATE stripe_events SET attempts=attempts+1,error=?,next_attempt_at=?+MIN(?,60000*(1<<MIN(attempts+1,12))) WHERE id=? AND processed_at IS NULL",
    reason: "retry bookkeeping for a failure BEFORE any lease was taken, on a pending event only; a failure inside the lease is recorded fenced, a lost lease records nothing" },
  { file: "b5-billing.ts", sql: "INSERT OR IGNORE INTO terms_notice_obligations (user_id,cloud_terms_version,tos_version,privacy_version,home_id,created_at,next_attempt_at)"
      + " SELECT h.owner_id, ?, ?, ?, MIN(b.home_id), ?, ? FROM billing_subscriptions b JOIN cloud_homes h ON h.id=b.home_id"
      + " WHERE b.status IN ('active','trialing','past_due') AND h.desired_state NOT IN ('deleted','deleting')"
      + " AND EXISTS (SELECT 1 FROM terms_acceptances a WHERE a.user_id=h.owner_id AND NOT (a.cloud_terms_version=? AND a.tos_version=? AND a.privacy_version=?)"
      + " AND ${acceptanceCounts(\"a\")})"
      + " AND NOT EXISTS (SELECT 1 FROM terms_notice_obligations o WHERE o.user_id=h.owner_id AND o.cloud_terms_version=? AND o.tos_version=? AND o.privacy_version=?)"
      + " GROUP BY h.owner_id LIMIT 500",
    reason: "queues that a notice is OWED (idempotent, one row per customer and version); it changes no subscription. Delivery and everything after it run under the home's lease" },
];
/** `.batch(` calls outside the fenced writer: only these (documents archive and user-level acceptances, no billing table). */
const ALLOWED_BATCHES: { file: string; contains: string; reason: string }[] = [
  { file: "b5-billing.ts", contains: "legacyAlertStmts", reason: "cloud_alerts only: the cutover guard's per-home legacy-reversal report (no billing state)" },
  { file: "b5-billing.ts", contains: "[checkpoint, ...unfencedStmts([...reconciled(target.outcome), ...resolveStuck()])]",
    reason: "an allowlisted no-lease checkpoint (immutable outcome or guarded miss settlement), its reconciliation and the stuck alert's resolution (cloud_alerts), both only once the event is processed, in one transaction" },
  { file: "b5-billing.ts", contains: '[env.DB.prepare("UPDATE stripe_events SET attempts=attempts+1,error=?,next_attempt_at=?+MIN(',
    reason: "the allowlisted pre-lease failure and its escalation (cloud_alerts only, pending-guarded, from the committed attempts) in one transaction" },
  { file: "b5-billing.ts", contains: "archiveCurrentDocs(env, now)", reason: "legal_doc_archive only (an idempotent archive of the current document texts)" },
  { file: "legal-routes.ts", contains: "...archiveCurrentDocs(env, now),", reason: "legal_doc_archive plus the user's own terms_acceptances row (user-level, no home or subscription)" },
  { file: "legal-routes.ts", contains: "SELECT * FROM billing_subscriptions WHERE home_id=?", reason: "the My Cloud summary: nine SELECTs in one round trip, no writes" },
  { file: "legal-routes.ts", contains: "UPDATE data_export_requests", reason: "the data export request (not a billing table)" },
  { file: "legal-routes.ts", contains: "SELECT created_at FROM cloud_outbox WHERE home_id=? AND kind='deleted'", reason: "the ended view of a deleted home (Astra R17 P2): two SELECTs in one round trip, no writes" },
  { file: "b5-billing.ts", contains: "orphanAlertBatch", reason: "cloud_alerts and the orphan's own cloud_ops_state review mark only (Astra TAXCOUNTRY-7 P2-e; no billing state, no lease needed)" },
  { file: "legal-routes.ts", contains: "IN_APP_CANCEL_INTENT_SQL} AND subscription_id=?", reason: "the in-app cancellation intent, persisted BEFORE the lease (Astra TAXCOUNTRY-8: cancelling is never gated): a monotonic revision bump bound to the subscription read, plus its resolution row; the leased sync re-reads the newest intent" },
  { file: "b5-billing.ts", contains: "SELECT 'alert:dispute_hold:'", reason: "G-F1: cloud_alerts and the dispute hold's own page mark only (dispute_holds is written before any home is known, so no lease can apply)" },
  { file: "b5-billing.ts", contains: "${WAKE_HELD_BY_HOLD_SQL} AND EXISTS (SELECT 1 FROM dispute_holds x WHERE x.event_id=?1 AND x.attributed_at IS NULL)",
    reason: "INTEGRATED-11/12: the operator's evidenced close of a dispute hold (dispute_holds, keyed by its event, never by a home), its cloud_alerts page, and the wake of the refunds it held (refund_ops.next_attempt_at only, WAKE_HELD_BY_HOLD_SQL)" },
  { file: "b5-billing.ts", contains: "env.DB.prepare(WAKE_HELD_BY_HOLD_SQL).bind(event.id, now),",
    reason: "INTEGRATED-12: a dispute hold's attribution resolved before any home is known (dispute_holds scope, or its unmatched release and cloud_alerts page) and the wake of the refunds it held (refund_ops.next_attempt_at only: makes them due now; every money step re-runs the gate under the lease)" },
  { file: "b5-billing.ts", contains: "env.DB.prepare(WAKE_HELD_BY_HOLD_SQL).bind(eventId, now),",
    reason: "INTEGRATED-13: a pending dispute hold's scope committed the moment it is known (dispute_holds, before any home is known) and the wake of the refunds its wider scope held (refund_ops next_attempt_at sooner only, and the release generation wake_gen: WAKE_HELD_BY_HOLD_SQL)" },
  { file: "b5-billing.ts", contains: "UPDATE payment_disputes SET polled_at", reason: "the open-dispute poll's bookkeeping (when it was read, failures) and its cloud_alerts page; the closure itself runs fenced through settleDispute" },
  { file: "legal-flows.ts", contains: "INSERT OR IGNORE INTO terms_acceptances", reason: "the order-submission acceptance and its once-only normalisation: terms_acceptances only (user-level, no home or subscription)" },
];

function writes(src: string) {
  const out: { table: string; sql: string }[] = [];
  for (const m of src.matchAll(/\.prepare\(\s*([`"'])([\s\S]*?)\1/g)) {
    const w = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(\w+)/i.exec(m[2]);
    if (w) out.push({ table: w[1], sql: m[2].trim().replace(/\s+/g, " ") });
  }
  return out;
}

/** EVERY source file of the control plane, not only the four billing modules: Astra round 8 found the lifecycle (b3-control) writing
 *  billing state directly. Outside the billing modules no file may write a billing table at all. */
// @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
const ALL_SOURCES = import.meta.glob("../src/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
/** The payment inbox is the hand-off from billing to the lifecycle: billing's inserts are fenced; the lifecycle only marks its own consumption. */
const LIFECYCLE_OWNED = ["cloud_payment_inbox"];
const BILLING_MODULES = ["b5-billing.ts", "legal-refunds.ts", "legal-routes.ts", "legal-flows.ts", "billing-lease.ts", "service-intervals.ts"];

describe("billing tables are written only by the billing modules", () => {
  it("no other source file (the lifecycle included) writes a billing table", () => {
    const stray: string[] = [];
    for (const [path, src] of Object.entries(ALL_SOURCES)) {
      const file = path.split("/").pop()!;
      if (BILLING_MODULES.includes(file)) continue;
      for (const w of writes(src)) if (BILLING_TABLES.includes(w.table) && !LIFECYCLE_OWNED.includes(w.table)) stray.push(`${file}: ${w.sql.slice(0, 100)}`);
    }
    expect(stray).toEqual([]);
  });
  it("the notifier's own writes are fenced (it needs the lease and writes billing_notices only through fencedRun)", () => {
    const notifier = billing.slice(billing.indexOf("export const defaultNotifier"), billing.indexOf("export interface BillingDependencies"));
    expect(notifier).toContain('throw new Error("lease_required")');
    expect(/\.prepare\(\s*[`"'](INSERT|UPDATE|DELETE)/.test(notifier)).toBe(false);
  });
});

describe("billing writes are fenced", () => {
  it("no billing module writes a billing table outside the fenced writer, except the explicit allowlist", () => {
    const unfenced: string[] = [];
    const used = new Set<string>();
    for (const [file, src] of Object.entries(SOURCES)) {
      for (const w of writes(src)) {
        if (!BILLING_TABLES.includes(w.table)) continue;
        const allowed = ALLOWED_WRITES.find((a) => a.file === file && w.sql === a.sql);
        if (allowed) used.add(`${a(allowed)}`); else unfenced.push(`${file}: ${w.sql}`);
      }
    }
    expect(unfenced).toEqual([]);
    // An allowlist entry that no longer matches anything is removed, not kept.
    expect([...used].sort()).toEqual(ALLOWED_WRITES.map(a).sort());
  });
  it("the allowlist is small and every entry says why", () => {
    expect(ALLOWED_WRITES).toHaveLength(6);
    expect(new Set(ALLOWED_WRITES.map(a)).size).toBe(6);
    // Exactly four unfenced updates of a stored event: the claim, the immutable-outcome checkpoint, the guarded miss settlement and the
    // pre-lease failure (lane C design 3 and Astra MAILRETRY-3).
    expect(ALLOWED_WRITES.filter((x) => x.sql.startsWith("UPDATE stripe_events")).map((x) => x.sql.split(" WHERE ")[0])).toEqual([
      "UPDATE stripe_events SET next_attempt_at=?", "UPDATE stripe_events SET processed_at=?,error=?,next_attempt_at=NULL",
      "UPDATE stripe_events SET processed_at=?,error=?,next_attempt_at=NULL", "UPDATE stripe_events SET attempts=attempts+1,error=?,next_attempt_at=?+MIN(?,60000*(1<<MIN(attempts+1,12)))"]);
    for (const a of ALLOWED_WRITES) expect(a.reason.length).toBeGreaterThan(20);
  });
  it("D1 batches in the billing modules are only the explicitly allowed non-billing ones", () => {
    const bad: string[] = [];
    for (const [file, src] of Object.entries(SOURCES)) {
      for (const m of src.matchAll(/DB\.batch\(([\s\S]{0,160})/g)) {
        if (!ALLOWED_BATCHES.some((a) => a.file === file && m[1].includes(a.contains))) bad.push(`${file}: DB.batch(${m[1].slice(0, 80)}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it("INTEGRATED-12/13: the only unfenced refund_ops write is the hold wake: next_attempt_at (sooner, never later) and the release generation wake_gen, never a decision or submission", () => {
    // INTEGRATED-13 P2: a held refund is due now; every unfinished refund in the hold's scope gets a new release generation (the fence of
    // a worker's failure backoff). Nothing else is written.
    expect(WAKE_HELD_BY_HOLD_SQL.split(" WHERE ")[0].replace(/\s+/g, " ")).toBe(
      `UPDATE refund_ops SET next_attempt_at=CASE WHEN last_error IN ${DISPUTE_HELD_CODES} AND COALESCE(next_attempt_at,0)>?2 THEN ?2 ELSE next_attempt_at END,wake_gen=wake_gen+1`);
    expect(WAKE_HELD_BY_HOLD_SQL).toContain("done_at IS NULL");
    // Used unfenced exactly three times in b5-billing.ts (a pending scope narrowed or resolved: narrowHold; unmatched release; operator
    // close); fenced at the checkpoint.
    expect(billing.match(/prepare\((?:`\$\{)?WAKE_HELD_BY_HOLD_SQL/g)?.length).toBe(3);
  });
  it("every billing write is reached through fencedRun / fencedBatch", () => {
    // The fenced calls exist in each module that writes billing state.
    expect(billing).toContain("fencedRun(env, lease,"); expect(refunds).toContain("fencedBatch(env, lease,");
    expect(routes).toContain("fencedBatch(env, lease,"); expect(flows).toContain("fencedBatch(env, lease,");
  });
});

const a = (x: { file: string; sql: string }) => `${x.file}|${x.sql}`;

describe("a stale lease holder's write changes nothing", () => {
  const seed = () => env.DB.prepare("INSERT OR REPLACE INTO billing_subscriptions (home_id,customer_id,plan,status,created_at,updated_at) VALUES ('fence-home','cus_f','starter','active',1,1)").run();
  const status = async () => (await env.DB.prepare("SELECT status FROM billing_subscriptions WHERE home_id='fence-home'").first<{ status: string }>())!.status;

  it("a takeover bumps the generation; the old token's UPDATE affects 0 rows and throws LeaseLost; the new token's write applies", async () => {
    await seed();
    const old = (await acquireHomeLease(env, "fence-home", "worker-old"))!;
    expect(old.generation).toBeGreaterThan(0);
    expect(await fencedRun(env, old, "UPDATE billing_subscriptions SET status='past_due' WHERE home_id='fence-home'")).toBe(1);
    expect(await acquireHomeLease(env, "fence-home", "worker-new")).toBeNull(); // still held
    await env.DB.prepare("UPDATE billing_home_leases SET lease_until=0 WHERE home_id='fence-home'").run(); // expiry, on the database's clock
    const next = (await acquireHomeLease(env, "fence-home", "worker-new"))!;
    expect(next.generation).toBe(old.generation + 1);
    await expect(fencedRun(env, old, "UPDATE billing_subscriptions SET status='active' WHERE home_id='fence-home'")).rejects.toBeInstanceOf(LeaseLost);
    expect(await status()).toBe("past_due");
    expect(await fencedRun(env, next, "UPDATE billing_subscriptions SET status='canceled' WHERE home_id='fence-home'")).toBe(1);
    expect(await status()).toBe("canceled");
  });
  it("a stale holder's INSERT and DELETE write nothing either", async () => {
    await seed();
    const old = (await acquireHomeLease(env, "fence-home", "w1"))!;
    await env.DB.prepare("UPDATE billing_home_leases SET lease_until=0").run();
    await acquireHomeLease(env, "fence-home", "w2");
    await expect(fencedRun(env, old, "INSERT INTO sub_mutations (id,home_id,subscription_id,desired_cancel,idempotency_key,state,created_at) VALUES (?,?,?,?,?,'pending',?)",
      "m1", "fence-home", "sub_x", 1, "k", 1)).rejects.toBeInstanceOf(LeaseLost);
    await expect(fencedRun(env, old, "DELETE FROM billing_subscriptions WHERE home_id='fence-home'")).rejects.toBeInstanceOf(LeaseLost);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sub_mutations").first()).toEqual({ n: 0 });
    expect(await status()).toBe("active");
  });
  it("a stale holder's whole batch rolls back", async () => {
    await seed();
    const old = (await acquireHomeLease(env, "fence-home", "b1"))!;
    await env.DB.prepare("UPDATE billing_home_leases SET lease_until=0").run();
    await acquireHomeLease(env, "fence-home", "b2");
    await expect(fencedBatch(env, old, [
      q("UPDATE billing_subscriptions SET status='disputed' WHERE home_id='fence-home'"),
      q("INSERT INTO sub_mutations (id,home_id,subscription_id,desired_cancel,idempotency_key,state,created_at) VALUES ('m2','fence-home','s',0,'k2','pending',1)"),
    ])).rejects.toBeInstanceOf(LeaseLost);
    expect(await status()).toBe("active");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sub_mutations").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_write_guards").first()).toEqual({ n: 0 });
  });
  it("lease time is the database's: a lease is live for about two minutes of real time, whatever the worker's clock says", async () => {
    const l = (await acquireHomeLease(env, "fence-home", "t1"))!;
    const row = (await env.DB.prepare("SELECT lease_until AS u FROM billing_home_leases WHERE home_id=?").bind(l.homeId).first<{ u: number }>())!;
    expect(Math.abs(row.u - (Date.now() + 120_000))).toBeLessThan(10_000);
  });
});

describe("Astra round 9: the default notifier writes nothing after losing the lease", () => {
  it("a paused send whose lease was taken over does not mark the notice sent; the next holder sends it again", async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES ('n-owner','N','n@example.test',1,1,1)`).run();
    const old = (await acquireHomeLease(env, "notice-home", "n1"))!;
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const sent: string[] = [];
    const email = { send: async (m: { subject: string }) => { sent.push(m.subject); if (sent.length === 1) await gate; } };
    const notice = { id: "payment_failed:notice-home:1", homeId: "notice-home", ownerId: "n-owner", kind: "payment_failed" as const, data: {} };
    const first = defaultNotifier.notify({ ...env, EMAIL: email } as never, notice, old);
    await new Promise((r) => setTimeout(r, 30));
    await env.DB.prepare("UPDATE billing_home_leases SET lease_until=0 WHERE home_id='notice-home'").run();
    const next = (await acquireHomeLease(env, "notice-home", "n2"))!;
    release();
    await expect(first).rejects.toBeInstanceOf(LeaseLost);
    expect(await env.DB.prepare("SELECT sent_at FROM billing_notices WHERE id=?").bind(notice.id).first()).toEqual({ sent_at: null });
    await env.DB.prepare("UPDATE billing_notices SET claimed_until=NULL WHERE id=?").bind(notice.id).run(); // the claim window passed
    await defaultNotifier.notify({ ...env, EMAIL: email } as never, notice, next);
    expect(sent).toHaveLength(2); // at least once
    expect(await env.DB.prepare("SELECT sent_at IS NOT NULL AS s FROM billing_notices WHERE id=?").bind(notice.id).first()).toEqual({ s: 1 });
  });
});
