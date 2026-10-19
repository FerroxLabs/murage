// SPDX-License-Identifier: AGPL-3.0-or-later
// Lane H1 (Flux on): the grant fence (flux-grant-fence.ts, migration 0109), the B4 grant/revoke rerouted to the router's grant routes, the
// shared grant ownership (B4, B5, an operator's dispute-credit claim) and ensure-account (auto-link). The Flux side is a FAKE implementing
// FluxMain's confirmed rules: a revision below the applied one is 409 stale_revision (no side effect), the same revision with the same body
// replays the original 200, the same revision with another body is 409 idempotency_mismatch. Every test asserts the account's prepaid and
// spent balances, which no grant mutation may touch.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFluxClient, grantMonthlyCredits, recordRemoteRevision, sweepFlux, type FluxDependencies } from "../src/b4-flux";
import { operatorApplied, operatorClaim } from "../src/b4-flux-ledger";
import { claimDisputeCredit, markDisputeCreditApplied, stubFluxHooks, type FluxEntitlementHooks } from "../src/b5-billing";
import { withHomeLease } from "../src/billing-lease";
import { allocateFenceRevision, claimGrantFence, fenceDue, fenceHeld, fenceOf, reconcileFences, reconcileOne, settleFenceRevision, type RemoteGrantState } from "../src/flux-grant-fence";
import { FluxNotDispatched, FluxRevisionMismatch, grantsHooks, readGrantState, sha256Hex } from "../src/flux-grants";

const QUALIFIED = { stub: false, capabilities: { reversalTargets: true } } as unknown as NonNullable<FluxDependencies["billingFlux"]>;
const HOME = "home-h1";
const OWNER = "user-h1";
const ACCT = "flux-acct-h1";
const SERVICE = "s".repeat(40);
const GRANTS = "g".repeat(40);
const P_START = Date.parse("2026-10-01T00:00:00Z");
const P_END = Date.parse("2026-11-01T00:00:00Z");
const PREPAID = 12_000_000;

type Json = Record<string, unknown>;
/** FluxMain's partner API as the control plane sees it, with the revision fence. */
class FenceFlux {
  requests: { method: string; path: string; body: Json | null; auth: string | null }[] = [];
  accounts = new Map<string, { flux: string; email: string }>();
  ensureAnswer: { status: number; body: Json } | null = null;
  ensureCalls = 0;
  grants = new Map<string, { account: string; amount: number; spent: number; remaining: number; state: string }>();
  fence = new Map<string, { applied: number; seen: Map<number, { sha: string; body: string }> }>();
  prepaid = new Map<string, number>();
  /** Requests held in flight (the caller sees a timeout), executed only by release(). */
  hold = false;
  private delayed: { path: string; body: Json }[] = [];

  spend(grantId: string, x: number) { const g = this.grants.get(grantId)!; g.spent += x; g.remaining -= x; }
  /** An operator's hand adjustment in the Flux admin (no revision): restores the unspent value. */
  adminRestore(grantId: string) { const g = this.grants.get(grantId)!; g.remaining = g.amount - g.spent; g.state = "active"; }
  balances(account: string) {
    return { prepaid: this.prepaid.get(account) ?? PREPAID, spent: [...this.grants.values()].filter((g) => g.account === account).reduce((s, g) => s + g.spent, 0) };
  }
  calls(path: string) { return this.requests.filter((r) => r.path === path); }
  async release() {
    const out: { status: number; json: Json }[] = [];
    for (const d of this.delayed.splice(0)) { const r = await this.mutate(d.path, d.body); out.push({ status: r.status, json: await r.json() as Json }); }
    return out;
  }

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Json : null;
    this.requests.push({ method, path: u.pathname, body, auth });
    const j = (status: number, o: unknown) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/internal/cloud-home/accounts/ensure" && method === "POST") {
      if (auth !== `Bearer ${SERVICE}`) return j(401, { code: "unauthorized" });
      this.ensureCalls++;
      if (this.ensureAnswer) return j(this.ensureAnswer.status, this.ensureAnswer.body);
      const id = String(body!.murage_account_id);
      const known = this.accounts.get(id);
      if (known) return j(200, { flux_account_id: known.flux, created: false });
      this.accounts.set(id, { flux: ACCT, email: String(body!.email) });
      return j(200, { flux_account_id: ACCT, created: true });
    }
    if (!u.pathname.startsWith("/internal/cloud-home/credit-grants")) return j(404, { detail: "Not Found" });
    if (auth !== `Bearer ${GRANTS}`) return j(401, { code: "unauthorized" });
    if (method === "GET" && u.pathname.endsWith("/capabilities")) return j(200, { capabilities: { reversalTargets: true, grantWithTarget: true } });
    if (method === "GET" && u.pathname.endsWith("/state")) {
      const id = u.searchParams.get("grant_id") ?? "";
      const g = this.grants.get(id);
      return j(200, { grant_id: id, state: g ? g.state : "not_found", applied_revision: this.fence.get(id)?.applied ?? 0, remaining_microcents: g?.remaining ?? 0,
        expires_at: "2026-12-01T00:00:00+00:00", extra_field_flux_may_add: true });
    }
    if (this.hold) { this.delayed.push({ path: u.pathname, body: body! }); throw new TypeError("timeout"); }
    return this.mutate(u.pathname, body!);
  };

  private async mutate(path: string, b: Json): Promise<Response> {
    const j = (status: number, o: unknown) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    const id = String(b.grant_id);
    const rev = b.revision as number;
    const f = this.fence.get(id) ?? { applied: 0, seen: new Map() };
    const { revision: _r, ...rest } = b;
    const sha = JSON.stringify(rest);
    if (!(Number.isSafeInteger(rev) && rev >= 1)) return j(400, { code: "invalid_request" });
    if (rev < f.applied) return j(409, { code: "stale_revision", error: { code: "stale_revision" }, applied_revision: f.applied, latest_revision: f.applied });
    const prior = f.seen.get(rev);
    if (prior) return prior.sha === sha ? new Response(prior.body, { status: 200 }) : j(409, { code: "idempotency_mismatch", applied_revision: f.applied });
    let answer: Json;
    const g = this.grants.get(id);
    if (path.endsWith("/reverse")) {
      if (!g) { this.grants.set(id, { account: "", amount: 0, spent: 0, remaining: 0, state: "tombstoned" }); answer = { status: "no_grant" }; }
      else { g.remaining = 0; g.state = "reversed"; answer = { status: "reversed", removed_microcents: g.amount - g.spent, consumed_microcents: g.spent }; }
    } else if (path.endsWith("/reversal-target")) {
      if (!g) return j(404, { code: "grant_not_found" });
      const removed = Math.min(b.target_removed_microcents as number, g.amount - g.spent);
      g.remaining = g.amount - g.spent - removed; g.state = removed > 0 ? "reversed" : "active";
      answer = { status: "applied", grant_id: id, revision: rev, removed_microcents: removed, consumed_microcents: g.spent, target_removed_microcents: b.target_removed_microcents };
    } else {
      if (g?.state === "tombstoned") answer = { status: "not_applied_reversed" };
      else if (g) answer = { status: "already_granted", state: g.state, amount_microcents: g.amount };
      else {
        this.grants.set(id, { account: String(b.account_id), amount: b.amount_microcents as number, spent: 0, remaining: b.amount_microcents as number, state: "active" });
        answer = { status: "granted", state: "active", amount_microcents: b.amount_microcents };
      }
    }
    const text = JSON.stringify(answer);
    f.applied = Math.max(f.applied, rev); f.seen.set(rev, { sha, body: text }); this.fence.set(id, f);
    return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
  }
}

let router: FenceFlux;
let clock = Date.parse("2026-10-09T12:00:00Z");
const fluxEnv = (over: Record<string, string | undefined> = {}) => ({ ...env, CLOUD_FLUX_ROUTES_ENABLED: "1", FLUX_CLOUD_SERVICE_TOKEN: SERVICE,
  FLUX_API_BASE: "https://api.fluxrouter.ai", FLUX_APP_BASE: "https://fluxrouter.ai", FLUX_CLOUD_GRANTS_URL: "https://router.test",
  FLUX_CLOUD_GRANTS_TOKEN: GRANTS, ...over }) as Env;
const deps = (): FluxDependencies => ({ fluxClient: (e) => createFluxClient(e, router.fetch as typeof fetch), billingFlux: QUALIFIED, now: () => clock });
const hooks = (): FluxEntitlementHooks => ({ ...stubFluxHooks, ...grantsHooks(router.fetch, { reversalTargets: true }), stub: false });
const seedHome = (owner = OWNER) => env.DB.prepare(`INSERT OR IGNORE INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
  VALUES (?,?,?,'ready','ready','sha256:x','k',1,1)`).bind(HOME, `inst-${HOME}`, owner).run();
const linkOwner = () => env.DB.prepare("INSERT INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES (?,?,1,'lnk-h1',1,0)")
  .bind(OWNER, ACCT).run();
const seedIdentity = async () => {
  await env.DB.prepare(`INSERT OR IGNORE INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)`).bind(OWNER, "n", `cloud-${OWNER}@cloud-account.invalid`).run();
  await env.DB.prepare("INSERT OR IGNORE INTO supabase_identities (sub,user_id,via,created_at,email_revision,contact_email) VALUES (?,?,'created',1,0,?)")
    .bind("sub-h1", OWNER, "owner-h1@example.test").run();
};
const cover = (invoiceId: string, covered: number) => env.DB.prepare(`INSERT INTO refund_coverage
    (home_id,payment_intent,invoice_id,subscription_id,paid_cents,covered_cents,open_cents,end_plan,changed_at,created_at) VALUES (?,?,?,'sub_a',4900,?,0,0,?,?)
  ON CONFLICT(home_id,payment_intent) DO UPDATE SET covered_cents=excluded.covered_cents`).bind(HOME, `pi_${invoiceId}`, invoiceId, covered, clock, clock).run();
const routerRouteCalls = () => router.requests.filter((r) => r.path.startsWith("/api/internal/cloud/credit-grants"));

beforeEach(() => { router = new FenceFlux(); clock = Date.parse("2026-10-09T12:00:00Z"); });
afterEach(async () => {
  for (const t of ["cloud_homes", "supabase_identities", "refund_coverage", "flux_grant_fence", "flux_grant_revisions", "credit_grants", "dispute_credit_obligations"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  await env.DB.prepare(`DELETE FROM "user" WHERE id=?`).bind(OWNER).run();
});

describe("H1 the remote revision fence closes the late-revoke P1 (b4-flux-ledger.ts R11)", () => {
  it("H1 revoke A stalls, revoke B confirms, the credit is restored, A lands: A is refused and the balance is the restored amount", async () => {
    const e = fluxEnv();
    await seedHome(); await linkOwner();
    const granted = await grantMonthlyCredits(e, { homeId: HOME, plan: "starter", invoiceId: "in_h1", ...{ periodStart: P_START, periodEnd: P_END } }, deps());
    expect(granted.status).toBe("done");
    const id = "in_h1:period";
    const amount = router.grants.get(id)!.amount;
    router.spend(id, 1_000_000);
    // The payment is refunded in full: the ledger revokes. Revoke A stalls at the router (in flight, its answer lost).
    await cover("in_h1", 4900);
    router.hold = true;
    await sweepFlux(e, deps());
    const a = await env.DB.prepare("SELECT dispatch_id,state,remote_revision,wire_grant_id FROM flux_grant_dispatches WHERE grant_id='inv:in_h1' AND kind='revoke'")
      .first<{ dispatch_id: string; state: string; remote_revision: number; wire_grant_id: string }>();
    expect(a).toMatchObject({ state: "open", remote_revision: 2, wire_grant_id: id });
    // A's claim expires; revoke B supersedes it and is confirmed.
    router.hold = false;
    await env.DB.prepare("UPDATE flux_grant_dispatches SET expires_at=0 WHERE state='open'").run();
    clock += 11 * 60_000;
    await sweepFlux(e, deps());
    expect(router.grants.get(id)!.remaining).toBe(0);
    expect((await env.DB.prepare("SELECT state FROM flux_grant_dispatches WHERE dispatch_id=?").bind(a!.dispatch_id).first())).toEqual({ state: "superseded" });
    expect((await fenceOf(env.DB, id))!.applied_revision).toBe(3);
    // The refund fails: the credit is owed again and an operator restores it by hand. R11: A's revision (2) is below what Flux applied (3),
    // so A is TERMINATED and the restoration receipt is accepted (pending Flux's own verification), never refused as termination_unconfirmed.
    await cover("in_h1", 0);
    const claim = await operatorClaim(env.DB, { grantId: "inv:in_h1", by: "ops-h1", now: clock });
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) return;
    router.adminRestore(id);
    expect(await operatorApplied(env.DB, { grantId: "inv:in_h1", token: claim.token, revision: claim.account.revision, wireRevision: claim.wireRevision ?? undefined, appliedMicrocents: amount - 1_000_000,
      adjustmentRef: claim.adjustmentRef, evidence: "Flux admin restore (h1)", by: "ops-h1", now: clock })).toBe("pending_verification");
    // Revoke A finally lands: refused by the fence, nothing removed.
    expect((await router.release()).map((r) => [r.status, r.json.code])).toEqual([[409, "stale_revision"]]);
    expect(router.grants.get(id)!.remaining).toBe(amount - 1_000_000);
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 1_000_000 });
    expect(routerRouteCalls()).toEqual([]);
  });

  it("H1 without the fence the same restoration would be refused while A is unterminated (a superseded revoke above Flux's applied revision)", async () => {
    const e = fluxEnv();
    await seedHome(); await linkOwner();
    await grantMonthlyCredits(e, { homeId: HOME, plan: "starter", invoiceId: "in_h1b", periodStart: P_START, periodEnd: P_END }, deps());
    await cover("in_h1b", 4900);
    router.hold = true;
    await sweepFlux(e, deps());
    router.hold = false;
    await env.DB.prepare("UPDATE flux_grant_dispatches SET expires_at=0 WHERE state='open'").run();
    // A was superseded but nothing newer applied at Flux (B never sent): A may still execute, so a restoration is refused.
    await env.DB.prepare("UPDATE flux_grant_dispatches SET state='superseded' WHERE state='open'").run();
    await cover("in_h1b", 0);
    const claim = await operatorClaim(env.DB, { grantId: "inv:in_h1b", by: "ops-h1", now: clock });
    if (!claim.claimed) throw new Error("not claimed");
    expect(await operatorApplied(env.DB, { grantId: "inv:in_h1b", token: claim.token, revision: claim.account.revision, wireRevision: claim.wireRevision ?? undefined, appliedMicrocents: 1,
      adjustmentRef: claim.adjustmentRef, evidence: "x evidence", by: "ops-h1", now: clock })).toBe("termination_unconfirmed");
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 0 });
  });
});

describe("H1 shared grant ownership (fence F1-F4)", () => {
  const seedGrant = async (id: string) => {
    await router.fetch("https://router.test/internal/cloud-home/credit-grants", { method: "POST", headers: { authorization: `Bearer ${GRANTS}` },
      body: JSON.stringify({ grant_id: id, account_id: ACCT, amount_microcents: 10_000_000, revision: 1 }) });
    const c = (await claimGrantFence(env.DB, { grantId: id, kind: "seed" }))!;
    await allocateFenceRevision(env.DB, c, { op: "grant" });
    await env.DB.prepare("UPDATE flux_grant_fence SET applied_revision=1,owner_token=NULL,owner_expires_at=NULL WHERE grant_id=?").bind(id).run();
    await env.DB.prepare("UPDATE flux_grant_revisions SET outcome='applied' WHERE grant_id=?").bind(id).run(); // settled (no orphan, H2)
    router.requests.length = 0;
  };
  const reverseInput = (id: string) => ({ homeId: HOME, invoiceId: id.split(":")[0], kind: "period" as const, grantId: id, reason: "h1" });

  it("H1 two claimants racing one grant: exactly one remote effect, the other sends nothing", async () => {
    const e = fluxEnv();
    await seedGrant("in_race:period");
    const h = hooks();
    const results = await Promise.allSettled([h.revokeCredits(e, reverseInput("in_race:period")), h.revokeCredits(e, reverseInput("in_race:period"))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(FluxNotDispatched);
    expect(lost.reason.code).toBe("grant_owner_busy");
    expect(router.calls("/internal/cloud-home/credit-grants/reverse")).toHaveLength(1);
    expect(router.grants.get("in_race:period")!.remaining).toBe(0);
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 0 });
  });

  it("H1 an expired claimant can allocate nothing, and its late request is refused by Flux", async () => {
    const e = fluxEnv();
    await seedGrant("in_exp:period");
    router.spend("in_exp:period", 2_000_000);
    // Claimant X takes the grant and allocates revision 2 for a full removal, then stalls past its claim.
    const x = (await claimGrantFence(env.DB, { grantId: "in_exp:period", kind: "x" }))!;
    const xRev = (await allocateFenceRevision(env.DB, x, { op: "target", floor: 1 }))!;
    expect(xRev).toBe(2);
    await env.DB.prepare("UPDATE flux_grant_fence SET owner_expires_at=0 WHERE grant_id='in_exp:period'").run();
    // Claimant Y takes over (compare-and-set on the expired claim) and sets a lower target: revision 3.
    const receipt = await hooks().setReversalTarget!(e, { ...reverseInput("in_exp:period"), targetRemovedMicrocents: 1_000_000, revision: 1 });
    expect(receipt).toMatchObject({ revision: 1, removedMicrocents: 1_000_000 });
    expect(router.calls("/internal/cloud-home/credit-grants/reversal-target").map((r) => r.body!.revision)).toEqual([3]);
    // X can no longer allocate or claim to hold the grant ...
    expect(await fenceHeld(env.DB, x)).toBe(false);
    expect(await allocateFenceRevision(env.DB, x, { op: "target" })).toBeNull();
    // ... and its request, arriving late with revision 2, is refused at Flux: nothing changes.
    const late = await router.fetch("https://router.test/internal/cloud-home/credit-grants/reversal-target", { method: "POST", headers: { authorization: `Bearer ${GRANTS}` },
      body: JSON.stringify({ grant_id: "in_exp:period", target_removed_microcents: 10_000_000, revision: xRev }) });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ code: "stale_revision", applied_revision: 3 });
    expect(router.grants.get("in_exp:period")!.remaining).toBe(10_000_000 - 2_000_000 - 1_000_000);
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 2_000_000 });
  });

  it("H1 replay: the same revision and body returns the original answer and changes nothing; another body at that revision is a mismatch, alerted, reconciled", async () => {
    const e = fluxEnv();
    await seedGrant("in_rep:period");
    await hooks().revokeCredits(e, reverseInput("in_rep:period"));
    const sent = router.calls("/internal/cloud-home/credit-grants/reverse")[0];
    const replay = async (body: Json) => router.fetch("https://router.test/internal/cloud-home/credit-grants/reverse", { method: "POST",
      headers: { authorization: `Bearer ${GRANTS}` }, body: JSON.stringify(body) });
    const again = await replay(sent.body!);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "reversed", removed_microcents: 10_000_000, consumed_microcents: 0 });
    expect((await replay({ ...sent.body!, reason: "other" })).status).toBe(409);
    // The control plane's own fence never re-sends a revision: force the collision Flux would see after a CP bug (the next revision is held).
    router.fence.get("in_rep:period")!.seen.set(3, { sha: "other", body: "{}" });
    router.fence.get("in_rep:period")!.applied = 3;
    await env.DB.prepare("UPDATE flux_grant_fence SET next_revision=2,applied_revision=2 WHERE grant_id='in_rep:period'").run();
    await expect(hooks().revokeCredits(e, reverseInput("in_rep:period"))).rejects.toBeInstanceOf(FluxRevisionMismatch);
    expect(await env.DB.prepare("SELECT kind,severity FROM cloud_alerts WHERE kind='credit.revision_mismatch'").first()).toEqual({ kind: "credit.revision_mismatch", severity: "high" });
    expect(await fenceOf(env.DB, "in_rep:period")).toMatchObject({ needs_reconcile: 1, last_outcome: "mismatch", applied_revision: 3 });
    expect(await hooks().reconcileFences!(e)).toBe(1);
    expect(await fenceOf(env.DB, "in_rep:period")).toMatchObject({ needs_reconcile: 0, remote_state: "reversed", remote_remaining_microcents: 0 });
    expect(router.grants.get("in_rep:period")!.remaining).toBe(0);
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 0 });
  });

  it("H1 a dispute-credit claim owns the grants' fence: automatic senders send nothing; once expired its receipt is refused and its late adjustment is stale", async () => {
    const e = fluxEnv();
    await seedHome();
    await seedGrant("in_d:period");
    await env.DB.prepare("INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at) VALUES ('in_d','period',?,'starter',1)").bind(HOME).run();
    await env.DB.prepare(`INSERT INTO dispute_credit_obligations (dispute_id,home_id,invoice_id,returned_cents,exact,state,recorded_at,updated_at)
      VALUES ('dp_h1',?,'in_d',4900,1,'owed',1,1)`).bind(HOME).run();
    const claim = (await withHomeLease(e, HOME, (lease) => claimDisputeCredit(e, lease, { disputeId: "dp_h1", by: "ops-h1" }, clock)))!;
    expect(claim.fence).toEqual([{ grantId: "in_d:period", epoch: 2, revision: 2 }]);
    await expect(hooks().revokeCredits(e, reverseInput("in_d:period"))).rejects.toBeInstanceOf(FluxNotDispatched);
    expect(router.requests.filter((r) => r.method === "POST")).toEqual([]);
    // The claim expires: its receipt no longer counts, and an automatic sender takes the grant over (revision 3).
    await env.DB.prepare("UPDATE flux_grant_fence SET owner_expires_at=0 WHERE grant_id='in_d:period'").run();
    expect(await withHomeLease(e, HOME, (lease) => markDisputeCreditApplied(e, lease, { disputeId: "dp_h1", token: claim.token, appliedCents: 4900,
      evidence: "Flux adjustment adj_h1 (by hand)", by: "ops-h1" }, clock))).toBe(false);
    expect(await hooks().revokeCredits(e, reverseInput("in_d:period"))).toEqual({ status: "reversed" });
    expect(router.calls("/internal/cloud-home/credit-grants/reverse").map((r) => r.body!.revision)).toEqual([3]);
    // The expired claimant's hand adjustment, carrying its issued revision 2, is refused.
    const late = await router.fetch("https://router.test/internal/cloud-home/credit-grants/reversal-target", { method: "POST",
      headers: { authorization: `Bearer ${GRANTS}` }, body: JSON.stringify({ grant_id: "in_d:period", target_removed_microcents: 0, revision: claim.fence[0].revision }) });
    expect(late.status).toBe(409);
    expect(router.grants.get("in_d:period")!.remaining).toBe(0);
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 0 });
  });
});

describe("H1 ensure-account (auto-link)", () => {
  it("H1 ensure-account is idempotent and called once per owner; the link it writes is the one keys and grants use", async () => {
    const e = fluxEnv();
    await seedHome(); await seedIdentity();
    await grantMonthlyCredits(e, { homeId: HOME, plan: "starter", invoiceId: "in_e1", periodStart: P_START, periodEnd: P_END }, deps());
    await grantMonthlyCredits(e, { homeId: HOME, plan: "starter", invoiceId: "in_e2", periodStart: P_START + 31 * 86_400_000, periodEnd: P_END + 31 * 86_400_000 }, deps());
    await hooks().ensureAccount!(e, { homeId: HOME });
    expect(router.ensureCalls).toBe(1);
    const call = router.calls("/api/internal/cloud-home/accounts/ensure")[0];
    expect(call.auth).toBe(`Bearer ${SERVICE}`);
    expect(call.body).toEqual({ murage_account_id: OWNER, email: "owner-h1@example.test" });
    expect(await env.DB.prepare("SELECT flux_account_id,link_id,link_version,fenced FROM flux_links WHERE owner_user_id=?").bind(OWNER).first())
      .toEqual({ flux_account_id: ACCT, link_id: ACCT, link_version: 1, fenced: 0 });
    expect([...router.grants.values()].map((g) => g.account)).toEqual([ACCT, ACCT]);
    expect(routerRouteCalls()).toEqual([]);
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 0 });
  });

  for (const [status, body, kind, retried] of [
    [503, { code: "ensure_disabled" }, null, true],
    [409, { code: "email_mismatch" }, "flux.ensure_account_refused", false],
    [422, { code: "disposable_email" }, "flux.ensure_account_refused", false],
    [401, { code: "unauthorized" }, "flux.ensure_account_unauthorized", false],
  ] as const) {
    it(`H1 ensure-account ${status}: the grant is held, ${kind ?? "no alert"}, ${retried ? "retried later" : "never retried automatically"}`, async () => {
      const e = fluxEnv();
      await seedHome(); await seedIdentity();
      router.ensureAnswer = { status, body };
      const r = await grantMonthlyCredits(e, { homeId: HOME, plan: "starter", invoiceId: `in_s${status}`, periodStart: P_START, periodEnd: P_END }, deps());
      expect(r.status).toBe("pending");
      await hooks().ensureAccount!(e, { homeId: HOME });
      expect(router.ensureCalls).toBe(retried ? 2 : 1);
      const alerts = (await env.DB.prepare("SELECT kind,severity FROM cloud_alerts WHERE kind LIKE 'flux.ensure_account%'").all()).results;
      expect(alerts).toEqual(kind ? [{ kind, severity: "high" }] : []);
      expect(router.requests.filter((x) => x.path.startsWith("/internal/cloud-home/credit-grants"))).toEqual([]);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_links").first()).toEqual({ n: 0 });
      expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 0 });
    });
  }
});

describe("H1 Flux off: nothing is called, the ledger still books every grant", () => {
  it("H1 switch off: zero calls to Flux (grants, revokes, ensure-account, state), and the grant is booked with its full entitlement", async () => {
    for (const [n, off] of [[0, undefined], [1, "0"]] as const) {
      router = new FenceFlux();
      const e = fluxEnv({ CLOUD_FLUX_ROUTES_ENABLED: off });
      await seedHome(); await seedIdentity();
      const invoice = `in_off_${off ?? "unset"}`;
      const shift = n * 31 * 86_400_000;
      expect((await grantMonthlyCredits(e, { homeId: HOME, plan: "starter", invoiceId: invoice, periodStart: P_START + shift, periodEnd: P_END + shift }, deps())).status).toBe("pending");
      await cover(invoice, 4900);
      await sweepFlux(e, deps());
      const h = hooks();
      await h.ensureAccount!(e, { homeId: HOME });
      expect(await h.reconcileFences!(e)).toBe(0);
      await expect(h.revokeCredits(e, { homeId: HOME, invoiceId: invoice, kind: "period", grantId: `${invoice}:period`, reason: "x" })).rejects.toThrow();
      expect(router.requests).toEqual([]);
      expect(await env.DB.prepare("SELECT status FROM flux_grants WHERE grant_id=?").bind(`inv:${invoice}`).first()).toEqual({ status: "pending" });
      expect(await env.DB.prepare("SELECT amount_microcents>0 AS booked FROM flux_grant_accounts WHERE grant_id=?").bind(`inv:${invoice}`).first()).toEqual({ booked: 1 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_grant_fence").first()).toEqual({ n: 0 });
      expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 0 });
    }
  });
});

// Lane H2: Astra's review of H1. Every P1 has a test reproducing its sequence and proving it closed; every test asserts prepaid and spent.
describe("H2 Astra review of the grant fence", () => {
  const T = "/internal/cloud-home/credit-grants/reversal-target";
  const seed = async (id: string) => {
    await router.fetch("https://router.test/internal/cloud-home/credit-grants", { method: "POST", headers: { authorization: `Bearer ${GRANTS}` },
      body: JSON.stringify({ grant_id: id, account_id: ACCT, amount_microcents: 10_000_000, revision: 1 }) });
    const c = (await claimGrantFence(env.DB, { grantId: id, kind: "seed" }))!;
    const r = (await allocateFenceRevision(env.DB, c, { op: "grant" }))!;
    await settleFenceRevision(env.DB, c, { revision: r, outcome: "applied" });
    router.requests.length = 0;
  };
  const input = (id: string) => ({ homeId: HOME, invoiceId: id.split(":")[0], kind: "period" as const, grantId: id, reason: "h2" });
  const reversal = (id: string, targetRevision: number) => env.DB.prepare(`INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,requested_at,scope,target_revision)
    VALUES (?,'period',?,'h2',1,'target',?) ON CONFLICT(invoice_id,kind) DO UPDATE SET target_revision=excluded.target_revision`).bind(id.split(":")[0], HOME, targetRevision).run();
  afterEach(async () => { for (const t of ["credit_reversals", "billing_home_leases", "flux_grant_dispatches", "cloud_alerts"]) await env.DB.prepare(`DELETE FROM ${t}`).run(); });

  it("H2 P1 stale target: A pauses, B applies logical revision 2 (target 0), A resumes with logical 1: refused at allocation, no wire revision, credit kept", async () => {
    const e = fluxEnv();
    await seed("in_st:period");
    // B: logical revision 2, nothing removed. Applied at Flux at a fenced wire revision.
    expect(await hooks().setReversalTarget!(e, { ...input("in_st:period"), targetRemovedMicrocents: 0, revision: 2 })).toMatchObject({ revision: 2, removedMicrocents: 0 });
    // A resumes with its obsolete logical revision 1 (remove everything): before the fix it received wire revision 3 and Flux removed 10,000,000.
    const late = await hooks().setReversalTarget!(e, { ...input("in_st:period"), targetRemovedMicrocents: 10_000_000, revision: 1 }).catch((x) => x);
    expect(late).toBeInstanceOf(FluxNotDispatched);
    expect(late.code).toBe("logical_revision_superseded");
    expect(router.calls(T).map((r) => r.body!.target_removed_microcents)).toEqual([0]);
    expect(router.grants.get("in_st:period")!.remaining).toBe(10_000_000);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_grant_revisions WHERE grant_id='in_st:period' AND logical_revision=1").first())).toEqual({ n: 0 });
    expect(await fenceOf(env.DB, "in_st:period")).toMatchObject({ owner_token: null });
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 0 });
  });

  it("H2 P1 stale target under the billing lease: the allocation checks the lease and the row's CURRENT target revision in the same statement", async () => {
    const e = fluxEnv();
    await seed("in_sl:period");
    router.spend("in_sl:period", 1_000_000);
    await reversal("in_sl:period", 2); // B journaled revision 2 (not yet sent); A still holds logical 1
    const refused = await withHomeLease(e, HOME, (lease) => hooks().setReversalTarget!(e, { ...input("in_sl:period"), targetRemovedMicrocents: 9_000_000, revision: 1 }, { lease }))
      .catch((x) => x);
    expect(refused).toBeInstanceOf(FluxNotDispatched);
    expect(refused.code).toBe("logical_revision_superseded");
    // A lease that lapsed (taken over meanwhile): refused even at the current revision.
    const stale = await withHomeLease(e, HOME, async (lease) => {
      await env.DB.prepare("UPDATE billing_home_leases SET lease_until=0 WHERE home_id=?").bind(HOME).run();
      return hooks().setReversalTarget!(e, { ...input("in_sl:period"), targetRemovedMicrocents: 0, revision: 2 }, { lease }).catch((x) => x);
    }).catch((x) => x);
    expect(stale).toBeInstanceOf(FluxNotDispatched);
    expect(router.calls(T)).toEqual([]);
    // The live lease at the current revision goes out.
    const ok = await withHomeLease(e, HOME, (lease) => hooks().setReversalTarget!(e, { ...input("in_sl:period"), targetRemovedMicrocents: 0, revision: 2 }, { lease }));
    expect(ok).toMatchObject({ revision: 2, removedMicrocents: 0 });
    expect(router.calls(T)).toHaveLength(1);
    expect(router.grants.get("in_sl:period")!.remaining).toBe(9_000_000);
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 1_000_000 });
  });

  it("H2 P1 operator vs B5: a B4 operator claim takes the shared fence (B5 sends nothing), a B5 owner refuses the operator claim, a lapsed claim's receipt and late adjustment are refused", async () => {
    const e = fluxEnv();
    await seedHome(); await linkOwner();
    expect((await grantMonthlyCredits(e, { homeId: HOME, plan: "starter", invoiceId: "in_op", periodStart: P_START, periodEnd: P_END }, deps())).status).toBe("done");
    const id = "in_op:period";
    const amount = router.grants.get(id)!.amount;
    router.spend(id, 1_000_000);
    router.requests.length = 0;
    // (a) B5 owns the grant: the operator claim is refused and leaves no open dispatch.
    const b5 = (await claimGrantFence(env.DB, { grantId: id, kind: "b5_target" }))!;
    const busy = await operatorClaim(env.DB, { grantId: "inv:in_op", by: "ops-h2", now: clock });
    expect(busy.claimed).toBe(false);
    if (!busy.claimed) expect(busy.open).toMatchObject({ kind: "fence:b5_target" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_grant_dispatches WHERE grant_id='inv:in_op' AND kind='operator'").first()).toEqual({ n: 0 });
    await env.DB.prepare("UPDATE flux_grant_fence SET owner_token=NULL,owner_kind=NULL,owner_expires_at=NULL WHERE owner_token=?").bind(b5.token).run();
    // (b) The operator claims: it owns the shared fence and a wire revision; B5 sends nothing.
    const claim = await operatorClaim(env.DB, { grantId: "inv:in_op", by: "ops-h2", now: clock });
    if (!claim.claimed) throw new Error("not claimed");
    expect(claim.wireGrantId).toBe(id);
    const wire = claim.wireRevision!;
    expect(wire).toBeGreaterThan(1);
    expect(await claimGrantFence(env.DB, { grantId: id, kind: "b5_target" })).toBeNull();
    await expect(hooks().setReversalTarget!(e, { ...input(id), targetRemovedMicrocents: 0, revision: 1 })).rejects.toMatchObject({ code: "grant_owner_busy" });
    expect(router.calls(T)).toEqual([]);
    // (c) A receipt must name the claim's wire revision.
    const receipt = (w?: number) => operatorApplied(env.DB, { grantId: "inv:in_op", token: claim.token, revision: claim.account.revision, wireRevision: w,
      appliedMicrocents: amount - 1_000_000, adjustmentRef: claim.adjustmentRef, evidence: "Flux admin adjustment (h2)", by: "ops-h2", now: clock,
      verified: { appliedMicrocents: amount - 1_000_000 } });
    expect(await receipt()).toBe("wire_revision_mismatch");
    expect(await receipt(wire + 1)).toBe("wire_revision_mismatch");
    // (d) The claim lapses; B5 takes the grant and applies a newer target (a removal of 4,000,000).
    await env.DB.prepare("UPDATE flux_grant_fence SET owner_expires_at=0 WHERE grant_id=?").bind(id).run();
    expect(await hooks().setReversalTarget!(e, { ...input(id), targetRemovedMicrocents: 4_000_000, revision: 1 })).toMatchObject({ removedMicrocents: 4_000_000 });
    expect(router.grants.get(id)!.remaining).toBe(amount - 1_000_000 - 4_000_000);
    // The operator's late hand adjustment carries its (older) wire revision: Flux refuses it, the newer B5 adjustment stands.
    const hand = await router.fetch(`https://router.test${T}`, { method: "POST", headers: { authorization: `Bearer ${GRANTS}` },
      body: JSON.stringify({ grant_id: id, target_removed_microcents: 0, revision: wire }) });
    expect(hand.status).toBe(409);
    expect(await hand.json()).toMatchObject({ code: "stale_revision" });
    // ... and its receipt can no longer move the ledger.
    expect(await receipt(wire)).toBe("fence_lost");
    expect(router.grants.get(id)!.remaining).toBe(amount - 1_000_000 - 4_000_000);
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 1_000_000 });
  });

  it("H2 P1 operator receipt under a live claim settles its wire revision and releases the shared fence", async () => {
    const e = fluxEnv();
    await seedHome(); await linkOwner();
    await grantMonthlyCredits(e, { homeId: HOME, plan: "starter", invoiceId: "in_op2", periodStart: P_START, periodEnd: P_END }, deps());
    const id = "in_op2:period";
    const amount = router.grants.get(id)!.amount;
    const claim = await operatorClaim(env.DB, { grantId: "inv:in_op2", by: "ops-h2", now: clock });
    if (!claim.claimed) throw new Error("not claimed");
    expect(await operatorApplied(env.DB, { grantId: "inv:in_op2", token: claim.token, revision: claim.account.revision, wireRevision: claim.wireRevision!,
      appliedMicrocents: amount, adjustmentRef: claim.adjustmentRef, evidence: "Flux admin adjustment (h2)", by: "ops-h2", now: clock,
      verified: { appliedMicrocents: amount } })).toBe("applied");
    expect(await fenceOf(env.DB, id)).toMatchObject({ owner_token: null });
    expect(await env.DB.prepare("SELECT outcome FROM flux_grant_revisions WHERE grant_id=? AND revision=?").bind(id, claim.wireRevision).first()).toEqual({ outcome: "applied_by_hand" });
    expect(await hooks().reconcileFences!(e)).toBe(0);
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 0 });
  });

  it("H2 P2 allocate, remote commit, worker dies: once the owner is gone the sweep reads the grant back; a live owner's in-flight revision is left alone", async () => {
    const e = fluxEnv();
    await seed("in_cr:period");
    router.spend("in_cr:period", 2_000_000);
    // The worker allocates revision 2 and Flux commits the reverse; it dies before settling.
    const c = (await claimGrantFence(env.DB, { grantId: "in_cr:period", kind: "b5_reverse" }))!;
    const rev = (await allocateFenceRevision(env.DB, c, { op: "reverse" }))!;
    expect((await router.fetch("https://router.test/internal/cloud-home/credit-grants/reverse", { method: "POST", headers: { authorization: `Bearer ${GRANTS}` },
      body: JSON.stringify({ grant_id: "in_cr:period", revision: rev }) })).status).toBe(200);
    // Still within its claim: in flight, not touched.
    expect(await hooks().reconcileFences!(e)).toBe(0);
    expect(router.calls("/internal/cloud-home/credit-grants/state")).toEqual([]);
    // The claim expires (the worker is gone): before the fix nothing ever read it back (needs_reconcile stayed 0).
    await env.DB.prepare("UPDATE flux_grant_fence SET owner_expires_at=0 WHERE grant_id='in_cr:period'").run();
    expect(await hooks().reconcileFences!(e)).toBe(1);
    expect(await fenceOf(env.DB, "in_cr:period")).toMatchObject({ applied_revision: rev, remote_state: "reversed", remote_remaining_microcents: 0, last_outcome: "reconciled" });
    expect(await env.DB.prepare("SELECT outcome FROM flux_grant_revisions WHERE grant_id='in_cr:period' AND revision=?").bind(rev).first()).toEqual({ outcome: "landed_or_superseded" });
    expect(await hooks().reconcileFences!(e)).toBe(0); // settled: never rediscovered
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 2_000_000 });
  });

  it("H2 P2 an allocation that never reached Flux and an expired operator claim are both discovered by the sweep, and (H3) stay due until Flux passes them", async () => {
    const e = fluxEnv();
    await seed("in_nr:period");
    const c = (await claimGrantFence(env.DB, { grantId: "in_nr:period", kind: "b5_target" }))!;
    const rev = (await allocateFenceRevision(env.DB, c, { op: "target", logical: 1, floor: 1 }))!;
    await env.DB.prepare("UPDATE flux_grant_fence SET owner_expires_at=0 WHERE grant_id='in_nr:period'").run();
    expect(await hooks().reconcileFences!(e)).toBe(1);
    // H3: Flux still holds an older revision: the orphan may yet land, so it is NOT retired and the grant stays due.
    expect(await env.DB.prepare("SELECT outcome FROM flux_grant_revisions WHERE grant_id='in_nr:period' AND revision=?").bind(rev).first()).toEqual({ outcome: null });
    expect(await hooks().reconcileFences!(e)).toBe(1);
    // A later revision applied at Flux supersedes it remotely: settled, never due again.
    expect(await hooks().setReversalTarget!(e, { ...input("in_nr:period"), targetRemovedMicrocents: 0, revision: 2 })).toMatchObject({ revision: 2, removedMicrocents: 0 });
    expect(await env.DB.prepare("SELECT outcome FROM flux_grant_revisions WHERE grant_id='in_nr:period' AND revision=?").bind(rev).first()).toEqual({ outcome: "landed_or_superseded" });
    expect(await hooks().reconcileFences!(e)).toBe(0);
    // An operator claim (B4) that lapses unfinished: discovered too, and kept due.
    await seedHome(); await linkOwner();
    await grantMonthlyCredits(e, { homeId: HOME, plan: "starter", invoiceId: "in_opx", periodStart: P_START, periodEnd: P_END }, deps());
    const claim = await operatorClaim(env.DB, { grantId: "inv:in_opx", by: "ops-h2", now: clock });
    if (!claim.claimed) throw new Error("not claimed");
    expect(await hooks().reconcileFences!(e)).toBe(0);
    await env.DB.prepare("UPDATE flux_grant_fence SET owner_expires_at=0 WHERE grant_id='in_opx:period'").run();
    router.requests.length = 0;
    expect(await hooks().reconcileFences!(e)).toBe(1);
    expect(router.calls("/internal/cloud-home/credit-grants/state")).toHaveLength(1);
    expect(await env.DB.prepare("SELECT outcome FROM flux_grant_revisions WHERE grant_id='in_opx:period' AND revision=?").bind(claim.wireRevision).first())
      .toEqual({ outcome: null });
    expect(await fenceDue(env.DB, "in_opx:period")).toBe(true);
    expect(router.grants.get("in_nr:period")!.remaining).toBe(10_000_000);
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 0 });
  });
});

describe("H3 Astra re-review of the grant fence (ASTRA-H2)", () => {
  const G = "/internal/cloud-home/credit-grants";
  const seed = async (id: string, amount = 10_000_000) => {
    await router.fetch(`https://router.test${G}`, { method: "POST", headers: { authorization: `Bearer ${GRANTS}` },
      body: JSON.stringify({ grant_id: id, account_id: ACCT, amount_microcents: amount, revision: 1 }) });
    const c = (await claimGrantFence(env.DB, { grantId: id, kind: "seed" }))!;
    const r = (await allocateFenceRevision(env.DB, c, { op: "grant" }))!;
    await settleFenceRevision(env.DB, c, { revision: r, outcome: "applied" });
    router.requests.length = 0;
  };
  const input = (id: string) => ({ homeId: HOME, invoiceId: id.split(":")[0], kind: "period" as const, grantId: id, reason: "h3" });
  const outcome = async (id: string, rev: number) => (await env.DB.prepare("SELECT outcome FROM flux_grant_revisions WHERE grant_id=? AND revision=?").bind(id, rev)
    .first<{ outcome: string | null }>())?.outcome;
  const read = (e: Env) => (id: string) => readGrantState(e, router.fetch, id, HOME);
  afterEach(async () => { for (const t of ["credit_reversals", "billing_home_leases", "flux_grant_dispatches", "cloud_alerts", "credit_grants"]) await env.DB.prepare(`DELETE FROM ${t}`).run(); });

  it("H3 P1 #2 a legacy (pre-0109, unfenced) operator claim on an invoice-backed grant cannot adjust it while B5 holds the fence; a re-claim is fenced", async () => {
    const e = fluxEnv();
    await seedHome(); await linkOwner();
    await grantMonthlyCredits(e, { homeId: HOME, plan: "starter", invoiceId: "in_lg", periodStart: P_START, periodEnd: P_END }, deps());
    const id = "in_lg:period";
    const amount = router.grants.get(id)!.amount;
    router.spend(id, 1_000_000);
    const acct = (await env.DB.prepare("SELECT revision FROM flux_grant_accounts WHERE grant_id='inv:in_lg'").first<{ revision: number }>())!;
    // The claim a 0106-era operator opened: no wire grant id, no wire revision (0109 supersedes these; one that slipped through is refused).
    await env.DB.prepare(`INSERT INTO flux_grant_dispatches (dispatch_id,grant_id,kind,revision,target_microcents,claimed_at,expires_at,by,adjustment_ref)
      VALUES ('legacy-op','inv:in_lg','operator',?,?,1,9999999999999,'ops-old','murage:inv:in_lg:legacy')`).bind(acct.revision, amount).run();
    const b5 = (await claimGrantFence(env.DB, { grantId: id, kind: "b5_target" }))!;
    const receipt = (verified: boolean) => operatorApplied(env.DB, { grantId: "inv:in_lg", token: "legacy-op", revision: acct.revision, appliedMicrocents: amount,
      adjustmentRef: "murage:inv:in_lg:legacy", evidence: "old hand restore (h3)", by: "ops-old", now: clock, ...(verified ? { verified: { appliedMicrocents: amount } } : {}) });
    expect(await receipt(true)).toBe("fence_lost");
    expect(await receipt(false)).toBe("fence_lost");
    expect(await env.DB.prepare("SELECT applied_microcents,router_state FROM flux_grant_accounts WHERE grant_id='inv:in_lg'").first())
      .toMatchObject({ applied_microcents: amount });
    expect(await env.DB.prepare("SELECT state,receipt_at FROM flux_grant_dispatches WHERE dispatch_id='legacy-op'").first()).toEqual({ state: "open", receipt_at: null });
    expect(await fenceHeld(env.DB, b5)).toBe(true);
    // Still refused once B5 lets go: an unfenced claim of an invoice-backed grant is never authorized; the operator re-claims (fenced).
    await env.DB.prepare("UPDATE flux_grant_fence SET owner_token=NULL,owner_kind=NULL,owner_expires_at=NULL WHERE owner_token=?").bind(b5.token).run();
    expect(await receipt(true)).toBe("fence_lost");
    await env.DB.prepare("UPDATE flux_grant_dispatches SET state='superseded',outcome='superseded_at_fence_cutover:reclaim' WHERE dispatch_id='legacy-op'").run();
    const re = await operatorClaim(env.DB, { grantId: "inv:in_lg", by: "ops-h3", now: clock });
    if (!re.claimed) throw new Error("not claimed");
    expect(re.wireGrantId).toBe(id);
    expect(re.wireRevision).toBeGreaterThan(1);
    expect(router.grants.get(id)!.remaining).toBe(amount - 1_000_000);
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 1_000_000 });
  });

  it("H3 P2 #3 an early GET never retires a dispatched revision: revision 2 sent, worker dies, owner expires, GET says 1, then revision 2 lands and is confirmed", async () => {
    const e = fluxEnv();
    await seed("in_eg:period");
    router.spend("in_eg:period", 2_000_000);
    const c = (await claimGrantFence(env.DB, { grantId: "in_eg:period", kind: "b5_reverse" }))!;
    const rev = (await allocateFenceRevision(env.DB, c, { op: "reverse" }))!;
    expect(rev).toBe(2);
    // Revision 2 is in flight at Flux (not yet applied); the worker dies; its owner expires.
    router.hold = true;
    await router.fetch(`https://router.test${G}/reverse`, { method: "POST", headers: { authorization: `Bearer ${GRANTS}` },
      body: JSON.stringify({ grant_id: "in_eg:period", revision: rev }) }).catch(() => undefined);
    router.hold = false;
    await env.DB.prepare("UPDATE flux_grant_fence SET owner_expires_at=0 WHERE grant_id='in_eg:period'").run();
    // The early GET still reports revision 1: before the fix revision 2 became unconfirmed_at_reconcile and the grant was no longer due.
    expect(await hooks().reconcileFences!(e)).toBe(1);
    expect(await outcome("in_eg:period", rev)).toBeNull();
    expect(await fenceDue(env.DB, "in_eg:period")).toBe(true);
    expect(await fenceOf(env.DB, "in_eg:period")).toMatchObject({ applied_revision: 1, remote_state: "active", remote_remaining_microcents: 8_000_000 });
    // Revision 2 lands remotely; the next read-back confirms it.
    expect((await router.release()).map((r) => r.status)).toEqual([200]);
    expect(await hooks().reconcileFences!(e)).toBe(1);
    expect(await outcome("in_eg:period", rev)).toBe("landed_or_superseded");
    expect(await fenceOf(env.DB, "in_eg:period")).toMatchObject({ applied_revision: 2, remote_state: "reversed", remote_remaining_microcents: 0 });
    expect(await fenceDue(env.DB, "in_eg:period")).toBe(false);
    expect(await hooks().reconcileFences!(e)).toBe(0);
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 2_000_000 });
  });

  it("H3 P1 #4 initial-target grant: A captures target revision 1 (remove 4,000,000), its lease lapses, the target becomes revision 2 (remove 0): A's grant is refused at allocation", async () => {
    const e = fluxEnv();
    const inv = "in_it";
    const id = `${inv}:period`;
    const body = JSON.stringify({ grant_id: id, invoice_id: inv, kind: "period", home_id: HOME, account_id: ACCT, amount_microcents: 10_000_000 });
    await env.DB.prepare("INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,body_json,body_sha256) VALUES (?,'period',?,'starter',1,?,?)")
      .bind(inv, HOME, body, await sha256Hex(body)).run();
    await env.DB.prepare(`INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,requested_at,scope,target_revision,covered_cents,paid_cents)
      VALUES (?,'period',?,'refund',1,'target',1,1960,4900)`).bind(inv, HOME).run();
    const ask = (lease: Parameters<NonNullable<FluxEntitlementHooks["setReversalTarget"]>>[2], it?: { targetRemovedMicrocents: number; revision: number }) =>
      hooks().grantMonthlyCredits(e, { homeId: HOME, plan: "starter", invoiceId: inv, periodStart: P_START, periodEnd: P_END, ...(it ? { initialTarget: it } : {}) }, lease);
    // A captured revision 1; meanwhile its lease lapses and B moves the target to revision 2, removing nothing.
    const a = await withHomeLease(e, HOME, async (lease) => {
      await env.DB.prepare("UPDATE billing_home_leases SET lease_until=0 WHERE home_id=?").bind(HOME).run();
      await env.DB.prepare("UPDATE credit_reversals SET target_revision=2,covered_cents=0 WHERE invoice_id=?").bind(inv).run();
      return ask({ lease }, { targetRemovedMicrocents: 4_000_000, revision: 1 }).catch((x) => x);
    }).catch((x) => x);
    expect(a).toBeInstanceOf(FluxNotDispatched);
    // Even under a live lease, the obsolete target revision is refused (the row's CURRENT intent is checked in the allocation statement).
    const a2 = (await withHomeLease(e, HOME, (lease) => ask({ lease }, { targetRemovedMicrocents: 4_000_000, revision: 1 }).catch((x) => x))) as FluxNotDispatched;
    expect(a2).toBeInstanceOf(FluxNotDispatched);
    expect(a2.code).toBe("logical_revision_superseded");
    expect(router.calls(G)).toEqual([]);
    expect(router.grants.has(id)).toBe(false);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_grant_revisions WHERE grant_id=?").bind(id).first()).toEqual({ n: 0 });
    // A publication WITHOUT a target while a covered target exists is refused too (it must travel with its target).
    await env.DB.prepare("UPDATE credit_reversals SET covered_cents=1960 WHERE invoice_id=?").bind(inv).run();
    const bare = await withHomeLease(e, HOME, (lease) => ask({ lease }).catch((x) => x));
    expect(bare).toBeInstanceOf(FluxNotDispatched);
    expect(router.calls(G)).toEqual([]);
    // The current intent goes out: no target any more (coverage gone), under the live lease: the full grant, nothing removed.
    await env.DB.prepare("UPDATE credit_reversals SET covered_cents=0 WHERE invoice_id=?").bind(inv).run();
    expect(await withHomeLease(e, HOME, (lease) => ask({ lease }))).toMatchObject({ status: "granted" });
    expect(router.grants.get(id)).toMatchObject({ amount: 10_000_000, remaining: 10_000_000 });
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 0 });
  });

  it("H3 P2 #5 a superseded B4 dispatch never acquires a fresh wire revision, and one superseded after its allocation is not sent", async () => {
    const e = fluxEnv();
    const client = createFluxClient(e, router.fetch as typeof fetch);
    const grant = (token: string, onRevision?: (w: string, r: number) => Promise<void>) => client.grant({ grantId: "inv:in_sd", entitlementKey: "k", recipientFluxAccountId: ACCT,
      homeId: HOME, plan: "starter", amountMicrocents: 10_000_000, periodStart: new Date(P_START).toISOString(), periodEnd: new Date(P_END).toISOString(),
      expiresAt: new Date(P_END + 30 * 86_400_000).toISOString(), deliveryId: token, invoiceId: "in_sd", kind: "period", dispatchToken: token,
      onRevision: onRevision ?? ((w, r) => recordRemoteRevision(e, token, w, r)) });
    const dispatch = (token: string, state: string) => env.DB.prepare(`INSERT INTO flux_grant_dispatches (dispatch_id,grant_id,kind,revision,target_microcents,claimed_at,expires_at,state)
      VALUES (?,'inv:in_sd','deliver',1,10000000,1,9999999999999,?)`).bind(token, state).run();
    // A paused before the shared fence; B superseded A's dispatch (and completed). A resumes: refused at the allocation, nothing sent.
    await dispatch("dA", "superseded");
    const a = await grant("dA").catch((x) => x);
    expect(a).toBeInstanceOf(FluxNotDispatched);
    expect(router.calls(G)).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_grant_revisions WHERE grant_id='in_sd:period'").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT remote_revision FROM flux_grant_dispatches WHERE dispatch_id='dA'").first()).toEqual({ remote_revision: null });
    // C was live at its allocation but superseded before its recording: the recording loses ownership, the send is refused, the revision abandoned.
    await dispatch("dC", "open");
    const c = await grant("dC", async (w, r) => {
      await env.DB.prepare("UPDATE flux_grant_dispatches SET state='superseded' WHERE dispatch_id='dC'").run();
      await recordRemoteRevision(e, "dC", w, r);
    }).catch((x) => x);
    expect(c).toBeInstanceOf(FluxNotDispatched);
    expect(c.code).toBe("dispatch_superseded");
    expect(router.calls(G)).toEqual([]);
    expect(await env.DB.prepare("SELECT outcome FROM flux_grant_revisions WHERE grant_id='in_sd:period'").all()).toMatchObject({ results: [{ outcome: "not_sent" }] });
    expect(await fenceOf(env.DB, "in_sd:period")).toMatchObject({ owner_token: null });
    expect(await fenceDue(env.DB, "in_sd:period")).toBe(false);
    // A live dispatch goes out.
    await dispatch("dD", "open");
    await grant("dD");
    expect(router.calls(G)).toHaveLength(1);
    expect(await env.DB.prepare("SELECT remote_revision FROM flux_grant_dispatches WHERE dispatch_id='dD'").first()).toEqual({ remote_revision: 2 });
    expect(router.grants.get("in_sd:period")).toMatchObject({ remaining: 10_000_000 });
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 0 });
  });

  it("H3 P2 #6 a delayed GET snapshot never overwrites newer reconciliation state, nor clears a newer revision's reconcile demand", async () => {
    const e = fluxEnv();
    await seed("in_dg:period");
    // (a) A reader takes its snapshot at revision 1; meanwhile revision 2 (remove 4,000,000) applies and is read back fresh; then the old snapshot arrives.
    const old1 = (await read(e)("in_dg:period"))!;
    expect(old1).toMatchObject({ appliedRevision: 1, remainingMicrocents: 10_000_000 });
    await reconcileOne(env.DB, "in_dg:period", HOME, async () => {
      expect(await hooks().setReversalTarget!(e, { ...input("in_dg:period"), targetRemovedMicrocents: 4_000_000, revision: 1 })).toMatchObject({ removedMicrocents: 4_000_000 });
      await reconcileOne(env.DB, "in_dg:period", HOME, read(e));
      return old1;
    });
    expect(await fenceOf(env.DB, "in_dg:period")).toMatchObject({ applied_revision: 2, remote_state: "reversed", remote_remaining_microcents: 6_000_000, needs_reconcile: 0 });
    // (b) A reader takes a snapshot at revision 2; meanwhile revision 3 (remove 0) times out (unknown); then the old snapshot arrives: the grant stays due.
    const old2 = (await read(e)("in_dg:period"))!;
    await reconcileOne(env.DB, "in_dg:period", HOME, async () => {
      router.hold = true;
      await expect(hooks().setReversalTarget!(e, { ...input("in_dg:period"), targetRemovedMicrocents: 0, revision: 2 })).rejects.toThrow();
      router.hold = false;
      return old2;
    });
    expect(await fenceOf(env.DB, "in_dg:period")).toMatchObject({ applied_revision: 2, needs_reconcile: 1, last_outcome: "unknown" });
    expect(await outcome("in_dg:period", 3)).toBe("unknown");
    expect(await fenceDue(env.DB, "in_dg:period")).toBe(true);
    // Even a FRESH read that still says revision 2 keeps it due (revision 3 may land).
    expect(await hooks().reconcileFences!(e)).toBe(1);
    expect(await fenceDue(env.DB, "in_dg:period")).toBe(true);
    // Revision 3 lands; the read-back confirms it.
    expect((await router.release()).map((r) => r.status)).toEqual([200]);
    expect(await hooks().reconcileFences!(e)).toBe(1);
    expect(await outcome("in_dg:period", 3)).toBe("landed_or_superseded");
    expect(await fenceOf(env.DB, "in_dg:period")).toMatchObject({ applied_revision: 3, remote_state: "active", remote_remaining_microcents: 10_000_000 });
    expect(await fenceDue(env.DB, "in_dg:period")).toBe(false);
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 0 });
  });
});

describe("H4 Astra re-review of the grant fence (ASTRA-H3)", () => {
  const G = "/internal/cloud-home/credit-grants";
  const post = (path: string, body: Json) => router.fetch(`https://router.test${G}${path}`, { method: "POST", headers: { authorization: `Bearer ${GRANTS}` }, body: JSON.stringify(body) });
  const seed = async (id: string) => {
    await post("", { grant_id: id, account_id: ACCT, amount_microcents: 10_000_000, revision: 1 });
    const c = (await claimGrantFence(env.DB, { grantId: id, kind: "seed" }))!;
    const r = (await allocateFenceRevision(env.DB, c, { op: "grant" }))!;
    await settleFenceRevision(env.DB, c, { revision: r, outcome: "applied" });
    router.requests.length = 0;
  };
  const input = (id: string) => ({ homeId: HOME, invoiceId: id.split(":")[0], kind: "period" as const, grantId: id, reason: "h4" });
  const outcome = async (id: string, rev: number) => (await env.DB.prepare("SELECT outcome FROM flux_grant_revisions WHERE grant_id=? AND revision=?").bind(id, rev)
    .first<{ outcome: string | null }>())?.outcome;
  const read = (e: Env) => (id: string) => readGrantState(e, router.fetch, id, HOME);
  afterEach(async () => { for (const t of ["credit_reversals", "billing_home_leases", "flux_grant_dispatches", "cloud_alerts", "credit_grants"]) await env.DB.prepare(`DELETE FROM ${t}`).run(); });

  it("H4 P2 #6 a dispute-credit hand-adjustment receipt advances the snapshot fence and keeps reconciliation demand: a delayed GET (revision 2) cannot cross the hand revision 3", async () => {
    const e = fluxEnv();
    const id = "in_h6:period";
    await seedHome();
    await seed(id);
    // Revision 2 removes 4,000,000 and is read back fresh.
    expect(await hooks().setReversalTarget!(e, { ...input(id), targetRemovedMicrocents: 4_000_000, revision: 1 })).toMatchObject({ removedMicrocents: 4_000_000 });
    await reconcileOne(env.DB, id, HOME, read(e));
    expect(await fenceOf(env.DB, id)).toMatchObject({ applied_revision: 2, remote_state: "reversed", remote_remaining_microcents: 6_000_000, needs_reconcile: 0 });
    // An operator claims the dispute credit: the grant's fence and revision 3.
    await env.DB.prepare("INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at) VALUES ('in_h6','period',?,'starter',1)").bind(HOME).run();
    await env.DB.prepare(`INSERT INTO dispute_credit_obligations (dispute_id,home_id,invoice_id,returned_cents,exact,state,recorded_at,updated_at)
      VALUES ('dp_h4',?,'in_h6',4900,1,'owed',1,1)`).bind(HOME).run();
    const claim = (await withHomeLease(e, HOME, (lease) => claimDisputeCredit(e, lease, { disputeId: "dp_h4", by: "ops-h4" }, clock)))!;
    expect(claim.fence).toMatchObject([{ grantId: id, revision: 3 }]);
    // A GET captures revision 2; meanwhile the hand adjustment (revision 3: restore) is made at Flux and its receipt accepted; then the GET lands.
    await reconcileOne(env.DB, id, HOME, async (gid) => {
      const old = await read(e)(gid);
      expect(old).toMatchObject({ appliedRevision: 2, remainingMicrocents: 6_000_000 });
      expect((await post("/reversal-target", { grant_id: id, target_removed_microcents: 0, revision: claim.fence[0].revision })).status).toBe(200);
      expect(await withHomeLease(e, HOME, (lease) => markDisputeCreditApplied(e, lease, { disputeId: "dp_h4", token: claim.token, appliedCents: 4900,
        evidence: "Flux adjustment adj_h4 (by hand, revision 3)", by: "ops-h4" }, clock))).toBe(true);
      return old;
    });
    // Before the fix: the delayed snapshot published and cleared the demand (revision 3 applied_by_hand, due=false).
    expect(await outcome(id, 3)).toBe("applied_by_hand");
    expect(await fenceOf(env.DB, id)).toMatchObject({ owner_token: null, needs_reconcile: 1 });
    expect(await fenceDue(env.DB, id)).toBe(true);
    // A fresh read-back records what the hand adjustment left at Flux.
    expect(await hooks().reconcileFences!(e)).toBe(1);
    expect(await fenceOf(env.DB, id)).toMatchObject({ applied_revision: 3, remote_state: "active", remote_remaining_microcents: 10_000_000, needs_reconcile: 0 });
    expect(await fenceDue(env.DB, id)).toBe(false);
    expect(router.grants.get(id)!.remaining).toBe(10_000_000);
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 0 });
  });

  it("H4 P2 #8 a snapshot that loses its CAS keeps the reconciliation demand: orphan triggers GET, revision 3 applies concurrently and its sender dies, the GET sees 3 but cannot publish", async () => {
    const e = fluxEnv();
    const id = "in_h8:period";
    await seed(id);
    await reconcileOne(env.DB, id, HOME, read(e));
    expect(await fenceOf(env.DB, id)).toMatchObject({ applied_revision: 1, remote_state: "active", remote_remaining_microcents: 10_000_000, needs_reconcile: 0 });
    // An orphan: revision 2 allocated, its owner gone.
    const c1 = (await claimGrantFence(env.DB, { grantId: id, kind: "b5_target" }))!;
    expect(await allocateFenceRevision(env.DB, c1, { op: "target", floor: 1 })).toBe(2);
    await env.DB.prepare("UPDATE flux_grant_fence SET owner_expires_at=0 WHERE grant_id=?").bind(id).run();
    expect(await fenceDue(env.DB, id)).toBe(true);
    await reconcileOne(env.DB, id, HOME, async (gid) => {
      // Concurrently a sender takes the grant over, revision 3 (reverse) applies at Flux, and the sender dies before settling.
      const c2 = (await claimGrantFence(env.DB, { grantId: id, kind: "b5_reverse" }))!;
      expect(await allocateFenceRevision(env.DB, c2, { op: "reverse" })).toBe(3);
      expect((await post("/reverse", { grant_id: id, revision: 3 })).status).toBe(200);
      return read(e)(gid); // observes revision 3: reversed, 0 left
    });
    // The snapshot lost its CAS: the row still says active/10,000,000, and (before the fix) nothing was due any more.
    expect(await outcome(id, 2)).toBe("landed_or_superseded");
    expect(await outcome(id, 3)).toBe("landed_or_superseded");
    expect(await fenceOf(env.DB, id)).toMatchObject({ applied_revision: 3, remote_state: "active", remote_remaining_microcents: 10_000_000, needs_reconcile: 1 });
    expect(await fenceDue(env.DB, id)).toBe(true);
    // The next sweep publishes what Flux holds.
    expect(await hooks().reconcileFences!(e)).toBe(1);
    expect(await fenceOf(env.DB, id)).toMatchObject({ applied_revision: 3, remote_state: "reversed", remote_remaining_microcents: 0, needs_reconcile: 0, snapshot_revision: 3 });
    expect(await fenceDue(env.DB, id)).toBe(false);
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 0 });
  });

  it("H5 P2 #8 a successful settlement keeps rejected-snapshot demand: orphan 2 triggers GET, reverse 3 applies concurrently, the GET loses its CAS, then the revision-3 sender completes", async () => {
    const e = fluxEnv();
    const id = "in_h5:period";
    await seed(id);
    await reconcileOne(env.DB, id, HOME, read(e));
    expect(await fenceOf(env.DB, id)).toMatchObject({ applied_revision: 1, remote_state: "active", remote_remaining_microcents: 10_000_000, needs_reconcile: 0, snapshot_revision: 1 });
    // An orphan: revision 2 allocated, its owner gone.
    const c1 = (await claimGrantFence(env.DB, { grantId: id, kind: "b5_target" }))!;
    expect(await allocateFenceRevision(env.DB, c1, { op: "target", floor: 1 })).toBe(2);
    await env.DB.prepare("UPDATE flux_grant_fence SET owner_expires_at=0 WHERE grant_id=?").bind(id).run();
    expect(await fenceDue(env.DB, id)).toBe(true);
    const held: { c?: NonNullable<Awaited<ReturnType<typeof claimGrantFence>>> } = {};
    await reconcileOne(env.DB, id, HOME, async (gid) => {
      // Concurrently a sender takes the grant over and revision 3 (reverse) applies at Flux; the sender is still alive.
      held.c = (await claimGrantFence(env.DB, { grantId: id, kind: "b5_reverse" }))!;
      expect(await allocateFenceRevision(env.DB, held.c, { op: "reverse" })).toBe(3);
      expect((await post("/reverse", { grant_id: id, revision: 3 })).status).toBe(200);
      return read(e)(gid); // observes revision 3: reversed, 0 left
    });
    expect(await fenceOf(env.DB, id)).toMatchObject({ applied_revision: 3, remote_state: "active", needs_reconcile: 1, snapshot_revision: 1, snapshot_due_revision: 3 });
    // The revision-3 sender now completes successfully. Before the fix this cleared the demand: active/10,000,000 stored, reversed/0 at Flux, due=false.
    await settleFenceRevision(env.DB, held.c!, { revision: 3, outcome: "applied", appliedRevision: 3, homeId: HOME });
    expect(await fenceOf(env.DB, id)).toMatchObject({ owner_token: null, applied_revision: 3, last_outcome: "applied", remote_state: "active",
      remote_remaining_microcents: 10_000_000, needs_reconcile: 1, snapshot_revision: 1, snapshot_due_revision: 3 });
    expect(await fenceDue(env.DB, id)).toBe(true);
    expect(router.grants.get(id)).toMatchObject({ state: "reversed", remaining: 0 });
    // The next sweep publishes what Flux holds and only then is the demand cleared.
    expect(await hooks().reconcileFences!(e)).toBe(1);
    expect(await fenceOf(env.DB, id)).toMatchObject({ applied_revision: 3, remote_state: "reversed", remote_remaining_microcents: 0, needs_reconcile: 0,
      snapshot_revision: 3, snapshot_due_revision: null });
    expect(await fenceDue(env.DB, id)).toBe(false);
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 0 });
  });

  it("H4 P2 #9 failing or null reads never starve later grants: twenty failing oldest grants, a healthy 21st is read on the next sweep", async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `in_s${String(i + 1).padStart(2, "0")}:period`);
    for (const [i, id] of ids.entries()) {
      await env.DB.prepare("INSERT INTO flux_grant_fence (grant_id,home_id,needs_reconcile,updated_at) VALUES (?,?,1,?)").bind(id, HOME, i + 1).run();
    }
    const healthy = ids[20];
    const reads = new Map<string, number>();
    const readFn = async (id: string): Promise<RemoteGrantState | null> => {
      reads.set(id, (reads.get(id) ?? 0) + 1);
      if (id === healthy) return { state: "active", appliedRevision: 0, remainingMicrocents: 10_000_000 };
      if (ids.indexOf(id) % 2 === 0) throw new Error("flux 503");
      return null;
    };
    expect(await reconcileFences(env.DB, readFn, 20)).toBe(0);
    expect(reads.get(healthy)).toBeUndefined(); // the 20 oldest first
    expect(await reconcileFences(env.DB, readFn, 20)).toBe(1); // before the fix: the same 20 failing grants again
    expect(reads.get(healthy)).toBe(1);
    expect(await fenceOf(env.DB, healthy)).toMatchObject({ remote_state: "active", remote_remaining_microcents: 10_000_000, needs_reconcile: 0 });
    expect(await fenceDue(env.DB, healthy)).toBe(false);
    await reconcileFences(env.DB, readFn, 20);
    expect(reads.get(healthy)).toBe(1);
    // Every failing grant is still due and keeps being tried in rotation.
    for (const id of ids.slice(0, 20)) {
      expect(await fenceDue(env.DB, id)).toBe(true);
      expect(reads.get(id)).toBeGreaterThanOrEqual(2);
    }
    expect(router.requests).toEqual([]);
    expect(router.balances(ACCT)).toEqual({ prepaid: PREPAID, spent: 0 });
  });
});
