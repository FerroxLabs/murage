// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra INTEGRATED-1 probes #2 to #5, each reproduced and then shown fixed. Real workerd + D1, the B3 fake provider, Stripe as a fixture. No network.
//   #2 a home the customer deletes while its purchase is unresolved is not retired while the checkout may still settle; a payment that
//      arrives for it (deleting or deleted, entitlement 'pending') becomes a refund obligation, acknowledged in the same batch.
//   #3 a deleted home's retained first payment stays requestable by its owner.
//   #4 an open, parked cancellation resolution is read hourly (read-only) before its promised end.
//   #5 a locally canceled plan whose external end is still pending is "ended, unconfirmed", never "no further charge".
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { fakeProvider, type ProviderAdapter } from "../src/b3-provider";
import { noFurtherCharge, planEndSentence, planEndState, type BillingDependencies } from "../src/b5-billing";
import { resolveCancellations } from "../src/public-cancellation";
import type { StripeClient } from "../src/b5-stripe";
import { consentFor, seedPendingQuotes } from "./legal-helpers";
import { customerFake } from "./stripe-customer-fake";

const ADMIN = "test-only-integrated1-admin-no-real-access";
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const USER = "int1-user";
const OTHER = "int1-other";
const IMAGE = `sha256:${"a".repeat(64)}`;
const B3 = { reservationMs: 30 * 60_000, graceMs: 3 * DAY, retentionMs: 14 * DAY, imageDigest: IMAGE, quarantineRelayIP: "192.0.2.20",
  engineSubscriptionGates: { claudeAgent: true, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: true },
  capacity: [1, 2].map((n) => ({ id: `slot-${n}`, projectId: "p1", location: "fsn1", serverType: "cx23", outcome: "available" })) };
const baseEnv = (): Env => ({ ...env, CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_KEK_V1: btoa("x".repeat(32)), CLOUD_B3_MODE: "fake", CLOUD_B3_CONFIG: JSON.stringify(B3),
  CLOUD_HOME_HOST_SUFFIX: "murage.test", CLOUD_HOME_ZONE_ID: "0".repeat(32), CLOUD_HOME_ACCOUNT_ID: "0".repeat(32), CLOUD_HOME_API_TOKEN: "test-only-cloud-home-token-no-access",
  STRIPE_SECRET_KEY: "sk_test_fixturefixturefixture", STRIPE_WEBHOOK_SECRET: "whsec_testonlyfixturesecret0123456789", BILLING_RETURN_ORIGIN: "https://cloud.murage.test",
  STRIPE_PRICE_STARTER: "price_starter0001", STRIPE_PRICE_PRO: "price_pro00000001", STRIPE_PRICE_MAX: "price_max000000001" } as unknown as Env);

let signedIn: string | null;
let listed: string[];
let intakeQuote: BillingDependencies["refundIntakeQuote"] | undefined;
const cust = customerFake();
const stripeFetch = async (input: string | URL | Request) => {
  // The customer preset (Astra TAXCOUNTRY-1): customers persisted by a shared fake.
  { const cr = await cust.handle("GET", new URL(String(input)), new URLSearchParams(String(""))); if (cr) return cr; }
  const path = new URL(String(input)).pathname;
  const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
  if (path === "/v1/customers") return j({ id: "cus_int1" });
  if (path === "/v1/checkout/sessions") return j({ id: "cs_test_int1", url: "https://checkout.stripe.test/c/cs_test_int1" });
  return new Response("{}", { status: 500 });
};
const deps = (): BillingDependencies => ({ stripeFetch, accountUser: async () => (signedIn ? { id: signedIn } : null), stepUp: async () => true,
  ...(intakeQuote ? { refundIntakeQuote: intakeQuote } : {}) });
/** The fake provider, noting every list_by_tag so a test can see the destruction phase of a deletion was reached. */
const provider = (db: D1Database): ProviderAdapter => {
  const p = fakeProvider(db);
  return { ...p, list_by_tag: async (...a: Parameters<ProviderAdapter["list_by_tag"]>) => { listed.push(String(a[0])); return p.list_by_tag(...a); } };
};
async function send(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  await seedPendingQuotes();
  const ctx = createExecutionContext();
  const response = await createWorker(fetch, fetch, { provider }, {}, deps()).fetch(new Request(`https://admin.murage.test${path}`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.10", ...headers } }), baseEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const reconcile = () => send("/v1/fake-b3/reconcile", {}, { authorization: `Bearer ${ADMIN}` });
const count = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n;

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  signedIn = USER; listed = []; intakeQuote = undefined;
  for (const id of [USER, OTHER]) {
    await env.DB.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, 'I',?,1,?,?)`).bind(id, `${id}@example.test`, NOW, NOW).run();
  }
});
afterEach(() => vi.restoreAllMocks());

// ---- #2 ------------------------------------------------------------------------------------------------------------------------------

describe("INTEGRATED-1 #2: a home deleted while its purchase is unresolved is retired only on settlement evidence; a payment for it is owed back", () => {
  /** A reserved home with a submitted checkout: a Stripe session id, no contract made, no expiry (CHECKOUT_MAY_SETTLE_SQL holds), no subscription id yet. */
  async function unresolvedPurchase(): Promise<string> {
    const { homeId } = await (await send("/v1/billing/reserve")).json() as { homeId: string };
    expect((await send("/v1/billing/checkout", { plan: "pro", consent: consentFor("pro", Date.now()) })).status).toBe(200);
    const c = (await env.DB.prepare("SELECT stripe_session_id,contract_made_at,session_expired_at FROM checkout_consents WHERE home_id=?").bind(homeId)
      .first<{ stripe_session_id: string | null; contract_made_at: number | null; session_expired_at: number | null }>())!;
    expect(c.stripe_session_id).not.toBeNull();
    expect(c.contract_made_at).toBeNull();
    expect(c.session_expired_at).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM billing_subscriptions WHERE home_id=? AND subscription_id IS NOT NULL", homeId)).toBe(0);
    expect((await state(homeId)).entitlement).toBe("pending");
    return homeId;
  }
  const state = (homeId: string) => env.DB.prepare("SELECT desired_state,entitlement FROM cloud_homes WHERE id=?").bind(homeId).first<{ desired_state: string; entitlement: string }>().then((r) => r!);
  /** The customer's delete, completed: the hold has run, DNS came off more than its TTL ago, the sweep is at the destruction step. */
  const deleting = (homeId: string) => env.DB.prepare("UPDATE cloud_homes SET desired_state='deleting',observed_state='deleting',dns_removed_at=? WHERE id=?").bind(NOW - 120_000, homeId).run();
  const deleted = (homeId: string) => env.DB.prepare("UPDATE cloud_homes SET desired_state='deleted',observed_state='deleted' WHERE id=?").bind(homeId).run();
  const paidEntry = (homeId: string, eventId: string, version: number, paymentId: string) => env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)")
    .bind(eventId, homeId, version, JSON.stringify({ eventId, homeId, version, status: "paid", paymentId }), Date.now()).run();
  const owed = (homeId: string) => env.DB.prepare("SELECT id,payload,completed_at FROM cloud_outbox WHERE home_id=? AND kind='refund_required' ORDER BY id")
    .bind(homeId).all<{ id: string; payload: string; completed_at: number | null }>().then((r) => r.results);

  it("the probe: the destruction runs, but the home stays 'deleting' while its checkout may still settle, however long; it is retired once the session expired", async () => {
    const homeId = await unresolvedPurchase();
    await deleting(homeId);
    expect((await reconcile()).status).toBe(200);
    expect(listed).toContain(homeId);                       // its resources were looked up for destruction
    expect((await state(homeId)).desired_state).toBe("deleting");
    vi.mocked(Date.now).mockReturnValue(NOW + 30 * DAY);   // age alone never retires it
    expect((await reconcile()).status).toBe(200);
    expect((await state(homeId)).desired_state).toBe("deleting");
    // Stripe's confirmed expiry of the session is the settlement evidence.
    await env.DB.prepare("UPDATE checkout_consents SET session_expired_at=? WHERE home_id=?").bind(Date.now(), homeId).run();
    expect((await reconcile()).status).toBe(200);
    expect((await state(homeId)).desired_state).toBe("deleted");
  });

  it("a paid entry arriving for the 'deleting' home becomes refund:retired:<paymentId>, acknowledged in the same sweep, and the home is still not retired", async () => {
    const homeId = await unresolvedPurchase();
    await deleting(homeId);
    await paidEntry(homeId, "evt_int1_a", 5, "in_int1_a");
    expect((await reconcile()).status).toBe(200);
    const rows = await owed(homeId);
    expect(rows.map((r) => r.id)).toEqual(["refund:retired:in_int1_a"]);
    expect(JSON.parse(rows[0].payload)).toMatchObject({ homeId, paymentId: "in_int1_a", status: "paid", version: 5 });
    // Acknowledged, with its obligation (never without it).
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE id='evt_int1_a' AND processed_at IS NOT NULL")).toBe(1);
    // The fake refund ran in the same sweep: the entitlement went refund_pending, then refunded; the obligation is completed.
    expect(await count("SELECT COUNT(*) AS n FROM cloud_fake_refunds WHERE payment_id='in_int1_a'")).toBe(1);
    expect(rows[0].completed_at).not.toBeNull();
    expect(await state(homeId)).toEqual({ desired_state: "deleting", entitlement: "refunded" });
    // The checkout has now been paid: no longer able to settle, so the deletion finishes.
    await env.DB.prepare("UPDATE checkout_consents SET contract_made_at=?,completed_at=?,paid_at=? WHERE home_id=?").bind(NOW, NOW, NOW, homeId).run();
    expect((await reconcile()).status).toBe(200);
    expect(await state(homeId)).toEqual({ desired_state: "deleted", entitlement: "refunded" });
  });

  it("a paid entry arriving for an already 'deleted' home with entitlement 'pending' is owed back too; a replay adds nothing", async () => {
    const homeId = await unresolvedPurchase();
    await deleted(homeId);
    await paidEntry(homeId, "evt_int1_b", 7, "in_int1_b");
    expect((await reconcile()).status).toBe(200);
    expect((await owed(homeId)).map((r) => r.id)).toEqual(["refund:retired:in_int1_b"]);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE id='evt_int1_b' AND processed_at IS NOT NULL")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_fake_refunds WHERE payment_id='in_int1_b'")).toBe(1);
    expect(await state(homeId)).toEqual({ desired_state: "deleted", entitlement: "refunded" });
    await paidEntry(homeId, "evt_int1_b_replay", 8, "in_int1_b");
    expect((await reconcile()).status).toBe(200);
    expect((await owed(homeId)).map((r) => r.id)).toEqual(["refund:retired:in_int1_b"]);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE id='evt_int1_b_replay' AND processed_at IS NOT NULL")).toBe(1);
  });

  it("a payment billing already voided is acknowledged with no obligation (billing refunds it itself)", async () => {
    const homeId = await unresolvedPurchase();
    await deleted(homeId);
    await env.DB.prepare("INSERT INTO cloud_payment_voids (home_id,payment_id,reason,ref,voided_at) VALUES (?,?,?,?,?)").bind(homeId, "in_int1_v", "test", "ref", NOW).run();
    await paidEntry(homeId, "evt_int1_v", 9, "in_int1_v");
    expect((await reconcile()).status).toBe(200);
    expect(await owed(homeId)).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE id='evt_int1_v' AND processed_at IS NOT NULL")).toBe(1);
  });
});

// ---- #3 ------------------------------------------------------------------------------------------------------------------------------

describe("INTEGRATED-1 #3: a deleted home's retained first payment is requestable by its owner", () => {
  const PAID_AT = NOW - 4 * DAY;
  beforeEach(async () => {
    await env.DB.prepare(`INSERT INTO installations (id,owner_user_id,client_instance_id,display_name,platform,created_at,updated_at)
      VALUES ('12345678-1234-4123-8123-123456789099',?,'12345678-1234-4123-8123-123456789099','I','linux',?,?)`).bind(USER, NOW, NOW).run();
    await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,entitlement,payment_version,image_digest,home_key,created_at,updated_at)
      VALUES ('home-gone','12345678-1234-4123-8123-123456789099',?,'deleted','deleted','paid',1,?,'k',?,?)`).bind(USER, IMAGE, PAID_AT, NOW - DAY).run();
    await env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,first_invoice_id,first_paid_at,first_invoice_cents,first_invoice_tax_cents,
        first_period_start,first_period_end,first_payment_intent,created_at,updated_at)
      VALUES ('home-gone','cus_gone','sub_gone','pro','canceled','in_gone',?,9900,0,?,?,'pi_gone',?,?)`)
      .bind(PAID_AT, PAID_AT, PAID_AT + 30 * DAY, PAID_AT, NOW - DAY).run();
    intakeQuote = async () => ({ eligible: true, reason: null, windowEndsAt: PAID_AT + 7 * DAY });
  });

  it("the owner's request is recorded (201) against that payment and home, with the payment pinned; asking again returns the same request", async () => {
    const res = await send("/v1/account/refund-request", {});
    expect(res.status).toBe(201);
    const body = await res.json<{ requestId: string }>();
    expect(body.requestId).toMatch(/^rr-/);
    const row = (await env.DB.prepare("SELECT * FROM refund_requests WHERE id=?").bind(body.requestId).first<Record<string, unknown>>())!;
    expect(row).toMatchObject({ user_id: USER, home_id: "home-gone", payment_key: "in_gone", subscription_id: "sub_gone" });
    expect(JSON.parse(String(row.payment_snapshot))).toMatchObject({ invoiceId: "in_gone", paidCents: 9900, paidAt: PAID_AT });
    const again = await send("/v1/account/refund-request", {});
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ requestId: body.requestId, alreadyRequested: true });
    expect(await count("SELECT COUNT(*) AS n FROM refund_requests")).toBe(1);
  });

  it("another user, who owns no payment, still gets 409 no_first_payment and nothing is recorded", async () => {
    signedIn = OTHER;
    const res = await send("/v1/account/refund-request", {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "no_first_payment" });
    expect(await count("SELECT COUNT(*) AS n FROM refund_requests")).toBe(0);
  });
});

// ---- #4 ------------------------------------------------------------------------------------------------------------------------------

describe("INTEGRATED-1 #4: an open parked cancellation resolution is read hourly, read-only, before its promised end", () => {
  const SUB = "sub_int1_park";
  let gets: string[];
  let writes: string[];
  let schedule: string | null;
  /** Stripe as a fixture: only reads exist; any other method is a write and fails the test (it is recorded and refused). */
  const stripe = new Proxy({}, { get: (_t, name: string) => {
    if (name === "getSubscription") return async (id: string) => { gets.push(id);
      return { id, status: "active", cancel_at_period_end: false, current_period_start: (NOW - 10 * DAY) / 1000, current_period_end: (NOW + 30 * DAY) / 1000, schedule }; };
    return async () => { writes.push(name); throw new Error(`unexpected stripe call ${name}`); };
  } }) as unknown as StripeClient;
  const row = () => env.DB.prepare("SELECT schedule_id,state,attempts,next_attempt_at FROM cancel_resolutions WHERE subscription_id=?").bind(SUB)
    .first<{ schedule_id: string | null; state: string; attempts: number; next_attempt_at: number }>().then((r) => r!);
  const alerts = () => count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='cancel.schedule_attached' AND id=?", `cancel.schedule_attached:${SUB}`);
  const resolve = (at: number) => resolveCancellations(baseEnv(), { stripe, now: () => at });

  beforeEach(async () => {
    gets = []; writes = []; schedule = "sub_sched_int1";
    await env.DB.prepare(`INSERT INTO cancel_resolutions (subscription_id,home_id,source,generation,promised_end_at,due_at,schedule_id,state,attempts,next_attempt_at,created_at)
      VALUES (?, 'home-int1','in_app','in_app:1',?,?,'sub_sched_int1','open',0,?,?)`).bind(SUB, NOW + 30 * DAY, NOW + 30 * DAY, NOW - 1000, NOW - DAY).run();
  });

  it("with the schedule still attached: one read, the alert re-raised, due again in an hour, and NO write of any kind", async () => {
    await resolve(NOW);
    expect(gets).toEqual([SUB]);                   // before the fix: zero Stripe reads
    expect(writes).toEqual([]);                    // no DELETE / cancel / update
    expect(await row()).toMatchObject({ schedule_id: "sub_sched_int1", state: "open", attempts: 0, next_attempt_at: NOW + HOUR });
    expect(await alerts()).toBe(1);
    // Not due again until that hour has passed.
    await resolve(NOW + 30 * 60_000);
    expect(gets).toEqual([SUB]);
    await resolve(NOW + HOUR);
    expect(gets).toEqual([SUB, SUB]);
    expect(writes).toEqual([]);
    expect(await row()).toMatchObject({ schedule_id: "sub_sched_int1", next_attempt_at: NOW + 2 * HOUR });
  });

  it("with the schedule gone: the parking is cleared, the row stays open for its date, and still no destructive call is made before it", async () => {
    schedule = null;
    await resolve(NOW);
    expect(gets).toEqual([SUB]);
    expect(writes).toEqual([]);
    const r = await row();
    expect(r.schedule_id).toBeNull();
    expect(r.state).toBe("open");
    // Not due before its promised end less the precision window: later passes read and write nothing.
    await resolve(NOW + 2 * HOUR);
    expect(writes).toEqual([]);
    expect((await row()).state).toBe("open");
  });
});

// ---- #5 ------------------------------------------------------------------------------------------------------------------------------

describe("INTEGRATED-1 #5: a locally canceled plan whose external end is pending reads 'ended, unconfirmed', never 'no further charge'", () => {
  const SUBID = "sub_int1_end";
  const HOME = "home-int1-end";
  beforeEach(async () => {
    await env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at) VALUES (?,?,?,?,'canceled',?,?)`)
      .bind(HOME, "cus_int1", SUBID, "pro", NOW - 10 * DAY, NOW - DAY).run();
  });
  const park = () => env.DB.prepare(`INSERT INTO cancel_resolutions (subscription_id,home_id,source,generation,promised_end_at,due_at,schedule_id,state,next_attempt_at,created_at)
    VALUES (?,?,'in_app','in_app:1',?,?,'sub_sched_end','open',?,?)`).bind(SUBID, HOME, NOW + 5 * DAY, NOW + 5 * DAY, NOW + HOUR, NOW).run();
  const refundOp = (id: string) => env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,end_plan,subscription_id,created_at,updated_at)
    VALUES (?,'withdrawal',?,?, 'in_end',1,?,?,?)`).bind(id, HOME, USER, SUBID, NOW, NOW).run();

  // INTEGRATED-2 RULE A: confirmed only by THE Stripe-end checkpoint (stripe_end_confirmed), set from Stripe's terminal evidence.
  const stripeEnded = () => env.DB.prepare("UPDATE billing_subscriptions SET stripe_end_confirmed=subscription_id WHERE home_id=?").bind(HOME).run();
  it("parked: ended, confirmed false; noFurtherCharge false; the sentence says it is still being confirmed; only Stripe's end confirms it", async () => {
    await park();
    const p = await planEndState(baseEnv(), HOME);
    expect(p).toMatchObject({ state: "ended", confirmed: false });
    expect(noFurtherCharge(p)).toBe(false);
    expect(planEndSentence(p)).toContain("We are still confirming this with our payment provider");
    await env.DB.prepare("UPDATE cancel_resolutions SET schedule_id=NULL WHERE subscription_id=?").bind(SUBID).run();
    expect(await planEndState(baseEnv(), HOME)).toMatchObject({ state: "ended", confirmed: false }); // unparked is not Stripe's end
    await stripeEnded();
    const after = await planEndState(baseEnv(), HOME);
    expect(after).toMatchObject({ state: "ended", confirmed: true });
    expect(noFurtherCharge(after)).toBe(true);
    expect(planEndSentence(after)).not.toContain("still confirming");
  });

  it("a refund operation that ends the plan and has not done so (canceled_at and done_at empty): the same unconfirmed answer; Stripe's end confirms it", async () => {
    await refundOp("op-int1-end");
    const p = await planEndState(baseEnv(), HOME);
    expect(p).toMatchObject({ state: "ended", confirmed: false });
    expect(noFurtherCharge(p)).toBe(false);
    expect(planEndSentence(p)).toContain("We are still confirming this with our payment provider");
    await env.DB.prepare("UPDATE refund_ops SET canceled_at=? WHERE id='op-int1-end'").bind(NOW).run();
    expect(await planEndState(baseEnv(), HOME)).toMatchObject({ state: "ended", confirmed: false }); // a local stamp is not Stripe's end
    await stripeEnded();
    expect(await planEndState(baseEnv(), HOME)).toMatchObject({ state: "ended", confirmed: true });
  });

  it("Stripe's end recorded: ended and confirmed, no further charge, and the plain 'Your plan has ended' sentence", async () => {
    expect(await planEndState(baseEnv(), HOME)).toMatchObject({ state: "ended", confirmed: false }); // nothing pending is not Stripe's end either
    await stripeEnded();
    const p = await planEndState(baseEnv(), HOME);
    expect(p).toMatchObject({ state: "ended", confirmed: true });
    expect(noFurtherCharge(p)).toBe(true);
    expect(planEndSentence(p)).toMatch(/^Your plan has ended\./);
  });
});
