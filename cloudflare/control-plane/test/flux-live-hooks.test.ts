// SPDX-License-Identifier: AGPL-3.0-or-later
// Step 1 of Flux for Murage Cloud: billing's hooks are the stub until the Flux route switch is "1", then the real grants client
// (flux-live-hooks.ts). The router is the contract double (test/support/grants-router-double.ts); real workerd + D1 + home lease.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coverageWatchQ, fluxDispatchEnabled, grantOnce, reconcilePaymentCoverage, retryPendingGrants, reverseCredits, stubFluxHooks } from "../src/b5-billing";
import { readFluxConfig, usdToMicrocents } from "../src/b4-flux-config";
import { fencedBatch, withHomeLease } from "../src/billing-lease";
import { createEnvFluxHooks, envFluxHooks, selectFluxMode } from "../src/flux-live-hooks";
import { createWorker } from "../src/index";
import { GrantsRouterDouble } from "./support/grants-router-double";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const P_START = Date.UTC(2027, 0, 15, 12, 0, 0);
const P_END = Date.UTC(2027, 1, 15, 12, 0, 0);
const HOME = "home-1";
const OWNER = "user-1";
const FLUX_ACCT = "flux-acct-9";
const INPUT = { homeId: HOME, plan: "starter", invoiceId: "in_1", periodStart: P_START, periodEnd: P_END, kind: "period" as "period" | "upgrade_delta" };

let router: GrantsRouterDouble;
let e: Env;
let hooks: ReturnType<typeof createEnvFluxHooks>;
const envWith = (over: Partial<Env> = {}): Env => ({ ...env, FLUX_CLOUD_GRANTS_URL: "https://router.test", FLUX_CLOUD_GRANTS_TOKEN: router.token,
  FLUX_CLOUD_SERVICE_TOKEN: "s".repeat(40), CLOUD_FLUX_ROUTES_ENABLED: "1", ...over } as Env);
const on = () => { e = envWith(); selectFluxMode(e, hooks); };
const off = () => { e = envWith({ CLOUD_FLUX_ROUTES_ENABLED: undefined }); selectFluxMode(e, hooks); };
const grant = (over: Partial<typeof INPUT> = {}, at = NOW) =>
  withHomeLease(e, HOME, (lease) => grantOnce(e, lease, hooks, { ...INPUT, ...over }, "sub_1", at, []));
const sweep = (at = NOW + DAY) => withHomeLease(e, HOME, (lease) => retryPendingGrants(e, lease, hooks, HOME, at));
const reverse = (at = NOW + DAY) => withHomeLease(e, HOME, (lease) => reverseCredits(e, lease, hooks, HOME, at));
const row = (id = "in_1") => env.DB.prepare("SELECT granted_at AS g,attempts AS a,last_error AS err FROM credit_grants WHERE invoice_id=? AND kind='period'").bind(id)
  .first<{ g: number | null; a: number; err: string | null }>();
const alerts = async (kind: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind=? AND resolved_at IS NULL").bind(kind).first<{ n: number }>())!.n;
const microcents = (plan: string) => usdToMicrocents(readFluxConfig(e).plans[plan]!.creditsUsd);

beforeEach(async () => {
  router = new GrantsRouterDouble();
  router.bind(HOME, FLUX_ACCT);
  router.reversalTargets = true;
  hooks = createEnvFluxHooks(router.fetch);
  e = envWith();
  await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,1,1)`).bind(HOME, "inst-1", OWNER, "running", "running", "sha256:x", "k").run();
  await env.DB.prepare("INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,current_period_start,current_period_end,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,1)")
    .bind(HOME, "cus_1", "sub_1", "starter", "active", P_START, P_END).run();
  await env.DB.prepare("INSERT OR REPLACE INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES (?,?,1,'lnk-1',1,0)").bind(OWNER, FLUX_ACCT).run();
});
const CLEAN = ["credit_grant_cutover", "credit_grants", "credit_reversals", "refund_coverage", "refund_ops", "cloud_alerts", "flux_links", "billing_subscriptions",
  "flux_hook_stub_log", "cloud_homes"];
afterEach(async () => { for (const t of CLEAN) await env.DB.prepare(`DELETE FROM ${t}`).run(); });

describe("flag off: the object is the stub", () => {
  it("answers as stubFluxHooks, advertises nothing, and a paid invoice sends nothing to the router", async () => {
    off();
    expect(hooks.stub).toBe(true);
    expect(hooks.capabilities).toBe(stubFluxHooks.capabilities);
    expect(fluxDispatchEnabled(hooks)).toBe(false);
    expect(hooks.setReversalTarget).toBeUndefined();
    expect(hooks.ensureAccount).toBeUndefined();
    expect(hooks.reconcileFences).toBeUndefined();
    expect(await grant()).toBe(false);
    expect(await row()).toMatchObject({ g: null, err: "grant_held:flux_off" });
    expect(router.requests).toHaveLength(0);
  });
  it("any value but exactly 1 stays off", () => {
    for (const v of [undefined, "", "0", "true", "yes"]) {
      selectFluxMode({ CLOUD_FLUX_ROUTES_ENABLED: v }, hooks);
      expect(fluxDispatchEnabled(hooks)).toBe(false);
    }
  });
  it("the worker selects the mode from each invocation's env, and an injected billing hook is never switched", async () => {
    const worker = createWorker();
    await worker.fetch(new Request("https://cp.test/healthz"), envWith(), { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    expect(fluxDispatchEnabled(envFluxHooks)).toBe(true);
    await worker.fetch(new Request("https://cp.test/healthz"), envWith({ CLOUD_FLUX_ROUTES_ENABLED: undefined }), { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    expect(fluxDispatchEnabled(envFluxHooks)).toBe(false);
    envFluxHooks.mode.on = false;
  });
});

describe("PRODFLUX: switched on with a Flux credential missing, billing holds every grant (Astra HIGH 2)", () => {
  it.each([["FLUX_CLOUD_SERVICE_TOKEN", "flux_service_token_absent"], ["FLUX_CLOUD_GRANTS_TOKEN", "grants_token_absent"]])(
    "%s absent: the real hooks stay selected but advertise nothing; no dispatch, no attempt, one alert, the obligation kept", async (secret, code) => {
      e = envWith({ [secret]: undefined } as Partial<Env>);
      selectFluxMode(e, hooks);
      expect(hooks.stub).toBeUndefined(); // still the real hooks: a billing Stop or plan change is journaled by B4, never the stub's log
      expect(fluxDispatchEnabled(hooks)).toBe(false);
      expect(await grant()).toBe(false);
      await sweep(NOW + DAY);
      expect(router.requests).toHaveLength(0);
      expect(await row()).toMatchObject({ g: null, a: 0, err: "grant_held:flux_not_ready" }); // PRODFLUX r3 (3): held before any count
      expect(await alerts(`credit.${code}`)).toBe(1);
      // The secret is put back: the same claim is granted once, nothing was lost.
      on();
      await sweep(NOW + 2 * DAY);
      expect((await row())!.g).toBe(NOW + 2 * DAY);
      expect(router.grants.size).toBe(1);
    });
});

describe("flag on: a paid invoice creates the plan's grant", () => {
  beforeEach(on);
  it("advertises the qualified capability and exposes every real hook", () => {
    expect(fluxDispatchEnabled(hooks)).toBe(true);
    expect(hooks.stub).toBeUndefined();
    for (const k of ["setReversalTarget", "grantReversalState", "ensureAccount", "reconcileFences"] as const) expect(typeof hooks[k]).toBe("function");
  });
  for (const plan of ["starter", "pro", "max"]) {
    it(`${plan}: exactly one grant of the plan's amount, to the linked Flux account`, async () => {
      expect(await grant({ plan })).toBe(true);
      const sent = router.requests.filter((r) => r.method === "POST" && !r.path.includes("/reverse"));
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0]!.body!)).toMatchObject({ grant_id: "in_1:period", account_id: FLUX_ACCT, plan, amount_microcents: microcents(plan) });
      expect(router.grants.get("in_1:period")!.amount).toBe(microcents(plan));
      expect(router.accountAvailable.get(FLUX_ACCT)).toBe(microcents(plan));
      expect(sent[0]!.auth).toBe(`Bearer ${router.token}`);
    });
  }
  it("a retry (the event again, a lost answer, the sweep) never doubles the grant", async () => {
    router.next = "apply_then_drop";
    await expect(grant()).rejects.toThrow("response lost");
    expect(await grant()).toBe(true);
    await grant(); // the duplicate event of a recorded grant: answered from the record
    await sweep();
    expect(router.grants.size).toBe(1);
    expect(router.accountAvailable.get(FLUX_ACCT)).toBe(microcents("starter"));
    expect((await row())!.g).not.toBeNull();
  });
  it("the router down: held for retry, no error raised to the caller, granted on the next pass", async () => {
    router.next = "unavailable";
    expect(await grant()).toBe(false);
    expect(await row()).toMatchObject({ g: null, a: 1, err: "credit_grants_retry:unavailable" });
    await sweep(NOW + DAY);
    expect(await row()).toMatchObject({ g: NOW + DAY, a: 1 });
    expect(router.accountAvailable.get(FLUX_ACCT)).toBe(microcents("starter"));
  });
});

describe("flag on: refunds and reversals", () => {
  beforeEach(on);
  const stripeOf = (amount: number) => ({ listRefunds: async () => ({ data: [{ id: "re_1", amount, status: "succeeded", payment_intent: "pi_1" }] }),
    getInvoice: async () => ({ amount_paid: 4900 }) }) as unknown as Parameters<typeof reconcilePaymentCoverage>[2]["stripe"];
  const cover = (amount: number, at = NOW + DAY) => withHomeLease(e, HOME, async (lease) => {
    await fencedBatch(e, lease, [coverageWatchQ({ homeId: HOME, paymentIntent: "pi_1", invoiceId: "in_1", subscriptionId: "sub_1", paidCents: 4900 }, at)]);
    await reconcilePaymentCoverage(e, lease, { stripe: stripeOf(amount), flux: hooks, deps: {}, now: at }, HOME, "pi_1");
  });
  it("a full refund takes the whole unspent grant back, once", async () => {
    expect(await grant()).toBe(true);
    const amount = microcents("starter");
    await cover(4900);
    expect(router.grants.get("in_1:period")!.removed).toBe(amount);
    expect(router.accountAvailable.get(FLUX_ACCT)).toBe(0);
    await cover(4900, NOW + 2 * DAY);
    expect(router.grants.get("in_1:period")!.removed).toBe(amount);
  });
  it("a non-refund reversal revokes the grant, and a repeat changes nothing", async () => {
    expect(await grant()).toBe(true);
    await env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at) VALUES ('in_1','period',?,'downgrade',NULL,?)").bind(HOME, NOW).run();
    await reverse();
    await reverse(NOW + 2 * DAY);
    expect(router.grants.get("in_1:period")!.removed).toBe(microcents("starter"));
    expect(router.accountAvailable.get(FLUX_ACCT)).toBe(0);
  });
  it("a router that does not advertise the capability holds the target with the existing alert and sends none", async () => {
    expect(await grant()).toBe(true);
    router.reversalTargets = false;
    await cover(900);
    expect(router.requests.filter((r) => r.path.endsWith("/reversal-target"))).toEqual([]);
    expect(await env.DB.prepare("SELECT last_error AS e FROM credit_reversals").first()).toEqual({ e: "router_capability_absent" });
    expect(router.grants.get("in_1:period")!.removed).toBe(0);
  });
  it("hooks off (stub) keep the target journaled pending_capability and alerted, nothing sent", async () => {
    expect(await grant()).toBe(true);
    const before = router.requests.length;
    off();
    await cover(900);
    expect(router.requests).toHaveLength(before);
    expect(await env.DB.prepare("SELECT last_error AS e FROM credit_reversals").first()).toEqual({ e: "pending_capability" });
    expect(await alerts("credit.reversal_pending")).toBe(1);
  });
});
