// SPDX-License-Identifier: AGPL-3.0-or-later
// TRUST-FIRST-FACTOR.md revision 4, part D (Astra TRUST-3 #2, TRUST-4 P2-1..P2-5): the first purchase on an account with nothing to protect
// proceeds on the email sign-in alone, under one bound purchase authorization (src/purchase-bootstrap.ts, migration 0085).
// Real workerd + D1, real-shaped Supabase tokens (ES256 JWKS), Stripe as an injected fake. No network.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { fakeProvider, type ProviderAdapter } from "../src/b3-provider";
import { invoiceRefundCoverage, type BillingNotifier, type FluxEntitlementHooks } from "../src/b5-billing";
import { customerMoveBody, signStripePayload } from "../src/b5-stripe";
import { LEGAL_DOCS } from "../src/legal-docs.generated";
import { boundSession, consentFor, useSellerEnv } from "./legal-helpers";
import type { ConsentInput } from "../src/legal-flows";
import { applyCustomerForm, customerFake } from "./stripe-customer-fake";

const REF_ORIGIN = "https://testref.supabase.co";
const ISS = `${REF_ORIGIN}/auth/v1`;
const WHSEC = "whsec_testonlyfixturesecret0123456789";
const T0 = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const IMAGE = `sha256:${"a".repeat(64)}`;
const PRICES = { STRIPE_PRICE_STARTER: "price_starter0001", STRIPE_PRICE_PRO: "price_pro00000001", STRIPE_PRICE_MAX: "price_max000000001" };
const B3 = { reservationMs: 30 * MIN, graceMs: 3 * 86_400_000, retentionMs: 14 * 86_400_000, imageDigest: IMAGE, quarantineRelayIP: "192.0.2.20",
  engineSubscriptionGates: { claudeAgent: true, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: true },
  capacity: [1, 2, 3, 4].map((n) => ({ id: `slot-${n}`, projectId: "p1", location: "fsn1", serverType: "cx23", outcome: "available" })) };
const testEnv = (): Env => ({ ...env, SUPABASE_URL: REF_ORIGIN, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_testkey_0123456789abcdef",
  MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined, CLOUD_ADMIN_TOKEN: "test-only-bootstrap-admin", CLOUD_KEK_V1: btoa("x".repeat(32)),
  CLOUD_B3_MODE: "fake", CLOUD_B3_CONFIG: JSON.stringify(B3), CLOUD_HOME_HOST_SUFFIX: "murage.test", CLOUD_HOME_ZONE_ID: "0".repeat(32),
  CLOUD_HOME_ACCOUNT_ID: "0".repeat(32), CLOUD_HOME_API_TOKEN: "test-only-cloud-home-token-no-access",
  STRIPE_SECRET_KEY: "sk_test_fixturefixturefixture", STRIPE_WEBHOOK_SECRET: WHSEC, BILLING_RETURN_ORIGIN: "https://murage.test",
  REFUND_KEY_SECRET: "test-only-refund-identity-hmac-secret-0123456789", REFUND_LIMIT_TERMS_VERSIONS: LEGAL_DOCS.cloudTerms.versionId,
  CLOUD_NONUS_SELLER: "direct", FERROX_TAX_COUNTRIES: "US", ...PRICES } as unknown as Env);

// ---- clock ----
let clock = T0;
const at = (ms: number) => { clock = ms; };

// ---- Supabase ----
const SESSION_A = "0b1c2d3e-aaaa-4bbb-8ccc-123456789abc";
const SESSION_B = "0b1c2d3e-bbbb-4bbb-8ccc-123456789abc";
const FM = "11111111-1111-4111-8111-111111111111";
const b64u = (b: ArrayBuffer | string) => Buffer.from(typeof b === "string" ? Buffer.from(b) : new Uint8Array(b)).toString("base64url");
let ec: CryptoKeyPair;
let jwks: { keys: Record<string, unknown>[] };
beforeAll(async () => {
  ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", ec.publicKey) as Record<string, unknown>), kid: "ec-1", alg: "ES256", use: "sig" }] };
});
let factors: { id: string; factor_type: string; status: string; friendly_name?: string }[] = [];
const emailOf = (sub: string) => `${sub.slice(0, 8)}@example.test`;
/** A session token: aal1 (the emailed code) unless `factor` (aal2 with that factor). */
async function token(sub: string, session = SESSION_A, factor: string | null = null) {
  const s = Math.floor(clock / 1000);
  const c = { iss: ISS, aud: "authenticated", exp: s + 3600, iat: s - 5, sub, email: emailOf(sub), role: "authenticated", is_anonymous: false,
    app_metadata: { provider: "email", email_verified: true }, user_metadata: {}, session_id: session, aal: factor ? "aal2" : "aal1", mfa_factor_id: factor,
    amr: factor ? [{ method: "totp", timestamp: s - 30 }, { method: "otp", timestamp: s - 60 }] : [{ method: "otp", timestamp: s - 60 }] };
  const input = `${b64u(JSON.stringify({ alg: "ES256", kid: "ec-1", typ: "JWT" }))}.${b64u(JSON.stringify(c))}`;
  return `${input}.${b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, new TextEncoder().encode(input)))}`;
}
const authFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const tok = String(new Headers(init?.headers).get("authorization")).replace(/^Bearer /, "");
  const c = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()) as { sub: string; email: string };
  return Response.json({ id: c.sub, email: c.email, email_confirmed_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00.000000Z",
    factors: factors.map((f) => ({ friendly_name: "", created_at: "2026-10-01T00:00:00Z", ...f })) });
}) as typeof fetch;
const jwksFetch = (async () => Response.json(jwks)) as typeof fetch;

// ---- Stripe ----
interface Call { method: string; path: string; form: URLSearchParams; key: string | null }
let calls: Call[];
let customerN: number;
let sessionN: number;
let sessions: { id: string; status: string; customer: string; subscription: string | null; metadata: Record<string, string>; url?: string; expires_at?: number }[];
/** Stripe refuses every session creation with this error (a permanent idempotency conflict, an invalid request). */
let createRefusal: { status: number; code: string; replayed?: boolean } | null = null;
/** Stripe's page size for the session listing (the real one honours `limit`; a smaller page here exercises has_more / starting_after). */
let pageSize = 100;
/** Runs while Stripe creates a checkout session (a clock that crosses a deadline during the call). */
let onSessionCreate: (() => void) | null = null;
/** Astra TAXCOUNTRY-7 P2-d: runs while Stripe creates a FIRST customer (a clock that crosses issue_until during the call). */
let onFirstCustomer: (() => void) | null = null;
/** The session listing fails (Stripe unavailable). */
let listFails = false;
/** Stripe's idempotency for session creation, off unless a test turns it on: the same key answers with the first response. */
let honourKeys = false;
/** Astra TAXCOUNTRY-3: Stripe fails to expire a session this many times (500). */
let expireFails = 0;
const keyed = new Map<string, { id: string; url: string }>();
const cust = customerFake();
const stripeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  // The customer preset (Astra TAXCOUNTRY-1): customers persisted by a shared fake.
  { const cr = await cust.handle(init?.method ?? "GET", new URL(String(input)), new URLSearchParams(String(init?.body ?? "")), new Headers(init?.headers).get("idempotency-key")); if (cr) return cr; }
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const form = new URLSearchParams(String(init?.body ?? ""));
  calls.push({ method, path: url.pathname, form, key: new Headers(init?.headers).get("idempotency-key") });
  const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s });
  if (method === "GET" && retrievable[url.pathname]) return j(retrievable[url.pathname]);
  // Stripe keeps the address a customer is created with (the required preset then reads it back; Astra TAXCOUNTRY-2).
  if (url.pathname === "/v1/customers" && method === "POST") { const f = onFirstCustomer; onFirstCustomer = null; f?.(); const id = `cus_boot${++customerN}`; cust.customers[id] = applyCustomerForm({}, form); return j({ id }); }
  if (url.pathname.startsWith("/v1/customers/")) return j({ id: url.pathname.split("/").pop(), object: "customer", email: null });
  if (url.pathname === "/v1/checkout/sessions" && method === "GET") {
    if (listFails) return j({ error: { code: "api_error" } }, 500);
    const all = sessions.filter((s) => s.customer === url.searchParams.get("customer"));
    const after = url.searchParams.get("starting_after");
    const from = after ? all.findIndex((s) => s.id === after) + 1 : 0;
    const n = Math.min(Number(url.searchParams.get("limit") ?? 10), pageSize);
    return j({ data: all.slice(from, from + n), has_more: from + n < all.length });
  }
  if (url.pathname === "/v1/checkout/sessions") {
    const key = new Headers(init?.headers).get("idempotency-key");
    if (createRefusal) return new Response(JSON.stringify({ error: { code: createRefusal.code } }), { status: createRefusal.status,
      headers: createRefusal.replayed ? { "idempotent-replayed": "true" } : {} });
    if (honourKeys && key && keyed.has(key)) return new Response(JSON.stringify(keyed.get(key)), { status: 200, headers: { "idempotent-replayed": "true" } });
    // Stripe's creation window: expires_at at least 30 minutes after the creation.
    if (Number(form.get("expires_at")) - Math.floor(clock / 1000) < 30 * 60) return j({ error: { type: "invalid_request_error" } }, 400);
    onSessionCreate?.();
    const id = `cs_boot${++sessionN}`;
    sessions.unshift({ id, status: "open", customer: form.get("customer") ?? "", subscription: null, url: `https://checkout.stripe.test/c/${id}`, expires_at: Number(form.get("expires_at")),
      metadata: { home_id: form.get("metadata[home_id]") ?? "", consent_id: form.get("metadata[consent_id]") ?? "" } });
    if (honourKeys && key) keyed.set(key, { id, url: `https://checkout.stripe.test/c/${id}` });
    return j({ id, url: `https://checkout.stripe.test/c/${id}` });
  }
  const expire = url.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/);
  if (expire && expireFails > 0) { expireFails--; return j({ error: { code: "api_error" } }, 500); }
  if (expire) { const s = sessions.find((x) => x.id === expire[1]); if (s?.status !== "open") return j({ error: { code: "session_not_open" } }, 400); s.status = "expired"; return j({ id: s.id, status: "expired" }); }
  if (url.pathname.startsWith("/v1/checkout/sessions/")) { const s = sessions.find((x) => x.id === url.pathname.split("/")[4]); return j({ id: url.pathname.split("/")[4], status: s?.status ?? "open" }); }
  if (url.pathname.startsWith("/v1/prices/")) {
    const id = url.pathname.split("/")[3];
    return j({ id, active: true, unit_amount: 4900, currency: "usd", recurring: { interval: "month", interval_count: 1 } });
  }
  if (url.pathname.startsWith("/v1/subscriptions/")) return j({ id: url.pathname.split("/")[3], status: "active", cancel_at_period_end: false,
    current_period_start: Math.floor(clock / 1000), current_period_end: Math.floor(clock / 1000) + 30 * 86400, items: { data: [] } });
  if (url.pathname.startsWith("/v1/invoices/")) return j({ id: url.pathname.split("/")[3], payment_intent: "pi_boot", charge: "ch_boot", amount_paid: 4900, subscription: "sub_boot1" });
  if (url.pathname.startsWith("/v1/payment_intents/")) return j({ id: url.pathname.split("/").pop(), object: "payment_intent", latest_charge: { payment_method_details: { type: "card", card: { fingerprint: null } }, billing_details: {} } });
  return j({ error: { code: "unexpected" } }, 500);
};
const notices: { kind: string }[] = [];
const notifier: BillingNotifier = { async notify(e, n) {
  notices.push({ kind: n.kind });
  await e.DB.prepare("INSERT INTO billing_notices (id,home_id,kind,payload,created_at,sent_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sent_at=COALESCE(sent_at,excluded.sent_at)")
    .bind(n.id, n.homeId, n.kind, JSON.stringify(n.data), clock, clock).run();
} };
const fluxLog: string[] = [];
const flux: FluxEntitlementHooks = {
  capabilities: { reversalTargets: true }, // switched on and qualified (Astra JOURNEY-A-10 #1)
  async grantMonthlyCredits() { fluxLog.push("grant"); }, async changePlan() { fluxLog.push("plan"); }, async revokeCredits() { fluxLog.push("revoke"); },
  async stopForBilling() { fluxLog.push("stop"); }, async usedIncludedCreditMicrocents() { return { usedMicrocents: 0 }; },
  async setAutoRecharge() { fluxLog.push("autorecharge"); },
};
const mail: { subject: string; text: string }[] = [];
const provider = (db: D1Database): ProviderAdapter => fakeProvider(db);
const worker = () => createWorker(fetch, fetch, { provider }, { emailSender: () => ({ async send(m) { mail.push({ subject: m.subject, text: m.text }); } }) },
  { stripeFetch, notifier, flux, now: () => clock }, { jwksFetch, authFetch, now: () => clock });

async function call(path: string, tok: string, body?: unknown) {
  const ctx = createExecutionContext();
  const res = await worker().fetch(new Request(`https://auth.murage.test${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${tok}`, ...(body === undefined ? {} : { "content-type": "application/json" }), "CF-Connecting-IP": "203.0.113.10" },
    body: body === undefined ? undefined : JSON.stringify(body) }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const out = async (res: Response) => [res.status, await res.json<Record<string, unknown>>()] as const;
let evtN = 0;
async function hook(type: string, object: Record<string, unknown>) {
  const raw = JSON.stringify({ id: `evt_boot${++evtN}abcd`, type, created: Math.floor(clock / 1000), data: { object } });
  const ctx = createExecutionContext();
  const res = await worker().fetch(new Request("https://auth.murage.test/v1/billing/webhook", { method: "POST", body: raw,
    headers: { "content-type": "application/json", "stripe-signature": await signStripePayload(raw, WHSEC, Math.floor(clock / 1000)) } }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// ---- flows ----
const userIdOf = async (sub: string) => (await env.DB.prepare("SELECT user_id FROM supabase_identities WHERE sub=?").bind(sub).first<{ user_id: string }>())!.user_id;
/** The Cloud account for `sub` (created by the first identified request). */
const account = async (sub: string) => { await call("/v1/account/terms", await token(sub)); return userIdOf(sub); };
const reserve = async (sub: string, session = SESSION_A) => out(await call("/v1/billing/reserve", await token(sub, session), {}));
const checkoutBody = (homeId: string | undefined, over: Record<string, unknown> = {}) =>
  ({ plan: "starter", ...(homeId ? { homeId } : {}), consent: consentFor("starter", clock, { declaredCountry: "US", billingCountry: "US", ...over } as Partial<ConsentInput>) });
const checkout = async (sub: string, homeId: string | undefined, session = SESSION_A, over: Record<string, unknown> = {}) =>
  out(await call("/v1/billing/checkout", await token(sub, session), checkoutBody(homeId, over)));
const row = (userId: string) => env.DB.prepare("SELECT * FROM cloud_purchase_bootstraps WHERE user_id=?").bind(userId).first<Record<string, unknown>>();
/** Astra STEPUP-EMAIL-10 #1: a bootstrap whose issuance expired with its abandonment unproven is no 403 on reserve: the sign-in-only path hands
 *  back the same pending home, and the bootstrap row (state, generation, home) is untouched; the unresolved attempt is never reclaimed. */
const reserveFallsBack = async (sub: string, o: { userId: string; homeId: string }) => {
  const before = await row(o.userId);
  const [status, body] = await reserve(sub);
  expect([status, body.homeId, body.state, body.existing, body.bootstrap, body.error]).toEqual([200, o.homeId, "payment_pending", true, undefined, undefined]);
  const after = await row(o.userId);
  expect([after!.state, after!.generation, after!.home_id]).toEqual([before!.state, before!.generation, before!.home_id]);
};
const sessionPosts = () => calls.filter((c) => c.method === "POST" && c.path === "/v1/checkout/sessions");
const customerPosts = () => calls.filter((c) => c.method === "POST" && c.path === "/v1/customers");
const refused = (r: readonly [number, Record<string, unknown>]) => r[0] === 403 && r[1].error === "step_up_required" && (r[1].step_up as { bootstrap?: boolean })?.bootstrap === false;
/** A fresh account reserves and checks out on the sign-in alone. */
async function bought(sub: string) {
  const userId = await account(sub);
  const [rs, r] = await reserve(sub);
  expect(rs).toBe(201);
  const homeId = r.homeId as string;
  const [cs, c] = await checkout(sub, homeId);
  expect([cs, c.error]).toEqual([200, undefined]);
  return { userId, homeId, sessionId: c.sessionId as string, consentId: c.consentId as string };
}
// The session as our checkout issued it for the consent (boundSession: hash, price, seller, created, the real line item).
let retrievable: Record<string, unknown> = {};
const sessionObj = (o: { homeId: string; sessionId: string; consentId: string; customer: string }, status = "paid") => boundSession({ object: "checkout.session", id: o.sessionId,
  mode: "subscription", payment_status: status, customer: o.customer, subscription: "sub_boot1", invoice: "in_boot1", client_reference_id: o.homeId, amount_total: 4900,
  total_details: { amount_tax: 0 }, customer_details: { address: { country: "US" } }, consent: { terms_of_service: "accepted" },
  metadata: { home_id: o.homeId, plan: "starter", consent_id: o.consentId } }, {}, retrievable);

beforeEach(() => {
  clock = T0; calls = []; customerN = 0; onFirstCustomer = null; sessionN = 0; sessions = []; retrievable = {}; notices.length = 0; fluxLog.length = 0; mail.length = 0; factors = [];
  pageSize = 100; onSessionCreate = null; listFails = false; honourKeys = false; keyed.clear(); createRefusal = null; expireFails = 0; cust.reset();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  useSellerEnv(() => testEnv());
});
afterEach(async () => {
  vi.restoreAllMocks(); useSellerEnv(() => env);
  await env.DB.prepare("DELETE FROM checkout_resume_attempts").run();
});

describe("first purchase on the email sign-in alone (aal1)", () => {
  it("a fresh account reserves and checks out; retries never allocate twice; the row binds session, home, customer, order and session", async () => {
    const { userId, homeId, sessionId, consentId } = await bought("a0000001-0000-4000-8000-000000000001");
    const r = (await row(userId))!;
    expect(r).toMatchObject({ generation: 1, session_id: SESSION_A, home_id: homeId, consent_id: consentId, stripe_customer_id: "cus_boot1",
      stripe_session_id: sessionId, state: "open", created_at: T0, issue_until: T0 + 30 * MIN, consumed_at: null });
    // The same session again: the original reservation, the same open session; nothing new is allocated or created.
    const [s2, again] = await reserve("a0000001-0000-4000-8000-000000000001");
    expect([s2, again.homeId, again.existing, again.bootstrap]).toEqual([200, homeId, true, true]);
    const [s3, c2] = await checkout("a0000001-0000-4000-8000-000000000001", homeId);
    expect([s3, c2.sessionId, c2.reused]).toEqual([200, sessionId, true]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_homes WHERE owner_id=?").bind(userId).first<{ n: number }>()).toEqual({ n: 1 });
    expect([customerPosts().length, sessionPosts().length]).toEqual([1, 1]);
    expect((await row(userId))!.generation).toBe(1);
    // Not a generic "step-up passed": the portal (and every other money route) still refuses.
    const [ps, pb] = await out(await call("/v1/billing/portal", await token("a0000001-0000-4000-8000-000000000001"), {}));
    expect([ps, pb.error]).toEqual([403, "step_up_required"]);
    // The step-up body on the purchase routes says the bootstrap does not apply when refused (another session here).
    const [bs, bb] = await checkout("a0000001-0000-4000-8000-000000000001", homeId, SESSION_B);
    expect([bs, bb.error, (bb.step_up as Record<string, unknown>).bootstrap, (bb.step_up as Record<string, unknown>).reason]).toEqual([403, "step_up_required", false, "aal1"]);
  });

  it("any protect-set record present: reserve is sign-in only (no bootstrap row, no code), and checkout asks for the code", async () => {
    const seeds: [string, (u: string) => Promise<unknown>][] = [
      ["a home of any state", (u) => env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
        VALUES (?,?,?,'deleted','deleted','sha256:x','k',0,0)`).bind(`home-old-${u}`, `inst-old-${u}`, u).run()],
      ["a machine owner", (u) => env.DB.prepare("INSERT INTO machine_owners (machine_id,owner_user_id,assigned_at) VALUES (?,?,0)").bind(`m-${u}`, u).run()],
      ["a trusted factor in any state", (u) => env.DB.prepare(`INSERT INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state)
        VALUES (?,?,'totp','email_code',0,0,'staged')`).bind(u, FM).run()],
      ["a trusted_* event", (u) => env.DB.prepare("INSERT INTO cloud_factor_trust_events (id,user_id,factor_id,kind,at) VALUES (?,?,?,'trusted_by_factor',0)").bind(`ev-${u}`, u, FM).run()],
      ["a pending replacement", (u) => env.DB.prepare(`INSERT INTO checkout_retry_routes (account_id,seller,collected_country,reason,replaces_subscription_id,expires_at)
        VALUES (?,'ferrox','US','address_change','sub_x',?)`).bind(u, T0 + HOUR).run()],
      ["a parked order", (u) => env.DB.prepare(`INSERT INTO checkout_consents (id,home_id,user_id,created_at,screen_version,cloud_terms_version,tos_version,privacy_version,
        terms_accepted,recurring_authorized,early_start,eu_region,topup_enabled,renewal_text,wording,billing_country,plan,price_cents,start_at,first_charge_at,delayed_start,acceptance_parked_at)
        VALUES (?,'home-gone',?,0,'v','v','v','v',1,1,0,0,0,'r','w','US','starter',4900,0,0,0,1)`).bind(`consent-parked-${u}`, u).run()],
    ];
    let n = 0;
    for (const [label, seed] of seeds) {
      const sub = `b000000${++n}-0000-4000-8000-000000000001`;
      const u = await account(sub);
      await seed(u);
      // Reserve is sign-in only (one purchase = at most one emailed code): a payable home, but never the bootstrap; checkout asks for the code.
      const r = await reserve(sub);
      expect([label, refused(r), r[1].error === "step_up_required", r[1].bootstrap]).toEqual([label, false, false, undefined]);
      expect([label, await row(u)]).toEqual([label, null]);
      expect([label, (await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_homes WHERE owner_id=? AND desired_state='payment_pending'").bind(u).first<{ n: number }>())!.n <= 1]).toEqual([label, true]);
      if (r[0] === 201) expect([label, refused(await checkout(sub, r[1].homeId as string))]).toEqual([label, true]);
    }
    // A stored Stripe customer anywhere for the account (a billing row on a retained home of it).
    const sub = "b0000009-0000-4000-8000-000000000001";
    const u = await account(sub);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
        VALUES ('home-cus','inst-cus',?,'deleted','deleted','sha256:x','k',0,0)`).bind(u),
      env.DB.prepare("INSERT INTO billing_subscriptions (home_id,customer_id,plan,created_at,updated_at) VALUES ('home-cus','cus_old','starter',0,0)"),
    ]);
    const [rs, rr] = await reserve(sub);
    expect([rs === 403, rr.bootstrap, await row(u)]).toEqual([false, undefined, null]); // a home or the waitlist: never the bootstrap
    expect(customerPosts()).toHaveLength(0);
  });

  it("a record created between reserve and checkout by another operation: 403, no customer and no session", async () => {
    const sub = "c0000001-0000-4000-8000-000000000001";
    const u = await account(sub);
    const [, r] = await reserve(sub);
    await env.DB.prepare("INSERT INTO machine_owners (machine_id,owner_user_id,assigned_at) VALUES ('m-late',?,0)").bind(u).run();
    expect(refused(await checkout(sub, r.homeId as string))).toBe(true);
    expect([customerPosts().length, sessionPosts().length]).toEqual([0, 0]);
    // ... and once a customer is bound, another record still stops a NEW session (re-checked in the binding statement itself).
    const sub2 = "c0000002-0000-4000-8000-000000000001";
    const u2 = await account(sub2);
    const [, r2] = await reserve(sub2);
    expect((await checkout(sub2, r2.homeId as string))[0]).toBe(200);
    await env.DB.prepare("INSERT INTO cloud_factor_trust_events (id,user_id,factor_id,kind,at) VALUES ('ev-late',?,?,'trusted_email_code',0)").bind(u2, FM).run();
    expect(refused(await checkout(sub2, r2.homeId as string, SESSION_A, { checkoutLanguage: "de" }))).toBe(true);
    expect(sessionPosts()).toHaveLength(1);
  });

  it("a wrong session_id: 403 on checkout, on resume and on a second reserve while the first is open", async () => {
    const sub = "d0000001-0000-4000-8000-000000000001";
    await account(sub);
    const [, r] = await reserve(sub);
    expect(refused(await checkout(sub, r.homeId as string, SESSION_B))).toBe(true);
    expect(refused(await out(await call("/v1/billing/checkout/resume", await token(sub, SESSION_B), { homeId: r.homeId })))).toBe(true);
    // Reserve is sign-in only: the other session gets the same payable home back, never a bootstrap of its own.
    expect(await reserve(sub, SESSION_B)).toEqual([200, expect.objectContaining({ homeId: r.homeId, existing: true })]);
    expect((await row(await userIdOf(sub)))!.session_id).toBe(SESSION_A);
    expect(sessionPosts()).toHaveLength(0);
  });

  it("checkout and resume are bound to the reserved home: homeId required, a different one refused; resume with {} answers 400", async () => {
    const { homeId } = await bought("e0000001-0000-4000-8000-000000000001");
    const sub = "e0000001-0000-4000-8000-000000000001";
    expect(refused(await checkout(sub, undefined))).toBe(true);
    expect((await checkout(sub, "home-someone-else"))[0]).toBe(409);
    expect(await out(await call("/v1/billing/checkout/resume", await token(sub), {}))).toEqual([400, { error: "home_required" }]);
    expect(refused(await out(await call("/v1/billing/checkout/resume", await token(sub), { homeId: "home-other" })))).toBe(true);
    // With its own home named, resume continues the bootstrap (the open session is still open).
    const [rs, rb] = await out(await call("/v1/billing/checkout/resume", await token(sub), { homeId }));
    expect([rs, rb.reused]).toEqual([200, true]);
  });

  it("STEPUP-EMAIL-10 #3: top-up switched on at the first purchase is the shared step-up refusal with an intent; nothing created", async () => {
    const sub = "f0000001-0000-4000-8000-000000000001";
    await account(sub);
    const [, r] = await reserve(sub);
    const first = await checkout(sub, r.homeId as string, SESSION_A, { topup: { enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100 } });
    // The probe answered 400 topup_after_payment here, with no intent: the emailed approval had nothing to approve.
    expect([refused(first), first[1].error]).toEqual([true, "step_up_required"]);
    expect((first[1].step_up as { email_code?: { intent_id?: string } }).email_code?.intent_id).toMatch(/^si_[0-9a-f]{32}$/);
    expect([customerPosts().length, sessionPosts().length, fluxLog.includes("autorecharge")]).toEqual([0, 0, false]);
    // An ordinary bootstrap purchase (no top-up) on the same reservation is unchanged.
    const [cs, c] = await checkout(sub, r.homeId as string);
    expect([cs, c.error]).toEqual([200, undefined]);
  });

  it("STEPUP-EMAIL-3 #1: the bootstrap is never promoted into a step-up approval: no homeId with top-up is refused, and so is its pending intent", async () => {
    const sub = "f0000002-0000-4000-8000-000000000001";
    await account(sub);
    const [rs] = await reserve(sub);
    expect(rs).toBe(201);
    const tok = await token(sub);
    const body = checkoutBody(undefined, { topup: { enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100 } });
    const first = await out(await call("/v1/billing/checkout", tok, body));
    expect(refused(first)).toBe(true);
    const intent = (first[1].step_up as { email_code?: { intent_id?: string } }).email_code?.intent_id;
    expect(intent).toMatch(/^si_[0-9a-f]{32}$/);
    // Repeating with that pending, never verified intent: still refused (no code, no authenticator was verified), nothing created.
    const again = await out(await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent }));
    expect(refused(again)).toBe(true);
    expect((again[1].step_up as { email_code: { intent_id: string } }).email_code.intent_id).not.toBe(intent);
    expect(await env.DB.prepare("SELECT 1 AS x FROM cloud_stepup_intents WHERE id=?").bind(intent).first()).toBeNull();
    expect([customerPosts().length, sessionPosts().length]).toEqual([0, 0]);
  });

  it("always a NEW Stripe customer, never looked up: each first purchase creates its own, keyed to the account and generation", async () => {
    const a = await bought("90000001-0000-4000-8000-000000000001");
    const b = await bought("90000002-0000-4000-8000-000000000001");
    expect(customerPosts().map((c) => c.key)).toEqual([`bootstrap-cust:${a.userId}:1`, `bootstrap-cust:${b.userId}:1`]);
    expect(calls.filter((c) => c.path.startsWith("/v1/customers") && c.method === "GET")).toHaveLength(0);
    expect(calls.some((c) => c.path.includes("search"))).toBe(false);
    expect(sessionPosts().map((c) => c.form.get("customer"))).toEqual(["cus_boot1", "cus_boot2"]);
  });
});

describe("Astra TAXCOUNTRY-6 P2-c: a bootstrap's customer follows the same holds-nothing rule", () => {
  it("the buyer corrects the postal code after the first session: a FRESH customer is created with it, the bootstrap row moves with the pointer, the session issues on it", async () => {
    const sub = "a6c00001-0000-4000-8000-000000000001";
    const { userId, homeId, sessionId } = await bought(sub);
    expect(cust.customers.cus_boot1.address).toMatchObject({ country: "US" });
    const [s2, c2] = await checkout(sub, homeId, SESSION_A, { postalCode: "94105" });
    expect([s2, c2.error]).toEqual([200, undefined]);
    expect(c2.sessionId).not.toBe(sessionId);
    expect(cust.created.map((c) => c.id)).toEqual(["cus_new1"]);
    expect(cust.customers.cus_new1.address).toEqual({ country: "US", postal_code: "94105" });
    expect(sessionPosts().pop()!.form.get("customer")).toBe("cus_new1");
    expect((await env.DB.prepare("SELECT customer_id FROM billing_subscriptions WHERE home_id=?").bind(homeId).first<{ customer_id: string }>())!.customer_id).toBe("cus_new1");
    expect(await row(userId)).toMatchObject({ stripe_customer_id: "cus_new1", stripe_session_id: c2.sessionId, state: "open", generation: 1 });
    expect(sessions.find((x) => x.id === sessionId)!.status).toBe("expired");
    // the old bootstrap customer stays this home's (ledger) and untouched
    expect(cust.customers.cus_boot1.address).toEqual({ country: "US" });
    expect(await env.DB.prepare("SELECT 1 AS x FROM cloud_ops_state WHERE key='customer_home:cus_boot1'").first()).toEqual({ x: 1 });
    // and the bootstrap keeps working on the moved customer: the same choices reuse the new session
    const [s3, c3] = await checkout(sub, homeId, SESSION_A, { postalCode: "94105" });
    expect([s3, c3.sessionId, c3.reused]).toEqual([200, c2.sessionId, true]);
  });

  it("a bootstrap customer that holds something (an attached card) is never switched: 403 step_up_required naming the location on file, with the emailed-code intent (Astra TAXCOUNTRY-7 P2-c)", async () => {
    const sub = "a6c00002-0000-4000-8000-000000000001";
    const { userId, homeId } = await bought(sub);
    cust.paymentMethods.push({ customer: "cus_boot1", id: "pm_setup" });
    const [s2, b2] = await checkout(sub, homeId, SESSION_A, { postalCode: "94105" });
    expect([s2, b2.error, b2.country]).toEqual([403, "step_up_required", "US"]);
    expect(b2.step_up).toMatchObject({ bootstrap: false, reason: "billing_location_on_file", holds: "saved_instrument", country: "US",
      declared: { country: "US", postalCode: "94105" }, email_code: { available: true, intent_id: expect.stringMatching(/^si_[0-9a-f]{32}$/) } });
    expect(cust.created).toEqual([]);
    expect(await row(userId)).toMatchObject({ stripe_customer_id: "cus_boot1" });
  });
});

describe("lifecycle: submitted, consumed on every paid path, parked and closed final", () => {
  it("after issue_until no new or replacement session (403 step_up_required, email intent); the issued session still pays and consumes", async () => {
    const sub = "10000001-0000-4000-8000-000000000001";
    const o = await bought(sub);
    at(T0 + 31 * MIN);
    expect(await checkout(sub, o.homeId, SESSION_A, { checkoutLanguage: "de" })).toMatchObject([403, { error: "step_up_required", step_up: expect.objectContaining({ bootstrap: false, bootstrap_expired: true, email_code: expect.objectContaining({ available: true, intent_id: expect.any(String) }) }) }]);
    expect(await out(await call("/v1/billing/checkout/resume", await token(sub), { homeId: o.homeId }))).toMatchObject([403, { error: "step_up_required", step_up: expect.objectContaining({ bootstrap: false, bootstrap_expired: true, email_code: expect.objectContaining({ available: true, intent_id: expect.any(String) }) }) }]);
    expect(sessionPosts()).toHaveLength(1);
    // A reserve now cannot reclaim: the issued session is still open (it may yet be paid). Sign-in-only fallback, same home, nothing claimed.
    await reserveFallsBack(sub, o);
    expect((await hook("checkout.session.completed", await sessionObj({ ...o, customer: "cus_boot1" }, "paid"))).status).toBe(200);
    expect(await row(o.userId)).toMatchObject({ state: "consumed", consumed_at: clock });
    expect((await env.DB.prepare("SELECT paid_at FROM checkout_consents WHERE id=?").bind(o.consentId).first<{ paid_at: number }>())!.paid_at).not.toBeNull();
  });

  it("completed + paid consumes in the paid-moment transaction; consumed is final", async () => {
    const o = await bought("20000001-0000-4000-8000-000000000001");
    expect((await hook("checkout.session.completed", await sessionObj({ ...o, customer: "cus_boot1" }))).status).toBe(200);
    expect(await row(o.userId)).toMatchObject({ state: "consumed", consumed_at: T0 });
    await expect(env.DB.prepare("UPDATE cloud_purchase_bootstraps SET state='open' WHERE user_id=?").bind(o.userId).run()).rejects.toThrow(/purchase_bootstrap_final/);
    const rr = await reserve("20000001-0000-4000-8000-000000000001");
    expect([refused(rr), rr[1].bootstrap, (await row(o.userId))!.state]).toEqual([false, undefined, "consumed"]);
  });

  it("completed unpaid → submitted (frozen: no new checkout); async_payment_succeeded consumes", async () => {
    const sub = "30000001-0000-4000-8000-000000000001";
    const o = await bought(sub);
    expect((await hook("checkout.session.completed", await sessionObj({ ...o, customer: "cus_boot1" }, "unpaid"))).status).toBe(200);
    expect((await row(o.userId))!.state).toBe("submitted");
    expect(refused(await checkout(sub, o.homeId, SESSION_A, { checkoutLanguage: "de" }))).toBe(true);
    expect(refused(await out(await call("/v1/billing/checkout/resume", await token(sub), { homeId: o.homeId })))).toBe(true);
    expect((await hook("checkout.session.async_payment_succeeded", await sessionObj({ ...o, customer: "cus_boot1" }, "paid"))).status).toBe(200);
    expect(await row(o.userId)).toMatchObject({ state: "consumed", consumed_at: T0 });
  });

  it("completed unpaid, then the first invoice.paid consumes", async () => {
    const o = await bought("40000001-0000-4000-8000-000000000001");
    expect((await hook("checkout.session.completed", await sessionObj({ ...o, customer: "cus_boot1" }, "unpaid"))).status).toBe(200);
    expect((await row(o.userId))!.state).toBe("submitted");
    at(T0 + MIN);
    const inv = { object: "invoice", id: "in_boot1", customer: "cus_boot1", subscription: "sub_boot1", billing_reason: "subscription_create", amount_paid: 4900,
      payment_intent: "pi_boot", lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: { start: T0 / 1000, end: T0 / 1000 + 30 * 86400 } }] } };
    expect((await hook("invoice.paid", inv)).status).toBe(200);
    expect(await row(o.userId)).toMatchObject({ state: "consumed", consumed_at: T0 + MIN });
  });

  it("parked and closed rows are never reused: no checkout, no resume, no reserve, no reclamation, ever", async () => {
    for (const [sub, state] of [["50000001-0000-4000-8000-000000000001", "parked"], ["50000002-0000-4000-8000-000000000001", "closed"]] as const) {
      const o = await bought(sub);
      await env.DB.prepare("UPDATE cloud_purchase_bootstraps SET state=?,closed_reason=? WHERE user_id=?").bind(state, state === "closed" ? "mismatch" : null, o.userId).run();
      expect([state, refused(await checkout(sub, o.homeId, SESSION_A, { checkoutLanguage: "de" }))]).toEqual([state, true]);
      expect([state, refused(await out(await call("/v1/billing/checkout/resume", await token(sub), { homeId: o.homeId })))]).toEqual([state, true]);
      at(T0 + 30 * HOUR);
      const rr = await reserve(sub);
      expect([state, refused(rr), rr[1].bootstrap]).toEqual([state, false, undefined]);
      expect([state, (await row(o.userId))!.generation]).toEqual([state, 1]);
      at(T0);
    }
    await expect(env.DB.prepare("UPDATE cloud_purchase_bootstraps SET state='open',generation=2 WHERE state='closed'").run()).rejects.toThrow(/purchase_bootstrap_final/);
  });
});

describe("abandonment: expired once, then ONE more generation, only while the protect-set is empty", () => {
  it("an attempt with no session expires after issue_until; generation 2 is claimed once; a third is refused", async () => {
    const sub = "60000001-0000-4000-8000-000000000001";
    const u = await account(sub);
    const [, r1] = await reserve(sub);
    at(T0 + 31 * MIN);
    const [s2, r2] = await reserve(sub, SESSION_B);
    expect([s2, r2.bootstrap]).toEqual([201, true]);
    expect(r2.homeId).not.toBe(r1.homeId);
    expect(await row(u)).toMatchObject({ generation: 2, state: "open", session_id: SESSION_B, home_id: r2.homeId, stripe_customer_id: null });
    expect(await env.DB.prepare("SELECT generation,home_id,state FROM cloud_purchase_bootstrap_history WHERE user_id=?").bind(u).all().then((x) => x.results))
      .toEqual([{ generation: 1, home_id: r1.homeId, state: "expired" }]);
    expect((await env.DB.prepare("SELECT desired_state FROM cloud_homes WHERE id=?").bind(r1.homeId).first<{ desired_state: string }>())!.desired_state).toBe("deleted");
    // Generation 2 checks out normally (the expired generation's deleted home is its own history, not a record to protect).
    expect((await checkout(sub, r2.homeId as string, SESSION_B))[0]).toBe(200);
    // ... but once it too is abandoned, there is no third attempt.
    sessions[0].status = "expired";
    at(T0 + 27 * HOUR);
    const third = await reserve(sub);
    expect([refused(third), third[1].bootstrap]).toEqual([false, undefined]); // sign-in-only reserve, never a third bootstrap
    expect((await row(u))!.generation).toBe(2);
  });

  it("reclaimed only while empty apart from its own expired records; an issued session must be terminal first", async () => {
    const sub = "70000001-0000-4000-8000-000000000001";
    const o = await bought(sub);
    // The issued session is still open: never reclaimed (the sign-in-only fallback hands back the same home).
    at(T0 + 31 * MIN);
    await reserveFallsBack(sub, o);
    // Stripe's expiry event for it: expired (the webhook path), with its history (home, customer, session) kept.
    sessions[0].status = "expired";
    expect((await hook("checkout.session.expired", { object: "checkout.session", id: o.sessionId, mode: "subscription", customer: "cus_boot1",
      client_reference_id: o.homeId, metadata: { home_id: o.homeId, plan: "starter", consent_id: o.consentId } })).status).toBe(200);
    expect((await row(o.userId))!.state).toBe("expired");
    expect(await env.DB.prepare("SELECT home_id,stripe_customer_id,stripe_session_id FROM cloud_purchase_bootstrap_history WHERE user_id=?").bind(o.userId).first())
      .toEqual({ home_id: o.homeId, stripe_customer_id: "cus_boot1", stripe_session_id: o.sessionId });
    at(T0 + 26 * HOUR);
    // Empty again apart from its own expired home (now deleted) and that home's unpaid billing row with its own customer: generation 2.
    const [s, r] = await reserve(sub);
    expect([s, r.bootstrap]).toEqual([201, true]);
    expect(await row(o.userId)).toMatchObject({ generation: 2, state: "open", stripe_customer_id: null, stripe_session_id: null, consent_id: null });
    const [cs] = await checkout(sub, r.homeId as string);
    expect(cs).toBe(200);
    expect(customerPosts().map((c) => c.key)).toEqual([`bootstrap-cust:${o.userId}:1`, `bootstrap-cust:${o.userId}:2`]);
  });
});

describe("Astra TRUSTCODE-2: deadline at the write, one complete reconciliation, release after abandonment, retry re-check", () => {
  const expiredHook = (o: { homeId: string; sessionId: string; consentId: string }) => hook("checkout.session.expired", { object: "checkout.session",
    id: o.sessionId, mode: "subscription", customer: sessions.find((x) => x.id === o.sessionId)!.customer, client_reference_id: o.homeId, metadata: { home_id: o.homeId, plan: "starter", consent_id: o.consentId } });
  const homeState = async (id: string) => (await env.DB.prepare("SELECT desired_state FROM cloud_homes WHERE id=?").bind(id).first<{ desired_state: string }>())!.desired_state;

  it("P2-1 checkout: the clock crosses issue_until during the Stripe call: nothing published, the session expired, 403 step_up_required (email intent)", async () => {
    const sub = "a2000001-0000-4000-8000-000000000001";
    const u = await account(sub);
    const [, r] = await reserve(sub);
    at(T0 + 30 * MIN - 1000);
    onSessionCreate = () => at(T0 + 30 * MIN + 5000);
    expect(await checkout(sub, r.homeId as string)).toMatchObject([403, { error: "step_up_required", step_up: expect.objectContaining({ bootstrap: false, bootstrap_expired: true, email_code: expect.objectContaining({ available: true, intent_id: expect.any(String) }) }) }]);
    expect(sessionPosts()).toHaveLength(1);
    expect(sessions[0].status).toBe("expired");
    expect(await row(u)).toMatchObject({ state: "open", stripe_session_id: null, consent_id: null });
    expect((await env.DB.prepare("SELECT state FROM open_checkouts WHERE home_id=?").bind(r.homeId).first<{ state: string }>())!.state).not.toBe("open");
  });

  it("P2-1 resume: a replacement session created across issue_until is not published (403 step_up_required, email intent); one past it is never created", async () => {
    const sub = "a2000002-0000-4000-8000-000000000001";
    const o = await bought(sub);
    sessions[0].status = "expired"; // Stripe let the first page lapse; the local row still says open
    at(T0 + 30 * MIN - 1000);
    onSessionCreate = () => at(T0 + 30 * MIN + 5000);
    const [s, b] = await out(await call("/v1/billing/checkout/resume", await token(sub), { homeId: o.homeId }));
    expect([s, b.error]).toEqual([403, "step_up_required"]);
    expect(b.step_up).toMatchObject({ bootstrap: false, bootstrap_expired: true, email_code: { available: true, intent_id: expect.any(String) } });
    expect(sessionPosts()).toHaveLength(2);
    expect(sessions.map((x) => x.status)).toEqual(["expired", "expired"]);
    expect((await row(o.userId))!.stripe_session_id).toBe(o.sessionId);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM checkout_resume_attempts WHERE home_id=? AND state='creating'").bind(o.homeId).first<{ n: number }>())!.n).toBe(0);
  });

  it("INTEGRATED-1 #8 expired bootstrap: checkout and resume answer the email step-up offer; the unresolved attempt and its original key are kept", async () => {
    const sub = "a2000009-0000-4000-8000-000000000001";
    const o = await bought(sub);
    at(T0 + 31 * MIN);
    await reserveFallsBack(sub, o);
    const snap = async () => ({
      boot: await row(o.userId),
      attempts: (await env.DB.prepare("SELECT * FROM checkout_resume_attempts WHERE home_id=? ORDER BY id").bind(o.homeId).all()).results,
      open: (await env.DB.prepare("SELECT * FROM open_checkouts WHERE home_id=? ORDER BY 1").bind(o.homeId).all()).results,
    });
    const before = await snap();
    const posts = sessionPosts().length;
    const [s1, b1] = await checkout(sub, o.homeId);
    const [s2, b2] = await out(await call("/v1/billing/checkout/resume", await token(sub), { homeId: o.homeId }));
    for (const [s, b] of [[s1, b1], [s2, b2]] as const) {
      expect(s).toBe(403);
      expect(b.error).toBe("step_up_required");
      expect(b.step_up).toMatchObject({ bootstrap: false, bootstrap_expired: true, email_code: { available: true, intent_id: expect.any(String) } });
      expect(typeof (b.step_up as { email_code: { intent_id: unknown } }).email_code.intent_id).toBe("string");
    }
    expect(sessionPosts()).toHaveLength(posts);
    const after = await snap();
    expect(after.boot).toMatchObject({ state: "open", stripe_session_id: o.sessionId });
    expect(after.attempts).toEqual(before.attempts);
    expect(after.open).toEqual(before.open);
  });

  it("P2-2: an open orphan beside the latest expired session, beyond page 1: neither the webhook nor reserve expires the row", async () => {
    const sub = "a2000003-0000-4000-8000-000000000001";
    const o = await bought(sub);
    sessions[0].status = "expired";
    sessions.push({ id: "cs_orphan1", status: "open", customer: "cus_boot1", subscription: null, metadata: { home_id: o.homeId } });
    pageSize = 1;
    at(T0 + 31 * MIN);
    expect((await expiredHook(o)).status).toBe(200);
    expect((await row(o.userId))!.state).toBe("open");
    await reserveFallsBack(sub, o);
    expect((await row(o.userId))!.state).toBe("open");
    expect(calls.filter((c) => c.method === "GET" && c.path === "/v1/checkout/sessions").length).toBeGreaterThanOrEqual(4); // two pages, twice
    // Once the orphan is terminal too, the same reconciliation expires it.
    sessions[1].status = "expired";
    const [s2, r2] = await reserve(sub, SESSION_B);
    expect([s2, r2.bootstrap]).toEqual([201, true]);
    expect((await row(o.userId))!.generation).toBe(2);
  });

  it("P2-3: confirmed abandonment releases the unused reservation: the second attempt reserves at minute 61", async () => {
    const sub = "a2000004-0000-4000-8000-000000000001";
    const o = await bought(sub);
    at(T0 + 31 * MIN);
    sessions[0].status = "expired";
    expect((await expiredHook(o)).status).toBe(200);
    expect((await row(o.userId))!.state).toBe("expired");
    at(T0 + 61 * MIN);
    const [s, r] = await reserve(sub);
    expect([s, r.bootstrap]).toEqual([201, true]);
    expect(r.homeId).not.toBe(o.homeId);
    expect(await homeState(o.homeId)).toBe("deleted");
    expect(await row(o.userId)).toMatchObject({ generation: 2, state: "open", home_id: r.homeId });
  });

  it("P2-3: settlement unknown (Stripe unreachable, or a payment not yet processed): the old home stays and reserve is still refused", async () => {
    for (const [sub, why] of [["a2000005-0000-4000-8000-000000000001", "stripe"], ["a2000006-0000-4000-8000-000000000001", "inbox"]] as const) {
      at(T0);
      sessions = [];
      const o = await bought(sub);
      at(T0 + 31 * MIN);
      sessions[0].status = "expired";
      expect((await expiredHook(o)).status).toBe(200);
      expect([why, (await row(o.userId))!.state]).toEqual([why, "expired"]);
      at(T0 + 61 * MIN);
      if (why === "stripe") listFails = true;
      else await env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,1,'{}',?,NULL)").bind(`evt-unprocessed-${o.homeId}`, o.homeId, clock).run();
      // Not reclaimed: the sign-in-only reserve hands back the same old home.
      const rr = await reserve(sub);
      expect([why, refused(rr), rr[1].homeId, rr[1].bootstrap]).toEqual([why, false, o.homeId, undefined]);
      expect([why, await homeState(o.homeId)]).toEqual([why, "payment_pending"]);
      expect([why, (await row(o.userId))!.generation]).toEqual([why, 1]);
      listFails = false;
    }
  });

  it("P3-4: a same-session reserve retry re-checks the protect-set (a machine assignment added after the reservation refuses it)", async () => {
    const sub = "a2000007-0000-4000-8000-000000000001";
    const u = await account(sub);
    const [s1] = await reserve(sub);
    expect(s1).toBe(201);
    await env.DB.prepare("INSERT INTO machine_owners (machine_id,owner_user_id,assigned_at) VALUES ('m-after-reserve',?,0)").bind(u).run();
    const [s2, r2] = await reserve(sub);
    expect([s2, r2.bootstrap]).toEqual([200, undefined]); // the same home, sign-in only; the bootstrap no longer applies
    expect(refused(await checkout(sub, r2.homeId as string))).toBe(true);
  });

  it("an expired attempt is never reclaimed while another record exists: reserve is sign-in only then, and the generation stays", async () => {
    const sub = "70000002-0000-4000-8000-000000000001";
    const o = await bought(sub);
    at(T0 + 31 * MIN);
    sessions[0].status = "expired";
    expect((await hook("checkout.session.expired", { object: "checkout.session", id: o.sessionId, mode: "subscription", customer: "cus_boot1",
      client_reference_id: o.homeId, metadata: { home_id: o.homeId, plan: "starter", consent_id: o.consentId } })).status).toBe(200);
    at(T0 + 26 * HOUR);
    await env.DB.prepare("INSERT INTO machine_owners (machine_id,owner_user_id,assigned_at) VALUES ('m-x2',?,0)").bind(o.userId).run();
    const [, r] = await reserve(sub);
    expect([r.bootstrap, (await row(o.userId))!.generation]).toEqual([undefined, 1]);
  });
});

describe("the authenticator-added notice", () => {
  it("states how the factor was approved and the if-not-you steps, with no blanket hold or inbox claim", async () => {
    const sub = "80000001-0000-4000-8000-000000000001";
    factors = [{ id: FM, factor_type: "totp", status: "verified", friendly_name: "Pat's phone" }];
    const t = await token(sub, SESSION_A, FM);
    expect((await call("/v1/account/mfa/trust-code", t, { factorId: FM })).status).toBe(202);
    const code = /Your one-time code is: (\d{8})/.exec(mail.at(-1)!.text)![1];
    expect((await call("/v1/account/mfa/trust", t, { factorId: FM, code })).status).toBe(201);
    const notice = mail.at(-1)!;
    expect(notice.subject).toBe("An authenticator was added to the trusted list on your Murage Cloud account");
    expect(notice.text).toContain("It was approved with the one-time code we emailed to this address.");
    expect(notice.text).toContain("If this was not you: do not share any code, sign in at https://murage.ai, change your password, remove every authenticator you do not recognise");
    expect(notice.text).not.toContain("cannot approve payments or connect a desktop until its hold ends");
  });
});

describe("STEPUP-EMAIL-4 #1: an emailed step-up approval completes the real checkout and resume handlers", () => {
  const HDR = "x-step-up-consumed";
  type StepUpBody = { step_up: { email_code: { intent_id: string } } };
  /** Send the code to the account's address, read it from the mail, verify it: the intent is approved. */
  async function approveByEmail(tok: string, intentId: string) {
    const [ss, sent] = await out(await call("/v1/account/step-up/email/send", tok, { intentId }));
    expect(ss).toBe(202);
    const code = /Your code is: (\d{6})/.exec(mail.at(-1)?.text ?? "")?.[1];
    expect(code).toMatch(/^\d{6}$/);
    const [vs] = await out(await call("/v1/account/step-up/email/verify", tok, { intentId, challengeId: sent.challengeId, code }));
    expect(vs).toBe(200);
  }
  const intentRow = (id: string) => env.DB.prepare("SELECT state,phase,dispatch_ref FROM cloud_stepup_intents WHERE id=?").bind(id).first<Record<string, unknown>>();
  /** Something to protect appears on the account (a machine assignment): the first-purchase bootstrap no longer applies. */
  const protect = (u: string) => env.DB.prepare("INSERT INTO machine_owners (machine_id,owner_user_id,assigned_at) VALUES (?,?,0)").bind(`m-s4-${u}`, u).run();

  it("checkout: preparation, dispatch, then ONE session created and recorded commits it; its duplicate creates nothing", async () => {
    const sub = "a4000001-0000-4000-8000-000000000001";
    const u = await account(sub);
    const [rs, r] = await reserve(sub);
    expect(rs).toBe(201);
    await protect(u);
    const tok = await token(sub);
    const body = checkoutBody(r.homeId as string);
    const first = await out(await call("/v1/billing/checkout", tok, body));
    expect(refused(first)).toBe(true);
    const intent = (first[1] as unknown as StepUpBody).step_up.email_code.intent_id;
    await approveByEmail(tok, intent);
    const res = await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent });
    expect(res.headers.get(HDR)).toBe("1");
    const [s, b] = await out(res);
    expect([s, b.error]).toEqual([200, undefined]);
    expect(b.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(sessionPosts()).toHaveLength(1);
    expect(await env.DB.prepare("SELECT state,session_id FROM open_checkouts WHERE home_id=?").bind(r.homeId).first()).toEqual({ state: "open", session_id: b.sessionId });
    expect(await intentRow(intent)).toMatchObject({ state: "done", phase: "delivered", dispatch_ref: `checkout:${r.homeId as string}` });
    const again = await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent });
    expect(await out(again)).toEqual([410, { error: "already_completed", operation: { id: intent } }]);
    expect(sessionPosts()).toHaveLength(1);
  });

  it("Astra TAXCOUNTRY-7 P2-c: holder recovery end to end: 403 with the email intent, verified, the holder's own location moved (journaled), the identical retry checks out", async () => {
    const sub = "a7c00001-0000-4000-8000-000000000001";
    const o = await bought(sub);
    cust.paymentMethods.push({ customer: "cus_boot1", id: "pm_setup" });
    const tok = await token(sub);
    const body = checkoutBody(o.homeId, { postalCode: "94105" });
    const first = await out(await call("/v1/billing/checkout", tok, body));
    expect([first[0], first[1].error, (first[1].step_up as Record<string, unknown>).reason]).toEqual([403, "step_up_required", "billing_location_on_file"]);
    expect([first[1].country, (first[1].step_up as Record<string, unknown>).declared]).toEqual(["US", { country: "US", postalCode: "94105" }]);
    expect(cust.executed).toEqual([]);
    const intent = (first[1] as unknown as StepUpBody).step_up.email_code.intent_id;
    await approveByEmail(tok, intent);
    const res = await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent });
    expect(res.headers.get(HDR)).toBe("1");
    const [s, b] = await out(res);
    expect([s, b.error]).toEqual([200, undefined]);
    // The customer moved ITS OWN billing location (the whole address replaced; the card stays with it), never switched to a new customer.
    expect(cust.customers.cus_boot1.address).toMatchObject({ country: "US", postal_code: "94105" });
    expect(cust.created).toEqual([]);
    expect(cust.violations).toEqual([]);
    expect(sessionPosts().pop()!.form.get("customer")).toBe("cus_boot1");
    expect((await env.DB.prepare("SELECT customer_id FROM billing_subscriptions WHERE home_id=?").bind(o.homeId).first<{ customer_id: string }>())!.customer_id).toBe("cus_boot1");
    const moved = await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key LIKE 'customer_move:%'").all<{ value: string }>();
    expect(moved.results.map((r) => JSON.parse(r.value))).toEqual([expect.objectContaining({ customerId: "cus_boot1", by: "customer_verified", intentId: intent,
      holds: "saved_instrument", toCountry: "US", movedAt: expect.any(Number) })]);
    expect(await env.DB.prepare("SELECT 1 FROM cloud_ops_state WHERE key LIKE 'holder_move:%'").first()).toBeNull();
  });

  describe("Astra TAXCOUNTRY-9 P2-b (round 10): an earlier approved move is settled by REPLAYING its own request (its key, its body), never by elapsed time or a read-back", () => {
    const aKey = "customer-move:consent-a:7";
    const aBody = customerMoveBody({ country: "CA", postalCode: "M5V 2T6", moveKey: aKey });
    const setup = async (sub: string, ageMs: number, journal: { body?: boolean } = { body: true }) => {
      const o = await bought(sub);
      cust.paymentMethods.push({ customer: "cus_boot1", id: "pm_setup" });
      const tok = await token(sub);
      const body = checkoutBody(o.homeId, { postalCode: "94105" });
      const first = await out(await call("/v1/billing/checkout", tok, body));
      expect(first[0]).toBe(403);
      const intent = (first[1] as unknown as StepUpBody).step_up.email_code.intent_id;
      await approveByEmail(tok, intent);
      // Move A: approved earlier, journaled with its key and exact body, its answer lost (no movedAt).
      const a = `customer_move:${o.homeId}:${aKey}`;
      await env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES (?,?)").bind(a, JSON.stringify({ homeId: o.homeId, customerId: "cus_boot1",
        consentId: "consent-a", by: "customer_verified", intentId: "si_a", holds: "saved_instrument", fromCountry: "US", toCountry: "CA", postalChanged: true,
        at: clock - ageMs, generation: 7, ...(journal.body ? { moveKey: aKey, body: aBody } : {}) })).run();
      return { o, tok, body, intent, a };
    };
    const rowOf = async (k: string) => JSON.parse((await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key=?").bind(k).first<{ value: string }>())!.value);

    it("backwards move with DELAYED TRANSPORT: A applied at Stripe but its answer is lost and its request still in transit; B replays A first (cached), then lands; A's late arrival changes nothing", async () => {
      const { tok, body, intent, a } = await setup("a7c00005-0000-4000-8000-000000000001", 60_000);
      // A executed at Stripe (its result cached under its key); our worker never saw the answer.
      await cust.handle("POST", new URL("https://api.stripe.com/v1/customers/cus_boot1"), new URLSearchParams(aBody), aKey);
      expect(cust.customers.cus_boot1.address).toMatchObject({ country: "CA" });
      const res = await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent });
      expect((await out(res))[0]).toBe(200);
      expect(cust.customers.cus_boot1.address).toMatchObject({ country: "US", postal_code: "94105" });
      expect(await rowOf(a)).toMatchObject({ settledAt: expect.any(Number), settledBy: "replay", landed: 1 });
      // The original A request, delayed in transport, reaches Stripe only now: Stripe replays its cached answer, B's address stands.
      const late = await cust.handle("POST", new URL("https://api.stripe.com/v1/customers/cus_boot1"), new URLSearchParams(aBody), aKey);
      expect(late!.headers.get("idempotent-replayed")).toBe("true");
      expect(cust.customers.cus_boot1.address).toMatchObject({ country: "US", postal_code: "94105" });
      expect(cust.violations).toEqual([]);
    });

    it("A never reached Stripe: the replay executes it NOW (under its key), so it is finished before B; B lands last", async () => {
      const { tok, body, intent, a } = await setup("a7c00006-0000-4000-8000-000000000001", 11 * 60_000);
      const res = await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent });
      expect((await out(res))[0]).toBe(200);
      expect(cust.executed.map((e) => e.key)).toEqual([aKey, expect.stringMatching(/^customer-move:/)]);
      expect(cust.customers.cus_boot1.address).toMatchObject({ country: "US", postal_code: "94105" });
      expect(await rowOf(a)).toMatchObject({ settledBy: "replay", landed: 1 });
      const moved = await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key LIKE 'customer_move:%' AND key<>?").bind(a).all<{ value: string }>();
      expect(moved.results.map((r) => JSON.parse(r.value))).toEqual([expect.objectContaining({ customerId: "cus_boot1", movedAt: expect.any(Number) })]);
    });

    it("A still in flight at Stripe (the replay answers 409 in use): A is not settled; B is refused (503, retryable); nothing is written", async () => {
      const { o, tok, body, intent, a } = await setup("a7c00007-0000-4000-8000-000000000001", 3 * 3_600_000);
      cust.byKey[aKey] = "inflight";
      const res = await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent });
      expect(res.status).toBe(503);
      expect(cust.customers.cus_boot1.address?.postal_code).not.toBe("94105");
      const rows = await env.DB.prepare("SELECT key FROM cloud_ops_state WHERE key LIKE 'customer_move:%'").all<{ key: string }>();
      expect(rows.results.map((r) => r.key)).toEqual([a]);
      expect((await rowOf(a)).settledAt).toBeUndefined();
      expect(o.homeId).toBeTruthy();
    });

    it("INTEGRATED-7 P2 uncached replay error: A's replay answers a FRESH (uncached) 400: A is never settled, B is refused and never sent", async () => {
      const { tok, body, intent, a } = await setup("a7c00009-0000-4000-8000-000000000001", 60_000);
      cust.nextUpdate = "refused"; // a validation failure of the replay itself: Stripe saves no result, so the original A may still execute
      const res = await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent });
      expect(res.status).toBe(503);
      // Before the fix: A was marked settled (landed 0) and B was dispatched while A could still land after it.
      expect((await rowOf(a)).settledAt).toBeUndefined();
      expect(cust.executed).toEqual([]);
      const rows = await env.DB.prepare("SELECT key FROM cloud_ops_state WHERE key LIKE 'customer_move:%'").all<{ key: string }>();
      expect(rows.results.map((r) => r.key)).toEqual([a]);
      expect(cust.customers.cus_boot1.address?.postal_code).not.toBe("94105");
      expect(cust.violations).toEqual([]);
    });

    it("INTEGRATED-7 P2: A's cached (Idempotent-Replayed) answer settles it; B's own direct 400 answer is recorded on B's journal row as terminal evidence", async () => {
      const { tok, body, intent, a } = await setup("a7c0000a-0000-4000-8000-000000000001", 60_000);
      cust.byKey[aKey] = { status: 200, body: { id: "cus_boot1", object: "customer" } };
      cust.nextUpdate = "refused"; // B's own request is refused by Stripe (answered, never executed)
      const res = await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent });
      expect(res.status).toBe(503);
      expect(await rowOf(a)).toMatchObject({ settledBy: "replay", landed: 1 });
      const b = (await env.DB.prepare("SELECT key FROM cloud_ops_state WHERE key LIKE 'customer_move:%' AND key<>?").bind(a).first<{ key: string }>())!.key;
      expect(await rowOf(b)).toMatchObject({ settledBy: "answer", landed: 0, settledAt: expect.any(Number), refusedWith: expect.stringContaining("400") });
      expect((await rowOf(b)).movedAt).toBeUndefined();
    });

    it("A unsettled past the replay window (or journaled without its body): HELD with a high alert, never assumed settled", async () => {
      const { o, tok, body, intent, a } = await setup("a7c00008-0000-4000-8000-000000000001", 21 * 3_600_000);
      const res = await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent });
      expect(res.status).toBe(503);
      expect(cust.executed).toEqual([]);
      expect((await rowOf(a)).settledAt).toBeUndefined();
      expect(await env.DB.prepare("SELECT severity,subject,resolved_at FROM cloud_alerts WHERE kind='billing.customer_move_unsettled' AND home_id=?").bind(o.homeId).first())
        .toEqual({ severity: "high", subject: a, resolved_at: null });
    });
  });

  it("round 8b: holder recovery on /checkout/resume: the same 403 (reason, on-file and declared location, email intent); the IDENTICAL resume with stepUpIntentId moves the holder and continues", async () => {
    const sub = "a7c00003-0000-4000-8000-000000000001";
    const o = await bought(sub);
    sessions[0].status = "expired"; // a fresh session is needed: resume reaches the customer preset
    cust.paymentMethods.push({ customer: "cus_boot1", id: "pm_setup" });
    // The order's consent declares a postal code the customer on file does not carry.
    await env.DB.prepare("UPDATE checkout_consents SET postal_code='94105' WHERE id=(SELECT consent_id FROM open_checkouts WHERE home_id=?)").bind(o.homeId).run();
    const tok = await token(sub);
    const first = await out(await call("/v1/billing/checkout/resume", tok, { homeId: o.homeId }));
    const stepUp = first[1].step_up as Record<string, unknown>;
    expect([first[0], first[1].error, stepUp.reason, first[1].country, stepUp.country, stepUp.declared])
      .toEqual([403, "step_up_required", "billing_location_on_file", "US", "US", { country: "US", postalCode: "94105" }]);
    expect(stepUp).toMatchObject({ bootstrap: false, holds: "saved_instrument", email_code: { available: true, intent_id: expect.stringMatching(/^si_[0-9a-f]{32}$/) } });
    expect(cust.executed).toEqual([]);
    const intent = (first[1] as unknown as StepUpBody).step_up.email_code.intent_id;
    await approveByEmail(tok, intent);
    const res = await call("/v1/billing/checkout/resume", tok, { homeId: o.homeId, stepUpIntentId: intent });
    const [s, b] = await out(res);
    expect([s, b.error]).toEqual([200, undefined]);
    expect(b.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(cust.customers.cus_boot1.address).toMatchObject({ country: "US", postal_code: "94105" });
    expect(cust.created).toEqual([]);
    expect(sessionPosts().pop()!.form.get("customer")).toBe("cus_boot1");
    const moved = await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key LIKE 'customer_move:%'").all<{ value: string }>();
    expect(moved.results.map((r) => JSON.parse(r.value))).toEqual([expect.objectContaining({ customerId: "cus_boot1", by: "customer_verified", intentId: intent,
      movedAt: expect.any(Number) })]);
    expect(await env.DB.prepare("SELECT 1 FROM cloud_ops_state WHERE key LIKE 'holder_move:%'").first()).toBeNull();
  });

  it("Astra TAXCOUNTRY-7 P2-c: a verified member WITHOUT the holder refusal on record keeps the 409 (no move offered)", async () => {
    const sub = "a7c00002-0000-4000-8000-000000000001";
    const u = await account(sub);
    const [rs, r] = await reserve(sub);
    expect(rs).toBe(201);
    await protect(u);
    const tok = await token(sub);
    const body0 = checkoutBody(r.homeId as string);
    const f0 = await out(await call("/v1/billing/checkout", tok, body0));
    await approveByEmail(tok, (f0[1] as unknown as StepUpBody).step_up.email_code.intent_id);
    expect((await out(await call("/v1/billing/checkout", tok, { ...body0, stepUpIntentId: (f0[1] as unknown as StepUpBody).step_up.email_code.intent_id })))[0]).toBe(200);
    const customer = (await env.DB.prepare("SELECT customer_id FROM billing_subscriptions WHERE home_id=?").bind(r.homeId).first<{ customer_id: string }>())!.customer_id;
    cust.paymentMethods.push({ customer, id: "pm_setup" });
    at(clock + 31_000); // the emailed code's resend gap
    const body = checkoutBody(r.homeId as string, { postalCode: "94105" });
    const first = await out(await call("/v1/billing/checkout", tok, body));
    expect(refused(first)).toBe(true);
    const intent = (first[1] as unknown as StepUpBody).step_up.email_code.intent_id;
    await approveByEmail(tok, intent);
    const [s, b] = await out(await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent }));
    expect([s, b.error]).toEqual([409, "country_mismatch_existing"]);
    expect(cust.executed).toEqual([]);
  });

  it("Astra TAXCOUNTRY-7 P2-d: a bootstrap customer created across issue_until (binding refused) is journaled and recorded as an orphan, never lost", async () => {
    const sub = "a7c00003-0000-4000-8000-000000000001";
    const u = await account(sub);
    const [rs, r] = await reserve(sub);
    expect(rs).toBe(201);
    onFirstCustomer = () => at(T0 + 31 * MIN);
    const [s, b] = await checkout(sub, r.homeId as string);
    expect([s, b.error]).toEqual([403, "step_up_required"]);
    const orphan = await env.DB.prepare("SELECT key,value FROM cloud_ops_state WHERE key LIKE 'customer_orphan:%'").all<{ key: string; value: string }>();
    expect(orphan.results.map((x) => ({ key: x.key, ...JSON.parse(x.value) as Record<string, unknown> }))).toEqual([expect.objectContaining({
      key: `customer_orphan:${r.homeId as string}:bootstrap-cust:${u}:1`, customerId: "cus_boot1", reason: "binding_failed", homeId: r.homeId })]);
    expect(JSON.parse((await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key='customer_home:cus_boot1'").first<{ value: string }>())!.value))
      .toMatchObject({ homeId: r.homeId, role: "orphan" });
    expect(await env.DB.prepare("SELECT 1 FROM cloud_ops_state WHERE key LIKE 'tax_customer:%'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM billing_subscriptions WHERE home_id=?").bind(r.homeId).first()).toBeNull();
  });

  it("STEPUP-EMAIL-10 #3: a fresh account's first purchase WITH top-up: 403 with intent, emailed code, the exact retry checks out once", async () => {
    const sub = "a4000010-0000-4000-8000-000000000001";
    await account(sub);
    const [rs, r] = await reserve(sub);
    expect([rs, r.bootstrap]).toEqual([201, true]);
    const tok = await token(sub);
    const body = checkoutBody(r.homeId as string, { topup: { enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100 } });
    const first = await out(await call("/v1/billing/checkout", tok, body));
    expect(refused(first)).toBe(true);
    expect(sessionPosts()).toHaveLength(0);
    const intent = (first[1] as unknown as StepUpBody).step_up.email_code.intent_id;
    await approveByEmail(tok, intent);
    const res = await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent });
    expect(res.headers.get(HDR)).toBe("1");
    const [s, b] = await out(res);
    expect([s, b.error]).toEqual([200, undefined]);
    expect(sessionPosts()).toHaveLength(1);
    expect(await intentRow(intent)).toMatchObject({ state: "done", phase: "delivered", dispatch_ref: `checkout:${r.homeId as string}` });
    // One emailed code for the purchase: the approval is spent.
    expect((await out(await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent })))[0]).toBe(410);
    expect(sessionPosts()).toHaveLength(1);
  });

  it("checkout/resume: a fresh session for the open order is created exactly once and committed with its recording", async () => {
    const sub = "a4000002-0000-4000-8000-000000000001";
    const o = await bought(sub);
    sessions[0].status = "expired"; // the first session lapsed at Stripe; the local row still says open
    await protect(o.userId);
    const tok = await token(sub);
    const first = await out(await call("/v1/billing/checkout/resume", tok, { homeId: o.homeId }));
    expect(refused(first)).toBe(true);
    const intent = (first[1] as unknown as StepUpBody).step_up.email_code.intent_id;
    await approveByEmail(tok, intent);
    const res = await call("/v1/billing/checkout/resume", tok, { homeId: o.homeId, stepUpIntentId: intent });
    expect(res.headers.get(HDR)).toBe("1");
    const [s, b] = await out(res);
    expect([s, b.error, b.reused]).toEqual([200, undefined, false]);
    expect(b.sessionId).not.toBe(o.sessionId);
    expect(sessionPosts()).toHaveLength(2);
    expect(await env.DB.prepare("SELECT state,session_id FROM open_checkouts WHERE home_id=?").bind(o.homeId).first()).toEqual({ state: "open", session_id: b.sessionId });
    expect(await intentRow(intent)).toMatchObject({ state: "done", phase: "delivered" });
    expect((await intentRow(intent))!.dispatch_ref).toMatch(/^resume:/);
    expect((await out(await call("/v1/billing/checkout/resume", tok, { homeId: o.homeId, stepUpIntentId: intent })))[0]).toBe(410);
    expect(sessionPosts()).toHaveLength(2);
  });
  it("STEPUP-EMAIL-5 #1: a resume approved for order A never pays for a same-plan order B that replaced it: 403 with a fresh intent", async () => {
    const sub = "a5000001-0000-4000-8000-000000000001";
    const o = await bought(sub);
    sessions[0].status = "expired";
    await protect(o.userId);
    const tok = await token(sub);
    const first = await out(await call("/v1/billing/checkout/resume", tok, { homeId: o.homeId }));
    expect(refused(first)).toBe(true);
    const intent = (first[1] as unknown as StepUpBody).step_up.email_code.intent_id;
    await approveByEmail(tok, intent);
    // The SQL probe: order B (another consent, the same plan, price and country) replaces A as the home's open checkout.
    const a = (await env.DB.prepare("SELECT * FROM checkout_consents WHERE id=?").bind(o.consentId).first<Record<string, unknown>>())!;
    const b: Record<string, unknown> = { ...a, id: "consent-order-b", stripe_session_id: null };
    const cols = Object.keys(b);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO checkout_consents (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...cols.map((k) => b[k])),
      env.DB.prepare("UPDATE open_checkouts SET consent_id='consent-order-b' WHERE home_id=?").bind(o.homeId),
    ]);
    const posts = sessionPosts().length;
    const res = await call("/v1/billing/checkout/resume", tok, { homeId: o.homeId, stepUpIntentId: intent });
    const again = await out(res);
    expect(refused(again)).toBe(true);
    expect((again[1] as unknown as StepUpBody).step_up.email_code.intent_id).not.toBe(intent);
    expect(res.headers.get(HDR)).toBeNull();
    expect(sessionPosts()).toHaveLength(posts);
    expect(await intentRow(intent)).toBeNull();
    expect(await env.DB.prepare("SELECT consent_id FROM open_checkouts WHERE home_id=?").bind(o.homeId).first()).toEqual({ consent_id: "consent-order-b" });
  });

  it("STEPUP-EMAIL-5 #3: a crash between Stripe's session and its commit batch: the exact retry replays the attempt's key and records the orphan", async () => {
    const sub = "a5000002-0000-4000-8000-000000000001";
    const u = await account(sub);
    const [rs, r] = await reserve(sub);
    expect(rs).toBe(201);
    await protect(u);
    const tok = await token(sub);
    const body = checkoutBody(r.homeId as string);
    const first = await out(await call("/v1/billing/checkout", tok, body));
    expect(refused(first)).toBe(true);
    const intent = (first[1] as unknown as StepUpBody).step_up.email_code.intent_id;
    await approveByEmail(tok, intent);
    honourKeys = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The batch that records the session never lands (the worker dies there): the open row refuses its move to 'open', this once.
    await env.DB.prepare("CREATE TRIGGER stepup_crash BEFORE UPDATE OF state ON open_checkouts WHEN NEW.state='open' BEGIN SELECT RAISE(ABORT, 'injected crash'); END").run();
    let crashed: Response;
    try { crashed = await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent }); }
    finally { await env.DB.prepare("DROP TRIGGER IF EXISTS stepup_crash").run(); }
    expect(crashed.status).toBe(500);
    expect(crashed.headers.get(HDR)).toBe("1");
    expect(await intentRow(intent)).toMatchObject({ state: "executing", phase: "dispatched" });
    expect(sessionPosts()).toHaveLength(1);
    const orphan = sessions[0].id;
    // The exact retry: accepted (its own preparation is recognised), the SAME request under the SAME key, Stripe's original session.
    const retry = await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent });
    expect(retry.headers.get(HDR)).toBe("1");
    const [s, b] = await out(retry);
    expect([s, b.error, b.sessionId]).toEqual([200, undefined, orphan]);
    expect(sessionPosts()).toHaveLength(2);
    expect(sessionPosts()[1].key).toBe(sessionPosts()[0].key);
    expect(sessionPosts()[1].form.toString()).toBe(sessionPosts()[0].form.toString());
    expect(sessions.map((x) => x.id)).toEqual([orphan]);
    expect(await env.DB.prepare("SELECT state,session_id FROM open_checkouts WHERE home_id=?").bind(r.homeId).first()).toEqual({ state: "open", session_id: orphan });
    expect(await intentRow(intent)).toMatchObject({ state: "done", phase: "delivered" });
    expect(await env.DB.prepare("SELECT state,session_id FROM checkout_resume_attempts WHERE id=?").bind(`stepup-checkout:${intent}`).first())
      .toEqual({ state: "done", session_id: orphan });
    expect((await out(await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent })))[0]).toBe(410);
    expect(sessionPosts()).toHaveLength(2);
  });

  /** Approved step-up checkout for a fresh account: the account's token, the checkout body, the intent. */
  async function approvedCheckout(sub: string) {
    const u = await account(sub);
    const [rs, r] = await reserve(sub);
    expect(rs).toBe(201);
    await protect(u);
    const tok = await token(sub);
    const body = checkoutBody(r.homeId as string);
    const first = await out(await call("/v1/billing/checkout", tok, body));
    expect(refused(first)).toBe(true);
    const intent = (first[1] as unknown as StepUpBody).step_up.email_code.intent_id;
    await approveByEmail(tok, intent);
    return { tok, body, intent, homeId: r.homeId as string };
  }
  /** /checkout/resume as the member presses it, with its own step-up approval when asked. */
  async function resumeCheckout(tok: string, homeId: string) {
    const resume = await out(await call("/v1/billing/checkout/resume", tok, { homeId }));
    if (!refused(resume)) return resume;
    const again = (resume[1] as unknown as StepUpBody).step_up.email_code.intent_id;
    await approveByEmail(tok, again);
    return out(await call("/v1/billing/checkout/resume", tok, { homeId, stepUpIntentId: again }));
  }
  const attemptOf = (intent: string) => env.DB.prepare("SELECT state,session_id FROM checkout_resume_attempts WHERE id=?").bind(`stepup-checkout:${intent}`).first();

  it("Astra TAXCOUNTRY-3 #6: the step-up replay's 503 (its earlier session not expired yet) is no dead end: the next press of the SAME intent expires that session and issues a fresh one for the same consent on the moved customer", async () => {
    const { tok, body, intent, homeId } = await approvedCheckout("a9300006-0000-4000-8000-000000000001");
    honourKeys = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The batch recording the session never lands: the session exists at Stripe, its attempt is still 'creating'.
    await env.DB.prepare("CREATE TRIGGER stepup_crash BEFORE UPDATE OF state ON open_checkouts WHEN NEW.state='open' BEGIN SELECT RAISE(ABORT, 'injected crash'); END").run();
    try { expect((await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent })).status).toBe(500); }
    finally { await env.DB.prepare("DROP TRIGGER IF EXISTS stepup_crash").run(); }
    const orphan = sessions[0].id, customer = sessions[0].customer;
    // Meanwhile the customer sits on another location (as a pre-fix customer did): that orphan was made off the declared country.
    cust.customers[customer] = { address: { country: "DE", postal_code: "10115", city: "Berlin" } };
    // The same intent's press: the preset moves the home to a new customer, but Stripe fails to expire the orphan this once: 503, nothing handed back.
    expireFails = 1;
    const [s1, b1] = await out(await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent }));
    expect([s1, b1.error]).toEqual([503, "checkout_unavailable"]);
    // Astra TAXCOUNTRY-5: the customer is never re-addressed; the home is moved to a NEW customer at the declared location.
    expect(cust.customers[customer].address).toMatchObject({ country: "DE", city: "Berlin" });
    const moved = (await env.DB.prepare("SELECT customer_id FROM billing_subscriptions WHERE home_id=?").bind(homeId).first<{ customer_id: string }>())!.customer_id;
    expect(moved).not.toBe(customer);
    expect(cust.customers[moved].address).toMatchObject({ country: "US" });
    expect(sessions.find((x) => x.id === orphan)!.status).toBe("open");
    expect(await attemptOf(intent)).toEqual({ state: "creating", session_id: null });
    // The next press of the SAME intent: never checkout_superseded or consent_stale. The orphan is expired first, the attempt closed as
    // relocated, and a fresh session (a new key) is issued and published for the same consent.
    const before = sessionPosts().length;
    const [s2, b2] = await out(await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent }));
    expect([s2, b2.error]).toEqual([200, undefined]);
    expect(b2.sessionId).not.toBe(orphan);
    expect(sessions.find((x) => x.id === orphan)!.status).toBe("expired");
    expect(sessions.find((x) => x.id === b2.sessionId)!.status).toBe("open");
    expect(await attemptOf(intent)).toEqual({ state: "relocated", session_id: orphan });
    expect(sessionPosts().slice(before).map((p) => p.key)).toEqual([sessionPosts()[0].key, expect.stringMatching(/^resume:/)]);
    expect(await env.DB.prepare("SELECT state,session_id FROM open_checkouts WHERE home_id=?").bind(homeId).first()).toEqual({ state: "open", session_id: b2.sessionId });
    expect(await env.DB.prepare("SELECT 1 FROM cloud_ops_state WHERE key=?").bind(`tax_relocated:${homeId}`).first()).toBeNull();
  });

  it("STEPUP-EMAIL-7 #3 / 8 #2: interrupted BEFORE dispatch, resumed past Stripe's creation window: unresolved until its expiry plus the grace, then an actionable 409 asking for fresh consent, never a 502", async () => {
    const { tok, body, intent, homeId } = await approvedCheckout("a7000005-0000-4000-8000-000000000001");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The worker dies right after the attempt is saved, before the session is requested.
    await env.DB.prepare("CREATE TRIGGER stepup_crash BEFORE UPDATE OF phase ON cloud_stepup_intents WHEN NEW.phase='dispatched' BEGIN SELECT RAISE(ABORT, 'injected crash'); END").run();
    let crashed: Response;
    try { crashed = await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent }); }
    finally { await env.DB.prepare("DROP TRIGGER IF EXISTS stepup_crash").run(); }
    expect(crashed.status).toBe(500);
    expect(sessionPosts()).toHaveLength(0);
    expect(await attemptOf(intent)).toEqual({ state: "creating", session_id: null });
    // 45 minutes into the attempt's fixed 60-minute expiry (only 15 minutes left: Stripe would refuse to create it). The attempt's own
    // times are moved, not the clock, so the account's purchase authority is unchanged.
    await env.DB.prepare(`UPDATE checkout_resume_attempts SET expires_at=?, created_at=?, payload=json_set(payload,'$.expiresAtSeconds',?) WHERE id=?`)
      .bind(clock + 15 * 60_000, clock - 45 * 60_000, Math.floor((clock + 15 * 60_000) / 1000), `stepup-checkout:${intent}`).run();
    at(clock + 60_000);
    // Nothing listed yet, and the key's outcome is not proven (Astra STEPUP-EMAIL-8 #2): unresolved, no restart, the attempt kept.
    {
      const [s, b] = await resumeCheckout(tok, homeId);
      expect([s, b.error, b.restart]).toEqual([409, "checkout_in_progress", undefined]);
      expect(await attemptOf(intent)).toEqual({ state: "creating", session_id: null });
    }
    // Its own expiry plus the grace period has passed with nothing listed: proven, abandoned.
    await env.DB.prepare("UPDATE checkout_resume_attempts SET expires_at=? WHERE id=?").bind(clock - 61 * 60_000, `stepup-checkout:${intent}`).run();
    await env.DB.prepare("UPDATE open_checkouts SET updated_at=? WHERE home_id=?").bind(clock - 120_000, homeId).run();
    for (let i = 0; i < 2; i++) {
      at(clock + 31_000); // each press asks for its own emailed code (sent 30 s apart at most)
      const [s, b] = await resumeCheckout(tok, homeId);
      expect([s, b.error]).toEqual([409, "consent_stale"]);
      if (i === 0) expect(b.restart).toBe("checkout");
    }
    // Never dispatched again (the expiry it fixed is too close), under no key; the attempt is closed for good.
    expect(sessionPosts()).toHaveLength(0);
    expect(await attemptOf(intent)).toEqual({ state: "abandoned", session_id: null });
  });

  it("STEPUP-EMAIL-7 #3: a permanent idempotency conflict is reconciled to the original session, or, with none, abandoned (409, fresh consent)", async () => {
    // (a) The session exists (the commit batch failed after Stripe created it); its replay meets a permanent conflict: reconciled.
    {
      const { tok, body, intent, homeId } = await approvedCheckout("a7000003-0000-4000-8000-000000000002");
      honourKeys = true;
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await env.DB.prepare("CREATE TRIGGER stepup_crash BEFORE UPDATE OF state ON open_checkouts WHEN NEW.state='open' BEGIN SELECT RAISE(ABORT, 'injected crash'); END").run();
      try { expect((await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent })).status).toBe(500); }
      finally { await env.DB.prepare("DROP TRIGGER IF EXISTS stepup_crash").run(); }
      const orphan = sessions[0].id;
      createRefusal = { status: 400, code: "idempotency_error" };
      at(clock + 60_000);
      const [s, b] = await resumeCheckout(tok, homeId);
      expect([s, b.error, b.sessionId]).toEqual([200, undefined, orphan]);
      expect(sessions.filter((x) => x.customer === sessions[0].customer).map((x) => x.id)).toEqual([orphan]);
      expect(await attemptOf(intent)).toEqual({ state: "done", session_id: orphan });
      createRefusal = null;
    }
    // (b) No session was ever created (interrupted before dispatch); the replay meets the same permanent refusal: abandoned, no 502.
    {
      const { tok, body, intent, homeId } = await approvedCheckout("a7000004-0000-4000-8000-000000000003");
      await env.DB.prepare("CREATE TRIGGER stepup_crash BEFORE UPDATE OF phase ON cloud_stepup_intents WHEN NEW.phase='dispatched' BEGIN SELECT RAISE(ABORT, 'injected crash'); END").run();
      try { expect((await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent })).status).toBe(500); }
      finally { await env.DB.prepare("DROP TRIGGER IF EXISTS stepup_crash").run(); }
      createRefusal = { status: 400, code: "idempotency_error" };
      const posts = sessionPosts().length;
      at(clock + 60_000);
      const [s, b] = await resumeCheckout(tok, homeId);
      expect([s, b.error, b.restart]).toEqual([409, "consent_stale", "checkout"]);
      // One replay under the original key (refused for good), then nothing more: no substitute key, no loop.
      expect(sessionPosts().slice(posts).map((p) => p.key)).toEqual([`checkout:${(await env.DB.prepare("SELECT consent_id FROM checkout_resume_attempts WHERE id=?").bind(`stepup-checkout:${intent}`).first<{ consent_id: string }>())!.consent_id}`]);
      expect(await attemptOf(intent)).toEqual({ state: "abandoned", session_id: null });
      at(clock + 31_000);
      const [s2, b2] = await resumeCheckout(tok, homeId);
      expect([s2, b2.error]).toEqual([409, "consent_stale"]);
      expect(sessionPosts().length).toBe(posts + 1);
    }
  });

  it("STEPUP-EMAIL-8 #2: a REPLAYED Stripe 500 is indeterminate: with an empty listing the attempt stays creating, no restart; the later webhook resolves it", async () => {
    const { tok, body, intent, homeId } = await approvedCheckout("a8000002-0000-4000-8000-000000000001");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    createRefusal = { status: 500, code: "api_error", replayed: true };
    const [s0, b0] = await out(await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent }));
    expect([s0, b0.error, b0.restart]).toEqual([409, "checkout_in_progress", undefined]);
    expect(await attemptOf(intent)).toEqual({ state: "creating", session_id: null });
    // A later press: the replay under the original key meets the same cached 500, the listing is still empty: still unresolved.
    at(clock + 60_000);
    const [s1, b1] = await resumeCheckout(tok, homeId);
    expect([s1, b1.error, b1.restart]).toEqual([409, "checkout_in_progress", undefined]);
    expect(await attemptOf(intent)).toEqual({ state: "creating", session_id: null });
    const keys = new Set(sessionPosts().map((p) => p.key));
    expect(keys.size).toBe(1);
    // Stripe's incident reconciliation creates the session after all; its webhook (here: expiry) resolves the attempt with it.
    const saved = (await env.DB.prepare("SELECT consent_id,payload FROM checkout_resume_attempts WHERE id=?").bind(`stepup-checkout:${intent}`).first<{ consent_id: string; payload: string }>())!;
    const input = JSON.parse(saved.payload) as { customerId: string; expiresAtSeconds: number };
    sessions.unshift({ id: "cs_late1", status: "expired", customer: input.customerId, subscription: null, expires_at: input.expiresAtSeconds,
      metadata: { home_id: homeId, consent_id: saved.consent_id } });
    createRefusal = null;
    expect((await hook("checkout.session.expired", { object: "checkout.session", id: "cs_late1", mode: "subscription", customer: input.customerId,
      client_reference_id: homeId, expires_at: input.expiresAtSeconds, metadata: { home_id: homeId, plan: "starter", consent_id: saved.consent_id } })).status).toBe(200);
    expect(await attemptOf(intent)).toEqual({ state: "abandoned", session_id: "cs_late1" });
  });

  it("STEPUP-EMAIL-9 #1: the EXACT approved request (its disclosure token included) completes; a refreshed token alone is 403 stepup_request_changed and keeps the approval", async () => {
    const { tok, body, intent, homeId } = await approvedCheckout("a9000001-0000-4000-8000-000000000001");
    // The page fetched a newly timestamped disclosure token after the confirmation; nothing else changed.
    at(clock + 1000);
    const fresh = checkoutBody(homeId);
    expect(fresh.consent.disclosureToken).not.toBe(body.consent.disclosureToken);
    const changed = await call("/v1/billing/checkout", tok, { ...fresh, stepUpIntentId: intent });
    expect(changed.headers.get(HDR)).toBeNull();
    expect(await out(changed)).toEqual([403, { error: "stepup_request_changed", changed: "disclosure_token" }]);
    expect(await intentRow(intent)).toMatchObject({ state: "approved" });
    expect(sessionPosts()).toHaveLength(0);
    // The byte-identical approved request: one session, once.
    const res = await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent });
    expect(res.headers.get(HDR)).toBe("1");
    const [s, b] = await out(res);
    expect([s, b.error]).toEqual([200, undefined]);
    expect(sessionPosts()).toHaveLength(1);
    expect((await out(await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent })))[0]).toBe(410);
    expect(sessionPosts()).toHaveLength(1);
  });

  it("STEPUP-EMAIL-9 #1: token-only mismatches are bounded (3), then the approval is dropped; a real change drops it at once", async () => {
    const { tok, body, intent, homeId } = await approvedCheckout("a9000001-0000-4000-8000-000000000002");
    for (let i = 0; i < 3; i++) {
      at(clock + 1000);
      expect((await out(await call("/v1/billing/checkout", tok, { ...checkoutBody(homeId), stepUpIntentId: intent })))[1].error).toBe("stepup_request_changed");
    }
    at(clock + 1000);
    expect(refused(await out(await call("/v1/billing/checkout", tok, { ...checkoutBody(homeId), stepUpIntentId: intent })))).toBe(true);
    expect(await intentRow(intent)).toBeNull();
    expect((await out(await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent })))[0]).toBe(403); // gone: a fresh refusal
    // Another approval; the purchasing choices change (another plan): not a token-only change, dropped at once.
    at(clock + 31_000);
    const first = await out(await call("/v1/billing/checkout", tok, body));
    const again = (first[1] as unknown as StepUpBody).step_up.email_code.intent_id;
    await approveByEmail(tok, again);
    expect(refused(await out(await call("/v1/billing/checkout", tok, { ...body, plan: "pro", stepUpIntentId: again })))).toBe(true);
    expect(await intentRow(again)).toBeNull();
    expect(sessionPosts()).toHaveLength(0);
  });

  it("STEPUP-EMAIL-9 #2: a fresh approval never replaces the order while an earlier attempt is unresolved; past its expiry plus the grace it is reconciled first", async () => {
    const { tok, body, intent, homeId } = await approvedCheckout("a9000002-0000-4000-8000-000000000001");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    createRefusal = { status: 500, code: "api_error", replayed: true };
    expect((await out(await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent })))[1].error).toBe("checkout_in_progress");
    createRefusal = null;
    const firstKey = sessionPosts()[0].key;
    // A fresh emailed approval 31 seconds later: still 409 checkout_in_progress, no second Stripe operation, the attempt untouched.
    const freshApproval = async () => {
      at(clock + 31_000);
      const r = await out(await call("/v1/billing/checkout", tok, body));
      expect(refused(r)).toBe(true);
      const id = (r[1] as unknown as StepUpBody).step_up.email_code.intent_id;
      await approveByEmail(tok, id);
      return out(await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: id }));
    };
    const [s1, b1] = await freshApproval();
    expect([s1, b1.error]).toEqual([409, "checkout_in_progress"]);
    expect(sessionPosts().map((p) => p.key)).toEqual([firstKey]);
    expect(await attemptOf(intent)).toEqual({ state: "creating", session_id: null });
    // Past its own expiry plus the grace, with nothing listed: reconciled (abandoned) under the lease, then the new order goes on.
    await env.DB.prepare("UPDATE checkout_resume_attempts SET expires_at=? WHERE id=?").bind(clock - 61 * 60_000, `stepup-checkout:${intent}`).run();
    const [s2, b2] = await freshApproval();
    expect([s2, b2.error]).toEqual([200, undefined]);
    expect(await attemptOf(intent)).toEqual({ state: "abandoned", session_id: null });
    expect(sessionPosts().filter((p) => p.key !== firstKey)).toHaveLength(1);
  });

  it("STEPUP-EMAIL-9 #3/#4: a replacement attempt refused for good spends the consent for every later /resume; its replay keeps restart", async () => {
    const sub = "a9000003-0000-4000-8000-000000000001";
    const o = await bought(sub);
    sessions[0].status = "expired";
    await protect(o.userId);
    const tok = await token(sub);
    const first = await out(await call("/v1/billing/checkout/resume", tok, { homeId: o.homeId }));
    expect(refused(first)).toBe(true);
    const intent = (first[1] as unknown as StepUpBody).step_up.email_code.intent_id;
    await approveByEmail(tok, intent);
    at(clock + 60_000); // the replacement's own expiry differs from the lapsed first session's
    createRefusal = { status: 400, code: "idempotency_error" };
    const [s, b] = await out(await call("/v1/billing/checkout/resume", tok, { homeId: o.homeId, stepUpIntentId: intent }));
    expect([s, b.error, b.restart]).toEqual([409, "consent_stale", "checkout"]);
    // #4: its exact replay keeps the fixed restart field (rebuilt from the stored code).
    const replay = await out(await call("/v1/billing/checkout/resume", tok, { homeId: o.homeId, stepUpIntentId: intent }));
    expect([replay[0], replay[1].error, replay[1].restart, replay[1].replayed]).toEqual([409, "consent_stale", "checkout", true]);
    // #3: Stripe would accept now, but the consent is spent: another approved /resume is the same 409, never a new key.
    createRefusal = null;
    const posts = sessionPosts().length;
    at(clock + 31_000);
    const [s2, b2] = await resumeCheckout(tok, o.homeId);
    expect([s2, b2.error, b2.restart]).toEqual([409, "consent_stale", "checkout"]);
    expect(sessionPosts()).toHaveLength(posts);
  });

  it("finding 6: a returning buyer reserves on the sign-in alone (no code), and checkout then asks for the ONE code", async () => {
    const sub = "a9000006-0000-4000-8000-000000000001";
    const u = await account(sub);
    await protect(u);
    const [rs, r] = await reserve(sub);
    expect([rs, r.bootstrap, r.error]).toEqual([201, undefined, undefined]);
    expect(mail).toHaveLength(0);
    expect(await reserve(sub)).toEqual([200, expect.objectContaining({ homeId: r.homeId, existing: true })]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_homes WHERE owner_id=? AND desired_state<>'deleted'").bind(u).first<{ n: number }>())!.n).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_stepup_intents WHERE user_id=?").bind(u).first()).toEqual({ n: 0 });
    expect(refused(await checkout(sub, r.homeId as string))).toBe(true);
    // No session: 401, never a reservation.
    expect((await call("/v1/billing/reserve", "not-a-token", {})).status).toBe(401);
  });

  it("STEPUP-EMAIL-6 #3: the commit batch fails after Stripe's session: a LATER /checkout/resume recovers the same session under the original key", async () => {
    const sub = "a6000003-0000-4000-8000-000000000001";
    const u = await account(sub);
    const [rs, r] = await reserve(sub);
    expect(rs).toBe(201);
    await protect(u);
    const tok = await token(sub);
    const body = checkoutBody(r.homeId as string);
    const first = await out(await call("/v1/billing/checkout", tok, body));
    expect(refused(first)).toBe(true);
    const intent = (first[1] as unknown as StepUpBody).step_up.email_code.intent_id;
    await approveByEmail(tok, intent);
    honourKeys = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await env.DB.prepare("CREATE TRIGGER stepup_crash BEFORE UPDATE OF state ON open_checkouts WHEN NEW.state='open' BEGIN SELECT RAISE(ABORT, 'injected crash'); END").run();
    let crashed: Response;
    try { crashed = await call("/v1/billing/checkout", tok, { ...body, stepUpIntentId: intent }); }
    finally { await env.DB.prepare("DROP TRIGGER IF EXISTS stepup_crash").run(); }
    expect(crashed.status).toBe(500);
    expect(sessionPosts()).toHaveLength(1);
    const orphan = sessions[0].id;
    // Saved BEFORE the dispatch: the price and the original key (the consent itself never got its price: that batch failed).
    const attempt = await env.DB.prepare("SELECT state,stripe_price_id,idempotency_key FROM checkout_resume_attempts WHERE id=?")
      .bind(`stepup-checkout:${intent}`).first<{ state: string; stripe_price_id: string | null; idempotency_key: string | null }>();
    expect(attempt!.state).toBe("creating");
    expect(attempt!.stripe_price_id).toBeTruthy();
    expect(attempt!.idempotency_key).toBe(sessionPosts()[0].key);
    // Later, not the exact retry: the member presses Finish checkout (its own step-up approval; codes are sent 30 s apart at most).
    at(clock + 60_000);
    const resume = await out(await call("/v1/billing/checkout/resume", tok, { homeId: r.homeId }));
    let res: Response;
    if (refused(resume)) {
      const again = (resume[1] as unknown as StepUpBody).step_up.email_code.intent_id;
      await approveByEmail(tok, again);
      res = await call("/v1/billing/checkout/resume", tok, { homeId: r.homeId, stepUpIntentId: again });
    } else {
      expect(resume[0]).toBe(200);
      res = new Response(JSON.stringify(resume[1]), { status: resume[0] });
    }
    const [s, b] = await out(res);
    expect([s, b.error, b.sessionId]).toEqual([200, undefined, orphan]);
    // The SAME request under the SAME key: Stripe's original session, no second one, and no consent_stale.
    expect(sessionPosts()).toHaveLength(2);
    expect(sessionPosts()[1].key).toBe(sessionPosts()[0].key);
    expect(sessionPosts()[1].form.toString()).toBe(sessionPosts()[0].form.toString());
    expect(sessions.map((x) => x.id)).toEqual([orphan]);
    expect(await env.DB.prepare("SELECT state,session_id FROM open_checkouts WHERE home_id=?").bind(r.homeId).first()).toEqual({ state: "open", session_id: orphan });
    expect(await env.DB.prepare("SELECT state,session_id FROM checkout_resume_attempts WHERE id=?").bind(`stepup-checkout:${intent}`).first())
      .toEqual({ state: "done", session_id: orphan });
  });
});

// Astra INTEGRATED-3 #1: an accepted, unpaid checkout whose subscription ENDS before its payment event is processed, on a home the customer
// deleted. Before the fix both paid-event handlers acknowledged `subscription_ended` without journaling the payment, so the deleted home's
// refund obligation (refund:retired:<payment id>) was never created and the customer kept no claim to the money.
describe("INTEGRATED-3 #1: a payment on an already-ended subscription of a deleted, unserved home is journaled before the terminal return", () => {
  const inbox = (homeId: string) => env.DB.prepare("SELECT payload FROM cloud_payment_inbox WHERE home_id=? ORDER BY id").bind(homeId).all<{ payload: string }>()
    .then((r) => r.results.map((x) => JSON.parse(x.payload) as { status: string; paymentId: string }));
  async function reconcileB3() {
    const ctx = createExecutionContext();
    const res = await worker().fetch(new Request("https://admin.murage.test/v1/fake-b3/reconcile", { method: "POST", body: "{}",
      headers: { "content-type": "application/json", authorization: "Bearer test-only-bootstrap-admin", "CF-Connecting-IP": "203.0.113.10" } }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }
  /** Bought, completed UNPAID (accepted, confirmation handed off), then the subscription ended (a webhook or an end) before payment cleared. */
  async function acceptedUnpaidThenEnded(sub: string) {
    const o = await bought(sub);
    expect((await hook("checkout.session.completed", await sessionObj({ ...o, customer: "cus_boot1" }, "unpaid"))).status).toBe(200);
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled',ended_at=? WHERE home_id=?").bind(clock, o.homeId).run();
    expect(await env.DB.prepare("SELECT entitlement FROM cloud_homes WHERE id=?").bind(o.homeId).first()).toEqual({ entitlement: "pending" });
    return o;
  }
  const deleteHome = (homeId: string) => env.DB.prepare("UPDATE cloud_homes SET desired_state='deleting',observed_state='deleting',dns_removed_at=? WHERE id=?")
    .bind(clock - 120_000, homeId).run();

  it("async_payment_succeeded: nothing is journaled for a live home; for a deleting one the payment goes in and B3 owes it back", async () => {
    const o = await acceptedUnpaidThenEnded("60000001-0000-4000-8000-000000000001");
    // Not deleted: the ended subscription starts nothing and journals nothing (record-only, unchanged).
    expect((await hook("checkout.session.async_payment_succeeded", await sessionObj({ ...o, customer: "cus_boot1" }, "paid"))).status).toBe(200);
    expect(await inbox(o.homeId)).toEqual([]);
    // Deleted while its payment was still on its way: the same terminal exit now journals the payment first (before: still nothing).
    await deleteHome(o.homeId);
    expect((await hook("checkout.session.async_payment_succeeded", await sessionObj({ ...o, customer: "cus_boot1" }, "paid"))).status).toBe(200);
    expect(await inbox(o.homeId)).toEqual([expect.objectContaining({ status: "paid", paymentId: "in_boot1" })]);
    expect((await reconcileB3()).status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM cloud_outbox WHERE home_id=? AND kind='refund_required'").bind(o.homeId).all().then((r) => r.results))
      .toEqual([{ id: "refund:retired:in_boot1" }]);
    expect(await getSubStatus(o.homeId)).toBe("canceled");                     // nothing restarted the ended subscription
  });

  it("invoice.paid: the payment facts are recorded AND the deleting home's payment is journaled; a replay adds no second obligation", async () => {
    const o = await acceptedUnpaidThenEnded("60000002-0000-4000-8000-000000000001");
    await deleteHome(o.homeId);
    at(T0 + MIN);
    const inv = { object: "invoice", id: "in_boot1", customer: "cus_boot1", subscription: "sub_boot1", billing_reason: "subscription_create", amount_paid: 4900,
      payment_intent: "pi_boot", lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: { start: T0 / 1000, end: T0 / 1000 + 30 * 86400 } }] } };
    expect((await hook("invoice.paid", inv)).status).toBe(200);
    expect(await inbox(o.homeId)).toEqual([expect.objectContaining({ status: "paid", paymentId: "in_boot1" })]);
    expect((await reconcileB3()).status).toBe(200);
    expect((await hook("invoice.paid", inv)).status).toBe(200);
    expect((await reconcileB3()).status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM cloud_outbox WHERE home_id=? AND kind='refund_required'").bind(o.homeId).all().then((r) => r.results))
      .toEqual([{ id: "refund:retired:in_boot1" }]);
    expect(await getSubStatus(o.homeId)).toBe("canceled");
  });
});
// Astra INTEGRATED-4 #1/#2: whether a deleted, never-served home's payment is still owed back is decided per INVOICE (invoiceRefundCoverage),
// on every paid-event exit. #1: a completed refund of an EARLIER invoice that ended the plan made a later, different payment return
// plan_ended unjournaled. #2: any refund row (a $1 external refund) on the invoice suppressed the remaining $48 obligation.
describe("INTEGRATED-4 #1/#2: a retired home's payment is judged on its own invoice: covered in full, or its remainder journaled once", () => {
  const inbox = (homeId: string) => env.DB.prepare("SELECT payload FROM cloud_payment_inbox WHERE home_id=? ORDER BY id").bind(homeId).all<{ payload: string }>()
    .then((r) => r.results.map((x) => JSON.parse(x.payload) as { status: string; paymentId: string }));
  const obligations = (homeId: string) => env.DB.prepare("SELECT id FROM cloud_outbox WHERE home_id=? AND kind='refund_required' ORDER BY id").bind(homeId).all()
    .then((r) => r.results);
  async function reconcileB3() {
    const ctx = createExecutionContext();
    const res = await worker().fetch(new Request("https://admin.murage.test/v1/fake-b3/reconcile", { method: "POST", body: "{}",
      headers: { "content-type": "application/json", authorization: "Bearer test-only-bootstrap-admin", "CF-Connecting-IP": "203.0.113.10" } }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
  }
  /** Bought, completed unpaid, its subscription ended, then deleted by the customer (never paid, never served: entitlement 'pending'). */
  async function retired(sub: string) {
    const o = await bought(sub);
    expect((await hook("checkout.session.completed", await sessionObj({ ...o, customer: "cus_boot1" }, "unpaid"))).status).toBe(200);
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled',ended_at=? WHERE home_id=?").bind(clock, o.homeId).run();
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleting',observed_state='deleting',dns_removed_at=? WHERE id=?").bind(clock - 120_000, o.homeId).run();
    at(T0 + MIN);
    return o;
  }
  /** A decided, completed refund of `invoiceId` (`kind` no_capacity ends the plan; external is a refund made outside the ledger). */
  async function refunded(o: { homeId: string; userId: string }, id: string, kind: string, invoiceId: string, cents: number, endPlan: number) {
    await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,invoice_id,paid_cents,target_cents,amount_cents,basis,end_plan,subscription_id,decided_at,
      refunded_at,done_at,refund_status,created_at,updated_at) VALUES (?,?,?,?,?,4900,?,?,?,?,'sub_boot1',?,?,?,'succeeded',?,?)`)
      .bind(id, kind, o.homeId, o.userId, invoiceId, cents, cents, kind, endPlan, clock, clock, clock, clock, clock).run();
    await env.DB.prepare("INSERT OR IGNORE INTO refund_invoice_ledger (invoice_id,version,decided_cents) VALUES (?,0,0)").bind(invoiceId).run();
    await env.DB.prepare("UPDATE refund_invoice_ledger SET version=version+1,decided_cents=decided_cents+? WHERE invoice_id=?").bind(cents, invoiceId).run();
  }
  const invoice = (id: string, reason = "subscription_create") => ({ object: "invoice", id, customer: "cus_boot1", subscription: "sub_boot1", billing_reason: reason,
    amount_paid: 4900, payment_intent: `pi_${id}`, lines: { data: [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, period: { start: T0 / 1000, end: T0 / 1000 + 30 * 86400 } }] } });

  it("#1 an earlier invoice's completed refund (it ended the plan) never covers a later, different payment: that one is journaled", async () => {
    const o = await retired("70000001-0000-4000-8000-000000000001");
    await refunded(o, "no_capacity:in_old", "no_capacity", "in_old", 4900, 1);
    expect((await hook("invoice.paid", invoice("in_later", "subscription_cycle"))).status).toBe(200);
    // before the fix: [] (returned plan_ended before the journal, and the event was acknowledged)
    expect(await inbox(o.homeId)).toEqual([expect.objectContaining({ status: "paid", paymentId: "in_later" })]);
    await reconcileB3();
    expect(await obligations(o.homeId)).toEqual([{ id: "refund:retired:in_later" }]);
    // A replay adds no second entry: the obligation is on record.
    expect((await hook("invoice.paid", invoice("in_later", "subscription_cycle"))).status).toBe(200);
    await reconcileB3();
    expect(await inbox(o.homeId)).toHaveLength(1);
    expect(await obligations(o.homeId)).toEqual([{ id: "refund:retired:in_later" }]);
  });
  it("#2 a partial ($1) refund on record leaves the $48 remainder owed: journaled once; a replayed event adds nothing", async () => {
    const o = await retired("70000002-0000-4000-8000-000000000001");
    await refunded(o, "external:re_part", "external", "in_boot1", 100, 0);
    expect(await invoiceRefundCoverage(env, "in_boot1", 4900)).toEqual({ paidCents: 4900, refundedCents: 100, obligationRecorded: false, outstandingCents: 4800 });
    expect((await hook("invoice.paid", invoice("in_boot1"))).status).toBe(200);
    expect(await inbox(o.homeId)).toEqual([expect.objectContaining({ status: "paid", paymentId: "in_boot1" })]);   // before the fix: []
    await reconcileB3();
    expect((await hook("invoice.paid", invoice("in_boot1"))).status).toBe(200);
    await reconcileB3();
    expect(await inbox(o.homeId)).toHaveLength(1);
    expect(await obligations(o.homeId)).toEqual([{ id: "refund:retired:in_boot1" }]);
    expect((await invoiceRefundCoverage(env, "in_boot1", 4900)).obligationRecorded).toBe(true);
  });
  it("a refund covering the whole payment: nothing is journaled, nothing owed", async () => {
    const o = await retired("70000003-0000-4000-8000-000000000001");
    await refunded(o, "external:re_full", "external", "in_boot1", 4900, 0);
    expect((await hook("invoice.paid", invoice("in_boot1"))).status).toBe(200);
    await reconcileB3();
    expect(await inbox(o.homeId)).toEqual([]);
    expect(await obligations(o.homeId)).toEqual([]);
  });
  it("a served home stays record-only: neither an ended plan's later payment nor its own invoice is journaled", async () => {
    const o = await retired("70000004-0000-4000-8000-000000000001");
    await env.DB.prepare("UPDATE cloud_homes SET entitlement='paid' WHERE id=?").bind(o.homeId).run();
    await refunded(o, "no_capacity:in_old", "no_capacity", "in_old", 4900, 1);
    expect((await hook("invoice.paid", invoice("in_later", "subscription_cycle"))).status).toBe(200);
    await env.DB.prepare("DELETE FROM refund_ops WHERE id='no_capacity:in_old'").run();
    expect((await hook("invoice.paid", invoice("in_boot1"))).status).toBe(200);
    expect(await inbox(o.homeId)).toEqual([]);
  });
});
const getSubStatus = (homeId: string) => env.DB.prepare("SELECT status FROM billing_subscriptions WHERE home_id=?").bind(homeId).first<{ status: string }>().then((r) => r!.status);
