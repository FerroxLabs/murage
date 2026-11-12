// SPDX-License-Identifier: AGPL-3.0-or-later
// Murage Cloud referral partners: every PAYING member is enrolled as a FirstPromoter promoter (campaign "Murage Cloud: Customers"), so
// they can fetch their own referral link (GET /v1/account/referral, members-api.ts).
//   - Queued when the member's first invoice is paid (b5-billing.ts invoice.paid), never on a reserved, unpaid or failed-payment home.
//   - Non-blocking: a FirstPromoter failure is recorded on the row and retried by the billing sweep with backoff; it never throws into
//     billing or provisioning. After REFERRAL_ALERT_AFTER failures an ops alert is raised.
//   - The address is ALWAYS the one reconciled with Supabase Auth right now (reconciledContactEmail through the identity reader, as the door
//     notices do): a stored address can be stale (a Google address can change hands), and the welcome mail goes to it. Conflict (409),
//     reader down (503) or no identity: a fixed error is recorded, NO FirstPromoter call is made, and the sweep retries.
//   - Only a member with a live home (not deleting or deleted) and an unrefunded paid first invoice is queued or shown a link.
//   - Idempotent: one row per member. A duplicate email (FirstPromoter 400 "email has already been taken") is NOT looked up: FirstPromoter
//     v2 has no lookup by email that keeps the address out of the URL (GET /promoters?q= and GET /promoters/{email}?find_by=email put it in
//     the query or path, so in FirstPromoter's access logs) and the 400 body names no promoter. The row is set to state 'manual' with
//     last_error fp_email_taken: it needs a manual link, and is never retried. Any other 400 is an error and stores nothing.
//   - Without FIRSTPROMOTER_API_KEY / FIRSTPROMOTER_ACCOUNT_ID enrollment is skipped with a logged warning (rows stay pending).
import { reconciledContactEmail } from "./cloud-accounts";
import { HTTPError } from "./http";
import type { IdentityReader } from "./public-tokens";

declare global {
  interface Env { FIRSTPROMOTER_API_KEY?: string; FIRSTPROMOTER_ACCOUNT_ID?: string }
  namespace Cloudflare { interface Env { FIRSTPROMOTER_API_KEY?: string; FIRSTPROMOTER_ACCOUNT_ID?: string } }
}

export const FP_API_BASE = "https://api.firstpromoter.com/api/v2/company";
/** The default campaign "Murage Cloud: Customers". */
export const FP_CAMPAIGN_ID = 44526;
export const REFERRAL_LINK_BASE = "https://murage.ai/?fpr=";
export const REFERRAL_PORTAL_URL = "https://murage.firstpromoter.com";
/** The Murage Cloud campaigns and what each pays (percent of each sale, for this many months). An unknown campaign shows no rate: never guessed. */
export const CAMPAIGN_TERMS: Readonly<Record<number, { rate: number; months: number }>> = {
  44526: { rate: 20, months: 12 }, // Customers
  44530: { rate: 25, months: 12 }, // Customers 25%
  44531: { rate: 30, months: 12 }, // Customers 30%
  44527: { rate: 25, months: 12 }, // Founders
  44528: { rate: 30, months: 12 }, // Certified Builders
  44529: { rate: 30, months: 24 }, // Enterprise Partners
};
const DAY_MS = 86_400_000;
const REFRESH_BATCH = 20;
export const REFERRAL_ALERT_AFTER = 5;
const FP_TIMEOUT_MS = 6000;
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
export const referralBackoff = (attempts: number) => BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1]!;

export interface ReferralDeps { firstPromoterFetch?: typeof fetch; now?: () => number; reader?: IdentityReader | null; readerTimeoutMs?: number }

/** SQL: the member (a user id expression) has a live home with a paid first invoice that no decided refund covers. */
const eligible = (user: string) => `EXISTS (SELECT 1 FROM billing_subscriptions es JOIN cloud_homes eh ON eh.id=es.home_id
  WHERE eh.owner_id=${user} AND es.first_invoice_id IS NOT NULL AND eh.desired_state NOT IN ('deleting','deleted')
    AND eh.entitlement NOT IN ('refund_pending','refunded')
    AND NOT EXISTS (SELECT 1 FROM refund_ops eo WHERE eo.invoice_id=es.first_invoice_id AND eo.decided_at IS NOT NULL
      AND COALESCE(eo.stripe_refund_status,'') NOT IN ('failed','canceled') AND COALESCE(eo.refund_status,'') NOT IN ('failed','canceled'))
    AND NOT EXISTS (SELECT 1 FROM cloud_outbox ob WHERE ob.id='refund:retired:' || es.first_invoice_id)
    AND NOT EXISTS (SELECT 1 FROM refund_ops en WHERE en.id='no_capacity:' || es.first_invoice_id))`;
const isEligible = async (env: Env, userId: string) => (await env.DB.prepare(`SELECT ${eligible("?")} AS ok`).bind(userId).first<{ ok: number }>())?.ok === 1;

/** The member's address, reconciled with Supabase now. Throws FpError with a fixed code (never the address) when it cannot be confirmed. */
async function reconciledEmail(env: Env, deps: ReferralDeps, userId: string, now: number): Promise<string> {
  const { readerUser } = await import("./door"); // door imports b5-billing, which imports this file: loaded lazily
  let email: string | null;
  try { email = await reconciledContactEmail(env.DB, userId, now, readerUser(env, { reader: deps.reader, readerTimeoutMs: deps.readerTimeoutMs })); }
  catch (e) {
    if (e instanceof HTTPError && e.status === 409) throw new FpError("email_conflict");
    if (e instanceof HTTPError && e.status === 503) throw new FpError("identity_unavailable");
    throw new FpError("identity_error");
  }
  if (!email) throw new FpError("no_email");
  return email;
}

interface Promoted { id: number; refToken: string | null; campaignId: number | null }
class FpError extends Error {}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});

/** The promoter id and its campaign ref token, from a FirstPromoter promoter object (the campaign's own token when it has one). */
function promoterOf(body: unknown): Promoted | null {
  const p = record(body);
  if (typeof p.id !== "number") return null;
  const camps = Array.isArray(p.promoter_campaigns) ? p.promoter_campaigns.map(record) : [];
  // The campaign the member is really in: the highest-paying Murage Cloud campaign (a tie goes to the longer term). One with no known terms
  // ranks below every known one, and one with no ref token cannot give a link.
  const rank = (c: Record<string, unknown>) => { const t = CAMPAIGN_TERMS[c.campaign_id as number]; return t ? t.rate * 1000 + t.months : -1; };
  const withToken = camps.filter((c) => typeof c.ref_token === "string" && /^[\w-]{1,64}$/.test(c.ref_token));
  const mine = withToken.reduce<Record<string, unknown> | undefined>((best, c) => (best === undefined || rank(c) > rank(best) ? c : best), undefined);
  return { id: p.id, refToken: (mine?.ref_token as string | undefined) ?? null, campaignId: typeof mine?.campaign_id === "number" ? mine.campaign_id : null };
}

async function fp(env: Env, deps: ReferralDeps, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const f = deps.firstPromoterFetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${FP_API_BASE}${path}`, { method, signal: AbortSignal.timeout(FP_TIMEOUT_MS),
      headers: { authorization: `Bearer ${env.FIRSTPROMOTER_API_KEY}`, "Account-ID": env.FIRSTPROMOTER_ACCOUNT_ID!, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new FpError("fp_unreachable"); }
  let json: unknown = null;
  try { json = await res.json(); } catch { /* an empty or non-JSON body */ }
  return { status: res.status, json };
}

/** FirstPromoter's duplicate-email 400 only: an "email ... taken" validation error. Any other 400 is an error. */
const isEmailTaken = (body: unknown): boolean => {
  const em = record(record(body).errors).email;
  const msgs = Array.isArray(em) ? em : typeof em === "string" ? [em] : [];
  return msgs.some((m) => typeof m === "string" && /taken|already exists|already been/i.test(m));
};

const firstName = (name: string | null | undefined): string | null => {
  const n = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return n && !n.includes("@") && n.length <= 60 ? n : null;
};

/** Queue a member for enrollment. Idempotent (one row per member); an enrolled member is left as is. */
export async function queueReferralEnrollment(env: Env, userId: string, homeId: string, now: number): Promise<void> {
  await env.DB.prepare("INSERT INTO cloud_referral_partners (user_id,home_id,state,next_attempt_at,created_at,updated_at) VALUES (?,?,'pending',0,?,?) ON CONFLICT DO NOTHING")
    .bind(userId, homeId, now, now).run();
}

async function failed(env: Env, userId: string, homeId: string, error: string, now: number): Promise<void> {
  const r = await env.DB.prepare("UPDATE cloud_referral_partners SET attempts=attempts+1,last_error=?,updated_at=? WHERE user_id=? AND state='pending' RETURNING attempts")
    .bind(error, now, userId).first<{ attempts: number }>();
  if (!r) return;
  await env.DB.prepare("UPDATE cloud_referral_partners SET next_attempt_at=? WHERE user_id=?").bind(now + referralBackoff(r.attempts), userId).run();
  if (r.attempts >= REFERRAL_ALERT_AFTER) {
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
      .bind(`referral:${userId}`, homeId, "referral.enroll_failing", "warning", JSON.stringify({ userId, attempts: r.attempts, error }), now).run();
    await env.DB.prepare("UPDATE cloud_referral_partners SET alerted_at=? WHERE user_id=? AND alerted_at IS NULL").bind(now, userId).run();
  }
}

/** One enrollment attempt for a queued member. Never throws: a failure is recorded on the row and retried by the sweep. */
export async function enrollReferral(env: Env, userId: string, deps: ReferralDeps = {}): Promise<"active" | "pending" | "skipped"> {
  const now = (deps.now ?? Date.now)();
  try {
    const row = await env.DB.prepare("SELECT home_id,state,promoter_id FROM cloud_referral_partners WHERE user_id=?").bind(userId)
      .first<{ home_id: string; state: string; promoter_id: number | null }>();
    if (!row) return "skipped";
    if (row.state === "active") return "active";
    if (row.state !== "pending") return "skipped";
    if (!(await isEligible(env, userId))) return "skipped";
    if (!env.FIRSTPROMOTER_API_KEY || !env.FIRSTPROMOTER_ACCOUNT_ID) {
      console.warn(JSON.stringify({ message: "referral enrollment skipped: FirstPromoter is not configured" }));
      return "skipped";
    }
    try {
      let found: Promoted | null = null;
      if (row.promoter_id !== null) {
        const g = await fp(env, deps, "GET", `/promoters/${row.promoter_id}`);
        if (g.status >= 200 && g.status < 300) found = promoterOf(g.json);
        else throw new FpError(`fp_${g.status}`);
      } else {
        const email = await reconciledEmail(env, deps, userId, now);
        const name = await env.DB.prepare(`SELECT name FROM "user" WHERE id=?`).bind(userId).first<{ name: string }>();
        const fn = firstName(name?.name);
        // drip_emails is FirstPromoter's only documented welcome-email flag ("Send a welcome email to the promoter"): the member needs it to
        // reach the portal and set a password.
        const c = await fp(env, deps, "POST", "/promoters", { email, initial_campaign_id: FP_CAMPAIGN_ID, always_approve: true, drip_emails: true,
          ...(fn ? { profile: { first_name: fn } } : {}) });
        if (c.status >= 200 && c.status < 300) found = promoterOf(c.json);
        else if (c.status === 400 && isEmailTaken(c.json)) {
          // Not looked up (see the header): marked for a manual link, never retried.
          await env.DB.prepare("UPDATE cloud_referral_partners SET state='manual',last_error='fp_email_taken',updated_at=? WHERE user_id=? AND state='pending'").bind(now, userId).run();
          return "pending";
        } else throw new FpError(`fp_${c.status}`);
      }
      if (!found) throw new FpError("fp_bad_response");
      // The promoter id is kept even before a token is known, so the retry reads that promoter instead of creating another.
      const done = found.refToken !== null;
      await env.DB.prepare("UPDATE cloud_referral_partners SET promoter_id=?,ref_token=?,campaign_id=?,campaign_checked_at=?,state=?,last_error=?,updated_at=? WHERE user_id=?")
        .bind(found.id, found.refToken, found.campaignId, now, done ? "active" : "pending", done ? null : "fp_no_ref_token", now, userId).run();
      if (!done) { await failed(env, userId, row.home_id, "fp_no_ref_token", now); return "pending"; }
      await env.DB.prepare("UPDATE cloud_alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL").bind(now, `referral:${userId}`).run();
      return "active";
    } catch (e) {
      await failed(env, userId, row.home_id, e instanceof FpError ? e.message : "fp_error", now);
      return "pending";
    }
  } catch (e) {
    console.warn(JSON.stringify({ message: "referral enrollment error", error: e instanceof Error ? e.message : "error" }));
    return "pending";
  }
}

/** Called when a member's first invoice is paid: queue and try once. Never throws. */
export async function referralOnPaid(env: Env, deps: ReferralDeps, homeId: string, now: number): Promise<void> {
  try {
    const h = await env.DB.prepare("SELECT owner_id FROM cloud_homes WHERE id=?").bind(homeId).first<{ owner_id: string }>();
    if (!h || !(await isEligible(env, h.owner_id))) return;
    await queueReferralEnrollment(env, h.owner_id, homeId, now);
    await enrollReferral(env, h.owner_id, deps);
  } catch (e) {
    console.warn(JSON.stringify({ message: "referral queue error", error: e instanceof Error ? e.message : "error" }));
  }
}

/** The sweep: owners of paid homes that have no row yet are queued (members who paid before this shipped), then due rows are retried. */
export async function sweepReferralEnrollments(env: Env, deps: ReferralDeps = {}): Promise<void> {
  const now = (deps.now ?? Date.now)();
  if (!env.FIRSTPROMOTER_API_KEY || !env.FIRSTPROMOTER_ACCOUNT_ID) return;
  const missing = await env.DB.prepare(`SELECT h.owner_id AS u, h.id AS home FROM cloud_homes h
    WHERE ${eligible("h.owner_id")} AND NOT EXISTS (SELECT 1 FROM cloud_referral_partners r WHERE r.user_id=h.owner_id)
    GROUP BY h.owner_id LIMIT 20`).all<{ u: string; home: string }>();
  for (const m of missing.results) await queueReferralEnrollment(env, m.u, m.home, now);
  const due = await env.DB.prepare(`SELECT user_id FROM cloud_referral_partners WHERE state='pending' AND next_attempt_at<=? AND ${eligible("user_id")} ORDER BY next_attempt_at LIMIT 20`).bind(now)
    .all<{ user_id: string }>();
  for (const d of due.results) await enrollReferral(env, d.user_id, deps);
  await refreshCampaigns(env, deps, now);
}

/** An active promoter's campaign is re-read from FirstPromoter at most once a day (a read-only GET each, REFRESH_BATCH per sweep). A promoter
 *  is stamped BEFORE the read, so a failing one waits an hour and never starves the others or hammers FirstPromoter. */
async function refreshCampaigns(env: Env, deps: ReferralDeps, now: number): Promise<void> {
  const rows = await env.DB.prepare("SELECT user_id,promoter_id FROM cloud_referral_partners WHERE state='active' AND promoter_id IS NOT NULL AND campaign_checked_at<=? ORDER BY campaign_checked_at LIMIT ?")
    .bind(now - DAY_MS, REFRESH_BATCH).all<{ user_id: string; promoter_id: number }>();
  for (const r of rows.results) {
    await env.DB.prepare("UPDATE cloud_referral_partners SET campaign_checked_at=? WHERE user_id=?").bind(now - DAY_MS + 3_600_000, r.user_id).run();
    try {
      const g = await fp(env, deps, "GET", `/promoters/${r.promoter_id}`);
      const found = g.status >= 200 && g.status < 300 ? promoterOf(g.json) : null;
      if (!found || found.refToken === null) continue;
      await env.DB.prepare("UPDATE cloud_referral_partners SET ref_token=?,campaign_id=?,campaign_checked_at=?,updated_at=? WHERE user_id=?")
        .bind(found.refToken, found.campaignId, now, now, r.user_id).run();
    } catch { /* retried in an hour */ }
  }
}

export type ReferralAnswer = { status: "active" | "pending" | "none"; link: string | null; portalUrl: string; rate?: number; months?: number };

/** What GET /v1/account/referral answers. "none": the member has never paid, or has no live paid home (deleting or deleted, or refunded). */
export async function referralFor(env: Env, userId: string): Promise<ReferralAnswer> {
  const none: ReferralAnswer = { status: "none", link: null, portalUrl: REFERRAL_PORTAL_URL };
  if (!(await isEligible(env, userId))) return none;
  const row = await env.DB.prepare("SELECT state,ref_token,campaign_id FROM cloud_referral_partners WHERE user_id=?").bind(userId).first<{ state: string; ref_token: string | null; campaign_id: number | null }>();
  if (row?.state === "active" && row.ref_token) {
    const terms = row.campaign_id !== null ? CAMPAIGN_TERMS[row.campaign_id] : undefined;
    return { status: "active", link: `${REFERRAL_LINK_BASE}${row.ref_token}`, portalUrl: REFERRAL_PORTAL_URL, ...(terms ? { rate: terms.rate, months: terms.months } : {}) };
  }
  return { status: "pending", link: null, portalUrl: REFERRAL_PORTAL_URL };
}
