// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra INTEGRATED-3 probes #2 to #6 (and the staging failed-setup shape), each reproduced and then shown fixed; INTEGRATED-4 #2's ledger cap
// and #3 (expiry candidates) too. #1 is in
// purchase-bootstrap.test.ts (it drives the real paid webhooks); the parked-dispute checkpoint replay is in customer-journey-b.test.ts.
// Real workerd + D1, the B3 fake provider, Stripe as a fixture. No network.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { fakeProvider } from "../src/b3-provider";
import { CHECKOUT_MAY_SETTLE_SQL, expireReservations } from "../src/b3-control";
import { CancelUnconfirmed, claimQs, getSub, invoiceRefundCoverage, planEndState, reconcileHomeAttempts, reconcilePaymentCoverage, reconcileSessionMarker, syncCancellation,
  type BillingDependencies, type BillingNotifier, type FluxEntitlementHooks } from "../src/b5-billing";
import { advanceRefundOp, refundOpInsert } from "../src/legal-refunds";
import { fencedBatch, withHomeLease } from "../src/billing-lease";
import { DELETION_BILLING_OPEN_SQL } from "../src/subscription-gateway";
import { StripeError, stripeClient, type StripeClient } from "../src/b5-stripe";
import { consentFor, seedPendingQuotes } from "./legal-helpers";
import membersSource from "../src/members-api.ts?raw";
import m0100 from "../migrations/0100_stripe_end_backfill_correction.sql?raw";
import { customerFake } from "./stripe-customer-fake";

const ADMIN = "test-only-integrated3-admin-no-real-access";
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const USER = "int3-user";
const IMAGE = `sha256:${"a".repeat(64)}`;
const B3 = { reservationMs: 30 * 60_000, graceMs: 3 * DAY, retentionMs: 14 * DAY, imageDigest: IMAGE, quarantineRelayIP: "192.0.2.20",
  engineSubscriptionGates: { claudeAgent: true, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: true },
  capacity: [1, 2].map((n) => ({ id: `slot-${n}`, projectId: "p1", location: "fsn1", serverType: "cx23", outcome: "available" })) };
const baseEnv = (): Env => ({ ...env, CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_KEK_V1: btoa("x".repeat(32)), CLOUD_B3_MODE: "fake", CLOUD_B3_CONFIG: JSON.stringify(B3),
  CLOUD_HOME_HOST_SUFFIX: "murage.test", CLOUD_HOME_ZONE_ID: "0".repeat(32), CLOUD_HOME_ACCOUNT_ID: "0".repeat(32), CLOUD_HOME_API_TOKEN: "test-only-cloud-home-token-no-access",
  STRIPE_SECRET_KEY: "sk_test_fixturefixturefixture", STRIPE_WEBHOOK_SECRET: "whsec_testonlyfixturesecret0123456789", BILLING_RETURN_ORIGIN: "https://cloud.murage.test",
  STRIPE_PRICE_STARTER: "price_starter0001", STRIPE_PRICE_PRO: "price_pro00000001", STRIPE_PRICE_MAX: "price_max000000001" } as unknown as Env);

// Stripe over fetch: a stateful subscription, the customer and the checkout used by reserve/checkout. `subFails`: every subscription call is a 500.
let subFails: boolean;
let subState: { cancel_at_period_end: boolean; status: string };
let subPosts: string[];
const LATE_SUB = "sub_int3_late";
const cust = customerFake();
const stripeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  // The customer preset (Astra TAXCOUNTRY-1): customers persisted by a shared fake.
  { const cr = await cust.handle(init?.method ?? "GET", new URL(String(input)), new URLSearchParams(String(init?.body ?? ""))); if (cr) return cr; }
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s });
  if (url.pathname === "/v1/customers") return j({ id: "cus_int3" });
  if (url.pathname === "/v1/checkout/sessions" && method === "GET") return j({ data: [], has_more: false });
  if (url.pathname === "/v1/checkout/sessions" && method === "POST") return j({ id: "cs_test_int3", url: "https://checkout.stripe.test/c/cs_test_int3" });
  if (url.pathname === `/v1/subscriptions/${LATE_SUB}`) {
    if (subFails) return j({ error: { type: "api_error", code: "api_error" } }, 500);
    if (method === "POST") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      subPosts.push(form.toString());
      if (form.has("cancel_at_period_end")) subState.cancel_at_period_end = form.get("cancel_at_period_end") === "true";
    }
    const ps = Math.floor((NOW - 10 * DAY) / 1000), pe = Math.floor((NOW + 20 * DAY) / 1000);
    return j({ id: LATE_SUB, object: "subscription", customer: "cus_int3", status: subState.status, cancel_at_period_end: subState.cancel_at_period_end, cancel_at: null,
      current_period_start: ps, current_period_end: pe, items: { data: [{ id: "si_1", current_period_start: ps, current_period_end: pe, price: { id: "price_pro00000001" } }] }, schedule: null });
  }
  return j({ error: { code: "unexpected" } }, 500);
};
const notifier: BillingNotifier = { async notify(e, n) { await e.DB.prepare("UPDATE billing_notices SET sent_at=? WHERE id=? AND sent_at IS NULL").bind(Date.now(), n.id).run(); } };
const flux: FluxEntitlementHooks = {
  capabilities: { reversalTargets: true },
  async grantMonthlyCredits() {}, async changePlan() {}, async revokeCredits() {}, async stopForBilling() {},
  async usedIncludedCreditMicrocents() { return { usedMicrocents: 0 }; }, async setAutoRecharge() {},
};
const deps = (): BillingDependencies => ({ stripeFetch, notifier, flux, accountUser: async () => ({ id: USER }), stepUp: async () => true });
async function send(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  await seedPendingQuotes();
  const ctx = createExecutionContext();
  const response = await createWorker(fetch, fetch, { provider: (db: D1Database) => fakeProvider(db) }, {}, deps()).fetch(new Request(`https://admin.murage.test${path}`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.10", ...headers } }), baseEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const reconcile = () => send("/v1/fake-b3/reconcile", {}, { authorization: `Bearer ${ADMIN}` });
const one = <T>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<T>().then((r) => r!);
const desired = (homeId: string) => one<{ d: string }>("SELECT desired_state AS d FROM cloud_homes WHERE id=?", homeId).then((r) => r.d);
const deleting = (homeId: string) => env.DB.prepare("UPDATE cloud_homes SET desired_state='deleting',observed_state='deleting',dns_removed_at=? WHERE id=?").bind(NOW - 120_000, homeId).run();
/** A reserved home with a submitted checkout (its consent, the customer, a session); no subscription yet. */
async function purchase(): Promise<{ homeId: string; consentId: string }> {
  const { homeId } = await (await send("/v1/billing/reserve")).json() as { homeId: string };
  expect((await send("/v1/billing/checkout", { plan: "pro", consent: consentFor("pro", Date.now()) })).status).toBe(200);
  const c = await one<{ id: string }>("SELECT id FROM checkout_consents WHERE home_id=?", homeId);
  return { homeId, consentId: c.id };
}

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  subFails = false; subState = { cancel_at_period_end: false, status: "active" }; subPosts = [];
  await env.DB.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, 'I',?,1,?,?)`).bind(USER, `${USER}@example.test`, NOW, NOW).run();
});
afterEach(() => vi.restoreAllMocks());


const checkpoint = (homeId: string) => one<{ c: string | null }>("SELECT stripe_end_confirmed AS c FROM billing_subscriptions WHERE home_id=?", homeId).then((r) => r.c);
/** A purchase whose checkout completed and paid, holding LATE_SUB. */
async function subscribed(): Promise<{ homeId: string; consentId: string }> {
  const r = await purchase();
  await withHomeLease(baseEnv(), r.homeId, (lease) => fencedBatch(baseEnv(), lease, claimQs(r.homeId, LATE_SUB, r.consentId, NOW)));
  await env.DB.prepare("UPDATE checkout_consents SET contract_made_at=?,completed_at=?,paid_at=? WHERE home_id=?").bind(NOW, NOW, NOW, r.homeId).run();
  return r;
}

// ---- #2 ------------------------------------------------------------------------------------------------------------------------------

describe("INTEGRATED-3 #2: a parked subscription never counts as a confirmed scheduled end; the deleted home waits for THE checkpoint", () => {
  const billingOpen = (homeId: string) => one<{ x: number }>(`SELECT ${DELETION_BILLING_OPEN_SQL} AS x FROM cloud_homes WHERE id=?`, homeId).then((r) => r.x);
  it("cancel_at_period_end confirmed, then parked: billing stays open and the home is not retired until Stripe's end is on record", async () => {
    const { homeId } = await subscribed();
    const g = await one<{ g: number }>("SELECT generation AS g FROM cloud_homes WHERE id=?", homeId);
    await env.DB.prepare(`INSERT INTO cloud_recovery_holds (id,home_id,action,generation,started_at,completes_at,completed_at,source) VALUES ('hold-int3',?,'delete',?,?,?,?,'customer')`)
      .bind(homeId, g.g, NOW - 3 * DAY, NOW, NOW).run();
    await env.DB.prepare("UPDATE billing_subscriptions SET cancel_at_period_end=1,cancel_synced_rev=cancel_intent_rev,status='active' WHERE home_id=?").bind(homeId).run();
    expect(await billingOpen(homeId)).toBe(0);                                   // a confirmed scheduled end, not parked: settled
    await env.DB.prepare(`INSERT INTO cancel_resolutions (subscription_id,home_id,source,generation,promised_end_at,due_at,schedule_id,state,next_attempt_at,created_at)
      VALUES (?,?,'in_app','in_app:1',?,?,'sub_sched_int3','open',?,?)`).bind(LATE_SUB, homeId, NOW + 20 * DAY, NOW + 20 * DAY, NOW, NOW).run();
    expect(await billingOpen(homeId)).toBe(1);                                   // before the fix: 0 (the probe's "settled")
    await deleting(homeId);
    expect((await reconcile()).status).toBe(200);
    expect(await desired(homeId)).toBe("deleting");                              // its slot is not freed while Stripe may still renew it
    await env.DB.prepare("UPDATE billing_subscriptions SET stripe_end_confirmed=subscription_id WHERE home_id=?").bind(homeId).run();
    expect(await billingOpen(homeId)).toBe(0);
    expect((await reconcile()).status).toBe(200);
    expect(await desired(homeId)).toBe("deleted");
  });
});

// ---- #3 ------------------------------------------------------------------------------------------------------------------------------

describe("INTEGRATED-3 #3: a local canceled status is no terminal success for Cancel; only THE checkpoint (or Stripe's read) is", () => {
  it("canceled locally, Stripe still active: unconfirmed, nothing written; Stripe shows it ended: the checkpoint is set and success returned", async () => {
    const { homeId } = await subscribed();
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled',ended_at=? WHERE home_id=?").bind(NOW, homeId).run();
    const sync = () => withHomeLease(baseEnv(), homeId, (lease) => syncCancellation(baseEnv(), deps(), homeId, lease)).catch((e: unknown) => e);
    expect(await sync()).toBeInstanceOf(CancelUnconfirmed);                     // before the fix: { cancel: true } with zero Stripe reads
    expect(subPosts).toEqual([]);                                               // a read only: never a write
    expect(await checkpoint(homeId)).toBeNull();
    expect(await planEndState(baseEnv(), homeId)).toMatchObject({ state: "ended", confirmed: false });
    subState.status = "canceled";
    expect(await sync()).toMatchObject({ cancel: true });
    expect(await checkpoint(homeId)).toBe(LATE_SUB);
    expect(subPosts).toEqual([]);
    expect(await planEndState(baseEnv(), homeId)).toMatchObject({ state: "ended", confirmed: true });
  });
});

// ---- #4 ------------------------------------------------------------------------------------------------------------------------------

describe("INTEGRATED-3 #4: a proven-empty /checkout/resume attempt settles its own marker (new rows by their key, old rows by their saved identity)", () => {
  const listing = (sessions: unknown[]) => ({ listAllCheckoutSessions: async () => sessions, getSubscription: async () => { throw new Error("unused"); } }) as unknown as StripeClient;
  const marker = (consentId: string) => one<{ at: number | null; iss: string | null }>("SELECT session_inflight_at AS at,session_issuance_id AS iss FROM checkout_consents WHERE id=?", consentId);
  /** A legacy resume attempt (written before resume persisted idempotency_key) whose request carries `issuance`, and the consent's marker of it. */
  async function legacyResume(issuanceOf: (id: string) => string) {
    const r = await purchase();
    const aid = crypto.randomUUID();
    await env.DB.prepare("UPDATE checkout_consents SET stripe_session_id=NULL,session_inflight_at=?,session_issuance_id=? WHERE id=?").bind(NOW - 3 * HOUR, `resume:${aid}`, r.consentId).run();
    await env.DB.prepare(`INSERT INTO checkout_resume_attempts (id,home_id,consent_id,expires_at,payload,state,created_at) VALUES (?,?,?,?,?,'creating',?)`)
      .bind(aid, r.homeId, r.consentId, NOW - 2 * HOUR - 1, JSON.stringify({ customerId: "cus_int3", issuanceId: issuanceOf(aid), renewalSha256: "x" }), NOW - 3 * HOUR).run();
    return { ...r, aid };
  }
  it("the home's attempt reconciliation: proven empty abandons the attempt AND settles resume:<id> (before: the marker stayed forever)", async () => {
    const { homeId, consentId, aid } = await legacyResume((id) => `resume:${id}`);
    await withHomeLease(baseEnv(), homeId, (lease) => reconcileHomeAttempts(baseEnv(), lease, listing([]) as ReturnType<typeof stripeClient>, homeId, NOW));
    expect(await one<{ s: string }>("SELECT state AS s FROM checkout_resume_attempts WHERE id=?", aid)).toEqual({ s: "abandoned" });
    expect(await marker(consentId)).toEqual({ at: null, iss: null });
    expect(await one<{ x: number }>(`SELECT ${CHECKOUT_MAY_SETTLE_SQL} AS x FROM cloud_homes WHERE id=?`, homeId)).toEqual({ x: 0 });
  });
  it("the marker sweep finds the resume attempt by its saved identity and settles it the same way", async () => {
    const { homeId, consentId } = await legacyResume((id) => `resume:${id}`);
    expect(await withHomeLease(baseEnv(), homeId, (lease) => reconcileSessionMarker(baseEnv(), lease, listing([]), consentId, NOW))).toBe(true);
    expect(await marker(consentId)).toEqual({ at: null, iss: null });
  });
  it("a saved identity that is not the attempt's own is never trusted: the marker stays (unresolved, for ops)", async () => {
    const { homeId, consentId } = await legacyResume(() => "resume:someone-else");
    await withHomeLease(baseEnv(), homeId, (lease) => reconcileHomeAttempts(baseEnv(), lease, listing([]) as ReturnType<typeof stripeClient>, homeId, NOW));
    expect((await marker(consentId)).at).not.toBeNull();
  });
  it("a new resume attempt persists its original key with the row", () => {
    expect(membersSource).toMatch(/INSERT INTO checkout_resume_attempts \(id,home_id,consent_id,expires_at,payload,state,created_at,idempotency_key\)[^\n]*\n[^\n]*`resume:\$\{fresh\.id\}`/);
  });
});

// ---- #5 ------------------------------------------------------------------------------------------------------------------------------

describe("INTEGRATED-3 #5: reservation expiry waits for terminal settlement evidence and never runs under a Delete hold", () => {
  const LATER = NOW + 26 * HOUR;                                                // past the billing row's 25-hour allowance
  it("an unresolved issuance marker keeps the reservation however old; then an open Delete hold keeps it; the hold cancelled, it lapses", async () => {
    const { homeId, consentId } = await purchase();
    await env.DB.prepare("UPDATE cloud_homes SET reservation_expires_at=? WHERE id=?").bind(NOW, homeId).run();
    // A session request whose answer never came back (its saved attempt can still be replayed under the same key).
    await env.DB.prepare("UPDATE checkout_consents SET session_inflight_at=?,session_issuance_id=? WHERE id=?").bind(NOW, `checkout:${consentId}`, consentId).run();
    expect(await expireReservations(baseEnv(), LATER)).toBe(0);                  // before the fix: 1 (retired with its checkout unresolved)
    expect(await desired(homeId)).toBe("payment_pending");
    await env.DB.prepare("UPDATE checkout_consents SET session_inflight_at=NULL,session_issuance_id=NULL,session_expired_at=? WHERE id=?").bind(LATER, consentId).run();
    const g = await one<{ g: number }>("SELECT generation AS g FROM cloud_homes WHERE id=?", homeId);
    await env.DB.prepare(`INSERT INTO cloud_recovery_holds (id,home_id,action,generation,started_at,completes_at,source) VALUES ('hold-int3-x',?,'delete',?,?,?,'customer')`)
      .bind(homeId, g.g, LATER - HOUR, LATER + 71 * HOUR).run();
    expect(await expireReservations(baseEnv(), LATER)).toBe(0);                  // the Delete hold owns this home's end
    expect(await desired(homeId)).toBe("payment_pending");
    await env.DB.prepare("UPDATE cloud_recovery_holds SET canceled_at=? WHERE id='hold-int3-x'").bind(LATER).run();
    expect(await expireReservations(baseEnv(), LATER)).toBe(1);
    expect(await desired(homeId)).toBe("deleted");
  });
});

// ---- #6 and the staging failed-setup shape (i) ---------------------------------------------------------------------------------------

describe("INTEGRATED-3 #6: a refund operation makes its refund BEFORE it ends its subscription; the end is Stripe's, then local", () => {
  const PI = "pi_int3";
  let calls: string[];
  let endFails: boolean;
  let refundStatus: string;
  const stripe = new Proxy({}, { get: (_t, name: string) => {
    if (name === "cancelSubscription") return async (id: string) => { calls.push("end"); if (endFails) throw new StripeError(500, "api_error"); return { id, status: "canceled" }; };
    if (name === "getSubscription") return async (id: string) => ({ id, status: endFails ? "active" : "canceled", cancel_at_period_end: false });
    if (name === "listRefunds") return async () => ({ data: [], has_more: false });
    if (name === "createRefund") return async () => { calls.push("refund"); return { id: "re_int3", amount: 4900, status: refundStatus, payment_intent: PI, created: NOW / 1000, metadata: {} }; };
    if (name === "getRefund") return async () => ({ id: "re_int3", amount: 4900, status: refundStatus, payment_intent: PI, created: NOW / 1000, metadata: {} });
    if (name === "getInvoice") return async (id: string) => ({ id, payment_intent: PI, amount_paid: 4900, lines: { data: [] } });
    return async () => { throw new StripeError(500, `unexpected_${name}`); };
  } }) as unknown as StripeClient;
  const ctx = () => ({ stripe, flux, deps: { notifier }, now: NOW });
  /** The failed-setup refund (A6: no capacity), opened with its subscription and payment, exactly as the live refund sweep opens it. */
  async function failedSetup(): Promise<string> {
    const { homeId } = await subscribed();
    const [sql, binds] = refundOpInsert({ id: "no_capacity:in_int3", kind: "no_capacity", homeId, userId: USER, invoiceId: "in_int3", paidCents: 4900, targetCents: 4900,
      endPlan: true, subscriptionId: LATE_SUB, paymentIntent: PI }, NOW);
    await env.DB.prepare(sql).bind(...(binds ?? [])).run();
    return homeId;
  }
  const op = () => one<{ refunded_at: number | null; canceled_at: number | null; done_at: number | null }>("SELECT refunded_at,canceled_at,done_at FROM refund_ops WHERE id='no_capacity:in_int3'");
  beforeEach(() => { calls = []; endFails = false; refundStatus = "succeeded"; });

  it("money first: the refund is created, THEN Stripe's end (DELETE), THEN the local canceled/ended_at; the checkpoint is Stripe's answer", async () => {
    const homeId = await failedSetup();
    await advanceRefundOp(baseEnv(), ctx(), "no_capacity:in_int3");
    expect(calls).toEqual(["refund", "end"]);                                    // before the fix: ["end", "refund"]
    expect(await op()).toMatchObject({ refunded_at: NOW, canceled_at: NOW });
    expect((await op()).done_at).not.toBeNull();
    // (i) the staging case: "Ended" is Stripe-true. The local canceled/ended_at follow Stripe's confirmed DELETE, which set THE checkpoint.
    expect(await getSub(baseEnv(), homeId)).toMatchObject({ status: "canceled", ended_at: NOW });
    expect(await checkpoint(homeId)).toBe(LATE_SUB);
    expect(await planEndState(baseEnv(), homeId)).toMatchObject({ state: "ended", confirmed: true });
  });
  it("money that cannot move this pass (a refused refund) was attempted first; billing still stops in the same pass", async () => {
    const homeId = await failedSetup();
    refundStatus = "failed";
    await advanceRefundOp(baseEnv(), ctx(), "no_capacity:in_int3");
    expect(calls).toEqual(["refund", "end"]);                                    // never the end ahead of money that could move
    expect(await op()).toMatchObject({ refunded_at: null, canceled_at: NOW });
    expect(await checkpoint(homeId)).toBe(LATE_SUB);
  });
  it("a refund still pending at Stripe has its checkpoint (it exists), so the end follows; a failed end never holds the money back", async () => {
    const homeId = await failedSetup();
    refundStatus = "pending"; endFails = true;
    await advanceRefundOp(baseEnv(), ctx(), "no_capacity:in_int3");
    expect(calls).toEqual(["refund", "end"]);
    expect(await op()).toMatchObject({ refunded_at: null, canceled_at: null });
    expect((await getSub(baseEnv(), homeId))!.status).not.toBe("canceled");     // no local end without Stripe's
    expect(await checkpoint(homeId)).toBeNull();
    refundStatus = "succeeded"; endFails = false;
    await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id='no_capacity:in_int3'").run();
    await advanceRefundOp(baseEnv(), ctx(), "no_capacity:in_int3");
    expect(calls.filter((c) => c === "refund")).toHaveLength(1);                // refunds never twice
    expect(await op()).toMatchObject({ refunded_at: NOW, canceled_at: NOW });
    expect(await checkpoint(homeId)).toBe(LATE_SUB);
  });
});

// Astra INTEGRATED-4 #2: the retired-home obligation for a partially refunded payment targets the whole payment; the invoice ledger caps
// its decision to the remainder, so the money moves once and never twice. (The journaling itself: purchase-bootstrap.test.ts.)
describe("INTEGRATED-4 #2: a partially refunded payment's obligation refunds only the remainder, capped by the invoice ledger", () => {
  const PI = "pi_int3";
  let asked: (number | null)[];
  const stripe = new Proxy({}, { get: (_t, name: string) => {
    if (name === "cancelSubscription") return async (id: string) => ({ id, status: "canceled" });
    if (name === "getSubscription") return async (id: string) => ({ id, status: "canceled", cancel_at_period_end: false });
    if (name === "listRefunds") return async () => ({ data: [], has_more: false });
    if (name === "createRefund") return async (i: { amountCents?: number }) => { asked.push(i.amountCents ?? null);
      return { id: "re_int4", amount: i.amountCents ?? 0, status: "succeeded", payment_intent: PI, created: NOW / 1000, metadata: {} }; };
    if (name === "getInvoice") return async (id: string) => ({ id, payment_intent: PI, amount_paid: 4900, lines: { data: [] } });
    return async () => { throw new StripeError(500, `unexpected_${name}`); };
  } }) as unknown as StripeClient;
  it("$1 refunded outside the ledger: the obligation decides $48, refunded once; afterwards the invoice is covered in full", async () => {
    asked = [];
    const { homeId } = await subscribed();
    await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,payment_intent,amount_cents,basis,end_plan,decided_at,refunded_at,done_at,refund_status,created_at,updated_at)
      VALUES ('external:re_part4','external',?,?,'in_int4',?,100,'external',0,?,?,?,'succeeded',?,?)`).bind(homeId, USER, PI, NOW, NOW, NOW, NOW, NOW).run();
    await env.DB.prepare("INSERT INTO refund_invoice_ledger (invoice_id,version,decided_cents) VALUES ('in_int4',1,100)").run();
    expect((await invoiceRefundCoverage(baseEnv(), "in_int4", 4900)).outstandingCents).toBe(4800);
    const [sql, binds] = refundOpInsert({ id: "no_capacity:in_int4", kind: "no_capacity", homeId, userId: USER, invoiceId: "in_int4", paidCents: 4900, targetCents: 4900,
      endPlan: true, subscriptionId: LATE_SUB, paymentIntent: PI }, NOW);
    await env.DB.prepare(sql).bind(...(binds ?? [])).run();
    await advanceRefundOp(baseEnv(), { stripe, flux, deps: { notifier }, now: NOW }, "no_capacity:in_int4");
    await advanceRefundOp(baseEnv(), { stripe, flux, deps: { notifier }, now: NOW }, "no_capacity:in_int4");
    expect(asked).toEqual([4800]);                                               // the remainder, once
    expect(await one<{ a: number }>("SELECT amount_cents AS a FROM refund_ops WHERE id='no_capacity:in_int4'")).toEqual({ a: 4800 });
    expect(await one<{ d: number }>("SELECT decided_cents AS d FROM refund_invoice_ledger WHERE invoice_id='in_int4'")).toEqual({ d: 4900 });
    expect(await invoiceRefundCoverage(baseEnv(), "in_int4", 4900)).toMatchObject({ refundedCents: 4900, outstandingCents: 0, obligationRecorded: true });
  });
});

// Astra INTEGRATED-4 #3: the candidate read applies the same holds as the guarded update, so 50 held reservations at the front never starve
// an eligible later one.
describe("INTEGRATED-4 #3: reservation expiry candidates skip held reservations; the 51st (eligible) one expires", () => {
  it("60 lapsed reservations, the oldest 50 held (marker, unpaid contract, Delete hold): the eligible ones behind them expire", async () => {
    const { consentId } = await purchase();
    const template = await one<Record<string, unknown>>("SELECT * FROM checkout_consents WHERE id=?", consentId);
    const ids: string[] = [];
    for (let i = 1; i <= 60; i++) {
      const id = `home-int4-${String(i).padStart(2, "0")}`; ids.push(id);
      await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,entitlement,reservation_expires_at,image_digest,home_key,created_at,updated_at)
        VALUES (?,?,?,'payment_pending','reserved','pending',?,?,'k',?,?)`).bind(id, `inst-${id}`, USER, NOW - (100 - i) * 1000, IMAGE, NOW - DAY, NOW - DAY).run();
      if (i <= 35) {
        const row: Record<string, unknown> = { ...template, id: `consent-${id}`, home_id: id, stripe_session_id: null, rejected_at: null, payment_failed_at: null,
          paid_at: null, ...(i <= 20 ? { session_inflight_at: NOW - DAY, session_issuance_id: `checkout:consent-${id}`, contract_made_at: null }
            : { session_inflight_at: null, session_issuance_id: null, contract_made_at: NOW - DAY }) };
        const cols = Object.keys(row);
        await env.DB.prepare(`INSERT INTO checkout_consents (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...cols.map((c) => row[c])).run();
      } else if (i <= 50) {
        await env.DB.prepare(`INSERT INTO cloud_recovery_holds (id,home_id,action,generation,started_at,completes_at,source) VALUES (?,?,'delete',1,?,?,'customer')`)
          .bind(`hold-${id}`, id, NOW - HOUR, NOW + 71 * HOUR).run();
      }
    }
    // before the fix: 0 (the same 50 held rows selected on every sweep, each failing the guarded update)
    expect(await expireReservations(baseEnv(), NOW)).toBe(10);
    expect(await desired("home-int4-51")).toBe("deleted");
    for (const id of ids.slice(0, 50)) expect(await desired(id)).toBe("payment_pending");
    expect(await expireReservations(baseEnv(), NOW)).toBe(0);
  });
});

// ---- staging review (iii): the 0096 backfill correction (migration 0100) -------------------------------------------------------------

describe("migration 0100: a checkpoint 0096 inferred for a local-only end is withdrawn and re-asked of Stripe; a Stripe-recorded end stays", () => {
  const PI = "pi_int3_cov";
  const run0100 = async () => {
    for (const stmt of m0100.split(";").map((x) => x.replace(/^\s*(--[^\n]*\n\s*)*/g, "").trim()).filter(Boolean)) await env.DB.prepare(stmt).run();
  };
  async function backfilledEnded(event: boolean): Promise<string> {
    const { homeId } = await subscribed();
    // The legacy shape: ended locally, a coverage watch released by an operation whose canceled_at was stamped on that local status alone,
    // and 0096's backfill set the checkpoint because nothing was open.
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled',ended_at=?,stripe_end_confirmed=subscription_id WHERE home_id=?").bind(NOW, homeId).run();
    await env.DB.prepare(`INSERT INTO refund_coverage (home_id,payment_intent,invoice_id,subscription_id,paid_cents,covered_cents,end_plan,changed_at,created_at)
      VALUES (?,?,?,?,4900,4900,0,?,?)`).bind(homeId, PI, "in_int3_cov", LATE_SUB, NOW - DAY, NOW - DAY).run();
    await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,payment_intent,end_plan,subscription_id,canceled_at,done_at,created_at,updated_at)
      VALUES ('op-int3-legacy','withdrawal',?,?,'in_int3_cov',?,1,?,?,?,?,?)`).bind(homeId, USER, PI, LATE_SUB, NOW - DAY, NOW - DAY, NOW - DAY, NOW - DAY).run();
    // The staging case (home-bac28...): Stripe's own customer.subscription.deleted is on record.
    if (event) await env.DB.prepare("INSERT INTO stripe_events (id,type,payload,received_at,processed_at) VALUES (?,?,?,?,?)").bind("evt_int3_deleted",
      "customer.subscription.deleted", JSON.stringify({ id: "evt_int3_deleted", type: "customer.subscription.deleted", data: { object: { id: LATE_SUB, status: "canceled" } } }), NOW, NOW).run();
    return homeId;
  }
  it("Stripe's deletion on record (the staging failed-setup shape): untouched", async () => {
    const homeId = await backfilledEnded(true);
    await run0100();
    expect(await checkpoint(homeId)).toBe(LATE_SUB);
    expect(await one<{ e: number }>("SELECT end_plan AS e FROM refund_coverage WHERE home_id=?", homeId)).toEqual({ e: 0 });
  });
  it("no Stripe evidence: the checkpoint is withdrawn, the watch re-armed, and coverage reconciliation asks Stripe and sets it on Stripe's answer", async () => {
    const homeId = await backfilledEnded(false);
    await run0100();
    expect(await checkpoint(homeId)).toBeNull();
    expect(await one<{ e: number }>("SELECT end_plan AS e FROM refund_coverage WHERE home_id=?", homeId)).toEqual({ e: 1 });
    expect(await planEndState(baseEnv(), homeId)).toMatchObject({ state: "ended", confirmed: false });
    const stripe = new Proxy({}, { get: (_t, name: string) => {
      if (name === "cancelSubscription") return async (id: string) => ({ id, status: "canceled" });
      if (name === "getSubscription") return async (id: string) => ({ id, status: "canceled" });
      if (name === "listRefunds") return async () => ({ data: [{ id: "re_cov", amount: 4900, status: "succeeded", payment_intent: PI, metadata: {} }], has_more: false });
      if (name === "getInvoice") return async (id: string) => ({ id, payment_intent: PI, amount_paid: 4900, lines: { data: [] } });
      return async () => { throw new StripeError(500, `unexpected_${name}`); };
    } }) as unknown as StripeClient;
    await withHomeLease(baseEnv(), homeId, (lease) => reconcilePaymentCoverage(baseEnv(), lease, { stripe, flux, deps: { notifier }, now: NOW }, homeId, PI));
    expect(await checkpoint(homeId)).toBe(LATE_SUB);
    expect(await planEndState(baseEnv(), homeId)).toMatchObject({ state: "ended", confirmed: true });
  });
});
