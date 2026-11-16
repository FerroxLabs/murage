// SPDX-License-Identifier: AGPL-3.0-or-later
// The credit an auto top-up bought: the frozen body, the capability hold, retries and the alarm, the 422 ceiling alert, refund reversal.
// The router is the contract double (test/support/grants-router-double.ts, draft cloud-b contract); real workerd + D1 + home lease.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coverageWatchQ, grantTopup, reconcilePaymentCoverage, retryPendingGrants, reverseCredits } from "../src/b5-billing";
import { fencedBatch, withHomeLease } from "../src/billing-lease";
import { createEnvFluxHooks, selectFluxMode } from "../src/flux-live-hooks";
import { composeTopupGrantBody } from "../src/flux-grants";
import { GrantsRouterDouble } from "./support/grants-router-double";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const HOME = "home-1";
const OWNER = "user-1";
const FLUX_ACCT = "flux-acct-9";
const INVOICE = "in_topup_1";

let router: GrantsRouterDouble;
let e: Env;
let hooks: ReturnType<typeof createEnvFluxHooks>;
const grant = (at = NOW) => withHomeLease(e, HOME, (lease) => grantTopup(e, lease, hooks, { homeId: HOME, invoiceId: INVOICE }, at));
const sweep = (at = NOW + DAY) => withHomeLease(e, HOME, (lease) => retryPendingGrants(e, lease, hooks, HOME, at));
const row = () => env.DB.prepare("SELECT granted_at AS g,attempts AS a,last_error AS err,body_json AS body FROM credit_grants WHERE invoice_id=? AND kind='topup'").bind(INVOICE)
  .first<{ g: number | null; a: number; err: string | null; body: string | null }>();
const alerts = async (kind: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind=? AND resolved_at IS NULL").bind(kind).first<{ n: number }>())!.n;

beforeEach(async () => {
  router = new GrantsRouterDouble();
  router.bind(HOME, FLUX_ACCT);
  router.reversalTargets = true;
  router.topupGrants = true;
  hooks = createEnvFluxHooks(router.fetch);
  e = { ...env, FLUX_CLOUD_GRANTS_URL: "https://router.test", FLUX_CLOUD_GRANTS_TOKEN: router.token, FLUX_CLOUD_SERVICE_TOKEN: "s".repeat(40), CLOUD_FLUX_ROUTES_ENABLED: "1" } as Env;
  selectFluxMode(e, hooks);
  await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,1,1)`).bind(HOME, "inst-1", OWNER, "running", "running", "sha256:x", "k").run();
  await env.DB.prepare("INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at) VALUES (?,?,?,?,?,1,1)")
    .bind(HOME, "cus_1", "sub_1", "starter", "active").run();
  await env.DB.prepare("INSERT OR REPLACE INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES (?,?,1,'lnk-1',1,0)").bind(OWNER, FLUX_ACCT).run();
  await env.DB.prepare(`INSERT INTO topup_attempts (attempt_id,home_id,settings_revision,amount_cents,month_key,state,invoice_id,claimed_at,updated_at,paid_at)
    VALUES ('a1',?,1,2000,'2027-01','paid',?,1,1,1)`).bind(HOME, INVOICE).run();
});
afterEach(async () => {
  for (const t of ["credit_grants", "credit_reversals", "refund_coverage", "refund_ops", "cloud_alerts", "flux_links", "billing_subscriptions", "topup_attempts", "cloud_homes"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe("auto top-up grant", () => {
  it("sends one body with no period or expiry, for the amount charged before tax, and the router credits it", async () => {
    expect(await grant()).toBe(true);
    const sent = JSON.parse((await row())!.body!);
    expect(sent).toEqual({ grant_id: `${INVOICE}:topup`, invoice_id: INVOICE, kind: "topup", home_id: HOME, account_id: FLUX_ACCT, plan: "topup", amount_microcents: 20_000_000 });
    expect(router.accountAvailable.get(FLUX_ACCT)).toBe(20_000_000);
    expect(await grant()).toBe(false); // granted once: a repeat asks nothing
    expect(router.grants.size).toBe(1);
  });

  it("the body is one function and carries nothing from the plan catalogue", async () => {
    const b = await composeTopupGrantBody(e, { homeId: HOME, invoiceId: INVOICE });
    expect("json" in b && JSON.parse(b.json).amount_microcents).toBe(20_000_000);
    expect(await composeTopupGrantBody(e, { homeId: HOME, invoiceId: "in_unknown" })).toEqual({ held: "amount_not_positive" });
  });

  it("a router that does not advertise topupGrants is sent nothing; the claim is retried and granted once it does", async () => {
    router.topupGrants = false;
    router.reversalTargets = true;
    expect(await grant()).toBe(false);
    expect(router.requests.filter((r) => r.path.endsWith("/credit-grants") && r.method === "POST")).toEqual([]);
    expect((await row())!.g).toBeNull();
    router.topupGrants = true;
    await sweep();
    expect((await row())!.g).toBe(NOW + DAY);
    expect(router.accountAvailable.get(FLUX_ACCT)).toBe(20_000_000);
  });

  it("paid but the grant fails: retried by the sweep, then alarmed, and still granted when the router recovers", async () => {
    router.issueEnabled = false;
    expect(await grant()).toBe(false);
    for (let i = 1; i <= 3; i++) await sweep(NOW + i * 60_000);
    expect((await row())!.a).toBeGreaterThanOrEqual(3);
    expect(await alerts("credit.grant_pending")).toBe(1);
    router.issueEnabled = true;
    await sweep(NOW + DAY);
    expect((await row())!.g).not.toBeNull();
    expect(await alerts("credit.grant_pending")).toBe(0);
  });

  const posts = () => router.requests.filter((r) => r.path.endsWith("/credit-grants") && r.method === "POST").length;
  const suppressed = () => env.DB.prepare("SELECT suppressed_reason AS r FROM credit_grants WHERE invoice_id=? AND kind='topup'").bind(INVOICE).first<{ r: string | null }>();

  it("a 422 ceiling is permanent: suppressed, alarmed once, and the sweep never asks again", async () => {
    router.ceiling = 1_000_000;
    expect(await grant()).toBe(false);
    expect(await alerts("credit.topup_ceiling")).toBe(1);
    expect(await suppressed()).toEqual({ r: "topup_ceiling" });
    const sent = posts();
    for (let i = 1; i <= 4; i++) { await sweep(NOW + i * DAY); expect(await grant(NOW + i * DAY)).toBe(false); }
    expect(posts()).toBe(sent);
    expect(await alerts("credit.topup_ceiling")).toBe(1);
    expect((await row())!.g).toBeNull();
  });

  it("a 409 account_not_fresh after the charge is alarmed at once and never retried as transient", async () => {
    router.unfresh.add(FLUX_ACCT);
    expect(await grant()).toBe(false);
    expect(await suppressed()).toEqual({ r: "account_not_fresh" });
    expect(await alerts("credit.grant_suppressed")).toBe(1);
    expect(await alerts("flux.account_not_fresh")).toBe(1); // charged and refused: the page kind
    const sent = posts();
    await sweep(NOW + DAY); await sweep(NOW + 2 * DAY);
    expect(posts()).toBe(sent);
    expect(await alerts("flux.account_not_fresh")).toBe(1);
  });

  // FluxMain: the 422 ceiling also answers /reverse and /reversal-target. Permanent: no retry, one alarm.
  let refused = 0; // asks that reached the refusing route
  const ceilingOn = (suffix: string) => {
    refused = 0;
    const h = createEnvFluxHooks((u, i) => (new URL(u).pathname.endsWith(suffix) && ++refused ? Promise.resolve(new Response(JSON.stringify({ error: { code: "ceiling", message: "removal ceiling" } }), { status: 422, headers: { "content-type": "application/json" } })) : router.fetch(u, i)));
    selectFluxMode(e, h);
    return h;
  };
  it("a 422 on /reverse is permanent: recorded once, alarmed once, never sent again", async () => {
    expect(await grant()).toBe(true);
    const h = ceilingOn("/reverse");
    await env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at) VALUES (?,'topup',?,'refund',NULL,?)").bind(INVOICE, HOME, NOW).run();
    for (let i = 1; i <= 4; i++) await withHomeLease(e, HOME, (lease) => reverseCredits(e, lease, h, HOME, NOW + i * DAY));
    expect(refused).toBe(1);
    expect(await alerts("credit.reversal_ceiling")).toBe(1);
    expect(await env.DB.prepare("SELECT last_error AS e, reversed_at IS NOT NULL AS done FROM credit_reversals").first()).toEqual({ e: "router_422_ceiling", done: 1 });
  });
  it("a 422 on /reversal-target is permanent: recorded once, alarmed once, never sent again at that revision", async () => {
    expect(await grant()).toBe(true);
    const h = ceilingOn("/reversal-target");
    const stripe = { listRefunds: async () => ({ data: [{ id: "re_1", amount: 2160, status: "succeeded", payment_intent: "pi_1" }] }),
      getInvoice: async () => ({ amount_paid: 2160 }) } as unknown as Parameters<typeof reconcilePaymentCoverage>[2]["stripe"];
    for (let i = 1; i <= 3; i++) await withHomeLease(e, HOME, async (lease) => {
      await fencedBatch(e, lease, [coverageWatchQ({ homeId: HOME, paymentIntent: "pi_1", invoiceId: INVOICE, subscriptionId: null, paidCents: 2160 }, NOW + i * DAY)]);
      await reconcilePaymentCoverage(e, lease, { stripe, flux: h, deps: {}, now: NOW + i * DAY }, HOME, "pi_1");
    });
    expect(refused).toBe(1);
    expect(await alerts("credit.reversal_ceiling")).toBe(1);
    expect(await env.DB.prepare("SELECT last_error AS e FROM credit_reversals WHERE scope='target'").first()).toEqual({ e: "router_422_ceiling" });
  });

  it("a full refund takes back only the unused credit", async () => {
    expect(await grant()).toBe(true);
    router.grants.get(`${INVOICE}:topup`)!.consumed = 5_000_000;
    const stripe = { listRefunds: async () => ({ data: [{ id: "re_1", amount: 2160, status: "succeeded", payment_intent: "pi_1" }] }),
      getInvoice: async () => ({ amount_paid: 2160 }) } as unknown as Parameters<typeof reconcilePaymentCoverage>[2]["stripe"];
    await withHomeLease(e, HOME, async (lease) => {
      await fencedBatch(e, lease, [coverageWatchQ({ homeId: HOME, paymentIntent: "pi_1", invoiceId: INVOICE, subscriptionId: null, paidCents: 2160 }, NOW + DAY)]);
      await reconcilePaymentCoverage(e, lease, { stripe, flux: hooks, deps: {}, now: NOW + DAY }, HOME, "pi_1");
    });
    expect(router.grants.get(`${INVOICE}:topup`)!.removed).toBe(15_000_000);
  });
});

describe("PRODFLUX r3: a top-up paid during a Flux secret outage", () => {
  const posts = () => router.requests.filter((r) => r.path.endsWith("/credit-grants") && r.method === "POST").length;
  const counters = () => env.DB.prepare("SELECT granted_at AS g,tries AS t,attempts AS a,last_error AS err,delivery_state AS ds FROM credit_grants WHERE invoice_id=? AND kind='topup'")
    .bind(INVOICE).first<{ g: number | null; t: number; a: number; err: string | null; ds: string | null }>();
  it.each([["FLUX_CLOUD_SERVICE_TOKEN", "flux_service_token_absent"], ["FLUX_CLOUD_GRANTS_TOKEN", "grants_token_absent"]])(
    "%s absent: held with no counter moved and nothing sent; granted exactly once when the secret is back", async (secret, code) => {
      const out = { ...e, [secret]: undefined } as Env;
      selectFluxMode(out, hooks);
      const asOut = (at: number) => withHomeLease(out, HOME, (lease) => grantTopup(out, lease, hooks, { homeId: HOME, invoiceId: INVOICE }, at));
      expect(await asOut(NOW)).toBe(false);
      for (let i = 1; i <= 3; i++) await withHomeLease(out, HOME, (lease) => retryPendingGrants(out, lease, hooks, HOME, NOW + i * 60_000));
      expect(posts()).toBe(0);
      expect(await counters()).toEqual({ g: null, t: 0, a: 0, err: "grant_held:flux_not_ready", ds: null });
      expect(await alerts(`credit.${code}`)).toBe(1);
      // Back: the sweep grants it once; a repeat (sweep or the paid path) sends nothing more.
      selectFluxMode(e, hooks);
      await sweep(NOW + DAY);
      expect((await row())!.g).toBe(NOW + DAY);
      expect(await grant(NOW + DAY + 1)).toBe(false);
      await sweep(NOW + 2 * DAY);
      expect(posts()).toBe(1); expect(router.grants.size).toBe(1);
      expect(router.accountAvailable.get(FLUX_ACCT)).toBe(20_000_000);
    });

  it("item 3: the credential hold is decided before any count, so an alert insert that fails leaves the counters at 0", async () => {
    const out = { ...e, FLUX_CLOUD_SERVICE_TOKEN: undefined } as Env;
    selectFluxMode(out, hooks);
    await env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS t_alert_down BEFORE INSERT ON cloud_alerts WHEN NEW.kind LIKE 'credit.%token_absent'
      BEGIN SELECT RAISE(ABORT, 'alert store down'); END`).run();
    try {
      expect(await withHomeLease(out, HOME, (lease) => grantTopup(out, lease, hooks, { homeId: HOME, invoiceId: INVOICE }, NOW))).toBe(false);
      await withHomeLease(out, HOME, (lease) => retryPendingGrants(out, lease, hooks, HOME, NOW + 60_000));
    } finally { await env.DB.prepare("DROP TRIGGER IF EXISTS t_alert_down").run(); }
    expect(await counters()).toMatchObject({ g: null, t: 0, a: 0, err: "grant_held:flux_not_ready" });
    expect(posts()).toBe(0);
    expect(await alerts("credit.flux_service_token_absent")).toBe(0);
  });
});
