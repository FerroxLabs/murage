// SPDX-License-Identifier: AGPL-3.0-or-later
// User-scoped reserve: the portal calls POST /v1/billing/reserve for a signed-in, 2FA-stepped-up customer.
// One pending reservation per user, unpaid ones lapse, a late payment is never orphaned. Real workerd + D1, no network.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { fakeProvider, type ProviderAdapter } from "../src/b3-provider";
import type { BillingDependencies } from "../src/b5-billing";
import { consentFor, seedPendingQuotes } from "./legal-helpers";
import { customerFake } from "./stripe-customer-fake";

const ADMIN = "test-only-b5-admin-no-real-access";
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const USER = "reserve-user";
const OTHER = "reserve-other";
const IMAGE = `sha256:${"a".repeat(64)}`;
const slot = (n: number) => ({ id: `slot-${n}`, projectId: "p1", location: "fsn1", serverType: "cx23", outcome: "available" });
const B3 = (slots = 2) => ({ reservationMs: 30 * 60_000, graceMs: 3 * 86_400_000, retentionMs: 14 * 86_400_000, imageDigest: IMAGE, quarantineRelayIP: "192.0.2.20",
  engineSubscriptionGates: { claudeAgent: true, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: true },
  capacity: Array.from({ length: slots }, (_, i) => slot(i + 1)) });
let slots = 2; let b3Mode: string | undefined = "fake"; let dbOver: D1Database | null = null;
const baseEnv = (): Env => ({ ...env, ...(dbOver ? { DB: dbOver } : {}), CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_KEK_V1: btoa("x".repeat(32)), CLOUD_B3_MODE: b3Mode, CLOUD_B3_CONFIG: JSON.stringify(B3(slots)),
  CLOUD_HOME_HOST_SUFFIX: "murage.test", CLOUD_HOME_ZONE_ID: "0".repeat(32), CLOUD_HOME_ACCOUNT_ID: "0".repeat(32), CLOUD_HOME_API_TOKEN: "test-only-cloud-home-token-no-access",
  STRIPE_SECRET_KEY: "sk_test_fixturefixturefixture", STRIPE_WEBHOOK_SECRET: "whsec_testonlyfixturesecret0123456789", BILLING_RETURN_ORIGIN: "https://cloud.murage.test",
  STRIPE_PRICE_STARTER: "price_starter0001", STRIPE_PRICE_PRO: "price_pro00000001", STRIPE_PRICE_MAX: "price_max000000001" } as unknown as Env);

let signedIn: string | null; let stepped: boolean;
const cust = customerFake();
const stripeFetch = async (input: string | URL | Request) => {
  // The customer preset (Astra TAXCOUNTRY-1): customers persisted by a shared fake.
  { const cr = await cust.handle("GET", new URL(String(input)), new URLSearchParams(String(""))); if (cr) return cr; }
  const path = new URL(String(input)).pathname;
  const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
  if (path === "/v1/customers") return j({ id: "cus_reserve1" });
  if (path === "/v1/checkout/sessions") return j({ id: "cs_test_r1", url: "https://checkout.stripe.test/c/cs_test_r1" });
  return new Response("{}", { status: 500 });
};
const deps = (): BillingDependencies => ({ stripeFetch, accountUser: async () => (signedIn ? { id: signedIn } : null), stepUp: async () => stepped });
const provider = (db: D1Database): ProviderAdapter => fakeProvider(db);
async function send(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  await seedPendingQuotes();
  const ctx = createExecutionContext();
  const response = await createWorker(fetch, fetch, { provider }, {}, deps()).fetch(new Request(`https://admin.murage.test${path}`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.10", ...headers } }), baseEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const reserve = () => send("/v1/billing/reserve");
const reconcile = () => send("/v1/fake-b3/reconcile", {}, { authorization: `Bearer ${ADMIN}` });
const count = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n;
const pendingFor = (user: string) => count("SELECT COUNT(*) AS n FROM cloud_homes WHERE owner_id=? AND desired_state='payment_pending'", user);
const setNow = (ms: number) => vi.spyOn(Date, "now").mockReturnValue(ms);

beforeEach(async () => {
  setNow(NOW); signedIn = USER; stepped = true; slots = 2; b3Mode = "fake"; dbOver = null;
  for (const id of [USER, OTHER]) {
    await env.DB.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, 'R',?,1,?,?)`).bind(id, `${id}@example.test`, NOW, NOW).run();
  }
});
afterEach(() => vi.restoreAllMocks());

describe("POST /v1/billing/reserve", () => {
  it("is sign-in only (one purchase = at most one emailed code, at checkout): no second step asked, and never a second pending home", async () => {
    stepped = false;
    const first = await reserve();
    expect(first.status).toBe(201);
    const { homeId } = await first.json<{ homeId: string }>();
    const again = await reserve();
    expect([again.status, await again.json()]).toEqual([200, expect.objectContaining({ homeId, existing: true })]);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_homes")).toBe(1);
  });
  it("refuses an anonymous caller and a deployment without cloud homes", async () => {
    signedIn = null;
    expect((await reserve()).status).toBe(401);
    signedIn = USER; b3Mode = undefined;
    expect((await reserve()).status).toBe(404);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_homes")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM installations")).toBe(0);
  });

  it("gives the signed-in user a payable home with a managed endpoint, owned by them, never by anything in the request", async () => {
    const res = await send("/v1/billing/reserve", { ownerId: OTHER, homeId: "evil", installationId: "x" });
    expect(res.status).toBe(201);
    const body = await res.json() as { homeId: string; state: string; expiresAt: number; existing: boolean };
    expect(body).toMatchObject({ state: "payment_pending", expiresAt: NOW + 30 * 60_000, existing: false });
    expect(body.homeId).toMatch(/^home-[0-9a-f]{24}$/);
    const home = await env.DB.prepare("SELECT owner_id,desired_state,entitlement FROM cloud_homes WHERE id=?").bind(body.homeId).first();
    expect(home).toEqual({ owner_id: USER, desired_state: "payment_pending", entitlement: "pending" });
    expect(await count("SELECT COUNT(*) AS n FROM machine_endpoints WHERE machine_id=? AND status='pending' AND hostname LIKE 'h-%.murage.test'", body.homeId)).toBe(1);
    expect(await pendingFor(OTHER)).toBe(0);
  });

  it("allows one pending reservation per user: a repeat, and concurrent calls, get the same home", async () => {
    const first = await (await reserve()).json() as { homeId: string };
    const again = await reserve();
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ homeId: first.homeId, existing: true });
    const raced = await Promise.all([reserve(), reserve(), reserve()]);
    for (const r of raced) expect([200, 201]).toContain(r.status);
    expect(await pendingFor(USER)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_homes WHERE owner_id=?", USER)).toBe(1);
    // Another user is unaffected.
    signedIn = OTHER;
    expect((await reserve()).status).toBe(201);
    expect(await pendingFor(OTHER)).toBe(1);
  });

  it("races on a fresh user still leave exactly one pending home", async () => {
    signedIn = OTHER;
    const results = await Promise.all([reserve(), reserve(), reserve(), reserve()]);
    const ids = new Set<string>();
    for (const r of results) { expect([200, 201]).toContain(r.status); ids.add(((await r.json()) as { homeId: string }).homeId); }
    expect(ids.size).toBe(1);
    expect(await pendingFor(OTHER)).toBe(1);
  });

  it("the reserved home is the one checkout bills, through the same user session", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    const checkout = await send("/v1/billing/checkout", { plan: "pro", consent: consentFor("pro", Date.now()) });
    expect(checkout.status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM billing_subscriptions WHERE home_id=? AND plan='pro'", homeId)).toBe(1);
  });

  it("answers 202 and creates no home when there is no capacity", async () => {
    slots = 1;
    signedIn = OTHER;
    expect((await reserve()).status).toBe(201);
    signedIn = USER;
    const waitlisted = await reserve();
    expect(waitlisted.status).toBe(202);
    expect(await waitlisted.json()).toMatchObject({ state: "waitlisted", checkoutAllowed: false });
    expect(await count("SELECT COUNT(*) AS n FROM cloud_homes WHERE owner_id=?", USER)).toBe(0);
    expect((await send("/v1/billing/checkout", { plan: "pro", consent: consentFor("pro", Date.now()) })).status).toBe(404);
  });

  it("refuses a second home while the first is live", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='ready',entitlement='paid' WHERE id=?").bind(homeId).run();
    const res = await reserve();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "home_exists", reason: "already_have_home" });
  });
});

describe("unpaid reservations lapse", () => {
  const stateOf = (id: string) => env.DB.prepare("SELECT desired_state,observed_state FROM cloud_homes WHERE id=?").bind(id).first();

  it("the cron sweep deletes an expired unpaid reservation, frees its slot and endpoint name, and the user can start again", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    expect(await count("SELECT COUNT(*) AS n FROM cloud_capacity WHERE home_id=?", homeId)).toBe(1);
    setNow(NOW + 29 * 60_000);
    expect((await reconcile()).status).toBe(200);
    expect((await stateOf(homeId))!.desired_state).toBe("payment_pending"); // not yet
    setNow(NOW + 31 * 60_000);
    expect((await reconcile()).status).toBe(200);
    expect(await stateOf(homeId)).toEqual({ desired_state: "deleted", observed_state: "deleted" });
    expect(await count("SELECT COUNT(*) AS n FROM cloud_capacity WHERE home_id=?", homeId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM machine_endpoints WHERE machine_id=?", homeId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE home_id=? AND kind='reservation_expired' AND completed_at IS NOT NULL", homeId)).toBe(1);
    const fresh = await reserve();
    expect(fresh.status).toBe(201);
    expect((await fresh.json() as { homeId: string }).homeId).not.toBe(homeId);
  });

  it("a reserve call itself retires that user's expired reservation before looking for a pending one", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    setNow(NOW + 40 * 60_000);
    const fresh = await (await reserve()).json() as { homeId: string; existing: boolean };
    expect(fresh.existing).toBe(false);
    expect(fresh.homeId).not.toBe(homeId);
    expect((await stateOf(homeId))!.desired_state).toBe("deleted");
    expect(await pendingFor(USER)).toBe(1);
  });

  it("does not delete a reservation whose checkout could still complete, nor one that has a subscription", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    expect((await send("/v1/billing/checkout", { plan: "starter", consent: consentFor("starter", Date.now()) })).status).toBe(200);
    setNow(NOW + 3 * HOUR); // reservation long past, Stripe's checkout page still open
    expect((await reconcile()).status).toBe(200);
    expect((await stateOf(homeId))!.desired_state).toBe("payment_pending");
    await env.DB.prepare("UPDATE billing_subscriptions SET subscription_id='sub_reserve1' WHERE home_id=?").bind(homeId).run();
    setNow(NOW + 48 * HOUR);
    expect((await reconcile()).status).toBe(200);
    expect((await stateOf(homeId))!.desired_state).toBe("payment_pending"); // a paid event must still find its home
  });

  it("an abandoned checkout (no subscription) lapses once the Stripe session can no longer complete", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    expect((await send("/v1/billing/checkout", { plan: "starter", consent: consentFor("starter", Date.now()) })).status).toBe(200);
    setNow(NOW + 26 * HOUR);
    expect((await reconcile()).status).toBe(200);
    expect((await stateOf(homeId))!.desired_state).toBe("deleted");
  });

  it("leaves an unprocessed payment alone", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    await env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES ('evt-late',?,1,'{}',?,NULL)").bind(homeId, NOW).run();
    // The expiry query itself must skip a home with an unprocessed payment (the fixture payload is not a real payment).
    const { expireReservations } = await import("../src/b3-control");
    expect(await expireReservations(env, NOW + 3 * HOUR)).toBe(0);
    expect((await stateOf(homeId))!.desired_state).toBe("payment_pending");
  });
});

describe("journey A6: a failed setup whose payment was refunded no longer blocks a new reservation", () => {
  const failHome = async (homeId: string, entitlement: string) => {
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='failed',observed_state='failed',entitlement=? WHERE id=?").bind(entitlement, homeId).run();
  };
  it("while the refund is pending the 409 says so in plain words; once it is recorded the home is deleted and a new reservation works", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    await failHome(homeId, "refund_pending");
    let res = await reserve();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "home_exists", reason: "setup_failed_refund_pending", action: "try_again_later",
      message: expect.stringContaining("being refunded") });
    expect((await reconcile()).status).toBe(200);
    expect(await env.DB.prepare("SELECT desired_state FROM cloud_homes WHERE id=?").bind(homeId).first()).toEqual({ desired_state: "failed" }); // still waiting for the refund
    expect((await reserve()).status).toBe(409);
    await failHome(homeId, "refunded"); // the refund path records the receipt
    expect((await reconcile()).status).toBe(200);
    expect(await env.DB.prepare("SELECT desired_state,observed_state FROM cloud_homes WHERE id=?").bind(homeId).first()).toEqual({ desired_state: "deleted", observed_state: "deleted" });
    res = await reserve();
    expect(res.status).toBe(201);
    const next = await res.json() as { homeId: string; state: string };
    expect(next.homeId).not.toBe(homeId);
    expect(next.state).toBe("payment_pending");
  });
  it("a refunded failed home is retired once its resources are released; a voided payment alone does not retire a failed home still waiting for a payment", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    await failHome(homeId, "refunded");
    await env.DB.prepare("INSERT INTO provision_attempts (home_id,resource_generation,attempts,first_at,next_at,gave_up_at) VALUES (?,1,3,?,0,?)").bind(homeId, NOW, NOW).run();
    expect((await reconcile()).status).toBe(200);
    expect(await env.DB.prepare("SELECT cleaned_at FROM provision_attempts WHERE home_id=?").bind(homeId).first()).toEqual({ cleaned_at: NOW }); // reconcile released the fake resources...
    expect(await env.DB.prepare("SELECT desired_state FROM cloud_homes WHERE id=?").bind(homeId).first()).toEqual({ desired_state: "deleted" }); // ...then retired the home
    const second = await (await reserve()).json() as { homeId: string };
    await failHome(second.homeId, "pending");
    await env.DB.prepare("INSERT INTO cloud_payment_voids (home_id,payment_id,reason,ref,voided_at) VALUES (?,?,?,?,?)").bind(second.homeId, "in_void", "test", "ref", NOW).run();
    expect((await reconcile()).status).toBe(200);
    expect(await env.DB.prepare("SELECT desired_state FROM cloud_homes WHERE id=?").bind(second.homeId).first()).toEqual({ desired_state: "failed" });
  });
  it("a live home keeps its plain 409, with what to do next", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='ready',entitlement='paid' WHERE id=?").bind(homeId).run();
    const res = await reserve();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "home_exists", reason: "already_have_home", action: "open_my_cloud", message: expect.stringContaining("already have a Murage Cloud server") });
    expect((await reconcile()).status).toBe(200);
    expect(await env.DB.prepare("SELECT desired_state FROM cloud_homes WHERE id=?").bind(homeId).first()).toEqual({ desired_state: "ready" });
  });
});

describe("journey A6 (Astra JOURNEY-A-1): retiring a refunded failed home never discards a payment that can still settle", () => {
  const failHome = async (homeId: string, entitlement: string) => {
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='failed',observed_state='failed',entitlement=? WHERE id=?").bind(entitlement, homeId).run();
  };
  const paidEntry = (homeId: string, eventId: string, version: number, paymentId: string) => env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)")
    .bind(eventId, homeId, version, JSON.stringify({ eventId, homeId, version, status: "paid", paymentId }), NOW).run();
  const stateOf = (homeId: string) => env.DB.prepare("SELECT desired_state,entitlement FROM cloud_homes WHERE id=?").bind(homeId).first<{ desired_state: string; entitlement: string }>();
  const refundOwed = (homeId: string, paymentId: string) => count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE home_id=? AND kind='refund_required' AND payload LIKE ?", homeId, `%${paymentId}%`);
  /** env.DB on which `before` runs once, just before the first statement or batch whose SQL contains `match`. */
  const raceDb = (match: string, before: () => Promise<unknown>): D1Database => {
    let armed = true;
    const fire = async (sql: string) => { if (armed && sql.includes(match)) { armed = false; await before(); } };
    type Stmt = D1PreparedStatement & { __real?: D1PreparedStatement; __sql?: string };
    const wrap = (stmt: D1PreparedStatement, sql: string): Stmt => new Proxy(stmt as Stmt, { get(t, k) {
      if (k === "__real") return t;
      if (k === "__sql") return sql;
      if (k === "bind") return (...a: unknown[]) => wrap(t.bind(...a), sql);
      if (k === "run" || k === "first" || k === "all" || k === "raw") return async (...a: unknown[]) => { await fire(sql); return (t as unknown as Record<string, (...x: unknown[]) => unknown>)[k as string](...a); };
      const v = (t as unknown as Record<string | symbol, unknown>)[k]; return typeof v === "function" ? v.bind(t) : v;
    } });
    return new Proxy(env.DB, { get(t, k) {
      if (k === "withSession") return undefined;
      if (k === "prepare") return (sql: string) => wrap(t.prepare(sql), sql);
      if (k === "batch") return async (st: Stmt[]) => { await fire(st.map((x) => x.__sql ?? "").join(";\n")); return t.batch(st.map((x) => x.__real ?? x)); };
      const v = (t as unknown as Record<string | symbol, unknown>)[k]; return typeof v === "function" ? v.bind(t) : v;
    } });
  };

  it("a newer paid entry that lands after the drain, just before the retirement write, keeps the home: it provisions or is refunded", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    await failHome(homeId, "refunded");
    dbOver = raceDb("AND entitlement='refunded'", () => paidEntry(homeId, "evt_late_paid_1", 5, "in_late_1"));
    expect((await reconcile()).status).toBe(200);
    dbOver = null;
    expect((await stateOf(homeId))!.desired_state).toBe("failed"); // not retired: a payment is waiting
    expect((await reconcile()).status).toBe(200);
    const after = (await stateOf(homeId))!;
    const provisions = after.entitlement === "paid" && ["provisioning", "checking", "ready"].includes(after.desired_state);
    expect(provisions || await refundOwed(homeId, "in_late_1") === 1).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE id='evt_late_paid_1' AND processed_at IS NOT NULL")).toBe(1);
  });
  it("a paid entry for a home already retired becomes a refund obligation, never an acknowledgement with no effect", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    await failHome(homeId, "refunded");
    expect((await reconcile()).status).toBe(200);
    expect((await stateOf(homeId))!.desired_state).toBe("deleted");
    await paidEntry(homeId, "evt_after_retire", 7, "in_after_retire");
    expect((await reconcile()).status).toBe(200);
    expect(await refundOwed(homeId, "in_after_retire")).toBe(1);
    expect(await stateOf(homeId)).toEqual({ desired_state: "deleted", entitlement: "refunded" }); // the fake ledger settled the new refund too
    expect(await count("SELECT COUNT(*) AS n FROM cloud_fake_refunds WHERE payment_id='in_after_retire'")).toBe(1);
  });
  it("a checkout of the home that could still complete keeps it from being retired until the checkout can no longer settle", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    expect((await send("/v1/billing/checkout", { plan: "pro", consent: consentFor("pro", Date.now()) })).status).toBe(200);
    await failHome(homeId, "refunded");
    expect((await reconcile()).status).toBe(200);
    expect((await stateOf(homeId))!.desired_state).toBe("failed");
    // Astra JOURNEY-A-2 A6: age alone never retires it (the old 25-hour cutoff did).
    setNow(NOW + 26 * HOUR);
    expect((await reconcile()).status).toBe(200);
    expect((await stateOf(homeId))!.desired_state).toBe("failed");
    // Stripe's confirmed expiry of the session (checkout.session.expired) is the evidence.
    await env.DB.prepare("UPDATE checkout_consents SET session_expired_at=? WHERE home_id=?").bind(NOW + 26 * HOUR, homeId).run();
    expect((await reconcile()).status).toBe(200);
    expect((await stateOf(homeId))!.desired_state).toBe("deleted");
  });
});

describe("journey A6 (Astra JOURNEY-A-2): retirement needs terminal settlement evidence; every late payment on a retired home is owed back", () => {
  const failHome = async (homeId: string, entitlement: string) => {
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='failed',observed_state='failed',entitlement=? WHERE id=?").bind(entitlement, homeId).run();
  };
  const stateOf = (homeId: string) => env.DB.prepare("SELECT desired_state,entitlement FROM cloud_homes WHERE id=?").bind(homeId).first<{ desired_state: string; entitlement: string }>();
  const ordered = async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    expect((await send("/v1/billing/checkout", { plan: "pro", consent: consentFor("pro", Date.now()) })).status).toBe(200);
    return homeId;
  };
  const paidEntry = (homeId: string, eventId: string, version: number, paymentId: string) => env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL)")
    .bind(eventId, homeId, version, JSON.stringify({ eventId, homeId, version, status: "paid", paymentId }), Date.now()).run();

  it("a submitted checkout still waiting for its asynchronous payment keeps the home, however young or old; its failure releases it", async () => {
    const homeId = await ordered();
    // Submitted ten seconds ago, unpaid (contract made, payment pending): the probe that retired the home before.
    await env.DB.prepare("UPDATE checkout_consents SET contract_made_at=?,completed_at=? WHERE home_id=?").bind(NOW - 10_000, NOW - 10_000, homeId).run();
    await failHome(homeId, "refunded");
    expect((await reconcile()).status).toBe(200);
    expect((await stateOf(homeId))!.desired_state).toBe("failed");
    setNow(NOW + 30 * 24 * HOUR); // a month later, still no payment outcome: still kept
    expect((await reconcile()).status).toBe(200);
    expect((await stateOf(homeId))!.desired_state).toBe("failed");
    // An expiry of a submitted checkout is not evidence (a completed session cannot expire; the payment is what is awaited).
    await env.DB.prepare("UPDATE checkout_consents SET session_expired_at=? WHERE home_id=?").bind(Date.now(), homeId).run();
    expect((await reconcile()).status).toBe(200);
    expect((await stateOf(homeId))!.desired_state).toBe("failed");
    await env.DB.prepare("UPDATE checkout_consents SET payment_failed_at=? WHERE home_id=?").bind(Date.now(), homeId).run();
    expect((await reconcile()).status).toBe(200);
    expect((await stateOf(homeId))!.desired_state).toBe("deleted");
  });
  it("a session request whose answer was never recorded keeps the home until that session's expiry is recorded", async () => {
    const homeId = await ordered();
    await env.DB.prepare("UPDATE checkout_consents SET session_expired_at=?,session_inflight_at=? WHERE home_id=?").bind(NOW, NOW, homeId).run();
    await failHome(homeId, "refunded");
    setNow(NOW + 48 * HOUR);
    expect((await reconcile()).status).toBe(200);
    expect((await stateOf(homeId))!.desired_state).toBe("failed");
    await env.DB.prepare("UPDATE checkout_consents SET session_inflight_at=NULL WHERE home_id=?").bind(homeId).run();
    expect((await reconcile()).status).toBe(200);
    expect((await stateOf(homeId))!.desired_state).toBe("deleted");
  });
  it("a paid checkout whose payment was refunded, and a rejected one, are terminal", async () => {
    const homeId = await ordered();
    await env.DB.prepare("UPDATE checkout_consents SET contract_made_at=?,completed_at=?,paid_at=? WHERE home_id=?").bind(NOW, NOW, NOW, homeId).run();
    await failHome(homeId, "refunded");
    expect((await reconcile()).status).toBe(200);
    expect((await stateOf(homeId))!.desired_state).toBe("deleted");
    const second = await ordered();
    await env.DB.prepare("UPDATE checkout_consents SET contract_made_at=?,completed_at=?,rejected_at=? WHERE home_id=?").bind(NOW, NOW, NOW, second).run();
    await failHome(second, "refunded");
    expect((await reconcile()).status).toBe(200);
    expect((await stateOf(second))!.desired_state).toBe("deleted");
  });
  it("two distinct late payments on a retired home are two refund obligations, each acknowledged only with its own; a replay adds nothing", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    await failHome(homeId, "refunded");
    expect((await reconcile()).status).toBe(200);
    expect((await stateOf(homeId))!.desired_state).toBe("deleted");
    // The first late payment turns the home to refund_pending; the second (an older version, too) must not slip through on that aggregate state.
    await paidEntry(homeId, "evt_late_a", 9, "in_late_a");
    await paidEntry(homeId, "evt_late_b", 8, "in_late_b");
    await paidEntry(homeId, "evt_late_a_replay", 10, "in_late_a");
    expect((await reconcile()).status).toBe(200);
    const owed = await env.DB.prepare("SELECT id FROM cloud_outbox WHERE home_id=? AND kind='refund_required' ORDER BY id").bind(homeId).all<{ id: string }>();
    expect(owed.results.map((r) => r.id)).toEqual(["refund:retired:in_late_a", "refund:retired:in_late_b"]);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE home_id=? AND processed_at IS NULL", homeId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_fake_refunds WHERE payment_id IN ('in_late_a','in_late_b')")).toBe(2);
    expect(await stateOf(homeId)).toEqual({ desired_state: "deleted", entitlement: "refunded" }); // 'refunded' only once both are done
    // A later replay of a payment already owed back adds nothing.
    await paidEntry(homeId, "evt_late_b_replay", 11, "in_late_b");
    expect((await reconcile()).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE home_id=? AND kind='refund_required'", homeId)).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE id='evt_late_b_replay' AND processed_at IS NOT NULL")).toBe(1);
  });
  it("a second late payment arriving while the first one's refund is still pending gets its own obligation", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    await failHome(homeId, "refunded");
    expect((await reconcile()).status).toBe(200);
    // The probe: the home already reads refund_pending for an earlier late payment whose refund is not done yet.
    await env.DB.prepare("UPDATE cloud_homes SET entitlement='refund_pending',payment_version=7 WHERE id=?").bind(homeId).run();
    await paidEntry(homeId, "evt_second", 8, "in_second");
    expect((await reconcile()).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE id='refund:retired:in_second' AND kind='refund_required'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_fake_refunds WHERE payment_id='in_second'")).toBe(1);
  });
  it("a late payment billing already turned away (voided) is acknowledged with no obligation: billing refunds it itself", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    await failHome(homeId, "refunded");
    expect((await reconcile()).status).toBe(200);
    await env.DB.prepare("INSERT INTO cloud_payment_voids (home_id,payment_id,reason,ref,voided_at) VALUES (?,?,?,?,?)").bind(homeId, "in_voided", "test", "ref", NOW).run();
    await paidEntry(homeId, "evt_voided", 9, "in_voided");
    expect((await reconcile()).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_outbox WHERE home_id=? AND kind='refund_required'", homeId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE id='evt_voided' AND processed_at IS NOT NULL")).toBe(1);
  });
});

describe("journey A6 (Astra JOURNEY-A-1): the 409 home_exists comes from the real payment, refund and cleanup state", () => {
  const failHome = async (homeId: string, entitlement: string) => {
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='failed',observed_state='failed',entitlement=? WHERE id=?").bind(entitlement, homeId).run();
  };
  const refusal = async () => { const r = await reserve(); expect(r.status).toBe(409); return await r.json() as { error: string; reason: string; action: string; message: string }; };
  it("refunded (still being cleaned up) says the slot is being freed; a recorded refund says it is being refunded", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    await failHome(homeId, "refunded");
    expect(await refusal()).toEqual({ error: "home_exists", reason: "setup_failed_refunded", action: "try_again_later", message: expect.stringContaining("was refunded") });
    await failHome(homeId, "refund_pending");
    expect(await refusal()).toMatchObject({ reason: "setup_failed_refund_pending", message: expect.stringContaining("being refunded") });
  });
  it("Astra JOURNEY-A-3 #3: a refunded home kept by a checkout that may still settle promises no time; once alerted, it sends the customer to support", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    expect((await send("/v1/billing/checkout", { plan: "pro", consent: consentFor("pro", Date.now()) })).status).toBe(200);
    await env.DB.prepare("UPDATE checkout_consents SET session_inflight_at=?,session_issuance_id='resume:lost' WHERE home_id=?").bind(NOW, homeId).run();
    await failHome(homeId, "refunded");
    const waiting = await refusal();
    expect(waiting).toMatchObject({ reason: "setup_failed_checkout_unsettled", action: "try_again_later" });
    expect(waiting.message).not.toContain("few minutes");
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES ('a1',?,'home.checkout_unresolved','high','{}',?)").bind(homeId, NOW).run();
    const alerted = await refusal();
    expect(alerted).toMatchObject({ reason: "setup_failed_checkout_unresolved", action: "contact_support" });
    expect(alerted.message).not.toContain("few minutes");
    // Astra JOURNEY-A-4 #5: once the marker settles, its settling batch resolves the alert: the customer is no longer sent to support.
    await env.DB.prepare("UPDATE checkout_consents SET session_inflight_at=NULL,session_issuance_id=NULL,session_expired_at=? WHERE home_id=?").bind(NOW, homeId).run();
    await env.DB.prepare("UPDATE cloud_alerts SET resolved_at=? WHERE id='a1'").bind(NOW).run();
    const settled = await refusal();
    expect(settled.action).not.toBe("contact_support");
    expect(settled.reason).not.toBe("setup_failed_checkout_unresolved");
  });
  it("a voided payment promises no refund; a failed home with no refund recorded sends the customer to support", async () => {
    const { homeId } = await (await reserve()).json() as { homeId: string };
    await failHome(homeId, "pending");
    await env.DB.prepare("INSERT INTO cloud_payment_voids (home_id,payment_id,reason,ref,voided_at) VALUES (?,?,?,?,?)").bind(homeId, "in_void", "test", "ref", NOW).run();
    const voided = await refusal();
    expect(voided).toMatchObject({ reason: "setup_failed_payment_voided", action: "contact_support", message: expect.stringContaining("no refund is pending") });
    expect(voided.message).not.toContain("being refunded");
    await env.DB.prepare("DELETE FROM cloud_payment_voids").run();
    await failHome(homeId, "paid");
    const other = await refusal();
    expect(other).toMatchObject({ reason: "setup_failed", action: "contact_support" });
    expect(other.message).not.toContain("refunded");
  });
});
