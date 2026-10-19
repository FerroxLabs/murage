// SPDX-License-Identifier: AGPL-3.0-or-later
// WP5-P4 control-plane half, D1-D3 (design b4/GRANTS-DESIGN.md r9 sections 2, 3, 8 row P4, 9), rebuilt for Astra WP5-P4-CP. The router is a
// CONTRACT DOUBLE mirroring the P3 route module (test/support/grants-router-double.ts), not the live router. Real workerd + D1; the real
// hook client; the real grantOnce, retryPendingGrants and reverseCredits under a real home lease.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coverageWatchQ, finalTargetsQ, grantOnce, legacyReversalReport, reconcilePaymentCoverage, retryPendingGrants, reverseCredits, stubFluxHooks, sweepLegacyReversals,
  type FluxEntitlementHooks } from "../src/b5-billing";
import { fencedBatch, q, withHomeLease } from "../src/billing-lease";
import { composeFrozenBody, grantsHooks, grantsIssuancePreflight, proratedShare, sha256Hex } from "../src/flux-grants";
import legalFlows from "../src/legal-flows.ts?raw";
import legalRefunds from "../src/legal-refunds.ts?raw";
import fluxGrantsSrc from "../src/flux-grants.ts?raw";
import { GrantsRouterDouble } from "./support/grants-router-double";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const P_START = Date.UTC(2027, 0, 15, 12, 0, 0);
const P_END = Date.UTC(2027, 1, 15, 12, 0, 0);
const HOME = "home-1";
const OWNER = "user-1";        // the Cloud account (cloud_homes.owner_id = flux_links.owner_user_id)
const FLUX_ACCT = "flux-acct-9"; // the Flux account its link names: the recipient
const INPUT = { homeId: HOME, plan: "starter", invoiceId: "in_1", periodStart: P_START, periodEnd: P_END, kind: "period" as "period" | "upgrade_delta" };
const ASTRA_CATALOGUE = JSON.stringify({ plans: { starter: { creditsUsd: 5 }, pro: { creditsUsd: 11 }, max: { creditsUsd: 17 }, team: { creditsUsd: 50, pooled: true } },
  defaultPlan: "starter", defaultCapMultiplier: 3, minCapUsd: 5, maxCapUsd: 1000, subkeyTtlDays: 35, linkChallengeMinutes: 10 });

let router: GrantsRouterDouble;
let e: Env;
const envWith = (over: Partial<Env> = {}): Env => ({ ...env, FLUX_CLOUD_GRANTS_URL: "https://router.test", FLUX_CLOUD_GRANTS_TOKEN: router.token,
  CLOUD_FLUX_ROUTES_ENABLED: "1", ...over } as Env);
/** Flux switched ON (Astra JOURNEY-A-10 #1): real hooks with the grants client built for a qualified router. */
const flux = (): FluxEntitlementHooks => ({ ...stubFluxHooks, ...grantsHooks(router.fetch, { reversalTargets: true }), stub: false });
/** Flux OFF, the launch state: the production default hooks (stub) with the grants client, no capability. */
const stubOff = (): FluxEntitlementHooks => ({ ...stubFluxHooks, ...grantsHooks(router.fetch) });
const grant = (over: Partial<typeof INPUT> & { previousPlan?: string } = {}, at = NOW, extra: Parameters<typeof grantOnce>[6] = []) =>
  withHomeLease(e, HOME, (lease) => grantOnce(e, lease, flux(), { ...INPUT, ...over }, "sub_1", at, extra));
const sweep = (at = NOW + DAY) => withHomeLease(e, HOME, (lease) => retryPendingGrants(e, lease, flux(), HOME, at));
const reverse = (at = NOW + DAY) => withHomeLease(e, HOME, (lease) => reverseCredits(e, lease, flux(), HOME, at));
const row = (id = "in_1", kind = "period") => env.DB.prepare(`SELECT granted_at AS g,attempts AS a,tries AS t,last_error AS err,suppressed_reason AS sup,body_json AS body,
  body_sha256 AS sha FROM credit_grants WHERE invoice_id=? AND kind=?`).bind(id, kind).first<{
  g: number | null; a: number; t: number; err: string | null; sup: string | null; body: string | null; sha: string | null }>();
const alerts = async (kind: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind=? AND resolved_at IS NULL").bind(kind).first<{ n: number }>())!.n;
// Lane H1: the request bodies as the frozen bytes (the top-level fenced revision, never part of the frozen body, left out).
const grantCalls = () => router.requests.filter((r) => r.method === "POST" && !r.path.endsWith("/reverse"))
  .map((r) => ({ ...r, body: r.body === null ? null : r.body.replace(/,"revision":\d+}$/, "}") }));
const stubLogRows = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_hook_stub_log").first<{ n: number }>())!.n;
const link = (fenced = 0) => env.DB.prepare("INSERT OR REPLACE INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES (?,?,1,'lnk-1',1,?)")
  .bind(OWNER, FLUX_ACCT, fenced).run();

beforeEach(async () => {
  router = new GrantsRouterDouble();
  router.bind(HOME, FLUX_ACCT);
  e = envWith();
  await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,1,1)`).bind(HOME, "inst-1", OWNER, "running", "running", "sha256:x", "k").run();
  await env.DB.prepare("INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,current_period_start,current_period_end,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,1)")
    .bind(HOME, "cus_1", "sub_1", "starter", "active", P_START, P_END).run();
  await link();
});
const CLEAN = ["credit_grant_cutover", "credit_grants", "credit_reversals", "refund_coverage", "refund_ops", "cloud_alerts", "plan_changes", "plan_quotes", "flux_links", "billing_subscriptions",
  "flux_hook_stub_log", "cloud_homes"];
afterEach(async () => { for (const t of CLEAN) await env.DB.prepare(`DELETE FROM ${t}`).run(); });

describe("D1: the frozen body", () => {
  it("is written into the fenced claim INSERT in the router's canonical shape, recipient = the linked Flux account (never the CP owner)", async () => {
    expect(await grant()).toBe(true);
    const r = (await row())!;
    expect(JSON.parse(r.body!)).toEqual({ grant_id: "in_1:period", invoice_id: "in_1", kind: "period", home_id: HOME, account_id: FLUX_ACCT, plan: "starter",
      amount_microcents: 10_000_000, period_start: "2027-01-15T12:00:00+00:00", period_end: "2027-02-15T12:00:00+00:00", expires_at: "2027-03-15T12:00:00+00:00" });
    expect(r.body).not.toContain(OWNER);
    expect(r.sha).toBe(await sha256Hex(r.body!));
    expect(grantCalls().map((c) => c.body)).toEqual([r.body]);
    expect(r.g).toBe(NOW);
  });
  it("expires_at clamps the day (Jan 31 + 1 month = Feb 28)", async () => {
    await grant({ periodStart: Date.UTC(2027, 0, 1), periodEnd: Date.UTC(2027, 0, 31) });
    expect(JSON.parse((await row())!.body!).expires_at).toBe("2027-02-28T00:00:00+00:00");
  });
  for (const [name, setup] of [["no link", () => env.DB.prepare("DELETE FROM flux_links").run()], ["a fenced (being unlinked) link", () => link(1)]] as const) {
    it(`recipient: ${name} HOLDS the claim: no body, no router call, one alert; linking later freezes the linked account and grants once`, async () => {
      await setup();
      expect(await grant()).toBe(false);
      await sweep(NOW + DAY); await sweep(NOW + 2 * DAY);
      // A local hold is not an ask (Astra WP5-P4-CP-2 #3): tries/attempts untouched, no credit.grant_pending escalation (not even by age),
      // only the fairness stamp moves.
      expect(await row()).toMatchObject({ g: null, a: 0, t: 0, body: null, sha: null, err: "grant_held:recipient_unlinked" });
      expect(await env.DB.prepare("SELECT last_attempt_at AS l,alerted_at AS al FROM credit_grants WHERE invoice_id='in_1'").first()).toEqual({ l: NOW + 2 * DAY, al: null });
      expect(router.requests).toHaveLength(0);
      expect(await alerts("credit.grant_pending")).toBe(0);
      expect(await alerts("credit.grant_held")).toBe(1);
      await link(0);
      await sweep(NOW + 3 * DAY);
      const r = (await row())!;
      expect(JSON.parse(r.body!).account_id).toBe(FLUX_ACCT);
      expect(r.g).toBe(NOW + 3 * DAY);
      expect(grantCalls()).toHaveLength(1);
      expect(await alerts("credit.grant_pending")).toBe(0);
      expect(await alerts("credit.grant_held")).toBe(0); // reconciled: no held claim remains (Astra WP5-P4-CP-2 #4)
    });
  }
  it("credit.grant_held is reconciled per home: resolved once linked and granted, a later hold records its own details", async () => {
    const held = () => env.DB.prepare("SELECT detail FROM cloud_alerts WHERE home_id=? AND kind='credit.grant_held' AND resolved_at IS NULL").bind(HOME)
      .all<{ detail: string }>().then((x) => x.results.map((a) => JSON.parse(a.detail)));
    await env.DB.prepare("DELETE FROM flux_links").run();
    expect(await grant()).toBe(false);
    expect(await held()).toEqual([{ grantId: "in_1:period", reason: "recipient_unlinked", grantIds: ["in_1:period"],
      grants: [{ grantId: "in_1:period", reason: "recipient_unlinked" }] }]);
    await link(0);
    await sweep(NOW + DAY);
    expect((await row())!.g).toBe(NOW + DAY);
    expect(await held()).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.grant_held' AND resolved_at=?").bind(NOW + DAY).first<{ n: number }>())!.n).toBe(1);
    await env.DB.prepare("DELETE FROM flux_links").run();
    expect(await grant({ invoiceId: "in_2" }, NOW + 2 * DAY)).toBe(false);
    expect(await held()).toEqual([{ grantId: "in_2:period", reason: "recipient_unlinked", grantIds: ["in_2:period"],
      grants: [{ grantId: "in_2:period", reason: "recipient_unlinked" }] }]);
    // a second held claim of the same home joins the ONE open alert (new revision), the oldest stays first
    e = envWith({ FLUX_B4_CONFIG: ASTRA_CATALOGUE });
    expect(await grant({ invoiceId: "in_3", plan: "team" }, NOW + 3 * DAY)).toBe(false);
    expect(await held()).toEqual([{ grantId: "in_2:period", reason: "recipient_unlinked", grantIds: ["in_2:period", "in_3:period"], revision: 1,
      grants: [{ grantId: "in_2:period", reason: "recipient_unlinked" }, { grantId: "in_3:period", reason: "plan_not_in_catalogue" }] }]);
    expect(router.requests).toHaveLength(1);
  });
  it("config_change_between_attempts: the frozen body is resent byte-identical after the catalogue changed", async () => {
    router.next = "busy";
    expect(await grant()).toBe(false);
    const first = (await row())!;
    expect(first).toMatchObject({ g: null, a: 1, err: "credit_grants_retry:busy" });
    e = envWith({ FLUX_B4_CONFIG: ASTRA_CATALOGUE });
    expect(await grant()).toBe(true); // the duplicate event: the conflict clause keeps the frozen body
    expect((await row())!.body).toBe(first.body);
    const sent = grantCalls().map((c) => c.body);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(JSON.parse(sent[1]!).amount_microcents).toBe(10_000_000);
  });
  it("a granted-but-unrecorded claim is resent the same bytes after a catalogue change and answered already_granted, once", async () => {
    router.next = "apply_then_drop";
    await expect(grant()).rejects.toThrow("response lost");
    e = envWith({ FLUX_B4_CONFIG: ASTRA_CATALOGUE });
    await sweep();
    expect(router.grants.size).toBe(1);
    expect(router.grants.get("in_1:period")!.amount).toBe(10_000_000);
    expect((await row())!.g).toBe(NOW + DAY);
  });
  it("catalogue: amounts come from b4-flux-config (FLUX_B4_CONFIG); a pooled plan or an invalid catalogue holds the claim, never a default", async () => {
    e = envWith({ FLUX_B4_CONFIG: ASTRA_CATALOGUE });
    await grant({ invoiceId: "in_p", plan: "pro" });
    expect(JSON.parse((await row("in_p"))!.body!).amount_microcents).toBe(11_000_000);
    await grant({ invoiceId: "in_t", plan: "team" });
    expect(await row("in_t")).toMatchObject({ body: null, err: "grant_held:plan_not_in_catalogue" });
    e = envWith({ FLUX_B4_CONFIG: "{\"plans\":{}}" });
    await grant({ invoiceId: "in_x" });
    expect(await row("in_x")).toMatchObject({ body: null, err: "grant_held:flux_config_invalid" });
    expect(fluxGrantsSrc).not.toMatch(/FLUX_PLAN_CREDIT_MICROCENTS/);
  });
});

describe("D1: upgrade_delta is the proration the customer was charged", () => {
  const S = Math.floor(P_START / 1000); const E = Math.floor(P_END / 1000);
  const quote = async (pd: number, withPeriod = true) => {
    await env.DB.prepare(`INSERT INTO plan_quotes (id,home_id,user_id,subscription_id,item_id,from_price,to_plan,to_price,proration_date,amount_cents,currency,created_at,expires_at,sub_period_start,sub_period_end)
      VALUES ('q1',?,?,'sub_1','si_1','price_s','pro','price_p',?,300,'usd',1,2,?,?)`).bind(HOME, OWNER, pd, withPeriod ? S : null, withPeriod ? E : null).run();
    await env.DB.prepare(`INSERT INTO plan_changes (id,home_id,user_id,quote_id,subscription_id,from_plan,to_plan,amount_cents,currency,invoice_id,state,created_at,updated_at)
      VALUES ('planchange:q1',?,?,'q1','sub_1','starter','pro',300,'usd','in_u','requested',1,1)`).bind(HOME, OWNER).run();
  };
  const up = (pd: number, at: number, over: { periodStart?: number; periodEnd?: number } = {}) =>
    grant({ invoiceId: "in_u", plan: "pro", kind: "upgrade_delta", previousPlan: "starter", periodStart: pd * 1000, periodEnd: P_END, ...over }, at);
  const amount = async () => JSON.parse((await row("in_u", "upgrade_delta"))!.body!).amount_microcents;

  it("Astra's example: the halfway upgrade grants 3,000,000 (not 6,000,000)", async () => {
    e = envWith({ FLUX_B4_CONFIG: ASTRA_CATALOGUE });
    const half = S + (E - S) / 2;
    await quote(half);
    expect(await up(half, half * 1000 + 60_000)).toBe(true);
    expect(await amount()).toBe(3_000_000);
  });
  it("does not depend on processing time: delivered days late (even after the period ended) it grants the same amount", async () => {
    e = envWith({ FLUX_B4_CONFIG: ASTRA_CATALOGUE });
    const half = S + (E - S) / 2;
    await quote(half);
    await up(half, P_END + 10 * DAY);
    expect(await amount()).toBe(3_000_000);
  });
  it("is floored exactly once with integer arithmetic (no floating-point overgrant)", async () => {
    const pd = S + 1_000_003;
    await quote(pd);
    await up(pd, NOW);
    const exact = (BigInt(10_000_000) * BigInt((E - pd) * 1000)) / BigInt((E - S) * 1000);
    expect(BigInt(await amount())).toBe(exact);
    expect(proratedShare(2 ** 52, 1, 0, 3)).toBe(Number((BigInt(2 ** 52) * 2n) / 3n));
  });
  it("a quote from before migration 0090 uses the recorded billing period only when it is provably the quoted one", async () => {
    const pd = S + (E - S) / 4;
    await quote(pd, false);
    await up(pd, NOW);
    expect(await amount()).toBe(Math.floor((10_000_000 * 3) / 4));
  });
  it("an invoice interval that is not [proration_date, period end] is held for ops, never guessed", async () => {
    const pd = S + (E - S) / 2;
    await quote(pd);
    expect(await up(pd, NOW, { periodStart: pd * 1000 + 1000 })).toBe(false);
    expect(await row("in_u", "upgrade_delta")).toMatchObject({ body: null, err: "grant_held:proration_unverifiable" });
    expect(router.requests).toHaveLength(0);
  });
});

describe("D1: legacy claims from the fail-closed stub", () => {
  it("a claim with granted_at NULL and no body is rebuilt once (fenced, write-once) from its facts; three sweeps make ONE router call", async () => {
    await env.DB.prepare(`INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,period_start,period_end,subscription_id,attempts,last_error)
      VALUES ('in_1','period',?,'starter',?,?,?,'sub_1',4,'flux_not_wired')`).bind(HOME, NOW - DAY, P_START, P_END).run();
    await sweep(NOW + DAY); await sweep(NOW + 2 * DAY); await sweep(NOW + 3 * DAY);
    const r = (await row())!;
    expect(grantCalls()).toHaveLength(1);
    expect(grantCalls()[0].body).toBe(r.body);
    expect(r.sha).toBe(await sha256Hex(r.body!));
    expect(JSON.parse(r.body!)).toMatchObject({ account_id: FLUX_ACCT, amount_microcents: 10_000_000 });
    expect(r.g).toBe(NOW + DAY);
  });
  it("an existing frozen body is never overwritten by a rebuild", async () => {
    const body = JSON.stringify({ grant_id: "in_1:period", invoice_id: "in_1", kind: "period", home_id: HOME, account_id: FLUX_ACCT, plan: "starter",
      amount_microcents: 7, period_start: "2027-01-15T12:00:00+00:00", period_end: "2027-02-15T12:00:00+00:00", expires_at: "2027-03-15T12:00:00+00:00" });
    await env.DB.prepare(`INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,period_start,period_end,subscription_id,body_json,body_sha256)
      VALUES ('in_1','period',?,'starter',?,?,?,'sub_1',?,?)`).bind(HOME, NOW - DAY, P_START, P_END, body, await sha256Hex(body)).run();
    await sweep();
    expect((await row())!.body).toBe(body);
    expect(grantCalls()[0].body).toBe(body);
  });
});

describe("D2: askGrant", () => {
  it("lost_grant_response: the retry is answered already_granted and stamps granted_at once", async () => {
    router.next = "apply_then_drop";
    await expect(grant()).rejects.toThrow("response lost");
    expect(await row()).toMatchObject({ g: null, a: 0, t: 1 });
    await sweep();
    expect((await row())!.g).toBe(NOW + DAY);
    await sweep(NOW + 3 * DAY); await grant();
    expect((await row())!.g).toBe(NOW + DAY);
    // Lane H1: the lost answer left the fenced outcome unknown: the retry READ the grant back (GET state) instead of sending it again.
    expect(grantCalls()).toHaveLength(1);
    expect(router.requests.filter((r) => r.method === "GET" && r.path.endsWith("/state"))).toHaveLength(1);
  });
  it("a reversed grant is RETAINED by the router: its replay is already_granted (state reversed) and is stamped, never suppressed", async () => {
    router.next = "apply_then_drop";
    await expect(grant()).rejects.toThrow("response lost");
    await router.fetch("https://router.test/internal/cloud-home/credit-grants/reverse", { method: "POST", headers: { authorization: `Bearer ${router.token}` },
      body: JSON.stringify({ grant_id: "in_1:period", invoice_id: "in_1", kind: "period", home_id: HOME, reason: "refunded" }) });
    const replay = await flux().grantMonthlyCredits(e, INPUT);
    expect(replay).toEqual({ status: "already_granted", state: "reversed" });
    await sweep();
    expect(await row()).toMatchObject({ g: NOW + DAY, sup: null });
    expect(router.grants.get("in_1:period")!.state).toBe("reversed");
  });
  it("reversing an EXPIRED grant removes its remainder but keeps state expired (router behaviour); the replay reports expired", async () => {
    expect(await grant()).toBe(true);
    router.grants.get("in_1:period")!.state = "expired";
    await env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at) VALUES ('in_1','period',?,'refunded',NULL,?)").bind(HOME, NOW).run();
    await reverse();
    expect(router.grants.get("in_1:period")).toMatchObject({ state: "expired", removed: 10_000_000 });
    expect(await flux().grantMonthlyCredits(e, INPUT)).toEqual({ status: "already_granted", state: "expired" });
  });
  it("suppressed_grant: not_applied_reversed (a tombstone) is not stamped, alerts credit.grant_suppressed and is never asked again", async () => {
    router.receipts.set("in_1:period", { homeId: HOME, invoiceId: "in_1", kind: "period", outcome: "no_grant", removed: 0, consumed: 0 });
    expect(await grant()).toBe(false);
    expect(await row()).toMatchObject({ g: null, sup: "not_applied_reversed", err: null });
    expect(await alerts("credit.grant_suppressed")).toBe(1);
    await sweep(NOW + 2 * DAY);
    expect(grantCalls()).toHaveLength(1);
  });
  it("suppression is TERMINAL: a duplicate invoice event neither clears it nor calls the router; only the caller's other writes land", async () => {
    router.receipts.set("in_1:period", { homeId: HOME, invoiceId: "in_1", kind: "period", outcome: "no_grant", removed: 0, consumed: 0 });
    await grant();
    const extra = [q("UPDATE billing_subscriptions SET status='active',updated_at=? WHERE home_id=?", 777, HOME)];
    expect(await grant({}, NOW + DAY, extra)).toBe(false);
    await sweep(NOW + 2 * DAY);
    expect(grantCalls()).toHaveLength(1);
    expect(await row()).toMatchObject({ g: null, sup: "not_applied_reversed" });
    expect((await env.DB.prepare("SELECT updated_at AS u FROM billing_subscriptions").first<{ u: number }>())!.u).toBe(777);
  });
  it("503s (busy, unavailable, issuance_paused, unbound, misconfigured) keep the claim, record the attempt, stamp nothing; the sweep retries", async () => {
    router.next = "busy";
    expect(await grant()).toBe(false);
    expect(await row()).toMatchObject({ g: null, a: 1, err: "credit_grants_retry:busy" });
    router.issueEnabled = false;
    await sweep(NOW + DAY);
    expect(await row()).toMatchObject({ a: 2, err: "issuance_paused" });
    router.issueEnabled = true; router.homes.get(HOME)!.fenced = true;
    await sweep(NOW + 2 * DAY);
    expect(await row()).toMatchObject({ a: 3, err: "unbound" });
    router.homes.get(HOME)!.fenced = false; router.ceiling = null;
    await sweep(NOW + 3 * DAY);
    expect(await row()).toMatchObject({ a: 4, err: "credit_grants_retry:unavailable" });
    router.ceiling = 1e12; router.keysToken = router.token;
    await sweep(NOW + 4 * DAY);
    expect(await row()).toMatchObject({ a: 5, err: "misconfigured" });
    router.keysToken = "k".repeat(40);
    await sweep(NOW + 5 * DAY);
    expect(await row()).toMatchObject({ g: NOW + 5 * DAY, err: null });
    expect(router.grants.size).toBe(1);
  });
  it("409s (recipient_mismatch, account_not_fresh) stamp nothing and raise the review alert", async () => {
    router.bind(HOME, "someone-else");
    expect(await grant()).toBe(false);
    expect(await row()).toMatchObject({ g: null, a: 1, err: "router_409_recipient_mismatch" });
    expect(await alerts("credit.grant_review")).toBe(1);
    router.bind(HOME, FLUX_ACCT); router.unfresh.add(FLUX_ACCT);
    await sweep();
    expect(await row()).toMatchObject({ g: null, a: 2, err: "router_409_account_not_fresh" });
    router.unfresh.clear();
    await sweep(NOW + 2 * DAY);
    expect((await row())!.g).toBe(NOW + 2 * DAY);
  });
  it("other throws escape: a network error, a 500 and a 422 ceiling are not attempts and stamp nothing", async () => {
    router.next = "network";
    await expect(grant()).rejects.toThrow("network down");
    router.next = "http500";
    await expect(sweep()).rejects.toThrow(/grants_router_500/);
    router.ceiling = 1;
    await expect(sweep(NOW + 2 * DAY)).rejects.toThrow(/grants_router_422_ceiling/);
    expect(await row()).toMatchObject({ g: null, a: 0, t: 3 });
  });
});

describe("D2: reversals", () => {
  it("lost_reverse_response: one receipt, reversed_at once, the second ask answered already_reversed", async () => {
    expect(await grant()).toBe(true);
    await env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at) VALUES ('in_1','period',?,'refunded',NULL,?)").bind(HOME, NOW).run();
    router.next = "apply_then_drop";
    await expect(reverse()).rejects.toThrow("response lost");
    expect(router.receipts.size).toBe(1);
    await reverse(NOW + 2 * DAY);
    expect((await env.DB.prepare("SELECT reversed_at AS r FROM credit_reversals").first<{ r: number }>())!.r).toBe(NOW + 2 * DAY);
    expect(router.receipts.get("in_1:period")).toMatchObject({ outcome: "removed", removed: 10_000_000 });
    await reverse(NOW + 3 * DAY);
    expect(router.requests.filter((r) => r.path.endsWith("/reverse"))).toHaveLength(2);
  });
  it("a reversal 503 is a recorded attempt; a reversal of a grant the router never saw resolves (no_grant) and tombstones it", async () => {
    await env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at) VALUES ('in_9','period',?,'refunded',NULL,?)").bind(HOME, NOW).run();
    router.next = "busy";
    await reverse();
    expect(await env.DB.prepare("SELECT attempts AS a,last_error AS e,reversed_at AS r FROM credit_reversals").first()).toEqual({ a: 1, e: "credit_grants_retry:busy", r: null });
    await reverse(NOW + 2 * DAY);
    expect((await env.DB.prepare("SELECT reversed_at AS r FROM credit_reversals").first<{ r: number }>())!.r).toBe(NOW + 2 * DAY);
    expect(router.receipts.get("in_9:period")!.outcome).toBe("no_grant");
  });
});

describe("Astra JOURNEY-A-6 #2/#3: a refund's credit adjustment is a versioned cumulative target, through the real hook client", () => {
  type Listed = { id: string; amount: number; status: string };
  /** The real hooks of a QUALIFIED router: not the stub, the capability advertised. */
  const qualified = (): FluxEntitlementHooks => ({ ...stubFluxHooks, ...grantsHooks(router.fetch, { reversalTargets: true }), stub: false });
  const stripeOf = (refunds: Listed[]) => ({ listRefunds: async () => ({ data: refunds.map((r) => ({ ...r, payment_intent: "pi_1" })) }),
    getInvoice: async () => ({ amount_paid: 4900 }) }) as unknown as Parameters<typeof reconcilePaymentCoverage>[2]["stripe"];
  /** One pass of payment-level reconciliation (the refund event or the sweep), with these hooks; a raw failure (a timeout) is the caller's. */
  const cover = (refunds: Listed[], hooks: FluxEntitlementHooks = qualified(), at = NOW + DAY) => withHomeLease(e, HOME, async (lease) => {
    await fencedBatch(e, lease, [coverageWatchQ({ homeId: HOME, paymentIntent: "pi_1", invoiceId: "in_1", subscriptionId: "sub_1", paidCents: 4900 }, at)]);
    await reconcilePaymentCoverage(e, lease, { stripe: stripeOf(refunds), flux: hooks, deps: {}, now: at }, HOME, "pi_1");
  });
  const rev = () => env.DB.prepare(`SELECT scope,covered_cents AS c,target_revision AS v,sent_revision AS sent,applied_revision AS applied,removed_microcents AS removed,
    reversed_at IS NOT NULL AS done,last_error AS err FROM credit_reversals`).first();
  const targetCalls = () => router.requests.filter((r) => r.path.endsWith("/reversal-target")).map((r) => JSON.parse(r.body!) as { revision: number; target_removed_microcents: number });
  const g = () => router.grants.get("in_1:period")!;
  const ok = (amount: number): Listed[] => [{ id: "re_1", amount, status: "succeeded" }];
  beforeEach(() => { router.reversalTargets = true; });

  it("#3 stub hooks (and real hooks without the capability): the target is journaled pending_capability, alerted, nothing is sent", async () => {
    expect(await grant()).toBe(true);
    await cover(ok(900), stubOff()); // the production default hooks (stub) with the grants client
    expect(await rev()).toMatchObject({ scope: "target", c: 900, v: 1, sent: null, done: 0, err: "pending_capability" });
    await cover(ok(900), { ...stubOff(), stub: false }, NOW + 2 * DAY); // real, but the router is not qualified
    expect(await rev()).toMatchObject({ v: 1, sent: null, done: 0, err: "pending_capability" });
    expect(targetCalls()).toEqual([]);
    expect(router.requests.filter((r) => r.path.endsWith("/reverse"))).toEqual([]);
    expect(g().removed).toBe(0);
    expect(await alerts("credit.reversal_pending")).toBe(1);
    // The refund fails before cutover: nothing was ever sent, so it settles with nothing removed.
    await cover([{ id: "re_1", amount: 900, status: "failed" }], stubOff(), NOW + 3 * DAY);
    expect(await rev()).toMatchObject({ c: 0, v: 2, applied: 2, removed: 0, done: 1 });
    expect(targetCalls()).toEqual([]);
  });
  it("#2 an older 90% target times out, a newer 0 is applied, then the older lands late: the router refuses it, journal and credits agree", async () => {
    expect(await grant()).toBe(true);
    const amount = g().amount;
    router.next = "delay";
    await cover(ok(4410)); // rev 1 (90%) in flight: outcome unknown (the raw failure is left to the sweep)
    expect(await rev()).toMatchObject({ v: 1, sent: 1, applied: null, done: 0 });
    // The refund fails: coverage 0, rev 2, target 0; it was sent once, so the zero is sent too.
    await cover([{ id: "re_1", amount: 4410, status: "failed" }], qualified(), NOW + 2 * DAY);
    expect(await rev()).toMatchObject({ v: 2, sent: 2, applied: 2, removed: 0, done: 1 });
    // The old request reaches the router now: a stale revision, refused; nothing removed.
    const late = await router.releaseDelayed();
    expect(late.map((x) => [x.status, x.json.status])).toEqual([[409, "stale_revision"]]);
    expect(g().removed).toBe(0);
    expect(router.accountAvailable.get(FLUX_ACCT)).toBe(amount);
    await reverse(NOW + 3 * DAY);
    // Lane H1: wire revisions come from the grant's fence (the grant itself took revision 1); the journal keeps the target's own revisions.
    expect(targetCalls().map((c) => [c.revision, c.target_removed_microcents])).toEqual([[2, Math.floor(amount * 4410 / 4900)], [3, 0]]);
  });
  it("#2 full -> partial -> full: each revision lands, credit is restored and removed again, never consumed credit", async () => {
    expect(await grant()).toBe(true);
    const amount = g().amount;
    g().consumed = Math.floor(amount / 10);
    await cover(ok(4900));
    expect(g().removed).toBe(amount - Math.floor(amount / 10));
    expect(await rev()).toMatchObject({ v: 1, applied: 1, removed: amount - Math.floor(amount / 10), done: 1 });
    await cover([{ id: "re_1", amount: 4900, status: "failed" }, { id: "re_2", amount: 900, status: "succeeded" }], qualified(), NOW + 2 * DAY);
    expect(g().removed).toBe(Math.floor(amount * 900 / 4900));
    expect(await rev()).toMatchObject({ v: 2, applied: 2, removed: Math.floor(amount * 900 / 4900), done: 1 });
    await cover([{ id: "re_1", amount: 4900, status: "succeeded" }], qualified(), NOW + 3 * DAY);
    expect(g().removed).toBe(amount - Math.floor(amount / 10));
    expect(await rev()).toMatchObject({ v: 3, applied: 3, removed: amount - Math.floor(amount / 10), done: 1 });
    expect(router.accountAvailable.get(FLUX_ACCT)).toBe(amount - g().removed); // nothing consumed here was ever taken back
    expect(targetCalls().map((c) => c.revision)).toEqual([2, 3, 4]); // lane H1: fenced wire revisions (the grant took 1)
  });
  it("#2 a receipt for a revision that is no longer the latest is not applied: the latest is sent next", async () => {
    expect(await grant()).toBe(true);
    const base = qualified();
    let bumped = false;
    const racing: FluxEntitlementHooks = { ...base, async setReversalTarget(env2, input) {
      const r = await base.setReversalTarget!(env2, input);
      if (!bumped) { bumped = true; await env.DB.prepare("UPDATE credit_reversals SET target_revision=target_revision+1,covered_cents=4900,reversed_at=NULL").run(); }
      return r;
    } };
    await cover(ok(900), racing);
    expect(await rev()).toMatchObject({ v: 2, sent: 1, applied: null, done: 0 });
    await withHomeLease(e, HOME, (lease) => reverseCredits(e, lease, qualified(), HOME, NOW + 2 * DAY));
    expect(await rev()).toMatchObject({ v: 2, sent: 2, applied: 2, done: 1 });
    expect(g().removed).toBe(g().amount);
  });
  it("A-7 #1: a grant applied at the router whose response was lost, then suppressed by cancellation, is never settled locally at 0", async () => {
    router.next = "apply_then_drop";
    await expect(grant()).rejects.toThrow(/response lost/);
    expect(await row()).toMatchObject({ g: null, t: 1, a: 0 });
    const amount = g().amount; // the router holds the whole grant
    // The plan is cancelled: the sweep suppresses the unconfirmed claim (never asked again).
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled' WHERE home_id=?").bind(HOME).run();
    await sweep(NOW + 60_000);
    expect(await row()).toMatchObject({ g: null, sup: "subscription_ended" });
    // $9 of $49 returned while the lost ask may still be in flight: nothing is settled, nothing pretended.
    await cover(ok(900), qualified(), NOW + 2 * 60_000);
    expect(await rev()).toMatchObject({ c: 900, v: 1, sent: null, applied: null, done: 0 });
    // After the delivery window the router is asked: its receipt says the grant exists, and what is removed of it.
    await cover(ok(900), qualified(), NOW + DAY);
    const t = Math.floor(amount * 900 / 4900);
    expect(g().removed).toBe(t);
    expect(await rev()).toMatchObject({ v: 1, applied: 1, removed: t, done: 1 });
    expect((await row())!.g).toBe(NOW + DAY); // the router's receipt is the proof that the grant landed
    expect(router.accountAvailable.get(FLUX_ACCT)).toBe(amount - t);
  });
  it("A-7 #1 / wp5-p5: grant_not_found for a grant of ambiguous delivery is no evidence: the target stays due and alerted, then lands with the grant", async () => {
    router.next = "delay"; // the grant request is held in flight: the caller sees a timeout
    await expect(grant()).rejects.toThrow(/timeout/);
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled' WHERE home_id=?").bind(HOME).run();
    await sweep(NOW + 60_000);
    await cover(ok(900), qualified(), NOW + DAY);
    expect(router.grants.size).toBe(0);
    expect(targetCalls()).toHaveLength(1); // asked, not assumed
    expect(await rev()).toMatchObject({ v: 1, sent: 1, applied: null, removed: null, done: 0, err: "grant_delivery_unconfirmed" });
    expect(await alerts("credit.reversal_pending")).toBe(1);
    // The delayed grant lands at the router after all: the next pass applies the target to it.
    expect((await router.releaseDelayed()).map((x) => x.json.status)).toEqual(["granted"]);
    await cover(ok(900), qualified(), NOW + 2 * DAY);
    const t = Math.floor(g().amount * 900 / 4900);
    expect(g().removed).toBe(t);
    expect(await rev()).toMatchObject({ v: 1, applied: 1, removed: t, done: 1 });
  });
  it("wp5-p5: stale_revision / revision_conflict carry latest_revision: the revision is refreshed above it and the latest target re-sent", async () => {
    expect(await grant()).toBe(true);
    // The router holds a newer revision of this grant than the journal knows (e.g. a journal restored from an older state).
    router.targets.set("in_1:period", { revision: 5, target: 0 });
    await cover(ok(900));
    const t = Math.floor(g().amount * 900 / 4900);
    expect(targetCalls().map((c) => [c.revision, c.target_removed_microcents])).toEqual([[2, t], [6, t]]); // lane H1: the grant took wire revision 1
    // Lane H1: the journal keeps the target's OWN revision (refreshed once above the stale ask); the wire revision is the fence's (6).
    expect(await rev()).toMatchObject({ v: 2, sent: 2, applied: 2, removed: t, done: 1 });
    expect(g().removed).toBe(t);
    // Same revision, another target: revision_conflict, refreshed the same way.
    router.targets.set("in_1:period", { revision: 7, target: 1 });
    await env.DB.prepare("UPDATE credit_reversals SET target_revision=7,reversed_at=NULL").run();
    await withHomeLease(e, HOME, (lease) => reverseCredits(e, lease, qualified(), HOME, NOW + 2 * DAY));
    expect(targetCalls().slice(2).map((c) => c.revision)).toEqual([7, 8]);
    expect(await rev()).toMatchObject({ v: 8, applied: 8, done: 1 });
    // The legacy /reverse is refused for a grant with a target (and the control plane never sends it: one journal row per grant).
    const res = await router.fetch("https://router.test/internal/cloud-home/credit-grants/reverse", { method: "POST", headers: { authorization: `Bearer ${router.token}` },
      body: JSON.stringify({ grant_id: "in_1:period", invoice_id: "in_1", kind: "period", home_id: HOME, reason: "x" }) });
    expect([res.status, ((await res.json()) as { status: string }).status]).toEqual([409, "reversal_target_held"]);
    expect(router.requests.filter((r) => r.path.endsWith("/reverse") && r.body?.includes("refunded"))).toEqual([]);
  });
  it("wp5-p5: a router that does not advertise reversalTargets on GET capabilities receives no target", async () => {
    expect(await grant()).toBe(true);
    router.reversalTargets = false;
    await cover(ok(900));
    expect(router.requests.filter((r) => r.path.endsWith("/capabilities")).length).toBeGreaterThan(0);
    expect(targetCalls()).toEqual([]);
    expect(await rev()).toMatchObject({ done: 0 });
    expect(await env.DB.prepare("SELECT last_error AS e FROM credit_reversals").first()).toEqual({ e: "router_capability_absent" });
  });
  it("A-7 #3: at cutover a pending grant is never published at its full balance while a refund target should reduce it", async () => {
    // Before cutover: the claim is written with its frozen body, nothing is sent (the token is absent: the quiesced state).
    e = envWith({ FLUX_CLOUD_GRANTS_TOKEN: "" });
    expect(await grant()).toBe(false);
    // $9 of $49 is returned: the target is journaled, waiting for a qualified router.
    await cover(ok(900), stubOff());
    expect(await rev()).toMatchObject({ c: 900, v: 1, done: 0, err: "pending_capability" });
    // The token is set but the hooks are not qualified yet (Flux off, Astra JOURNEY-A-10 #1): the grant is HELD here, never published.
    e = envWith();
    await withHomeLease(e, HOME, (lease) => retryPendingGrants(e, lease, { ...stubOff(), stub: false }, HOME, NOW + 2 * DAY));
    expect(router.grants.size).toBe(0);
    expect(await row()).toMatchObject({ g: null, err: "grant_held:flux_off" });
    expect(await alerts("credit.grant_held")).toBe(1);
    // Astra JOURNEY-A-8 #2: a qualified router that does not advertise grantWithTarget: the grant is still HELD (never grant-then-target).
    await withHomeLease(e, HOME, (lease) => retryPendingGrants(e, lease, qualified(), HOME, NOW + 2 * DAY + 60_000));
    expect(router.grants.size).toBe(0);
    expect(grantCalls().filter((r) => r.path === "/internal/cloud-home/credit-grants")).toEqual([]);
    expect(await row()).toMatchObject({ g: null, err: "grant_held:grant_with_target_unavailable" });
    expect(await alerts("credit.grant_held")).toBe(1);
    // Cutover with a router that applies initial_target in the grant's own transaction: ONE grant request carries the target.
    router.grantWithTarget = true;
    const seen: { path: string; body: string | null; available: number | undefined }[] = [];
    const watched: FluxEntitlementHooks = { ...stubFluxHooks, ...grantsHooks(async (u, i) => {
      const res = await router.fetch(u, i);
      seen.push({ path: new URL(u).pathname, body: typeof i?.body === "string" ? i.body : null, available: router.accountAvailable.get(FLUX_ACCT) });
      return res;
    }, { reversalTargets: true }), stub: false };
    await withHomeLease(e, HOME, (lease) => retryPendingGrants(e, lease, watched, HOME, NOW + 3 * DAY));
    const amount = g().amount; const t = Math.floor(amount * 900 / 4900);
    expect(seen.map((x) => x.path)).toEqual(["/internal/cloud-home/credit-grants/capabilities", "/internal/cloud-home/credit-grants"]);
    expect(JSON.parse(seen[1].body!).initial_target).toEqual({ target_removed_microcents: t, revision: 1 });
    expect(seen[1].available).toBe(amount - t); // reduced the moment the grant exists: never spendable in full
    expect(g().removed).toBe(t);
    expect(targetCalls()).toEqual([]); // no second request
    expect(await rev()).toMatchObject({ v: 1, sent: 1, applied: 1, removed: t, done: 1 });
    expect(await row()).toMatchObject({ g: NOW + 3 * DAY, err: null });
    expect(await alerts("credit.grant_held")).toBe(0);
  });
  it("A-8 #2: capability is read on EVERY publish: a router downgraded between its capability answer and the grant refuses it; the grant is held", async () => {
    e = envWith({ FLUX_CLOUD_GRANTS_TOKEN: "" });
    expect(await grant()).toBe(false);
    await cover(ok(4900), stubOff());
    e = envWith();
    router.grantWithTarget = true;
    // The capability answer says yes; the router is downgraded before the grant itself arrives (an older build takes the request).
    const downgrading: FluxEntitlementHooks = { ...stubFluxHooks, ...grantsHooks(async (u, i) => {
      const res = await router.fetch(u, i);
      if (new URL(u).pathname.endsWith("/capabilities")) router.grantWithTarget = false;
      return res;
    }, { reversalTargets: true }), stub: false };
    await withHomeLease(e, HOME, (lease) => retryPendingGrants(e, lease, downgrading, HOME, NOW + 2 * DAY));
    expect(router.grants.size).toBe(0); // the unknown field is refused before any state change
    expect(await row()).toMatchObject({ g: null, err: "grant_held:grant_with_target_unavailable" });
    expect(await alerts("credit.grant_held")).toBe(1);
    expect(await rev()).toMatchObject({ v: 1, applied: null, done: 0 });
    // The same hooks, upgraded again: the next publish asks again (nothing cached) and the grant goes out with its target.
    router.grantWithTarget = true;
    await withHomeLease(e, HOME, (lease) => retryPendingGrants(e, lease, qualified(), HOME, NOW + 3 * DAY));
    const amount = g().amount;
    expect(g().removed).toBe(amount);
    expect(router.accountAvailable.get(FLUX_ACCT)).toBe(0);
    expect(await rev()).toMatchObject({ v: 1, applied: 1, removed: amount, done: 1 });
    expect(router.requests.filter((r) => r.path.endsWith("/capabilities")).length).toBe(2);
  });
  it("A-8 #1: a grant the router committed but answered 503, then cancellation and a full refund: never settled at zero; the receipt settles it", async () => {
    router.next = "apply_then_503";
    expect(await grant()).toBe(false);
    expect(await row()).toMatchObject({ g: null, t: 1, a: 1, err: "credit_grants_retry:unavailable" }); // tries == attempts: NOT proof
    const amount = g().amount; // all 49,000,000 microcents are live at the router
    expect(await env.DB.prepare("SELECT delivery_state AS d FROM credit_grants").first()).toEqual({ d: "ambiguous" });
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled' WHERE home_id=?").bind(HOME).run();
    await sweep(NOW + 60_000);
    expect(await row()).toMatchObject({ g: null, sup: "subscription_ended" });
    // Full refund while the 503'd ask may still be settling: nothing is settled locally.
    await cover(ok(4900), qualified(), NOW + 2 * 60_000);
    expect(await rev()).toMatchObject({ c: 4900, v: 1, sent: null, applied: null, done: 0 });
    expect(router.accountAvailable.get(FLUX_ACCT)).toBe(amount);
    // After the delivery window the target is SENT, and the router's receipt settles it: the whole unused grant is removed.
    await cover(ok(4900), qualified(), NOW + DAY);
    expect(targetCalls().map((c) => [c.revision, c.target_removed_microcents])).toEqual([[2, amount]]); // lane H1: fenced wire revision
    expect(g().removed).toBe(amount);
    expect(router.accountAvailable.get(FLUX_ACCT)).toBe(0);
    expect(await rev()).toMatchObject({ v: 1, applied: 1, removed: amount, done: 1 });
    expect((await row())!.g).toBe(NOW + DAY);
  });
  it("A-8 #1: only definitive refusals (409) before cancellation: grant_not_found from the router is explicit evidence, settled at zero", async () => {
    router.unfresh.add(FLUX_ACCT);
    expect(await grant()).toBe(false);
    expect(await env.DB.prepare("SELECT delivery_state AS d FROM credit_grants").first()).toEqual({ d: "dispatched" });
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled' WHERE home_id=?").bind(HOME).run();
    await sweep(NOW + 60_000);
    await cover(ok(4900), qualified(), NOW + 2 * 60_000);
    expect(targetCalls()).toHaveLength(1); // asked, not assumed
    expect(await rev()).toMatchObject({ v: 1, sent: 1, applied: 1, removed: 0, done: 1 });
    expect(router.grants.size).toBe(0);
  });
  it("lane B #6: a pending, action-required or failed refund produces no reversal and no target above zero", async () => {
    expect(await grant()).toBe(true);
    for (const status of ["pending", "requires_action", "failed"]) {
      await cover([{ id: "re_1", amount: 4900, status }], qualified(), NOW + DAY);
      expect(await rev()).toBeNull();
    }
    expect(targetCalls()).toEqual([]);
    expect(g().removed).toBe(0);
  });
  it("A-8 #3: a lane B reversal journaled with a refund (legacy full row) is a final TARGET: coverage 'failed' with cached success removes nothing; a completed full reversal is restored when its refund fails", async () => {
    expect(await grant()).toBe(true);
    const amount = g().amount;
    // The operation's refund is cached as succeeded (refunded_at), but Stripe has since reported it failed.
    await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,end_plan,detail,created_at,updated_at,payment_intent,paid_cents,refunded_at,stripe_refund_status)
      VALUES ('mismatch:x','mismatch',?,?,'in_1',0,'{}',?,?,'pi_1',4900,?,'succeeded')`).bind(HOME, OWNER, NOW, NOW, NOW).run();
    await env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at) VALUES ('in_1','period',?,'mismatch','mismatch:x',?)").bind(HOME, NOW).run();
    await reverse(NOW + DAY);
    expect(router.requests.filter((r) => r.path.endsWith("/reverse"))).toEqual([]); // never the one-shot /reverse
    expect(await env.DB.prepare("SELECT scope,final,payment_intent AS pi FROM credit_reversals").first()).toEqual({ scope: "target", final: 1, pi: "pi_1" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM refund_coverage WHERE payment_intent='pi_1'").first()).toEqual({ n: 1 });
    // Authoritative coverage: the listing says failed. The cached success never reverses anything.
    await cover([{ id: "re_1", amount: 4900, status: "failed" }], qualified(), NOW + DAY + 1);
    expect(g().removed).toBe(0);
    expect(router.accountAvailable.get(FLUX_ACCT)).toBe(amount);
    expect(await rev()).toMatchObject({ c: 0, removed: 0, done: 1 });
    // The money is returned: the whole unused grant is removed (a target at full coverage)...
    await cover(ok(4900), qualified(), NOW + 2 * DAY);
    expect(g().removed).toBe(amount);
    // ...then that refund fails (or returns to requires_action): the target falls to zero and the credit is RESTORED.
    await cover([{ id: "re_1", amount: 4900, status: "requires_action" }], qualified(), NOW + 3 * DAY);
    expect(g().removed).toBe(0);
    expect(router.accountAvailable.get(FLUX_ACCT)).toBe(amount);
    expect(await rev()).toMatchObject({ c: 0, removed: 0, done: 1 });
    expect(router.requests.filter((r) => r.path.endsWith("/reverse"))).toEqual([]);
    // The grant is FINAL: a redelivered invoice never asks for it again.
    await env.DB.prepare("UPDATE credit_grants SET granted_at=NULL").run();
    expect(await grant({}, NOW + 4 * DAY)).toBe(false);
    expect(grantCalls().filter((r) => r.path === "/internal/cloud-home/credit-grants")).toHaveLength(1);
  });
  it("A-8 #3: a lane B reversal journaled now (finalTargetsQ) removes nothing until money is returned, follows coverage both ways, never /reverse", async () => {
    expect(await grant()).toBe(true);
    const amount = g().amount;
    await withHomeLease(e, HOME, (lease) => fencedBatch(e, lease, [finalTargetsQ("in_1", HOME, "replaced_unserved", "late_payment:in_1", NOW)]));
    expect(await env.DB.prepare("SELECT scope,final,target_revision AS v,op_id AS op FROM credit_reversals").first())
      .toEqual({ scope: "target", final: 1, v: 1, op: "late_payment:in_1" });
    await reverse(NOW + DAY); // no money returned yet: nothing to remove
    expect(g().removed).toBe(0);
    await cover(ok(4900), qualified(), NOW + 2 * DAY);
    expect(g().removed).toBe(amount);
    await cover([{ id: "re_1", amount: 4900, status: "failed" }], qualified(), NOW + 3 * DAY);
    expect(g().removed).toBe(0);
    expect(router.accountAvailable.get(FLUX_ACCT)).toBe(amount);
    expect(router.requests.filter((r) => r.path.endsWith("/reverse"))).toEqual([]);
  });
  it("Astra JOURNEY-A-10 #1 probe: Flux off (stub hooks, no capability) with token, URL and switch ALL configured: every grant/target/reversal path journals, sends NOTHING, completes nothing, alerts", async () => {
    e = envWith(); // credentials configured and CLOUD_FLUX_ROUTES_ENABLED on: the stub hooks alone must keep Flux off
    const grantOff = (id: string) => withHomeLease(e, HOME, (lease) => grantOnce(e, lease, stubOff(), { ...INPUT, invoiceId: id }, "sub_1", NOW));
    // in_1: a refund-driven target on a grant that must go out WITH its target; in_2: a final (lane B) target; in_3 / in_4: legacy
    // refund-backed /reverse rows, one dispatched before (ambiguous), one never dispatched; in_5: an ordinary (non-refund) full reversal.
    for (const id of ["in_1", "in_2", "in_3", "in_4"]) expect(await grantOff(id)).toBe(false);
    await cover(ok(900), stubOff());
    await withHomeLease(e, HOME, (lease) => fencedBatch(e, lease, [finalTargetsQ("in_2", HOME, "replaced_unserved", "late_payment:in_2", NOW)]));
    for (const [id, tries] of [["in_3", 1], ["in_4", 0]] as const) {
      await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,end_plan,detail,created_at,updated_at,payment_intent,paid_cents,refunded_at,stripe_refund_status)
        VALUES (?,'mismatch',?,?,?,0,'{}',?,?,?,4900,?,'succeeded')`).bind(`op:${id}`, HOME, OWNER, id, NOW, NOW, `pi_${id}`, NOW).run();
      await env.DB.prepare(`INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at,tries,attempts,last_attempt_at)
        VALUES (?,'period',?,'mismatch',?,?,?,0,?)`).bind(id, HOME, `op:${id}`, NOW, tries, NOW).run();
    }
    await env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at) VALUES ('in_5','period',?,'downgrade',NULL,?)").bind(HOME, NOW).run();
    for (const at of [NOW + DAY, NOW + 2 * DAY]) {
      await withHomeLease(e, HOME, (lease) => retryPendingGrants(e, lease, stubOff(), HOME, at));
      await withHomeLease(e, HOME, (lease) => reverseCredits(e, lease, stubOff(), HOME, at));
      await cover(ok(900), stubOff(), at);
    }
    await expect(stubOff().usedIncludedCreditMicrocents(e, { homeId: HOME, periodStart: P_START, periodEnd: P_END, usedThrough: NOW })).rejects.toThrow();
    expect(router.requests).toEqual([]); // nothing sent: no grant, no target, no /reverse, not even a capability or usage read
    expect(await stubLogRows()).toBe(0);
    const rows = (await env.DB.prepare(`SELECT invoice_id AS i,scope,final,reversed_at IS NOT NULL AS done,sent_revision AS sent,COALESCE(removed_microcents,0) AS removed,
      last_error AS err FROM credit_reversals ORDER BY invoice_id`).all()).results;
    expect(rows).toEqual([
      { i: "in_1", scope: "target", final: 0, done: 0, sent: null, removed: 0, err: "pending_capability" }, // money returned: due, alerted
      // No money returned yet: nothing to remove, nothing sent (a later coverage change makes it due again at a new revision).
      { i: "in_2", scope: "target", final: 1, done: 1, sent: null, removed: 0, err: null },
      { i: "in_3", scope: "full", final: 0, done: 0, sent: null, removed: 0, err: "pending_capability" }, // ambiguous: never converted blind
      { i: "in_4", scope: "target", final: 1, done: 1, sent: null, removed: 0, err: null },
      { i: "in_5", scope: "full", final: 0, done: 0, sent: null, removed: 0, err: "pending_capability" }, // the ordinary reversal: journaled, never sent
    ]);
    // Nothing lost or completed: every grant still claimed, ungranted, unsuppressed and HELD (flux_off); in_4's payment stays watched; alerted.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM credit_grants WHERE granted_at IS NULL AND suppressed_at IS NULL AND last_error='grant_held:flux_off'")
      .first<{ n: number }>())!.n).toBe(4);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM refund_coverage WHERE payment_intent='pi_in_4'").first()).toEqual({ n: 1 });
    expect(await alerts("credit.reversal_pending")).toBe(1);
    expect(await alerts("credit.grant_held")).toBe(1);
    expect((await legacyReversalReport(e)).rows.map((x) => x.grantId)).toEqual(["in_3:period"]);
  });
  it("Astra JOURNEY-A-10 #1: qualified real hooks but the Flux switch (CLOUD_FLUX_ROUTES_ENABLED) unset: the client sends nothing, completes nothing, ONE alert", async () => {
    e = envWith({ CLOUD_FLUX_ROUTES_ENABLED: undefined });
    expect(await grant()).toBe(false);
    await env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at) VALUES ('in_5','period',?,'downgrade',NULL,?)").bind(HOME, NOW).run();
    await sweep(NOW + DAY); await reverse(NOW + DAY);
    expect(router.requests).toEqual([]);
    expect(await row()).toMatchObject({ g: null, err: "flux_off" });
    expect(await env.DB.prepare("SELECT reversed_at AS r,last_error AS e FROM credit_reversals WHERE invoice_id='in_5'").first()).toEqual({ r: null, e: "flux_off" });
    expect(await alerts("credit.flux_off")).toBe(1);
    // Switched on: the same obligations go out.
    e = envWith();
    await sweep(NOW + 2 * DAY); await reverse(NOW + 2 * DAY);
    expect(await row()).toMatchObject({ err: null });
    expect((await row())!.g).not.toBeNull();
    expect(await env.DB.prepare("SELECT reversed_at IS NOT NULL AS r FROM credit_reversals WHERE invoice_id='in_5'").first()).toEqual({ r: 1 });
  });
  describe("Astra JOURNEY-A-9 #1: a receipt settles a target only when its revision AND held target are the ones asked", () => {
    /** The probe: the grant landed at the router, which holds revision 1 at target 0 (journal recovery); the CP's journal asks revision 1 at
     *  the full grant (a full refund) and replays the grant with that initial target. */
    const probe = async () => {
      router.grantWithTarget = true;
      expect(await grant()).toBe(true);
      router.targets.set("in_1:period", { revision: 1, target: 0 });
      await env.DB.prepare("UPDATE credit_grants SET granted_at=NULL,delivery_state='ambiguous'").run();
      await env.DB.prepare(`INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,requested_at,scope,covered_cents,paid_cents,payment_intent,target_revision)
        VALUES ('in_1','period',?,'refunded',?,'target',4900,4900,'pi_1',1)`).bind(HOME, NOW).run();
      await withHomeLease(e, HOME, (lease) => retryPendingGrants(e, lease, qualified(), HOME, NOW + DAY));
      return g().amount;
    };
    // Lane H1: the router's held revision 1 can no longer meet the control plane's ask at the same revision: every mutation of the grant
    // carries a revision allocated above everything Flux reported applied (the fence), so the latest target is applied at once and settled.
    it("H1 the grant's replay with its initial target goes out above the router's held revision: applied and settled at once, no conflict", async () => {
      const amount = await probe();
      expect(g().removed).toBe(amount);
      expect(await rev()).toMatchObject({ v: 1, applied: 1, removed: amount, done: 1, err: null });
      expect(await alerts("credit.reversal_pending")).toBe(0);
      expect(router.accountAvailable.get(FLUX_ACCT)).toBe(0);
      await withHomeLease(e, HOME, (lease) => reverseCredits(e, lease, qualified(), HOME, NOW + DAY + 60_000));
      expect(targetCalls()).toEqual([]);
    });
    it("a router that does not echo the held target: nothing settles on the grant's receipt; /reversal-target confirms it (lane H1: above the held revision)", async () => {
      router.echoTargets = false;
      const amount = await probe();
      expect(await rev()).toMatchObject({ v: 1, applied: null, done: 0, err: "receipt_target_unconfirmed" });
      await withHomeLease(e, HOME, (lease) => reverseCredits(e, lease, qualified(), HOME, NOW + DAY + 60_000));
      expect(targetCalls().map((c) => [c.revision, c.target_removed_microcents])).toEqual([[3, amount]]);
      expect(g().removed).toBe(amount);
      expect(await rev()).toMatchObject({ v: 1, applied: 1, removed: amount, done: 1 });
    });
    it("H1 a router holding an older revision with another target never meets the fenced ask: the target is applied above it and settled", async () => {
      expect(await grant()).toBe(true);
      const amount = g().amount;
      router.targets.set("in_1:period", { revision: 1, target: 0 });
      await cover(ok(4900));
      expect(targetCalls().map((c) => [c.revision, c.target_removed_microcents])).toEqual([[2, amount]]);
      expect(g().removed).toBe(amount);
      expect(await rev()).toMatchObject({ v: 1, applied: 1, removed: amount, done: 1 });
    });
    it("coverage reconciliation re-checks the settled TARGET: one settled against another held target is due again and corrected", async () => {
      expect(await grant()).toBe(true);
      const amount = g().amount;
      await cover(ok(4900));
      expect(await rev()).toMatchObject({ v: 1, applied: 1, removed: amount, done: 1 });
      // A settlement recorded against a different held target (the router holds revision 1 at 0, nothing removed).
      router.targets.set("in_1:period", { revision: 1, target: 0 }); router.accountAvailable.set(FLUX_ACCT, amount); g().removed = 0;
      await env.DB.prepare("UPDATE credit_reversals SET target_microcents=0,removed_microcents=0").run();
      await cover(ok(4900), qualified(), NOW + 2 * DAY); // the same coverage: only the target re-check can find it
      expect(g().removed).toBe(amount);
      expect(router.accountAvailable.get(FLUX_ACCT)).toBe(0);
      expect(await rev()).toMatchObject({ v: 2, applied: 2, removed: amount, done: 1 });
    });
  });
  describe("Astra JOURNEY-A-9 #2: a legacy refund-backed /reverse row is reconciled with the router before it becomes a target", () => {
    const legacyRow = async (tries: number) => {
      await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,end_plan,detail,created_at,updated_at,payment_intent,paid_cents,refunded_at,stripe_refund_status)
        VALUES ('mismatch:x','mismatch',?,?,'in_1',0,'{}',?,?,'pi_1',4900,?,'succeeded')`).bind(HOME, OWNER, NOW, NOW, NOW).run();
      await env.DB.prepare(`INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at,tries,attempts,last_attempt_at)
        VALUES ('in_1','period',?,'mismatch','mismatch:x',?,?,0,?)`).bind(HOME, NOW, tries, NOW).run();
    };
    const reverseWith = (hooks: FluxEntitlementHooks, at: number) => withHomeLease(e, HOME, (lease) => reverseCredits(e, lease, hooks, HOME, at));
    it("probe: /reverse committed, its response lost, the refund later fails: journal and router agree and the credit is restored", async () => {
      expect(await grant()).toBe(true);
      const amount = g().amount;
      await legacyRow(1);
      // The old code's /reverse: committed at the router, its answer lost (reversed_at stays NULL).
      router.next = "apply_then_drop";
      await expect(router.fetch("https://router.test/internal/cloud-home/credit-grants/reverse", { method: "POST", headers: { authorization: `Bearer ${router.token}` },
        body: JSON.stringify({ grant_id: "in_1:period", invoice_id: "in_1", kind: "period", home_id: HOME, reason: "mismatch" }) })).rejects.toThrow();
      expect(g().removed).toBe(amount);
      // Never "unexecuted": while the ask may be in flight nothing changes; a router that cannot be asked keeps it pending and alerted.
      await reverseWith(qualified(), NOW + 60_000);
      expect(await rev()).toMatchObject({ scope: "full", done: 0 });
      await reverseWith(qualified(), NOW + DAY);
      expect(await rev()).toMatchObject({ scope: "full", done: 0, err: "legacy_reversal_unreconciled" });
      expect(await alerts("credit.reversal_pending")).toBe(1);
      // The cutover guard reports it (sweep report + alert).
      expect((await legacyReversalReport(e)).rows).toEqual([{ homeId: HOME, grantId: "in_1:period", dispatched: true, lastError: "legacy_reversal_unreconciled" }]);
      await sweepLegacyReversals(e, NOW + DAY);
      expect(await alerts("credit.legacy_reversal_unreconciled")).toBe(1);
      // The router reports the grant REVERSED: the target starts from the removal it applied.
      router.grantState = true; router.adoptLegacyReversal = true;
      await reverseWith(qualified(), NOW + 2 * DAY);
      expect(await rev()).toMatchObject({ scope: "target", applied: 0, removed: amount, sent: 0, done: 0 });
      expect(router.requests.filter((r) => r.path.endsWith("/reverse"))).toHaveLength(1); // only the historical one
      expect((await legacyReversalReport(e)).unreconciled).toBe(0);
      await sweepLegacyReversals(e, NOW + 2 * DAY);
      expect(await alerts("credit.legacy_reversal_unreconciled")).toBe(0);
      // The refund fails: the target falls to zero and the credit is RESTORED at the router, with the journal agreeing.
      await cover([{ id: "re_1", amount: 4900, status: "failed" }], qualified(), NOW + 3 * DAY);
      expect(targetCalls().map((c) => [c.revision, c.target_removed_microcents])).toEqual([[2, 0]]);
      expect(JSON.parse(router.requests.filter((r) => r.path.endsWith("/reversal-target"))[0].body!).adopt_legacy_reversal).toBe(true);
      expect(g().removed).toBe(0);
      expect(router.accountAvailable.get(FLUX_ACCT)).toBe(amount);
      expect(await rev()).toMatchObject({ c: 0, applied: 2, removed: 0, done: 1 });
      // A /reverse arriving late is refused: the grant is under a target now.
      const late = await router.fetch("https://router.test/internal/cloud-home/credit-grants/reverse", { method: "POST", headers: { authorization: `Bearer ${router.token}` },
        body: JSON.stringify({ grant_id: "in_1:period", invoice_id: "in_1", kind: "period", home_id: HOME, reason: "mismatch" }) });
      expect(late.status).toBe(409);
      expect(g().removed).toBe(0);
    });
    it("a dispatched /reverse the router never applied: converted with sent_revision 0, never settled locally at zero, only on a router receipt", async () => {
      expect(await grant()).toBe(true);
      await legacyRow(1);
      router.grantState = true;
      await reverseWith(qualified(), NOW + DAY);
      expect(await rev()).toMatchObject({ scope: "target", sent: 0, applied: null, done: 0 });
      await reverseWith(qualified(), NOW + DAY + 60_000);
      expect(targetCalls().map((c) => [c.revision, c.target_removed_microcents])).toEqual([[2, 0]]); // asked, not assumed (lane H1: fenced wire revision)
      expect(await rev()).toMatchObject({ applied: 1, removed: 0, done: 1 });
    });
    it("a router that reports the grant reversed but cannot adopt it: pending, nothing restored or settled", async () => {
      expect(await grant()).toBe(true);
      await legacyRow(1);
      router.next = "apply_then_drop";
      await router.fetch("https://router.test/internal/cloud-home/credit-grants/reverse", { method: "POST", headers: { authorization: `Bearer ${router.token}` },
        body: JSON.stringify({ grant_id: "in_1:period", invoice_id: "in_1", kind: "period", home_id: HOME, reason: "mismatch" }) }).catch(() => undefined);
      router.grantState = true;
      await reverseWith(qualified(), NOW + DAY);
      await cover([{ id: "re_1", amount: 4900, status: "failed" }], qualified(), NOW + 2 * DAY);
      expect(targetCalls()).toEqual([]);
      expect(g().removed).toBe(g().amount);
      expect(await rev()).toMatchObject({ applied: 0, removed: g().amount, done: 0, err: "router_adopt_capability_absent" });
    });
  });
  it("#2 a router without the target route removes nothing: the target stays pending (never a full reversal in its place)", async () => {
    router.reversalTargets = false;
    expect(await grant()).toBe(true);
    await cover(ok(4900), qualified());
    expect(await rev()).toMatchObject({ v: 1, sent: 1, done: 0 });
    expect(g().removed).toBe(0);
    expect(router.requests.filter((r) => r.path.endsWith("/reverse"))).toEqual([]);
  });
});

describe("D3: the token guard runs before ANY dispatch", () => {
  for (const url of ["https://router.test", undefined]) {
    it(`token absent (URL ${url ? "set" : "absent"}): no router call, no stub, the claim is kept, ONE alert, no stamp`, async () => {
      e = envWith({ FLUX_CLOUD_GRANTS_TOKEN: undefined, FLUX_CLOUD_GRANTS_URL: url });
      // the real hooks switched on (the stub never dispatches at all: Astra JOURNEY-A-10 #1)
      expect(await grant()).toBe(false);
      await sweep(NOW + DAY);
      await sweep(NOW + 2 * DAY);
      expect(router.requests).toHaveLength(0);
      expect(await stubLogRows()).toBe(0);
      expect(await row()).toMatchObject({ g: null, err: "grants_token_absent" });
      expect((await row())!.body === null).toBe(url === undefined); // quiesced state: frozen, not sent
      expect(await alerts("credit.grants_token_absent")).toBe(1);
    });
  }
  it("token set but URL absent: refused with its own alert, never the stub", async () => {
    e = envWith({ FLUX_CLOUD_GRANTS_URL: undefined });
    expect(await grant()).toBe(false);
    expect(await row()).toMatchObject({ err: "grants_url_absent" });
    expect(await stubLogRows()).toBe(0);
    expect(await alerts("credit.grants_url_absent")).toBe(1);
  });
  it("token absent: a reversal is refused too, and the usage page reads nothing", async () => {
    e = envWith({ FLUX_CLOUD_GRANTS_TOKEN: undefined });
    await env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at) VALUES ('in_1','period',?,'refunded',NULL,?)").bind(HOME, NOW).run();
    await reverse();
    await expect(flux().usedIncludedCreditMicrocents(e, { homeId: HOME, periodStart: P_START, periodEnd: P_END, usedThrough: NOW })).rejects.toThrow("included_credit_unavailable");
    expect(router.requests).toHaveLength(0);
    expect((await env.DB.prepare("SELECT last_error AS e FROM credit_reversals").first<{ e: string }>())!.e).toBe("grants_token_absent");
  });
  it("sends only the grants token as the bearer; a wrong token is a plain failure (401), not a retry", async () => {
    await grant();
    expect(router.requests[0].auth).toBe(`Bearer ${router.token}`);
    e = envWith({ FLUX_CLOUD_GRANTS_TOKEN: "w".repeat(40) });
    await env.DB.prepare("UPDATE credit_grants SET granted_at=NULL").run();
    await expect(sweep()).rejects.toThrow(/grants_router_401/);
  });
  it("preflight (runbook): fails whenever router issuance could be on while the CP lacks grant config", () => {
    const ok = { FLUX_CLOUD_GRANTS_URL: "https://router.test", FLUX_CLOUD_GRANTS_TOKEN: "g".repeat(40), FLUX_CLOUD_SERVICE_TOKEN: "k".repeat(40) };
    expect(grantsIssuancePreflight(ok)).toEqual({ ok: true, problems: [] });
    expect(grantsIssuancePreflight({ ...ok, FLUX_CLOUD_GRANTS_TOKEN: undefined })).toMatchObject({ ok: false, problems: ["FLUX_CLOUD_GRANTS_TOKEN unset"] });
    expect(grantsIssuancePreflight({ ...ok, FLUX_CLOUD_GRANTS_URL: undefined }).ok).toBe(false);
    expect(grantsIssuancePreflight({ ...ok, FLUX_CLOUD_GRANTS_URL: "http://router.test" }).problems).toContain("FLUX_CLOUD_GRANTS_URL not https");
    expect(grantsIssuancePreflight({ ...ok, FLUX_CLOUD_GRANTS_TOKEN: "short" }).problems).toContain("FLUX_CLOUD_GRANTS_TOKEN shorter than 32");
    expect(grantsIssuancePreflight({ ...ok, FLUX_CLOUD_GRANTS_TOKEN: ok.FLUX_CLOUD_SERVICE_TOKEN }).problems).toContain("FLUX_CLOUD_GRANTS_TOKEN equals the keys token");
    expect(grantsIssuancePreflight({ ...ok, FLUX_B4_CONFIG: "{" }).problems).toContain("FLUX_B4_CONFIG invalid");
    expect(JSON.stringify(grantsIssuancePreflight({ ...ok, FLUX_CLOUD_GRANTS_TOKEN: "sk-flux-" + "s".repeat(40) }))).not.toContain("s".repeat(40));
  });
  it("usage reads consumed over grants whose period_end is in (start, end]; a fault is never 0", async () => {
    await grant();
    router.grants.get("in_1:period")!.consumed = 1234;
    const read = (s: number, en: number) => flux().usedIncludedCreditMicrocents(e, { homeId: HOME, periodStart: s, periodEnd: en, usedThrough: NOW });
    expect(await read(P_START, P_END)).toEqual({ usedMicrocents: 1234 });
    expect(await read(P_END, P_END + 30 * DAY)).toEqual({ usedMicrocents: 0 }); // left-open: the boundary grant belongs to the earlier period
    router.usageFault = true;
    await expect(read(P_START, P_END)).rejects.toThrow("included_credit_unavailable");
    router.usageFault = false; router.enabled = false;
    await expect(read(P_START, P_END)).rejects.toThrow("included_credit_unavailable");
  });
});

describe("contract double mirrors the router", () => {
  const post = (body: unknown, over: { auth?: string; path?: string; raw?: string; headers?: Record<string, string> } = {}) =>
    router.fetch(`https://router.test/internal/cloud-home/credit-grants${over.path ?? ""}`, { method: "POST",
      headers: { authorization: over.auth ?? `Bearer ${router.token}`, ...over.headers }, body: over.raw ?? JSON.stringify(body) });
  const good = async () => {
    const b = await composeFrozenBody(e, INPUT);
    return JSON.parse((b as { json: string }).json) as Record<string, unknown>;
  };
  it("404 flag-off envelope has no reason field; misconfigured token 503; 401", async () => {
    router.enabled = false;
    expect(await (await post({})).json()).toEqual({ status: "not_found", error: { code: "not_found", message: "not found" } });
    router.enabled = true; router.token = "short";
    const m = await post({});
    expect([m.status, await m.json()]).toEqual([503, { status: "misconfigured", error: { code: "misconfigured", message: "grants authority is not configured" } }]);
    router.token = "t".repeat(40);
    expect((await post({}, { auth: "Bearer nope" })).status).toBe(401);
  });
  it("413 payload_too_large (declared or streamed), 400 for unknown fields, a non-object and date overflow", async () => {
    expect((await post(null, { raw: "x".repeat(16 * 1024 + 1) })).status).toBe(413);
    expect((await post(null, { raw: "{}", headers: { "content-length": "99999" } })).status).toBe(413);
    // Store validation renders error.message only: no top-level and no nested reason (route _err without a reason).
    expect(await (await post({ ...(await good()), extra: 1 })).json()).toEqual({ status: "invalid_request", error: { code: "invalid_request", message: "unknown field(s) in body" } });
    expect((await post([1])).status).toBe(400);
    const over = { ...(await good()), period_start: "9999-11-01T00:00:00+00:00", period_end: "9999-12-15T00:00:00+00:00", expires_at: "9999-12-15T00:00:00+00:00" };
    expect(await (await post(over)).json()).toEqual({ status: "invalid_request", error: { code: "invalid_request", message: "period_end plus one calendar month is out of the supported date range" } });
    const rev = await post({ grant_id: "in_1:period", invoice_id: "in_1", kind: "period", home_id: HOME, reason: "r".repeat(501) }, { path: "/reverse" });
    expect([rev.status, Object.keys(await rev.json()).sort()]).toEqual([400, ["error", "status"]]);
    expect((await post({ ...(await good()), amount_microcents: true })).status).toBe(400);
    expect((await post({ ...(await good()), period_end: "2027-02-15T12:00:00" })).status).toBe(400);
  });
  it("success fields, and a changed body for the same id is 409 idempotency_conflict", async () => {
    const b = await good();
    expect(await (await post(b)).json()).toEqual({ status: "granted", state: "active", amount_microcents: 10_000_000, available_microcents: 10_000_000,
      account_available_microcents: 10_000_000 });
    expect(await (await post({ ...b, amount_microcents: 1 })).json()).toMatchObject({ status: "idempotency_conflict" });
    expect(await (await post(b)).json()).toEqual({ status: "already_granted", state: "active", amount_microcents: 10_000_000, available_microcents: 10_000_000 });
  });
});

describe("no_money_path_reads_usage", () => {
  it("legal-flows.ts and legal-refunds.ts never call the usage hooks", () => {
    for (const [name, src] of [["legal-flows.ts", legalFlows], ["legal-refunds.ts", legalRefunds]] as const) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, name).not.toMatch(/usedIncludedCreditMicrocents|includedCreditMicrocents/);
      expect(code, name).not.toMatch(/\.usage\b|\/credit-grants\/usage/);
    }
  });
});

describe("Astra WP5-P4-CP-3: hold markers, first-time holds and journaled reversals", () => {
  const HOUR = 3_600_000;
  const meta = () => env.DB.prepare("SELECT alerted_at AS al,last_attempt_at AS l FROM credit_grants WHERE invoice_id='in_1'").first<{ al: number | null; l: number | null }>();
  const pendingDetail = async () => JSON.parse((await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE kind='credit.grant_pending' AND resolved_at IS NULL")
    .first<{ detail: string }>())!.detail);
  it("#1: a cleared hold loses its marker before dispatch; raw 500s then count, escalate and the held alert is resolved", async () => {
    await env.DB.prepare("DELETE FROM flux_links").run();
    expect(await grant()).toBe(false);
    expect(await alerts("credit.grant_held")).toBe(1);
    await link(0);
    for (let i = 1; i <= 4; i++) {
      router.next = "http500";
      await expect(sweep(NOW + i * DAY)).rejects.toThrow(/grants_router_500/);
    }
    const r = (await row())!;
    expect(r).toMatchObject({ g: null, t: 4, a: 0, err: null });
    expect(r.body).not.toBeNull();
    expect(grantCalls()).toHaveLength(4);
    expect((await meta())!.al).not.toBeNull();
    expect(await alerts("credit.grant_pending")).toBe(1);
    expect(await pendingDetail()).toMatchObject({ grantIds: ["in_1:period"], grants: [{ invoiceId: "in_1", kind: "period", error: "infra_failing" }] });
    expect(await alerts("credit.grant_held")).toBe(0);
    // the next ask that succeeds grants it and clears the escalation
    await sweep(NOW + 5 * DAY);
    expect((await row())!.g).toBe(NOW + 5 * DAY);
    expect(await alerts("credit.grant_pending")).toBe(0);
  });
  it("#2: an untried claim resumed after 2 hours is classified held first: no escalation, held alert only", async () => {
    await env.DB.prepare("DELETE FROM flux_links").run();
    // interrupted right after the claim INSERT: never asked, no stamp
    await env.DB.prepare(`INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,period_start,period_end,subscription_id)
      VALUES ('in_1','period',?,'starter',?,?,?,'sub_1')`).bind(HOME, NOW, P_START, P_END).run();
    await sweep(NOW + 2 * HOUR);
    expect(await row()).toMatchObject({ g: null, a: 0, t: 0, err: "grant_held:recipient_unlinked" });
    expect(await meta()).toEqual({ al: null, l: NOW + 2 * HOUR });
    expect(router.requests).toHaveLength(0);
    expect(await alerts("credit.grant_pending")).toBe(0);
    expect(await alerts("credit.grant_held")).toBe(1);
    await sweep(NOW + 5 * HOUR);
    expect((await meta())!.al).toBeNull();
    expect(await alerts("credit.grant_pending")).toBe(0);
  });
  it("#2: an escalation justified earlier is kept when the claim is later held", async () => {
    await env.DB.prepare(`INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,period_start,period_end,subscription_id,last_attempt_at,tries)
      VALUES ('in_1','period',?,'starter',?,?,?,'sub_1',?,3)`).bind(HOME, NOW, P_START, P_END, NOW + HOUR).run();
    await env.DB.prepare("DELETE FROM flux_links").run();
    await sweep(NOW + 3 * HOUR); // pre-call rebuild: 3 raw failures already on record -> escalated, then held
    expect(await row()).toMatchObject({ err: "grant_held:recipient_unlinked" });
    expect((await meta())!.al).toBe(NOW + 3 * HOUR);
    expect(await alerts("credit.grant_pending")).toBe(1);
    expect(await alerts("credit.grant_held")).toBe(1);
  });
  it("#3: a journaled reversal resolves credit.grant_held even when the router answers 503", async () => {
    await env.DB.prepare("DELETE FROM flux_links").run();
    expect(await grant()).toBe(false);
    expect(await alerts("credit.grant_held")).toBe(1);
    await env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at) VALUES ('in_1','period',?,'refunded',NULL,?)").bind(HOME, NOW).run();
    router.next = "busy";
    await reverse();
    expect(await env.DB.prepare("SELECT attempts AS a,last_error AS e,reversed_at AS r FROM credit_reversals").first()).toEqual({ a: 1, e: "credit_grants_retry:busy", r: null });
    expect(await alerts("credit.grant_held")).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.grant_held' AND resolved_at=?").bind(NOW + DAY).first<{ n: number }>())!.n).toBe(1);
  });
});
