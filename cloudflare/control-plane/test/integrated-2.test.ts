// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra INTEGRATED-2 probes #1 to #5, each reproduced and then shown fixed, plus the scan that every "Stripe confirmed the end" reads THE
// Stripe-end checkpoint (billing_subscriptions.stripe_end_confirmed). Real workerd + D1, the B3 fake provider, Stripe as a fixture. No network.
//   RULE A (#2, #5): the checkpoint is set only from Stripe's terminal evidence; until then the end stays owed and is retried.
//   RULE B (#1, #3): a Delete binds a subscription created later; the home is retired only once its plan end and checkout are settled.
//   #4: a replayed checkout whose session is complete keeps its issuance marker (its payment may still be processing).
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { fakeProvider } from "../src/b3-provider";
import { CHECKOUT_MAY_SETTLE_SQL } from "../src/b3-control";
import { claimQs, endSubscription, getSub, noFurtherCharge, planEndSentence, planEndState, reconcileDeletionObligation, reconcileHomeAttempts,
  reconcilePaymentCoverage, reconcileSessionMarker, replayCheckoutAttempt, sweepBilling, type BillingDependencies, type BillingNotifier,
  type FluxEntitlementHooks } from "../src/b5-billing";
import { advanceRefundOp } from "../src/legal-refunds";
import { fencedBatch, withHomeLease } from "../src/billing-lease";
import { DELETION_BILLING_OPEN_SQL } from "../src/subscription-gateway";
import { StripeError, type StripeClient } from "../src/b5-stripe";
import { HTTPError } from "../src/http";
import { consentFor, seedPendingQuotes } from "./legal-helpers";
import b5Source from "../src/b5-billing.ts?raw";
import refundsSource from "../src/legal-refunds.ts?raw";
import b3Source from "../src/b3-control.ts?raw";
import gatewaySource from "../src/subscription-gateway.ts?raw";
import { customerFake } from "./stripe-customer-fake";

// @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
const ALL_SOURCES = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const ADMIN = "test-only-integrated2-admin-no-real-access";
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const USER = "int2-user";
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
const LATE_SUB = "sub_int2_late";
const cust = customerFake();
const stripeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  // The customer preset (Astra TAXCOUNTRY-1): customers persisted by a shared fake.
  { const cr = await cust.handle(init?.method ?? "GET", new URL(String(input)), new URLSearchParams(String(init?.body ?? ""))); if (cr) return cr; }
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s });
  if (url.pathname === "/v1/customers") return j({ id: "cus_int2" });
  if (url.pathname === "/v1/checkout/sessions" && method === "POST") return j({ id: "cs_test_int2", url: "https://checkout.stripe.test/c/cs_test_int2" });
  if (url.pathname === `/v1/subscriptions/${LATE_SUB}`) {
    if (subFails) return j({ error: { type: "api_error", code: "api_error" } }, 500);
    if (method === "POST") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      subPosts.push(form.toString());
      if (form.has("cancel_at_period_end")) subState.cancel_at_period_end = form.get("cancel_at_period_end") === "true";
    }
    const ps = Math.floor((NOW - 10 * DAY) / 1000), pe = Math.floor((NOW + 20 * DAY) / 1000);
    return j({ id: LATE_SUB, object: "subscription", customer: "cus_int2", status: subState.status, cancel_at_period_end: subState.cancel_at_period_end, cancel_at: null,
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

// ---- #1 (RULE B) ---------------------------------------------------------------------------------------------------------------------

describe("INTEGRATED-2 #1: a Delete asked before the subscription exists binds it; the home is retired only after its plan end is settled", () => {
  async function deleteRequested(homeId: string) {
    const g = await one<{ g: number }>("SELECT generation AS g FROM cloud_homes WHERE id=?", homeId);
    await env.DB.prepare(`INSERT INTO cloud_recovery_holds (id,home_id,action,generation,started_at,completes_at,source) VALUES ('hold-int2',?,'delete',?,?,?,'customer')`)
      .bind(homeId, g.g, NOW, NOW + 3 * DAY).run();
  }
  const paid = (homeId: string) => env.DB.prepare("UPDATE checkout_consents SET contract_made_at=?,completed_at=?,paid_at=? WHERE home_id=?").bind(NOW, NOW, NOW, homeId).run();
  const billingOpen = (homeId: string) => one<{ x: number }>(`SELECT ${DELETION_BILLING_OPEN_SQL} AS x FROM cloud_homes WHERE id=?`, homeId).then((r) => r.x);

  it("the payment during the hold: the claim binds the intent, the sweep selects it and ends it through the gateway, THEN the home is retired", async () => {
    const { homeId, consentId } = await purchase();
    await deleteRequested(homeId);
    // The checkout completes during the 72-hour hold: the claim (the handler's own claimQs) binds the deletion in the same batch.
    await withHomeLease(baseEnv(), homeId, (lease) => fencedBatch(baseEnv(), lease, claimQs(homeId, LATE_SUB, consentId, NOW)));
    await paid(homeId);
    const bound = (await getSub(baseEnv(), homeId))!;
    expect(bound).toMatchObject({ subscription_id: LATE_SUB, customer_cancel_at: NOW });
    expect(bound.cancel_intent_rev).toBeGreaterThan(bound.cancel_synced_rev);   // before the fix: no intent, desiredCancel false after the hold
    // The hold completes while Stripe is down: the reconciliation is tried, never a gate; the end stays owed.
    subFails = true;
    await withHomeLease(baseEnv(), homeId, (lease) => reconcileDeletionObligation(baseEnv(), deps(), homeId, lease, NOW));
    await env.DB.prepare("UPDATE cloud_recovery_holds SET completed_at=? WHERE id='hold-int2'").bind(NOW + 3 * DAY).run();
    await deleting(homeId);
    expect(await billingOpen(homeId)).toBe(1);
    expect((await reconcile()).status).toBe(200);
    expect(await desired(homeId)).toBe("deleting");                              // not retired while the plan still renews
    // Stripe answers again: the in-app cancellation sweep selects the bound subscription and ends it through the gateway.
    subFails = false;
    await sweepBilling(baseEnv(), deps());
    expect(subPosts.some((p) => p.includes("cancel_at_period_end=true"))).toBe(true);
    const after = (await getSub(baseEnv(), homeId))!;
    expect(after).toMatchObject({ cancel_at_period_end: 1 });
    expect(after.cancel_synced_rev).toBe(after.cancel_intent_rev);
    expect(await billingOpen(homeId)).toBe(0);
    expect((await reconcile()).status).toBe(200);
    expect(await desired(homeId)).toBe("deleted");
  });

  it("at hold completion with Stripe up, the plan end is asked of Stripe through the gateway before the hold completes", async () => {
    const { homeId, consentId } = await purchase();
    await deleteRequested(homeId);
    await withHomeLease(baseEnv(), homeId, (lease) => fencedBatch(baseEnv(), lease, claimQs(homeId, LATE_SUB, consentId, NOW)));
    await withHomeLease(baseEnv(), homeId, (lease) => reconcileDeletionObligation(baseEnv(), deps(), homeId, lease, NOW));
    expect(subPosts.some((p) => p.includes("cancel_at_period_end=true"))).toBe(true);
    expect(await billingOpen(homeId)).toBe(0);
  });

  it("no Delete asked: the claim binds nothing", async () => {
    const { homeId, consentId } = await purchase();
    await withHomeLease(baseEnv(), homeId, (lease) => fencedBatch(baseEnv(), lease, claimQs(homeId, LATE_SUB, consentId, NOW)));
    expect((await getSub(baseEnv(), homeId))).toMatchObject({ subscription_id: LATE_SUB, customer_cancel_at: null });
  });
});

// ---- #2 and #5 (RULE A) --------------------------------------------------------------------------------------------------------------

describe("INTEGRATED-2 #2/#5: only Stripe's terminal evidence sets the Stripe-end checkpoint; until then the end is owed and retried", () => {
  const HOME = "home-int2-end";
  const SUB = "sub_int2_end";
  const PI = "pi_int2";
  let endFails: boolean;
  let deletes: number;
  const checkpoint = () => one<{ c: string | null }>("SELECT stripe_end_confirmed AS c FROM billing_subscriptions WHERE home_id=?", HOME).then((r) => r.c);
  const stripe = new Proxy({}, { get: (_t, name: string) => {
    if (name === "cancelSubscription") return async (id: string) => { deletes++; if (endFails) throw new StripeError(500, "api_error"); return { id, status: "canceled" }; };
    if (name === "getSubscription") return async (id: string) => ({ id, status: endFails ? "active" : "canceled", cancel_at_period_end: false });
    if (name === "listRefunds") return async () => ({ data: [{ id: "re_ext", amount: 4900, status: "succeeded", payment_intent: PI, metadata: {} }], has_more: false });
    if (name === "getInvoice") return async (id: string) => ({ id, payment_intent: PI, amount_paid: 4900, lines: { data: [] } });
    return async () => { throw new StripeError(500, `unexpected_${name}`); };
  } }) as unknown as StripeClient;
  const ctx = () => ({ stripe, flux, deps: { notifier }, now: NOW });
  const coverage = () => withHomeLease(baseEnv(), HOME, (lease) => reconcilePaymentCoverage(baseEnv(), lease, ctx(), HOME, PI)).catch((e: unknown) => e);
  beforeEach(async () => {
    endFails = true; deletes = 0;
    await env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)`)
      .bind(HOME, "cus_int2", SUB, "pro", NOW - 10 * DAY, NOW - DAY).run();
  });

  it("#2 external full refund, then a withdrawal: zero false discharge; the end stays owed until Stripe confirms, then the checkpoint is set once", async () => {
    await env.DB.prepare(`INSERT INTO refund_coverage (home_id,payment_intent,invoice_id,subscription_id,paid_cents,end_plan,changed_at,created_at) VALUES (?,?,?,?,4900,1,?,?)`)
      .bind(HOME, PI, "in_int2", SUB, NOW, NOW).run();
    // The external refund covers the payment: the local end first (canceled), then Stripe's end, which fails.
    expect(await coverage()).toBeInstanceOf(Error);
    expect((await getSub(baseEnv(), HOME))!.status).toBe("canceled");
    expect(await checkpoint()).toBeNull();
    const p = await planEndState(baseEnv(), HOME);
    expect(p).toMatchObject({ state: "ended", confirmed: false });
    expect(noFurtherCharge(p)).toBe(false);
    expect(planEndSentence(p)).toContain("We are still confirming this with our payment provider");
    // The withdrawal of the same contract: before the fix it trusted the local canceled, made NO provider-end call and stamped canceled_at.
    await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,payment_intent,end_plan,subscription_id,created_at,updated_at)
      VALUES ('op-int2-wd','withdrawal',?,?,'in_int2',?,1,?,?,?)`).bind(HOME, USER, PI, SUB, NOW, NOW).run();
    const before = deletes;
    await advanceRefundOp(baseEnv(), ctx(), "op-int2-wd").catch(() => null);
    expect(deletes).toBeGreaterThan(before);                                    // the end was asked of Stripe (through the gateway)
    expect((await one<{ c: number | null }>("SELECT canceled_at AS c FROM refund_ops WHERE id='op-int2-wd'")).c).toBeNull();
    // Coverage reconciliation does not release its end obligation on the operation's word: the operation still owes it (deferred, kept).
    await coverage();
    expect(await one<{ e: number; at: number | null }>("SELECT end_plan AS e,ended_at AS at FROM refund_coverage WHERE home_id=?", HOME)).toEqual({ e: 1, at: null });
    expect(await checkpoint()).toBeNull();
    expect(noFurtherCharge(await planEndState(baseEnv(), HOME))).toBe(false);
    // Stripe ends it: the operation's retry confirms, THE checkpoint is set, and only then is canceled_at stamped and the watch released.
    endFails = false;
    const before3 = deletes;
    await advanceRefundOp(baseEnv(), ctx(), "op-int2-wd").catch(() => null);
    expect(deletes).toBe(before3 + 1);
    expect(await checkpoint()).toBe(SUB);
    expect((await one<{ c: number | null }>("SELECT canceled_at AS c FROM refund_ops WHERE id='op-int2-wd'")).c).toBe(NOW);
    await coverage();
    expect(await one<{ e: number }>("SELECT end_plan AS e FROM refund_coverage WHERE home_id=?", HOME)).toEqual({ e: 0 });
    expect(deletes).toBe(before3 + 1);                                          // set once: nothing asks Stripe again
    const confirmed = await planEndState(baseEnv(), HOME);
    expect(confirmed).toMatchObject({ state: "ended", confirmed: true });
    expect(noFurtherCharge(confirmed)).toBe(true);
  });

  it("#2 legacy: an operation that stamped canceled_at on the local status alone never discharges the watch; the watch asks Stripe itself", async () => {
    await env.DB.prepare(`INSERT INTO refund_coverage (home_id,payment_intent,invoice_id,subscription_id,paid_cents,end_plan,changed_at,created_at) VALUES (?,?,?,?,4900,1,?,?)`)
      .bind(HOME, PI, "in_int2", SUB, NOW, NOW).run();
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled' WHERE home_id=?").bind(HOME).run();
    await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,payment_intent,end_plan,subscription_id,canceled_at,created_at,updated_at)
      VALUES ('op-int2-old','withdrawal',?,?,'in_int2',?,1,?,?,?,?)`).bind(HOME, USER, PI, SUB, NOW, NOW, NOW).run();
    expect(await coverage()).toBeInstanceOf(Error);                              // before the fix: released as 'ledger_operation', zero calls
    expect(deletes).toBe(1);
    expect(await one<{ e: number }>("SELECT end_plan AS e FROM refund_coverage WHERE home_id=?", HOME)).toEqual({ e: 1 });
    endFails = false;
    expect(await coverage()).toBe(true);
    expect(await checkpoint()).toBe(SUB);
  });

  it("#5 a dispute whose Stripe termination failed: confirmed false, noFurtherCharge false; the retried end sets the checkpoint", async () => {
    // The dispute handler's local writes ran (disputed), its endSubscription failed: nothing pending in refunds, coverage or parking.
    await env.DB.prepare("UPDATE billing_subscriptions SET status='disputed' WHERE home_id=?").bind(HOME).run();
    const sub = (await getSub(baseEnv(), HOME))!;
    expect(await withHomeLease(baseEnv(), HOME, (lease) => endSubscription(baseEnv(), lease, stripe, sub)).catch((e: unknown) => e)).toMatchObject({ message: "subscription_not_canceled" });
    expect(deletes).toBe(1);
    expect(await checkpoint()).toBeNull();
    const p = await planEndState(baseEnv(), HOME);
    expect(p).toMatchObject({ state: "ended", confirmed: false });              // before the fix: confirmed true, noFurtherCharge true
    expect(noFurtherCharge(p)).toBe(false);
    // The stored event's retry runs the same end: Stripe confirms it now.
    endFails = false;
    await withHomeLease(baseEnv(), HOME, (lease) => endSubscription(baseEnv(), lease, stripe, sub));
    expect(await checkpoint()).toBe(SUB);
    const after = await planEndState(baseEnv(), HOME);
    expect(after).toMatchObject({ state: "ended", confirmed: true });
    expect(noFurtherCharge(after)).toBe(true);
  });
});

// ---- #3 (RULE B) ---------------------------------------------------------------------------------------------------------------------

describe("INTEGRATED-2 #3: a proven-empty checkout settles its marker and alert in one batch; Delete finishes; the reason is said plainly", () => {
  const listing = (sessions: unknown[]) => ({ listAllCheckoutSessions: async () => sessions }) as unknown as StripeClient;
  let ATTEMPT = "";
  beforeEach(() => { ATTEMPT = `stepup-checkout:${crypto.randomUUID()}`; });
  async function unresolved(): Promise<{ homeId: string; consentId: string }> {
    const r = await purchase();
    // Its answer was never recorded: no session id, the marker of its key, and a saved step-up attempt of that key past expiry plus grace.
    await env.DB.prepare("UPDATE checkout_consents SET stripe_session_id=NULL,session_inflight_at=?,session_issuance_id=? WHERE id=?")
      .bind(NOW - 3 * HOUR, `checkout:${r.consentId}`, r.consentId).run();
    await env.DB.prepare(`INSERT INTO checkout_resume_attempts (id,home_id,consent_id,expires_at,payload,state,created_at,stripe_price_id,idempotency_key)
      VALUES (?,?,?,?,?,'creating',?,'price_pro00000001',?)`)
      .bind(ATTEMPT, r.homeId, r.consentId, NOW - 2 * HOUR - 1, JSON.stringify({ customerId: "cus_int2" }), NOW - 3 * HOUR, `checkout:${r.consentId}`).run();
    await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,'home.checkout_unresolved','high',?,?)`)
      .bind(`alert:checkout_unresolved:${r.consentId}:checkout:${r.consentId}`, r.homeId, JSON.stringify({ issuances: [`checkout:${r.consentId}`] }), NOW - HOUR).run();
    await deleting(r.homeId);
    return r;
  }
  const marker = (consentId: string) => one<{ at: number | null; iss: string | null }>("SELECT session_inflight_at AS at,session_issuance_id AS iss FROM checkout_consents WHERE id=?", consentId);
  const alertOpen = (homeId: string) => one<{ n: number }>("SELECT COUNT(*) AS n FROM cloud_alerts WHERE home_id=? AND kind='home.checkout_unresolved' AND resolved_at IS NULL", homeId).then((r) => r.n);

  it("while it waits the customer is told the real reason; the attempt reconciliation proves it empty and Delete finishes", async () => {
    const { homeId, consentId } = await unresolved();
    expect((await reconcile()).status).toBe(200);
    expect(await desired(homeId)).toBe("deleting");
    const res = await send("/v1/billing/reserve");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "home_exists", reason: "deleting_last_payment", action: "try_again_later",
      message: expect.stringMatching(/^We are finishing your last payment first\./) });
    await withHomeLease(baseEnv(), homeId, (lease) => reconcileHomeAttempts(baseEnv(), lease, listing([]), homeId, NOW));
    // One batch: the attempt abandoned, its marker settled, the alert resolved.
    expect(await one<{ s: string }>("SELECT state AS s FROM checkout_resume_attempts WHERE id=?", ATTEMPT)).toEqual({ s: "abandoned" });
    expect(await marker(consentId)).toEqual({ at: null, iss: null });
    expect(await alertOpen(homeId)).toBe(0);
    expect((await reconcile()).status).toBe(200);
    expect(await desired(homeId)).toBe("deleted");
  });

  it("the marker sweep runs the attempt's reconciliation for a marker of its key: past the grace, proven empty settles it (before: kept forever)", async () => {
    const { homeId, consentId } = await unresolved();
    const stripe = { ...listing([]), getSubscription: async () => { throw new Error("unused"); } } as unknown as StripeClient;
    // Before the attempt's expiry plus grace it stays unresolved.
    await withHomeLease(baseEnv(), homeId, (lease) => reconcileSessionMarker(baseEnv(), lease, stripe, consentId, NOW - 2 * HOUR));
    expect((await marker(consentId)).at).not.toBeNull();
    expect(await withHomeLease(baseEnv(), homeId, (lease) => reconcileSessionMarker(baseEnv(), lease, stripe, consentId, NOW))).toBe(true);
    expect(await marker(consentId)).toEqual({ at: null, iss: null });
    expect(await alertOpen(homeId)).toBe(0);
    expect((await reconcile()).status).toBe(200);
    expect(await desired(homeId)).toBe("deleted");
  });
});

// ---- #4 ------------------------------------------------------------------------------------------------------------------------------

describe("INTEGRATED-2 #4: a replay that finds the session complete keeps the issuance marker; expired settles it", () => {
  async function replayAgainst(status: "complete" | "expired") {
    const { homeId, consentId } = await purchase();
    const key = `checkout:${consentId}`;
    const aid = `stepup-checkout:${crypto.randomUUID()}`;
    await env.DB.prepare("UPDATE checkout_consents SET stripe_session_id=NULL,session_inflight_at=?,session_issuance_id=? WHERE id=?").bind(NOW - HOUR, key, consentId).run();
    await env.DB.prepare("UPDATE open_checkouts SET state='failed',consent_id=? WHERE home_id=?").bind(consentId, homeId).run();
    const payload = { customerId: "cus_int2", homeId, plan: "pro", consentId, priceId: "price_pro00000001", issuanceId: key };
    await env.DB.prepare(`INSERT INTO checkout_resume_attempts (id,home_id,consent_id,expires_at,payload,state,created_at,stripe_price_id,idempotency_key)
      VALUES (?,?,?,?,?,'creating',?,'price_pro00000001',?)`).bind(aid, homeId, consentId, NOW + 50 * 60_000, JSON.stringify(payload), NOW - HOUR, key).run();
    const prior = await one<Parameters<typeof replayCheckoutAttempt>[5]>("SELECT * FROM checkout_resume_attempts WHERE id=?", aid);
    const stripe = { createCheckoutSession: async () => ({ id: "cs_int2_done", url: "https://checkout.stripe.test/c/done" }),
      retrieveEventObject: async () => ({ id: "cs_int2_done", status }),
      // the customer already at the consent's location (the required preset reads it, writes nothing; Astra TAXCOUNTRY-1)
      customerTaxState: async () => { const c = await one<{ c: string; p: string | null }>("SELECT billing_country AS c,postal_code AS p FROM checkout_consents WHERE id=?", consentId);
        return { country: c.c, postalCode: c.p, marker: null, liveSubscription: false }; } } as unknown as Parameters<typeof replayCheckoutAttempt>[2];
    const err = await withHomeLease(baseEnv(), homeId, (lease) => replayCheckoutAttempt(baseEnv(), lease, stripe, homeId, aid, prior, NOW)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HTTPError);
    const settle = await one<{ x: number }>(`SELECT ${CHECKOUT_MAY_SETTLE_SQL} AS x FROM cloud_homes WHERE id=?`, homeId);
    const m = await one<{ at: number | null }>("SELECT session_inflight_at AS at FROM checkout_consents WHERE id=?", consentId);
    return { err: err as HTTPError, settle: settle.x, at: m.at };
  }
  it("complete (its payment may still be processing): 409 checkout_completed, marker kept, CHECKOUT_MAY_SETTLE stays true", async () => {
    const r = await replayAgainst("complete");
    expect(r.err.message).toBe("checkout_completed");
    expect(r.at).toBe(NOW - HOUR);                                              // before the fix: cleared
    expect(r.settle).toBe(1);                                                   // before the fix: 0 with the payment unresolved
  });
  it("expired: 409 checkout_expired, marker settled", async () => {
    const r = await replayAgainst("expired");
    expect(r.err.message).toBe("checkout_expired");
    expect(r.at).toBeNull();
  });
});

// ---- the checkpoint scan -------------------------------------------------------------------------------------------------------------

describe("RULE A: every place that computes 'Stripe confirmed the end' reads the one checkpoint; only Stripe's evidence writes it", () => {
  const rel = (p: string) => p.slice(p.indexOf("src/"));
  const between = (src: string, from: string, to: string) => { const a = src.indexOf(from); expect(a).toBeGreaterThan(-1); return src.slice(a, src.indexOf(to, a + from.length)); };
  it("the column is named in the gateway module only", () => {
    expect(Object.keys(ALL_SOURCES).length).toBeGreaterThan(50);
    const named = Object.entries(ALL_SOURCES).filter(([p, s]) => rel(p) !== "src/subscription-gateway.ts" && s.includes("stripe_end_confirmed")).map(([p]) => rel(p));
    expect(named).toEqual([]);
    expect(gatewaySource).toContain("export const stripeEndConfirmed =");
  });
  it("its writers are the Stripe-evidence sites only: cancelConfirmed, markEndedQ, syncCancellation's read-back, subscription.updated/.deleted", () => {
    const writes = [...b5Source.matchAll(/stripeEndedQ\(|STRIPE_ENDED_SET|STRIPE_ENDED_ON_STATUS/g)].length;
    expect(writes).toBe(7); // the import line (2) and the five sites below: cancelConfirmed, markEndedQ, the read-back, .updated, .deleted
    expect(between(b5Source, "case \"customer.subscription.updated\"", "case \"customer.subscription.deleted\"")).toContain("${STRIPE_ENDED_ON_STATUS}");
    expect(between(b5Source, "export async function cancelConfirmed", "export const DELETION_WARNING_LEAD_MS")).toContain("stripeEndedQ(id)");
    expect(between(b5Source, "export const markEndedQ", "const ENDED")).toContain("${STRIPE_ENDED_SET}");
    expect(between(b5Source, 'case "customer.subscription.deleted"', 'case "charge.refunded"')).toContain("stripeEndedQ(");
    expect(between(b5Source, "if (got.status === \"canceled\" || got.status === \"incomplete_expired\") {", "return { cancel: true")).toContain("${STRIPE_ENDED_SET}");
    for (const [p, s] of Object.entries(ALL_SOURCES)) if (!["src/b5-billing.ts", "src/subscription-gateway.ts"].includes(rel(p))) {
      expect(/stripeEndedQ\(|STRIPE_ENDED_SET|STRIPE_ENDED_ON_STATUS/.test(s), rel(p)).toBe(false);
    }
  });
  it("planEndState (and so noFurtherCharge), the withdrawal / refund end, coverage reconciliation and the deletion's retirement read it", () => {
    const pes = between(b5Source, "export async function planEndState", "export type DeletionPlanEnd");
    expect(pes).toContain("const stripeEnded = await stripeEndConfirmed(env, sub.subscription_id)");
    expect(pes).toContain("confirmed: stripeEnded");
    expect(b5Source).not.toContain("stripeEndPending");
    expect(between(b5Source, "export const noFurtherCharge", ";")).toContain("p.confirmed");
    const end = between(refundsSource, "if (op.end_plan === 1) {", "} else if (op.cancel_subscription_id)");
    expect(end).toContain("if (!await stripeEndConfirmed(env, op.subscription_id)) await cancelConfirmed(");
    expect(end).not.toMatch(/status\s*!==\s*"canceled"/);
    expect(between(b5Source, "async function endOnFullCoverage", "async function reverseJournaledCredits"))
      .toContain('if (ending?.ended === 1 && await stripeEndConfirmed(env, w.subscription_id)) { await release("ledger_operation")');
    expect(b3Source).toContain("${CHECKOUT_MAY_SETTLE_SQL} OR ${DELETION_BILLING_OPEN_SQL}");
    expect(between(gatewaySource, "export const DELETION_BILLING_OPEN_SQL", ";")).toContain('stripeEndConfirmedSql("db")');
    expect(between(b5Source, "export async function provisionFailedEmail", "paras.push(`")).toContain('stripeEndConfirmedSql("b")');
  });
});
