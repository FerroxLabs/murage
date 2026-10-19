// SPDX-License-Identifier: AGPL-3.0-or-later
// Members-area routes (src/members-api.ts): order reconciliation, deletion receipt, Finish checkout, plan change and the resize job.
// Real workerd + D1, real-shaped Supabase tokens (ES256 JWKS), Stripe and build host as injected fakes. No network.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { fakeProvider } from "../src/b3-provider";
import { sweepBilling, sweepTaxDispatches, TAX_DISPATCH_INFLIGHT_MS, type BillingNotifier } from "../src/b5-billing";
import { fence, withHomeLease } from "../src/billing-lease";
import { signStripePayload, stripeClient } from "../src/b5-stripe";
import { currentVersions, SCREEN_VERSION } from "../src/legal-flows";
import { stripePageOf } from "../src/checkout-strings";
import { checkoutLocale } from "../src/checkout-policy";
import { SUBMIT_TEXT_VARIANT } from "../src/seller";
import { deletionNoticeData, ResizeHostError, sweepPlanResizes, type MembersDependencies, type ResizeHost } from "../src/members-api";
import { customerFake } from "./stripe-customer-fake";

const REF_ORIGIN = "https://testref.supabase.co";
const ISS = `${REF_ORIGIN}/auth/v1`;
const NOW = 1_790_000_000_000; // identity clock (token iat/exp/amr)
const nowS = Math.floor(NOW / 1000);
const T = Date.now(); // billing clock
const SUB_A = "5f0c1b2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
const SUB_B = "6a1d2c3f-4b5e-4f60-9b0c-1d2e3f4a5b6c";
const WHSEC = "whsec_testonlyfixturesecret0123456789";
const PRICES = { STRIPE_PRICE_STARTER: "price_starter0001", STRIPE_PRICE_PRO: "price_pro00000001", STRIPE_PRICE_MAX: "price_max000000001" };
const B3 = { reservationMs: 30 * 60_000, graceMs: 3 * 86_400_000, retentionMs: 14 * 86_400_000, imageDigest: `sha256:${"a".repeat(64)}`, quarantineRelayIP: "192.0.2.20",
  engineSubscriptionGates: { claudeAgent: true, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: true },
  capacity: [{ id: "slot-1", projectId: "p1", location: "fsn1", serverType: "cx23", outcome: "available" }] };
let planFlag = "1";
let envOver: Record<string, string> = {};
const testEnv = (): Env => ({ ...env, CLOUD_PLAN_CHANGE: planFlag, SUPABASE_URL: REF_ORIGIN, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_testkey_0123456789abcdef", MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined,
  CLOUD_ADMIN_TOKEN: "test-only-members-admin", CLOUD_KEK_V1: btoa("x".repeat(32)), CLOUD_B3_MODE: "fake", CLOUD_B3_CONFIG: JSON.stringify(B3),
  STRIPE_SECRET_KEY: "sk_test_fixturefixturefixture", STRIPE_WEBHOOK_SECRET: WHSEC, BILLING_RETURN_ORIGIN: "https://murage.test", ...PRICES, ...envOver } as unknown as Env);

// ---- Supabase tokens ----
/** The member's trusted second factor (makerkit-auth: step-up needs a factor trusted here and still verified at Supabase). */
const FACTOR = "7d3e0c1a-1111-4222-8333-944455566677";
const subOf = (tok: string) => (JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()) as { sub: string; aal: string; email: string });
const authFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const claims = subOf(String(new Headers(init?.headers).get("authorization")).replace(/^Bearer /, ""));
  return Response.json({ id: claims.sub, email: claims.email, email_confirmed_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    factors: [{ id: FACTOR, factor_type: "totp", status: "verified" }] });
}) as typeof fetch;
const b64u = (b: ArrayBuffer | string) => Buffer.from(typeof b === "string" ? Buffer.from(b) : new Uint8Array(b)).toString("base64url");
let ec: CryptoKeyPair;
let jwks: { keys: Record<string, unknown>[] };
const jwksFetch = (async (input: RequestInfo | URL) => String(input) === `${ISS}/.well-known/jwks.json` ? Response.json(jwks) : new Response("no", { status: 404 })) as typeof fetch;
beforeAll(async () => {
  ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", ec.publicKey)), kid: "ec-1", alg: "ES256", use: "sig" }] };
});
async function token(sub: string, fresh: boolean) {
  const c = { iss: ISS, aud: "authenticated", exp: nowS + 3600, iat: nowS - 5, sub, email: `${sub.slice(0, 4)}@example.test`, role: "authenticated",
    app_metadata: { provider: "email", email_verified: true }, user_metadata: {}, is_anonymous: false, session_id: "0b1c2d3e-aaaa-4bbb-8ccc-123456789abc",
    aal: fresh ? "aal2" : "aal1", amr: fresh ? [{ method: "totp", timestamp: nowS - 30 }] : [{ method: "password", timestamp: nowS - 60 }],
    ...(fresh ? { mfa_factor_id: FACTOR } : {}) };
  const input = `${b64u(JSON.stringify({ alg: "ES256", kid: "ec-1", typ: "JWT" }))}.${b64u(JSON.stringify(c))}`;
  return `${input}.${b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, new TextEncoder().encode(input)))}`;
}

// ---- Stripe fake ----
interface Call { method: string; path: string; form: URLSearchParams; key: string | null }
let calls: Call[];
let sessionStatus: string;
let previewAmount: number;
let livePrice: string;
let liveCancelAt: number | null = null; // Stripe's cancel_at on sub_1 (Unix seconds)
let portalUpdates: boolean | undefined;
let retrieveFails: number;
/** Every checkout session Stripe lists for the customer (the replacement attempt's own order, when a test plants it). */
let listed: Record<string, unknown>[] = [];
let upgradeInvoice: string;
let priceAmount: number;
let linePages: Record<string, { data: unknown[] } | "fail">;
let portalId: string | undefined;
/** Astra TAXCOUNTRY-2 P2: Stripe answers the session POST from its idempotency cache (a session an EARLIER request made). */
let sessionReplayed = false;
/** Astra TAXCOUNTRY-3: Stripe fails to expire a session this many times (500). */
let expireFails = 0;
/** Astra TAXCOUNTRY-4: sessions kept as Stripe keeps them (created ones listed as open; expire turns an open one expired and is refused for a
 *  complete one; retrieve reads the listed state). Stripe documents that an expired session can no longer be completed (payStripePage). */
let trackSessions = false;
/** Fail the Nth session creation from now (1-based, 0 = never) with a 500 (a crash in the middle of a flow). */
let failCreateAt = 0;
let createN = 0;
const cust = customerFake();
const stripeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  calls.push({ method, path: url.pathname, form: new URLSearchParams(String(init?.body ?? "")), key: new Headers(init?.headers).get("idempotency-key") });
  const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s });
  const cr = await cust.handle(method, url, new URLSearchParams(String(init?.body ?? "")), new Headers(init?.headers).get("idempotency-key")); // the customer preset (persisted; Astra TAXCOUNTRY-1)
  if (cr) return cr;
  if (url.pathname === "/v1/checkout/sessions" && method === "GET") return j({ data: listed });
  if (url.pathname === "/v1/checkout/sessions") {
    if (failCreateAt && ++createN === failCreateAt) { failCreateAt = 0; return j({ error: { code: "api_error" } }, 500); }
    if (trackSessions && !listed.some((x) => x.id === "cs_test_new")) {
      const f = new URLSearchParams(String(init?.body ?? ""));
      listed.unshift({ id: "cs_test_new", url: "https://checkout.stripe.test/c/cs_test_new", status: "open", subscription: null,
        metadata: { consent_id: f.get("metadata[consent_id]"), home_id: f.get("metadata[home_id]") } });
    }
    const replayed = sessionReplayed; sessionReplayed = false; // one answer from the cache, then a fresh session
    return new Response(JSON.stringify({ id: "cs_test_new", url: "https://checkout.stripe.test/c/cs_test_new" }),
      { status: 200, headers: replayed ? { "idempotent-replayed": "true" } : {} });
  }
  if (url.pathname.startsWith("/v1/checkout/sessions/") && url.pathname.endsWith("/expire")) {
    if (expireFails > 0) { expireFails--; return j({ error: { code: "api_error" } }, 500); }
    if (trackSessions) {
      const t = listed.find((x) => x.id === url.pathname.split("/")[4]);
      if (t?.status === "complete") return j({ error: { type: "invalid_request_error", message: "This Checkout Session is already complete." } }, 400);
      if (t) t.status = "expired";
    }
    return j({ id: "x", status: "expired" });
  }
  if (url.pathname.startsWith("/v1/checkout/sessions/") && trackSessions) {
    const t = listed.find((x) => x.id === url.pathname.split("/").pop());
    if (t) return j({ ...t, customer: "cus_1" });
  }
  if (url.pathname.startsWith("/v1/checkout/sessions/")) {
    if (retrieveFails > 0) { retrieveFails--; return j({ error: { code: "api_error" } }, 500); }
    return j({ id: url.pathname.split("/").pop(), status: sessionStatus });
  }
  const period = { current_period_start: Math.floor(T / 1000) - 86_400, current_period_end: Math.floor(T / 1000) + 20 * 86_400 };
  if (url.pathname === "/v1/subscriptions/sub_1" && method === "GET") {
    return j({ id: "sub_1", status: "active", cancel_at_period_end: false, cancel_at: liveCancelAt, pending_update: null, items: { data: [{ id: "si_1", price: { id: livePrice }, ...period }] } });
  }
  if (url.pathname === "/v1/subscriptions/sub_1") return j({ id: "sub_1", latest_invoice: upgradeInvoice, pending_update: { expires_at: 1 } });
  if (url.pathname === "/v1/invoices/create_preview") return j({ amount_due: previewAmount, currency: "usd" });
  if (url.pathname.endsWith("/void")) return j({ id: "in_up_9", status: "void" });
  if (/^\/v1\/invoices\/[^/]+\/lines$/.test(url.pathname)) {
    const page = linePages[url.pathname.split("/")[3]];
    return !page || page === "fail" ? j({ error: { code: "api_error" } }, 500) : j({ ...page, has_more: false });
  }
  if (url.pathname.startsWith("/v1/invoices/")) return j({ id: url.pathname.split("/")[3], status: "open", lines: { data: [] } });
  if (url.pathname.startsWith("/v1/billing_portal/configurations")) return j({ data: [{ id: portalId, features: { subscription_update: { enabled: portalUpdates } } }] });
  if (url.pathname.startsWith("/v1/prices/")) return j({ id: url.pathname.split("/")[3], active: true, unit_amount: priceAmount, currency: "usd", recurring: { interval: "month", interval_count: 1 } });
  if (url.pathname === "/v1/billing_portal/sessions") return j({ url: "https://billing.stripe.test/p/1" });
  return j({ error: { code: "unexpected" } }, 500);
};
const notices: { kind: string; data: Record<string, unknown> }[] = [];
const notifier: BillingNotifier = { async notify(_e, n) { notices.push({ kind: n.kind, data: n.data }); } };
const deps = (): MembersDependencies => ({ stripeFetch, notifier, now: () => T });
const worker = (extra: Partial<MembersDependencies> = {}) => createWorker(fetch, fetch, {}, {}, { ...deps(), ...extra }, { jwksFetch, authFetch, now: () => NOW });

/** A fresh-token caller has the trusted factor its token names (the account is created by a plain request first if it does not exist yet). */
async function trustFactorFor(tok: string) {
  const c = subOf(tok);
  if (c.aal !== "aal2") return;
  let row = await env.DB.prepare("SELECT user_id FROM supabase_identities WHERE sub=?").bind(c.sub).first<{ user_id: string }>();
  if (!row) {
    const ctx = createExecutionContext();
    await worker().fetch(new Request("https://auth.murage.test/v1/account/terms", { headers: { authorization: `Bearer ${tok}` } }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    row = await env.DB.prepare("SELECT user_id FROM supabase_identities WHERE sub=?").bind(c.sub).first<{ user_id: string }>();
  }
  if (!row) return;
  await env.DB.prepare("INSERT OR IGNORE INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state) VALUES (?,?,'totp','email_code',0,0,'active')")
    .bind(row.user_id, FACTOR).run();
}
async function call(path: string, tok: string | null, body?: unknown) {
  const headers = new Headers();
  if (tok) headers.set("authorization", `Bearer ${tok}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (tok) await trustFactorFor(tok);
  const ctx = createExecutionContext();
  const res = await worker().fetch(new Request(`https://auth.murage.test${path}`, { method: body === undefined ? "GET" : "POST", headers,
    body: body === undefined ? undefined : JSON.stringify(body) }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
async function webhook(event: unknown, extra: Partial<MembersDependencies> = {}) {
  const raw = JSON.stringify(event);
  const ctx = createExecutionContext();
  const res = await worker(extra).fetch(new Request("https://auth.murage.test/v1/billing/webhook", { method: "POST", body: raw,
    headers: { "content-type": "application/json", "stripe-signature": await signStripePayload(raw, WHSEC, Math.floor(T / 1000)) } }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// ---- Seeds ----
/** Signs the member in once (creates their account) and returns their control-plane user id. */
async function userOf(sub: string): Promise<string> {
  expect((await call("/v1/account/terms", await token(sub, false))).status).toBe(200);
  return (await env.DB.prepare("SELECT user_id FROM supabase_identities WHERE sub=?").bind(sub).first<{ user_id: string }>())!.user_id;
}
let homeN = 0;
async function home(owner: string, state: string, entitlement = "pending", id = `home-m${++homeN}`) {
  await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,entitlement,image_digest,home_key,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(id, `inst-${id}`, owner, state, state, entitlement, B3.imageDigest, "k", T - 1000, T - 1000).run();
  return id;
}
async function consent(homeId: string, userId: string, o: Record<string, unknown> = {}) {
  const v = currentVersions();
  const row: Record<string, unknown> = { id: `consent-${homeId}`, home_id: homeId, user_id: userId, email: null, created_at: T - 60_000, screen_version: SCREEN_VERSION,
    cloud_terms_version: v.cloudTerms, tos_version: v.termsOfService, privacy_version: v.privacyPolicy, terms_accepted: 1, recurring_authorized: 1,
    early_start: 0, eu_region: 0, topup_enabled: 0, renewal_text: "Renews monthly.", wording: "w", billing_country: "US", plan: "starter",
    price_cents: 4900, start_at: T - 60_000, first_charge_at: T - 60_000, delayed_start: 0, tax_source: "stripe_tax", quoted_total_cents: 5300,
    quote_id: `quote-${homeId}`, stripe_price_id: PRICES.STRIPE_PRICE_STARTER,
    // the Stripe page archived at issuance, as prepareConsent writes it (a reissue must show exactly this page)
    disclosure: JSON.stringify({ stripePage: { ...stripePageOf("direct", "starter", checkoutLocale("US", null), SUBMIT_TEXT_VARIANT), authorization: "clickwrap_consent_record" } }), ...o };
  const cols = Object.keys(row);
  await env.DB.prepare(`INSERT INTO checkout_consents (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...cols.map((c) => row[c])).run();
  return row.id as string;
}
/** The tax quote a consent was priced with (still unexpired: createTaxQuote reuses it as the current total at that address). */
async function taxQuote(id: string, userId: string, total: number) {
  await env.DB.prepare(`INSERT INTO tax_quotes (id,user_id,plan,country,postal_code,price_cents,tax_cents,total_cents,topup_amount_cents,source,created_at,expires_at)
    VALUES (?,?,'starter','US',NULL,4900,400,?,2000,'stripe_tax',?,?)`).bind(id, userId, total, T - 60_000, T + 3_600_000).run();
}
async function subscription(homeId: string, o: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = { home_id: homeId, customer_id: "cus_1", plan: "starter", created_at: T, updated_at: T, ...o };
  const cols = Object.keys(row);
  await env.DB.prepare(`INSERT INTO billing_subscriptions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...cols.map((c) => row[c])).run();
}
async function openCheckout(homeId: string, consentId: string, state: string, expiresAt: number | null, sessionId: string | null = "cs_test_old") {
  await env.DB.prepare(`INSERT INTO open_checkouts (home_id,consent_id,fingerprint,state,session_id,session_url,expires_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).bind(homeId, consentId, "fp", state, sessionId, sessionId ? `https://checkout.stripe.test/c/${sessionId}` : null, expiresAt, T - 120_000, T - 120_000).run();
}

// The home's customer at the default consent's declared location (US): a customer elsewhere is moved to a NEW customer by the preset
// (Astra TAXCOUNTRY-5), which the TAXCOUNTRY tests below set up on purpose; every other test keeps the one customer it seeds.
beforeEach(() => { calls = []; cust.reset(); cust.customers.cus_1 = { address: { country: "US" } }; liveCancelAt = null; sessionStatus = "open"; previewAmount = 1234; notices.length = 0; planFlag = "1"; livePrice = PRICES.STRIPE_PRICE_STARTER;
  portalUpdates = false; retrieveFails = 0; listed = []; upgradeInvoice = "in_up_1"; priceAmount = 4900; portalId = "bpc_1"; envOver = {}; linePages = {}; sessionReplayed = false; expireFails = 0;
  trackSessions = false; failCreateAt = 0; createN = 0; });
afterEach(async () => {
  await env.DB.batch(["plan_changes", "plan_resizes", "plan_quotes", "backup_subaccounts", "checkout_resume_attempts"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe("auth on every members route", () => {
  it("answers 401 without a token, before any body or configuration check", async () => {
    for (const [path, body] of [["/v1/account/order?home=x", undefined], ["/v1/account/deletion", undefined], ["/v1/account/plan", undefined],
      ["/v1/billing/checkout/resume", {}], ["/v1/account/plan/preview", { plan: "pro" }], ["/v1/account/plan", { plan: "pro", expectedAmountCents: 1 }],
      ["/v1/account/plan/preview", "not an object"]] as const) {
      expect([path, (await call(path, null, body)).status]).toEqual([path, 401]);
    }
  });

  it("refuses money routes without a fresh second step (403 step_up_required with the step_up body)", async () => {
    await userOf(SUB_A);
    for (const [path, body] of [["/v1/billing/checkout/resume", {}], ["/v1/account/plan", { plan: "pro", expectedAmountCents: 1 }],
      ["/v1/account/export-request", {}]] as const) {
      const res = await call(path, await token(SUB_A, false), body);
      expect([path, res.status, (await res.json<{ error: string; step_up?: { reason: string } }>()).step_up?.reason]).toEqual([path, 403, "aal1"]);
    }
  });

  it("lets a fresh step-up export its data (SPEC §5 item 8)", async () => {
    const a = await userOf(SUB_A);
    await home(a, "ready", "paid");
    expect((await call("/v1/account/export-request", await token(SUB_A, true), {})).status).toBe(201);
  });
});

describe("GET /v1/account/order", () => {
  it("is the caller's own: another member's home or session is 404", async () => {
    const a = await userOf(SUB_A); await userOf(SUB_B);
    const h = await home(a, "payment_pending");
    const c = await consent(h, a, { stripe_session_id: "cs_test_a" });
    await openCheckout(h, c, "open", T + 3_600_000, "cs_test_a");
    const b = await token(SUB_B, false);
    expect((await call(`/v1/account/order?home=${h}`, b)).status).toBe(404);
    expect((await call("/v1/account/order?session=cs_test_a", b)).status).toBe(404);
    expect((await call("/v1/account/order", b)).status).toBe(400);
    const mine = await call("/v1/account/order?session=cs_test_a", await token(SUB_A, false));
    expect(await mine.json()).toMatchObject({ homeId: h, sessionId: "cs_test_a", status: "pending", reason: "awaiting_payment" });
  });

  it("says pending until the signed webhook records the payment, whatever the URL says", async () => {
    const a = await userOf(SUB_A);
    const h = await home(a, "payment_pending");
    const c = await consent(h, a, { stripe_session_id: "cs_test_a", completed_at: T - 1000, stripe_subscription_id: "sub_a" });
    await openCheckout(h, c, "completed", T + 3_600_000, "cs_test_a");
    await subscription(h, { subscription_id: "sub_a", status: "incomplete", consent_id: c });
    const tok = await token(SUB_A, false);
    expect(await (await call(`/v1/account/order?home=${h}&notice=paid&status=paid`, tok)).json()).toMatchObject({ status: "pending", reason: "processing" });
    await env.DB.prepare("UPDATE billing_subscriptions SET status='active',first_paid_at=? WHERE home_id=?").bind(T, h).run();
    expect(await (await call(`/v1/account/order?home=${h}`, tok)).json()).toMatchObject({ status: "paid", charged: true });
  });

  it("reports failed for an expired or repriced checkout, and refund_pending then refund_sent from the ledger", async () => {
    const a = await userOf(SUB_A);
    const tok = await token(SUB_A, false);
    const h1 = await home(a, "payment_pending");
    const c1 = await consent(h1, a);
    await openCheckout(h1, c1, "open", T - 1000);
    expect(await (await call(`/v1/account/order?home=${h1}`, tok)).json()).toMatchObject({ status: "failed", reason: "expired" });
    await env.DB.prepare("UPDATE checkout_consents SET price_mismatch_at=? WHERE id=?").bind(T, c1).run();
    expect(await (await call(`/v1/account/order?home=${h1}`, tok)).json()).toMatchObject({ status: "failed", reason: "repriced" });

    await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleted' WHERE id=?").bind(h1).run();
    const h2 = await home(a, "payment_pending");
    const c2 = await consent(h2, a, { completed_at: T, stripe_subscription_id: "sub_r" });
    await subscription(h2, { subscription_id: "sub_r", status: "canceled", consent_id: c2 });
    await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,paid_cents,target_cents,end_plan,subscription_id,created_at,updated_at)
      VALUES ('price_mismatch:x','price_mismatch',?,?,2000,2000,0,'sub_r',?,?)`).bind(h2, a, T, T).run();
    expect(await (await call(`/v1/account/order?home=${h2}`, tok)).json()).toMatchObject({ status: "refund_pending", refund: { amountCents: 2000, refundedAt: null } });
    await env.DB.prepare("UPDATE refund_ops SET refunded_at=? WHERE id='price_mismatch:x'").bind(T + 5).run();
    expect(await (await call(`/v1/account/order?home=${h2}`, tok)).json()).toMatchObject({ status: "refund_sent", refund: { amountCents: 2000, refundedAt: T + 5 } });
  });
});

describe("deletion receipt", () => {
  it("tells deleted from never-had, with dates and the backup purge date, and only to the owner", async () => {
    const a = await userOf(SUB_A); await userOf(SUB_B);
    const tokA = await token(SUB_A, false);
    expect(await (await call("/v1/account/deletion", tokA)).json()).toEqual({ deletion: null, hasLiveHome: false });
    const h = await home(a, "deleting", "paid");
    await env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES ('o1',?,2,?,'retention_ended','{}',?)`).bind(h, a, T - 5000).run();
    expect(await (await call("/v1/account/deletion", tokA)).json()).toMatchObject({ deletion: { homeId: h, status: "deleting", reason: "plan_ended",
      startedAt: T - 5000, deletedAt: null, backupsPurgedAt: null } });
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleted' WHERE id=?").bind(h).run();
    await env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES ('o2',?,3,?,'deleted','{}',?)`).bind(h, a, T - 1000).run();
    await env.DB.prepare(`INSERT INTO backup_subaccounts (home_id,resource_generation,box_id,subaccount_id,username,server,directory,created_at,deleted_at)
      VALUES (?,1,1,'s','u','srv','d',?,?)`).bind(h, T - 9e6, T - 1500).run();
    const body = await (await call("/v1/account/deletion", tokA)).json<{ deletion: Record<string, unknown> }>();
    expect(body.deletion).toMatchObject({ status: "deleted", deletedAt: T - 1000, backupsPurgedAt: T - 1000, emailSentAt: null });
    expect((body.deletion.deleted as string[]).join(" ")).toContain("every backup and snapshot");
    expect(await (await call("/v1/account/deletion", await token(SUB_B, false))).json()).toEqual({ deletion: null, hasLiveHome: false });
  });

  it("sends a durable email saying what was deleted, when, and the backup purge date (billing_notices outbox)", async () => {
    const a = await userOf(SUB_A);
    const h = await home(a, "deleted", "paid");
    await env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES ('o3',?,3,?,'deleted','{}',?)`).bind(h, a, Date.UTC(2026, 9, 1, 12, 30)).run();
    await env.DB.prepare(`INSERT INTO backup_subaccounts (home_id,resource_generation,box_id,subaccount_id,username,server,directory,created_at,deleted_at)
      VALUES (?,1,1,'s','u','srv','d',?,?)`).bind(h, T - 9e6, Date.UTC(2026, 9, 1, 12, 29)).run();
    const data = await deletionNoticeData(env, h, T);
    expect(data.emailText).toContain("deleted on 2026-10-01 12:30 UTC");
    expect(data.emailText).toContain("purged by 2026-10-01");
    expect(data.emailText).toContain("invoices, billing and tax records");
    await sweepBilling(testEnv(), { notifier, stripeFetch, now: () => T });
    const sent = notices.filter((n) => n.kind === "deleted");
    expect(sent).toHaveLength(1);
    expect(String(sent[0].data.emailText)).toContain("Your Murage Cloud was deleted on 2026-10-01 12:30 UTC");
  });
});

describe("POST /v1/billing/checkout/resume (Finish checkout)", () => {
  async function reserved(o: { expiresAt: number | null; consent?: Record<string, unknown>; state?: string }) {
    const a = await userOf(SUB_A);
    const h = await home(a, "payment_pending");
    const c = await consent(h, a, o.consent);
    await taxQuote(`quote-${h}`, a, 5300);
    await subscription(h, { status: "checkout_created", consent_id: c });
    await openCheckout(h, c, o.state ?? "open", o.expiresAt);
    // The customer already at the consent's declared location (the required preset then writes nothing; Astra TAXCOUNTRY-2 P2).
    cust.customers.cus_1 = { address: { country: String(o.consent?.billing_country ?? "US"), postal_code: (o.consent?.postal_code as string | undefined) ?? null } };
    return { a, h, c };
  }

  it("returns the open, unexpired session without a new reserve or session", async () => {
    await reserved({ expiresAt: T + 30 * 60_000 });
    const res = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
    expect([res.status, await res.json()]).toEqual([200, expect.objectContaining({ sessionId: "cs_test_old", reused: true })]);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("says checkout_completed when Stripe already completed it (webhook on its way)", async () => {
    await reserved({ expiresAt: T + 30 * 60_000 });
    sessionStatus = "complete";
    const res = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
    expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([409, "checkout_completed"]);
  });

  it("makes one fresh session for the SAME reservation and consent once the old one expired, idempotently", async () => {
    const { h, c } = await reserved({ expiresAt: T - 1000 });
    const res = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
    expect([res.status, await res.json()]).toEqual([200, { sessionId: "cs_test_new", url: "https://checkout.stripe.test/c/cs_test_new", consentId: c, reused: false }]);
    const create = calls.find((x) => x.method === "POST" && x.path === "/v1/checkout/sessions")!;
    const attempt = await env.DB.prepare("SELECT id,state,session_id FROM checkout_resume_attempts WHERE home_id=?").bind(h).first<{ id: string }>();
    expect(attempt).toEqual({ id: expect.any(String), state: "done", session_id: "cs_test_new" });
    expect(create.key).toBe(`resume:${attempt!.id}`);
    expect(create.form.get("metadata[consent_id]")).toBe(c);
    expect(await env.DB.prepare("SELECT state,session_id FROM open_checkouts WHERE home_id=?").bind(h).first()).toEqual({ state: "open", session_id: "cs_test_new" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_homes WHERE owner_id=(SELECT owner_id FROM cloud_homes WHERE id=?)").bind(h).first()).toEqual({ n: 1 });
  });

  for (const [why, disclosure] of [["no archive at all (pre-change consent)", null], ["an archive without a Stripe page (pre-change consent)", JSON.stringify({ lines: { price: "x" } })],
    ["an archived Stripe page of another version", JSON.stringify({ stripePage: { ...stripePageOf("direct", "starter", checkoutLocale("US", null), SUBMIT_TEXT_VARIANT), version: "2026-10-01.sp0" } })],
    ["an archived Stripe page with other words", JSON.stringify({ stripePage: { ...stripePageOf("direct", "starter", checkoutLocale("US", null), SUBMIT_TEXT_VARIANT), submitMessage: "Old words." } })]] as const) {
    it(`Astra DROPDOWN-DIRECT-1 (4): never reissued (fresh consent instead): ${why}`, async () => {
      await reserved({ expiresAt: T - 1000, consent: { disclosure } });
      const res = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
      expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([409, "consent_stale"]);
      expect(calls.filter((c) => c.method === "POST" && c.path === "/v1/checkout/sessions")).toEqual([]);
    });
  }

  it("Astra DROPDOWN-DIRECT-1 (4): a reissue journals the superseded session binding before it binds the new session", async () => {
    const { h, c } = await reserved({ expiresAt: T - 1000, consent: { stripe_session_id: "cs_test_old" } });
    const res = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
    expect([res.status, (await res.json<{ sessionId: string }>()).sessionId]).toEqual([200, "cs_test_new"]);
    expect(await env.DB.prepare("SELECT stripe_session_id AS s FROM checkout_consents WHERE id=?").bind(c).first()).toEqual({ s: "cs_test_new" });
    expect(await env.DB.prepare("SELECT consent_id AS c,session_id AS s,payload FROM checkout_resume_attempts WHERE home_id=? AND state='superseded'").bind(h).all().then((r) => r.results))
      .toEqual([{ c, s: "cs_test_old", payload: JSON.stringify({ supersededBy: "cs_test_new" }) }]);
  });

  it("refuses a stale consent and a home with no checkout; another member has nothing to finish", async () => {
    await reserved({ expiresAt: T - 1000, consent: { created_at: T - 25 * 3_600_000 } });
    const res = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
    expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([409, "consent_stale"]);
    await userOf(SUB_B);
    expect((await call("/v1/billing/checkout/resume", await token(SUB_B, true), {})).status).toBe(404);
  });
});

describe("plan change", () => {
  async function subscribed(o: { plan?: string; arch?: string; link?: boolean } = {}) {
    const a = await userOf(SUB_A);
    const h = await home(a, "ready", "paid");
    const c = await consent(h, a, { completed_at: T, stripe_subscription_id: "sub_1", tax_source: o.link ? "managed_payments" : "stripe_tax" });
    await subscription(h, { subscription_id: "sub_1", status: "active", plan: o.plan ?? "starter", consent_id: c, price_id: PRICES.STRIPE_PRICE_STARTER, first_paid_at: T - 86_400_000 });
    await env.DB.prepare(`INSERT INTO provision_choices (home_id,resource_generation,provider,server_type,location,arch,image,tried,created_at)
      VALUES (?,1,'hetzner',?,'fsn1',?,'img','[]',?)`).bind(h, o.arch === "arm" ? "cax11" : "cx23", o.arch ?? "x86", T).run();
    return { a, h };
  }
  const quote = async (tok: string, plan = "pro") => (await call("/v1/account/plan/preview", tok, { plan })).json<{ quoteId: string; amountDueNowCents: number }>();
  const updates = () => calls.filter((x) => x.method === "POST" && x.path === "/v1/subscriptions/sub_1");

  it("is off unless CLOUD_PLAN_CHANGE=1: the site shows contact us", async () => {
    await subscribed();
    planFlag = "";
    const tok = await token(SUB_A, true);
    const res = await call("/v1/account/plan/preview", tok, { plan: "pro" });
    expect([res.status, await res.json()]).toEqual([409, { error: "plan_change_disabled", contact: true }]);
    expect(await (await call("/v1/account/plan", tok)).json()).toMatchObject({ changeAvailable: false });
  });

  it("charges exactly a server-issued quote: the same proration_date on preview and update, pending_if_incomplete (Astra 3)", async () => {
    const { h } = await subscribed();
    const tok = await token(SUB_A, true);
    const qt = await quote(tok);
    expect(qt).toMatchObject({ amountDueNowCents: 1234, quoteId: expect.any(String) });
    const ok = await call("/v1/account/plan", tok, { quoteId: qt.quoteId });
    expect([ok.status, await ok.json()]).toEqual([200, expect.objectContaining({ state: "awaiting_payment", amountDueNowCents: 1234 })]);
    const previews = calls.filter((x) => x.path === "/v1/invoices/create_preview");
    const pd = previews[0].form.get("subscription_details[proration_date]");
    expect(pd).toMatch(/^\d+$/);
    expect(previews.map((x) => x.form.get("subscription_details[proration_date]"))).toEqual([pd, pd]);
    const upd = updates()[0];
    expect(Object.fromEntries(upd.form)).toEqual({ "items[0][id]": "si_1", "items[0][price]": PRICES.STRIPE_PRICE_PRO, proration_behavior: "always_invoice",
      proration_date: pd, payment_behavior: "pending_if_incomplete" });
    expect(upd.key).toBe(`planchange:${qt.quoteId}`);
    expect(await env.DB.prepare("SELECT state,invoice_id FROM plan_changes WHERE home_id=?").bind(h).first()).toEqual({ state: "requested", invoice_id: "in_up_1" });
    // A quote is accepted once.
    expect((await (await call("/v1/account/plan", tok, { quoteId: qt.quoteId })).json<{ error: string }>()).error).toBe("quote_used");
    expect(updates()).toHaveLength(1);
  });

  it("refuses a quote whose amount or subscription changed, an expired one, and another member's (Astra 3)", async () => {
    await subscribed();
    const tok = await token(SUB_A, true);
    const q1 = await quote(tok);
    previewAmount = 1500;
    expect((await (await call("/v1/account/plan", tok, { quoteId: q1.quoteId })).json<{ error: string }>()).error).toBe("quote_stale");
    previewAmount = 1234;
    const q2 = await quote(tok);
    livePrice = "price_other";
    expect((await (await call("/v1/account/plan", tok, { quoteId: q2.quoteId })).json<{ error: string }>()).error).toBe("quote_stale");
    livePrice = PRICES.STRIPE_PRICE_STARTER;
    const q3 = await quote(tok);
    await env.DB.prepare("UPDATE plan_quotes SET expires_at=? WHERE id=?").bind(T - 1, q3.quoteId).run();
    expect((await (await call("/v1/account/plan", tok, { quoteId: q3.quoteId })).json<{ error: string }>()).error).toBe("quote_expired");
    await userOf(SUB_B);
    expect((await call("/v1/account/plan", await token(SUB_B, true), { quoteId: (await quote(tok)).quoteId })).status).toBe(404);
    expect(updates()).toHaveLength(0);
  });

  it("an open public (§312k) cancellation Stripe confirmed refuses a plan change (cancellation_open), up or down; after Keep my plan it is allowed", async () => {
    const { h } = await subscribed();
    const tok = await token(SUB_A, true);
    const end = T + 20 * 86_400_000;
    await env.DB.prepare("UPDATE billing_subscriptions SET current_period_end=? WHERE home_id=?").bind(end, h).run();
    await env.DB.prepare(`INSERT INTO cancellation_requests (id,ref,received_at,fields_json,kind,entered_email,entered_name,confirm_email,language,match_state,
      attribution_basis,home_id,subscription_id,effective_at,hold_until,status,receipt_sha256,stripe_synced,stripe_cancel_at,created_at,updated_at)
      VALUES ('cx-pc','REF-cx-pc',?,'{}','ordinary_earliest','a@example.test','A','a@example.test','en','matched','account_email',?,'sub_1',?,?,'open','00',1,?,?,?)`)
      .bind(T, h, end, end, end, T, T).run();
    for (const plan of ["pro", "starter"]) { // checked before any plan comparison: an upgrade, and a non-upgrade
      const r = await call("/v1/account/plan/preview", tok, { plan });
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ error: "cancellation_open", message: expect.stringContaining("Keep my plan"), cancellationId: "cx-pc" });
    }
    await env.DB.prepare("UPDATE cancellation_requests SET status='kept', kept_by='customer' WHERE id='cx-pc'").run();
    const ok = await call("/v1/account/plan/preview", tok, { plan: "pro" });
    expect(ok.status).toBe(200);
    expect(updates()).toHaveLength(0);
  });

  it("Astra CS-1 #4: after Keep my plan, before Stripe confirms the clear, no quote and no charge; once confirmed the upgrade is allowed", async () => {
    const { h } = await subscribed();
    const tok = await token(SUB_A, true);
    const end = T + 20 * 86_400_000;
    await env.DB.prepare("UPDATE billing_subscriptions SET current_period_end=?, cancel_at=? WHERE home_id=?").bind(end, end, h).run();
    // Kept (committed), Stripe not cleared yet: the declaration is unsynced, Stripe and the row still show the end.
    await env.DB.prepare(`INSERT INTO cancellation_requests (id,ref,received_at,fields_json,kind,entered_email,entered_name,confirm_email,language,match_state,
      attribution_basis,home_id,subscription_id,effective_at,hold_until,status,kept_by,receipt_sha256,stripe_synced,stripe_cancel_at,created_at,updated_at)
      VALUES ('cx-kc','REF-cx-kc',?,'{}','ordinary_earliest','a@example.test','A','a@example.test','en','matched','account_email',?,'sub_1',?,?,'kept','customer','00',0,?,?,?)`)
      .bind(T, h, end, end, end, T, T).run();
    liveCancelAt = Math.floor(end / 1000);
    const r = await call("/v1/account/plan/preview", tok, { plan: "pro" });
    expect([r.status, (await r.json<{ error: string }>()).error]).toEqual([409, "cancellation_clearing"]);
    // The local record says cleared but Stripe still shows the end: the live read refuses the quote too.
    await env.DB.prepare("UPDATE cancellation_requests SET stripe_synced=1, stripe_cancel_at=NULL WHERE id='cx-kc'").run();
    await env.DB.prepare("UPDATE billing_subscriptions SET cancel_at=NULL WHERE home_id=?").bind(h).run();
    expect((await call("/v1/account/plan/preview", tok, { plan: "pro" })).status).toBe(409);
    // Stripe confirmed the clear: quoted; then Stripe shows an end again before the charge: the charge is refused (live read in the lease).
    liveCancelAt = null;
    const q = await quote(tok);
    liveCancelAt = Math.floor(end / 1000);
    expect((await (await call("/v1/account/plan", tok, { quoteId: q.quoteId })).json<{ error: string }>()).error).toBe("quote_stale");
    expect(updates()).toHaveLength(0);
    liveCancelAt = null;
    expect((await call("/v1/account/plan/preview", tok, { plan: "pro" })).status).toBe(200);
  });

  it("re-reads cancellation, withdrawal and lifecycle inside the lease: a cancel recorded after the quote wins (Astra 2)", async () => {
    const { a, h } = await subscribed();
    const tok = await token(SUB_A, true);
    const q1 = await quote(tok);
    await env.DB.prepare("UPDATE billing_subscriptions SET customer_cancel_at=? WHERE home_id=?").bind(T, h).run();
    expect((await (await call("/v1/account/plan", tok, { quoteId: q1.quoteId })).json<{ error: string }>()).error).toBe("plan_cancelling");
    await env.DB.prepare("UPDATE billing_subscriptions SET customer_cancel_at=NULL WHERE home_id=?").bind(h).run();
    const q2 = await quote(tok);
    await env.DB.prepare(`INSERT INTO withdrawals (id,home_id,user_id,consent_id,confirmed_at,early_start,days_supplied,deducted_cents,refund_cents,basis,status)
      VALUES ('w1',?,?,'c',?,0,1,0,0,'b','recorded')`).bind(h, a, T).run();
    expect((await (await call("/v1/account/plan", tok, { quoteId: q2.quoteId })).json<{ error: string }>()).error).toBe("plan_change_unavailable");
    await env.DB.prepare("DELETE FROM withdrawals").run();
    const q3 = await quote(tok);
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleting' WHERE id=?").bind(h).run();
    expect((await (await call("/v1/account/plan", tok, { quoteId: q3.quoteId })).json<{ error: string }>()).error).toBe("plan_change_unavailable");
    expect(updates()).toHaveLength(0);
  });

  it("refuses a downgrade, the same plan, a Link sale (contact us) and a member without a plan", async () => {
    await subscribed({ plan: "pro" });
    const tok = await token(SUB_A, true);
    for (const [plan, code] of [["starter", "downgrade_not_available"], ["pro", "same_plan"]] as const) {
      const res = await call("/v1/account/plan/preview", tok, { plan });
      expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([409, code]);
    }
    await userOf(SUB_B);
    expect((await call("/v1/account/plan/preview", await token(SUB_B, true), { plan: "max" })).status).toBe(404);
    expect((await call("/v1/account/plan", await token(SUB_B, false))).status).toBe(404);
  });

  it("does not offer a Link (Managed Payments) sale a plan change at all (fails closed)", async () => {
    await subscribed({ link: true });
    const res = await call("/v1/account/plan/preview", await token(SUB_A, true), { plan: "pro" });
    expect([res.status, await res.json()]).toEqual([409, { error: "plan_change_unavailable", contact: true }]);
  });

  it("a declined upgrade payment fails the change only: the paid subscription stays active, no payment problem (Astra 1)", async () => {
    const { h } = await subscribed();
    const tok = await token(SUB_A, true);
    await call("/v1/account/plan", tok, { quoteId: (await quote(tok)).quoteId });
    const res = await webhook({ id: "evt_testupfail001", type: "invoice.payment_failed", created: Math.floor(T / 1000),
      data: { object: { id: "in_up_1", object: "invoice", customer: "cus_1", subscription: "sub_1", billing_reason: "subscription_update" } } });
    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT status,plan FROM billing_subscriptions WHERE home_id=?").bind(h).first()).toEqual({ status: "active", plan: "starter" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_payment_inbox WHERE home_id=?").bind(h).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT state FROM plan_changes WHERE home_id=?").bind(h).first()).toEqual({ state: "payment_failed" });
    expect(notices.filter((n) => n.kind === "payment_failed")).toEqual([]);
  });

  it("moves the plan and queues the resize atomically: a Flux failure is retried on redelivery and the resize is never lost (Astra 4)", async () => {
    const { h } = await subscribed();
    let fluxFails = 1; const fluxCalls: string[] = [];
    const flux = { stub: false, capabilities: { reversalTargets: true } as const, async changePlan(_e: Env, i: { plan: string }) { fluxCalls.push(i.plan); if (fluxFails-- > 0) throw new Error("flux_down"); },
      async grantMonthlyCredits() {}, async stopForBilling() {}, async usedIncludedCreditMicrocents() { return { usedMicrocents: 0 }; }, async setAutoRecharge() {}, async revokeCredits() {} };
    const event = { id: "evt_testplanmove01", type: "customer.subscription.updated", created: Math.floor(T / 1000),
      data: { object: { id: "sub_1", object: "subscription", customer: "cus_1", status: "active", cancel_at_period_end: false,
        items: { data: [{ id: "si_1", price: { id: PRICES.STRIPE_PRICE_PRO } }] } } } };
    expect((await webhook(event, { flux })).status).toBe(500);
    expect(await env.DB.prepare("SELECT plan,flux_plan_dirty FROM billing_subscriptions WHERE home_id=?").bind(h).first()).toEqual({ plan: "pro", flux_plan_dirty: 1 });
    expect(await env.DB.prepare("SELECT state,to_plan,generation FROM plan_resizes WHERE home_id=?").bind(h).first()).toEqual({ state: "queued", to_plan: "pro", generation: 1 });
    expect((await webhook(event, { flux })).status).toBe(200);
    expect(fluxCalls).toEqual(["pro", "pro"]);
    expect(await env.DB.prepare("SELECT flux_plan_dirty FROM billing_subscriptions WHERE home_id=?").bind(h).first()).toEqual({ flux_plan_dirty: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM plan_resizes WHERE home_id=?").bind(h).first()).toEqual({ n: 1 });
  });

  it("refuses an upgrade with no resize target (Vultr)", async () => {
    const { h } = await subscribed();
    await env.DB.prepare("UPDATE provision_choices SET provider='vultr' WHERE home_id=?").bind(h).run();
    const res = await call("/v1/account/plan/preview", await token(SUB_A, true), { plan: "pro" });
    expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([409, "resize_not_available"]);
  });
});

describe("resize job", () => {
  let clock: number;
  let ops: string[];
  let server: { status: string; type: string };
  let snapAction: "running" | "success" | "error";
  let imageStatus: string;
  let changeTypeError: number | null;
  let changeTypeLost: boolean;
  let shutdownLost: boolean;
  let readFails: number;
  const host: ResizeHost = {
    async findServer() { return { id: "42" }; },
    async server() { if (readFails > 0) { readFails--; throw new ResizeHostError(503); } return { ...server }; },
    async snapshot(s) { ops.push(`snapshot:${s}`); return { imageId: "img-1", actionId: "a-snap" }; },
    async image() { return imageStatus; },
    async shutdown(s) { ops.push(`shutdown:${s}`); server.status = "off"; if (shutdownLost) throw new ResizeHostError(502); return "a-off"; },
    async forceOff(s) { ops.push(`forceoff:${s}`); server.status = "off"; return "a-force"; },
    async powerOn(s) { ops.push(`poweron:${s}`); server.status = "running"; return "a-on"; },
    async changeType(s, type) {
      ops.push(`change:${s}:${type}`);
      if (changeTypeError !== null) throw new ResizeHostError(changeTypeError);
      server.type = type;
      if (changeTypeLost) throw new ResizeHostError(502);
      return "a-change";
    },
    async action(id) { return id === "a-snap" ? snapAction : "success"; },
  };
  const sweep = async (n = 1) => { for (let i = 0; i < n; i++) { clock += 61_000; await sweepPlanResizes(testEnv(), { resizeHost: host, now: () => clock, stripeFetch }); } };
  const job = () => env.DB.prepare("SELECT state,last_error,pending_op FROM plan_resizes WHERE id='r1'").first<{ state: string; last_error: string | null; pending_op: string | null }>();
  async function queued(o: { state?: string; server?: boolean } = {}) {
    const a = await userOf(SUB_A);
    const h = await home(a, "ready", "paid");
    await env.DB.prepare(`INSERT INTO provision_choices (home_id,resource_generation,provider,server_type,location,arch,image,tried,created_at)
      VALUES (?,1,'hetzner','cx23','fsn1','x86','img','[]',?)`).bind(h, T).run();
    await subscription(h, { subscription_id: "sub_1", status: "active", plan: "pro" });
    await env.DB.prepare("INSERT INTO cloud_home_health (home_id,reported_at,last_backup_at) VALUES (?,?,?)").bind(h, T, T).run();
    await env.DB.prepare(`INSERT INTO plan_resizes (id,home_id,generation,resource_generation,from_plan,to_plan,state,server_id,from_type,target_type,next_at,created_at,updated_at,step_at)
      VALUES ('r1',?,1,1,'starter','pro',?,?,'cx23','cx33',0,?,?,?)`).bind(h, o.state ?? "queued", o.server ? "42" : null, T, T, T).run();
    return h;
  }
  beforeEach(() => {
    clock = T; ops = []; server = { status: "running", type: "cx23" }; snapAction = "success"; imageStatus = "available"; changeTypeError = null; changeTypeLost = false;
    shutdownLost = false; readFails = 0;
  });

  it("runs snapshot (usable) → shutdown → change_type → power on → heartbeat, one claimed step per sweep", async () => {
    const h = await queued();
    await sweep(6);
    expect(ops).toEqual(["snapshot:42", "shutdown:42", "change:42:cx33", "poweron:42"]);
    expect((await job())!.state).toBe("checking");
    expect(await env.DB.prepare("SELECT server_type FROM provision_choices WHERE home_id=?").bind(h).first()).toEqual({ server_type: "cx33" });
    await env.DB.prepare("UPDATE cloud_homes SET heartbeat_at=? WHERE id=?").bind(clock + 30_000, h).run();
    await sweep();
    expect((await job())!.state).toBe("done");
    // A second sweep at the same moment finds nothing due: the job is claimed and re-read inside the lease.
    const before = ops.length; await sweepPlanResizes(testEnv(), { resizeHost: host, now: () => clock }); expect(ops.length).toBe(before);
  });

  it("does not shut down until the snapshot image is usable, and fails (server untouched) if the snapshot fails (Astra 7)", async () => {
    await queued();
    snapAction = "running"; imageStatus = "creating";
    await sweep(3);
    expect(ops).toEqual(["snapshot:42"]);
    expect((await job())!.state).toBe("snapshotting");
    snapAction = "success"; imageStatus = "unavailable";
    await sweep();
    expect(await job()).toMatchObject({ state: "failed", last_error: "snapshot_failed" });
    expect(ops).toEqual(["snapshot:42"]);
  });

  it("rechecks the volume backup right before the shutdown (Astra 7)", async () => {
    const h = await queued({ state: "snapshotted", server: true });
    await env.DB.prepare("UPDATE cloud_home_health SET last_backup_at=? WHERE home_id=?").bind(T - 2 * 86_400_000, h).run();
    await sweep(2);
    expect(ops).toEqual([]);
    expect((await job())!.state).toBe("snapshotted");
  });

  it("a refused change_type powers the server back on, records the failure and alerts (Astra 6)", async () => {
    const h = await queued({ state: "snapshotted", server: true });
    changeTypeError = 422;
    await sweep(5);
    expect(ops).toEqual(["shutdown:42", "change:42:cx33", "poweron:42"]);
    expect(await job()).toMatchObject({ state: "failed" });
    expect(server.status).toBe("running");
    expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE home_id=? AND kind='plan.resize_failed'").bind(h).first()).toBeTruthy();
  });

  it("a lost change_type answer is reconciled from the server's real type, then the server is powered on (Astra 6)", async () => {
    await queued({ state: "snapshotted", server: true });
    changeTypeLost = true;
    await sweep(6); // the lost answer backs off two minutes, then the journal is reconciled against the server's real type
    expect(ops).toEqual(["shutdown:42", "change:42:cx33", "poweron:42"]);
    expect((await job())!.state).toBe("checking");
  });

  it("never powers on a home whose lifecycle moved on (deleting): left off, failed, alert (Astra 5)", async () => {
    const h = await queued({ state: "snapshotted", server: true });
    await sweep(1); // shutdown sent
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleting',generation=generation+1 WHERE id=?").bind(h).run();
    await sweep(3);
    expect(ops).toEqual(["shutdown:42"]);
    expect(await job()).toMatchObject({ state: "failed", last_error: "left_off_lifecycle_deleting" });
  });

  it("does not shut down a home whose lifecycle changed after the snapshot (Astra 5)", async () => {
    const h = await queued({ state: "snapshotted", server: true });
    await env.DB.prepare("UPDATE cloud_homes SET generation=generation+1 WHERE id=?").bind(h).run();
    await sweep(1);
    expect(ops).toEqual([]);
    expect(await job()).toMatchObject({ state: "failed", last_error: "lifecycle_ready" });
  });

  it("a lost shutdown answer plus failing reads goes to durable recovery, never a terminal failure; the server comes back on (Astra2 P1-2)", async () => {
    await queued({ state: "snapshotted", server: true });
    shutdownLost = true; readFails = 6;
    for (let i = 0; i < 12; i++) { clock += 31 * 60_000; await sweepPlanResizes(testEnv(), { resizeHost: host, now: () => clock, stripeFetch }); }
    expect(ops).toEqual(["shutdown:42", "poweron:42"]);
    expect(server.status).toBe("running");
    expect((await job())!.state).toBe("failed");
  });

  it("flags a home that does not come back after the resize", async () => {
    const h = await queued({ state: "checking", server: true });
    await env.DB.prepare("UPDATE plan_resizes SET powered_on_at=? WHERE id='r1'").bind(T).run();
    clock = T + 16 * 60_000; await sweep();
    expect(await job()).toMatchObject({ state: "unhealthy", last_error: "no_heartbeat_after_resize" });
    expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE home_id=? AND kind='plan.resize_unhealthy'").bind(h).first()).toBeTruthy();
  });

  it("voids the invoice of an upgrade Stripe never completed and expires the change", async () => {
    const a = await userOf(SUB_A);
    const h = await home(a, "ready", "paid");
    await env.DB.prepare(`INSERT INTO plan_changes (id,home_id,user_id,quote_id,subscription_id,from_plan,to_plan,amount_cents,currency,invoice_id,state,created_at,updated_at)
      VALUES ('pc1',?,?,'q','sub_1','starter','pro',1234,'usd','in_up_9','requested',?,?)`).bind(h, a, T - 24 * 3_600_000, T - 24 * 3_600_000).run();
    await sweep();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(expect.arrayContaining(["POST /v1/invoices/in_up_9/void"]));
    expect(await env.DB.prepare("SELECT state FROM plan_changes WHERE id='pc1'").first()).toEqual({ state: "expired" });
  });
});

describe("Astra STEPUP-EMAIL-8 #3: a saved replacement attempt follows the immutable-attempt policy", () => {
  // (The saved request carries its issuance id, as every replacement attempt has since Astra JOURNEY-A-3 #2: one without it is retired.)
  async function savedReplacement(remainingMs: number) {
    const a = await userOf(SUB_A);
    const h = await home(a, "payment_pending");
    const c = await consent(h, a);
    await taxQuote(`quote-${h}`, a, 5300);
    await subscription(h, { status: "checkout_created", consent_id: c });
    await openCheckout(h, c, "failed", T - 1000);
    await env.DB.prepare("UPDATE open_checkouts SET updated_at=? WHERE home_id=?").bind(T - 120_000, h).run();
    const id = crypto.randomUUID(), expiresAt = T + remainingMs;
    await env.DB.prepare("INSERT INTO checkout_resume_attempts (id,home_id,consent_id,expires_at,payload,state,created_at) VALUES (?,?,?,?,?,'creating',?)")
      .bind(id, h, c, expiresAt, JSON.stringify({ homeId: h, consentId: c, renewalSha256: "x".repeat(64), issuanceId: `resume:${id}`, expiresAtSeconds: Math.floor(expiresAt / 1000) }), T - 45 * 60_000).run();
    // The customer already at the consent's declared location: the required preset moves nothing, so the attempt's own session stands
    // (a relocated customer's earlier session is expired instead: Astra TAXCOUNTRY-2 P2, tested below).
    cust.customers.cus_1 = { address: { country: "US" } };
    return { h, c, id, expiresAt };
  }
  const attemptState = (id: string) => env.DB.prepare("SELECT state,session_id FROM checkout_resume_attempts WHERE id=?").bind(id).first();

  it("15 minutes remaining: its own original session is recorded under the attempt; no other key, no new session, never expired", async () => {
    const { h, c, id, expiresAt } = await savedReplacement(15 * 60_000);
    listed = [{ id: "cs_saved", status: "open", url: "https://checkout.stripe.test/c/cs_saved", subscription: null, expires_at: Math.floor(expiresAt / 1000),
      metadata: { home_id: h, consent_id: c } }];
    const res = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
    expect([res.status, await res.json()]).toEqual([200, { sessionId: "cs_saved", url: "https://checkout.stripe.test/c/cs_saved", consentId: c, reused: false }]);
    // Never dispatched under any key (its fixed expiry is too close for Stripe to create it) and its session never expired.
    expect(calls.filter((x) => x.method === "POST" && x.path === "/v1/checkout/sessions")).toEqual([]);
    expect(calls.filter((x) => x.path.endsWith("/expire"))).toEqual([]);
    expect(await attemptState(id)).toEqual({ state: "done", session_id: "cs_saved" });
    expect(await env.DB.prepare("SELECT state,session_id FROM open_checkouts WHERE home_id=?").bind(h).first()).toEqual({ state: "open", session_id: "cs_saved" });
  });

  it("15 minutes remaining and no session listed yet: unresolved (409 checkout_in_progress), never a 502, never a substituted key; past its expiry plus the grace: 409 consent_stale", async () => {
    const { h, id } = await savedReplacement(15 * 60_000);
    const res = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
    expect([res.status, (await res.json<{ error: string; restart?: string }>())]).toEqual([409, { error: "checkout_in_progress" }]);
    expect(calls.filter((x) => x.method === "POST" && x.path === "/v1/checkout/sessions")).toEqual([]);
    expect(await attemptState(id)).toEqual({ state: "creating", session_id: null });
    // Its own expiry plus the grace period has passed with nothing listed: proven, abandoned, a fresh consent is asked for.
    await env.DB.prepare("UPDATE checkout_resume_attempts SET expires_at=? WHERE id=?").bind(T - 61 * 60_000, id).run();
    await env.DB.prepare("UPDATE open_checkouts SET updated_at=? WHERE home_id=?").bind(T - 120_000, h).run();
    const late = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
    expect([late.status, await late.json()]).toEqual([409, expect.objectContaining({ error: "consent_stale", restart: "checkout" })]);
    expect(calls.filter((x) => x.method === "POST" && x.path === "/v1/checkout/sessions")).toEqual([]);
    expect(await attemptState(id)).toEqual({ state: "abandoned", session_id: null });
  });
});

describe("Astra INTEGRATED-1 #1: a replayed step-up checkout settles its issuance marker", () => {
  it("INTEGRATED-1 #1 a recovered (replayed) checkout publishes and clears its issuance marker; the marker sweep never expires it", async () => {
    const a = await userOf(SUB_A);
    const h = await home(a, "payment_pending");
    // The interrupted run journaled its marker under the original key before Stripe was asked, and never recorded the answer.
    const c = await consent(h, a, { session_inflight_at: T - 20 * 60_000, session_issuance_id: `checkout:consent-${h}` });
    await taxQuote(`quote-${h}`, a, 5300);
    await subscription(h, { status: "checkout_created", consent_id: c });
    await openCheckout(h, c, "failed", T + 40 * 60_000, null);
    const id = `stepup-checkout:intent-${h}`, expiresAt = T + 40 * 60_000;
    await env.DB.prepare(`INSERT INTO checkout_resume_attempts (id,home_id,consent_id,expires_at,payload,state,created_at,stripe_price_id,idempotency_key) VALUES (?,?,?,?,?,'creating',?,?,?)`)
      .bind(id, h, c, expiresAt, JSON.stringify({ customerId: "cus_1", homeId: h, plan: "starter", priceId: PRICES.STRIPE_PRICE_STARTER, consentId: c, renewalSha256: "a".repeat(64),
        locale: "en", issuanceId: `checkout:${c}`, expiresAtSeconds: Math.floor(expiresAt / 1000), successUrl: "https://app.murage.test/ok", cancelUrl: "https://app.murage.test/no",
        submitLinks: { terms: "https://murage.test/terms", tos: "https://murage.test/tos", privacy: "https://murage.test/privacy" } }),
        T - 20 * 60_000, PRICES.STRIPE_PRICE_STARTER, `checkout:${c}`).run();
    const marker = () => env.DB.prepare("SELECT session_inflight_at AS at,session_issuance_id AS iss FROM checkout_consents WHERE id=?").bind(c).first();
    expect(await marker()).toEqual({ at: T - 20 * 60_000, iss: `checkout:${c}` });

    const res = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
    expect([res.status, await res.json()]).toMatchObject([200, { sessionId: "cs_test_new", url: "https://checkout.stripe.test/c/cs_test_new", consentId: c }]);
    const creates = calls.filter((x) => x.method === "POST" && x.path === "/v1/checkout/sessions");
    expect(creates.map((x) => x.key)).toEqual([`checkout:${c}`]);
    expect(await env.DB.prepare("SELECT state,session_id FROM checkout_resume_attempts WHERE id=?").bind(id).first()).toEqual({ state: "done", session_id: "cs_test_new" });
    expect(await env.DB.prepare("SELECT state,session_id FROM open_checkouts WHERE home_id=?").bind(h).first()).toEqual({ state: "open", session_id: "cs_test_new" });
    // Publication settled the marker in the same batch.
    expect(await marker()).toEqual({ at: null, iss: null });

    // The billing sweep, well past the marker settle age, finds nothing to reconcile: the published session is never expired.
    calls.length = 0;
    await expect(sweepBilling(testEnv(), { notifier, stripeFetch, now: () => T + 60 * 60_000 })).resolves.not.toThrow();
    expect(calls.filter((x) => x.method === "POST" && x.path.endsWith("/expire"))).toEqual([]);
    expect(await marker()).toEqual({ at: null, iss: null });
    expect(await env.DB.prepare("SELECT state,session_id FROM open_checkouts WHERE home_id=?").bind(h).first()).toEqual({ state: "open", session_id: "cs_test_new" });
  });
});

describe("Astra round 1 P2s", () => {
  it("Finish checkout replays the same attempt (same key and expiry) after a crash, and never leaves two sessions recorded (P2 8)", async () => {
    const a = await userOf(SUB_A);
    const h = await home(a, "payment_pending");
    const c = await consent(h, a);
    await taxQuote(`quote-${h}`, a, 5300);
    await subscription(h, { status: "checkout_created", consent_id: c });
    await openCheckout(h, c, "open", T - 1000);
    retrieveFails = 1; // the session is created, then the worker loses the answer
    expect((await call("/v1/billing/checkout/resume", await token(SUB_A, true), {})).status).toBe(502);
    await env.DB.prepare("UPDATE open_checkouts SET updated_at=? WHERE home_id=?").bind(T - 120_000, h).run();
    expect((await call("/v1/billing/checkout/resume", await token(SUB_A, true), {})).status).toBe(200);
    const creates = calls.filter((x) => x.method === "POST" && x.path === "/v1/checkout/sessions");
    expect(creates).toHaveLength(2);
    expect(creates[0].key).toBe(creates[1].key);
    expect(creates[0].form.get("expires_at")).toBe(creates[1].form.get("expires_at"));
  });

  it("Finish checkout asks for a fresh consent when the price, the seller or the total including tax changed (P2 9)", async () => {
    const a = await userOf(SUB_A);
    const tok = await token(SUB_A, true);
    for (const [over, total] of [[{ price_cents: 2000 }, 5300], [{ billing_country: "DE" }, 5300], [{}, 5900]] as const) {
      await env.DB.prepare("DELETE FROM cloud_homes").run(); await env.DB.prepare("DELETE FROM checkout_consents").run();
      await env.DB.prepare("DELETE FROM billing_subscriptions").run(); await env.DB.prepare("DELETE FROM open_checkouts").run(); await env.DB.prepare("DELETE FROM tax_quotes").run();
      const h = await home(a, "payment_pending");
      const c = await consent(h, a, over);
      await taxQuote(`quote-${h}`, a, total);
      await subscription(h, { status: "checkout_created", consent_id: c });
      await openCheckout(h, c, "open", T - 1000);
      const res = await call("/v1/billing/checkout/resume", tok, {});
      expect([JSON.stringify(over), res.status, (await res.json<{ error: string }>()).error]).toEqual([JSON.stringify(over), 409, "consent_stale"]);
    }
    expect(calls.filter((x) => x.method === "POST" && x.path === "/v1/checkout/sessions")).toEqual([]);
  });

  it("an unpaid past_due order is pending, never paid/charged (P2 10)", async () => {
    const a = await userOf(SUB_A);
    const h = await home(a, "payment_pending", "paid");
    const c = await consent(h, a, { completed_at: T, stripe_subscription_id: "sub_p" });
    await subscription(h, { subscription_id: "sub_p", status: "past_due", consent_id: c });
    expect(await (await call(`/v1/account/order?home=${h}`, await token(SUB_A, false))).json()).toMatchObject({ status: "pending", reason: "processing", charged: null });
  });

  it("a deletion receipt reports backups pending while any backup space has no purge time (P2 11)", async () => {
    const a = await userOf(SUB_A);
    const h = await home(a, "deleted", "paid");
    await env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES ('o9',?,3,?,'deleted','{}',?)`).bind(h, a, T).run();
    await env.DB.prepare(`INSERT INTO backup_subaccounts (home_id,resource_generation,box_id,subaccount_id,username,server,directory,created_at,deleted_at)
      VALUES (?,1,1,'s1','u','srv','d',?,?), (?,2,1,'s2','u','srv','d2',?,NULL)`).bind(h, T, T - 5, h, T).run();
    expect((await (await call("/v1/account/deletion", await token(SUB_A, false))).json<{ deletion: Record<string, unknown> }>()).deletion)
      .toMatchObject({ backups: { status: "pending", purgedAt: null }, backupsPurgedAt: null });
    expect(String((await deletionNoticeData(env, h, T)).emailText)).toContain("is being purged now");
  });

  it("the Customer Portal opens only on a configuration with plan switching off; otherwise 503 and an alert (P2 12)", async () => {
    const a = await userOf(SUB_A);
    const h = await home(a, "ready", "paid");
    await subscription(h, { subscription_id: "sub_1", status: "active" });
    const tok = await token(SUB_A, true);
    expect((await call("/v1/billing/portal", tok, {})).status).toBe(200);
    for (const v of [true, undefined]) {
      portalUpdates = v;
      const res = await call("/v1/billing/portal", tok, {});
      expect([String(v), res.status, (await res.json<{ error: string }>()).error]).toEqual([String(v), 503, "portal_misconfigured"]);
    }
    expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE home_id=? AND kind='billing.portal_allows_plan_switch'").bind(h).first()).toBeTruthy();
  });

  it("export with another member's home id is 404, not the caller's own export (P2 13)", async () => {
    const a = await userOf(SUB_A); const b = await userOf(SUB_B);
    await home(a, "ready", "paid");
    const hb = await home(b, "ready", "paid");
    expect((await call("/v1/account/export-request", await token(SUB_A, true), { homeId: hb })).status).toBe(404);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM data_export_requests").first()).toEqual({ n: 0 });
  });
});

describe("Astra round 2: launch path", () => {
  async function expiredReservation(over: Record<string, unknown> = {}) {
    const a = await userOf(SUB_A);
    const h = await home(a, "payment_pending");
    const c = await consent(h, a, over);
    await taxQuote(`quote-${h}`, a, 5300);
    await subscription(h, { status: "checkout_created", consent_id: c });
    await openCheckout(h, c, "open", T - 1000);
    return { a, h, c };
  }
  const resume = async () => call("/v1/billing/checkout/resume", await token(SUB_A, true), {});

  it("Finish checkout reuses a consent only for its own configured Stripe price, still active at the same amount (P2-4)", async () => {
    await expiredReservation();
    envOver = { STRIPE_PRICE_STARTER: "price_startnew0001" };
    expect((await (await resume()).json<{ error: string }>()).error).toBe("consent_stale");
    envOver = {}; priceAmount = 5900;
    expect((await (await resume()).json<{ error: string }>()).error).toBe("consent_stale");
    priceAmount = 4900;
    await env.DB.prepare("UPDATE checkout_consents SET stripe_price_id=NULL").run();
    expect((await (await resume()).json<{ error: string }>()).error).toBe("consent_stale");
    await env.DB.prepare("UPDATE checkout_consents SET stripe_price_id=?").bind(PRICES.STRIPE_PRICE_STARTER).run();
    expect((await resume()).status).toBe(200);
    expect(calls.filter((x) => x.method === "POST" && x.path === "/v1/checkout/sessions")[0].form.get("line_items[0][price]")).toBe(PRICES.STRIPE_PRICE_STARTER);
  });

  it("Finish checkout replays the stored request exactly, even after configuration changed (P2-5)", async () => {
    const { h } = await expiredReservation();
    retrieveFails = 1;
    expect((await resume()).status).toBe(502);
    envOver = { BILLING_RETURN_ORIGIN: "https://elsewhere.test" };
    await env.DB.prepare("UPDATE open_checkouts SET updated_at=? WHERE home_id=?").bind(T - 120_000, h).run();
    expect((await resume()).status).toBe(200);
    const creates = calls.filter((x) => x.method === "POST" && x.path === "/v1/checkout/sessions");
    expect(creates).toHaveLength(2);
    expect(creates[1].key).toBe(creates[0].key);
    expect(creates[1].form.toString()).toBe(creates[0].form.toString());
    expect(creates[1].form.get("success_url")).toContain("https://murage.test/");
  });

  it("the portal session opens on exactly the verified configuration id; none returned is 503 (P2-6)", async () => {
    const a = await userOf(SUB_A);
    const h = await home(a, "ready", "paid");
    await subscription(h, { subscription_id: "sub_1", status: "active" });
    const tok = await token(SUB_A, true);
    expect((await call("/v1/billing/portal", tok, {})).status).toBe(200);
    expect(calls.find((x) => x.path === "/v1/billing_portal/sessions")!.form.get("configuration")).toBe("bpc_1");
    portalId = undefined;
    expect((await call("/v1/billing/portal", tok, {})).status).toBe(503);
  });

  it("a proration invoice grants the NEW plan as an upgrade delta whatever its line order; a renewal grants its own plan (P1-3)", async () => {
    const a = await userOf(SUB_A);
    const h = await home(a, "ready", "paid");
    const c = await consent(h, a, { completed_at: T, confirmation_sent_at: T, stripe_subscription_id: "sub_1" });
    await subscription(h, { subscription_id: "sub_1", status: "active", plan: "starter", consent_id: c, first_invoice_id: "in_first", first_paid_at: T - 86_400_000 });
    const grants: Record<string, unknown>[] = [];
    const flux = { stub: false, capabilities: { reversalTargets: true } as const, async grantMonthlyCredits(_e: Env, i: Record<string, unknown>) { grants.push(i); }, async changePlan() {}, async stopForBilling() {},
      async usedIncludedCreditMicrocents() { return { usedMicrocents: 0 }; }, async setAutoRecharge() {}, async revokeCredits() {} };
    const p = { start: Math.floor(T / 1000), end: Math.floor(T / 1000) + 20 * 86_400 };
    const invoice = (id: string, reason: string, lines: unknown[]) => ({ id: `evt_test${id}aaaa`, type: "invoice.paid", created: Math.floor(T / 1000),
      data: { object: { id, object: "invoice", customer: "cus_1", subscription: "sub_1", billing_reason: reason, status: "paid", amount_paid: 1000, lines: { data: lines } } } });
    // Credit line (old plan) BEFORE the debit line (new plan): order must not matter. The upgrade is verified: our recorded plan change.
    await env.DB.prepare(`INSERT INTO plan_changes (id,home_id,user_id,quote_id,subscription_id,from_plan,to_plan,amount_cents,currency,invoice_id,state,created_at,updated_at)
      VALUES ('pc-pr',?,?,'q','sub_1','starter','pro',1000,'usd','in_pr_1','requested',?,?)`).bind(h, a, T, T).run();
    expect((await webhook(invoice("in_pr_1", "subscription_update", [
      { price: { id: PRICES.STRIPE_PRICE_STARTER }, proration: true, amount: -1500, period: p },
      { price: { id: PRICES.STRIPE_PRICE_PRO }, proration: true, amount: 2500, period: p }]), { flux })).status).toBe(200);
    expect(grants.at(-1)).toMatchObject({ plan: "pro", kind: "upgrade_delta", previousPlan: "starter", invoiceId: "in_pr_1" });
    expect((await webhook(invoice("in_rn_1", "subscription_cycle", [{ price: { id: PRICES.STRIPE_PRICE_STARTER }, proration: false, amount: 4900, period: p }]), { flux })).status).toBe(200);
    expect(grants.at(-1)).toMatchObject({ plan: "starter", invoiceId: "in_rn_1" });
    expect(grants.at(-1)).not.toHaveProperty("kind");
  });

  it("a declined upgrade that is then paid advances to paid and applied; a late failure never regresses it (Astra2 P2-8)", async () => {
    const a = await userOf(SUB_A);
    const h = await home(a, "ready", "paid");
    await subscription(h, { subscription_id: "sub_1", status: "active", plan: "starter" });
    await env.DB.prepare(`INSERT INTO plan_changes (id,home_id,user_id,quote_id,subscription_id,from_plan,to_plan,amount_cents,currency,invoice_id,state,created_at,updated_at)
      VALUES ('pc2',?,?,'q','sub_1','starter','pro',1234,'usd','in_up_2','payment_failed',?,?)`).bind(h, a, T, T).run();
    const { upgradeInvoiceOutcome } = await import("../src/members-api");
    const { withHomeLease } = await import("../src/billing-lease");
    await withHomeLease(env, h, (lease) => upgradeInvoiceOutcome(env, lease, h, "in_up_2", "subscription_update", true, T));
    expect(await env.DB.prepare("SELECT state FROM plan_changes WHERE id='pc2'").first()).toEqual({ state: "paid" });
    await withHomeLease(env, h, (lease) => upgradeInvoiceOutcome(env, lease, h, "in_up_2", "subscription_update", false, T));
    expect(await env.DB.prepare("SELECT state FROM plan_changes WHERE id='pc2'").first()).toEqual({ state: "paid" });
  });
});

describe("Astra round 3", () => {
  async function paying() {
    const a = await userOf(SUB_A);
    const h = await home(a, "ready", "paid");
    const c = await consent(h, a, { completed_at: T, confirmation_sent_at: T, stripe_subscription_id: "sub_1" });
    await subscription(h, { subscription_id: "sub_1", status: "active", plan: "starter", consent_id: c, first_invoice_id: "in_first", first_paid_at: T - 86_400_000,
      current_period_start: T - 86_400_000, current_period_end: T + 29 * 86_400_000 });
    const grants: Record<string, unknown>[] = [];
    const fluxCalls: string[] = [];
    const flux = { stub: false, capabilities: { reversalTargets: true } as const, async grantMonthlyCredits(_e: Env, i: Record<string, unknown>) { grants.push(i); }, async changePlan(_e: Env, i: { plan: string }) { fluxCalls.push(i.plan); },
      async stopForBilling() {}, async usedIncludedCreditMicrocents() { return { usedMicrocents: 0 }; }, async setAutoRecharge() {}, async revokeCredits() {} };
    return { a, h, grants, fluxCalls, flux };
  }
  const S = Math.floor(T / 1000);
  const adj = { start: S, end: S + 20 * 86_400 };          // a mid-period adjustment
  const next = { start: S + 29 * 86_400, end: S + 59 * 86_400 }; // the next renewal period
  const basil = (price: string, amount: number, o: { proration: boolean; invoiceItem?: boolean; period: { start: number; end: number } }) => ({
    amount, pricing: { price_details: { price } }, period: o.period,
    parent: o.invoiceItem ? { type: "invoice_item_details", invoice_item_details: { proration: o.proration, subscription: "sub_1", invoice_item: "ii_1" } }
      : { type: "subscription_item_details", subscription_item_details: { proration: o.proration, subscription: "sub_1", subscription_item: "si_1" } } });
  const paidInvoice = (id: string, reason: string, lines: unknown[]) => ({ id: `evt_test${id.replace(/_/g, "")}aa`, type: "invoice.paid", created: S,
    data: { object: { id, object: "invoice", customer: "cus_1", subscription: "sub_1", billing_reason: reason, status: "paid", amount_paid: 1000, lines: { data: lines } } } });
  const period = (h: string) => env.DB.prepare("SELECT current_period_start AS s,current_period_end AS e FROM billing_subscriptions WHERE home_id=?").bind(h).first();
  const P = PRICES;

  it("flag off: a Stripe-side plan move is recorded and alerted; no resize starts (P1-1)", async () => {
    const { h, fluxCalls, flux } = await paying();
    planFlag = "";
    expect((await webhook({ id: "evt_testflagoff01", type: "customer.subscription.updated", created: S, data: { object: { id: "sub_1", object: "subscription",
      customer: "cus_1", status: "active", cancel_at_period_end: false, items: { data: [{ id: "si_1", price: { id: P.STRIPE_PRICE_PRO } }] } } } }, { flux })).status).toBe(200);
    expect(await env.DB.prepare("SELECT plan FROM billing_subscriptions WHERE home_id=?").bind(h).first()).toEqual({ plan: "pro" });
    expect(fluxCalls).toEqual(["pro"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM plan_resizes").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE home_id=? AND kind='plan.changed_while_plan_change_off'").bind(h).first()).toBeTruthy();
  });

  it("an unverified adjustment (Dashboard change, manual proration, quantity) grants nothing and never moves the period (P1-3)", async () => {
    const { h, grants, flux } = await paying();
    const before = await period(h);
    for (const [id, reason, lines] of [
      ["in_dash_1", "subscription_update", [basil(P.STRIPE_PRICE_STARTER, -1500, { proration: true, period: adj }), basil(P.STRIPE_PRICE_PRO, 2500, { proration: true, period: adj })]],
      ["in_man_1", "manual", [basil(P.STRIPE_PRICE_STARTER, -1500, { proration: true, invoiceItem: true, period: adj }), basil(P.STRIPE_PRICE_PRO, 2500, { proration: true, invoiceItem: true, period: adj })]],
      ["in_qty_1", "subscription_update", [basil(P.STRIPE_PRICE_STARTER, 1200, { proration: true, period: adj })]],
    ] as const) {
      expect([id, (await webhook(paidInvoice(id, reason, lines as unknown as unknown[]), { flux })).status]).toEqual([id, 200]);
    }
    // One open alert per kind per home (cloud_alerts): raised by the first, kept open for the rest.
    expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE home_id=? AND kind='billing.unverified_adjustment'").bind(h).first()).toEqual({ kind: "billing.unverified_adjustment" });
    expect(grants).toEqual([]);
    expect(await period(h)).toEqual(before);
  });

  it("a verified upgrade invoiced manually gets its delta from the recorded change, whatever billing_reason, without moving the period (P1-3)", async () => {
    const { a, h, grants, flux } = await paying();
    await env.DB.prepare(`INSERT INTO plan_changes (id,home_id,user_id,quote_id,subscription_id,from_plan,to_plan,amount_cents,currency,invoice_id,state,created_at,updated_at)
      VALUES ('pc-m',?,?,'q','sub_1','starter','pro',1000,'usd','in_man_2','requested',?,?)`).bind(h, a, T, T).run();
    const before = await period(h);
    expect((await webhook(paidInvoice("in_man_2", "manual", [basil(P.STRIPE_PRICE_PRO, 2500, { proration: true, invoiceItem: true, period: adj }),
      basil(P.STRIPE_PRICE_STARTER, -1500, { proration: true, invoiceItem: true, period: adj })]), { flux })).status).toBe(200);
    expect(grants).toEqual([{ homeId: h, plan: "pro", invoiceId: "in_man_2", periodStart: adj.start * 1000, periodEnd: adj.end * 1000, kind: "upgrade_delta", previousPlan: "starter" }]);
    expect(await period(h)).toEqual(before);
    expect(await env.DB.prepare("SELECT state FROM plan_changes WHERE id='pc-m'").first()).toEqual({ state: "paid" });
  });

  it("Basil invoice-item prorations before a real renewal line: the renewal is granted with ITS plan and period (P1-2)", async () => {
    const { h, grants, flux } = await paying();
    expect((await webhook(paidInvoice("in_rn_2", "subscription_cycle", [
      basil(P.STRIPE_PRICE_STARTER, -1500, { proration: true, invoiceItem: true, period: adj }),
      basil(P.STRIPE_PRICE_PRO, 2500, { proration: true, invoiceItem: true, period: adj }),
      basil(P.STRIPE_PRICE_PRO, 9900, { proration: false, period: next })]), { flux })).status).toBe(200);
    expect(grants).toEqual([{ homeId: h, plan: "pro", invoiceId: "in_rn_2", periodStart: next.start * 1000, periodEnd: next.end * 1000 }]);
    expect(await period(h)).toEqual({ s: next.start * 1000, e: next.end * 1000 });
  });

  it("two candidate renewal lines that nothing pins are rejected, never guessed (P1-2)", async () => {
    const { grants, flux } = await paying();
    expect((await webhook(paidInvoice("in_amb_1", "subscription_cycle", [basil(P.STRIPE_PRICE_STARTER, 4900, { proration: false, period: next }),
      basil(P.STRIPE_PRICE_PRO, 9900, { proration: false, period: next })]), { flux })).status).toBe(500);
    expect(grants).toEqual([]);
  });

  it("flag off: resize jobs drain recovery-only; nothing new starts, an off server comes back on (P1-1)", async () => {
    const a = await userOf(SUB_A);
    const h1 = await home(a, "ready", "paid"); const h2 = await home(a, "ready", "paid"); const h3 = await home(a, "ready", "paid");
    const row = (id: string, h: string, state: string, pending: string | null) => env.DB.prepare(`INSERT INTO plan_resizes
      (id,home_id,generation,resource_generation,from_plan,to_plan,state,server_id,from_type,target_type,pending_op,next_at,step_at,created_at,updated_at)
      VALUES (?,?,1,1,'starter','pro',?,?,'cx23','cx33',?,0,?,?,?)`).bind(id, h, state, `srv-${id}`, pending, T, T, T).run();
    await row("j-snap", h1, "snapshotted", null); await row("j-off", h2, "powering_off", null); await row("j-acpi", h3, "snapshotted", "shutdown");
    const status: Record<string, string> = { "srv-j-snap": "running", "srv-j-off": "off", "srv-j-acpi": "running" };
    const ops: string[] = [];
    const host: ResizeHost = {
      async findServer() { return null; }, async server(id) { return { status: status[id], type: "cx23" }; },
      async snapshot(id) { ops.push(`snapshot:${id}`); return { imageId: "i", actionId: "a" }; }, async image() { return "available"; },
      async shutdown(id) { ops.push(`shutdown:${id}`); return "a"; }, async forceOff(id) { ops.push(`forceoff:${id}`); return "a"; },
      async powerOn(id) { ops.push(`poweron:${id}`); status[id] = "running"; return "a"; }, async changeType(id) { ops.push(`change:${id}`); return "a"; },
      async action() { return "success"; },
    };
    planFlag = "";
    let clock = T;
    const sweep = async () => { clock += 61_000; await sweepPlanResizes(testEnv(), { resizeHost: host, now: () => clock, stripeFetch }); };
    await sweep(); await sweep();
    expect(ops).toEqual(["poweron:srv-j-off"]);
    expect(await env.DB.prepare("SELECT state,last_error FROM plan_resizes WHERE id='j-snap'").first()).toEqual({ state: "failed", last_error: "drained_plan_change_off" });
    // The ACPI shutdown sent before the switch completes later: recovery waited for it and now powers the server back on.
    expect((await env.DB.prepare("SELECT state FROM plan_resizes WHERE id='j-acpi'").first<{ state: string }>())!.state).toBe("recovering");
    status["srv-j-acpi"] = "off";
    await sweep();
    expect(ops).toEqual(["poweron:srv-j-off", "poweron:srv-j-acpi"]);
    expect(ops.some((o) => /^(snapshot|shutdown|forceoff|change):/.test(o))).toBe(false);
  });

  it("a paid order stays paid when the subscription later goes unpaid (P2-4)", async () => {
    const a = await userOf(SUB_A);
    const h = await home(a, "ready", "paid");
    const c = await consent(h, a, { completed_at: T, stripe_subscription_id: "sub_u" });
    await subscription(h, { subscription_id: "sub_u", status: "unpaid", consent_id: c, first_paid_at: T - 5 });
    expect(await (await call(`/v1/account/order?home=${h}`, await token(SUB_A, false))).json()).toMatchObject({ status: "paid", charged: true });
  });

  it("the deletion receipt dates the purge conservatively: not before the snapshots went with the deletion (P2-5)", async () => {
    const a = await userOf(SUB_A);
    const h = await home(a, "deleted", "paid");
    const deletedAt = Date.UTC(2026, 9, 3, 9, 0);
    await env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES ('od',?,3,?,'deleted','{}',?)`).bind(h, a, deletedAt).run();
    await env.DB.prepare(`INSERT INTO backup_subaccounts (home_id,resource_generation,box_id,subaccount_id,username,server,directory,created_at,deleted_at)
      VALUES (?,1,1,'s','u','srv','d',?,?)`).bind(h, T - 9e6, Date.UTC(2026, 9, 1, 9, 0)).run();
    const r = (await (await call("/v1/account/deletion", await token(SUB_A, false))).json<{ deletion: { backups: Record<string, unknown>; backupsPurgedAt: number } }>()).deletion;
    expect(r.backups).toEqual({ status: "purged", purgedAt: Date.UTC(2026, 9, 1, 9, 0), verifiedPurgedBy: deletedAt });
    expect(r.backupsPurgedAt).toBe(deletedAt);
    expect(String((await deletionNoticeData(env, h, T)).emailText)).toContain("purged by 2026-10-03");
  });
});

describe("Astra round 4", () => {
  const P = PRICES;
  const S = Math.floor(T / 1000);
  const adj = { start: S, end: S + 20 * 86_400 };
  const next = { start: S + 29 * 86_400, end: S + 59 * 86_400 };
  const line = (price: string, amount: number, proration: boolean, period: { start: number; end: number }) => ({ id: `il_${price}_${amount}`, amount,
    pricing: { price_details: { price } }, period, parent: { type: "subscription_item_details", subscription_item_details: { proration, subscription: "sub_1", subscription_item: "si_1" } } });
  async function paying() {
    const a = await userOf(SUB_A);
    const h = await home(a, "ready", "paid");
    const c = await consent(h, a, { completed_at: T, confirmation_sent_at: T, stripe_subscription_id: "sub_1" });
    await subscription(h, { subscription_id: "sub_1", status: "active", plan: "starter", consent_id: c, first_invoice_id: "in_first", first_paid_at: T - 86_400_000,
      current_period_start: T - 86_400_000, current_period_end: T + 29 * 86_400_000 });
    const grants: Record<string, unknown>[] = [];
    const flux = { stub: false, capabilities: { reversalTargets: true } as const, async grantMonthlyCredits(_e: Env, i: Record<string, unknown>) { grants.push(i); }, async changePlan() {}, async stopForBilling() {},
      async usedIncludedCreditMicrocents() { return { usedMicrocents: 0 }; }, async setAutoRecharge() {}, async revokeCredits() {} };
    return { h, grants, flux };
  }
  const inv = (type: string, id: string, lines: unknown[], o: Record<string, unknown> = {}) => ({ id: `evt_test${id.replace(/_/g, "")}${type.length}x`, type, created: S,
    data: { object: { id, object: "invoice", customer: "cus_1", subscription: "sub_1", billing_reason: "manual", status: type === "invoice.paid" ? "paid" : "open",
      amount_paid: type === "invoice.paid" ? 1 : 0, lines: { data: lines }, ...o } } });
  const inbox = (h: string) => env.DB.prepare("SELECT payload FROM cloud_payment_inbox WHERE home_id=?").bind(h).all<{ payload: string }>()
    .then((r) => r.results.map((x) => (JSON.parse(x.payload) as { status: string }).status));

  it("a failed adjustment never makes the paid subscription past_due or starts grace (P1-1)", async () => {
    const { h, flux } = await paying();
    planFlag = "";
    expect((await webhook(inv("invoice.payment_failed", "in_adjf_1", [line(P.STRIPE_PRICE_STARTER, -1500, true, adj), line(P.STRIPE_PRICE_PRO, 2500, true, adj)]), { flux })).status).toBe(200);
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions WHERE home_id=?").bind(h).first()).toEqual({ status: "active" });
    expect(await inbox(h)).toEqual([]);
    expect(await env.DB.prepare("SELECT kind FROM cloud_alerts WHERE home_id=? AND kind='billing.adjustment_payment_failed'").bind(h).first()).toBeTruthy();
  });

  it("a paid one-cent adjustment never reactivates a home whose renewal failed (P1-1)", async () => {
    const { h, grants, flux } = await paying();
    expect((await webhook(inv("invoice.payment_failed", "in_rnf_1", [line(P.STRIPE_PRICE_STARTER, 4900, false, next)], { billing_reason: "subscription_cycle" }), { flux })).status).toBe(200);
    expect(await inbox(h)).toEqual(["payment_problem"]);
    expect((await webhook(inv("invoice.paid", "in_cent_1", [line(P.STRIPE_PRICE_STARTER, 1, true, adj)]), { flux })).status).toBe(200);
    expect(await inbox(h)).toEqual(["payment_problem"]);
    expect(await env.DB.prepare("SELECT status FROM billing_subscriptions WHERE home_id=?").bind(h).first()).toEqual({ status: "past_due" });
    expect(grants).toEqual([]);
  });

  it("classifies from ALL invoice lines: a renewal on a later page is found; an unreadable page leaves the event retryable (P2-3)", async () => {
    const { h, grants, flux } = await paying();
    const firstPage = Array.from({ length: 10 }, (_, i) => line(P.STRIPE_PRICE_STARTER, i % 2 ? -100 : 100, true, adj));
    const all = [...firstPage, line(P.STRIPE_PRICE_STARTER, 4900, false, next)];
    linePages = { in_pg_2: "fail" };
    expect((await webhook(inv("invoice.paid", "in_pg_2", firstPage, { lines: { data: firstPage, has_more: true }, amount_paid: 4900 }), { flux })).status).toBe(500);
    expect(grants).toEqual([]);
    linePages = { in_pg_1: { data: all } };
    expect((await webhook(inv("invoice.paid", "in_pg_1", firstPage, { lines: { data: firstPage, has_more: true }, amount_paid: 4900 }), { flux })).status).toBe(200);
    expect(grants).toEqual([{ homeId: h, plan: "starter", invoiceId: "in_pg_1", periodStart: next.start * 1000, periodEnd: next.end * 1000 }]);
    expect(calls.some((c) => c.path === "/v1/invoices/in_pg_1/lines")).toBe(true);
  });

  it("flag-off draining keeps an acknowledged ACPI shutdown outstanding and powers the server back on when it completes (P1-2)", async () => {
    const a = await userOf(SUB_A);
    const h = await home(a, "ready", "paid");
    await env.DB.prepare(`INSERT INTO cloud_home_health (home_id,reported_at,last_backup_at) VALUES (?,?,?)`).bind(h, T, T).run();
    await env.DB.prepare(`INSERT INTO plan_resizes (id,home_id,generation,resource_generation,from_plan,to_plan,state,server_id,from_type,target_type,next_at,step_at,created_at,updated_at)
      VALUES ('j1',?,1,1,'starter','pro','snapshotted','srv-1','cx23','cx33',0,?,?,?)`).bind(h, T, T, T).run();
    let status = "running"; const ops: string[] = [];
    const host: ResizeHost = {
      async findServer() { return null; }, async server() { return { status, type: "cx23" }; },
      async snapshot() { ops.push("snapshot"); return { imageId: "i", actionId: "a" }; }, async image() { return "available"; },
      async shutdown() { ops.push("shutdown"); return "a-off"; }, // acknowledged; the server keeps running for now (ACPI)
      async forceOff() { ops.push("forceoff"); return "a"; }, async powerOn() { ops.push("poweron"); status = "running"; return "a-on"; },
      async changeType() { ops.push("change"); return "a"; }, async action() { return "success"; },
    };
    let clock = T;
    const sweep = async () => { clock += 61_000; await sweepPlanResizes(testEnv(), { resizeHost: host, now: () => clock, stripeFetch }); };
    await sweep();
    expect(await env.DB.prepare("SELECT state,shutdown_sent_at AS m FROM plan_resizes WHERE id='j1'").first()).toEqual({ state: "powering_off", m: clock });
    planFlag = "";
    await sweep(); await sweep(); await sweep();
    expect((await env.DB.prepare("SELECT state FROM plan_resizes WHERE id='j1'").first<{ state: string }>())!.state).toBe("recovering");
    status = "off"; // the ACPI shutdown completes late
    await sweep(); await sweep();
    expect(ops).toEqual(["shutdown", "poweron"]);
    expect(status).toBe("running");
    expect(await env.DB.prepare("SELECT state,shutdown_sent_at AS m FROM plan_resizes WHERE id='j1'").first()).toEqual({ state: "failed", m: null });
  });

  it("the deletion is dated after the awaited purge completed, not when the sweep started (P2-4)", async () => {
    const a = await userOf(SUB_A);
    const h = await home(a, "deleting", "paid");
    await env.DB.prepare("UPDATE cloud_homes SET dns_removed_at=? WHERE id=?").bind(Date.now() - 120_000, h).run();
    let purgedAt = 0;
    const provider = (db: D1Database) => ({ ...fakeProvider(db), async purge_snapshots() { await new Promise((r) => setTimeout(r, 40)); purgedAt = Date.now(); } });
    const ctx = createExecutionContext();
    const res = await createWorker(fetch, fetch, { provider }, {}, deps()).fetch(new Request("https://admin.murage.test/v1/fake-b3/reconcile", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-only-members-admin" }, body: "{}" }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBeLessThan(300);
    const done = await env.DB.prepare("SELECT created_at FROM cloud_outbox WHERE home_id=? AND kind='deleted'").bind(h).first<{ created_at: number }>();
    expect(purgedAt).toBeGreaterThan(0);
    expect(done!.created_at).toBeGreaterThanOrEqual(purgedAt);
  });

  describe("Astra round 5", () => {
    type HostState = { status: string; clock: number; ops: string[] };
    async function drainingWithOutstandingShutdown(over: (st: HostState) => Partial<ResizeHost> = () => ({})) {
      const a = await userOf(SUB_A);
      const h = await home(a, "ready", "paid");
      await env.DB.prepare(`INSERT INTO cloud_home_health (home_id,reported_at,last_backup_at) VALUES (?,?,?)`).bind(h, T, T).run();
      await env.DB.prepare(`INSERT INTO plan_resizes (id,home_id,generation,resource_generation,from_plan,to_plan,state,server_id,from_type,target_type,next_at,step_at,created_at,updated_at)
        VALUES ('j5',?,1,1,'starter','pro','snapshotted','srv-5','cx23','cx33',0,?,?,?)`).bind(h, T, T, T).run();
      const st = { status: "running", clock: T, ops: [] as string[] };
      const host: ResizeHost = {
        async findServer() { return null; }, async server() { return { status: st.status, type: "cx23" }; },
        async snapshot() { st.ops.push("snapshot"); return { imageId: "i", actionId: "a" }; }, async image() { return "available"; },
        async shutdown() { st.ops.push("shutdown"); return "a-off"; }, // acknowledged; the server keeps running (ACPI)
        async forceOff() { st.ops.push("forceoff"); return "a"; }, async powerOn() { st.ops.push("poweron"); st.status = "running"; return "a-on"; },
        async changeType() { st.ops.push("change"); return "a"; }, async action() { return "success"; }, ...over(st),
      };
      const sweep = async (step = 61_000) => { st.clock += step; await sweepPlanResizes(testEnv(), { resizeHost: host, now: () => st.clock, stripeFetch }); };
      await sweep();
      expect(st.ops).toEqual(["shutdown"]);
      planFlag = "";
      await sweep();
      const row = () => env.DB.prepare("SELECT state,last_error AS e,shutdown_sent_at AS m,next_at AS n FROM plan_resizes WHERE id='j5'")
        .first<{ state: string; e: string | null; m: number | null; n: number }>();
      const alerts = () => env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE home_id=? AND kind='plan.resize_shutdown_outstanding'").bind(h).first<{ n: number }>();
      const alertsOf = (kind: string) => env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE home_id=? AND kind=?").bind(h, kind).first<{ n: number }>().then((r) => r!.n);
      return { h, st, sweep, row, alerts, alertsOf };
    }

    it("past the 12-minute watch the shutdown stays outstanding: alert once, keep reconciling, power back on when it completes late (P1)", async () => {
      const { st, sweep, row, alerts } = await drainingWithOutstandingShutdown();
      const sentAt = (await row())!.m;
      expect(sentAt).not.toBeNull();
      for (let i = 0; i < 20; i++) await sweep(); // ~20 minutes, well past SHUTDOWN_WATCH_MS, server still running
      expect(await row()).toMatchObject({ state: "recovering", e: "shutdown_watch_expired", m: sentAt });
      expect((await alerts())!.n).toBe(1);
      st.status = "off"; // the ACPI shutdown completes late
      await sweep(); await sweep();
      expect(st.ops).toEqual(["shutdown", "poweron"]);
      expect(st.status).toBe("running");
      expect(await row()).toMatchObject({ state: "failed", m: null });
    });

    it("never terminal on time alone: after days running, it rechecks every 15 minutes and still restores a late shutdown (P1)", async () => {
      const { st, sweep, row, alerts } = await drainingWithOutstandingShutdown();
      for (let i = 0; i < 15; i++) await sweep();
      await sweep(3 * 24 * 3_600_000); // three days on, the server has kept running
      const r = (await row())!;
      expect(r).toMatchObject({ state: "recovering", e: "shutdown_watch_expired" });
      expect(r.m).not.toBeNull();
      expect(r.n - st.clock).toBe(15 * 60_000);
      expect((await alerts())!.n).toBe(1);
      st.status = "off";
      await sweep(15 * 60_000); await sweep();
      expect(st.ops).toEqual(["shutdown", "poweron"]);
      expect(await row()).toMatchObject({ state: "failed", m: null });
    });

    it("round 6: a power-on whose action ends in error is never terminal; it alerts, reconciles and restores once the provider recovers (P1)", async () => {
      let failing = true;
      const { st, sweep, row, alertsOf } = await drainingWithOutstandingShutdown((s) => ({
        async powerOn() { s.ops.push("poweron"); if (!failing) s.status = "running"; return failing ? "a-on-bad" : "a-on"; },
        async action(id: string) { return id === "a-on-bad" ? "error" : "success"; },
      }));
      st.status = "off"; // the acknowledged shutdown completes
      await sweep(); // recovering: off -> power on (journaled)
      expect(st.ops).toEqual(["shutdown", "poweron"]);
      await sweep(); // the power-on action ends in error, the server is still off
      expect(await row()).toMatchObject({ state: "restoring" });
      expect((await row())!.m).not.toBeNull();
      expect(await alertsOf("plan.resize_power_on_failed")).toBe(1);
      // Three days of daily sweeps with the provider still failing: never terminal, the server is reconciled and powered on again each time.
      for (let d = 0; d < 3; d++) { await sweep(24 * 3_600_000); await sweep(31 * 60_000); await sweep(31 * 60_000); }
      expect(["recovering", "restoring"]).toContain((await row())!.state);
      expect((await row())!.m).not.toBeNull();
      expect(st.ops.filter((o) => o === "poweron").length).toBeGreaterThan(2);
      expect(await alertsOf("plan.resize_power_on_failed")).toBe(1); // one open alert, not one per retry
      failing = false; // the provider recovers
      for (let i = 0; i < 4 && (await row())!.state !== "failed"; i++) await sweep(31 * 60_000);
      expect(st.status).toBe("running");
      expect(await row()).toMatchObject({ state: "failed", m: null });
      expect((await row())!.e).toMatch(/^resize_failed_server_restarted:/);
    });

    it("round 6: host configuration temporarily unavailable is never terminal; restored config and a late shutdown still power it back on (P1)", async () => {
      const { st, sweep, row, alertsOf } = await drainingWithOutstandingShutdown();
      expect((await row())!.state).toBe("recovering");
      const unconfigured = async (step: number) => { st.clock += step;
        await sweepPlanResizes({ ...testEnv(), HCLOUD_TOKEN: undefined } as unknown as Env, { now: () => st.clock, stripeFetch }); };
      for (let d = 0; d < 3; d++) { await unconfigured(31 * 60_000); await unconfigured(24 * 3_600_000); }
      expect(await row()).toMatchObject({ state: "recovering" });
      expect((await row())!.m).not.toBeNull();
      expect(await alertsOf("plan.resize_provider_unconfigured")).toBe(1);
      expect(st.ops).toEqual(["shutdown"]);
      // Configuration is back and the delayed ACPI shutdown completes: recovery powers the server back on and verifies it.
      st.status = "off";
      for (let i = 0; i < 4 && (await row())!.state !== "failed"; i++) await sweep(31 * 60_000);
      expect(st.ops).toEqual(["shutdown", "poweron"]);
      expect(st.status).toBe("running");
      expect(await row()).toMatchObject({ state: "failed", m: null });
    });

    it("round 6: an unconfigured provider still lets a lifecycle that powers the home off take the server over (P1)", async () => {
      const { h, st, row } = await drainingWithOutstandingShutdown();
      await env.DB.prepare("UPDATE cloud_homes SET desired_state='stopped' WHERE id=?").bind(h).run();
      st.clock += 61_000;
      await sweepPlanResizes({ ...testEnv(), HCLOUD_TOKEN: undefined } as unknown as Env, { now: () => st.clock, stripeFetch });
      expect(await row()).toMatchObject({ state: "failed", e: "left_off_lifecycle_stopped" });
    });

    it("a lifecycle that powers the home off itself ends the watch without restoring it (P1)", async () => {
      const { h, st, sweep, row } = await drainingWithOutstandingShutdown();
      await env.DB.prepare("UPDATE cloud_homes SET desired_state='stopped' WHERE id=?").bind(h).run();
      await sweep();
      expect(await row()).toMatchObject({ state: "failed", e: "left_off_lifecycle_stopped" });
      expect(st.ops).toEqual(["shutdown"]);
    });

    it("a paid renewal fully covered by customer credit grants its month and moves the period; a $0 adjustment still grants nothing (P2)", async () => {
      const { h, grants, flux } = await paying();
      expect((await webhook(inv("invoice.paid", "in_credit_1", [line(P.STRIPE_PRICE_STARTER, 4900, false, next)],
        { billing_reason: "subscription_cycle", amount_paid: 0, amount_due: 0, total: 4900, starting_balance: -4900, ending_balance: 0 }), { flux })).status).toBe(200);
      expect(grants).toEqual([{ homeId: h, plan: "starter", invoiceId: "in_credit_1", periodStart: next.start * 1000, periodEnd: next.end * 1000 }]);
      expect(await env.DB.prepare("SELECT current_period_start AS s,current_period_end AS e,status FROM billing_subscriptions WHERE home_id=?").bind(h).first())
        .toEqual({ s: next.start * 1000, e: next.end * 1000, status: "active" });
      expect((await webhook(inv("invoice.paid", "in_credit_adj", [line(P.STRIPE_PRICE_STARTER, -1500, true, adj), line(P.STRIPE_PRICE_PRO, 2500, true, adj)],
        { amount_paid: 0, amount_due: 0 }), { flux })).status).toBe(200);
      expect(grants).toHaveLength(1);
      expect(await env.DB.prepare("SELECT current_period_start AS s FROM billing_subscriptions WHERE home_id=?").bind(h).first()).toEqual({ s: next.start * 1000 });
    });
  });
});

describe("Astra TAXCOUNTRY-5: Finish checkout and the interrupted-attempt replay follow the pointer; a rewritable customer is replaced by a new one, never re-addressed", () => {
  // Changed from rounds 1-5 (which updated cus_1's address): the expectations now are a NEW customer (cus_new1) created with the consent's
  // location, the session naming it, cus_1 untouched, and a saved attempt frozen on cus_1 treated as made before the move.
  const post = (path: string) => calls.filter((x) => x.method === "POST" && x.path === path);
  const creates = () => post("/v1/customers");
  const resume = async () => call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
  const pointer = async (h: string) => (await env.DB.prepare("SELECT customer_id FROM billing_subscriptions WHERE home_id=?").bind(h).first<{ customer_id: string }>())!.customer_id;
  const berlin = { address: { country: "DE", postal_code: "10115", line1: "Unter den Linden 1", city: "Berlin" } };
  afterEach(() => { expect(cust.violations).toEqual([]); expect(calls.filter((x) => x.method === "POST" && x.path.startsWith("/v1/customers/"))).toEqual([]); });
  async function expiredTh() {
    const a = await userOf(SUB_A);
    const h = await home(a, "payment_pending");
    const c = await consent(h, a); // US (the archived Stripe page's country), no postal code
    await taxQuote(`quote-${h}`, a, 5300);
    await subscription(h, { status: "checkout_created", consent_id: c });
    await openCheckout(h, c, "open", T - 1000);
    cust.customers.cus_1 = structuredClone(berlin);
    return { a, h, c };
  }

  it("resume: the stale DE customer is replaced by a NEW customer at the consent's US location (whole address) before the fresh session, which names it", async () => {
    const { h } = await expiredTh();
    expect((await call("/v1/billing/checkout/resume", await token(SUB_A, true), {})).status).toBe(200);
    const [c] = creates(), [s] = post("/v1/checkout/sessions");
    expect(c.form.get("address[country]")).toBe("US");
    expect(c.form.has("address[postal_code]")).toBe(false);
    expect(cust.customers.cus_new1.address).toEqual({ country: "US" });
    expect(cust.customers.cus_1).toEqual(berlin);
    expect(s.form.get("customer")).toBe("cus_new1");
    expect(await pointer(h)).toBe("cus_new1");
    expect(calls.indexOf(c)).toBeLessThan(calls.indexOf(s));
  });

  it("resume: a failed preset refuses with 503 checkout_unavailable and creates no session and no customer", async () => {
    await expiredTh();
    cust.getFails = 5;
    const res = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
    expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([503, "checkout_unavailable"]);
    expect(post("/v1/checkout/sessions")).toEqual([]);
    expect(creates()).toEqual([]);
  });

  it("Astra TAXCOUNTRY-2 P2: resume of a pre-fix OPEN session on the stale DE customer: a new customer first, that session expired, a fresh one issued on the new customer", async () => {
    const { c } = await expiredTh();
    await env.DB.prepare("UPDATE open_checkouts SET expires_at=? WHERE consent_id=?").bind(T + 50 * 60_000, c).run();
    const res = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
    expect([res.status, await res.json()]).toEqual([200, expect.objectContaining({ sessionId: "cs_test_new", reused: false })]);
    const [cr] = creates(), [x] = post("/v1/checkout/sessions/cs_test_old/expire"), [s] = post("/v1/checkout/sessions");
    expect(calls.indexOf(cr)).toBeLessThan(calls.indexOf(x));
    expect(calls.indexOf(x)).toBeLessThan(calls.indexOf(s));
    expect(s.form.get("customer")).toBe("cus_new1");
  });

  it("Astra TAXCOUNTRY-2 P2: resume of an open session whose customer is already at the declared location returns it unchanged", async () => {
    const { c } = await expiredTh();
    cust.customers.cus_1 = { address: { country: "US" } };
    await env.DB.prepare("UPDATE open_checkouts SET expires_at=? WHERE consent_id=?").bind(T + 50 * 60_000, c).run();
    const res = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
    expect([res.status, await res.json()]).toEqual([200, expect.objectContaining({ sessionId: "cs_test_old", reused: true })]);
    expect(calls.filter((x) => x.method === "POST")).toEqual([]);
  });

  it("Astra TAXCOUNTRY-2 P2: an interrupted replacement attempt frozen on the old customer with under 31 minutes left: reconciled on ITS customer, its session expired, a fresh attempt on the new customer", async () => {
    const { h, c } = await expiredTh();
    const id = "resume-attempt-1", expiresAt = T + 20 * 60_000;
    await env.DB.prepare(`INSERT INTO checkout_resume_attempts (id,home_id,consent_id,expires_at,payload,state,created_at,idempotency_key) VALUES (?,?,?,?,?,'creating',?,?)`)
      .bind(id, h, c, expiresAt, JSON.stringify({ customerId: "cus_1", homeId: h, plan: "starter", priceId: PRICES.STRIPE_PRICE_STARTER, consentId: c, renewalSha256: "a".repeat(64),
        issuanceId: `resume:${id}`, expiresAtSeconds: Math.floor(expiresAt / 1000) }), T - 40 * 60_000, `resume:${id}`).run();
    listed = [{ id: "cs_attempt", url: "https://checkout.stripe.test/c/cs_attempt", status: "open", subscription: null, expires_at: Math.floor(expiresAt / 1000),
      metadata: { consent_id: c, home_id: h } }];
    const res = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
    expect([res.status, await res.json()]).toEqual([200, expect.objectContaining({ sessionId: "cs_test_new" })]);
    const [cr] = creates(), [x] = post("/v1/checkout/sessions/cs_attempt/expire"), [s] = post("/v1/checkout/sessions");
    expect(calls.indexOf(cr)).toBeLessThan(calls.indexOf(x));
    expect(calls.indexOf(x)).toBeLessThan(calls.indexOf(s));
    expect(s.key).not.toBe(`resume:${id}`);
    expect(s.form.get("customer")).toBe("cus_new1");
    // the frozen attempt was reconciled on the customer it was made for
    expect(calls.some((x) => x.method === "GET" && x.path === "/v1/checkout/sessions")).toBe(true);
    expect(await env.DB.prepare("SELECT state,session_id FROM checkout_resume_attempts WHERE id=?").bind(id).first()).toEqual({ state: "abandoned", session_id: "cs_attempt" });
  });

  async function frozenStepUp(o: Record<string, unknown> = {}) {
    const a = await userOf(SUB_A);
    const h = await home(a, "payment_pending");
    const c = await consent(h, a, { session_inflight_at: T - 20 * 60_000, session_issuance_id: `checkout:consent-${h}`, ...o });
    await taxQuote(`quote-${h}`, a, 5300);
    await subscription(h, { status: "checkout_created", consent_id: c });
    await openCheckout(h, c, "failed", T + 40 * 60_000, null);
    const id = `stepup-checkout:intent-${h}`, expiresAt = T + 40 * 60_000;
    await env.DB.prepare(`INSERT INTO checkout_resume_attempts (id,home_id,consent_id,expires_at,payload,state,created_at,stripe_price_id,idempotency_key) VALUES (?,?,?,?,?,'creating',?,?,?)`)
      .bind(id, h, c, expiresAt, JSON.stringify({ customerId: "cus_1", homeId: h, plan: "starter", priceId: PRICES.STRIPE_PRICE_STARTER, consentId: c, renewalSha256: "a".repeat(64),
        locale: "de", issuanceId: `checkout:${c}`, expiresAtSeconds: Math.floor(expiresAt / 1000), successUrl: "https://app.murage.test/ok", cancelUrl: "https://app.murage.test/no",
        submitLinks: { terms: "https://murage.test/terms", tos: "https://murage.test/tos", privacy: "https://murage.test/privacy" } }),
        T - 20 * 60_000, PRICES.STRIPE_PRICE_STARTER, `checkout:${c}`).run();
    cust.customers.cus_1 = { address: { country: "DE", postal_code: "10115", city: "Berlin" } };
    return { h, c, id };
  }

  it("replay of an interrupted step-up attempt frozen on the old customer: nothing is dispatched until the preset succeeded; then its session (on the old customer) is expired, the attempt closed as relocated, and a fresh session names the new customer", async () => {
    const { h, c, id } = await frozenStepUp(); // a US consent, its customer on DE
    cust.getFails = 5;
    const failed = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
    expect([failed.status, (await failed.json<{ error: string }>()).error]).toEqual([503, "checkout_unavailable"]);
    expect(post("/v1/checkout/sessions")).toEqual([]);
    cust.getFails = 0;
    await env.DB.prepare("UPDATE open_checkouts SET updated_at=? WHERE home_id=?").bind(T - 120_000, h).run();
    calls = [];
    const res = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
    expect([res.status, await res.clone().json()]).toEqual([200, expect.anything()]);
    const [cr] = creates(), [s1, s2] = post("/v1/checkout/sessions");
    expect(cust.customers.cus_new1.address).toEqual({ country: "US" });
    expect([s1.key, s1.form.get("customer")]).toEqual([`checkout:${c}`, "cus_1"]); // the frozen request, as saved
    expect(s2.form.get("customer")).toBe("cus_new1");
    expect(calls.indexOf(cr)).toBeLessThan(calls.indexOf(s1));
    expect(post(`/v1/checkout/sessions/cs_test_new/expire`)).toHaveLength(1);
    expect(await env.DB.prepare("SELECT state FROM checkout_resume_attempts WHERE id=?").bind(id).first()).toEqual({ state: "relocated" });
    expect(cust.customers.cus_1.address).toEqual({ country: "DE", postal_code: "10115", city: "Berlin" });
  });

  it("Astra TAXCOUNTRY-3 P2-a/#6: replay of a step-up attempt whose session Stripe made EARLIER: expired, never handed back, and a fresh session on the new customer in the same request", async () => {
    const { h, c, id } = await frozenStepUp();
    sessionReplayed = true;
    const res = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
    expect([res.status, await res.json()]).toEqual([200, expect.objectContaining({ sessionId: "cs_test_new", reused: false })]);
    const [cr] = creates(), [x] = post("/v1/checkout/sessions/cs_test_new/expire"), [s1, s2] = post("/v1/checkout/sessions");
    expect(s1.key).toBe(`checkout:${c}`);
    expect(s2.key).toMatch(/^resume:/);
    expect(s2.form.get("customer")).toBe("cus_new1");
    expect(calls.indexOf(cr)).toBeLessThan(calls.indexOf(s1));
    expect(calls.indexOf(x)).toBeLessThan(calls.indexOf(s2));
    expect(await env.DB.prepare("SELECT state,session_id FROM checkout_resume_attempts WHERE id=?").bind(id).first()).toEqual({ state: "relocated", session_id: "cs_test_new" });
    expect(await env.DB.prepare("SELECT state FROM open_checkouts WHERE home_id=?").bind(h).first()).toEqual({ state: "open" });
    expect(await env.DB.prepare("SELECT 1 FROM cloud_ops_state WHERE key=?").bind(`tax_relocated:${h}`).first()).toBeNull();
  });

  it("Astra TAXCOUNTRY-3 P2-a: the relocation is DURABLE: the old session's expiry failing refuses (503) with the pointer already moved; the next request (nothing to create) still expires it first and issues on the new customer", async () => {
    const { h, c } = await expiredTh();
    await env.DB.prepare("UPDATE open_checkouts SET expires_at=? WHERE consent_id=?").bind(T + 50 * 60_000, c).run();
    listed = [{ id: "cs_test_old", url: "https://checkout.stripe.test/c/cs_test_old", status: "open", subscription: null, metadata: { consent_id: c, home_id: h } }];
    expireFails = 1;
    const first = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
    expect([first.status, (await first.json<{ error: string }>()).error]).toEqual([503, "checkout_unavailable"]);
    expect(await pointer(h)).toBe("cus_new1");
    expect(post("/v1/checkout/sessions")).toEqual([]);
    expect(JSON.parse((await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key=?").bind(`tax_relocated:${h}`).first<{ value: string }>())!.value))
      .toMatchObject({ customerId: "cus_new1", from: ["cus_1"] });
    calls = [];
    const res = await call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
    expect([res.status, await res.json()]).toEqual([200, expect.objectContaining({ sessionId: "cs_test_new", reused: false })]);
    expect(creates()).toEqual([]);
    const [x] = post("/v1/checkout/sessions/cs_test_old/expire"), [s] = post("/v1/checkout/sessions");
    expect(calls.indexOf(x)).toBeLessThan(calls.indexOf(s));
    expect(s.form.get("customer")).toBe("cus_new1");
    expect(await env.DB.prepare("SELECT 1 FROM cloud_ops_state WHERE key=?").bind(`tax_relocated:${h}`).first()).toBeNull();
  });

  it("expiry vs completion (expiry first): the session made before the move is expired, then a fresh one issued: exactly one payable session, and a payment on the expired one is refused (Stripe: an expired session cannot be completed)", async () => {
    const a = await userOf(SUB_A);
    const h = await home(a, "payment_pending");
    const c = await consent(h, a);
    await taxQuote(`quote-${h}`, a, 5300);
    await subscription(h, { status: "checkout_created", consent_id: c });
    await openCheckout(h, c, "open", T + 50 * 60_000, "cs_test_old");
    cust.customers.cus_1 = { address: { country: "DE", postal_code: "10115" } };
    trackSessions = true;
    listed = [{ id: "cs_test_old", url: "https://checkout.stripe.test/c/cs_test_old", status: "open", subscription: null, metadata: { consent_id: c, home_id: h } }];
    const res = await resume();
    expect([res.status, await res.json()]).toEqual([200, expect.objectContaining({ sessionId: "cs_test_new" })]);
    expect(listed.filter((x) => x.status === "open").map((x) => x.id)).toEqual(["cs_test_new"]);
    const payStripePage = (id: string) => { const t = listed.find((x) => x.id === id)!; if (t.status !== "open") return "refused"; t.status = "complete"; return "paid"; };
    expect(payStripePage("cs_test_old")).toBe("refused");
    expect(payStripePage("cs_test_new")).toBe("paid");
  });

  it("expiry vs completion (payment first): the customer completes the old session just as it would be expired: no second payable session is issued (409 checkout_completed)", async () => {
    const a = await userOf(SUB_A);
    const h = await home(a, "payment_pending");
    const c = await consent(h, a);
    await taxQuote(`quote-${h}`, a, 5300);
    await subscription(h, { status: "checkout_created", consent_id: c });
    await openCheckout(h, c, "open", T + 50 * 60_000, "cs_test_old");
    cust.customers.cus_1 = { address: { country: "DE", postal_code: "10115" } };
    trackSessions = true;
    const old = { id: "cs_test_old", url: "https://checkout.stripe.test/c/cs_test_old", status: "open", subscription: null as string | null, metadata: { consent_id: c, home_id: h } };
    listed = [old];
    cust.onCreate = async () => { old.status = "complete"; old.subscription = "sub_9"; }; // paid while the new customer is created
    const res = await resume();
    expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([409, "checkout_completed"]);
    expect(post("/v1/checkout/sessions")).toEqual([]);
    expect(listed.filter((x) => x.status === "open")).toEqual([]);
  });

  async function relocatedAttempt() {
    const a = await userOf(SUB_A);
    const h = await home(a, "payment_pending");
    const c = await consent(h, a, { session_inflight_at: T - 20 * 60_000, session_issuance_id: `checkout:consent-${h}` });
    await taxQuote(`quote-${h}`, a, 5300);
    await subscription(h, { status: "checkout_created", consent_id: c });
    await openCheckout(h, c, "failed", T + 40 * 60_000, null);
    const id = `stepup-checkout:intent-${h}`, expiresAt = T + 40 * 60_000;
    await env.DB.prepare(`INSERT INTO checkout_resume_attempts (id,home_id,consent_id,expires_at,payload,state,created_at,stripe_price_id,idempotency_key) VALUES (?,?,?,?,?,'creating',?,?,?)`)
      .bind(id, h, c, expiresAt, JSON.stringify({ customerId: "cus_1", homeId: h, plan: "starter", priceId: PRICES.STRIPE_PRICE_STARTER, consentId: c, renewalSha256: "a".repeat(64),
        locale: "en", issuanceId: `checkout:${c}`, expiresAtSeconds: Math.floor(expiresAt / 1000), successUrl: "https://app.murage.test/ok", cancelUrl: "https://app.murage.test/no",
        submitLinks: { terms: "https://murage.test/terms", tos: "https://murage.test/tos", privacy: "https://murage.test/privacy" } }),
        T - 20 * 60_000, PRICES.STRIPE_PRICE_STARTER, `checkout:${c}`).run();
    cust.customers.cus_1 = { address: { country: "DE", postal_code: "10115", city: "Berlin" } };
    return { h, c, id };
  }

  it("a crash in the relocated-attempt fallback before the attempt is closed: the next request recovers (closes it as relocated, one fresh session)", async () => {
    const { h, id } = await relocatedAttempt();
    sessionReplayed = true;
    await env.DB.prepare("CREATE TRIGGER crash_relocated BEFORE UPDATE OF state ON checkout_resume_attempts WHEN NEW.state='relocated' BEGIN SELECT RAISE(ABORT, 'crash'); END").run();
    try { expect((await resume()).status).toBeGreaterThanOrEqual(500); }
    finally { await env.DB.prepare("DROP TRIGGER IF EXISTS crash_relocated").run(); }
    expect(await env.DB.prepare("SELECT state FROM checkout_resume_attempts WHERE id=?").bind(id).first()).toEqual({ state: "creating" });
    calls = [];
    sessionReplayed = true;
    const res = await resume();
    expect([res.status, await res.json()]).toEqual([200, expect.objectContaining({ sessionId: "cs_test_new", reused: false })]);
    expect(await env.DB.prepare("SELECT state FROM checkout_resume_attempts WHERE id=?").bind(id).first()).toEqual({ state: "relocated" });
    expect(await env.DB.prepare("SELECT state FROM open_checkouts WHERE home_id=?").bind(h).first()).toEqual({ state: "open" });
    expect(post("/v1/checkout/sessions").filter((p) => p.key?.startsWith("resume:"))).toHaveLength(1);
  });

  it("a crash in the relocated-attempt fallback after the attempt is closed (the fresh session's creation fails): the next request issues it", async () => {
    const { h, id } = await relocatedAttempt();
    sessionReplayed = true;
    failCreateAt = 2; // the replay of the attempt answers; the fresh session's creation fails
    expect((await resume()).status).toBeGreaterThanOrEqual(500);
    expect(await env.DB.prepare("SELECT state FROM checkout_resume_attempts WHERE id=?").bind(id).first()).toEqual({ state: "relocated" });
    calls = [];
    const res = await resume();
    expect([res.status, await res.json()]).toEqual([200, expect.objectContaining({ sessionId: "cs_test_new", reused: false })]);
    expect(post("/v1/checkout/sessions").map((p) => p.key?.split(":")[0])).toEqual(["resume"]);
    expect(await env.DB.prepare("SELECT state FROM open_checkouts WHERE home_id=?").bind(h).first()).toEqual({ state: "open" });
  });
});

describe("Astra TAXCOUNTRY-5 P2-1: a rejected (and refunded) earlier session is not an outstanding purchase", () => {
  const resume = async () => call("/v1/billing/checkout/resume", await token(SUB_A, true), {});
  /** The verbatim sequence: a renewal-authorization rejection BEFORE attachSessionToConsent leaves the first consent rejected_at set and
   *  completed_at NULL; its cancellation/refund completes; the member's fresh checkout changes the ZIP, which moves the home to a new customer
   *  and records the relocation. The relocation helper then lists the old customer's sessions and finds the historical COMPLETE session. */
  async function rejectedThenNewZip(refundEvidence: boolean) {
    const a = await userOf(SUB_A);
    const h = await home(a, "payment_pending");
    const rejected = await consent(h, a, { id: `consent-rej-${h}`, postal_code: "90210", rejected_at: T - 30 * 60_000, rejected_reason: "rejected_consent", completed_at: null });
    if (refundEvidence) await env.DB.prepare("INSERT INTO rejected_subscriptions (subscription_id,at,reason,home_id,cancel_pending) VALUES ('sub_rej',?,'rejected_consent',?,0)").bind(T - 29 * 60_000, h).run();
    const c = await consent(h, a, { postal_code: "10001" });
    await env.DB.prepare(`INSERT INTO tax_quotes (id,user_id,plan,country,postal_code,price_cents,tax_cents,total_cents,topup_amount_cents,source,created_at,expires_at)
      VALUES (?,?,'starter','US','10001',4900,400,5300,2000,'stripe_tax',?,?)`).bind(`quote-${h}`, a, T - 60_000, T + 3_600_000).run();
    await subscription(h, { status: "checkout_created", consent_id: c });
    await openCheckout(h, c, "open", T - 1000);
    // Checkout saved the rejected order's entered address on the customer; its subscription is cancelled (not live), nothing else held.
    cust.customers.cus_1 = { address: { country: "US", postal_code: "90210", line1: "1 Rodeo Dr", city: "Beverly Hills", state: "CA" } };
    listed = [{ id: "cs_rejected", status: "complete", subscription: "sub_rej", metadata: { consent_id: rejected, home_id: h } }];
    return { h, c };
  }
  it.each([[true], [false]])("rejection with refund evidence %s: the fresh checkout with the new ZIP issues (no 409 checkout_completed), and keeps issuing while the marker stands", async (refundEvidence) => {
    const { h } = await rejectedThenNewZip(refundEvidence);
    const first = await resume();
    expect([first.status, await first.json()]).toEqual([200, expect.objectContaining({ sessionId: "cs_test_new" })]);
    expect((await env.DB.prepare("SELECT customer_id FROM billing_subscriptions WHERE home_id=?").bind(h).first<{ customer_id: string }>())!.customer_id).toBe("cus_new1");
    // the marker stands again (a press after a new relocation, before the publication clears it): never a false checkout_completed
    await env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(`tax_relocated:${h}`, JSON.stringify({ customerId: "cus_new1", from: ["cus_1"], at: Date.now() })).run();
    await env.DB.prepare("UPDATE open_checkouts SET expires_at=? WHERE home_id=?").bind(T - 1000, h).run();
    calls = [];
    const again = await resume();
    expect(again.status).toBe(200);
  });
  it("an unsettled complete session (not rejected, not refunded, not recorded) is still a payment on its way: 409 checkout_completed", async () => {
    const { h } = await rejectedThenNewZip(false);
    await env.DB.prepare("UPDATE checkout_consents SET rejected_at=NULL,rejected_reason=NULL WHERE id=?").bind(`consent-rej-${h}`).run();
    const res = await resume();
    expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([409, "checkout_completed"]);
  });
});

describe("Astra TAXCOUNTRY-5 P2-2 and the orphan list: the customer-create sweep", () => {
  const rows = async () => (await env.DB.prepare("SELECT key,value FROM cloud_ops_state WHERE key LIKE 'tax_customer:%' ORDER BY key").all<{ key: string; value: string }>()).results;
  const orphanRows = async () => (await env.DB.prepare("SELECT key,value FROM cloud_ops_state WHERE key LIKE 'customer_orphan:%' ORDER BY key").all<{ key: string; value: string }>()).results;
  const cfg = { secretKey: "sk_test_fixturefixturefixture", apiVersion: "2025-03-31.basil" };
  const onHome = (h: string, work: (l: Parameters<Parameters<typeof withHomeLease>[2]>[0]) => Promise<void>) => withHomeLease(testEnv(), h, work).catch(() => undefined);
  beforeEach(async () => { await env.DB.prepare("DELETE FROM cloud_ops_state WHERE key LIKE 'tax_customer:%' OR key LIKE 'customer_orphan:%'").run(); });
  /** Journal rows of lost creates (no customer learnt), aged past TAX_DISPATCH_INFLIGHT_MS. */
  async function lostCreates(n: number) {
    const old = Date.now() - TAX_DISPATCH_INFLIGHT_MS - 60_000;
    const stmts: D1PreparedStatement[] = [];
    for (let i = 1; i <= n; i++) {
      const key = `checkout-customer:consent-s${i}:1`;
      stmts.push(env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES (?,?)").bind(`tax_customer:home-s${i}:${key}`, JSON.stringify({ homeId: `home-s${i}`,
        idempotencyKey: key, body: `metadata%5Bcheckout_attempt%5D=${encodeURIComponent(key)}&address%5Bcountry%5D=US`, createdAt: old + i, generation: 1,
        consentId: `consent-s${i}`, fromCustomerId: `cus_s${i}` })));
    }
    await env.DB.batch(stmts);
  }
  /** A Stripe whose create replays take `ms` each (or hang until aborted when ms is null), honouring the request's AbortSignal. */
  function slowStripe(ms: (n: number) => number | null) {
    const started: number[] = [];
    let n = 0;
    const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
      const i = ++n; started.push(Date.now());
      const d = ms(i);
      await new Promise<void>((resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) { reject(signal.reason); return; }
        const t = d === null ? null : setTimeout(resolve, d);
        signal?.addEventListener("abort", () => { if (t) clearTimeout(t); reject(signal.reason); }, { once: true });
      });
      return new Response(JSON.stringify({ id: `cus_orphan${i}`, object: "customer" }), { status: 200 });
    };
    return { started, stripeFor: (signal: AbortSignal) => stripeClient(cfg, fetcher, { signal }) };
  }

  it("a replay that takes almost the whole cap (59 of 60): the next call is NOT started; that row keeps its due time for the next run", async () => {
    await lostCreates(2);
    // scaled: a 3 s cap, the first replay takes 2 s, a call needs 1.5 s left to start (the 1 s of slack absorbs D1 and lease overhead)
    const s = slowStripe(() => 2_000);
    const t0 = Date.now();
    await sweepTaxDispatches(testEnv(), s.stripeFor, onHome, { budgetMs: 3_000, callMinMs: 1_500 });
    expect(s.started).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(3_500);
    const left = await rows();
    expect(left).toHaveLength(1);
    expect(JSON.parse(left[0].value).attempts ?? 0).toBe(0); // not tried in this run
    expect((await orphanRows()).map((r) => JSON.parse(r.value).customerId)).toEqual(["cus_orphan1"]);
  });

  it("a call still running at the cap is ABORTED there: the run ends on time, the row stays outstanding with its backoff stamped", async () => {
    await lostCreates(1);
    const s = slowStripe(() => null); // never answers
    const t0 = Date.now();
    await sweepTaxDispatches(testEnv(), s.stripeFor, onHome, { budgetMs: 300, callMinMs: 10 });
    const took = Date.now() - t0;
    expect(s.started).toHaveLength(1);
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(1_500);
    const [row] = await rows();
    expect(JSON.parse(row.value)).toMatchObject({ attempts: 1, nextAttemptAt: expect.any(Number) });
    expect(await orphanRows()).toEqual([]);
  });

  it("the scheduled invocation's deadline caps the run below the sweep's own budget (deps.sweepDeadline)", async () => {
    await lostCreates(1);
    const s = slowStripe(() => null);
    const t0 = Date.now();
    await sweepTaxDispatches(testEnv(), s.stripeFor, onHome, { deadline: Date.now() + 250, callMinMs: 10 });
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(s.started).toHaveLength(1);
    // a deadline already too close starts nothing at all
    const s2 = slowStripe(() => 1);
    await sweepTaxDispatches(testEnv(), s2.stripeFor, onHome, { deadline: Date.now() + 1_000 });
    expect(s2.started).toEqual([]);
  });

  it("Astra TAXCOUNTRY-6 P3: the awaited fence (a lease renewal) consumes the headroom: the headroom is checked again after it and Stripe is NOT started", async () => {
    await lostCreates(1);
    const s = slowStripe(() => 1);
    // a 2 s cap, a call needs 1.5 s left: the check before the fence passes, the fence takes 0.8 s
    await sweepTaxDispatches(testEnv(), s.stripeFor, onHome, { budgetMs: 2_000, callMinMs: 1_500,
      fence: async (e, l) => { await fence(e, l); await new Promise((r) => setTimeout(r, 800)); } });
    expect(s.started).toEqual([]);
    const [row] = await rows();
    expect(JSON.parse(row.value)).toMatchObject({ attempts: 1 }); // its backoff stamped; tried again by a later run
    expect(await orphanRows()).toEqual([]);
  });

  it("C2 review: a REFUSED replay (400) proves only that this request did not run: the row stays uncertain (backoff stamped), no orphan written, nothing dropped", async () => {
    await lostCreates(1);
    cust.nextCreate = "refused";
    await sweepBilling(testEnv(), deps()).catch(() => undefined);
    const [row] = await rows();
    expect(JSON.parse(row.value)).toMatchObject({ attempts: 1 });
    expect(await orphanRows()).toEqual([]);
  });

  it("a row that learnt its customer becomes an orphan record with no Stripe call; one past Stripe's key retention is recorded with the customer unknown, never replayed", async () => {
    const old = Date.now() - TAX_DISPATCH_INFLIGHT_MS - 60_000, ancient = Date.now() - 21 * 3_600_000;
    await env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES (?,?),(?,?)")
      .bind("tax_customer:home-k1:checkout-customer:consent-k1:1", JSON.stringify({ homeId: "home-k1", idempotencyKey: "checkout-customer:consent-k1:1", body: "x", createdAt: old,
        generation: 1, consentId: "consent-k1", fromCustomerId: "cus_a", customerId: "cus_known" }),
        "tax_customer:home-k2:checkout-customer:consent-k2:1", JSON.stringify({ homeId: "home-k2", idempotencyKey: "checkout-customer:consent-k2:1", body: "x", createdAt: ancient,
        generation: 1, consentId: "consent-k2", fromCustomerId: "cus_b" })).run();
    const s = slowStripe(() => 1);
    await sweepTaxDispatches(testEnv(), s.stripeFor, onHome);
    expect(s.started).toEqual([]);
    expect(await rows()).toEqual([]);
    expect((await orphanRows()).map((r) => JSON.parse(r.value) as { customerId: string | null; reason: string }).map((v) => [v.customerId, v.reason]))
      .toEqual([["cus_known", "switch_not_committed"], [null, "key_expired_customer_unknown"]]);
  });

  it("twenty persistently failing rows (Stripe cached a 500 for each key) never starve the 21st: recorded within two sweeps, the twenty rotate on their backoff, nothing executed at Stripe", async () => {
    await lostCreates(21);
    for (let i = 1; i <= 20; i++) {
      const key = `checkout-customer:consent-s${i}:1`;
      const body = `metadata%5Bcheckout_attempt%5D=${encodeURIComponent(key)}&address%5Bcountry%5D=US`;
      cust.byKey[key] = { status: 500, body: { error: { type: "api_error" } } }; cust.keyBody[key] = body;
    }
    const sweep = () => sweepBilling(testEnv(), deps()).catch(() => undefined);
    await sweep();
    expect((await rows()).map((r) => r.key)).toContain("tax_customer:home-s21:checkout-customer:consent-s21:1");
    await sweep();
    expect((await rows()).map((r) => r.key)).not.toContain("tax_customer:home-s21:checkout-customer:consent-s21:1");
    expect(await rows()).toHaveLength(20);
    expect((await orphanRows()).map((r) => r.key)).toEqual(["customer_orphan:home-s21:checkout-customer:consent-s21:1"]);
    expect(cust.created.map((c) => c.key)).toEqual(["checkout-customer:consent-s21:1"]); // the one replay that executed: an orphan we now know
    const v = JSON.parse((await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key='tax_customer:home-s1:checkout-customer:consent-s1:1'").first<{ value: string }>())!.value);
    expect(v.attempts).toBe(1);
    expect(v.nextAttemptAt).toBeGreaterThan(Date.now() + 9 * 60_000);
  });
});
