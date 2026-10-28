// SPDX-License-Identifier: AGPL-3.0-or-later
// B5 billing: Stripe events are fixtures; no network. Real workerd + D1, the frozen B3 lifecycle with its fake provider.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker, SCHEDULED_SWEEP_DEADLINE_MS } from "../src/index";
import { fakeProvider, type ProviderAdapter } from "../src/b3-provider";
import { PROVISION_MAX_MS, type Home } from "../src/b3-control";
import { billingConfig } from "../src/b5-config";
import { signStripePayload } from "../src/b5-stripe";
import { boundSession, consentFor, latestConsentId, seedPendingQuotes } from "./legal-helpers";
import { backoffFor, defaultNotifier, EVENT_CLAIM_MS, EVENT_MAX_MS, MISS_SETTLES_AFTER_MS, NOTICE_DEAD_LIMIT, NOTICE_RETRY_CLAIM_MS, SWEEP_LOOP_BUDGET_MS, SWEEP_PERIOD_MS,
  SWEEP_RUN_MS, noticeBackoff, processStoredEvent, stubFluxHooks, sweepBilling, SWEEP_EVENT_BATCH, type BillingDependencies, type BillingNotifier, type FluxEntitlementHooks } from "../src/b5-billing";
import { acquireHomeLease } from "../src/billing-lease";
import { deliver as deliverAlert } from "../src/ops-monitor";
import { customerFake } from "./stripe-customer-fake";
/** The renewal dropdown, answered (plan §3.2): without it the guard turns the order away. */
const RENEWAL_YES = [{ key: "renewalconsent", type: "dropdown", dropdown: { value: "renewalyes" } }];

const ADMIN = "test-only-b5-admin-no-real-access";
const WHSEC = "whsec_testonlyfixturesecret0123456789";
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const OWNER = "b5-owner";
const INSTALL = "12345678-1234-4123-8123-123456789012";
const IMAGE = `sha256:${"a".repeat(64)}`;
const PRICES = { STRIPE_PRICE_STARTER: "price_starter0001", STRIPE_PRICE_PRO: "price_pro00000001", STRIPE_PRICE_MAX: "price_max000000001" };
const B3 = { reservationMs: 30 * 60_000, graceMs: 3 * DAY, retentionMs: 14 * DAY, imageDigest: IMAGE, quarantineRelayIP: "192.0.2.20",
  engineSubscriptionGates: { claudeAgent: true, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: true },
  capacity: [{ id: "slot-1", projectId: "p1", location: "fsn1", serverType: "cx23", outcome: "available" }] };
const baseEnv = (): Env => ({ ...env, CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_KEK_V1: btoa("x".repeat(32)), CLOUD_B3_MODE: "fake",
  CLOUD_B3_CONFIG: JSON.stringify(B3), STRIPE_SECRET_KEY: "sk_test_fixturefixturefixture", STRIPE_WEBHOOK_SECRET: WHSEC,
  BILLING_RETURN_ORIGIN: "https://cloud.murage.test", ...PRICES } as Env);

interface StripeCall { method: string; path: string; form: URLSearchParams; headers: Headers }
let stripeCalls: StripeCall[];
let notices: { id: string; kind: string; homeId: string }[];
let fluxLog: { hook: string; args: unknown }[];
let cancelFails = false;
// Stripe's refund listing of pi_1 (GET /v1/refunds): what Stripe shows returned, the only evidence a refund ends anything (Astra JOURNEY-A-6 #1).
let refundList: { id: string; amount: number; status: string; payment_intent: string; metadata: Record<string, string> }[] = [];
// Objects Stripe answers on a plain GET (a session's line items, registered by boundSession).
let retrievable: Record<string, unknown> = {};
const cust = customerFake();
const stripeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  // Every call the code sends is logged, the ones the shared customer fake answers included (merge of lanes C1 + F: the fake answered
  // GET /v1/customers/{id} before the log, so the address handler's live read was invisible to C1's assertions).
  stripeCalls.push({ method: init?.method ?? "GET", path: url.pathname, form: new URLSearchParams(String(init?.body ?? "")), headers: new Headers(init?.headers) });
  // The customer preset (Astra TAXCOUNTRY-1): customers persisted by a shared fake.
  { const cr = await cust.handle(init?.method ?? "GET", url, new URLSearchParams(String(init?.body ?? ""))); if (cr) return cr; }
  const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s });
  if ((init?.method ?? "GET") === "GET" && retrievable[url.pathname]) return j(retrievable[url.pathname]);
  if (url.pathname === "/v1/customers") return j({ id: "cus_test1" });
  if (url.pathname === "/v1/checkout/sessions" && (init?.method ?? "GET") === "GET") return j({ data: [] });
  if (url.pathname === "/v1/checkout/sessions") return j({ id: "cs_test_1", url: "https://checkout.stripe.test/c/cs_test_1" });
  if (url.pathname === "/v1/billing_portal/sessions") return j({ url: "https://billing.stripe.test/p/1" });
  if (url.pathname.startsWith("/v1/billing_portal/configurations")) return j({ data: [{ id: "bpc_default", features: { subscription_update: { enabled: false } } }] });
  if (url.pathname.startsWith("/v1/charges/")) return j({ id: "ch_1", customer: "cus_test1", invoice: "in_1", payment_intent: "pi_1" });
  if (url.pathname.startsWith("/v1/invoices/")) return j({ id: "in_1", payment_intent: "pi_1", charge: "ch_1", amount_paid: 4900 });
  if (url.pathname === "/v1/refunds" && (init?.method ?? "GET") === "GET") return j({ data: refundList, has_more: false });
  if (url.pathname === "/v1/refunds") return j({ id: "re_1", status: "succeeded" });
  if (url.pathname.startsWith("/v1/subscriptions/")) return cancelFails ? j({ error: { code: "resource_missing" } }, 404)
    : j({ id: "sub_test1", ...((init?.method ?? "GET") === "DELETE" ? { status: "canceled" } : {}) });
  return j({ error: { code: "unexpected" } }, 500);
};
// Like the real notifier, a delivered notice is marked sent (a notice recorded with its action beforehand is not sent again by the sweep).
const notifier: BillingNotifier = { async notify(e, n) {
  notices.push({ id: n.id, kind: n.kind, homeId: n.homeId });
  await e.DB.prepare("UPDATE billing_notices SET sent_at=? WHERE id=? AND sent_at IS NULL").bind(Date.now(), n.id).run();
} };
const flux: FluxEntitlementHooks = {
  capabilities: { reversalTargets: true }, // switched on and qualified (Astra JOURNEY-A-10 #1)
  async grantMonthlyCredits(_e, input) { fluxLog.push({ hook: "grant", args: input }); },
  async changePlan(_e, input) { fluxLog.push({ hook: "plan", args: input }); },
  async revokeCredits(_e, input) { fluxLog.push({ hook: "revoke", args: input }); },
  async stopForBilling(_e, homeId, _d, options) { fluxLog.push({ hook: "stop", args: { homeId, ...options } }); },
  async usedIncludedCreditMicrocents() { return { usedMicrocents: 0 }; },
  async setAutoRecharge(_e, input) { fluxLog.push({ hook: "autorecharge", args: input }); },
};
const deps = (): BillingDependencies => ({ stripeFetch, notifier, flux });
let purged: string[];
const provider = (db: D1Database): ProviderAdapter => ({ ...fakeProvider(db), async purge_snapshots(h, g) { purged.push(`${h}:${g}`); } });

async function send(path: string, init: { method?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}, extraDeps: BillingDependencies = deps()) {
  await seedPendingQuotes();
  const ctx = createExecutionContext();
  const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  const response = await createWorker(fetch, fetch, { provider }, {}, extraDeps).fetch(new Request(`https://admin.murage.test${path}`, {
    method: init.method ?? "POST", body, headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.10", ...init.headers } }), baseEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const admin = { authorization: `Bearer ${ADMIN}` };
let evtN = 0;
function stripeEvent(type: string, object: Record<string, unknown>, created = NOW / 1000) {
  return { id: `evt_test${++evtN}abcd`, type, created, data: { object } };
}
async function hook(event: unknown, opts: { sig?: string; tSeconds?: number } = {}) {
  const raw = JSON.stringify(event);
  const sig = opts.sig ?? await signStripePayload(raw, WHSEC, opts.tSeconds ?? NOW / 1000);
  return send("/v1/billing/webhook", { raw, headers: { "stripe-signature": sig } });
}
const reconcile = () => send("/v1/fake-b3/reconcile", { body: {}, headers: admin });
const getHome = async () => (await env.DB.prepare("SELECT * FROM cloud_homes WHERE id='home-1'").first<Home>())!;
const sub = (over: Record<string, unknown> = {}) => ({ object: "subscription", id: "sub_test1", customer: "cus_test1", status: "active",
  cancel_at_period_end: false, current_period_start: NOW / 1000, current_period_end: NOW / 1000 + 30 * 86400,
  items: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER } }] }, ...over });
const invoice = (over: Record<string, unknown> = {}) => ({ object: "invoice", id: "in_1", customer: "cus_test1", subscription: "sub_test1",
  billing_reason: "subscription_create", amount_paid: 4900,
  lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: { start: NOW / 1000, end: NOW / 1000 + 30 * 86400 } }] }, ...over });
async function reserveAndCheckout(plan = "starter", fpTid?: string) {
  const r = await send("/v1/fake-b3/reserve", { body: { homeId: "home-1", installationId: INSTALL, ownerId: OWNER,
    publicOrigin: "https://home-1.murage.test", idempotencyKey: "reserve-key-home-1-0001" }, headers: admin });
  expect(r.status).toBe(201);
  return send("/v1/billing/checkout", { body: { homeId: "home-1", plan, consent: consentFor(plan, NOW), ...(fpTid ? { fp_tid: fpTid } : {}) }, headers: admin });
}
async function paidAndRunning() {
  expect((await reserveAndCheckout()).status).toBe(200);
  expect((await hook(stripeEvent("checkout.session.completed", await boundSession({ object: "checkout.session", consent: { terms_of_service: "accepted" }, customer_details: { address: { country: "US" } }, id: "cs_test_1", mode: "subscription",
    payment_status: "paid", customer: "cus_test1", subscription: "sub_test1", invoice: "in_1", client_reference_id: "home-1",
    metadata: { home_id: "home-1", plan: "starter", consent_id: await latestConsentId("home-1") } }, {}, retrievable)))).status).toBe(200);
  expect((await hook(stripeEvent("invoice.paid", invoice()))).status).toBe(200);
  expect((await reconcile()).status).toBe(200);
}
beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  stripeCalls = []; notices = []; fluxLog = []; purged = []; cancelFails = false; evtN = 0; retrievable = {}; refundList = [];
  await env.DB.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, 'B5','b5@example.test',1,?,?)`).bind(OWNER, NOW, NOW).run();
  await env.DB.prepare(`INSERT INTO installations (id,owner_user_id,client_instance_id,display_name,platform,created_at,updated_at)
    VALUES (?,?,?,'B5','linux',?,?)`).bind(INSTALL, OWNER, INSTALL, NOW, NOW).run();
});
afterEach(() => vi.restoreAllMocks());

describe("webhook signature and inbox", () => {
  it("rejects missing, malformed, wrong, stale and replayed-with-other-body signatures and stores nothing", async () => {
    const ev = stripeEvent("invoice.paid", invoice());
    const raw = JSON.stringify(ev);
    expect((await send("/v1/billing/webhook", { raw })).status).toBe(400);
    expect((await send("/v1/billing/webhook", { raw, headers: { "stripe-signature": "garbage" } })).status).toBe(400);
    expect((await hook(ev, { sig: `t=${NOW / 1000},v1=${"0".repeat(64)}` })).status).toBe(400);
    expect((await hook(ev, { tSeconds: NOW / 1000 - 301 })).status).toBe(400);
    const good = await signStripePayload(raw, WHSEC, NOW / 1000);
    expect((await send("/v1/billing/webhook", { raw: raw.replace("4900", "1"), headers: { "stripe-signature": good } })).status).toBe(400);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM stripe_events").first<{ n: number }>())!.n).toBe(0);
  });
  it("refuses a chunked body over the cap as it streams, without reading it whole (upstream 88060af8f)", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024);
    // 4 MB with no declared length; the cap is 256 KB
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; if (pulled > 64) controller.close(); else controller.enqueue(chunk); } });
    const ctx = createExecutionContext();
    const response = await createWorker(fetch, fetch, { provider }, {}, deps()).fetch(new Request("https://admin.murage.test/v1/billing/webhook", {
      method: "POST", body: stream, headers: { "content-type": "application/json", "stripe-signature": `t=${NOW / 1000},v1=${"0".repeat(64)}` }, duplex: "half" } as RequestInit), baseEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(20);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM stripe_events").first<{ n: number }>())!.n).toBe(0);
  });
  it("accepts a body larger than the 16 KB API cap and is idempotent on event id", async () => {
    await reserveAndCheckout();
    const big = stripeEvent("checkout.session.completed", await boundSession({ object: "checkout.session", consent: { terms_of_service: "accepted" }, customer_details: { address: { country: "US" } }, id: "cs_test_1", mode: "subscription", payment_status: "paid",
      customer: "cus_test1", subscription: "sub_test1", invoice: "in_1", client_reference_id: "home-1", metadata: { home_id: "home-1", plan: "starter", consent_id: await latestConsentId("home-1"), pad: "x".repeat(40_000) } }, {}, retrievable));
    expect((await hook(big)).status).toBe(200);
    const again = await hook(big);
    expect(await again.json()).toEqual({ received: true, duplicate: true });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM stripe_events").first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_payment_inbox").first<{ n: number }>())!.n).toBe(1);
  });
  it("ignores unknown event types and non-subscription checkouts", async () => {
    expect((await hook(stripeEvent("customer.created", { id: "cus_x" }))).status).toBe(200);
    expect((await hook(stripeEvent("checkout.session.completed", { object: "checkout.session", consent: { terms_of_service: "accepted" }, custom_fields: RENEWAL_YES, customer_details: { address: { country: "US" } }, mode: "payment", id: "cs_x" }))).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_payment_inbox").first<{ n: number }>())!.n).toBe(0);
  });
  it("an event for a home we cannot resolve fails with 500 and is retried by the sweep once the home exists", async () => {
    const ev = stripeEvent("invoice.paid", invoice());
    expect((await hook(ev)).status).toBe(500);
    expect((await env.DB.prepare("SELECT processed_at,error FROM stripe_events").first<{ processed_at: number | null; error: string }>())).toEqual({ processed_at: null, error: "home_unresolved" });
    await reserveAndCheckout();
    // The home exists now, but the confirmation gate (Astra #2) holds the invoice until the checkout completes and the confirmation is out.
    vi.mocked(Date.now).mockReturnValue(NOW + 10 * 60_000);
    await expect(sweepBilling(baseEnv(), deps())).rejects.toThrow("billing_sweep_incomplete");
    expect((await env.DB.prepare("SELECT processed_at,error FROM stripe_events").first())).toEqual({ processed_at: null, error: "confirmation_pending" });
    expect((await hook(stripeEvent("checkout.session.completed", await boundSession({ object: "checkout.session", consent: { terms_of_service: "accepted" }, customer_details: { address: { country: "US" } }, id: "cs_test_1", mode: "subscription", payment_status: "paid",
      customer: "cus_test1", subscription: "sub_test1", invoice: "in_1", client_reference_id: "home-1",
      metadata: { home_id: "home-1", plan: "starter", consent_id: await latestConsentId("home-1") } }, {}, retrievable)), { tSeconds: (NOW + 10 * 60_000) / 1000 })).status).toBe(200);
    vi.mocked(Date.now).mockReturnValue(NOW + 30 * 60_000);
    await sweepBilling(baseEnv(), deps());
    expect((await env.DB.prepare("SELECT processed_at FROM stripe_events WHERE type='invoice.paid'").first<{ processed_at: number | null }>())!.processed_at).toBe(NOW + 30 * 60_000);
  });
});

describe("checkout and portal", () => {
  it("builds a subscription Checkout with Stripe Tax, the plan price and fp_tid from the cookie", async () => {
    const res = await reserveAndCheckout("pro", "fp_tid_abc123");
    expect(await res.json()).toMatchObject({ sessionId: "cs_test_1", url: "https://checkout.stripe.test/c/cs_test_1" });
    const cs = stripeCalls.find((c) => c.path === "/v1/checkout/sessions")!;
    expect(cs.form.get("mode")).toBe("subscription");
    expect(cs.form.get("line_items[0][price]")).toBe(PRICES.STRIPE_PRICE_PRO);
    expect(cs.form.get("automatic_tax[enabled]")).toBe("true");
    expect(cs.form.get("metadata[fp_tid]")).toBe("fp_tid_abc123");
    expect(cs.form.get("subscription_data[metadata][fp_tid]")).toBe("fp_tid_abc123");
    expect(cs.form.get("client_reference_id")).toBe("home-1");
    expect(cs.form.get("customer")).toBe("cus_test1");
    // Stripe returns to the members area's Cloud page (/home/cloud), never the retired portal's /billing pages.
    expect(cs.form.get("success_url")).toMatch(/^https:\/\/cloud\.murage\.test\/home\/cloud\?notice=paid&home=[^&]+$/);
    expect(cs.form.get("cancel_url")).toMatch(/^https:\/\/cloud\.murage\.test\/home\/cloud\?notice=checkout_cancelled&home=[^&]+$/);
    expect(cs.headers.get("stripe-version")).toBe("2025-03-31.basil"); // the ONE pinned version (Managed Payments needs Basil)
    expect(cs.headers.get("idempotency-key")).toMatch(/^checkout:consent-/);
    expect(stripeCalls.find((c) => c.path === "/v1/customers")!.form.get("metadata[fp_tid]")).toBe("fp_tid_abc123");
  });
  it("maps each plan to its configured price, refuses unknown plans, bad cookies, no admin and non-payable homes", async () => {
    for (const [plan, price] of [["starter", PRICES.STRIPE_PRICE_STARTER], ["max", PRICES.STRIPE_PRICE_MAX]] as const) {
      stripeCalls = [];
      await env.DB.prepare("DELETE FROM billing_subscriptions").run(); await env.DB.prepare("DELETE FROM cloud_homes").run();
      await env.DB.prepare("DELETE FROM cloud_capacity").run(); await env.DB.prepare("DELETE FROM cloud_mutations").run();
      await env.DB.prepare("DELETE FROM cloud_outbox").run();
      await reserveAndCheckout(plan);
      expect(stripeCalls.find((c) => c.path === "/v1/checkout/sessions")!.form.get("line_items[0][price]")).toBe(price);
    }
    expect((await send("/v1/billing/checkout", { body: { homeId: "home-1", plan: "enterprise", consent: consentFor("pro", NOW) }, headers: admin })).status).toBe(400);
    expect((await send("/v1/billing/checkout", { body: { homeId: "home-1", plan: "pro", fp_tid: "bad value!", consent: consentFor("pro", NOW) }, headers: admin })).status).toBe(400);
    expect((await send("/v1/billing/checkout", { body: { homeId: "home-1", plan: "pro", consent: consentFor("pro", NOW) } })).status).toBe(401);
    expect((await send("/v1/billing/checkout", { body: { homeId: "nope", plan: "pro", consent: consentFor("pro", NOW) }, headers: admin })).status).toBe(404);
  });
  it("refuses a second checkout once the home is subscribed", async () => {
    await paidAndRunning();
    expect((await send("/v1/billing/checkout", { body: { homeId: "home-1", plan: "pro", consent: consentFor("pro", NOW) }, headers: admin })).status).toBe(409);
  });
  it("opens the hosted Customer Portal for the stored customer", async () => {
    expect((await send("/v1/billing/portal", { body: { homeId: "home-1" }, headers: admin })).status).toBe(404);
    await reserveAndCheckout();
    const res = await send("/v1/billing/portal", { body: { homeId: "home-1" }, headers: admin });
    expect(await res.json()).toEqual({ url: "https://billing.stripe.test/p/1" });
    expect(stripeCalls.at(-1)!.form.get("customer")).toBe("cus_test1");
    expect(stripeCalls.at(-1)!.form.get("return_url")).toBe("https://cloud.murage.test/home/cloud");
  });
  it("is off (503) when Stripe is not configured", async () => {
    const ctx = createExecutionContext();
    const res = await createWorker(fetch, fetch, {}, {}, deps()).fetch(new Request("https://admin.murage.test/v1/billing/portal", {
      method: "POST", headers: { "content-type": "application/json", ...admin }, body: JSON.stringify({ homeId: "home-1" }) }),
    { ...baseEnv(), STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined } as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);
  });
});

describe("customer-facing contract (portal): session user + 2FA step-up", () => {
  const as = (id: string | null, stepUp: boolean): BillingDependencies => ({ ...deps(), accountUser: async () => (id ? { id } : null), stepUp: async () => stepUp });
  async function reserveOnly() {
    expect((await send("/v1/fake-b3/reserve", { body: { homeId: "home-1", installationId: INSTALL, ownerId: OWNER,
      publicOrigin: "https://home-1.murage.test", idempotencyKey: "reserve-key-home-1-0001" }, headers: admin })).status).toBe(201);
  }
  it("refuses checkout without step-up (403) and creates no Stripe session", async () => {
    await reserveOnly();
    const res = await send("/v1/billing/checkout", { body: { plan: "pro", consent: consentFor("pro", NOW) } }, as(OWNER, false));
    // The purchase routes say the first-purchase bootstrap does not apply (purchase-bootstrap.ts).
    expect(res.status).toBe(403); expect(await res.json()).toEqual({ error: "step_up_required", step_up: { bootstrap: false } });
    expect(stripeCalls).toEqual([]);
  });
  it("fails closed when no step-up check is wired", async () => {
    await reserveOnly();
    expect((await send("/v1/billing/checkout", { body: { plan: "pro", consent: consentFor("pro", NOW) } }, { ...deps(), accountUser: async () => ({ id: OWNER }) })).status).toBe(403);
  });
  it("with step-up, {plan, fp_tid} returns the Checkout URL for the user's own home; a foreign homeId is refused (409 home_mismatch)", async () => {
    await reserveOnly();
    // A customer's homeId must BE the home the server resolves (Astra TRUST-4 P2-4): another one is refused before anything is created.
    const foreign = await send("/v1/billing/checkout", { body: { plan: "max", fp_tid: "tid_1", homeId: "someone-elses", consent: consentFor("max", NOW) } }, as(OWNER, true));
    expect([foreign.status, await foreign.json()]).toEqual([409, { error: "home_mismatch" }]);
    expect(stripeCalls).toEqual([]);
    const res = await send("/v1/billing/checkout", { body: { plan: "max", fp_tid: "tid_1", homeId: "home-1", consent: consentFor("max", NOW) } }, as(OWNER, true));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sessionId: "cs_test_1", url: "https://checkout.stripe.test/c/cs_test_1" });
    const cs = stripeCalls.find((c) => c.path === "/v1/checkout/sessions")!;
    expect(cs.form.get("client_reference_id")).toBe("home-1");
    expect(cs.form.get("line_items[0][price]")).toBe(PRICES.STRIPE_PRICE_MAX);
    expect(cs.form.get("metadata[fp_tid]")).toBe("tid_1");
  });
  it("401 without a session, 404 for a user with no payable home", async () => {
    await reserveOnly();
    expect((await send("/v1/billing/checkout", { body: { plan: "pro", consent: consentFor("pro", NOW) } }, as(null, true))).status).toBe(401);
    expect((await send("/v1/billing/checkout", { body: { plan: "pro", consent: consentFor("pro", NOW) } }, as("other-user", true))).status).toBe(404);
  });
  it("portal returns the hosted Customer Portal URL for the user's subscribed home only", async () => {
    await reserveOnly();
    // The Stripe Customer Portal can cancel and change the payment method: a money action, so it needs step-up too.
    expect((await send("/v1/billing/portal", { body: {} }, as(OWNER, false))).status).toBe(403);
    expect((await send("/v1/billing/portal", { body: {} }, as(OWNER, true))).status).toBe(404);
    expect((await send("/v1/billing/checkout", { body: { plan: "pro", fp_tid: "tid_1", consent: consentFor("pro", NOW) } }, as(OWNER, true))).status).toBe(200);
    const res = await send("/v1/billing/portal", { body: {} }, as(OWNER, true));
    expect(await res.json()).toEqual({ url: "https://billing.stripe.test/p/1" });
    expect((await send("/v1/billing/portal", { body: {} }, as("other-user", true))).status).toBe(404);
    expect(stripeCalls.find((c) => c.path === "/v1/checkout/sessions")!.form.get("metadata[fp_tid]")).toBe("tid_1");
  });
});

describe("config safety", () => {
  it("refuses live keys unless explicitly allowed, and keeps Flux top-ups out of the commission allowlist", () => {
    expect(() => billingConfig({ ...baseEnv(), STRIPE_SECRET_KEY: "sk_live_fixturefixturefixture" } as Env)).toThrow("billing_live_not_allowed"); // secret-scan: fixture
    expect(() => billingConfig({ ...baseEnv(), FP_COMMISSION_PRICE_IDS: "price_topup000001", FLUX_TOPUP_PRICE_IDS: "price_topup000001" } as Env)).toThrow("commission_allowlist_invalid");
    expect(() => billingConfig({ ...baseEnv(), FP_COMMISSION_PRICE_IDS: "price_unknown00001" } as Env)).toThrow("commission_allowlist_invalid");
    const c = billingConfig(baseEnv())!;
    expect([...c.commissionPriceIds].sort()).toEqual(Object.values(PRICES).sort());
    expect(() => billingConfig({ ...baseEnv(), STRIPE_PRICE_PRO: PRICES.STRIPE_PRICE_STARTER } as Env)).toThrow("billing_prices_duplicate");
    expect(billingConfig({ ...baseEnv(), STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined } as Env)).toBeNull();
  });
  it("a Flux top-up invoice grants nothing and moves no state", async () => {
    await paidAndRunning(); fluxLog = [];
    const topup = invoice({ id: "in_topup", lines: { data: [{ price: { id: "price_topup000001" }, period: { start: NOW / 1000, end: NOW / 1000 + 1 } }] } });
    expect((await hook(stripeEvent("invoice.paid", topup, NOW / 1000 + 5))).status).toBe(200);
    expect(fluxLog).toEqual([]);
  });
});

describe("lifecycle: pay, fail, grace, suspend, delete", () => {
  it("pay creates the home and grants the monthly Flux credit once", async () => {
    await paidAndRunning();
    expect((await getHome()).entitlement).toBe("paid");
    expect((await getHome()).desired_state).toBe("checking");
    expect(await env.DB.prepare("SELECT id FROM cloud_fake_resources WHERE role='home'").first()).not.toBeNull();
    expect(fluxLog).toEqual([{ hook: "grant", args: { homeId: "home-1", plan: "starter", invoiceId: "in_1",
      periodStart: NOW, periodEnd: NOW + 30 * 86400_000 } }]);
    const row = await env.DB.prepare("SELECT * FROM billing_subscriptions").first();
    expect(row).toMatchObject({ subscription_id: "sub_test1", plan: "starter", status: "active" });
  });
  it("payment failed: 3 day grace with an email, then suspend (data kept), Flux stopped, notices, delete after 14 days", async () => {
    await paidAndRunning();
    expect((await hook(stripeEvent("invoice.payment_failed", invoice({ id: "in_2", billing_reason: "subscription_cycle" }), NOW / 1000 + 60))).status).toBe(200);
    await reconcile();
    const h1 = await getHome();
    expect(h1.desired_state).toBe("payment_problem");
    expect(h1.grace_until).toBe(NOW + 3 * DAY);
    expect(notices.filter((n) => n.kind === "payment_failed")).toHaveLength(1);
    // grace not over: still running
    vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY - 1000); await reconcile();
    expect((await getHome()).desired_state).toBe("payment_problem");
    // grace over: suspend, servers fenced, nothing deleted
    vi.mocked(Date.now).mockReturnValue(NOW + 3 * DAY + 1000); await reconcile();
    const s = await getHome();
    expect(s.desired_state).toBe("suspended");
    expect(s.delete_after).toBe(NOW + 3 * DAY + 1000 + 14 * DAY);
    expect((await env.DB.prepare("SELECT state FROM cloud_fake_resources WHERE role='volume'").first<{ state: string }>())!.state).not.toBe("destroyed");
    await sweepBilling(baseEnv(), deps());
    expect(fluxLog.some((f) => f.hook === "stop")).toBe(true);
    expect(notices.filter((n) => n.kind === "suspended")).toHaveLength(1);
    expect((await getHome()).suspension_notices).toBe(1);
    // no deletion before day 14 even with one notice
    vi.mocked(Date.now).mockReturnValue(s.delete_after! - 4 * DAY); await reconcile(); await sweepBilling(baseEnv(), deps());
    expect((await getHome()).desired_state).toBe("suspended"); expect((await getHome()).suspension_notices).toBe(1);
    // 3 days before deletion: the warning
    vi.mocked(Date.now).mockReturnValue(s.delete_after! - 3 * DAY); await sweepBilling(baseEnv(), deps());
    expect(notices.filter((n) => n.kind === "deletion_warning")).toHaveLength(1);
    expect((await getHome()).suspension_notices).toBe(2);
    // day 14: delete (DNS first, then resources after the TTL), snapshots purged with it
    vi.mocked(Date.now).mockReturnValue(s.delete_after! + 1000); await reconcile();
    expect((await getHome()).desired_state).toBe("deleting");
    await reconcile();
    vi.mocked(Date.now).mockReturnValue(s.delete_after! + 70_000); await reconcile();
    expect((await getHome()).desired_state).toBe("deleted");
    expect(purged).toEqual(["home-1:1"].length ? [`home-1:${(await getHome()).resource_generation}`] : []);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_fake_resources WHERE state<>'destroyed'").first<{ n: number }>())!.n).toBe(0);
    await sweepBilling(baseEnv(), deps());
    expect(notices.some((n) => n.kind === "deleted")).toBe(true);
  });
  it("a notice that cannot be delivered does not count toward deletion", async () => {
    await paidAndRunning();
    await hook(stripeEvent("customer.subscription.deleted", sub({ status: "canceled" }), NOW / 1000 + 10)); await reconcile();
    const failing: BillingNotifier = { async notify() { throw new Error("smtp_down"); } };
    await expect(sweepBilling(baseEnv(), { ...deps(), notifier: failing })).rejects.toThrow("billing_sweep_incomplete");
    expect((await getHome()).suspension_notices).toBe(0);
  });
  it("paying again during grace resumes without suspending", async () => {
    await paidAndRunning();
    await hook(stripeEvent("invoice.payment_failed", invoice({ id: "in_2" }), NOW / 1000 + 60)); await reconcile();
    await hook(stripeEvent("invoice.paid", invoice({ id: "in_3", billing_reason: "subscription_cycle" }), NOW / 1000 + 120)); await reconcile();
    expect((await getHome()).grace_until).toBeNull();
    vi.mocked(Date.now).mockReturnValue(NOW + 4 * DAY); await reconcile();
    expect((await getHome()).desired_state).not.toBe("suspended");
  });
});

describe("cancel, refund, dispute, upgrade", () => {
  it("cancel at period end keeps the home active and sends a notice; the period-end deletion event suspends it", async () => {
    await paidAndRunning();
    // Stripe, read live (Astra JOURNEY-B-2 #5: a changed cancellation field is always confirmed against it), shows the end too.
    retrievable["/v1/subscriptions/sub_test1"] = sub({ cancel_at_period_end: true });
    await hook(stripeEvent("customer.subscription.updated", sub({ cancel_at_period_end: true }), NOW / 1000 + 5)); await reconcile();
    expect((await getHome()).desired_state).toBe("checking");
    expect(notices.filter((n) => n.kind === "cancel_scheduled")).toHaveLength(1);
    expect((await env.DB.prepare("SELECT cancel_at_period_end AS c FROM billing_subscriptions").first<{ c: number }>())!.c).toBe(1);
    const end = NOW + 30 * DAY; vi.mocked(Date.now).mockReturnValue(end);
    await hook(stripeEvent("customer.subscription.deleted", sub({ status: "canceled" }), end / 1000), { tSeconds: end / 1000 }); await reconcile();
    const h = await getHome();
    expect(h.desired_state).toBe("suspended");
    expect(h.delete_after).toBe(end + 14 * DAY);
    expect(notices.filter((n) => n.kind === "subscription_ended")).toHaveLength(1);
  });
  it("a full refund (Stripe lists the whole payment returned) ends the subscription, suspends and stops Flux service only; a partial refund does nothing", async () => {
    await paidAndRunning(); fluxLog = [];
    const charge = { object: "charge", id: "ch_1", customer: "cus_test1", invoice: "in_1", refunded: false, amount_refunded: 100 };
    refundList = [{ id: "re_p", amount: 100, status: "succeeded", payment_intent: "pi_1", metadata: {} }];
    await hook(stripeEvent("charge.refunded", charge, NOW / 1000 + 10)); await reconcile();
    expect((await getHome()).desired_state).toBe("checking"); expect(fluxLog).toEqual([]);
    refundList.push({ id: "re_f", amount: 4800, status: "succeeded", payment_intent: "pi_1", metadata: {} });
    await hook(stripeEvent("charge.refunded", { ...charge, refunded: true, amount_refunded: 4900 }, NOW / 1000 + 20)); await reconcile();
    expect((await getHome()).desired_state).toBe("suspended");
    // The Stop ends service only: the credit follows the payment's own reversal target (journaled; these hooks are not qualified, so not sent).
    expect(fluxLog).toEqual([{ hook: "stop", args: { homeId: "home-1", invoiceId: "in_1", keepGrants: true } }]);
    expect(stripeCalls.some((c) => c.method === "DELETE" && c.path === "/v1/subscriptions/sub_test1")).toBe(true);
    expect(notices.some((n) => n.kind === "refunded")).toBe(true);
  });
  it("a refund of a subscription Stripe already ended still suspends", async () => {
    await paidAndRunning(); cancelFails = true;
    refundList = [{ id: "re_f", amount: 4900, status: "succeeded", payment_intent: "pi_1", metadata: {} }];
    await hook(stripeEvent("charge.refunded", { object: "charge", id: "ch_1", customer: "cus_test1", invoice: "in_1", refunded: true }, NOW / 1000 + 20)); await reconcile();
    expect((await getHome()).desired_state).toBe("suspended");
  });
  it("a dispute looks up the charge, suspends, ends billing and stops Flux for that invoice", async () => {
    await paidAndRunning(); fluxLog = [];
    await hook(stripeEvent("charge.dispute.created", { object: "dispute", id: "dp_1", charge: "ch_1", reason: "fraudulent" }, NOW / 1000 + 30)); await reconcile();
    expect(stripeCalls.some((c) => c.path === "/v1/charges/ch_1")).toBe(true);
    expect((await getHome()).desired_state).toBe("suspended");
    // Round 9b: an open dispute ends service only (keepGrants) and holds; credit is never reversed on the open dispute.
    expect(fluxLog).toEqual([{ hook: "stop", args: { homeId: "home-1", invoiceId: "in_1", keepGrants: true, line: "sub_test1" } }]);
    expect((await env.DB.prepare("SELECT status FROM billing_subscriptions").first<{ status: string }>())!.status).toBe("disputed");
    expect(notices.some((n) => n.kind === "dispute_opened")).toBe(true);
  });
  it("an old event delivered late cannot undo a newer state", async () => {
    await paidAndRunning();
    await hook(stripeEvent("customer.subscription.deleted", sub({ status: "canceled" }), NOW / 1000 + 100)); await reconcile();
    expect((await getHome()).desired_state).toBe("suspended");
    await hook(stripeEvent("invoice.paid", invoice({ id: "in_old" }), NOW / 1000 + 50)); await reconcile();
    expect((await getHome()).desired_state).toBe("suspended");
  });
  it("an upgrade changes the Flux plan and grants only the delta; period invoices after it grant a full period", async () => {
    await paidAndRunning(); fluxLog = [];
    await hook(stripeEvent("customer.subscription.updated", sub({ items: { data: [{ price: { id: PRICES.STRIPE_PRICE_PRO } }] } }), NOW / 1000 + 5));
    expect(fluxLog).toEqual([{ hook: "plan", args: { homeId: "home-1", plan: "pro", billingCustomerId: "cus_test1" } }]);
    fluxLog = [];
    // An upgrade nobody recorded (made at Stripe: Dashboard, portal) gets no automatic delta: an alert for ops (Astra MEMBERS3 P1-3).
    await hook(stripeEvent("invoice.paid", invoice({ id: "in_up0", billing_reason: "subscription_update", amount_paid: 2500,
      lines: { data: [{ proration: true, amount: 2500, price: { id: PRICES.STRIPE_PRICE_PRO }, period: { start: NOW / 1000 + 10, end: NOW / 1000 + 30 * 86400 } }] } }), NOW / 1000 + 6));
    expect(fluxLog).toEqual([]);
    expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind='billing.unverified_adjustment'").first()).toEqual({ kind: "billing.unverified_adjustment" });
    // A verified upgrade (our recorded plan change, bound to its invoice) gets exactly its delta.
    await env.DB.prepare(`INSERT INTO plan_changes (id,home_id,user_id,quote_id,subscription_id,from_plan,to_plan,amount_cents,currency,invoice_id,state,created_at,updated_at)
      VALUES ('pc-b5','home-1',?,'q','sub_test1','starter','pro',2500,'usd','in_up','requested',?,?)`).bind(OWNER, NOW, NOW).run();
    await hook(stripeEvent("invoice.paid", invoice({ id: "in_up", billing_reason: "subscription_update", amount_paid: 2500,
      lines: { data: [{ proration: true, amount: 2500, price: { id: PRICES.STRIPE_PRICE_PRO }, period: { start: NOW / 1000 + 10, end: NOW / 1000 + 30 * 86400 } }] } }), NOW / 1000 + 7));
    expect(fluxLog).toMatchObject([{ hook: "grant", args: { plan: "pro", kind: "upgrade_delta", previousPlan: "starter", invoiceId: "in_up" } }]);
  });
});

describe("live mode", () => {
  it("only Stripe can mark a live home paid: the synthetic payments route is closed", async () => {
    const ctx = createExecutionContext();
    const res = await createWorker(fetch, fetch, {}, {}, deps()).fetch(new Request("https://admin.murage.test/v1/fake-b3/payments", {
      method: "POST", headers: { "content-type": "application/json", ...admin },
      body: JSON.stringify({ eventId: "e1", homeId: "home-1", version: 1, status: "paid", paymentId: "p1" }) }), { ...baseEnv(), CLOUD_B3_MODE: "live" } as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });
  it("records a snapshot receipt and never lets a weaker receipt replace a volume-covering one", async () => {
    const body = { homeId: "home-1", resourceGeneration: 1, kind: "volume_archive", ref: "r2:archive/home-1", coversVolume: true };
    expect((await send("/v1/billing/snapshot-receipt", { body, headers: admin })).status).toBe(200);
    await send("/v1/billing/snapshot-receipt", { body: { ...body, kind: "server_snapshot", ref: "hetzner:9", coversVolume: false }, headers: admin });
    expect(await env.DB.prepare("SELECT kind,covers_volume FROM volume_snapshots").first()).toEqual({ kind: "volume_archive", covers_volume: 1 });
  });
});

describe("Astra JOURNEY-B-1 #14: a downgrade reaches Flux on the verified renewal invoice, not on the subscription update", () => {
  it("the update leaves the plan owed to Flux (dirty); the renewal invoice of the new plan tells Flux and only then clears it", async () => {
    await paidAndRunning();
    await env.DB.prepare("UPDATE billing_subscriptions SET plan='pro',price_id=? WHERE home_id='home-1'").bind(PRICES.STRIPE_PRICE_PRO).run();
    fluxLog = [];
    const next = { start: NOW / 1000 + 30 * 86400, end: NOW / 1000 + 60 * 86400 };
    await hook(stripeEvent("customer.subscription.updated", sub({ current_period_start: next.start, current_period_end: next.end }), NOW / 1000 + 5));
    expect(fluxLog.filter((x) => x.hook === "plan")).toEqual([]);
    expect(await env.DB.prepare("SELECT plan,flux_plan_dirty FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ plan: "starter", flux_plan_dirty: 1 });
    await hook(stripeEvent("invoice.paid", invoice({ id: "in_2", billing_reason: "subscription_cycle",
      lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: next }] } }), NOW / 1000 + 6));
    expect(fluxLog).toContainEqual({ hook: "plan", args: { homeId: "home-1", plan: "starter", billingCustomerId: "cus_test1" } });
    expect(await env.DB.prepare("SELECT flux_plan_dirty FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ flux_plan_dirty: 0 });
  });
  it("Astra JOURNEY-B-2 #7: the renewal invoice first, the update second: the persisted evidence completes the move (from the update, else the sweep)", async () => {
    await paidAndRunning();
    await env.DB.prepare("UPDATE billing_subscriptions SET plan='pro',price_id=? WHERE home_id='home-1'").bind(PRICES.STRIPE_PRICE_PRO).run();
    fluxLog = [];
    const next = { start: NOW / 1000 + 30 * 86400, end: NOW / 1000 + 60 * 86400 };
    await hook(stripeEvent("invoice.paid", invoice({ id: "in_2", billing_reason: "subscription_cycle",
      lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: next }] } }), NOW / 1000 + 5));
    expect(fluxLog.filter((x) => x.hook === "plan")).toEqual([]); // the row still says Pro: nothing to tell Flux yet
    await hook(stripeEvent("customer.subscription.updated", sub({ current_period_start: next.start, current_period_end: next.end }), NOW / 1000 + 6));
    expect(fluxLog).toContainEqual({ hook: "plan", args: { homeId: "home-1", plan: "starter", billingCustomerId: "cus_test1" } });
    expect(await env.DB.prepare("SELECT plan,flux_plan_dirty FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ plan: "starter", flux_plan_dirty: 0 });
    // The sweep finishes a move still owed (here: the mark left set, as by a Flux failure) from the same evidence.
    await env.DB.prepare("UPDATE billing_subscriptions SET flux_plan_dirty=1 WHERE home_id='home-1'").run();
    fluxLog = [];
    await sweepBilling(baseEnv(), deps()).catch(() => undefined);
    expect(fluxLog.filter((x) => x.hook === "plan")).toEqual([{ hook: "plan", args: { homeId: "home-1", plan: "starter", billingCustomerId: "cus_test1" } }]);
    expect(await env.DB.prepare("SELECT flux_plan_dirty FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ flux_plan_dirty: 0 });
  });
  it("Astra JOURNEY-B-2 #7: a refunded renewal invoice (credit reversal) is no evidence: the move stays owed", async () => {
    await paidAndRunning();
    await env.DB.prepare("UPDATE billing_subscriptions SET plan='pro',price_id=? WHERE home_id='home-1'").bind(PRICES.STRIPE_PRICE_PRO).run();
    const next = { start: NOW / 1000 + 30 * 86400, end: NOW / 1000 + 60 * 86400 };
    await hook(stripeEvent("invoice.paid", invoice({ id: "in_2", billing_reason: "subscription_cycle",
      lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: next }] } }), NOW / 1000 + 5));
    expect(await env.DB.prepare("SELECT plan FROM credit_grants WHERE invoice_id='in_2' AND kind='period'").first()).toEqual({ plan: "starter" }); // the evidence
    await env.DB.prepare(`INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,requested_at) SELECT invoice_id,kind,home_id,'refund',0 FROM credit_grants WHERE invoice_id='in_2'`).run();
    fluxLog = [];
    await hook(stripeEvent("customer.subscription.updated", sub({ current_period_start: next.start, current_period_end: next.end }), NOW / 1000 + 6));
    expect(fluxLog.filter((x) => x.hook === "plan")).toEqual([]);
    expect(await env.DB.prepare("SELECT flux_plan_dirty FROM billing_subscriptions WHERE home_id='home-1'").first()).toEqual({ flux_plan_dirty: 1 });
  });
});

describe("Astra JOURNEY-B-3 #6-#8: one reversal barrier for every propagation path; the stub never acknowledges; dirty rows rotate", () => {
  const next = { start: NOW / 1000 + 30 * 86400, end: NOW / 1000 + 60 * 86400 };
  const dirtyOf = async () => (await env.DB.prepare("SELECT flux_plan_dirty AS d FROM billing_subscriptions WHERE home_id='home-1'").first<{ d: number }>())!.d;
  /** A downgrade to Starter applied at Stripe (the update first): the plan move is owed to Flux. */
  async function owed() {
    await paidAndRunning();
    await env.DB.prepare("UPDATE billing_subscriptions SET plan='pro',price_id=? WHERE home_id='home-1'").bind(PRICES.STRIPE_PRICE_PRO).run();
    await hook(stripeEvent("customer.subscription.updated", sub({ current_period_start: next.start, current_period_end: next.end }), NOW / 1000 + 5));
    expect(await dirtyOf()).toBe(1);
    fluxLog = [];
  }

  it("#6: a renewal invoice already reversed (its refund journaled) never changes Flux nor clears the mark, on the invoice nor in the sweep", async () => {
    await owed();
    await env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,requested_at) VALUES ('in_2','period','home-1','refund',0)").run();
    await hook(stripeEvent("invoice.paid", invoice({ id: "in_2", billing_reason: "subscription_cycle",
      lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: next }] } }), NOW / 1000 + 6));
    expect(fluxLog.filter((x) => x.hook === "plan" || x.hook === "grant")).toEqual([]);
    expect(await dirtyOf()).toBe(1);
    await sweepBilling(baseEnv(), deps()).catch(() => undefined);
    expect(fluxLog.filter((x) => x.hook === "plan")).toEqual([]);
    expect(await dirtyOf()).toBe(1);
  });
  it("#6: a grant the router reported reversed before it was applied (not_applied_reversed) is the same barrier for the plan", async () => {
    await owed();
    await env.DB.prepare(`INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,period_start,period_end,subscription_id,suppressed_at,suppressed_reason)
      VALUES ('in_2','period','home-1','starter',0,?,?,'sub_test1',0,'not_applied_reversed')`).bind(next.start * 1000, next.end * 1000).run();
    await hook(stripeEvent("invoice.paid", invoice({ id: "in_2", billing_reason: "subscription_cycle",
      lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: next }] } }), NOW / 1000 + 6));
    expect(fluxLog.filter((x) => x.hook === "plan")).toEqual([]);
    await sweepBilling(baseEnv(), deps()).catch(() => undefined);
    expect(fluxLog.filter((x) => x.hook === "plan")).toEqual([]);
    expect(await dirtyOf()).toBe(1);
  });

  it("#7: the default worker's stub changePlan (it only logs) never acknowledges: the mark stays for the cutover, one alert says so; the real hook clears it", async () => {
    await owed();
    await hook(stripeEvent("invoice.paid", invoice({ id: "in_2", billing_reason: "subscription_cycle",
      lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: next }] } }), NOW / 1000 + 6));
    // The evidence is persisted; now the plan move is left to the sweep, run with the stub (Flux off at launch).
    await env.DB.prepare("UPDATE billing_subscriptions SET flux_plan_dirty=1 WHERE home_id='home-1'").run();
    fluxLog = [];
    await sweepBilling(baseEnv(), { ...deps(), flux: stubFluxHooks }).catch(() => undefined);
    await sweepBilling(baseEnv(), { ...deps(), flux: stubFluxHooks }).catch(() => undefined);
    expect(await dirtyOf()).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='flux.plan_change_pending' AND home_id='home-1'").first()).toEqual({ n: 1 });
    await sweepBilling(baseEnv(), deps()).catch(() => undefined);
    expect(fluxLog.filter((x) => x.hook === "plan")).toEqual([{ hook: "plan", args: { homeId: "home-1", plan: "starter", billingCustomerId: "cus_test1" } }]);
    expect(await dirtyOf()).toBe(0);
  });
  it("#7: the stub on the renewal invoice itself leaves the mark set too", async () => {
    await owed();
    const raw = JSON.stringify(stripeEvent("invoice.paid", invoice({ id: "in_2", billing_reason: "subscription_cycle",
      lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: next }] } }), NOW / 1000 + 6));
    await send("/v1/billing/webhook", { raw, headers: { "stripe-signature": await signStripePayload(raw, WHSEC, NOW / 1000) } }, { ...deps(), flux: stubFluxHooks });
    expect(await env.DB.prepare("SELECT plan FROM credit_grants WHERE invoice_id='in_2' AND kind='period'").first()).toEqual({ plan: "starter" });
    expect(await dirtyOf()).toBe(1);
  });

  it("#8: fifty older dirty rows without usable evidence never starve an eligible one: each is stamped when tried and rotates behind it", async () => {
    await owed();
    await hook(stripeEvent("invoice.paid", invoice({ id: "in_2", billing_reason: "subscription_cycle",
      lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: next }] } }), NOW / 1000 + 6));
    await env.DB.prepare("UPDATE billing_subscriptions SET flux_plan_dirty=1,updated_at=? WHERE home_id='home-1'").bind(NOW).run();
    for (let i = 0; i < 50; i++) {
      const h = `h-${String(i).padStart(2, "0")}`;
      await env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,flux_plan_dirty,created_at,updated_at)
        VALUES (?,?,?,'starter','active',1,0,0)`).bind(h, `cus_${h}`, `sub_${h}`).run();
    }
    fluxLog = [];
    await sweepBilling(baseEnv(), deps()).catch(() => undefined);
    await sweepBilling(baseEnv(), deps()).catch(() => undefined);
    expect(fluxLog.filter((x) => x.hook === "plan")).toEqual([{ hook: "plan", args: { homeId: "home-1", plan: "starter", billingCustomerId: "cus_test1" } }]);
    expect(await dirtyOf()).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM billing_subscriptions WHERE flux_plan_attempt_at IS NOT NULL AND home_id LIKE 'h-%'").first()).toEqual({ n: 50 });
  });
});

describe("lane C design 3: stored-event retries (earliest due first, claim, time budget, 5-minute cap, one stuck alert per event)", () => {
  const MIN = 60_000;
  // The mail provider is down for the order confirmation only (every other notice goes out).
  const confirmationDown: BillingNotifier = { async notify(e, n, lease) {
    if (n.kind === "confirmation") throw new Error("mail_provider_down");
    await notifier.notify(e, n, lease);
  } };
  const mailDown = (): BillingDependencies => ({ ...deps(), notifier: confirmationDown });
  /** A (re)delivery by Stripe, signed at the current (mocked) time. */
  async function deliver(event: { id: string }, d: BillingDependencies = deps()) {
    const raw = JSON.stringify(event);
    return send("/v1/billing/webhook", { raw, headers: { "stripe-signature": await signStripePayload(raw, WHSEC, Math.floor(Date.now() / 1000)) } }, d);
  }
  const at = (t: number) => vi.mocked(Date.now).mockReturnValue(t);
  const runEvent = (id: string, d: BillingDependencies = deps(), e: Env = baseEnv()) => processStoredEvent(e, billingConfig(e)!, d, id).catch(() => undefined);
  /** One sweep run at `t`. Only the sweep's own "some work failed this run" is expected (the failing events of the scenario); anything
   *  else fails the test. */
  async function sweepAt(t: number, d: BillingDependencies = deps(), e: Env = baseEnv()) {
    at(t);
    await sweepBilling(e, d).catch((err: unknown) => { if (!(err instanceof Error && err.message === "billing_sweep_incomplete")) throw err; });
  }
  type EvRow = { attempts: number; next_attempt_at: number | null; processed_at: number | null; error: string | null };
  const evRow = (id: string) => env.DB.prepare("SELECT attempts,next_attempt_at,processed_at,error FROM stripe_events WHERE id=?").bind(id).first<EvRow>().then((r) => r!);
  type AlertRow = { id: string; home_id: string; severity: string; detail: string; raised_at: number; resolved_at: number | null; delivered_at: number | null; delivery_attempts: number };
  const stuckAlerts = () => env.DB.prepare("SELECT * FROM cloud_alerts WHERE kind='billing.webhook_stuck' ORDER BY raised_at,id").all<AlertRow>().then((r) => r.results);
  const eventStuck = () => env.DB.prepare("SELECT * FROM cloud_alerts WHERE kind='billing.event_stuck'").all<AlertRow>().then((r) => r.results);
  const detail = (a: { detail: string }) => JSON.parse(a.detail) as Record<string, unknown>;
  const inboxRows = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_payment_inbox").first<{ n: number }>())!.n;
  async function checkoutEvent(paymentStatus = "paid", type = "checkout.session.completed") {
    return stripeEvent(type, await boundSession({ object: "checkout.session", consent: { terms_of_service: "accepted" }, customer_details: { address: { country: "US" } }, id: "cs_test_1", mode: "subscription",
      payment_status: paymentStatus, customer: "cus_test1", subscription: "sub_test1", invoice: "in_1", client_reference_id: "home-1",
      metadata: { home_id: "home-1", plan: "starter", consent_id: await latestConsentId("home-1") } }, {}, retrievable));
  }
  /** A checkout rendered in another API version: its session is retrieved from Stripe before any lease. A payment-mode session touches no
   *  home (ignored_mode, an outcome of the event itself); until it is retrievable the event fails before any lease. */
  const oldVersionCheckout = (sessionId: string) => ({ ...stripeEvent("checkout.session.completed", { object: "checkout.session", id: sessionId, mode: "payment" }), api_version: "2020-08-27" });
  const sessionRetrievable = (sessionId: string) => { retrievable[`/v1/checkout/sessions/${sessionId}`] = { object: "checkout.session", id: sessionId, mode: "payment" }; };
  /** A payment for a customer no home has: it fails (home_unresolved) on every attempt. */
  const ghostInvoice = (key: string) => stripeEvent("invoice.paid", invoice({ id: `in_${key}`, customer: `cus_${key}`, subscription: `sub_${key}` }));
  async function insertEvents(rows: { ev: { id: string; type: string }; receivedAt: number; attempts: number; next: number | null; error?: string }[]) {
    for (let i = 0; i < rows.length; i += 50) {
      await env.DB.batch(rows.slice(i, i + 50).map((r) => env.DB.prepare("INSERT INTO stripe_events (id,type,payload,received_at,attempts,error,next_attempt_at) VALUES (?,?,?,?,?,?,?)")
        .bind(r.ev.id, r.ev.type, JSON.stringify(r.ev), r.receivedAt, r.attempts, r.error ?? (r.attempts ? "home_unresolved" : null), r.next)));
    }
  }
  /** Every D1 batch as the SQL of its statements (a statement's text is remembered through bind). */
  function captureBatches() {
    const sqlOf = new WeakMap<object, string>();
    const prepare = env.DB.prepare.bind(env.DB);
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      const st = prepare(sql);
      const bind = st.bind.bind(st);
      st.bind = (...values: unknown[]) => { const b = bind(...values); sqlOf.set(b, sql); return b; };
      sqlOf.set(st, sql);
      return st;
    });
    const batches: { sql: string[]; changes: number[] }[] = [];
    vi.spyOn(env.DB, "batch").mockImplementation(async (stmts: D1PreparedStatement[]) => {
      const res = await batch(stmts);
      batches.push({ sql: stmts.map((s) => (sqlOf.get(s) ?? "?").replace(/\s+/g, " ")), changes: res.map((r) => r.meta.changes) });
      return res;
    });
    return batches;
  }
  /** A batch that marks an event processed AND resolves its stuck alert (one transaction). */
  const resolving = (b: { sql: string[] }) => b.sql.some((s) => s.startsWith("UPDATE stripe_events SET processed_at="))
    && b.sql.some((s) => s.startsWith("UPDATE cloud_alerts SET resolved_at=? WHERE id=?"));

  it("A3: a customer-waiting event is retried at most 5 minutes apart on EVERY attempt (11, 12, 13 too); other types keep noticeBackoff and alert at 8 in the failure's batch", async () => {
    for (const t of ["checkout.session.completed", "checkout.session.async_payment_succeeded", "invoice.paid"]) {
      expect([1, 2, 3, 4, 11, 12, 13, 40].map((a) => backoffFor(t, a))).toEqual([2 * MIN, 4 * MIN, 5 * MIN, 5 * MIN, 5 * MIN, 5 * MIN, 5 * MIN, 5 * MIN]);
    }
    for (const a of [1, 2, 3, 4, 10, 20]) expect(backoffFor("customer.subscription.deleted", a)).toBe(noticeBackoff(a));
    // Real failures, the gap computed in SQL from the committed count: attempts 11, 12 and 13 of a payment nobody can resolve yet.
    const ghost = ghostInvoice("g11");
    await insertEvents([{ ev: ghost, receivedAt: NOW - DAY, attempts: 10, next: NOW }]);
    for (const n of [11, 12, 13]) {
      at(NOW + (n - 11) * 5 * MIN);
      await runEvent(ghost.id);
      expect(await evRow(ghost.id)).toMatchObject({ attempts: n, processed_at: null, error: "home_unresolved", next_attempt_at: Date.now() + 5 * MIN });
    }
    const [alert] = await stuckAlerts();
    // The incident as raised (at attempt 11 here); the live attempts are the event's own row (13).
    expect(detail(alert)).toEqual({ eventId: ghost.id, type: "invoice.paid", homeId: null, retryRule: "retried at most 5 minutes apart until it completes; never given up",
      generation: 1, attemptsAtRaise: 11, errorAtRaise: "home_unresolved" });
    expect(await eventStuck()).toEqual([]); // a customer-waiting event has only its own alert (A7)
    // Another type: noticeBackoff, and billing.event_stuck from the eighth failure, written with the failure (pending-guarded).
    const deleted = stripeEvent("customer.subscription.deleted", sub({ id: "sub_g7", customer: "cus_g7", status: "canceled" }));
    await insertEvents([{ ev: deleted, receivedAt: NOW - DAY, attempts: 6, next: NOW }]);
    await runEvent(deleted.id);
    expect(await evRow(deleted.id)).toMatchObject({ attempts: 7, next_attempt_at: Date.now() + noticeBackoff(7) });
    expect(await eventStuck()).toEqual([]);
    await runEvent(deleted.id);
    expect(await evRow(deleted.id)).toMatchObject({ attempts: 8, next_attempt_at: Date.now() + noticeBackoff(8) });
    const stuck = await eventStuck();
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ home_id: "billing", resolved_at: null });
    expect(detail(stuck[0])).toEqual({ eventId: deleted.id, type: "customer.subscription.deleted", error: "home_unresolved", attempts: 8 });
    expect(await stuckAlerts()).toHaveLength(1); // none for the non-waiting type
  });

  it("A3: eligibility is the gap, latency is at most gap + the cron period; a Stripe redelivery is one more attempt outside the schedule", async () => {
    const ghost = ghostInvoice("cron");
    at(NOW + 1000); // fails inline at 00:00:01
    expect((await deliver(ghost)).status).toBe(500);
    expect(await evRow(ghost.id)).toMatchObject({ attempts: 1, next_attempt_at: NOW + 1000 + 2 * MIN });
    // Cron ticks every 5 minutes on the boundary. Each tick serves what is due; nothing waits more than gap + one period.
    await sweepAt(NOW + 5 * MIN);
    expect(await evRow(ghost.id)).toMatchObject({ attempts: 2, next_attempt_at: NOW + 5 * MIN + 4 * MIN });
    await sweepAt(NOW + 10 * MIN);
    expect(await evRow(ghost.id)).toMatchObject({ attempts: 3, next_attempt_at: NOW + 15 * MIN });
    at(NOW + 11 * MIN);
    expect((await deliver(ghost)).status).toBe(500); // Stripe redelivers: counted, and it re-dues the event
    expect(await evRow(ghost.id)).toMatchObject({ attempts: 4, next_attempt_at: NOW + 16 * MIN });
    await sweepAt(NOW + 15 * MIN); // not yet eligible (00:16)
    expect(await evRow(ghost.id)).toMatchObject({ attempts: 4, next_attempt_at: NOW + 16 * MIN });
    await sweepAt(NOW + 20 * MIN); // the next tick: 4 minutes after eligibility, within gap + period of the last failure
    expect(await evRow(ghost.id)).toMatchObject({ attempts: 5, next_attempt_at: NOW + 25 * MIN });
  });

  it("§1 Astra-1: 100 older failing events (batch 50, retried every 5 min) take two cron runs; the newer recoverable payment is served in the third", async () => {
    expect(SWEEP_EVENT_BATCH).toBe(50);
    expect((await reserveAndCheckout()).status).toBe(200);
    const ev = await checkoutEvent();
    expect((await deliver(ev, mailDown())).status).toBe(500);
    expect(await evRow(ev.id)).toMatchObject({ attempts: 1, next_attempt_at: NOW + 2 * MIN });
    // 100 older payments failing for good, already on the 5-minute gap: received earlier and due earlier than the payment.
    const ghosts = Array.from({ length: 100 }, (_, i) => ghostInvoice(`old${i}`));
    await insertEvents(ghosts.map((g, i) => ({ ev: g, receivedAt: NOW - DAY + i, attempts: 3, next: NOW - 10 * MIN + i })));
    const triedGhosts = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM stripe_events WHERE type='invoice.paid' AND attempts>=4").first<{ n: number }>())!.n;
    // The mail provider is back. Cron runs 5 minutes apart: each re-dues the 50 it tried 5 minutes later, behind everything already waiting.
    await sweepAt(NOW + 2 * MIN);
    expect(await triedGhosts()).toBe(50);
    expect(await evRow(ev.id)).toMatchObject({ attempts: 1, processed_at: null });
    await sweepAt(NOW + 7 * MIN); // the first 50 are due again, but the other 50 and the payment were due earlier
    expect(await triedGhosts()).toBe(100);
    expect(await evRow(ev.id)).toMatchObject({ attempts: 1, processed_at: null });
    await sweepAt(NOW + 12 * MIN); // every ghost is due again; the payment, due since NOW+2 min, is first
    expect((await evRow(ev.id)).processed_at).toBe(NOW + 12 * MIN);
    expect(notices.filter((n) => n.kind === "confirmation")).toHaveLength(1);
  });

  it("§1 Astra-2 (reversed): 64 fresh one-attempt failers every run never starve an old overdue event with many attempts", async () => {
    expect((await reserveAndCheckout()).status).toBe(200);
    const a = await checkoutEvent();
    expect((await deliver(a, mailDown())).status).toBe(500);
    await env.DB.prepare("UPDATE stripe_events SET attempts=11 WHERE id=?").bind(a.id).run(); // A has failed 11 times; due NOW+2 min
    const fresh = async (run: number, tag: string) => {
      const evs = Array.from({ length: 64 }, (_, i) => ghostInvoice(`${tag}${i}`));
      // Each failed inline at receipt, 3 minutes before the run: due one minute before the run, after A.
      await insertEvents(evs.map((g, i) => ({ ev: g, receivedAt: run - 3 * MIN + i, attempts: 1, next: run - MIN + i })));
      return evs;
    };
    const run1 = NOW + 10 * MIN;
    const first = await fresh(run1, "f1_");
    await sweepAt(run1); // the mail provider is back
    expect((await evRow(a.id)).processed_at).toBe(run1);
    expect(notices.filter((n) => n.kind === "confirmation")).toHaveLength(1);
    // The 14 fresh events of run 1 not reached are first in run 2, ahead of run 2's own 64.
    const run2 = run1 + 5 * MIN;
    const second = await fresh(run2, "f2_");
    const attemptsOf = async (evs: { id: string }[]) => Promise.all(evs.map(async (e) => (await evRow(e.id)).attempts));
    expect((await attemptsOf(first)).filter((n) => n === 1)).toHaveLength(15); // 49 served after A in run 1
    await sweepAt(run2);
    expect((await attemptsOf(first)).every((n) => n >= 2)).toBe(true);
    expect((await attemptsOf(second)).filter((n) => n >= 2).length).toBeLessThan(64);
  });

  it("A1 + fencing: repeated LeaseLost (the D1 lease expired and taken over) records nothing; the claim rotates the event behind the others", async () => {
    expect((await reserveAndCheckout()).status).toBe(200);
    const e = await checkoutEvent();
    expect((await deliver(e, mailDown())).status).toBe(500);
    expect(await evRow(e.id)).toMatchObject({ attempts: 1, next_attempt_at: NOW + 2 * MIN, error: "mail_provider_down" });
    const f = ghostInvoice("rotF");
    const g = ghostInvoice("rotG");
    await insertEvents([{ ev: f, receivedAt: NOW, attempts: 1, next: NOW + 3 * MIN }, { ev: g, receivedAt: NOW, attempts: 1, next: NOW + 6 * MIN }]);
    const steal = async () => {
      await env.DB.prepare("UPDATE billing_home_leases SET lease_until=0 WHERE home_id='home-1'").run(); // expiry, on the database's clock
      expect(await acquireHomeLease(env, "home-1", "thief")).not.toBeNull();
    };
    const release = () => env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    // 1. The confirmation fails AFTER the lease was taken over: the failure record is fenced and writes nothing.
    const failAfterSteal: BillingNotifier = { async notify(env2, n, lease) {
      if (n.kind === "confirmation") { await steal(); throw new Error("mail_provider_down_again"); }
      await notifier.notify(env2, n, lease);
    } };
    await sweepAt(NOW + 4 * MIN, { ...deps(), notifier: failAfterSteal });
    expect(await evRow(e.id)).toMatchObject({ attempts: 1, error: "mail_provider_down", processed_at: null, next_attempt_at: NOW + 4 * MIN + EVENT_CLAIM_MS });
    expect(await evRow(f.id)).toMatchObject({ attempts: 2 }); // served after it in the same run
    await release();
    // 2. Not due again until the claim passes: G (due before it) is served, E is not.
    await sweepAt(NOW + 7 * MIN);
    expect(await evRow(g.id)).toMatchObject({ attempts: 2 });
    expect(await evRow(e.id)).toMatchObject({ attempts: 1, next_attempt_at: NOW + 4 * MIN + EVENT_CLAIM_MS });
    // 3. The confirmation goes out, then the lease is lost before the checkpoint: the stale holder's completion writes nothing.
    const stealAfterSend: BillingNotifier = { async notify(env2, n, lease) {
      await notifier.notify(env2, n, lease);
      if (n.kind === "confirmation") await steal();
    } };
    await sweepAt(NOW + 4 * MIN + EVENT_CLAIM_MS, { ...deps(), notifier: stealAfterSend });
    expect(await evRow(e.id)).toMatchObject({ attempts: 1, processed_at: null, next_attempt_at: NOW + 4 * MIN + 2 * EVENT_CLAIM_MS });
    expect(await inboxRows()).toBe(0);
    await release();
    // 4. A plain run after the claim: completed exactly once.
    await sweepAt(NOW + 4 * MIN + 2 * EVENT_CLAIM_MS);
    expect(await evRow(e.id)).toMatchObject({ processed_at: NOW + 4 * MIN + 2 * EVENT_CLAIM_MS, next_attempt_at: null });
    expect(await inboxRows()).toBe(1);
  });

  /** The step cap used by the frozen-clock timing test: one REAL second. */
  const STEP_MS = 1000;
  /** How fast the measured run clock runs. */
  const RATE = 60;
  /** A measured run clock (never jumped): `t0` plus RATE times the real time elapsed. The sweep is told (clockRate: RATE), so its step
   *  timers wait cap / RATE real milliseconds: the loop budgets, the PRODUCTION cap (EVENT_MAX_MS) and the clock are in
   *  one time scale, and a run permits exactly the hung steps production permits (Astra MAILRETRY-4: the old test cut at one real second
   *  while reserving one logical second, so it allowed two hung starts where production allows one). */
  const runClock = (t0: number) => {
    const p0 = performance.now();
    vi.mocked(Date.now).mockImplementation(() => t0 + Math.floor((performance.now() - p0) * RATE));
  };
  const noNetwork = (async () => { throw new Error("no_network"); }) as unknown as typeof fetch;
  /** One scheduled invocation (the whole cron chain) at `t0`, on the measured clock. The context records what the invocation registers
   *  with ctx.waitUntil: the cron chain first, then whatever the chain registers (every continuation of a sweep step cut at its cap; the
   *  self-service sweep's background work). Only the chain is waited for: the runtime keeps the rest alive on its own. Returns the rest. */
  async function scheduledRun(t0: number, d: BillingDependencies, e: Env = baseEnv()) {
    runClock(t0);
    const registered: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { registered.push(p); }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    createWorker(noNetwork, noNetwork, { provider }, {}, d).scheduled({ scheduledTime: t0, cron: "*/5 * * * *", noRetry() {} }, e, ctx);
    await registered[0];
    return registered.slice(1);
  }
  /** One billing sweep run on the measured clock (production budgets and caps; only the run's own "some work failed" is expected). */
  async function measuredSweep(t0: number, d: BillingDependencies) {
    runClock(t0);
    await sweepBilling(baseEnv(), { ...d, clockRate: RATE }).catch((err: unknown) => { if (!(err instanceof Error && err.message === "billing_sweep_incomplete")) throw err; });
  }
  /** A later sweep's effect to look for: public-token retention deletes a long-expired rate-limit window. */
  const expiredWindow = (bucket: string) => env.DB.prepare("INSERT INTO public_mail_limits (bucket,window_start,count) VALUES (?,?,1)").bind(bucket, NOW - 400 * DAY).run();
  const windowLeft = async (bucket: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM public_mail_limits WHERE bucket=?").bind(bucket).first<{ n: number }>())!.n;
  /** The home's billing lease expires (two minutes of DATABASE time in production). */
  const leaseExpires = () => env.DB.prepare("UPDATE billing_home_leases SET lease_until=0 WHERE home_id='home-1'").run();
  const logged = (spy: { mock: { calls: unknown[][] } }, text: string) => spy.mock.calls.filter(([m]) => String(m).includes(text)).length;

  it("A2: on the 60x clock at PRODUCTION caps, a hung dependency costs the event loop exactly one attempt; the later stages and sweeps run; the cut step is registered and the next runs serve the rest", async () => {
    let releaseHung!: () => void;
    const hung = new Promise<void>((r) => { releaseHung = r; });
    const hungFetch: typeof stripeFetch = async (input, init) => {
      if (String(input).includes("/v1/checkout/sessions/cs_hung")) await hung;
      return stripeFetch(input, init);
    };
    const h = [1, 2, 3].map((i) => oldVersionCheckout(`cs_hung${i}`));
    const later = ghostInvoice("afterHung");
    await insertEvents([...h.map((ev, i) => ({ ev, receivedAt: NOW - DAY + i, attempts: 0, next: null })),
      { ev: later, receivedAt: NOW, attempts: 1, next: NOW - MIN }]);
    await expiredWindow("lanec-a2-1");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registered = await scheduledRun(NOW, { ...deps(), stripeFetch: hungFetch, clockRate: RATE });
    // The event loop's budget (SWEEP_LOOP_BUDGET_MS, 120 s) at the production cap (EVENT_MAX_MS, 60 s): the first attempt hangs and is
    // cut a minute in; a second could end past the budget, so it is never claimed. Production permits exactly this one hung start.
    expect(SWEEP_LOOP_BUDGET_MS).toBeLessThan(2 * EVENT_MAX_MS + 1);
    expect(await evRow(h[0].id)).toMatchObject({ attempts: 0, processed_at: null });
    expect((await evRow(h[0].id)).next_attempt_at! - EVENT_CLAIM_MS).toBeLessThan(NOW + 30_000);
    for (const ev of [h[1], h[2]]) expect(await evRow(ev.id)).toMatchObject({ attempts: 0, next_attempt_at: null });
    expect(await evRow(later.id)).toMatchObject({ attempts: 1, next_attempt_at: NOW - MIN });
    // The timeout is a failure of this run, reported (not swallowed); every later sweep of the same run still ran; the cut attempt goes
    // on as a continuation registered with the invocation (Astra MAILRETRY-4 P2).
    expect(logged(errors, "customer-waiting sweep failed")).toBe(1); // its own step, first in the invocation (Astra MAILRETRY-7 P1)
    expect(await windowLeft("lanec-a2-1")).toBe(0);
    expect(registered.length).toBeGreaterThanOrEqual(1);
    // The hung retrieval answers late: its attempt records what an ordinary attempt would (before any lease, pending-guarded), and every
    // registered continuation ends.
    releaseHung();
    await Promise.all(registered);
    expect((await evRow(h[0].id)).attempts).toBe(1);
    // Due order for the NEXT run: the two never reached (due since receipt), the older failer, then the late failure (its backoff).
    const due = await env.DB.prepare(`SELECT id FROM stripe_events WHERE processed_at IS NULL AND COALESCE(next_attempt_at,received_at)<=?
      ORDER BY COALESCE(next_attempt_at,received_at),received_at LIMIT 4`).bind(NOW + 5 * MIN).all<{ id: string }>();
    expect(due.results.map((r) => r.id)).toEqual([h[1].id, h[2].id, later.id, h[0].id]);
    // The NEXT run, 5 minutes later, with Stripe answering: every due event is served and its effects are there; the chain runs again.
    for (const ev of h) sessionRetrievable(ev.data.object.id as string);
    await expiredWindow("lanec-a2-2");
    await scheduledRun(NOW + 5 * MIN, { ...deps(), clockRate: RATE });
    for (const ev of h) expect(await evRow(ev.id)).toMatchObject({ processed_at: expect.any(Number), error: "ignored_mode" });
    expect(await evRow(later.id)).toMatchObject({ attempts: 2, processed_at: null }); // still no home: retried, re-dued
    expect(await windowLeft("lanec-a2-2")).toBe(0);
  });

  it("P1: a hung sender is bounded on the notice-retry path too (Astra MAILRETRY-3): the cron chain goes on, the loop writes nothing, the NEXT run recovers once", async () => {
    expect((await reserveAndCheckout()).status).toBe(200);
    const ev = await checkoutEvent();
    await insertEvents([{ ev, receivedAt: NOW, attempts: 0, next: null }]);
    const sent: string[] = [];
    const hungSends: (() => void)[] = [];
    let mailHangs = true;
    const mailEnv = { ...baseEnv(), EMAIL: { send: async (m: { subject: string }) => {
      if (mailHangs) await new Promise<void>((_, reject) => { hungSends.push(() => reject(new Error("mail_provider_down"))); });
      sent.push(m.subject);
    } } } as unknown as Env;
    const real: BillingDependencies = { ...deps(), notifier: defaultNotifier, clockRate: RATE };
    const confirmation = () => env.DB.prepare("SELECT sent_at,attempts,next_attempt_at FROM billing_notices WHERE kind='confirmation'")
      .first<{ sent_at: number | null; attempts: number; next_attempt_at: number | null }>();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Run 1: the event's attempt hangs in the order confirmation's send. Cut at the cap; the event keeps its claim; the chain goes on.
    await expiredWindow("lanec-p1-1");
    await scheduledRun(NOW, real, mailEnv);
    expect(hungSends).toHaveLength(1);
    expect(await evRow(ev.id)).toMatchObject({ attempts: 0, processed_at: null });
    const claimedUntil = (await evRow(ev.id)).next_attempt_at!;
    expect(claimedUntil).toBeGreaterThanOrEqual(NOW + EVENT_CLAIM_MS);
    expect(await confirmation()).toMatchObject({ sent_at: null, attempts: 1, next_attempt_at: null });
    expect(await windowLeft("lanec-p1-1")).toBe(0);
    expect(logged(errors, "customer-waiting sweep failed")).toBe(1); // its own step, first in the invocation (Astra MAILRETRY-7 P1)
    // Run 2, four minutes on (Astra's case): the home's lease and the notice's 2-minute claim have expired, the event's claim has not.
    // The event is not due; the notice retry reaches the SAME hung sender: cut at the cap as well. The loop writes nothing after the cut
    // (no backoff, no failure count; only the notifier's own claim counted the try), and its claim, written BEFORE the handoff (Astra
    // MAILRETRY-4 P1), keeps the notice behind every other due notice until the run after next. The later sweeps still run.
    await leaseExpires();
    await expiredWindow("lanec-p1-2");
    await scheduledRun(NOW + 4 * MIN, real, mailEnv);
    expect(hungSends).toHaveLength(2);
    expect(await evRow(ev.id)).toMatchObject({ attempts: 0, processed_at: null, next_attempt_at: claimedUntil });
    expect(await confirmation()).toMatchObject({ sent_at: null, attempts: 2 });
    const noticeClaim = (await confirmation())!.next_attempt_at!;
    expect(noticeClaim).toBeGreaterThanOrEqual(NOW + 4 * MIN + NOTICE_RETRY_CLAIM_MS);
    expect(noticeClaim).toBeLessThan(NOW + 4 * MIN + NOTICE_RETRY_CLAIM_MS + 2 * MIN);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind IN ('notice.undelivered','notice.dead')").first()).toEqual({ n: 0 });
    expect(await windowLeft("lanec-p1-2")).toBe(0);
    expect(logged(errors, "customer-waiting sweep failed")).toBe(2);
    // Both hung sends fail late, after their lease expired: everything they still try to write is fenced out.
    await leaseExpires();
    mailHangs = false;
    for (const fail of hungSends) fail();
    await vi.waitFor(() => expect(logged(errors, "timed-out billing sweep step failed")).toBe(2));
    expect(await evRow(ev.id)).toMatchObject({ attempts: 0, processed_at: null, next_attempt_at: claimedUntil });
    expect(await confirmation()).toMatchObject({ sent_at: null, next_attempt_at: noticeClaim });
    // Run 3, the NEXT cron run: the event is due again and completes once, with one confirmation and one payment entry; the chain runs.
    await expiredWindow("lanec-p1-3");
    await scheduledRun(NOW + 10 * MIN, real, mailEnv);
    const done = await evRow(ev.id);
    expect(done.processed_at).toBeGreaterThanOrEqual(NOW + 10 * MIN);
    expect(done.error).toBeNull();
    expect((await confirmation())!.sent_at).not.toBeNull();
    expect(sent.filter((x) => x === sent[0])).toHaveLength(1);
    expect(await inboxRows()).toBe(1);
    expect(await windowLeft("lanec-p1-3")).toBe(0);
  });

  it("P1: an attempt cut at the cap whose money path completes LATE is fenced out: the next holder completes it once (one payment, one confirmation)", async () => {
    expect((await reserveAndCheckout()).status).toBe(200);
    const ev = await checkoutEvent();
    await insertEvents([{ ev, receivedAt: NOW, attempts: 0, next: null }]);
    let answer!: () => void;
    const late = new Promise<void>((r) => { answer = r; });
    let slowOnce = true;
    // The provider takes the first confirmation but answers only later (as if sent); every other send is normal.
    const slow: BillingNotifier = { async notify(e, n, lease) {
      if (n.kind === "confirmation" && slowOnce) { slowOnce = false; await late; return; }
      await notifier.notify(e, n, lease);
    } };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await sweepAt(NOW, { ...deps(), notifier: slow, eventMaxMs: STEP_MS });
    expect(await evRow(ev.id)).toMatchObject({ attempts: 0, processed_at: null, next_attempt_at: NOW + EVENT_CLAIM_MS });
    expect(await inboxRows()).toBe(0);
    // Its lease expires; the next run, once the claim has passed, completes the event under a new lease.
    await leaseExpires();
    await sweepAt(NOW + EVENT_CLAIM_MS);
    expect(await evRow(ev.id)).toMatchObject({ processed_at: NOW + EVENT_CLAIM_MS, attempts: 0, error: null });
    // The first attempt now carries on from its send: its next fenced write finds the lease gone (LeaseLost) and it writes nothing.
    answer();
    await vi.waitFor(() => expect(errors.mock.calls.some(([m]) => String(m).includes(`event:${ev.id}`) && String(m).includes("lease_lost"))).toBe(true));
    expect(await evRow(ev.id)).toMatchObject({ processed_at: NOW + EVENT_CLAIM_MS, attempts: 0, error: null });
    expect(await inboxRows()).toBe(1);
    expect(notices.filter((n) => n.kind === "confirmation")).toHaveLength(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM checkout_consents WHERE confirmation_sent_at=?").bind(NOW + EVENT_CLAIM_MS).first()).toEqual({ n: 1 });
  });

  it("Astra MAILRETRY-12: the event claim's own write delayed past the attempt cap is cut like any attempt: the loop keeps its budget, and the late claim then runs the event once", async () => {
    const first = ghostInvoice("claimSlow1");
    const second = ghostInvoice("claimSlow2");
    await insertEvents([{ ev: first, receivedAt: NOW - 2, attempts: 0, next: null }, { ev: second, receivedAt: NOW - 1, attempts: 0, next: null }]);
    let releaseClaim!: () => void;
    const held = new Promise<void>((r) => { releaseClaim = r; });
    let claims = 0;
    const prepare = env.DB.prepare.bind(env.DB);
    // The FIRST claim write (scheduling metadata, the attempt's first statement) does not answer until released.
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      const st = prepare(sql);
      if (!sql.startsWith("UPDATE stripe_events SET next_attempt_at=? WHERE id=? AND processed_at IS NULL")) return st;
      const bind = st.bind.bind(st);
      st.bind = (...values: unknown[]) => {
        const b = bind(...values);
        const run = b.run.bind(b);
        (b as unknown as { run: () => Promise<unknown> }).run = async () => { if (claims++ === 0) await held; return run(); };
        return b;
      };
      return st;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // On the 60x clock at production caps: the hung claim is cut at EVENT_MAX_MS; a second attempt could end past the loop's budget, so it
    // is never started. The sweep returns while the claim is still held (a claim outside the cap would hang the whole run here).
    await measuredSweep(NOW, deps());
    expect(claims).toBe(1);
    expect(await evRow(first.id)).toMatchObject({ attempts: 0, processed_at: null, next_attempt_at: null });
    expect(await evRow(second.id)).toMatchObject({ attempts: 0, processed_at: null, next_attempt_at: null });
    // The claim answers late: the cut continuation claims and runs the event exactly once (its failure recorded as an ordinary attempt's).
    releaseClaim();
    await vi.waitFor(async () => expect((await evRow(first.id)).attempts).toBe(1));
    expect(await evRow(first.id)).toMatchObject({ attempts: 1, processed_at: null, error: "home_unresolved" });
    expect(claims).toBe(1);
    expect(await evRow(second.id)).toMatchObject({ attempts: 0, next_attempt_at: null });
  });

  describe("Astra MAILRETRY-4: the notice loop claims before every attempt; cut continuations are registered", () => {
    /** A notice row as the sweep retries it (home-1, due at `due`). */
    const addNotice = (id: string, due: number) => env.DB.prepare("INSERT INTO billing_notices (id,home_id,kind,payload,created_at,next_attempt_at) VALUES (?,?,?,?,?,?)")
      .bind(id, "home-1", "suspended", "{}", due, due).run();
    const noticeRow = (id: string) => env.DB.prepare("SELECT sent_at,attempts,next_attempt_at FROM billing_notices WHERE id=?").bind(id)
      .first<{ sent_at: number | null; attempts: number; next_attempt_at: number | null }>().then((r) => r!);

    it("the bounds: the default run deadline is the scheduled one; the event claim is 5 minutes; the notice claim outlasts a cron period plus an attempt", () => {
      expect(SWEEP_RUN_MS).toBe(SCHEDULED_SWEEP_DEADLINE_MS);
      expect(SWEEP_LOOP_BUDGET_MS).toBeLessThan(2 * EVENT_MAX_MS + 1);
      expect(EVENT_CLAIM_MS).toBe(5 * MIN);
      expect(NOTICE_RETRY_CLAIM_MS).toBeGreaterThanOrEqual(SWEEP_PERIOD_MS + EVENT_MAX_MS);
    });

    it("P1: a permanently hung notice ahead of healthy ones costs one step; the healthy ones go out the NEXT run; the hung one rotates behind a later notice", async () => {
      expect((await reserveAndCheckout()).status).toBe(200);
      await addNotice("n-poison", NOW - DAY);
      await addNotice("n-ok-1", NOW - DAY + 1);
      await addNotice("n-ok-2", NOW - DAY + 2);
      const delivered: string[] = [];
      let poisonTries = 0;
      const poisoned: BillingNotifier = { async notify(e, n, lease) {
        if (n.id === "n-poison") { poisonTries++; return new Promise<void>(() => undefined); } // never answers
        if (n.id.startsWith("n-ok")) { delivered.push(n.id); await e.DB.prepare("UPDATE billing_notices SET sent_at=? WHERE id=?").bind(Date.now(), n.id).run(); return; }
        await notifier.notify(e, n, lease);
      } };
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const d = { ...deps(), notifier: poisoned };
      // Run 1: the poisoned notice is first (earliest due), is claimed BEFORE the handoff, hangs, and is cut at the cap (60 s of the loop's
      // 120 s budget): no further notice fits this run.
      await measuredSweep(NOW, d);
      expect(poisonTries).toBe(1);
      expect(delivered).toEqual([]);
      const claim1 = (await noticeRow("n-poison")).next_attempt_at!;
      expect(claim1).toBeGreaterThanOrEqual(NOW + NOTICE_RETRY_CLAIM_MS);
      expect(await noticeRow("n-poison")).toMatchObject({ sent_at: null, attempts: 0 });
      // Run 2 (its lease long expired): the poisoned notice is not due (its claim outlasts the cron period); the healthy ones go out.
      await leaseExpires();
      await measuredSweep(NOW + 5 * MIN, d);
      expect(delivered).toEqual(["n-ok-1", "n-ok-2"]);
      expect(poisonTries).toBe(1);
      // A later notice is queued, due after the poisoned one's claim ended. Run 3: the poisoned one is due again (first), takes its one
      // step and is claimed again; the later notice waits one run. Run 4: the poisoned one is behind it, and the later one goes out.
      await addNotice("n-ok-3", claim1 + 1);
      await leaseExpires();
      await measuredSweep(NOW + 10 * MIN, d);
      expect(poisonTries).toBe(2);
      expect((await noticeRow("n-poison")).next_attempt_at).toBeGreaterThanOrEqual(NOW + 10 * MIN + NOTICE_RETRY_CLAIM_MS);
      await leaseExpires();
      await measuredSweep(NOW + 15 * MIN, d);
      expect(delivered).toEqual(["n-ok-1", "n-ok-2", "n-ok-3"]);
      expect(poisonTries).toBe(2);
      expect(await noticeRow("n-poison")).toMatchObject({ sent_at: null, attempts: 0 });
    });

    it("P2: a cut step's continuation is registered with the invocation (waitUntil) and its item is not processed again by the next run", async () => {
      expect((await reserveAndCheckout()).status).toBe(200);
      await addNotice("n-slow", NOW - DAY);
      let answer!: () => void;
      const slow = new Promise<void>((r) => { answer = r; });
      const calls: string[] = [];
      const slowNotifier: BillingNotifier = { async notify(e, n, lease) {
        if (n.id === "n-slow") { calls.push(n.id); await slow; return; }
        await notifier.notify(e, n, lease);
      } };
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const registered: Promise<unknown>[] = [];
      const waitUntil = vi.fn((p: Promise<unknown>) => { registered.push(p); });
      await measuredSweep(NOW, { ...deps(), notifier: slowNotifier, waitUntil });
      // Cut at its cap: the continuation was handed to waitUntil and is still running (pending until the send answers).
      expect(calls).toEqual(["n-slow"]);
      expect(waitUntil).toHaveBeenCalled();
      const states = registered.map((p) => { const st = { done: false }; void p.then(() => { st.done = true; }); return st; });
      await new Promise((r) => setTimeout(r, 50));
      expect(states.some((st) => !st.done)).toBe(true);
      // The next run, while it is still running (its lease expired): the notice is claimed by the cut run, so it is not handed off again.
      await leaseExpires();
      await measuredSweep(NOW + 5 * MIN, { ...deps(), notifier: slowNotifier, waitUntil });
      expect(calls).toEqual(["n-slow"]);
      // It ends: every registered continuation settles.
      answer();
      await Promise.all(registered);
      expect(states.every((st) => st.done)).toBe(true);
    });
  });

  describe("Astra MAILRETRY-6: the bounded loops run first on their own budgets; a late notice failure escalates like an in-time one", () => {
    const addNotice = (id: string, due: number, attempts = 0) => env.DB.prepare("INSERT INTO billing_notices (id,home_id,kind,payload,created_at,next_attempt_at,attempts) VALUES (?,?,?,?,?,?,?)")
      .bind(id, "home-1", "suspended", "{}", due, due, attempts).run();
    const noticeRow = (id: string) => env.DB.prepare("SELECT sent_at,attempts,next_attempt_at,dead_at FROM billing_notices WHERE id=?").bind(id)
      .first<{ sent_at: number | null; attempts: number; next_attempt_at: number | null; dead_at: number | null }>().then((r) => r!);
    const alertsFor = (kind: string, noticeId: string) => env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind=? AND detail LIKE ?")
      .bind(kind, `%"noticeId":"${noticeId}"%`).first<{ n: number }>().then((r) => r!.n);
    const incompleteOk = (err: unknown) => { if (!(err instanceof Error && err.message === "billing_sweep_incomplete")) throw err; };

    it("P1: 50 earlier failing cancellation retries of 10 s each cannot starve the notice loop: an immediately deliverable notice goes out in the same run", async () => {
      expect((await reserveAndCheckout()).status).toBe(200);
      for (let i = 0; i < 50; i++) {
        await env.DB.prepare("INSERT INTO rejected_subscriptions (subscription_id,at,reason,home_id,cancel_pending) VALUES (?,?,?,?,1)")
          .bind(`sub_rej${i}`, NOW - DAY + i, "test", "home-1").run();
      }
      await addNotice("n-now", NOW - 1);
      // The run's clock: the measured clock plus 10 s for every cancellation Stripe takes 10 s to refuse (500 s of the run in all).
      let offset = 0;
      const p0 = performance.now();
      vi.mocked(Date.now).mockImplementation(() => NOW + offset + Math.floor((performance.now() - p0) * RATE));
      const refused = new Set<string>();
      const slowCancels: typeof stripeFetch = async (input, init) => {
        const sub = /\/v1\/subscriptions\/(sub_rej\d+)/.exec(String(input))?.[1];
        if (sub) { if (!refused.has(sub)) { refused.add(sub); offset += 10_000; } throw new Error("stripe_down"); }
        return stripeFetch(input, init);
      };
      const delivered: string[] = [];
      const quick: BillingNotifier = { async notify(e, n, lease) {
        if (n.id === "n-now") { delivered.push(n.id); await e.DB.prepare("UPDATE billing_notices SET sent_at=? WHERE id=?").bind(Date.now(), n.id).run(); return; }
        await notifier.notify(e, n, lease);
      } };
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await sweepBilling(baseEnv(), { ...deps(), stripeFetch: slowCancels, notifier: quick, clockRate: RATE, sweepDeadline: NOW + SCHEDULED_SWEEP_DEADLINE_MS }).catch(incompleteOk);
      expect(refused.size).toBe(50);
      expect(offset).toBe(500_000);
      expect(delivered).toEqual(["n-now"]);
      expect((await noticeRow("n-now")).sent_at).not.toBeNull();
    });

    it("P1: slow work before the billing sweep (9.5 minutes of the invocation) does not stop the event loop: a due event is processed", async () => {
      expect((await reserveAndCheckout()).status).toBe(200);
      const ev = await checkoutEvent();
      expect((await deliver(ev, mailDown())).status).toBe(500);
      expect(await evRow(ev.id)).toMatchObject({ attempts: 1, processed_at: null });
      const t = NOW + 10 * MIN;
      // The invocation started 9.5 minutes before the sweep (B3 reconcile and the self-service sweep took that long).
      await sweepAt(t, { ...deps(), sweepDeadline: t - 9.5 * MIN + SCHEDULED_SWEEP_DEADLINE_MS });
      expect(await evRow(ev.id)).toMatchObject({ processed_at: t });
      expect(await inboxRows()).toBe(1);
    });

    it("MAILRETRY-7 P1: B3 reconcile and the self-service sweep use 14.5 minutes of the invocation: due events and notices are still served in that run", async () => {
      expect((await reserveAndCheckout()).status).toBe(200);
      const ev = await checkoutEvent();
      expect((await deliver(ev, mailDown())).status).toBe(500);
      expect(await evRow(ev.id)).toMatchObject({ attempts: 1, processed_at: null });
      const t0 = NOW + 10 * MIN;
      await addNotice("n-waiting", t0 - 1);
      // The invocation's clock: measured (RATE), plus 14.5 minutes the first time B3 reconcile or the self-service sweep reads it (their work).
      let offset = 0;
      const p0 = performance.now();
      vi.mocked(Date.now).mockImplementation(() => {
        if (offset === 0 && /reconcileB3|sweepSelfService/.test(new Error().stack ?? "")) offset = 14.5 * MIN;
        return t0 + offset + Math.floor((performance.now() - p0) * RATE);
      });
      const delivered: string[] = [];
      const quick: BillingNotifier = { async notify(e, n, lease) {
        if (n.id === "n-waiting") { delivered.push(n.id); await e.DB.prepare("UPDATE billing_notices SET sent_at=? WHERE id=?").bind(Date.now(), n.id).run(); return; }
        await notifier.notify(e, n, lease);
      } };
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const registered: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => { registered.push(p); }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
      createWorker(noNetwork, noNetwork, { provider }, {}, { ...deps(), notifier: quick, clockRate: RATE })
        .scheduled({ scheduledTime: t0, cron: "*/5 * * * *", noRetry() {} }, baseEnv(), ctx);
      await registered[0];
      expect(offset).toBe(14.5 * MIN); // the stages before billing ran, and used the time
      expect((await evRow(ev.id)).processed_at).not.toBeNull();
      expect((await evRow(ev.id)).processed_at!).toBeLessThan(t0 + 14.5 * MIN);
      expect(await inboxRows()).toBe(1);
      expect(delivered).toEqual(["n-waiting"]);
      expect((await noticeRow("n-waiting")).sent_at!).toBeLessThan(t0 + 14.5 * MIN);
    });

    /** One run in which the notice's send outlives its 60 s cap and is refused at 80 s, while its lease is still valid. */
    async function lateRefusal(id: string) {
      const late: BillingNotifier = { async notify(e, n, lease) {
        if (n.id === id) { await new Promise((r) => setTimeout(r, 80_000 / RATE)); throw new Error("mail_provider_down"); }
        await notifier.notify(e, n, lease);
      } };
      const registered: Promise<unknown>[] = [];
      await measuredSweep(NOW, { ...deps(), notifier: late, waitUntil: (p) => { registered.push(p); } });
      // Cut at the cap: nothing recorded yet.
      expect(registered.length).toBeGreaterThan(0);
      await Promise.all(registered);
    }

    it("P2: a late refusal after the timeout goes through the same failure path: backoff, attempts, notice.undelivered at the fifth try", async () => {
      expect((await reserveAndCheckout()).status).toBe(200);
      await addNotice("n-late", NOW - DAY, 4);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await lateRefusal("n-late");
      const row = await noticeRow("n-late");
      expect(row).toMatchObject({ sent_at: null, attempts: 5, dead_at: null });
      expect(row.next_attempt_at).toBeGreaterThanOrEqual(NOW + noticeBackoff(5));
      expect(row.next_attempt_at).toBeLessThan(NOW + NOTICE_RETRY_CLAIM_MS + noticeBackoff(5));
      expect(await alertsFor("notice.undelivered", "n-late")).toBe(1);
      expect(await alertsFor("notice.dead", "n-late")).toBe(0);
    });

    it("P2: a late refusal at the dead-letter threshold is dead-lettered: dead_at, a daily retry and the notice.dead alert", async () => {
      expect((await reserveAndCheckout()).status).toBe(200);
      await addNotice("n-dead", NOW - DAY, NOTICE_DEAD_LIMIT - 1);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await lateRefusal("n-dead");
      const row = await noticeRow("n-dead");
      expect(row).toMatchObject({ sent_at: null, attempts: NOTICE_DEAD_LIMIT });
      expect(row.dead_at).not.toBeNull();
      expect(row.next_attempt_at).toBeGreaterThanOrEqual(NOW + DAY);
      expect(await alertsFor("notice.undelivered", "n-dead")).toBe(1);
      expect(await alertsFor("notice.dead", "n-dead")).toBe(1);
    });

    it("P2: a late success after the timeout records the send normally (no failure, no alert)", async () => {
      expect((await reserveAndCheckout()).status).toBe(200);
      await addNotice("n-slow-ok", NOW - DAY, 4);
      const slowOk: BillingNotifier = { async notify(e, n, lease) {
        if (n.id === "n-slow-ok") { await new Promise((r) => setTimeout(r, 80_000 / RATE)); await e.DB.prepare("UPDATE billing_notices SET sent_at=? WHERE id=?").bind(Date.now(), n.id).run(); return; }
        await notifier.notify(e, n, lease);
      } };
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const registered: Promise<unknown>[] = [];
      await measuredSweep(NOW, { ...deps(), notifier: slowOk, waitUntil: (p) => { registered.push(p); } });
      await Promise.all(registered);
      expect(await noticeRow("n-slow-ok")).toMatchObject({ attempts: 4 });
      expect((await noticeRow("n-slow-ok")).sent_at).not.toBeNull();
      expect(await alertsFor("notice.undelivered", "n-slow-ok")).toBe(0);
    });
  });

  describe("Astra MAILRETRY-8: an overdue B3 give-up is not displaced by the customer-waiting loops or by slow homes; the loops run once", () => {
    /** Cloudflare's hard wall for a Cron Trigger invocation. */
    const WALL = SCHEDULED_SWEEP_DEADLINE_MS;
    const EVENT_SELECT = "SELECT id FROM stripe_events WHERE processed_at IS NULL";
    const NOTICE_SELECT = "SELECT n.id,n.home_id,n.kind,n.payload,n.attempts,h.owner_id FROM billing_notices n";
    let start = 0;
    let offset = 0;
    const clock = () => start + offset;
    type Seen = { live: boolean; walled: boolean; events: number; notices: number; failEventSelect: boolean; refunds: { id: string; at: number }[];
      /** Commits of give-up refund obligations and webhook deliveries, in the order they happened. */
      log: string[]; giveUpMs: number;
      /** Astra MAILRETRY-10: every D1 READ (first/all/raw) takes this long, the preamble's and each give-up's own reads included; and when
       *  each overdue-pass SELECT ran (the invocation's clock). */
      readMs: number; passSelects: number[]; pageStarts: number[] };
    let seen: Seen;
    /** env.DB as one invocation sees it: past the wall (WALL of the invocation's clock after its start) every statement and batch is refused,
     *  as when Cloudflare ends the invocation, so nothing after it commits: preparing one, and executing one prepared earlier (run, first,
     *  all, raw on the statement or any bound copy; Astra MAILRETRY-9). `giveUpMs` slows each give-up's D1 batch (a slow D1). Counts the two customer-waiting loops' selects (each loop reads
     *  its due rows exactly once per run) and records when each refund obligation commits (the invocation's clock). */
    beforeEach(() => {
      seen = { live: false, walled: false, events: 0, notices: 0, failEventSelect: false, refunds: [], log: [], giveUpMs: 0, readMs: 0, passSelects: [], pageStarts: [] };
      const meta = new WeakMap<object, { sql: string; values: unknown[] }>();
      const cut = () => { if (seen.live && clock() - start > WALL) { seen.walled = true; throw new Error("invocation_wall"); } };
      const prepare = env.DB.prepare.bind(env.DB);
      const batch = env.DB.batch.bind(env.DB);
      vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
        cut();
        if (seen.live && sql.startsWith(EVENT_SELECT)) { seen.events++; if (seen.failEventSelect) throw new Error("synthetic_event_select_failure"); }
        if (seen.live && sql.startsWith(NOTICE_SELECT)) seen.notices++;
        const walled = (x: D1PreparedStatement) => {
          for (const m of ["run", "first", "all", "raw"] as const) {
            const f = (x[m] as (...a: unknown[]) => unknown).bind(x);
            (x as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => {
              try { cut(); } catch (e) { return Promise.reject(e); }
              if (seen.live && m !== "run") {
                if (sql.includes("AS never_attempted")) seen.passSelects.push(clock());
                if (sql.startsWith("SELECT last_home_id FROM cloud_reconcile_progress")) seen.pageStarts.push(clock());
                offset += seen.readMs;
              }
              return f(...a);
            };
          }
          return x;
        };
        const st = walled(prepare(sql));
        const bind = st.bind.bind(st);
        st.bind = (...values: unknown[]) => { const b = walled(bind(...values)); meta.set(b, { sql, values }); return b; };
        return st;
      });
      vi.spyOn(env.DB, "batch").mockImplementation(async (stmts: D1PreparedStatement[]) => {
        cut();
        const res = await batch(stmts);
        for (const s of stmts) {
          const m = meta.get(s);
          if (m && m.sql.includes("INSERT INTO cloud_outbox") && m.sql.includes("'refund_required'")) {
            seen.refunds.push({ id: String(m.values[0]), at: clock() });
            if (String(m.values[0]).startsWith("refund:provision_failed:")) { seen.log.push(`refund ${m.values[1]}`); offset += seen.giveUpMs; }
          }
        }
        return res;
      });
    });
    /** One scheduled invocation at `t0` on the invocation's clock (moved only by the slow work below). Waits for the cron chain. */
    async function invocation(t0: number, d: BillingDependencies, make: (db: D1Database) => ProviderAdapter = provider, extra: Record<string, string> = {}) {
      start = t0; offset = 0;
      vi.mocked(Date.now).mockImplementation(clock);
      const registered: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => { registered.push(p); }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
      seen.live = true;
      try {
        createWorker(noNetwork, noNetwork, { provider: make }, {}, d).scheduled({ scheduledTime: t0, cron: "*/5 * * * *", noRetry() {} }, { ...baseEnv(), ...extra } as Env, ctx);
        await registered[0];
      } finally { seen.live = false; }
      await Promise.allSettled(registered.slice(1));
    }
    const homeRow = (id: string) => env.DB.prepare("INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,entitlement,payment_version,generation,resource_generation,image_digest,home_key,created_at,updated_at) VALUES (?,?,?,?,?,?,1,1,1,?,'synthetic-home-key',?,?)");
    /** A paid home that booted but never became ready, its budget opened at `firstAt`, with the payment its refund returns. */
    async function checkingHome(id: string, firstAt: number) {
      await env.DB.batch([
        homeRow(id).bind(id, `inst-${id}`, OWNER, "checking", "checking", "paid", IMAGE, NOW, NOW),
        env.DB.prepare("INSERT INTO provision_attempts (home_id,resource_generation,first_at) VALUES (?,1,?)").bind(id, firstAt),
        env.DB.prepare("INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES (?,?,1,?,'payment_paid',?,?)")
          .bind(`payment:${id}`, id, OWNER, JSON.stringify({ eventId: `evt-${id}`, homeId: id, version: 1, status: "paid", paymentId: `in-${id}` }), NOW),
      ]);
    }
    const state = async (id: string) => (await env.DB.prepare("SELECT desired_state FROM cloud_homes WHERE id=?").bind(id).first<{ desired_state: string }>())!.desired_state;
    const cursor = async () => (await env.DB.prepare("SELECT last_home_id FROM cloud_reconcile_progress WHERE id='homes'").first<{ last_home_id: string }>())?.last_home_id;
    const addNotice = (id: string, due: number) => env.DB.prepare("INSERT INTO billing_notices (id,home_id,kind,payload,created_at,next_attempt_at,attempts) VALUES (?,?,?,?,?,?,0)")
      .bind(id, "home-1", "suspended", "{}", due, due).run();
    const sentAt = async (id: string) => (await env.DB.prepare("SELECT sent_at FROM billing_notices WHERE id=?").bind(id).first<{ sent_at: number | null }>())!.sent_at;
    const sentSlow = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM billing_notices WHERE id LIKE 'n-slow%' AND sent_at IS NOT NULL").first<{ n: number }>())!.n;
    // Astra MAILRETRY-10 P1-3: the obligation key is per payment (each fixture home's payment is in-<home>).
    const refundAt = (homeId: string) => seen.refunds.filter((r) => r.id === `refund:provision_failed:${homeId}:in-${homeId}`).map((r) => r.at);

    const slowHomes = (db: D1Database): ProviderAdapter => {
      const p = provider(db);
      return { ...p, async snapshot_home(homeId: string, generation: number) { if (homeId.startsWith("home-s")) offset += 10_000; await p.snapshot_home?.(homeId, generation); } };
    };
    /** The customer-waiting loops at their worst: each attempt takes 59 s, so two events and two notices fill their 120 s budgets (236 s). */
    function slowLoops() {
      const slowed = new Set<string>(); // one 59 s attempt per event and run, however many Stripe calls the attempt makes
      const slowFetch: typeof stripeFetch = async (input, init) => {
        const session = /\/v1\/checkout\/sessions\/(cs_slow[\w-]+)/.exec(String(input))?.[1];
        if (session && !slowed.has(session)) { slowed.add(session); offset += 59_000; }
        return stripeFetch(input, init);
      };
      const slowNotices: BillingNotifier = { async notify(e, n, lease) {
        if (n.id.startsWith("n-slow")) { offset += 59_000; await e.DB.prepare("UPDATE billing_notices SET sent_at=? WHERE id=?").bind(Date.now(), n.id).run(); return; }
        await notifier.notify(e, n, lease);
      } };
      const slowWaiting = async (t: number, tag: string) => {
        await insertEvents([1, 2, 3].map((i) => ({ ev: oldVersionCheckout(`cs_slow${tag}${i}`), receivedAt: t - MIN + i, attempts: 0, next: null })));
        for (const i of [1, 2, 3]) await addNotice(`n-slow${tag}${i}`, t - MIN + i);
      };
      return { slowed, d: { ...deps(), stripeFetch: slowFetch, notifier: slowNotices }, slowWaiting };
    }
    const HOOK = "https://ops.murage.test/hook";
    /** The ops webhook takes `ms` per delivery (global fetch, as sweepMonitoring sends); every delivery is logged in commit order. */
    function slowWebhook(ms: number) {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (!String(input instanceof Request ? input.url : input).startsWith(HOOK)) throw new Error("no_network");
        seen.log.push(`fetch ${(JSON.parse(String(init?.body)) as { kind: string }).kind}`);
        offset += ms;
        return new Response("ok");
      });
    }

    it("MAILRETRY-9 P1: after 236 s of loops, 25 overdue homes with the alert webhook taking 30 s per delivery: all 25 obligations commit before any webhook call, within the wall", async () => {
      expect((await reserveAndCheckout()).status).toBe(200);
      const t0 = NOW + 10 * MIN;
      const ids = Array.from({ length: 25 }, (_, i) => `home-z${String(i).padStart(2, "0")}`);
      for (const [i, id] of ids.entries()) await checkingHome(id, t0 - PROVISION_MAX_MS - MIN - i);
      const { d, slowWaiting } = slowLoops();
      await slowWaiting(t0, "a");
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      slowWebhook(30_000);
      await invocation(t0, d, provider, { ALERT_WEBHOOK_URL: HOOK });
      // Every obligation committed at the same instant, right after the loops: no external I/O between the first give-up and the last.
      for (const id of ids) { expect(refundAt(id)).toEqual([t0 + 236_000]); expect(await state(id)).toBe("failed"); }
      const refunds = seen.log.flatMap((e, i) => e.startsWith("refund ") ? [i] : []);
      const fetches = seen.log.flatMap((e, i) => e.startsWith("fetch ") ? [i] : []);
      expect(refunds).toHaveLength(25);
      expect(fetches.filter((i) => i < refunds[24])).toEqual([]);
      // The alerts were persisted with the obligations (one per home) and delivered only afterwards, by the monitoring sweep (30 s each).
      expect(seen.log.filter((e) => e === "fetch provision.failed").length).toBeGreaterThan(0);
      const alerts = await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='provision.failed'").first<{ n: number }>();
      expect(alerts!.n).toBe(25);
    });

    it("MAILRETRY-9: 60 overdue homes and a slow D1 (3 s per give-up), the page walled by slow homes: the pass stops at 120 s; the rest drain oldest first in the next invocation, each once", async () => {
      expect((await reserveAndCheckout()).status).toBe(200);
      // 80 suspended homes of 10 s each before the overdue ones in id order: the page never reaches an overdue home in the first invocation.
      const suspended = Array.from({ length: 80 }, (_, i) => `home-s${String(i).padStart(2, "0")}`);
      await env.DB.batch(suspended.map((id) => homeRow(id).bind(id, `inst-${id}`, OWNER, "suspended", "suspended", "paid", IMAGE, NOW, NOW)));
      const t0 = NOW + 10 * MIN;
      const ids = Array.from({ length: 60 }, (_, i) => `home-z${String(i).padStart(2, "0")}`);
      for (const [i, id] of ids.entries()) await checkingHome(id, t0 - PROVISION_MAX_MS - 2 * MIN + i * 1000);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      seen.giveUpMs = 3_000;
      await invocation(t0, deps(), slowHomes);
      // Given up (a home given up in the first run may be refunded by the fake ledger and retired, deleted, in the second).
      const done = async () => (await env.DB.prepare("SELECT home_id FROM provision_attempts WHERE gave_up_at IS NOT NULL AND home_id LIKE 'home-z%' ORDER BY home_id")
        .all<{ home_id: string }>()).results.map((r) => r.home_id);
      expect(await done()).toEqual(ids.slice(0, 40)); // 40 x 3 s = 120 s of pass time; oldest first
      expect(seen.refunds.filter((r) => r.id.startsWith("refund:provision_failed:")).every((r) => r.at - t0 < 120_000 + 3_000)).toBe(true);
      expect(seen.walled).toBe(true); // the page ran into the wall in the slow homes, before any overdue home
      seen.walled = false;
      await invocation(t0 + SWEEP_PERIOD_MS, deps(), slowHomes);
      expect(await done()).toEqual(ids);
      for (const id of ids) expect(refundAt(id)).toHaveLength(1);
      const n = await env.DB.prepare("SELECT COUNT(*) AS n,COUNT(DISTINCT home_id) AS homes FROM cloud_outbox WHERE kind='refund_required' AND id LIKE 'refund:provision_failed:%'").first();
      expect(n).toEqual({ n: 60, homes: 60 });
    });

    it("MAILRETRY-10: a slow D1 that delays every READ (the preamble's and each give-up's own) as well as the batches: admissions stop at 120 s of pass time, each commit within one give-up's D1 time of it, oldest first; the rest are given up later (the page or the next invocation), each once", async () => {
      expect((await reserveAndCheckout()).status).toBe(200);
      const t0 = NOW + 10 * MIN;
      const ids = Array.from({ length: 40 }, (_, i) => `home-z${String(i).padStart(2, "0")}`);
      for (const [i, id] of ids.entries()) await checkingHome(id, t0 - PROVISION_MAX_MS - 2 * MIN + i * 1000);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      seen.readMs = 1_500; seen.giveUpMs = 1_000; // one give-up: 2 reads + its batch = 4 s
      await invocation(t0, deps());
      const passStart = seen.passSelects[0];
      expect(passStart - t0).toBeGreaterThan(0); // the preamble's reads were slowed too, before the pass began
      // The pass's commits (before the page starts; the page's own checking branch gives up overdue homes it reaches, as before).
      const pass = seen.refunds.filter((r) => r.id.startsWith("refund:provision_failed:") && r.at < seen.pageStarts[0]);
      expect(pass.length).toBeGreaterThan(0); expect(pass.length).toBeLessThan(ids.length);
      for (const r of pass) expect(r.at - passStart).toBeLessThanOrEqual(120_000 + 4_000); // admission bound plus one give-up's D1 time
      expect(pass.map((r) => r.id)).toEqual(ids.slice(0, pass.length).map((id) => `refund:provision_failed:${id}:in-${id}`)); // oldest first
      const done = async () => (await env.DB.prepare("SELECT home_id FROM provision_attempts WHERE gave_up_at IS NOT NULL AND home_id LIKE 'home-z%' ORDER BY home_id")
        .all<{ home_id: string }>()).results.map((r) => r.home_id);
      await invocation(t0 + SWEEP_PERIOD_MS, deps());
      expect(await done()).toEqual(ids);
      for (const id of ids) expect(refundAt(id)).toHaveLength(1);
    });

    it("MAILRETRY-9 fixture: a statement prepared before the wall is refused when executed after it", async () => {
      seen.live = true; start = NOW; offset = 0;
      try {
        const st = env.DB.prepare("SELECT 1 AS x");
        const bound = env.DB.prepare("SELECT ? AS x").bind(1);
        expect(await st.first()).toEqual({ x: 1 });
        offset = WALL + 1;
        await expect(st.first()).rejects.toThrow("invocation_wall");
        await expect(bound.all()).rejects.toThrow("invocation_wall");
        await expect(bound.run()).rejects.toThrow("invocation_wall");
      } finally { seen.live = false; }
    });

    it("P1: 2 x 59 s events, 2 x 59 s notices and 80 suspended homes of 10 s each before it: the overdue give-up commits within the wall, in two invocations in a row", async () => {
      expect((await reserveAndCheckout()).status).toBe(200);
      // 80 suspended homes before the overdue ones in the page's id order (home-s.. < home-z..); 83 homes in all, so the cursor stays empty and
      // every run's page starts again at the first home: without the pass, home-z* is reached at 236 s + 800 s, past the wall, in EVERY run.
      const suspended = Array.from({ length: 80 }, (_, i) => `home-s${String(i).padStart(2, "0")}`);
      await env.DB.batch(suspended.map((id) => homeRow(id).bind(id, `inst-${id}`, OWNER, "suspended", "suspended", "paid", IMAGE, NOW, NOW)));
      const t0 = NOW + 10 * MIN;
      const t1 = t0 + SWEEP_PERIOD_MS;
      await checkingHome("home-z1", t0 - PROVISION_MAX_MS - MIN); // overdue at t0
      await checkingHome("home-z2", t0 - PROVISION_MAX_MS + 5 * MIN); // overdue only in the second run (B3 reads the clock 236 s in)
      const { slowed, d, slowWaiting } = slowLoops();
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      for (const [t, id, other] of [[t0, "home-z1", "home-z2"], [t1, "home-z2", "home-z1"]] as const) {
        await slowWaiting(t, id);
        slowed.clear();
        const sentBefore = await sentSlow();
        const before = refundAt(id).length;
        await invocation(t, d, slowHomes);
        // The customer-waiting loops used their whole budgets (2 x 2 x 59 s), and the slow homes after them ran into the wall: Cloudflare would
        // have ended this invocation (nothing committed past it).
        expect(await sentSlow() - sentBefore).toBe(2);
        expect(slowed.size).toBe(2);
        expect(seen.walled).toBe(true);
        expect(offset).toBeGreaterThan(WALL);
        // The overdue home was given up and its refund obligation committed BEFORE the wall: right after the 236 s of the loops.
        expect(await state(id)).toBe("failed");
        expect(refundAt(id).length - before).toBe(1);
        expect(refundAt(id)[0] - t).toBe(236_000);
        expect(refundAt(id)[0] - t).toBeLessThanOrEqual(2 * SWEEP_LOOP_BUDGET_MS);
        if (id === "home-z1") expect(await state(other)).toBe("checking"); // not overdue yet at t0
        expect(await cursor()).toBe(""); // at most 100 homes: the next page starts again at the first home
        seen.walled = false;
      }
      // One refund obligation per home, ever.
      const n = await env.DB.prepare("SELECT home_id,COUNT(*) AS n FROM cloud_outbox WHERE kind='refund_required' GROUP BY home_id ORDER BY home_id").all();
      expect(n.results).toEqual([{ home_id: "home-z1", n: 1 }, { home_id: "home-z2", n: 1 }]);
    });

    it("once only, scheduled: the event loop and the notice loop each read their due rows exactly once in the invocation, and B3 runs", async () => {
      expect((await reserveAndCheckout()).status).toBe(200);
      const t0 = NOW + 10 * MIN;
      await insertEvents([{ ev: ghostInvoice("once1"), receivedAt: t0 - MIN, attempts: 0, next: null }]);
      await addNotice("n-once", t0 - MIN);
      await checkingHome("home-z1", t0 - PROVISION_MAX_MS - MIN);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await invocation(t0, deps());
      expect(seen.walled).toBe(false);
      expect({ events: seen.events, notices: seen.notices }).toEqual({ events: 1, notices: 1 });
      expect(await sentAt("n-once")).not.toBeNull();
      expect(await state("home-z1")).toBe("failed");
    });

    it("once only, direct: sweepBilling runs the two loops itself, once each; told the invocation already did (customerWaitingDone), not at all", async () => {
      expect((await reserveAndCheckout()).status).toBe(200);
      await insertEvents([{ ev: ghostInvoice("once2"), receivedAt: NOW - MIN, attempts: 0, next: null }]);
      await addNotice("n-direct", NOW - MIN);
      const ok = (err: unknown) => { if (!(err instanceof Error && err.message === "billing_sweep_incomplete")) throw err; };
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      seen.live = true;
      try {
        await sweepBilling(baseEnv(), deps()).catch(ok);
        expect({ events: seen.events, notices: seen.notices }).toEqual({ events: 1, notices: 1 });
        await sweepBilling(baseEnv(), { ...deps(), customerWaitingDone: true }).catch(ok);
        expect({ events: seen.events, notices: seen.notices }).toEqual({ events: 1, notices: 1 });
      } finally { seen.live = false; }
      expect(await sentAt("n-direct")).not.toBeNull();
    });

    it("once only, error: sweepCustomerWaiting throws; the billing sweep does not run the loops again, and B3 and every later stage still run", async () => {
      expect((await reserveAndCheckout()).status).toBe(200);
      const t0 = NOW + 10 * MIN;
      await insertEvents([{ ev: ghostInvoice("once3"), receivedAt: t0 - MIN, attempts: 0, next: null }]);
      await addNotice("n-error", t0 - MIN);
      await checkingHome("home-z1", t0 - PROVISION_MAX_MS - MIN);
      await expiredWindow("after-billing");
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      seen.failEventSelect = true;
      await invocation(t0, deps());
      expect(logged(errors, "customer-waiting sweep failed")).toBe(1);
      // The event loop's read failed once; the notice loop never ran, neither there nor in the billing sweep after it.
      expect({ events: seen.events, notices: seen.notices }).toEqual({ events: 1, notices: 0 });
      expect(await sentAt("n-error")).toBeNull();
      expect(await state("home-z1")).toBe("failed"); // B3 reconcile ran
      expect(await windowLeft("after-billing")).toBe(0); // a stage after the billing sweep ran
    });
  });

  it("§4/A5: ONE alert row per event: raised at the third failure from the committed attempts, never duplicated, untouched while open, resolved with the payment in one batch", async () => {
    expect((await reserveAndCheckout()).status).toBe(200);
    const ev = await checkoutEvent();
    expect((await deliver(ev, mailDown())).status).toBe(500);
    await runEvent(ev.id, mailDown());
    expect(await evRow(ev.id)).toMatchObject({ attempts: 2 });
    expect(await stuckAlerts()).toEqual([]);
    await runEvent(ev.id, mailDown());
    let alerts = await stuckAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: `alert:webhook_stuck:${ev.id}`, home_id: `stripe_event:${ev.id}`, severity: "high", raised_at: NOW, resolved_at: null });
    expect(detail(alerts[0])).toMatchObject({ eventId: ev.id, type: "checkout.session.completed", errorAtRaise: "mail_provider_down", attemptsAtRaise: 3, homeId: "home-1", generation: 1 });
    const raisedDetail = alerts[0].detail;
    // Ops was told; later failures change nothing on the open alert (no new row, no re-delivery, the same detail: Astra MAILRETRY-3 P2).
    await env.DB.prepare("UPDATE cloud_alerts SET delivered_at=?,delivery_attempts=1 WHERE id=?").bind(NOW, alerts[0].id).run();
    at(NOW + MIN);
    await runEvent(ev.id, mailDown());
    await runEvent(ev.id, mailDown());
    alerts = await stuckAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ raised_at: NOW, delivered_at: NOW, delivery_attempts: 1, resolved_at: null, detail: raisedDetail });
    expect(await evRow(ev.id)).toMatchObject({ attempts: 5 });
    const batches = captureBatches();
    at(NOW + 5 * MIN);
    await runEvent(ev.id);
    expect(await evRow(ev.id)).toMatchObject({ processed_at: NOW + 5 * MIN, attempts: 5 });
    alerts = await stuckAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].resolved_at).toBe(NOW + 5 * MIN);
    expect(batches.filter(resolving)).toHaveLength(1);
    expect(await inboxRows()).toBe(1);
  });

  it("§4: a terminal outcome (ignored_mode) resolves the alert in the SAME batch as the checkpoint and its reconciliation", async () => {
    const a = oldVersionCheckout("cs_va");
    expect((await deliver(a)).status).toBe(500);
    for (let i = 0; i < 2; i++) await runEvent(a.id);
    expect(await evRow(a.id)).toMatchObject({ attempts: 3 });
    const [alert] = await stuckAlerts();
    expect(alert).toMatchObject({ home_id: `stripe_event:${a.id}`, resolved_at: null });
    expect(detail(alert)).toMatchObject({ homeId: null, attemptsAtRaise: 3, generation: 1 });
    const batches = captureBatches();
    sessionRetrievable("cs_va");
    at(NOW + MIN);
    await runEvent(a.id);
    expect(await evRow(a.id)).toMatchObject({ processed_at: NOW + MIN, error: "ignored_mode" });
    expect((await stuckAlerts())[0].resolved_at).toBe(NOW + MIN);
    const done = batches.filter(resolving);
    expect(done).toHaveLength(1);
    expect(done[0].sql.some((s) => s.startsWith("INSERT INTO stripe_event_reconciliations"))).toBe(true);
  });

  it("§4: two stuck events of the same home have two rows; invoice.paid waits on confirmation_pending and completes on the next sweep, one payment", async () => {
    expect((await reserveAndCheckout()).status).toBe(200);
    const co = await checkoutEvent();
    const inv = stripeEvent("invoice.paid", invoice());
    expect((await deliver(co, mailDown())).status).toBe(500);
    expect((await deliver(inv, mailDown())).status).toBe(500);
    expect(await evRow(inv.id)).toMatchObject({ attempts: 1, error: "confirmation_pending" });
    for (let i = 0; i < 2; i++) await runEvent(co.id, mailDown());
    at(NOW + MIN);
    for (let i = 0; i < 2; i++) await runEvent(inv.id, mailDown());
    expect(await evRow(co.id)).toMatchObject({ attempts: 3, error: "mail_provider_down", next_attempt_at: NOW + 5 * MIN });
    expect(await evRow(inv.id)).toMatchObject({ attempts: 3, error: "confirmation_pending", next_attempt_at: NOW + 6 * MIN });
    let alerts = await stuckAlerts();
    expect(alerts.map((a) => a.home_id).sort()).toEqual([`stripe_event:${co.id}`, `stripe_event:${inv.id}`].sort());
    expect(alerts.map((a) => detail(a).homeId)).toEqual(["home-1", "home-1"]);
    // The mail provider is back. Only the checkout is due: it completes, its alert is resolved; the invoice's stays open.
    await sweepAt(NOW + 5 * MIN);
    expect((await evRow(co.id)).processed_at).toBe(NOW + 5 * MIN);
    expect(await evRow(inv.id)).toMatchObject({ processed_at: null, attempts: 3, error: "confirmation_pending" });
    alerts = await stuckAlerts();
    expect(alerts.find((a) => a.home_id === `stripe_event:${co.id}`)!.resolved_at).toBe(NOW + 5 * MIN);
    expect(alerts.find((a) => a.home_id === `stripe_event:${inv.id}`)!.resolved_at).toBeNull();
    // The next sweep: the invoice finds its confirmation sent and completes; its own alert is resolved with it.
    await sweepAt(NOW + 6 * MIN);
    expect(await evRow(inv.id)).toMatchObject({ processed_at: NOW + 6 * MIN, error: null });
    expect((await stuckAlerts()).every((a) => a.resolved_at !== null)).toBe(true);
    expect(notices.filter((n) => n.kind === "confirmation")).toHaveLength(1);
    // One payment-inbox entry per payment event (the checkout and its invoice, as on the happy path) and one monthly credit: no double effect.
    expect(await inboxRows()).toBe(2);
    expect(fluxLog.filter((x) => x.hook === "grant")).toHaveLength(1);
  });

  it("A6: two workers crossing the threshold at once (both read attempts=1) commit attempts=3 and exactly ONE open alert with attempts 3", async () => {
    const ghost = ghostInvoice("conc");
    await insertEvents([{ ev: ghost, receivedAt: NOW - DAY, attempts: 1, next: NOW }]);
    await Promise.all([runEvent(ghost.id), runEvent(ghost.id)]);
    expect(await evRow(ghost.id)).toMatchObject({ attempts: 3, processed_at: null });
    const alerts = await stuckAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].resolved_at).toBeNull();
    expect(detail(alerts[0])).toMatchObject({ attemptsAtRaise: 3, generation: 1 });
  });

  it("A5: a resolved alert REOPENS (same row, delivery reset) when its event is requeued and fails again", async () => {
    const p = oldVersionCheckout("cs_park");
    expect((await deliver(p)).status).toBe(500);
    for (let i = 0; i < 2; i++) await runEvent(p.id);
    await env.DB.prepare("UPDATE cloud_alerts SET delivered_at=?,delivery_attempts=2 WHERE kind='billing.webhook_stuck'").bind(NOW).run();
    sessionRetrievable("cs_park");
    at(NOW + MIN);
    await runEvent(p.id);
    expect((await stuckAlerts())[0].resolved_at).toBe(NOW + MIN);
    // Requeued the way releaseParkedAcceptance does it; the retrieval fails again.
    await env.DB.prepare("UPDATE stripe_events SET processed_at=NULL,error=NULL,next_attempt_at=? WHERE id=?").bind(NOW + MIN, p.id).run();
    delete retrievable["/v1/checkout/sessions/cs_park"];
    at(NOW + 2 * MIN);
    await runEvent(p.id);
    const alerts = await stuckAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: `alert:webhook_stuck:${p.id}`, resolved_at: null, raised_at: NOW + 2 * MIN, delivered_at: null, delivery_attempts: 0 });
    expect(detail(alerts[0])).toMatchObject({ attemptsAtRaise: 4, generation: 2 }); // the next incident generation
    sessionRetrievable("cs_park");
    at(NOW + 3 * MIN);
    await runEvent(p.id);
    expect((await stuckAlerts())[0].resolved_at).toBe(NOW + 3 * MIN);
  });

  it("§4: completion and resolution are one transaction: a failing resolution rolls the checkpoint back too (both or neither)", async () => {
    expect((await reserveAndCheckout()).status).toBe(200);
    const ev = await checkoutEvent();
    expect((await deliver(ev, mailDown())).status).toBe(500);
    for (let i = 0; i < 2; i++) await runEvent(ev.id, mailDown());
    expect(await stuckAlerts()).toHaveLength(1);
    await env.DB.prepare(`CREATE TRIGGER lanec_resolve_fails BEFORE UPDATE OF resolved_at ON cloud_alerts WHEN NEW.resolved_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'resolve_failed'); END`).run();
    try {
      at(NOW + 5 * MIN);
      await runEvent(ev.id);
      expect((await evRow(ev.id)).processed_at).toBeNull();
      expect((await stuckAlerts())[0].resolved_at).toBeNull();
    } finally { await env.DB.prepare("DROP TRIGGER lanec_resolve_fails").run(); }
    at(NOW + 10 * MIN);
    await runEvent(ev.id);
    expect((await evRow(ev.id)).processed_at).toBe(NOW + 10 * MIN);
    expect((await stuckAlerts())[0].resolved_at).toBe(NOW + 10 * MIN);
    expect(await inboxRows()).toBe(1);
  });

  it("§5/(j): the unfenced checkpoint never overwrites an event a lease holder completed meanwhile", async () => {
    const ev = oldVersionCheckout("cs_j");
    expect((await deliver(ev)).status).toBe(500);
    // Worker A stalls retrieving the session; worker B completes the event (at NOW+1 min); A's retrieval then succeeds.
    let raced = false;
    const stalling: BillingDependencies = { ...deps(), stripeFetch: async (input, init) => {
      if (!raced && String(input).includes("/v1/checkout/sessions/cs_j")) {
        raced = true;
        sessionRetrievable("cs_j");
        await processStoredEvent(baseEnv(), billingConfig(baseEnv())!, { ...deps(), now: () => NOW + MIN }, ev.id);
      }
      return stripeFetch(input, init);
    } };
    const batches = captureBatches();
    await processStoredEvent(baseEnv(), billingConfig(baseEnv())!, stalling, ev.id);
    expect(raced).toBe(true);
    expect(await evRow(ev.id)).toMatchObject({ processed_at: NOW + MIN, error: "ignored_mode" });
    const checkpoints = batches.filter((b) => b.sql[0].startsWith("UPDATE stripe_events SET processed_at=?,error=?,next_attempt_at=NULL WHERE id=? AND processed_at IS NULL"));
    expect(checkpoints.map((b) => b.changes[0])).toEqual([1, 0]); // B's applied; A's matched nothing
  });

  it("(f) attempt-eight late failure of an event another worker completed meanwhile writes nothing: no attempt, no alert of either kind", async () => {
    const ev = oldVersionCheckout("cs_late");
    expect((await deliver(ev)).status).toBe(500);
    await env.DB.prepare("UPDATE stripe_events SET attempts=7 WHERE id=?").bind(ev.id).run();
    await env.DB.prepare("DELETE FROM cloud_alerts WHERE kind='billing.webhook_stuck'").run(); // as if it had never been alerted
    let raced = false;
    const stalling: BillingDependencies = { ...deps(), stripeFetch: async (input, init) => {
      if (!raced && String(input).includes("/v1/checkout/sessions/cs_late")) {
        raced = true;
        sessionRetrievable("cs_late");
        await processStoredEvent(baseEnv(), billingConfig(baseEnv())!, deps(), ev.id);
        delete retrievable["/v1/checkout/sessions/cs_late"];
        return new Response(JSON.stringify({ error: { code: "unexpected" } }), { status: 500 });
      }
      return stripeFetch(input, init);
    } };
    await expect(processStoredEvent(baseEnv(), billingConfig(baseEnv())!, stalling, ev.id)).rejects.toThrow();
    expect(raced).toBe(true);
    expect(await evRow(ev.id)).toMatchObject({ processed_at: NOW, error: "ignored_mode", attempts: 7 });
    expect(await stuckAlerts()).toEqual([]);
    expect(await eventStuck()).toEqual([]);
  });

  it("A4: customer_unknown is a retryable miss; a customer bound after the third miss is handled; a customer with none of our metadata settles at once", async () => {
    // Not ours by evidence (none of our metadata keys): settled immediately, 200 to Stripe.
    const foreign = stripeEvent("customer.updated", { object: "customer", id: "cus_foreign", address: { country: "FR" }, metadata: {} });
    expect((await deliver(foreign)).status).toBe(200);
    expect(await evRow(foreign.id)).toMatchObject({ processed_at: NOW, error: "customer_unknown", attempts: 0 });
    // Ours (home_id metadata), its billing row not there yet: a miss, retried with noticeBackoff, no stuck alert, never settled at 3.
    const ours = stripeEvent("customer.updated", { object: "customer", id: "cus_test1", address: { country: "US" }, metadata: { home_id: "home-1" } });
    // Durably queued and retried by the sweep: acknowledged to Stripe with a typed pending outcome, never a 500 (Astra MAILRETRY-3 P2).
    const res = await deliver(ours);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, outcome: "pending:customer_unknown" });
    expect(await evRow(ours.id)).toMatchObject({ processed_at: null, error: "customer_unknown", attempts: 1, next_attempt_at: NOW + noticeBackoff(1) });
    for (let i = 0; i < 3; i++) await runEvent(ours.id);
    expect(await evRow(ours.id)).toMatchObject({ processed_at: null, error: "customer_unknown", attempts: 4 });
    expect(await stuckAlerts()).toEqual([]);
    // The checkout binds the customer: the next try resolves the home and the address handler runs (it reads the live customer).
    expect((await reserveAndCheckout()).status).toBe(200);
    retrievable["/v1/customers/cus_test1"] = { id: "cus_test1", address: { country: "US" } };
    at(NOW + 10 * MIN);
    await runEvent(ours.id);
    const r = await evRow(ours.id);
    expect(r.processed_at).toBe(NOW + 10 * MIN);
    expect(r.error).not.toBe("customer_unknown");
    expect(stripeCalls.some((c) => c.method === "GET" && c.path === "/v1/customers/cus_test1")).toBe(true);
  });

  it("A4: an unbound customer of ours, and a refund no ledger knows, settle only after 24 h of misses", async () => {
    const ours = stripeEvent("customer.updated", { object: "customer", id: "cus_never", metadata: { home_id: "home-never", fp_tid: "fp_1" } });
    const refund = stripeEvent("refund.updated", { object: "refund", id: "re_none", payment_intent: "pi_none", status: "succeeded", amount: 100 });
    expect((await deliver(ours)).status).toBe(200);
    const res = await deliver(refund);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "pending:not_a_ledger_refund" });
    expect(await evRow(refund.id)).toMatchObject({ processed_at: null, error: "not_a_ledger_refund", attempts: 1, next_attempt_at: NOW + noticeBackoff(1) });
    at(NOW + MISS_SETTLES_AFTER_MS - 1);
    await runEvent(ours.id); await runEvent(refund.id);
    expect(await evRow(ours.id)).toMatchObject({ processed_at: null, attempts: 2 });
    expect(await evRow(refund.id)).toMatchObject({ processed_at: null, attempts: 2 });
    at(NOW + MISS_SETTLES_AFTER_MS);
    await runEvent(ours.id); await runEvent(refund.id);
    expect(await evRow(ours.id)).toMatchObject({ processed_at: NOW + MISS_SETTLES_AFTER_MS, error: "customer_unknown", attempts: 2 });
    expect(await evRow(refund.id)).toMatchObject({ processed_at: NOW + MISS_SETTLES_AFTER_MS, error: "not_a_ledger_refund", attempts: 2 });
  });

  it("A4: a credit-note refund that arrives before its ledger checkpoint is resolved to its home on a later try, not settled as foreign", async () => {
    await paidAndRunning();
    const refund = stripeEvent("refund.updated", { object: "refund", id: "re_cn1", payment_intent: "pi_1", status: "succeeded", amount: 100 });
    expect((await deliver(refund)).status).toBe(200);
    expect(await evRow(refund.id)).toMatchObject({ error: "not_a_ledger_refund", processed_at: null });
    // The credit note's coverage is checkpointed for the payment meanwhile.
    await env.DB.prepare("INSERT INTO refund_coverage (home_id,payment_intent,changed_at,created_at) VALUES ('home-1','pi_1',?,?)").bind(NOW, NOW).run();
    at(NOW + 2 * MIN);
    stripeCalls = [];
    await runEvent(refund.id);
    // Resolved to home-1 this time: handled under its lease (the payment's refunds are read from Stripe to re-check its coverage) and settled
    // by the refund handler's own verdict, without counting a failed attempt.
    expect(await evRow(refund.id)).toMatchObject({ processed_at: NOW + 2 * MIN, attempts: 1 });
    expect(stripeCalls.some((c) => c.method === "GET" && c.path === "/v1/refunds")).toBe(true);
  });

  it("P2: a customer bound between an aged miss's lookup and its checkpoint is handled under its home's lease, never settled as unknown", async () => {
    expect((await reserveAndCheckout()).status).toBe(200);
    // The binding does not exist yet when the event arrives.
    expect((await env.DB.prepare("UPDATE billing_subscriptions SET customer_id='cus_not_yet' WHERE customer_id='cus_test1'").run()).meta.changes).toBe(1);
    const ours = stripeEvent("customer.updated", { object: "customer", id: "cus_test1", address: { country: "US" }, metadata: { home_id: "home-1" } });
    expect((await deliver(ours)).status).toBe(200);
    expect(await evRow(ours.id)).toMatchObject({ processed_at: null, error: "customer_unknown", attempts: 1 });
    retrievable["/v1/customers/cus_test1"] = { id: "cus_test1", address: { country: "US" } };
    // 24 h later the miss is due to settle by age. The checkout binds the customer right after this worker's lookup missed, just before
    // its checkpoint (the first batch the attempt writes).
    at(NOW + MISS_SETTLES_AFTER_MS);
    const batch = env.DB.batch.bind(env.DB);
    let bound = false;
    vi.spyOn(env.DB, "batch").mockImplementation(async (stmts: D1PreparedStatement[]) => {
      if (!bound) { bound = true; await env.DB.prepare("UPDATE billing_subscriptions SET customer_id='cus_test1' WHERE customer_id='cus_not_yet'").run(); }
      return batch(stmts);
    });
    stripeCalls = [];
    await runEvent(ours.id);
    expect(bound).toBe(true);
    const r = await evRow(ours.id);
    expect(r.processed_at).toBe(NOW + MISS_SETTLES_AFTER_MS);
    expect(r.error).not.toBe("customer_unknown");
    expect(r.attempts).toBe(1);
    expect(stripeCalls.some((c) => c.method === "GET" && c.path === "/v1/customers/cus_test1")).toBe(true); // the address handler ran
  });

  it("P2: an aged refund miss whose ledger row appears before the checkpoint is not settled as foreign either", async () => {
    await paidAndRunning();
    const refund = stripeEvent("refund.updated", { object: "refund", id: "re_late", payment_intent: "pi_1", status: "succeeded", amount: 100 });
    expect((await deliver(refund)).status).toBe(200);
    at(NOW + MISS_SETTLES_AFTER_MS);
    const batch = env.DB.batch.bind(env.DB);
    let checkpointed = false;
    vi.spyOn(env.DB, "batch").mockImplementation(async (stmts: D1PreparedStatement[]) => {
      if (!checkpointed) {
        checkpointed = true;
        await env.DB.prepare("INSERT INTO refund_coverage (home_id,payment_intent,changed_at,created_at) VALUES ('home-1','pi_1',?,?)").bind(NOW, NOW).run();
      }
      return batch(stmts);
    });
    stripeCalls = [];
    await runEvent(refund.id);
    expect(checkpointed).toBe(true);
    // Resolved to home-1 and settled by the refund handler's own verdict under its lease (the payment's refunds are read from Stripe to
    // re-check its coverage), not checkpointed by age without a lease.
    expect(await evRow(refund.id)).toMatchObject({ processed_at: NOW + MISS_SETTLES_AFTER_MS, attempts: 1 });
    expect(stripeCalls.some((c) => c.method === "GET" && c.path === "/v1/refunds")).toBe(true);
  });

  it("P2: a miss whose retry record cannot be written is NOT acknowledged (500): Stripe keeps the obligation", async () => {
    const ours = stripeEvent("customer.updated", { object: "customer", id: "cus_rec", metadata: { home_id: "home-rec" } });
    await env.DB.prepare(`CREATE TRIGGER lanec_miss_record_fails BEFORE UPDATE OF attempts ON stripe_events
      BEGIN SELECT RAISE(ABORT,'record_failed'); END`).run();
    try {
      expect((await deliver(ours)).status).toBe(500);
    } finally { await env.DB.prepare("DROP TRIGGER lanec_miss_record_fails").run(); }
    expect(await evRow(ours.id)).toMatchObject({ attempts: 0, processed_at: null });
    const res = await deliver(ours); // Stripe's redelivery, the record working again
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "pending:customer_unknown" });
    expect(await evRow(ours.id)).toMatchObject({ attempts: 1, error: "customer_unknown" });
  });

  describe("P2: the monitoring sender's acknowledgement (ops-monitor deliver, keyed on the detail it sent)", () => {
    const opsEnv = () => ({ ...baseEnv(), ALERT_WEBHOOK_URL: "https://ops.murage.test/hook" }) as unknown as Env;
    const hookOk = (async () => new Response("ok")) as unknown as typeof fetch;
    const ack = (a: AlertRow, now: number) => deliverAlert(opsEnv(), a.id, a.detail, { kind: "billing.webhook_stuck", text: a.detail, at: a.raised_at }, now, hookOk);

    it("a delivery in flight while later attempts fail is acknowledged: attempt telemetry never changes the alert", async () => {
      const ghost = ghostInvoice("ack");
      await insertEvents([{ ev: ghost, receivedAt: NOW - DAY, attempts: 2, next: NOW }]);
      await runEvent(ghost.id);
      const [sending] = await stuckAlerts(); // the sender reads the alert (attempt 3) and posts it
      at(NOW + 5 * MIN);
      await runEvent(ghost.id); // attempt 4 fails meanwhile
      await runEvent(ghost.id); // and attempt 5
      await ack(sending, NOW + 5 * MIN);
      const [after] = await stuckAlerts();
      expect(after).toMatchObject({ delivered_at: NOW + 5 * MIN, delivery_attempts: 1, resolved_at: null, detail: sending.detail });
      expect(await evRow(ghost.id)).toMatchObject({ attempts: 5, error: "home_unresolved" }); // the live telemetry
    });

    it("a delivery of the previous incident acknowledged after a REOPEN changes nothing: the reopened incident is still sent", async () => {
      const p = oldVersionCheckout("cs_ack");
      expect((await deliver(p)).status).toBe(500);
      for (let i = 0; i < 2; i++) await runEvent(p.id);
      const [sending] = await stuckAlerts(); // generation 1, being sent
      expect(detail(sending)).toMatchObject({ generation: 1 });
      // Meanwhile the event completes (alert resolved), is requeued and fails again: the alert reopens as generation 2.
      sessionRetrievable("cs_ack");
      at(NOW + MIN);
      await runEvent(p.id);
      await env.DB.prepare("UPDATE stripe_events SET processed_at=NULL,error=NULL,next_attempt_at=? WHERE id=?").bind(NOW + MIN, p.id).run();
      delete retrievable["/v1/checkout/sessions/cs_ack"];
      at(NOW + 2 * MIN);
      await runEvent(p.id);
      let [reopened] = await stuckAlerts();
      expect(detail(reopened)).toMatchObject({ generation: 2 });
      expect(reopened).toMatchObject({ resolved_at: null, delivered_at: null, delivery_attempts: 0 });
      // The late acknowledgement of generation 1 does not mark generation 2 delivered.
      await ack(sending, NOW + 2 * MIN);
      [reopened] = await stuckAlerts();
      expect(reopened).toMatchObject({ delivered_at: null, delivery_attempts: 0 });
      // Generation 2's own send is acknowledged.
      await ack(reopened, NOW + 3 * MIN);
      expect((await stuckAlerts())[0]).toMatchObject({ delivered_at: NOW + 3 * MIN, delivery_attempts: 1 });
    });
  });

  async function stuckCheckout() {
    expect((await reserveAndCheckout()).status).toBe(200);
    const ev = await checkoutEvent();
    expect((await deliver(ev, mailDown())).status).toBe(500);
    for (let i = 0; i < 2; i++) await runEvent(ev.id, mailDown());
    expect(await evRow(ev.id)).toMatchObject({ attempts: 3, processed_at: null, next_attempt_at: NOW + 5 * MIN });
    expect(await stuckAlerts()).toHaveLength(1);
    at(NOW + 5 * MIN);
    return ev;
  }
  async function expectCompletedOnce(id: string) {
    expect(await evRow(id)).toMatchObject({ processed_at: NOW + 5 * MIN, attempts: 3 });
    expect(notices.filter((n) => n.kind === "confirmation")).toHaveLength(1);
    const alerts = await stuckAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].resolved_at).toBe(NOW + 5 * MIN);
    expect(await inboxRows()).toBe(1);
  }

  it("(g) a Stripe redelivery during the sweep's retry under the home lease: the sweep completes it, the redelivery records nothing", async () => {
    const ev = await stuckCheckout();
    let redelivery: Response | null = null;
    const racing: BillingNotifier = { async notify(e, n, lease) {
      if (n.kind === "confirmation" && !redelivery) redelivery = await deliver(ev, deps());
      await notifier.notify(e, n, lease);
    } };
    await sweepAt(NOW + 5 * MIN, { ...deps(), notifier: racing });
    expect(redelivery!.status).toBe(500); // the home was busy: nothing written
    await expectCompletedOnce(ev.id);
  });

  it("(g) a sweep during the Stripe redelivery's retry under the home lease: the redelivery completes it, the sweep records nothing", async () => {
    const ev = await stuckCheckout();
    let swept = false;
    const racing: BillingNotifier = { async notify(e, n, lease) {
      if (n.kind === "confirmation" && !swept) { swept = true; await sweepAt(NOW + 5 * MIN); }
      await notifier.notify(e, n, lease);
    } };
    expect((await deliver(ev, { ...deps(), notifier: racing })).status).toBe(200);
    expect(swept).toBe(true);
    await expectCompletedOnce(ev.id);
  });

  describe("the default notifier (at-least-once email, exactly-once payment)", () => {
    let sent: string[];
    const mailEnv = () => ({ ...baseEnv(), EMAIL: { send: async (m: { subject: string }) => { sent.push(m.subject); } } } as unknown as Env);
    /** Sends of the order confirmation (the first email of the order). */
    const confirmations = () => sent.filter((x) => x === sent[0]);
    const real = (): BillingDependencies => ({ ...deps(), notifier: defaultNotifier });
    beforeEach(() => { sent = []; });
    const confirmationRow = () => env.DB.prepare("SELECT sent_at,attempts FROM billing_notices WHERE kind='confirmation'").first<{ sent_at: number | null; attempts: number }>();

    it("the sent_at checkpoint fails after the handoff: the event is retried, the email goes out again (documented at-least-once), the payment applies once", async () => {
      expect((await reserveAndCheckout()).status).toBe(200);
      const ev = await checkoutEvent();
      await insertEvents([{ ev, receivedAt: NOW, attempts: 0, next: null }]);
      await env.DB.prepare(`CREATE TRIGGER lanec_sent_fails BEFORE UPDATE OF sent_at ON billing_notices WHEN NEW.sent_at IS NOT NULL AND NEW.kind='confirmation'
        BEGIN SELECT RAISE(ABORT,'sent_checkpoint_failed'); END`).run();
      try {
        await runEvent(ev.id, real(), mailEnv());
        expect(confirmations()).toHaveLength(1);
        expect(await confirmationRow()).toMatchObject({ sent_at: null });
        expect(await evRow(ev.id)).toMatchObject({ processed_at: null, attempts: 1 });
      } finally { await env.DB.prepare("DROP TRIGGER lanec_sent_fails").run(); }
      await sweepAt(NOW + 5 * MIN, real(), mailEnv()); // past the notice's claim window and the event's gap
      expect(await evRow(ev.id)).toMatchObject({ processed_at: NOW + 5 * MIN });
      expect(confirmations()).toHaveLength(2);
      expect((await confirmationRow())!.sent_at).not.toBeNull();
      expect(await inboxRows()).toBe(1);
    });

    it("the event's checkpoint fails after sent_at: the retry does not send again and completes once", async () => {
      expect((await reserveAndCheckout()).status).toBe(200);
      const ev = await checkoutEvent();
      await insertEvents([{ ev, receivedAt: NOW, attempts: 0, next: null }]);
      await env.DB.prepare(`CREATE TRIGGER lanec_done_fails BEFORE UPDATE OF processed_at ON stripe_events WHEN NEW.processed_at IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'event_checkpoint_failed'); END`).run();
      try {
        await runEvent(ev.id, real(), mailEnv());
        expect(confirmations()).toHaveLength(1);
        expect((await confirmationRow())!.sent_at).not.toBeNull();
        expect(await evRow(ev.id)).toMatchObject({ processed_at: null, attempts: 1 });
      } finally { await env.DB.prepare("DROP TRIGGER lanec_done_fails").run(); }
      await sweepAt(NOW + 5 * MIN, real(), mailEnv());
      expect(await evRow(ev.id)).toMatchObject({ processed_at: NOW + 5 * MIN });
      expect(confirmations()).toHaveLength(1);
      expect(await inboxRows()).toBe(1);
    });

    it("async payment journey: the order email cannot go out, the payment arrives meanwhile; both recover on the sweep, one payment, one 'Payment received'", async () => {
      expect((await reserveAndCheckout()).status).toBe(200);
      const completed = await checkoutEvent("unpaid");
      const succeeded = await checkoutEvent("paid", "checkout.session.async_payment_succeeded");
      const down = { ...mailEnv(), EMAIL: { send: async () => { throw new Error("mail_provider_down"); } } } as unknown as Env;
      await insertEvents([{ ev: completed, receivedAt: NOW, attempts: 0, next: null }, { ev: succeeded, receivedAt: NOW + 1, attempts: 0, next: null }]);
      await runEvent(completed.id, real(), down);
      at(NOW + MIN);
      await runEvent(succeeded.id, real(), down);
      expect((await evRow(completed.id)).processed_at).toBeNull();
      for (const t of [5, 10, 15, 20]) await sweepAt(NOW + t * MIN, real(), mailEnv());
      expect((await evRow(completed.id)).processed_at).not.toBeNull();
      expect((await evRow(succeeded.id)).processed_at).not.toBeNull();
      expect(await inboxRows()).toBe(1);
      const kinds = await env.DB.prepare("SELECT kind,sent_at FROM billing_notices WHERE kind IN ('confirmation','payment_received') ORDER BY kind").all<{ kind: string; sent_at: number | null }>();
      expect(kinds.results.map((k) => [k.kind, k.sent_at !== null])).toEqual([["confirmation", true], ["payment_received", true]]);
      expect((await stuckAlerts()).every((a) => a.resolved_at !== null)).toBe(true);
    });
  });
});

describe("Astra MAILRETRY-11: a customer cancel on a given-up home", () => {
  it("is recorded on the subscription and its hand-off handled, while the home keeps its refund (no overwrite, one obligation)", async () => {
    await paidAndRunning();
    const t = NOW + PROVISION_MAX_MS + 60_000;
    vi.mocked(Date.now).mockReturnValue(t); expect((await reconcile()).status).toBe(200);
    expect(await getHome()).toMatchObject({ desired_state: "failed", entitlement: "refund_pending" });
    const version = (await getHome()).payment_version;
    vi.mocked(Date.now).mockReturnValue(t + 60_000);
    expect((await hook(stripeEvent("customer.subscription.deleted", sub({ status: "canceled" }), (t + 60_000) / 1000), { tSeconds: (t + 60_000) / 1000 })).status).toBe(200);
    expect((await reconcile()).status).toBe(200);
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions WHERE home_id='home-1'").first()).toMatchObject({ status: "canceled" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE home_id='home-1' AND processed_at IS NULL").first<{ n: number }>())!.n).toBe(0);
    const h = await getHome();
    expect(["refund_pending", "refunded"]).toContain(h.entitlement);
    // MAILRETRY-11 P1-B: the cancellation's version is recorded (it fences older events), with no other effect on the home.
    expect(h.payment_version).toBeGreaterThan(version);
    const obligations = await env.DB.prepare("SELECT id FROM cloud_outbox WHERE home_id='home-1' AND kind='refund_required'").all<{ id: string }>();
    expect(obligations.results.map((o) => o.id)).toEqual([expect.stringMatching(/^refund:provision_failed:home-1:/)]);
  });
});
