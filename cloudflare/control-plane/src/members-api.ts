// SPDX-License-Identifier: AGPL-3.0-or-later
// Control-plane routes the murage.ai members area needs (muragesite plans/members-ux/SPEC.md §5; design: lanes/cloud-v2/members/NOTES.md):
//   GET  /v1/account/order?home=|session=   order reconciliation for the Stripe return page (paid | pending | failed | refund_pending | refund_sent)
//   GET  /v1/account/deletion               deletion receipt: what was deleted, when, and when the backups were purged
//   POST /v1/billing/checkout/resume        "Finish checkout" for a reserved home: the open session, or a fresh one for the same consent (step-up)
//   POST /v1/account/plan/preview           a server-issued quote: what an upgrade charges now (prorated at the quote's timestamp, tax included)
//   POST /v1/account/plan                   accept that quote: upgrade now (step-up); downgrade answers 409 downgrade_not_available
//                                           (both off unless CLOUD_PLAN_CHANGE=1: 409 plan_change_disabled, "contact us")
//   GET  /v1/account/plan                   the plan, a pending change, and the server resize that follows an upgrade
// Every route is the signed-in member's own (Supabase identity on Cloud routes); another member's home or session is 404. Every state is read
// from D1 rows written by the signed Stripe webhook, the refund ledger and the lifecycle, never from the query string.
import { assertPinnedHome } from "./customer-identity";
import { commitQ, journalDispatch } from "./step-up-op";
import { z } from "zod";
import { accountSession, type ControlPlaneAuth } from "./auth";
import { actor, bindingOf, cfg, CHECKOUT_SESSION_TTL_MS, checkoutAlertSyncQ, completedSessionSettled, expireConfirmed, getSub, homeSoldByLink, indeterminateStripeOutcome, planEndSentence, prepareCheckoutCustomer, planEndState, RelocatedAttempt, relocationClearedQ, publicCancelEndSql, readJSON, reconcileCheckoutAttempt, replayCheckoutAttempt,
  savedStepUpCheckout, checkoutAttemptAbandoned, sessionRequestSettled, stepUpConsentRestart, STRIPE_MIN_SESSION_WINDOW_MS, terminalStripeRefusal, type BillingDependencies } from "./b5-billing";
import { PLAN_MONTHLY_USD, submitLinksFor } from "./b5-config";
import { DEFAULT_LADDERS, provisionerConfig, ladderFor, type LadderRung } from "./b5-config";
import { PLAN_RANK, PLANS, type Plan } from "./b5-config";
import { StripeError, stripeClient, subscriptionPeriod } from "./b5-stripe";
import { writeSubscription, type SubscriptionAnswer } from "./subscription-gateway";
import { fence, fencedBatch, fencedRun, HomeBusy, LeaseLost, q, withHomeLease, type HomeLease, type Q } from "./billing-lease";
import { HTTPError, json } from "./http";
import { bindSessionQ, bootstrapExpired, issuancePast, publishClock, purchaseAuthority, stepUpRefused, type BootstrapRow } from "./purchase-bootstrap";
import { checkoutLocale, countrySwitch } from "./checkout-policy";
import { renewalSha256 } from "./disclosure-token";
import { CLOUD_MEMBERS_PATH, createTaxQuote, currentVersions, SCREEN_VERSION, getConsent as getConsentRow, getTaxQuote, hostedSnapshotComplete, htmlOf, isoDate, type ConsentRow as LegalConsentRow } from "./legal-flows";
import { BACKUP_STALE_MS } from "./ops-monitor";
import { MANAGED_QUOTE_SOURCE, sellerFor, sellerOfConsent, sellerSettings, SUBMIT_TEXT_VARIANT } from "./seller";
import { archivedStripePage, stripePageOf } from "./checkout-strings";

/** The consent row with the subscription its checkout created (written by attachSessionToConsent). */
type ConsentRow = LegalConsentRow & { stripe_subscription_id: string | null; quote_id: string | null; stripe_price_id: string | null };
const getConsent = (env: Env, id: string) => getConsentRow(env, id) as Promise<ConsentRow | null>;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A recorded consent is reused for a fresh session (Finish checkout) only this long after it was given. */
export const CONSENT_REUSE_MS = 24 * HOUR;
/** The member's home must report a heartbeat this soon after the resized server is powered on. */
export const RESIZE_HEALTH_MS = 15 * MINUTE;
/** A resize waiting for a fresh volume backup raises an alert after this long. */
export const RESIZE_BACKUP_WAIT_ALERT_MS = 24 * HOUR;


const nowOf = (deps: BillingDependencies) => (deps.now ?? Date.now)();
async function currentUser(request: Request, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<{ id: string }> {
  const user = await (deps.accountUser ?? (async (r, a) => (await accountSession(r, a))?.user ?? null))(request, auth);
  if (!user) throw new HTTPError(401, "unauthorized");
  return user;
}
async function requireStepUp(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth) {
  // The worker gate (index.ts, STEP_UP_ROUTES) already answered with the step_up body; this is the handler's own check.
  if (!await (deps.stepUp ?? (async () => false))(env, request, auth)) throw new HTTPError(403, "step_up_required");
}
async function busyAs409<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (e) { if (e instanceof HomeBusy || e instanceof LeaseLost) throw new HTTPError(409, "home_busy"); throw e; }
}
const alert = (env: Env, homeId: string, kind: string, severity: string, detail: Record<string, unknown>, now: number) =>
  env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
    .bind(crypto.randomUUID(), homeId, kind, severity, JSON.stringify(detail), now).run();

// ---- 2. Order reconciliation ----------------------------------------------------------------------------------------------------

export type OrderStatus = "paid" | "pending" | "failed" | "refund_pending" | "refund_sent";
const orderQuery = z.object({ home: z.string().regex(/^[\w-]{1,128}$/).optional(), session: z.string().regex(/^cs_[\w]{1,200}$/).optional() })
  .refine((v) => (v.home === undefined) !== (v.session === undefined));
interface HomeRow { id: string; owner_id: string; desired_state: string; entitlement: string; reservation_expires_at: number | null }
interface RefundRow { amount_cents: number | null; target_cents: number | null; paid_cents: number | null; refunded_at: number | null; done_at: number | null }

async function order(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  const user = await currentUser(request, deps, auth);
  const url = new URL(request.url);
  const parsed = orderQuery.safeParse({ home: url.searchParams.get("home") ?? undefined, session: url.searchParams.get("session") ?? undefined });
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  let consent: ConsentRow | null = null;
  let homeId: string;
  if (parsed.data.session) {
    const sid = parsed.data.session;
    // The session must be one of THIS member's checkouts (its consent, or the home's open checkout); anything else is not found.
    consent = await env.DB.prepare("SELECT * FROM checkout_consents WHERE stripe_session_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1")
      .bind(sid, user.id).first<ConsentRow>();
    if (!consent) {
      const open = await env.DB.prepare(`SELECT o.consent_id FROM open_checkouts o JOIN cloud_homes h ON h.id=o.home_id WHERE o.session_id=? AND h.owner_id=?`)
        .bind(sid, user.id).first<{ consent_id: string }>();
      consent = open ? await getConsent(env, open.consent_id) : null;
    }
    if (!consent) throw new HTTPError(404, "not_found");
    homeId = consent.home_id;
  } else homeId = parsed.data.home!;
  const home = await env.DB.prepare("SELECT id,owner_id,desired_state,entitlement,reservation_expires_at FROM cloud_homes WHERE id=? AND owner_id=?")
    .bind(homeId, user.id).first<HomeRow>();
  if (!home) throw new HTTPError(404, "not_found");
  const open = await env.DB.prepare("SELECT consent_id,state,session_id,expires_at FROM open_checkouts WHERE home_id=?").bind(home.id)
    .first<{ consent_id: string; state: string; session_id: string | null; expires_at: number | null }>();
  if (!consent) {
    // The home's current order: the consent of its open checkout, else its newest consent.
    consent = open ? await getConsent(env, open.consent_id)
      : await env.DB.prepare("SELECT * FROM checkout_consents WHERE home_id=? ORDER BY created_at DESC LIMIT 1").bind(home.id).first<ConsentRow>();
  }
  const sub = await getSub(env, home.id);
  const view = await reconcileOrder(env, home, consent, open, sub, nowOf(deps));
  // currentPeriodEnd: Stripe's current_period_end of the subscription this order belongs to (the renewal date), else null.
  // sub.consent_id alone is mutable (a retry rewrites it before the old subscription is replaced): the subscription must also be the one
  // this consent's own checkout created.
  const ownSub = consent !== null && sub !== null && sub.consent_id === consent.id && consent.stripe_subscription_id !== null
    && sub.subscription_id !== null && sub.subscription_id === consent.stripe_subscription_id ? sub : null;
  return json({ homeId: home.id, sessionId: consent?.stripe_session_id ?? open?.session_id ?? null, plan: consent?.plan ?? sub?.plan ?? null, ...view,
    currentPeriodEnd: ownSub?.current_period_end ?? null, checkedAt: nowOf(deps) });
}

/** The status of one purchase, from webhook-verified D1 state. Refunds outrank everything (money going back is what the member must see),
 *  then paid, then failed, else pending. */
export async function reconcileOrder(env: Env, home: HomeRow, consent: ConsentRow | null,
  open: { consent_id: string; state: string; session_id: string | null; expires_at: number | null } | null,
  sub: Awaited<ReturnType<typeof getSub>>, now: number): Promise<{ status: OrderStatus; reason: string; charged: boolean | null; startsAt: number | null;
    refund: { amountCents: number | null; refundedAt: number | null } | null }> {
  const subId = consent?.stripe_subscription_id ?? null;
  // The server start of THIS order: the subscription-bound service_start_at (written at payment), else the order's own paid moment. Never the
  // start promised on the disclosure screen (Astra WP5-1 #10): an unpaid order has not started.
  const ownSub = subId !== null && sub?.subscription_id === subId ? sub : null;
  const base = { charged: null as boolean | null, startsAt: ownSub?.service_start_at ?? consent?.paid_at ?? null, refund: null as { amountCents: number | null; refundedAt: number | null } | null };
  const current = consent !== null && sub?.consent_id === consent.id;
  // Refunds of THIS order's contract (by its subscription), money-bearing or not yet decided. A decided zero is no refund.
  const refunds = subId ? (await env.DB.prepare(`SELECT amount_cents,target_cents,paid_cents,refunded_at,done_at FROM refund_ops WHERE home_id=?
      AND (subscription_id=? OR cancel_subscription_id=?)`).bind(home.id, subId, subId).all<RefundRow>()).results
      .filter((r) => { const a = r.amount_cents ?? r.target_cents ?? r.paid_cents; return a === null ? r.done_at === null : a > 0; }) : [];
  if (refunds.length) {
    const sent = refunds.every((r) => r.refunded_at !== null);
    const amount = refunds.reduce<number | null>((s, r) => (s === null || (r.amount_cents ?? r.target_cents) === null ? null : s + (r.amount_cents ?? r.target_cents)!), 0);
    return { ...base, status: sent ? "refund_sent" : "refund_pending", reason: "refund", charged: true,
      refund: { amountCents: amount, refundedAt: sent ? Math.max(...refunds.map((r) => r.refunded_at!)) : null } };
  }
  // The lifecycle's own refund of a paid home that could not be served (no capacity, gave up): only for the home's current order.
  if (current && (home.entitlement === "refund_pending" || home.entitlement === "refunded")) {
    return { ...base, status: home.entitlement === "refunded" ? "refund_sent" : "refund_pending", reason: "not_served", charged: true };
  }
  if (consent && consent.completed_at !== null && subId && sub?.subscription_id === subId) {
    // "charged" only from a verified payment receipt: the order's paid_at (completion paid, async_payment_succeeded or invoice.paid, all
    // signed webhooks) or first_paid_at, written by the signed invoice.paid webhook for this contract (recordFirstInvoice). A subscription status alone (active, past_due) is not proof that money was taken.
    // A recorded receipt is history: later delinquency (past_due, unpaid) or an ended plan never turns a paid order back into "processing".
    if (sub.first_paid_at !== null || consent.paid_at !== null) return { ...base, status: "paid", reason: ["canceled", "incomplete_expired"].includes(sub.status) ? "ended" : "paid", charged: true };
    // The guard turned the order away (renewal not confirmed, country mismatch, country paused): a failed order, refunded in full.
    if (consent.rejected_at !== null) return { ...base, status: "failed", reason: "not_paid", charged: false };
    if (["canceled", "incomplete_expired"].includes(sub.status)) {
      return { ...base, status: "failed", reason: "not_paid", charged: false };
    }
  }
  if (!consent) {
    if (home.desired_state === "deleted") return { ...base, status: "failed", reason: "reservation_expired" };
    return { ...base, status: "pending", reason: "not_started" };
  }
  if (consent.price_mismatch_at !== null) return { ...base, status: "failed", reason: "repriced", charged: false };
  if (open && open.consent_id !== consent.id && consent.completed_at === null) return { ...base, status: "failed", reason: "superseded", charged: false };
  if (open && open.consent_id === consent.id) {
    if (open.state === "failed") return { ...base, status: "failed", reason: "checkout_failed", charged: false };
    if (open.state === "open" && (open.expires_at ?? 0) <= now) return { ...base, status: "failed", reason: "expired", charged: false };
  }
  if (home.desired_state === "deleted" && home.entitlement === "pending") return { ...base, status: "failed", reason: "reservation_expired", charged: false };
  // Open, being created, completed but not yet confirmed by the webhook, or an asynchronous payment still processing.
  return { ...base, status: "pending", reason: consent.completed_at !== null ? "processing" : "awaiting_payment" };
}

// ---- 3. Deletion receipt --------------------------------------------------------------------------------------------------------

export const DELETED_ITEMS = ["your Cloud server and everything on it", "its data volume", "every backup and snapshot of it",
  "its web address", "its connection keys and paired devices"];
export const KEPT_TEXT = "We keep only these records: invoices, billing and tax records for as long as tax and accounting law requires; support emails for up to 24 months after our last reply; the log of backup unlocks and server access for 24 months from each entry; and records of what you accepted, kept for as long as the law requires to prove your agreement.";

/** purged: every backup space has its purge time; none: the home never had a backup space; pending: no proof yet. */
export type BackupPurge = { status: "purged" | "none" | "pending"; purgedAt: number | null; verifiedPurgedBy: number | null };
export type DeletionReceipt = { homeId: string; status: "deleting" | "deleted"; reason: "your_request" | "plan_ended" | "operator";
  startedAt: number | null; deletedAt: number | null; backups: BackupPurge; backupsPurgedAt: number | null; deleted: string[]; kept: string };

export async function deletionReceipt(env: Env, homeId: string): Promise<DeletionReceipt | null> {
  const h = await env.DB.prepare("SELECT id,desired_state,resource_generation FROM cloud_homes WHERE id=?").bind(homeId)
    .first<{ id: string; desired_state: string; resource_generation: number }>();
  if (!h || (h.desired_state !== "deleting" && h.desired_state !== "deleted")) return null;
  const started = await env.DB.prepare(`SELECT kind,created_at FROM cloud_outbox WHERE home_id=? AND kind IN ('delete','delete_after_hold','retention_ended')
    ORDER BY created_at DESC LIMIT 1`).bind(homeId).first<{ kind: string; created_at: number }>();
  const done = h.desired_state === "deleted"
    ? await env.DB.prepare("SELECT created_at FROM cloud_outbox WHERE home_id=? AND kind='deleted' ORDER BY created_at DESC LIMIT 1").bind(homeId).first<{ created_at: number }>()
    : null;
  // Purge evidence, never inferred: every backup space of the home must carry its own purge time (purgeBackup sets it after verifying the
  // directory is gone), and no provider snapshot record may remain (purge_snapshots deletes them after verifying none is left).
  const b = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS open, MAX(deleted_at) AS at FROM backup_subaccounts WHERE home_id=?")
    .bind(homeId).first<{ n: number; open: number | null; at: number | null }>();
  const snaps = await env.DB.prepare("SELECT COUNT(*) AS n FROM volume_snapshots WHERE home_id=?").bind(homeId).first<{ n: number }>();
  const deletedAt = done?.created_at ?? null;
  // purgedAt: when the backup spaces were purged. verifiedPurgedBy: a date by which EVERY backup and snapshot is verifiably gone, i.e. the
  // later of that and the deletion itself (provider snapshots are purged and verified in the step that marks the home deleted).
  const backups: BackupPurge = (snaps?.n ?? 0) > 0 || (b?.open ?? 0) > 0 || deletedAt === null ? { status: "pending", purgedAt: null, verifiedPurgedBy: null }
    : (b?.n ?? 0) === 0 ? { status: "none", purgedAt: null, verifiedPurgedBy: deletedAt }
    : { status: "purged", purgedAt: b!.at, verifiedPurgedBy: Math.max(b!.at ?? 0, deletedAt) };
  return { homeId, status: h.desired_state as "deleting" | "deleted",
    reason: started?.kind === "retention_ended" ? "plan_ended" : started?.kind === "delete_after_hold" ? "your_request" : "operator",
    startedAt: started?.created_at ?? null, deletedAt, backups, backupsPurgedAt: backups.verifiedPurgedBy, deleted: DELETED_ITEMS, kept: KEPT_TEXT };
}

/** The durable "your home was deleted" email (billing_notices outbox, sent by the billing sweep). */
export async function deletionNoticeData(env: Env, homeId: string, now: number): Promise<Record<string, unknown>> {
  const r = await deletionReceipt(env, homeId);
  const at = (ms: number | null) => new Date(ms ?? now).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const deletedAt = r?.deletedAt ?? now;
  const planLine = planEndSentence(await planEndState(env, homeId));
  const text = `Your Murage Cloud was deleted on ${at(deletedAt)}.\n\nWhat we deleted:\n${DELETED_ITEMS.map((d) => `- ${d}`).join("\n")}\n\n`
    + (r?.backups.status === "purged" ? `Backups: every backup and snapshot was purged by ${isoDate(r.backups.verifiedPurgedBy!)}. Nothing can be restored.\n\n`
      : r?.backups.status === "none" ? `Backups: this Cloud had no backup space; its server snapshots were purged by ${isoDate(r.backups.verifiedPurgedBy!)}. Nothing can be restored.\n\n`
      : "Backups: every backup and snapshot of this Cloud is being purged now. You do not need to do anything.\n\n")
    // B1: the plan's end date and that nothing is charged again (a deletion never refunds; the plan simply does not renew).
    + (planLine ? `${planLine}\n\n` : "")
    + `${KEPT_TEXT}\n\nYou can start a new Murage Cloud from your account page whenever you like.\n\nReference: ${homeId}`;
  return { deletedAt, backupsPurgedAt: r?.backupsPurgedAt ?? null, emailSubject: "Murage Cloud: your Cloud was deleted", emailText: text, emailHtml: htmlOf(text) };
}

async function deletion(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  const user = await currentUser(request, deps, auth);
  const row = await env.DB.prepare(`SELECT id FROM cloud_homes WHERE owner_id=? AND desired_state IN ('deleting','deleted')
    AND (desired_state='deleting' OR EXISTS (SELECT 1 FROM cloud_outbox o WHERE o.home_id=cloud_homes.id AND o.kind='deleted'))
    ORDER BY updated_at DESC LIMIT 1`).bind(user.id).first<{ id: string }>();
  const live = await env.DB.prepare("SELECT 1 AS x FROM cloud_homes WHERE owner_id=? AND desired_state NOT IN ('deleting','deleted') LIMIT 1").bind(user.id).first();
  const receipt = row ? await deletionReceipt(env, row.id) : null;
  const email = row ? await env.DB.prepare("SELECT created_at,sent_at FROM billing_notices WHERE home_id=? AND kind='deleted' LIMIT 1").bind(row.id)
    .first<{ created_at: number; sent_at: number | null }>() : null;
  return json({ deletion: receipt ? { ...receipt, emailSentAt: email?.sent_at ?? null } : null, hasLiveHome: live !== null });
}

// ---- 4. Finish checkout -----------------------------------------------------------------------------------------------------------

interface OpenRow { home_id: string; consent_id: string; state: string; session_id: string | null; session_url: string | null; expires_at: number | null; updated_at: number }

async function resumeCheckout(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  const who = await actor(request, env, deps, auth, undefined, "payable");
  // { homeId } is optional; when sent it must be the resolved home. On the first-purchase bootstrap it is REQUIRED and must be the reserved
  // home (Astra TRUST-4 P2-4: the resume target is bound at both gates, never picked for an empty body).
  const body = await readJSON(request, z.object({ homeId: z.string().regex(/^[\w-]{1,128}$/).optional() }).strict());
  const authority = await purchaseAuthority(deps, env, request, auth, null, who.homeId);
  if (!authority) throw stepUpRefused();
  const bootstrap = authority === "trusted" ? null : authority;
  if (bootstrap && body.homeId === undefined) throw new HTTPError(400, "home_required");
  if (body.homeId !== undefined && body.homeId !== who.homeId) throw bootstrap ? stepUpRefused() : new HTTPError(409, "home_mismatch");
  if (bootstrap && !bootstrap.row) throw stepUpRefused();
  const config = cfg(env);
  // WP4 r2-4: a paused country is refused BEFORE the lease is taken, so the refusal writes nothing at all (not even billing_home_leases'
  // generation). Read-only: the consent of this home's open checkout. The same check runs again inside the lease (assertConsentStands),
  // so a pause that lands meanwhile still wins.
  const pending = await env.DB.prepare(`SELECT c.declared_country,c.billing_country FROM open_checkouts o JOIN checkout_consents c ON c.id=o.consent_id
    WHERE o.home_id=? AND c.home_id=o.home_id AND o.state<>'completed'`).bind(who.homeId).first<{ declared_country: string | null; billing_country: string }>();
  if (pending && await countrySwitch(env, pending.declared_country ?? pending.billing_country) === "paused") throw new HTTPError(409, "country_paused");
  return busyAs409(() => withHomeLease(env, who.homeId, (lease) => resumeLeased(env, deps, lease, config, who.homeId, bootstrap?.row ?? null), deps.lease));
}

export async function resumeLeased(env: Env, deps: BillingDependencies, lease: HomeLease, config: ReturnType<typeof cfg>, homeId: string,
  boot: BootstrapRow | null): Promise<Response> {
  const now = nowOf(deps);
  const home = await env.DB.prepare("SELECT desired_state,entitlement FROM cloud_homes WHERE id=?").bind(homeId).first<{ desired_state: string; entitlement: string }>();
  if (!home || home.desired_state !== "payment_pending" || home.entitlement !== "pending") throw new HTTPError(409, "home_not_payable");
  const sub = await getSub(env, homeId);
  if (sub?.subscription_id && ["active", "trialing", "past_due"].includes(sub.status)) throw new HTTPError(409, "already_subscribed");
  let open = await env.DB.prepare("SELECT * FROM open_checkouts WHERE home_id=?").bind(homeId).first<OpenRow>();
  if (!open || !sub) throw new HTTPError(409, "checkout_not_started");
  if (open.state === "completed") throw new HTTPError(409, "checkout_completed");
  if (open.state === "creating" && open.updated_at > now - MINUTE) throw new HTTPError(409, "checkout_in_progress");
  // A step-up checkout attempt saved before its dispatch whose recording batch never landed (Astra STEPUP-EMAIL-6 #3) is read FIRST, before
  // any consent staleness check (its consent has no recorded price yet, by construction): it is validated and replayed under its ORIGINAL
  // idempotency key (b5-billing.ts replayCheckoutAttempt), so Stripe answers with the session that run created. Never a second session.
  // A paused country still sells nothing.
  const saved = boot ? null : await savedStepUpCheckout(env, homeId, open.consent_id);
  if (saved) {
    const c = await getConsent(env, open.consent_id);
    if (!c) throw stepUpConsentRestart();
    if (await countrySwitch(env, c.declared_country ?? c.billing_country) === "paused") throw new HTTPError(409, "country_paused");
    try { return await replayCheckoutAttempt(env, lease, stripeClient(config, deps.stripeFetch), homeId, saved.id, saved, now); }
    catch (e) { if (!(e instanceof RelocatedAttempt)) throw e; }
    // Its session was made before the customer moved and is expired (Astra TAXCOUNTRY-3 #6): a fresh session for the same consent below.
    open = await env.DB.prepare("SELECT * FROM open_checkouts WHERE home_id=?").bind(homeId).first<OpenRow>();
    if (!open) throw new HTTPError(409, "checkout_not_started");
  }
  // An attempt of this consent proven to have created no session: the consent is spent, a fresh one is asked for (Astra STEPUP-EMAIL-7 #3).
  // Any attempt family (a step-up checkout or a /checkout/resume replacement) and the bootstrap alike (Astra STEPUP-EMAIL-9 #3).
  if (await checkoutAttemptAbandoned(env, homeId, open.consent_id)) throw stepUpConsentRestart();
  // Before ANY reuse (the open session, a replacement, or the replay of a saved attempt): the recorded consent must be from the screen in
  // force and its country must not be paused. A paused country sells nothing new, a resumed session included.
  const consent = await getConsent(env, open.consent_id);
  await assertConsentStands(env, consent);
  // The bootstrap resumes only its own order, for its own customer.
  if (boot && (sub.customer_id !== boot.stripe_customer_id || open.consent_id !== boot.consent_id)) throw stepUpRefused();
  const stripe = stripeClient(config, deps.stripeFetch);
  // The required, fenced customer preset (b5-billing.ts prepareCheckoutCustomer). It never re-addresses a customer: a rewritable home is
  // moved to a NEW customer created with the declared location (Astra TAXCOUNTRY-5), so every session below names `customerId`, the pointer
  // as the preset returned it under this lease. `stale`: the home's DURABLE relocation marker stands (set by this request's switch or an
  // earlier one's, cleared only by a later session's publication), so any session made before this request (the open one, a replayed or
  // reconciled attempt's) was made before the move, and the preset has expired every open one (Astra TAXCOUNTRY-3 P2-a).
  let customerId = sub.customer_id;
  const preset = async () => {
    const r = await prepareCheckoutCustomer(env, lease, stripe, { homeId, consentId: consent!.id, country: consent!.billing_country,
      postalCode: consent!.postal_code ?? null, bootstrap: bindingOf(boot) });
    if (boot) boot.stripe_customer_id = r.customerId;
    customerId = r.customerId;
    return r;
  };
  let stale = false;
  try {
    if (open.state === "open" && open.session_id && open.session_url && (open.expires_at ?? 0) > now + 5 * MINUTE) {
      // Still open locally: confirm at Stripe (a completed payment whose webhook is on its way must not be offered again).
      const live = await stripe.retrieveEventObject("checkout_session", open.session_id);
      if (live.status === "complete") throw new HTTPError(409, "checkout_completed");
      if (live.status === "open") {
        // Astra TAXCOUNTRY-2 P2, TAXCOUNTRY-3 P2-a: the preset runs before ANY session is handed back. A session made before the customer
        // moved (the marker stands) has been expired by it, confirmed at Stripe, and is replaced below by a fresh session; a preset or an
        // expiry that cannot be confirmed refuses (503 checkout_unavailable) and the marker makes the next request do the same.
        stale = (await preset()).stale;
        // A session Stripe reports on another customer than the pointer was made before a switch: never handed back.
        const sessionCustomer = typeof live.customer === "string" ? live.customer : null;
        if (sessionCustomer && sessionCustomer !== customerId) stale = true;
        if (!stale) return json({ sessionId: open.session_id, url: open.session_url, consentId: open.consent_id, reused: true });
        await expireConfirmed(env, lease, stripe, open.session_id); // the one this home knows, whatever a listing shows
      }
    }
    // Expired (or about to): a fresh session for the SAME home and the SAME recorded consent, only if that consent still stands for money too.
    await assertConsentReusable(env, stripe, consent, config.priceByPlan[consent?.plan as Plan] ?? null, now);
    const plan = consent!.plan as Plan;
    // The duplicate-subscription guards of createCheckout: earlier open sessions are expired first, and a completed session for this home
    // that the ledger has not settled means the payment went through. The one exception is the session of this consent's saved, still
    // unresolved replacement attempt (its own fixed expiry): it is that attempt's original operation, kept for it (Astra STEPUP-EMAIL-8 #3).
    const unresolved = await env.DB.prepare("SELECT expires_at FROM checkout_resume_attempts WHERE home_id=? AND consent_id=? AND state='creating' ORDER BY created_at DESC LIMIT 1")
      .bind(homeId, consent!.id).first<{ expires_at: number }>();
    const ownSession = (s: { metadata?: Record<string, string> | null; expires_at?: number | null }) => unresolved !== null
      && s.metadata?.consent_id === consent!.id && (s.metadata?.home_id ?? homeId) === homeId && s.expires_at === Math.floor(unresolved.expires_at / 1000);
    for (const s of (await stripe.listCheckoutSessions(customerId)).data ?? []) {
      const settled = s.status === "complete" && await completedSessionSettled(env, homeId, s, sub);
      if (s.status === "complete" && s.subscription && !settled && (s.metadata?.home_id ?? homeId) === homeId) throw new HTTPError(409, "checkout_completed");
      if (s.status === "open" && !ownSession(s)) { await fence(env, lease); await stripe.expireCheckoutSession(s.id); }
    }
    const claim = await fencedRun(env, lease, `UPDATE open_checkouts SET state='creating',session_id=NULL,session_url=NULL,expires_at=NULL,updated_at=?
      WHERE home_id=? AND consent_id=? AND state=?`, now, homeId, consent!.id, open.state);
    if (claim !== 1) throw new HTTPError(409, "checkout_in_progress");
    try {
      // At most two attempts: a replayed attempt whose session is no longer open (expired by the loop above after a crash) is abandoned once.
      for (let round = 0; round < 2; round++) {
        await fence(env, lease);
        // The bootstrap's deadline again, immediately before a session is created (Astra TRUSTCODE-2 P2-1).
        if (boot && await issuancePast(env, boot, publishClock(deps))) throw bootstrapExpired();
        // The customer is settled at this consent's declared location before any session is (re-)created or handed back, whatever the
        // attempt's remaining time: the same required, fenced preset as a new checkout (Astra TAXCOUNTRY-1 P2, TAXCOUNTRY-2 P2). It runs
        // BEFORE a fresh attempt is written, so that attempt's fixed request names the pointer as it stands after the preset.
        stale = (await preset()).stale;
        const attempt = await resumeAttempt(env, lease, homeId, consent!.id, now, (expiresAt, issuanceId): SessionInput => ({ customerId, homeId, plan, issuanceId,
          priceId: consent!.stripe_price_id!, fpTid: sub.fp_tid ?? undefined, consentId: consent!.id,
          // The journaled renewal sentence of this consent, bound to the session for the webhook (plan §3.2, 2026-10-14).
          renewalSha256: renewalSha256(consent!.renewal_text),
          // The locale the consent was sold with (WP4 stores the one actually sent); an older consent falls back to its billing country.
          locale: consent!.checkout_language ?? checkoutLocale(consent!.billing_country, null), submitLinks: submitLinksFor(env),
          expiresAtSeconds: Math.floor(expiresAt / 1000), seller: sellerOfConsent(consent!),
          successUrl: `${config.returnOrigin}${CLOUD_MEMBERS_PATH}?notice=paid&home=${encodeURIComponent(homeId)}`,
          cancelUrl: `${config.returnOrigin}${CLOUD_MEMBERS_PATH}?notice=checkout_cancelled&home=${encodeURIComponent(homeId)}` }));
        // Astra TAXCOUNTRY-5: a saved attempt frozen on a customer the home was moved away from yields only sessions made before the move.
        const frozenCustomer = typeof attempt.input.customerId === "string" && attempt.input.customerId ? attempt.input.customerId : customerId;
        const onPrevious = frozenCustomer !== customerId;
        if (onPrevious) stale = true;
        // The attempt's id, expiry and whole request are fixed when it is first written: a retry after a crash or a lost lease sends the
        // identical request under the identical key (even if configuration changed meanwhile), so Stripe returns the same session.
        // Astra JOURNEY-A-2 A6: the request is on record before Stripe is asked (a lost answer still keeps a failed home from retiring).
        // Astra JOURNEY-A-3 #2: the request's identity (its idempotency key, in the attempt's stored request as metadata issuance_id).
        const issuanceId = `resume:${attempt.id}`;
        await fencedRun(env, lease, "UPDATE checkout_consents SET session_inflight_at=?,session_issuance_id=? WHERE id=?", now, issuanceId, consent!.id);
        await journalDispatch(env, issuanceId);
        // The same immutable-attempt policy as a step-up attempt (Astra STEPUP-EMAIL-8 #3): dispatched again under its ORIGINAL key only
        // while Stripe could still create the session (its fixed expiry at least 31 minutes away); a terminal refusal, a replayed 5xx and
        // an attempt past that window are RECONCILED by its own order (this consent, this home, its own expiry), never given another key.
        // An empty listing abandons it only after a proven refusal or past its expiry plus the grace (409 consent_stale, restart); before
        // that it stays unresolved (409 checkout_in_progress). A transient failure stays a retryable 502 with the attempt untouched.
        let session: { id: string; url: string; replayed?: boolean } | null = null, proven = false;
        if (attempt.expires_at - now >= STRIPE_MIN_SESSION_WINDOW_MS) {
          try { session = await stripe.createCheckoutSession(attempt.input, issuanceId); }
          catch (e) { if (!terminalStripeRefusal(e) && !indeterminateStripeOutcome(e)) throw e; proven = terminalStripeRefusal(e); }
        }
        // A session this dispatch created is newer than the preset; a replayed or reconciled one was made EARLIER.
        const earlier = session === null || session.replayed === true || onPrevious;
        if (session === null) {
          const found = await reconcileCheckoutAttempt(env, lease, stripe, { homeId, attemptId: attempt.id, consentId: consent!.id, customerId: frozenCustomer,
            expiresAt: attempt.expires_at, proven, matchExpiry: true }, now);
          if ("closed" in found) {
            if (found.status === "complete") throw new HTTPError(409, "checkout_completed");
            // Expired at Stripe: that settles this request's in-flight marker too (Astra JOURNEY-A-2 A6), as on the live-state path below.
            if (found.status === "expired") await sessionRequestSettled(env, lease, consent!.id, issuanceId, now);
            continue;
          }
          session = found;
        }
        // A replay returns Stripe's original answer: read the session's live state before offering it.
        const live = await stripe.retrieveEventObject("checkout_session", session.id);
        if (live.status !== "open") {
          await fencedRun(env, lease, "UPDATE checkout_resume_attempts SET state='abandoned',session_id=? WHERE id=?", session.id, attempt.id);
          // Stripe says this session is expired: it can never be submitted, so it settles the request (a complete one is left to its completion).
          if (live.status === "expired") await sessionRequestSettled(env, lease, consent!.id, issuanceId, now);
          continue;
        }
        // Astra TAXCOUNTRY-2 P2, TAXCOUNTRY-3 P2-a: a session made before the customer moved is never handed back: it is expired
        // (confirmed at Stripe), the attempt closed with it, and the next round writes a fresh attempt whose session is made after the move.
        if (stale && earlier) {
          await expireConfirmed(env, lease, stripe, session.id);
          await fencedRun(env, lease, "UPDATE checkout_resume_attempts SET state='abandoned',session_id=? WHERE id=?", session.id, attempt.id);
          await sessionRequestSettled(env, lease, consent!.id, issuanceId, now);
          continue;
        }
        // A replacement session of the bootstrap is bound to it first, in the same batch (generation-fenced, before issue_until judged at
        // the time of this write, never the handler's start: a session created across the deadline is not published).
        const at = boot ? publishClock(deps) : null;
        const published = boot ? [bindSessionQ(boot, { customerId, sessionId: session.id, consentId: consent!.id, at })] : [];
        const owned = await fencedBatch(env, lease, [
          ...published,
          q(`UPDATE open_checkouts SET state='open',session_id=?,session_url=?,expires_at=?,updated_at=? WHERE home_id=? AND consent_id=? AND state='creating'${boot ? " AND changes()=1" : ""}`,
            session.id, session.url, attempt.expires_at, now, homeId, consent!.id),
          // A step-up operation's commitment (step-up-op.ts): only its completed effect, the new session recorded as the open checkout.
          ...[commitQ(env, `resume:${attempt.id}`)].filter((x): x is Q => x !== null),
          // The session this consent was bound to is never overwritten silently (Astra DROPDOWN-DIRECT-1 (4)): the superseded binding is
          // journaled first, naming the session that replaces it. A completion of the superseded session is then refused on its own.
          q(`INSERT INTO checkout_resume_attempts (id,home_id,consent_id,expires_at,payload,state,session_id,created_at)
            SELECT 'superseded:'||stripe_session_id,home_id,id,?,?,'superseded',stripe_session_id,? FROM checkout_consents
            WHERE id=? AND stripe_session_id IS NOT NULL AND stripe_session_id<>?${boot ? " AND EXISTS (SELECT 1 FROM open_checkouts WHERE home_id=? AND session_id=? AND state='open')" : ""}
            ON CONFLICT(id) DO NOTHING`, now, JSON.stringify({ supersededBy: session.id }), now, consent!.id, session.id, ...(boot ? [homeId, session.id] : [])),
          q(`UPDATE checkout_consents SET stripe_session_id=?,session_inflight_at=NULL,session_issuance_id=NULL,session_expired_at=NULL WHERE id=?${boot ? " AND EXISTS (SELECT 1 FROM open_checkouts WHERE home_id=? AND session_id=? AND state='open')" : ""}`,
            session.id, consent!.id, ...(boot ? [homeId, session.id] : [])),
          checkoutAlertSyncQ(consent!.id, now), // Astra JOURNEY-A-4 #5: the marker settled by publication leaves the alert too
          q("UPDATE checkout_resume_attempts SET state='done',session_id=? WHERE id=?", session.id, attempt.id),
          relocationClearedQ(homeId, session.id),
        ]);
        if (boot && owned[0].meta.changes !== 1) {
          // Expired at Stripe, the attempt is settled (no replay would issue it again); one that cannot be expired stays unresolved.
          try {
            await stripe.expireCheckoutSession(session.id);
            await fencedRun(env, lease, "UPDATE checkout_resume_attempts SET state='abandoned',session_id=? WHERE id=?", session.id, attempt.id);
            await sessionRequestSettled(env, lease, consent!.id, issuanceId, now);
          } catch (e) { if (e instanceof LeaseLost) throw e; /* a completion is caught by the duplicate claim */ }
          throw await issuancePast(env, boot, at) ? bootstrapExpired() : stepUpRefused();
        }
        if (owned[published.length].meta.changes !== 1) {
          try { await stripe.expireCheckoutSession(session.id); } catch { /* a completion is caught by the duplicate claim */ }
          throw new HTTPError(409, "checkout_superseded");
        }
        return json({ sessionId: session.id, url: session.url, consentId: consent!.id, reused: false });
      }
      throw new HTTPError(409, "checkout_in_progress");
    } catch (e) {
      // The claim is released; an attempt still 'creating' is kept, so the next press replays the same request and key.
      try { await fencedRun(env, lease, "UPDATE open_checkouts SET state='failed',updated_at=? WHERE home_id=? AND consent_id=? AND state='creating'", now, homeId, consent!.id); }
      catch (e2) { if (!(e2 instanceof LeaseLost)) throw e2; }
      throw e;
    }
  } catch (e) {
    if (e instanceof StripeError) throw new HTTPError(502, "stripe_unavailable");
    throw e;
  }
}

/** The open replacement attempt for this consent, or a new one (fresh id and expiry). A saved attempt is kept whatever its remaining time
 *  (its original key until it is resolved, Astra STEPUP-EMAIL-8 #3); only a pre-2026-10-14 request shape is abandoned. */
type SessionInput = Parameters<ReturnType<typeof stripeClient>["createCheckoutSession"]>[0];
async function resumeAttempt(env: Env, lease: HomeLease, homeId: string, consentId: string, now: number, build: (expiresAt: number, issuanceId: string) => SessionInput) {
  const a = await env.DB.prepare("SELECT id,expires_at,payload FROM checkout_resume_attempts WHERE home_id=? AND consent_id=? AND state='creating' ORDER BY created_at DESC LIMIT 1")
    .bind(homeId, consentId).first<{ id: string; expires_at: number; payload: string }>();
  // An attempt written before 2026-10-14 has no renewalSha256 (its request carried the renewal dropdown): replaying it would send a
  // different request under the same key, so it is abandoned and a fresh attempt is written.
  const input = a ? JSON.parse(a.payload) as Partial<SessionInput> : null;
  // Likewise an attempt without its issuance id (Astra JOURNEY-A-3 #2): its session could not be matched to its request. Its remaining time is
  // not judged here: a saved attempt keeps its original key until it is resolved (Astra STEPUP-EMAIL-8 #3; reconciled past Stripe's window).
  if (a && input?.renewalSha256 && input.issuanceId === `resume:${a.id}`) return { id: a.id, expires_at: a.expires_at, input: input as SessionInput };
  if (a) await fencedRun(env, lease, "UPDATE checkout_resume_attempts SET state='abandoned' WHERE id=?", a.id);
  const expiresAt = now + CHECKOUT_SESSION_TTL_MS;
  const id = crypto.randomUUID();
  const fresh = { id, expires_at: expiresAt, input: build(expiresAt, `resume:${id}`) };
  // Astra INTEGRATED-3 #4: the original key (its issuance id) is persisted with the attempt, so proven-empty settles its marker by it.
  await fencedRun(env, lease, "INSERT INTO checkout_resume_attempts (id,home_id,consent_id,expires_at,payload,state,created_at,idempotency_key) VALUES (?,?,?,?,?,'creating',?,?)",
    fresh.id, homeId, consentId, fresh.expires_at, JSON.stringify(fresh.input), now, `resume:${fresh.id}`);
  return fresh;
}

/** A consent from the current hosted checkout (r13), positively identified: no tax quote, our button press recorded with a declared country,
 *  a hosted or Link seller marker, no delayed start, the screen version in force, and (WP4 r2-1) a complete snapshot: our button label
 *  (start_request_text) and the shown lines archived. Only such a consent may skip the tax re-check or be reused at all. */
export const isHostedConsent = (c: Pick<ConsentRow, "quote_id" | "start_request_at" | "declared_country" | "tax_source" | "delayed_start" | "screen_version">
  & Partial<Pick<LegalConsentRow, "start_request_text" | "disclosure">>) =>
  c.quote_id === null && c.start_request_at !== null && c.declared_country !== null && (c.tax_source === "hosted" || c.tax_source === MANAGED_QUOTE_SOURCE)
  && c.delayed_start === 0 && c.screen_version === SCREEN_VERSION && hostedSnapshotComplete({ start_request_text: c.start_request_text, disclosure: c.disclosure });

/** Checked before every reuse of a recorded consent (open session, replacement, saved-attempt replay): 409 consent_stale for a consent from
 *  another screen version or a pre-r13 delayed start (whose session would charge at once without the trial it promised), and for a
 *  quote-free consent that is not positively a hosted one; 409 country_paused when its declared country is paused now. */
async function assertConsentStands(env: Env, consent: ConsentRow | null): Promise<void> {
  // A hosted consent whose snapshot is incomplete (no start_request_text or no archived lines: a pre-r1 r13 row) is stale too (r2-1).
  if (!consent || consent.screen_version !== SCREEN_VERSION || consent.delayed_start === 1
    || (consent.quote_id === null && !isHostedConsent(consent)) || (consent.start_request_at !== null && !hostedSnapshotComplete(consent)))
    throw stepUpConsentRestart();
  if (await countrySwitch(env, consent.declared_country ?? consent.billing_country) === "paused") throw new HTTPError(409, "country_paused");
}

/** The Stripe page a reissued session for this consent would show (its seller path, plan and the locale the consent was sold with, the
 *  current words) is, field for field, the one archived with the consent at issuance (prepareConsent's stripePage). Chosen over keeping
 *  per-session word snapshots: a reissue then never shows words the consent's archive does not hold, and a changed page (a new
 *  STRIPE_PAGE_VERSION) or a pre-change consent always goes back through our page for fresh consent. */
export function stripePageStands(consent: Pick<ConsentRow, "disclosure" | "plan" | "tax_source" | "checkout_language" | "billing_country">): boolean {
  const archived = archivedStripePage(consent.disclosure);
  if (!archived || !(PLANS as readonly string[]).includes(consent.plan)) return false;
  const { authorization: _authorization, ...words } = archived;
  const now: Record<string, unknown> = stripePageOf(sellerOfConsent(consent) === "link" ? "managed" : "direct", consent.plan as Plan,
    consent.checkout_language ?? checkoutLocale(consent.billing_country, null), SUBMIT_TEXT_VARIANT);
  const keys = new Set([...Object.keys(words), ...Object.keys(now)]);
  return [...keys].every((k) => words[k] === now[k]);
}

/** A recorded consent may back a replacement session only if it still stands: same documents, under 24 h old, a delayed start still ahead,
 *  the same plan price, the same seller for its billing country now, and (a Ferrox sale) the same total including tax at its address now.
 *  Anything else: 409 consent_stale, and the site runs the normal checkout (fresh consent). */
async function assertConsentReusable(env: Env, stripe: ReturnType<typeof stripeClient>, consent: ConsentRow | null, configuredPrice: string | null, now: number): Promise<void> {
  const cur = currentVersions();
  const stale = () => stepUpConsentRestart();
  if (!consent || consent.completed_at !== null || consent.price_mismatch_at !== null || now - consent.created_at > CONSENT_REUSE_MS
    || consent.cloud_terms_version !== cur.cloudTerms || consent.tos_version !== cur.termsOfService || consent.privacy_version !== cur.privacyPolicy
    || consent.screen_version !== SCREEN_VERSION || !(PLANS as readonly string[]).includes(consent.plan)) throw stale();
  const plan = consent.plan as Plan;
  if (consent.price_cents !== PLAN_MONTHLY_USD[plan] * 100) throw stale();
  // Bound to the exact Stripe price the consent was sold at, which must still be the configured one, and Stripe's own price must still be
  // what the member agreed to: active, the same monthly amount in USD.
  if (!consent.stripe_price_id || consent.stripe_price_id !== configuredPrice) throw stale();
  // The reissued session must show exactly the Stripe page archived with this consent (Astra DROPDOWN-DIRECT-1 (4)): never words the
  // archive does not hold. A consent from the pre-change code (no Stripe-page provenance) or from another page version gives fresh consent.
  if (!stripePageStands(consent)) throw stale();
  const price = await stripe.getPrice(consent.stripe_price_id);
  if (price.active !== true || price.unit_amount !== consent.price_cents || price.currency !== "usd" || price.recurring?.interval !== "month"
    || (price.recurring?.interval_count ?? 1) !== 1) throw stale();
  let seller: string;
  try { seller = sellerFor(sellerSettings(env), consent.billing_country); } catch { throw stale(); }
  if (seller !== sellerOfConsent(consent)) throw stale();
  // A consent made with a tax quote must still match the total including tax at its address. Only a positively identified hosted-checkout
  // consent has none and skips this; any other quote-free consent is stale.
  if (consent.quote_id === null && !isHostedConsent(consent)) throw stale();
  if (seller === "ferrox" && consent.quote_id !== null) {
    const original = await getTaxQuote(env, consent.quote_id);
    if (!original || consent.quoted_total_cents === null) throw stale();
    let fresh: Awaited<ReturnType<typeof createTaxQuote>>;
    try {
      fresh = await createTaxQuote(env, stripe, { userId: consent.user_id, plan, country: consent.billing_country, postalCode: consent.postal_code,
        topupAmountCents: original.topup_amount_cents }, now);
    } catch (e) { if (e instanceof HTTPError) throw stale(); throw e; }
    if (fresh.total_cents !== consent.quoted_total_cents) throw stale();
  }
}

// ---- 5. Plan change -----------------------------------------------------------------------------------------------------------------
// Off for launch: CLOUD_PLAN_CHANGE=1 turns it on (the site shows "Contact us to change plan" while it is off). See NOTES.md item 5.

export const planChangeEnabled = (env: Env) => ((env as { CLOUD_PLAN_CHANGE?: string }).CLOUD_PLAN_CHANGE ?? "").trim() === "1";
const quoteBody = z.object({ plan: z.enum(PLANS) }).strict();
const planBody = z.object({ quoteId: z.string().uuid() }).strict();
const ACTIVE_RESIZE = "state NOT IN ('done','unhealthy','failed')";
/** A quote is honoured this long; the proration it binds is computed at its own timestamp. */
export const QUOTE_TTL_MS = 10 * MINUTE;
/** A plan change Stripe has not completed in this long has lapsed (Stripe's pending updates expire after 23 h): its invoice is voided. */
export const PLAN_CHANGE_LAPSE_MS = 23 * HOUR + 30 * MINUTE;

/** The server type an upgraded home moves to: the new plan's ladder rung with the same provider and CPU architecture (change_type cannot
 *  cross either). Null when there is none (Vultr, or no matching rung): the upgrade is refused before anything is charged. */
export async function resizeTarget(env: Env, homeId: string, plan: string): Promise<{ provider: string; fromType: string; targetType: string } | null> {
  const h = await env.DB.prepare("SELECT resource_generation FROM cloud_homes WHERE id=?").bind(homeId).first<{ resource_generation: number }>();
  if (!h) return null;
  const choice = await env.DB.prepare("SELECT provider,server_type,arch FROM provision_choices WHERE home_id=? AND resource_generation=?")
    .bind(homeId, h.resource_generation).first<{ provider: string; server_type: string; arch: string }>();
  if (!choice || choice.provider !== "hetzner") return null;
  let ladder: LadderRung[];
  try { ladder = env.B5_PROVISIONER_CONFIG ? ladderFor(provisionerConfig(env), plan) : DEFAULT_LADDERS[plan as Plan]; }
  catch { return null; }
  const rung = ladder?.find((r) => r.provider === "hetzner" && r.arch === choice.arch);
  return rung ? { provider: "hetzner", fromType: choice.server_type, targetType: rung.serverType } : null;
}

/** Every local reason an upgrade must not be charged now, read fresh. Called before the quote AND again inside the home's lease right
 *  before the Stripe update, so a cancellation, withdrawal, refund, lifecycle change or another change recorded meanwhile always wins. */
async function planChecks(env: Env, homeId: string, plan: Plan, now: number) {
  const sub = await getSub(env, homeId);
  if (!sub?.subscription_id) throw new HTTPError(404, "not_found");
  const home = await env.DB.prepare("SELECT desired_state FROM cloud_homes WHERE id=?").bind(homeId).first<{ desired_state: string }>();
  if (sub.status !== "active" || home?.desired_state !== "ready") throw new HTTPError(409, "plan_change_unavailable");
  // An open public (§312k) cancellation Stripe confirmed: no plan change (up or down) until the customer takes it back. Only the change is
  // refused; cancelling is never gated by this.
  const pub = await env.DB.prepare(`SELECT ${publicCancelEndSql("b")} AS at, (SELECT r.id FROM cancellation_requests r WHERE r.subscription_id=b.subscription_id
    AND r.match_state='matched' AND r.status='open' ORDER BY r.effective_at IS NULL, r.effective_at, r.received_at, r.id LIMIT 1) AS id
    FROM billing_subscriptions b WHERE b.home_id=?`).bind(homeId).first<{ at: number | null; id: string | null }>();
  if (pub?.at != null) {
    // cancellationId: what POST /v1/account/cancellations/{id}/keep takes, so the page can offer Keep my plan right here.
    throw new HTTPError(409, "cancellation_open", { message: "You have cancelled this plan. To change your plan, press Keep my plan on your account page first.",
      cancellationId: pub.id });
  }
  // Keep my plan commits `kept` before Stripe is told (Astra CANCEL-SUMMARY-1 #4): until Stripe's cancel_at is cleared and read back (the
  // declaration synced again, the row's cancel_at gone) the subscription still ends, and nothing is quoted or charged against it.
  if (await env.DB.prepare(`SELECT 1 AS x FROM cancellation_requests WHERE subscription_id=? AND match_state='matched' AND status='kept' AND stripe_synced=0`)
    .bind(sub.subscription_id).first()) {
    throw new HTTPError(409, "cancellation_clearing", { message: "You kept your plan. We are confirming that with our payment provider; try the change again in a few minutes." });
  }
  if (sub.cancel_at_period_end === 1 || sub.customer_cancel_at !== null || (sub.cancel_at ?? null) !== null
    || await env.DB.prepare("SELECT 1 AS x FROM terms_change_notices WHERE home_id=? AND cancel_set_at IS NOT NULL AND lifted_at IS NULL").bind(homeId).first()) {
    throw new HTTPError(409, "plan_cancelling");
  }
  if (await env.DB.prepare("SELECT 1 AS x FROM withdrawals WHERE home_id=?").bind(homeId).first()
    || await env.DB.prepare("SELECT 1 AS x FROM refund_ops WHERE home_id=? AND done_at IS NULL").bind(homeId).first()) {
    throw new HTTPError(409, "plan_change_unavailable");
  }
  const from = sub.plan as Plan;
  if (plan === from) throw new HTTPError(409, "same_plan");
  // Downgrades are not offered: a home provisioned on its plan's own type cannot change_type to a smaller root disk (NOTES.md item 5).
  if (PLAN_RANK[plan] < PLAN_RANK[from]) throw new HTTPError(409, "downgrade_not_available");
  if (await env.DB.prepare(`SELECT 1 AS x FROM plan_resizes WHERE home_id=? AND ${ACTIVE_RESIZE}`).bind(homeId).first()
    || await env.DB.prepare("SELECT 1 AS x FROM plan_changes WHERE home_id=? AND state IN ('requested','paid') AND created_at>?").bind(homeId, now - PLAN_CHANGE_LAPSE_MS).first()) {
    throw new HTTPError(409, "change_in_progress");
  }
  // A Link (Managed Payments) sale: Link prices the change in the member's currency on its own page, and no portal configuration is verified
  // to allow upgrades only. Not offered: the member is asked to contact us (fails closed).
  if (await homeSoldByLink(env, homeId, true)) throw new HTTPError(409, "plan_change_unavailable", { contact: true });
  if (!await resizeTarget(env, homeId, plan)) throw new HTTPError(409, "resize_not_available");
  return { sub, from };
}

/** The subscription as Stripe has it now: one item, its price, its period. */
async function liveSubscription(stripe: ReturnType<typeof stripeClient>, subscriptionId: string) {
  const raw = await stripe.retrieveEventObject("subscription", subscriptionId);
  const items = (raw.items as { data?: { id?: string; price?: { id?: string } }[] } | undefined)?.data ?? [];
  const period = subscriptionPeriod(raw);
  if (items.length !== 1 || !items[0].id || !items[0].price?.id || period.start === null || period.end === null) throw new HTTPError(409, "plan_change_unavailable");
  // A dated end (cancel_at, set by a public cancellation and cleared by Keep my plan) counts like cancel_at_period_end: the plan is ending.
  return { status: String(raw.status ?? ""), cancelAtEnd: raw.cancel_at_period_end === true || (typeof raw.cancel_at === "number" && raw.cancel_at > 0),
    pending: raw.pending_update != null,
    itemId: items[0].id, priceId: items[0].price.id, start: period.start, end: period.end };
}

function requireEnabled(env: Env) {
  if (!planChangeEnabled(env)) throw new HTTPError(409, "plan_change_disabled", { contact: true });
}

/** Step 1: a server-issued quote. The amount is Stripe's proration computed at the quote's own timestamp, which the update reuses.
 *  Errors (Astra CANCEL-SUMMARY-2 #8, deliberately distinct): at THIS step, a subscription Stripe shows as not changeable now (ending, a
 *  pending update, another price, outside its period) answers 409 plan_change_unavailable: nothing was quoted. At step 2 the
 *  same live state answers 409 quote_stale: a quote exists but no longer matches Stripe; ask for a new quote. */
async function planQuote(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  requireEnabled(env);
  const body = await readJSON(request, quoteBody);
  const who = await actor(request, env, deps, auth, undefined, "subscribed");
  const user = await currentUser(request, deps, auth);
  const now = nowOf(deps);
  const { sub } = await planChecks(env, who.homeId, body.plan, now);
  const config = cfg(env);
  const stripe = stripeClient(config, deps.stripeFetch);
  try {
    const live = await liveSubscription(stripe, sub.subscription_id!);
    const prorationDate = Math.floor(now / 1000);
    if (live.status !== "active" || live.cancelAtEnd || live.pending || prorationDate < live.start || prorationDate >= live.end
      || live.priceId !== config.priceByPlan[sub.plan as Plan]) throw new HTTPError(409, "plan_change_unavailable");
    const toPrice = config.priceByPlan[body.plan];
    const p = await stripe.previewPriceChange({ subscriptionId: sub.subscription_id!, itemId: live.itemId, priceId: toPrice, prorationDate });
    const id = crypto.randomUUID();
    // The subscription period Stripe prorates over is frozen with the quote: the upgrade's credit grant is prorated over exactly it
    // (flux-grants.ts upgradeAmount, migration 0090).
    await env.DB.prepare(`INSERT INTO plan_quotes (id,home_id,user_id,subscription_id,item_id,from_price,to_plan,to_price,proration_date,amount_cents,currency,created_at,expires_at,sub_period_start,sub_period_end)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, who.homeId, user.id, sub.subscription_id, live.itemId, live.priceId, body.plan, toPrice, prorationDate,
      p.amount_due, p.currency ?? "usd", now, now + QUOTE_TTL_MS, live.start, live.end).run();
    return json({ quoteId: id, change: "upgrade", plan: body.plan, amountDueNowCents: p.amount_due, currency: p.currency ?? "usd", expiresAt: now + QUOTE_TTL_MS });
  } catch (e) { if (e instanceof StripeError) throw new HTTPError(502, "stripe_unavailable"); throw e; }
}

/** Step 2 (step-up): the member accepts that quote. Everything is checked again inside the home's lease, then the subscription is updated
 *  with the quote's own proration_date: Stripe charges exactly the quoted amount, or nothing changes. */
async function changePlan(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  requireEnabled(env);
  const user = await currentUser(request, deps, auth);
  await requireStepUp(request, env, deps, auth);
  const body = await readJSON(request, planBody);
  const quote = await env.DB.prepare("SELECT * FROM plan_quotes WHERE id=? AND user_id=?").bind(body.quoteId, user.id).first<QuoteRow>();
  if (!quote) throw new HTTPError(404, "not_found");
  const home = await env.DB.prepare("SELECT id FROM cloud_homes WHERE id=? AND owner_id=?").bind(quote.home_id, user.id).first();
  if (!home) throw new HTTPError(404, "not_found");
  assertPinnedHome(request, quote.home_id);
  const config = cfg(env);
  const stripe = stripeClient(config, deps.stripeFetch);
  try {
    return await busyAs409(() => withHomeLease(env, quote.home_id, async (lease) => {
      const now = nowOf(deps);
      if (quote.used_at !== null) throw new HTTPError(409, "quote_used");
      if (quote.expires_at <= now) throw new HTTPError(409, "quote_expired");
      const { sub, from } = await planChecks(env, quote.home_id, quote.to_plan as Plan, now);
      if (sub.subscription_id !== quote.subscription_id || config.priceByPlan[quote.to_plan as Plan] !== quote.to_price) throw new HTTPError(409, "quote_stale");
      const live = await liveSubscription(stripe, quote.subscription_id);
      if (live.status !== "active" || live.cancelAtEnd || live.pending || live.itemId !== quote.item_id || live.priceId !== quote.from_price
        || quote.proration_date < live.start || quote.proration_date >= live.end
        || (quote.sub_period_start !== null && (quote.sub_period_start !== live.start || quote.sub_period_end !== live.end))) throw new HTTPError(409, "quote_stale");
      // The same timestamp gives the same proration: confirmed once more before the charge.
      const p = await stripe.previewPriceChange({ subscriptionId: quote.subscription_id, itemId: quote.item_id, priceId: quote.to_price, prorationDate: quote.proration_date });
      if (p.amount_due !== quote.amount_cents || (p.currency ?? "usd") !== quote.currency) throw new HTTPError(409, "quote_stale");
      const id = `planchange:${quote.id}`;
      const claimed = await fencedBatch(env, lease, [
        q("UPDATE plan_quotes SET used_at=? WHERE id=? AND used_at IS NULL", now, quote.id),
        q(`INSERT INTO plan_changes (id,home_id,user_id,quote_id,subscription_id,from_plan,to_plan,amount_cents,currency,state,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,?,?,'requested',?,? WHERE changes()=1`, id, quote.home_id, user.id, quote.id, quote.subscription_id, from, quote.to_plan,
          quote.amount_cents, quote.currency, now, now),
      ]);
      if (claimed[0].meta.changes !== 1) throw new HTTPError(409, "quote_used");
      // pending_if_incomplete: the new price applies only once the upgrade's own invoice is paid. A decline leaves the plan and the paid
      // subscription exactly as they were (the webhook handles that invoice apart from renewals). Astra JOURNEY-BCORE-6 #1: through the gateway
      // (it fences the lease): a parked subscription (an attached schedule ops must resolve) is never written; the change is not sent.
      let updated: SubscriptionAnswer<"price">;
      try {
        const w = await writeSubscription(env, lease, stripe, quote.subscription_id, { kind: "price", itemId: quote.item_id, priceId: quote.to_price,
          prorationDate: quote.proration_date, key: id });
        if (w.parked) {
          await fencedRun(env, lease, "UPDATE plan_changes SET state='not_sent',updated_at=? WHERE id=?", now, id);
          throw new HTTPError(409, "plan_change_unavailable");
        }
        updated = w.answer;
      } catch (e) {
        if (e instanceof StripeError && e.status === 402) {
          await fencedRun(env, lease, "UPDATE plan_changes SET state='payment_failed',updated_at=? WHERE id=?", now, id);
          throw new HTTPError(402, "payment_declined");
        }
        throw e;
      }
      const invoice = typeof updated.latest_invoice === "string" ? updated.latest_invoice : updated.latest_invoice?.id ?? null;
      await fencedRun(env, lease, "UPDATE plan_changes SET invoice_id=?,updated_at=? WHERE id=?", invoice, now, id);
      return json({ change: "upgrade", plan: quote.to_plan, amountDueNowCents: quote.amount_cents, currency: quote.currency,
        state: updated.pending_update != null ? "awaiting_payment" : "requested" });
    }, deps.lease));
  } catch (e) { if (e instanceof StripeError) throw new HTTPError(502, "stripe_unavailable"); throw e; }
}
interface QuoteRow { id: string; home_id: string; user_id: string; subscription_id: string; item_id: string; from_price: string; to_plan: string;
  to_price: string; proration_date: number; amount_cents: number; currency: string; created_at: number; expires_at: number; used_at: number | null;
  sub_period_start: number | null; sub_period_end: number | null }

async function planStatus(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response> {
  const who = await actor(request, env, deps, auth, undefined, "subscribed");
  const sub = await getSub(env, who.homeId);
  const now = nowOf(deps);
  const change = await env.DB.prepare("SELECT to_plan,state,amount_cents,currency,created_at FROM plan_changes WHERE home_id=? ORDER BY created_at DESC LIMIT 1")
    .bind(who.homeId).first<{ to_plan: string; state: string; amount_cents: number; currency: string; created_at: number }>();
  const resize = await env.DB.prepare("SELECT from_plan,to_plan,state,updated_at,done_at FROM plan_resizes WHERE home_id=? ORDER BY created_at DESC LIMIT 1")
    .bind(who.homeId).first<{ from_plan: string; to_plan: string; state: string; updated_at: number; done_at: number | null }>();
  const live = change && ["requested", "paid"].includes(change.state) && change.created_at > now - PLAN_CHANGE_LAPSE_MS;
  return json({ homeId: who.homeId, plan: sub?.plan ?? null, changeAvailable: planChangeEnabled(env),
    pendingChange: live ? { plan: change.to_plan, state: change.state, amountDueNowCents: change.amount_cents, currency: change.currency, requestedAt: change.created_at } : null,
    lastChange: change && !live ? { plan: change.to_plan, state: change.state === "requested" ? "expired" : change.state } : null,
    resize: resize ? { from: resize.from_plan, to: resize.to_plan, state: resize.state === "done" ? "done" : ["unhealthy", "failed"].includes(resize.state) ? "needs_attention" : "in_progress",
      updatedAt: resize.updated_at, doneAt: resize.done_at } : null,
    downgrade: { available: false, reason: "downgrade_not_available" } });
}

// ---- Webhook side -------------------------------------------------------------------------------------------------------------------

/** customer.subscription.updated moved the plan: statements committed in the SAME batch as the plan itself, so a crash or a failing Flux call
 *  can never leave the plan moved and the resize lost. An upgrade queues the resize (bound to the home's lifecycle generation); a downgrade
 *  (only possible if a portal allows it: every portal entry is pinned to a configuration without plan switching) resizes nothing and is an
 *  alert. */
export function planMovedStatements(homeId: string, subscriptionId: string, from: string, to: string, now: number, enabled = true): Q[] {
  const out: Q[] = [q("UPDATE plan_changes SET state='applied',updated_at=? WHERE home_id=? AND subscription_id=? AND to_plan=? AND state IN ('requested','paid','payment_failed')",
    now, homeId, subscriptionId, to)];
  const rf = PLAN_RANK[from as Plan]; const rt = PLAN_RANK[to as Plan];
  if (rf === undefined || rt === undefined) return out;
  // Plan change switched off (CLOUD_PLAN_CHANGE): a move made at Stripe (the Dashboard) is recorded as billed, ops are told, and nothing
  // new starts: no resize. Credits follow only verified upgrades (the invoice handler).
  if (!enabled) {
    out.push(q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING", crypto.randomUUID(), homeId,
      "plan.changed_while_plan_change_off", "high", JSON.stringify({ from, to, subscriptionId }), now));
    return out;
  }
  if (rt < rf) {
    out.push(q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING", crypto.randomUUID(), homeId,
      "plan.downgrade_without_resize", "high", JSON.stringify({ from, to, subscriptionId }), now));
    return out;
  }
  out.push(q(`INSERT OR IGNORE INTO plan_resizes (id,home_id,generation,resource_generation,from_plan,to_plan,state,next_at,created_at,updated_at)
    SELECT ?,id,generation,resource_generation,?,?,'queued',?,?,? FROM cloud_homes WHERE id=?`, `resize:${homeId}:${subscriptionId}:${to}`, from, to, now, now, now, homeId));
  return out;
}

/** invoice.payment_failed / invoice.paid for an upgrade's own invoice (billing_reason subscription_update, or recorded on a plan change).
 *  A failed upgrade payment never touches the paid subscription, its status or its entitlement: the plan change alone fails. Returns the
 *  outcome when the invoice was an upgrade's, else null. */
export async function upgradeInvoiceOutcome(env: Env, lease: HomeLease, homeId: string, invoiceId: string | null, billingReason: string | null,
  paid: boolean, now: number): Promise<string | null> {
  const change = invoiceId ? await env.DB.prepare("SELECT id FROM plan_changes WHERE invoice_id=? AND home_id=?").bind(invoiceId, homeId).first<{ id: string }>() : null;
  if (!change && billingReason !== "subscription_update") return null;
  if (change) {
    // A verified success advances a failed attempt (Stripe lets a pending update be paid after a decline); a later failure delivery never
    // regresses a paid or applied change.
    if (paid) await fencedRun(env, lease, "UPDATE plan_changes SET state='paid',updated_at=? WHERE id=? AND state IN ('requested','payment_failed')", now, change.id);
    else await fencedRun(env, lease, "UPDATE plan_changes SET state='payment_failed',updated_at=? WHERE id=? AND state='requested'", now, change.id);
  }
  return paid ? null : "upgrade_payment_failed";
}

// ---- Resize job (cron sweep) ----------------------------------------------------------------------------------------------------------

/** The server resize that follows an upgrade (build host only). Injected in tests; default: the build host Cloud API with HCLOUD_TOKEN. Every
 *  mutating call returns the provider action id; failures throw ResizeHostError with the HTTP status. */
export interface ResizeHost {
  findServer(homeId: string, generation: number): Promise<{ id: string } | null>;
  server(serverId: string): Promise<{ status: string; type: string }>;
  snapshot(serverId: string, homeId: string, generation: number): Promise<{ imageId: string; actionId: string }>;
  /** "available" once the image can be used. */
  image(imageId: string): Promise<string>;
  /** A graceful (ACPI) shutdown: its action only says the request was sent. */
  shutdown(serverId: string): Promise<string>;
  forceOff(serverId: string): Promise<string>;
  powerOn(serverId: string): Promise<string>;
  /** build host change_type with upgrade_disk=false (the root disk keeps its size, so a later downgrade stays possible). */
  changeType(serverId: string, serverType: string): Promise<string>;
  action(actionId: string): Promise<"running" | "success" | "error">;
}
export class ResizeHostError extends Error { constructor(public readonly status: number) { super(`hetzner_${status}`); } }
export interface MembersDependencies extends BillingDependencies { resizeHost?: ResizeHost }

export function hetznerResizeHost(token: string, fetcher: typeof fetch = fetch): ResizeHost {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetcher(`https://api.hetzner.cloud/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new ResizeHostError(r.status);
    return await r.json() as T;
  };
  const act = async (serverId: string, name: string, body: unknown = {}) =>
    String((await call<{ action: { id: number } }>("POST", `/servers/${Number(serverId)}/actions/${name}`, body)).action.id);
  const sel = (homeId: string, gen: number, role: string) => encodeURIComponent(`murage/home=${homeId},murage/generation=${gen},murage/role=${role}`);
  return {
    async findServer(homeId, gen) {
      const s = (await call<{ servers: { id: number }[] }>("GET", `/servers?label_selector=${sel(homeId, gen, "home")}`)).servers;
      return s.length === 1 ? { id: String(s[0].id) } : null;
    },
    async server(id) {
      const s = (await call<{ server: { status: string; server_type: { name: string } } }>("GET", `/servers/${Number(id)}`)).server;
      return { status: s.status, type: s.server_type.name };
    },
    async snapshot(serverId, homeId, gen) {
      // Labelled like the lifecycle's own snapshots, so the home's deletion purges it too (purge_snapshots lists by these labels).
      const r = await call<{ image: { id: number }; action: { id: number } }>("POST", `/servers/${Number(serverId)}/actions/create_image`, { type: "snapshot",
        description: `murage-${homeId}-${gen}-resize`, labels: { "murage/home": homeId, "murage/generation": String(gen), "murage/role": "snapshot" } });
      return { imageId: String(r.image.id), actionId: String(r.action.id) };
    },
    async image(id) { return (await call<{ image: { status: string } }>("GET", `/images/${Number(id)}`)).image.status; },
    shutdown: (id) => act(id, "shutdown"),
    forceOff: (id) => act(id, "poweroff"),
    powerOn: (id) => act(id, "poweron"),
    changeType: (id, type) => act(id, "change_type", { server_type: type, upgrade_disk: false }),
    async action(id) { const s = (await call<{ action: { status: string } }>("GET", `/actions/${Number(id)}`)).action.status; return s === "success" ? "success" : s === "error" ? "error" : "running"; },
  };
}

interface ResizeRow { id: string; home_id: string; generation: number; resource_generation: number; from_plan: string; to_plan: string; state: string;
  server_id: string | null; from_type: string | null; target_type: string | null; action_id: string | null; snapshot_ref: string | null; pending_op: string | null;
  attempts: number; powered_on_at: number | null; step_at: number | null; shutdown_sent_at: number | null; next_at: number; alerted_at: number | null; last_error: string | null; created_at: number }
/** A graceful shutdown gets this long before a hard power-off. */
export const SHUTDOWN_GRACE_MS = 3 * MINUTE;
/** After a shutdown was sent, a server still reporting "running" is watched this long before recovery concludes the shutdown never took
 *  (an ACPI shutdown may complete well after it was acknowledged). */
export const SHUTDOWN_WATCH_MS = 4 * SHUTDOWN_GRACE_MS;
/** How soon a running server with a shutdown still outstanding is read again: every minute for the first hour, then every 5 minutes for
 *  a day, then every 15 minutes for as long as it takes (never terminal on time alone). */
export function outstandingRecheckMs(sinceShutdownMs: number): number {
  return sinceShutdownMs < HOUR ? MINUTE : sinceShutdownMs < 24 * HOUR ? 5 * MINUTE : 15 * MINUTE;
}
/** Lifecycles that power the home off themselves (b3-control fences them): recovery never restores a server under them. */
const LIFECYCLE_OFF = new Set(["stopped", "suspended", "deleting", "deleted"]);
/** A snapshot that is not usable in this long fails the resize (the server was never touched). */
export const SNAPSHOT_MAX_MS = 2 * HOUR;
/** A step that keeps failing this many times stops: before the shutdown the job fails (server untouched); after it, recovery powers the
 *  server back on if the lifecycle allows it. A definite refusal (4xx other than 409/423/429) of change_type goes to recovery at once. */
export const RESIZE_MAX_ATTEMPTS = 5;
const TERMINAL = new Set(["done", "unhealthy", "failed"]);
/** States in which the server may be off: any trouble here is recovered (powered back on when the lifecycle allows it). */
const MAY_BE_OFF = new Set(["powering_off", "changing"]);
/** Journaled calls after which the server may be off whatever the state says (an accepted call whose answer was lost). */
const OFF_OPS = new Set(["shutdown", "forceoff", "change_type"]);
class ClaimLost extends Error { constructor() { super("resize_claim_lost"); } }
/** Backoff between retries of a step that failed (or could not run): 2, 4, 8, 16, then every 30 minutes. */
const retryMs = (attempts: number) => Math.min(30, 2 ** attempts) * MINUTE;
/** The job owes the owner a verified restoration: a shutdown was (or may have been) sent and the server has not been verified back on.
 *  Such a job is never terminal on a failure: it alerts and retries until restoration is verified or a lifecycle takes the server over. */
function restorationOwed(job: ResizeRow): boolean {
  return MAY_BE_OFF.has(job.state) || OFF_OPS.has(job.pending_op ?? "") || job.shutdown_sent_at !== null || ["recovering", "restoring", "powering_on"].includes(job.state);
}
/** A lifecycle that powers the home off itself (stop, suspension, deletion, a new resource generation) owns the server now: nothing to
 *  restore, so a still-outstanding shutdown is moot. Not for a completed resize (its server is reconciled first). */
function lifecycleTookOver(job: ResizeRow, home: { desired_state: string; resource_generation: number }): boolean {
  const outstanding = job.shutdown_sent_at !== null || OFF_OPS.has(job.pending_op ?? "");
  return outstanding && job.last_error !== "resized" && (LIFECYCLE_OFF.has(home.desired_state) || home.resource_generation !== job.resource_generation);
}

/** One step of every due resize, and the lapse of plan changes Stripe never completed. Each resize step re-reads and claims its job INSIDE
 *  the home's billing lease, checks the lifecycle before every provider call, and journals the call before making it. */
export async function sweepPlanResizes(env: Env, deps: MembersDependencies = {}): Promise<void> {
  const now = nowOf(deps);
  await lapsePlanChanges(env, deps, now);
  const host = deps.resizeHost ?? (env.HCLOUD_TOKEN ? hetznerResizeHost(env.HCLOUD_TOKEN) : null);
  const due = await env.DB.prepare(`SELECT id,home_id FROM plan_resizes WHERE ${ACTIVE_RESIZE} AND next_at<=? ORDER BY next_at LIMIT 10`).bind(now).all<{ id: string; home_id: string }>();
  for (const d of due.results) {
    try { await withHomeLease(env, d.home_id, (lease) => resizeClaimed(env, lease, host, d.id, now)); }
    catch (e) { if (!(e instanceof HomeBusy || e instanceof LeaseLost || e instanceof ClaimLost)) throw e; }
  }
}

async function resizeClaimed(env: Env, lease: HomeLease, host: ResizeHost | null, id: string, now: number): Promise<void> {
  // The job as it is NOW (another sweep may have advanced it after the list above was read).
  const job = await env.DB.prepare("SELECT * FROM plan_resizes WHERE id=?").bind(id).first<ResizeRow>();
  if (!job || TERMINAL.has(job.state) || job.next_at > now) return;
  try { await resizeStep(env, lease, host, job, now); }
  catch (e) {
    if (e instanceof LeaseLost || e instanceof ClaimLost) throw e;
    const code = (e instanceof Error ? e.message : "error").slice(0, 80);
    const attempts = job.attempts + 1;
    const definite = e instanceof ResizeHostError && e.status >= 400 && e.status < 500 && ![409, 423, 429].includes(e.status);
    // Durable recovery, never a terminal failure, whenever the server may be off: the journal is kept until the server is reconciled.
    const mayBeOff = MAY_BE_OFF.has(job.state) || OFF_OPS.has(job.pending_op ?? "");
    if (mayBeOff && (attempts >= RESIZE_MAX_ATTEMPTS || (definite && job.pending_op === "change_type"))) {
      await claimSet(env, lease, job, now, "state='recovering',attempts=?,last_error=?,next_at=?", attempts, code, now);
      return;
    }
    if (!mayBeOff && attempts >= RESIZE_MAX_ATTEMPTS && !restorationOwed(job)) {
      await finish(env, lease, job, now, job.state === "powering_on" || job.state === "checking" ? "unhealthy" : "failed", code);
      return;
    }
    if (attempts === RESIZE_MAX_ATTEMPTS) await alert(env, job.home_id, "plan.resize_stuck", "high", { resizeId: job.id, state: job.state, error: code }, now);
    await claimSet(env, lease, job, now, "attempts=?,last_error=?,next_at=?", attempts, code, now + retryMs(attempts));
  }
}

/** A fenced write that must hit exactly this job in exactly the state it was read in; otherwise the claim is lost and the step stops. */
async function claimSet(env: Env, lease: HomeLease, job: ResizeRow, now: number, fields: string, ...binds: unknown[]): Promise<void> {
  const n = await fencedRun(env, lease, `UPDATE plan_resizes SET ${fields},updated_at=? WHERE id=? AND state=? AND attempts=?`, ...binds, now, job.id, job.state, job.attempts);
  if (n !== 1) throw new ClaimLost();
  job.attempts = (fields.includes("attempts=?") ? (binds[0] as number) : job.attempts);
}
async function finish(env: Env, lease: HomeLease, job: ResizeRow, now: number, state: "done" | "failed" | "unhealthy", why: string | null): Promise<void> {
  await claimSet(env, lease, job, now, "state=?,last_error=?,pending_op=NULL,done_at=?", state, why, now);
  if (state !== "done") await alert(env, job.home_id, `plan.resize_${state}`, "high", { resizeId: job.id, from: job.from_plan, to: job.to_plan, why, server: job.server_id }, now);
}

async function resizeStep(env: Env, lease: HomeLease, host: ResizeHost | null, job: ResizeRow, now: number): Promise<void> {
  const home = await env.DB.prepare("SELECT desired_state,generation,resource_generation,heartbeat_at FROM cloud_homes WHERE id=?").bind(job.home_id)
    .first<{ desired_state: string; generation: number; resource_generation: number; heartbeat_at: number | null }>();
  if (!home) return finish(env, lease, job, now, "failed", "home_missing");
  // The lifecycle fence: the home is still the one the job was queued for, and its owner wants it running.
  const lifecycleOk = home.desired_state === "ready" && home.generation === job.generation && home.resource_generation === job.resource_generation;
  const set = (fields: string, ...binds: unknown[]) => claimSet(env, lease, job, now, fields, ...binds);
  // Plan change switched off: recovery-only draining. Nothing new starts (no snapshot, shutdown or change_type); a call already made is
  // finished and the server is brought back on through recovery.
  const draining = !planChangeEnabled(env);
  /** Journal the call, fence the lease, make the call. */
  const journaled = async <T>(op: string, call: () => Promise<T>): Promise<T> => {
    await set("pending_op=?,step_at=?", op, now);
    job.pending_op = op;
    await fence(env, lease);
    return call();
  };
  if (job.state !== "queued" && !host) {
    if (!restorationOwed(job)) return finish(env, lease, job, now, "failed", "provider_unconfigured");
    // The server may be off and the provider cannot be reached right now: never terminal. The journal is kept, ops are told, and the
    // step is retried with backoff until the configuration is back (or the lifecycle takes the server over).
    if (job.state === "recovering" && lifecycleTookOver(job, home)) return finish(env, lease, job, now, "failed", `left_off_lifecycle_${home.desired_state}`);
    const attempts = job.attempts + 1;
    await alert(env, job.home_id, "plan.resize_provider_unconfigured", "high", { resizeId: job.id, state: job.state, server: job.server_id }, now);
    return set("attempts=?,next_at=?", attempts, now + retryMs(attempts));
  }

  // A provider call whose answer was lost: read the server and decide from what it actually is.
  if (job.pending_op && job.server_id && host && !["recovering", "restoring"].includes(job.state)) {
    const s = await host.server(job.server_id);
    const op = job.pending_op;
    if (op === "change_type" && s.type === job.target_type) return set("state='changing',pending_op=NULL,action_id=NULL,next_at=?", now);
    if ((op === "shutdown" || op === "forceoff") && s.status === "off") return set("state='powering_off',pending_op=NULL,action_id=NULL,shutdown_sent_at=COALESCE(shutdown_sent_at,step_at),next_at=?", now);
    if (op === "poweron" && s.status === "running") return set("state='powering_on',pending_op=NULL,action_id=NULL,next_at=?", now);
    // Draining with a shutdown that may still be under way: recovery waits it out and powers the server back on (journal kept).
    if (draining && OFF_OPS.has(op)) return set("state='recovering',last_error='drained_plan_change_off',shutdown_sent_at=COALESCE(shutdown_sent_at,step_at),next_at=?", now);
    await set("pending_op=NULL");
    job.pending_op = null;
  }

  switch (job.state) {
    case "queued": {
      if (draining) return finish(env, lease, job, now, "failed", "drained_plan_change_off");
      if (home.desired_state !== "ready") return set("next_at=?", now + 15 * MINUTE);
      // Nothing has been touched yet: a lifecycle change since queueing re-baselines the job on the current generation.
      if (home.generation !== job.generation || home.resource_generation !== job.resource_generation) {
        return set("generation=?,resource_generation=?,next_at=?", home.generation, home.resource_generation, now);
      }
      const target = await resizeTarget(env, job.home_id, job.to_plan);
      if (!target) return finish(env, lease, job, now, "failed", "no_resize_target");
      if (target.targetType === target.fromType) { await set("from_type=?,target_type=?", target.fromType, target.targetType); return finish(env, lease, job, now, "done", null); }
      if (!host) return finish(env, lease, job, now, "failed", "provider_unconfigured");
      if (!await backupFresh(env, lease, job, now)) return;
      const server = await host.findServer(job.home_id, home.resource_generation);
      if (!server) return finish(env, lease, job, now, "failed", "server_not_found");
      await set("server_id=?,from_type=?,target_type=?", server.id, target.fromType, target.targetType);
      job.server_id = server.id;
      const snap = await journaled("snapshot", () => host.snapshot(server.id, job.home_id, home.resource_generation));
      return set("state='snapshotting',snapshot_ref=?,action_id=?,pending_op=NULL,step_at=?,next_at=?", snap.imageId, snap.actionId, now, now + MINUTE);
    }
    case "snapshotting": {
      if (draining) return finish(env, lease, job, now, "failed", "drained_plan_change_off");
      if (!lifecycleOk) return finish(env, lease, job, now, "failed", `lifecycle_${home.desired_state}`);
      const st = await host!.action(job.action_id!);
      const image = st === "success" ? await host!.image(job.snapshot_ref!) : null;
      if (st === "error" || (image !== null && image !== "available" && image !== "creating")) return finish(env, lease, job, now, "failed", "snapshot_failed");
      if (image === "available") return set("state='snapshotted',action_id=NULL,next_at=?", now);
      if (now - (job.step_at ?? now) > SNAPSHOT_MAX_MS) return finish(env, lease, job, now, "failed", "snapshot_timeout");
      return set("next_at=?", now + MINUTE);
    }
    case "snapshotted": {
      if (draining) return finish(env, lease, job, now, "failed", "drained_plan_change_off");
      if (!lifecycleOk) return finish(env, lease, job, now, "failed", `lifecycle_${home.desired_state}`);
      // Right before the shutdown: the volume backup must still be fresh.
      if (!await backupFresh(env, lease, job, now)) return;
      const action = await journaled("shutdown", () => host!.shutdown(job.server_id!));
      // The marker outlives the acknowledgement: until the server is verified back on, recovery treats a shutdown as outstanding.
      return set("state='powering_off',action_id=?,pending_op=NULL,step_at=?,shutdown_sent_at=?,next_at=?", action, now, now, now + MINUTE);
    }
    case "powering_off": {
      if (draining) return set("state='recovering',last_error='drained_plan_change_off',next_at=?", now);
      if (!lifecycleOk) return set("state='recovering',last_error=?,next_at=?", `lifecycle_${home.desired_state}`, now);
      if (job.action_id && await host!.action(job.action_id) === "running") return set("next_at=?", now + MINUTE);
      // The shutdown action only says the ACPI request was sent: change_type waits until the server is really off.
      const s = await host!.server(job.server_id!);
      if (s.status !== "off") {
        if (now - (job.step_at ?? now) > SHUTDOWN_GRACE_MS && job.last_error !== "forced_off") {
          const a = await journaled("forceoff", () => host!.forceOff(job.server_id!));
          return set("action_id=?,pending_op=NULL,last_error='forced_off',next_at=?", a, now + MINUTE);
        }
        if (now - (job.step_at ?? now) > 4 * SHUTDOWN_GRACE_MS) return set("state='recovering',last_error='would_not_stop',next_at=?", now);
        return set("next_at=?", now + MINUTE);
      }
      const a = await journaled("change_type", () => host!.changeType(job.server_id!, job.target_type!));
      return set("state='changing',action_id=?,pending_op=NULL,step_at=?,next_at=?", a, now, now + MINUTE);
    }
    case "changing": {
      const st = job.action_id ? await host!.action(job.action_id) : "success";
      if (st === "running") return set("next_at=?", now + MINUTE);
      const s = await host!.server(job.server_id!);
      if (st === "error" || s.type !== job.target_type) return set("state='recovering',last_error='change_type_failed',next_at=?", now);
      // The home's record follows the server it now runs on, in the same write as the step.
      await fencedBatch(env, lease, [
        q("UPDATE provision_choices SET server_type=? WHERE home_id=? AND resource_generation=?", job.target_type, job.home_id, job.resource_generation),
        q("UPDATE plan_resizes SET state='recovering',last_error='resized',updated_at=? WHERE id=? AND state='changing'", now, job.id),
      ]);
      // Powering on is the recovery path's own step: it powers the server on only when the lifecycle allows it.
      job.state = "recovering"; job.last_error = "resized";
      return resizeStep(env, lease, host, job, now);
    }
    case "recovering": {
      // The server is (or may be) off. Back on only if the owner's lifecycle still wants it running; otherwise left off and ops told.
      const resized = job.last_error === "resized";
      const outstanding = job.shutdown_sent_at !== null || OFF_OPS.has(job.pending_op ?? "");
      // Decided before the server read (a deleted server can no longer be read).
      if (lifecycleTookOver(job, home)) return finish(env, lease, job, now, "failed", `left_off_lifecycle_${home.desired_state}`);
      const s = await host!.server(job.server_id!);
      if (s.status === "running") {
        if (resized) return set("state='checking',powered_on_at=?,shutdown_sent_at=NULL,next_at=?", now, now + MINUTE);
        if (outstanding) {
          // A shutdown was sent and may still complete (ACPI), however late. Elapsed time alone never clears the journal: the marker and
          // this nonterminal state stay until the shutdown and the restoration are both verified, so a late shutdown is always powered
          // back on. Nothing else powers a ready home back on (no watchdog), so there is no terminal timeout: past the watch, ops are
          // told once and the server is re-read at a lower, bounded frequency indefinitely. No hand resolution is ever needed.
          const since = now - (job.shutdown_sent_at ?? job.step_at ?? now);
          if (since >= SHUTDOWN_WATCH_MS && job.last_error !== "shutdown_watch_expired") {
            await alert(env, job.home_id, "plan.resize_shutdown_outstanding", "high",
              { resizeId: job.id, server: job.server_id, shutdownSentAt: job.shutdown_sent_at ?? job.step_at, cause: job.last_error }, now);
            return set("last_error='shutdown_watch_expired',shutdown_sent_at=COALESCE(shutdown_sent_at,step_at,?),next_at=?", now, now + outstandingRecheckMs(since));
          }
          return set("next_at=?", now + outstandingRecheckMs(since));
        }
        return finish(env, lease, job, now, "failed", job.last_error ?? "recovered_running");
      }
      if (s.status !== "off") return set("next_at=?", now + MINUTE); // stopping or starting: look again
      if (home.desired_state !== "ready" || home.resource_generation !== job.resource_generation) {
        return finish(env, lease, job, now, "failed", `left_off_lifecycle_${home.desired_state}`);
      }
      const a = await journaled("poweron", () => host!.powerOn(job.server_id!));
      return set(`state=?,action_id=?,pending_op=NULL,step_at=?,next_at=?`, resized ? "powering_on" : "restoring", a, now, now + MINUTE);
    }
    case "restoring": case "powering_on": {
      const st = job.action_id ? await host!.action(job.action_id) : "success";
      if (st === "running") return set("next_at=?", now + MINUTE);
      // Restoration is verified on the server itself before the outstanding shutdown is cleared, whatever the action reported.
      const s = await host!.server(job.server_id!);
      if (st === "error" && s.status !== "running") {
        // An errored power-on is never terminal: ops are told, and after a backoff the server is reconciled again (no action pending:
        // running is verified restoration; off goes back through recovery, which powers it on again when the lifecycle allows it).
        const attempts = job.attempts + 1;
        await alert(env, job.home_id, "plan.resize_power_on_failed", "high", { resizeId: job.id, server: job.server_id, status: s.status, cause: job.last_error }, now);
        return set("attempts=?,action_id=NULL,next_at=?", attempts, now + retryMs(attempts));
      }
      if (s.status === "off") return set("state='recovering',next_at=?", now);
      if (s.status !== "running") return set("next_at=?", now + MINUTE);
      await set("shutdown_sent_at=NULL");
      if (job.state === "restoring") return finish(env, lease, job, now, "failed", `resize_failed_server_restarted:${job.last_error ?? ""}`);
      return set("state='checking',powered_on_at=?,next_at=?", now, now + MINUTE);
    }
    case "checking": {
      if (home.desired_state !== "ready" || home.resource_generation !== job.resource_generation) return finish(env, lease, job, now, "failed", `lifecycle_${home.desired_state}`);
      if (home.heartbeat_at !== null && job.powered_on_at !== null && home.heartbeat_at > job.powered_on_at) return finish(env, lease, job, now, "done", null);
      if (now - (job.powered_on_at ?? now) > RESIZE_HEALTH_MS) return finish(env, lease, job, now, "unhealthy", "no_heartbeat_after_resize");
      return set("next_at=?", now + MINUTE);
    }
  }
}

/** True when the home's data volume has a backup newer than BACKUP_STALE_MS (the home reports it). Otherwise the job waits, with an alert
 *  after a day. */
async function backupFresh(env: Env, lease: HomeLease, job: ResizeRow, now: number): Promise<boolean> {
  const health = await env.DB.prepare("SELECT last_backup_at FROM cloud_home_health WHERE home_id=?").bind(job.home_id).first<{ last_backup_at: number | null }>();
  if (health?.last_backup_at && now - health.last_backup_at <= BACKUP_STALE_MS) return true;
  if (job.alerted_at === null && now - job.created_at > RESIZE_BACKUP_WAIT_ALERT_MS) {
    await alert(env, job.home_id, "plan.resize_waiting_for_backup", "high", { resizeId: job.id, lastBackupAt: health?.last_backup_at ?? null }, now);
    await claimSet(env, lease, job, now, "alerted_at=?,next_at=?", now, now + 15 * MINUTE);
  } else await claimSet(env, lease, job, now, "next_at=?", now + 15 * MINUTE);
  return false;
}

/** A plan change Stripe never completed (the pending update lapsed, or the payment kept failing): its open invoice is voided so it can
 *  never be paid later for an upgrade that did not happen, and the change is marked expired. */
async function lapsePlanChanges(env: Env, deps: BillingDependencies, now: number): Promise<void> {
  const rows = await env.DB.prepare("SELECT id,home_id,invoice_id FROM plan_changes WHERE state IN ('requested','payment_failed') AND created_at<=? LIMIT 20")
    .bind(now - PLAN_CHANGE_LAPSE_MS).all<{ id: string; home_id: string; invoice_id: string | null }>();
  if (!rows.results.length) return;
  let stripe: ReturnType<typeof stripeClient>;
  try { stripe = stripeClient(cfg(env), deps.stripeFetch); } catch { return; }
  for (const r of rows.results) {
    try {
      await withHomeLease(env, r.home_id, async (lease) => {
        if (r.invoice_id) {
          const inv = await stripe.getInvoice(r.invoice_id);
          if (inv.status === "paid") return; // paid after all: invoice.paid and subscription.updated settle it
          if (inv.status === "open" || inv.status === "draft") { await fence(env, lease); await stripe.voidInvoice(r.invoice_id, `planvoid:${r.invoice_id}`); }
        }
        await fencedRun(env, lease, "UPDATE plan_changes SET state='expired',updated_at=? WHERE id=? AND state IN ('requested','payment_failed')", now, r.id);
      });
    } catch (e) { if (!(e instanceof HomeBusy || e instanceof LeaseLost || e instanceof StripeError)) throw e; }
  }
}

// ---- Routing -----------------------------------------------------------------------------------------------------------------------

export const MEMBERS_PATHS: ReadonlySet<string> = new Set(["/v1/account/order", "/v1/account/deletion", "/v1/billing/checkout/resume",
  "/v1/account/plan/preview", "/v1/account/plan"]);

export async function membersRoute(request: Request, env: Env, deps: BillingDependencies, auth: ControlPlaneAuth): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!MEMBERS_PATHS.has(path)) return null;
  // Authentication first (CONTRACT.md 2a): no method, body or configuration answer reaches a caller who is not signed in.
  await currentUser(request, deps, auth);
  const m = request.method;
  const only = (method: string) => { if (m !== method) throw new HTTPError(405, "method_not_allowed"); };
  if (path === "/v1/account/order") { only("GET"); return order(request, env, deps, auth); }
  if (path === "/v1/account/deletion") { only("GET"); return deletion(request, env, deps, auth); }
  if (path === "/v1/billing/checkout/resume") { only("POST"); return resumeCheckout(request, env, deps, auth); }
  if (path === "/v1/account/plan/preview") { only("POST"); return planQuote(request, env, deps, auth); }
  if (path === "/v1/account/plan") {
    if (m === "GET") return planStatus(request, env, deps, auth);
    only("POST"); return changePlan(request, env, deps, auth);
  }
  return null;
}
