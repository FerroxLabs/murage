// SPDX-License-Identifier: AGPL-3.0-or-later
// Customer journey, lane B (CUSTOMER-JOURNEY-CP.md): B1 Delete my Cloud ends the plan; B2 the ended view and Start again; B3 the
// refund clock (later of first payment and server ready); (B4, the downgrade at renewal, is not in this branch: journey-b-core);
// B5 the in-app cancellation is keepable by its CX reference, sign-in only; Astra CANCEL-SUMMARY-2 findings #1-#8. Real workerd + D1, real-shaped Supabase ES256
// member tokens (the members area), the B3 fake provider, Stripe as a fixture. No network.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { fakeProvider, type ProviderAdapter } from "../src/b3-provider";
import type { Home } from "../src/b3-control";
import { IN_APP_CANCEL_INTENT_SQL, inAppResolutionQ, planEndState, publicResolutionQ, reminderStandsSql, sweepBilling, type BillingNotifier, type FluxEntitlementHooks } from "../src/b5-billing";
import { unparkQs } from "../src/subscription-gateway";
import { allocateCancelRef } from "../src/cancel-reference";
import { refundOpInsert } from "../src/legal-refunds";
import { deletionNoticeData } from "../src/members-api";
import { sweepCancellations } from "../src/public-cancellation";
import { isoDate, quoteFirstMonthRefund, readyStamp } from "../src/legal-flows";
import { aoeDate, aoeEnd, refundWindow } from "../src/checkout-moments";
import { reconcileB3, reserveHomeForUser } from "../src/b3-control";
import { signStripePayload } from "../src/b5-stripe";
import { needsStepUp } from "../src/customer-identity";

const ADMIN = "test-only-b3-admin-no-real-access";
const KEK = btoa("x".repeat(32));
const IMAGE = `sha256:${"a".repeat(64)}`;
const NOW = 1_800_000_000_000;
const MIN = 60_000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
const INSTALL = "12345678-1234-4123-8123-123456789012";
const REF_ORIGIN = "https://testref.supabase.co";
const ISS = `${REF_ORIGIN}/auth/v1`;
const JWKS_URL = `${ISS}/.well-known/jwks.json`;
const SUB = "5f0c1b2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
const OTHER_SUB = "6f0c1b2e-3a4d-4e5f-8a9b-0c1d2e3f4a5c";
const PRICES = { STRIPE_PRICE_STARTER: "price_starter0001", STRIPE_PRICE_PRO: "price_pro00000001", STRIPE_PRICE_MAX: "price_max000000001" };
const CONFIG = {
  reservationMs: 60_000, graceMs: 3 * DAY, retentionMs: 14 * DAY, imageDigest: IMAGE, quarantineRelayIP: "192.0.2.20",
  engineSubscriptionGates: { claudeAgent: true, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: true },
  capacity: [{ id: "hel-available", projectId: "project-2", location: "hel1", serverType: "cpx32", outcome: "available" }],
};
/** The paid month the fixture subscription is in. */
const PERIOD_START = NOW - 10 * DAY;
const PERIOD_END = NOW + 20 * DAY;
const b64u = (b: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? Buffer.from(b) : b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");

let ec: CryptoKeyPair;
let jwks: { keys: Record<string, unknown>[] };
let signingJwk: JsonWebKey;
let notices: { id: string; kind: string; data: Record<string, unknown> }[];

// ---- Stripe fixture ---------------------------------------------------------------------------------------------------------------
interface StripeCall { method: string; path: string; form: URLSearchParams; key: string | null }
let stripeCalls: StripeCall[];
let stripeDown: boolean;
/** Stripe answers reads but every write fails (500). */
let stripePostDown: boolean;
type SubFixture = { status: string; cancel_at_period_end: boolean; cancel_at: number | null; price: string; schedule: string | null; start: number; end: number };
let subs: Record<string, SubFixture>;
/** Astra JOURNEY-B-4 #1: keys Stripe refuses on validation (400 invalid_request_error, NOT replayed: nothing saved under the key). */
let validationKeys: Set<string>;
/** Astra JOURNEY-B-4 #5: every Stripe request is rejected by fetch itself (a network failure, not a Stripe answer). */
let fetchRejects: boolean;
/** Astra JOURNEY-B-3 #1: keys Stripe rate-limits (429, NOT replayed: the key is not consumed). */
let rateLimitedKeys: Set<string>;
/** Astra JOURNEY-B-3 #1: subscription keys Stripe has seen, with the cancel_at_period_end each carried (a reuse with other parameters: 400). */
let subKeyParams: Record<string, string>;
/** Idempotency keys whose cached failure Stripe replays (Idempotent-Replayed: true), and keys Stripe no longer knows (400). */
let failedKeys: Record<string, number>;
let expiredKeys: Set<string>;
/** Astra JOURNEY-BCORE-3 #3: DELETEs of a subscription Stripe fails (500, not replayed: no cached answer yet). */
let deleteFails: number;
/** Astra JOURNEY-BCORE-3 #4: run once right after the next GET of a subscription is answered (a resolution racing a Keep). */
let afterSubGet: (() => void) | null;
/** Astra JOURNEY-BCORE-5 #3/#4: the next `failSubGets` reads of a subscription fail (500); `onSubDelete` runs once when a DELETE arrives. */
let failSubGets: number;
let onSubDelete: (() => void) | null;
/** Astra JOURNEY-BCORE-3 #8: run when an invoice listing of that status is asked for, BEFORE it is answered (an invoice settling meanwhile). */
let onList: Record<string, () => void>;
/** Astra JOURNEY-BCORE-3 #10: the test notifier fails every send while set. */
let notifyFails: boolean;
let paidInvoices: Record<string, unknown>[];
/** Astra JOURNEY-BCORE-2 #3/#4: invoices Stripe lists as open / draft, and the pages of an invoice's lines (GET /v1/invoices/:id/lines, 1 line per page when listed). */
let openInvoices: Record<string, unknown>[];
let draftInvoices: Record<string, unknown>[];
let invoiceLinePages: Record<string, Record<string, unknown>[][]>;
/** Invoices Stripe answers by id (GET /v1/invoices/:id) that no listing shows. */
let invoiceById: Record<string, Record<string, unknown>>;
/** Astra JOURNEY-BCORE-4 #5: invoices whose line pages Stripe fails to list (500). */
let failLines: Set<string>;
/** Astra JOURNEY-BCORE-7 #1: refunds Stripe has made (POST /v1/refunds succeeds at once). */
let refundsMade: Record<string, unknown>[];
const subJson = (id: string, s: SubFixture) => ({ id, object: "subscription", status: s.status, cancel_at_period_end: s.cancel_at_period_end, cancel_at: s.cancel_at,
  schedule: s.schedule, pending_update: null, customer: "cus_1",
  items: { data: [{ id: `si_${id}`, price: { id: s.price }, current_period_start: s.start / 1000, current_period_end: s.end / 1000 }] } });
const stripeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const form = new URLSearchParams(String(init?.body ?? ""));
  stripeCalls.push({ method, path: url.pathname, form, key: new Headers(init?.headers).get("idempotency-key") });
  if (fetchRejects) throw new TypeError("fetch failed");
  const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s });
  if (stripeDown || (stripePostDown && method === "POST")) return j({ error: { type: "api_error" } }, 500);
  const reqKey = stripeCalls.at(-1)!.key;
  if (method === "POST" && reqKey && rateLimitedKeys.has(reqKey)) return j({ error: { type: "invalid_request_error", code: "rate_limit" } }, 429);
  if (method === "POST" && reqKey && validationKeys.has(reqKey)) return j({ error: { type: "invalid_request_error", code: "parameter_invalid_empty" } }, 400);
  if ((method === "POST" || method === "DELETE") && reqKey && failedKeys[reqKey]) return new Response(JSON.stringify({ error: { type: "api_error" } }), { status: failedKeys[reqKey], headers: { "idempotent-replayed": "true" } });
  if (method === "POST" && reqKey && expiredKeys.has(reqKey)) return j({ error: { type: "idempotency_error" } }, 400);
  if (url.pathname === "/v1/invoices" && method === "GET") {
    const st = url.searchParams.get("status");
    if (st && onList[st]) { const f = onList[st]; delete onList[st]; f(); }
    return j({ object: "list", data: st === "paid" ? paidInvoices : st === "open" ? openInvoices : st === "draft" ? draftInvoices : [], has_more: false });
  }
  const linesOf = url.pathname.match(/^\/v1\/invoices\/([^/]+)\/lines$/);
  if (linesOf && method === "GET") {
    if (failLines.has(linesOf[1])) return j({ error: { type: "api_error" } }, 500);
    const pages = invoiceLinePages[linesOf[1]] ?? [];
    const after = url.searchParams.get("starting_after");
    const idx = after ? pages.findIndex((pg) => pg.some((l) => l.id === after)) + 1 : 0;
    return j({ object: "list", data: pages[idx] ?? [], has_more: idx + 1 < pages.length });
  }
  const oneInvoice = url.pathname.match(/^\/v1\/invoices\/([^/]+)$/);
  if (oneInvoice && method === "GET") {
    const inv = [...paidInvoices, ...openInvoices, ...draftInvoices].find((i) => i.id === oneInvoice[1]) ?? invoiceById[oneInvoice[1]];
    return inv ? j(inv) : j({ error: { code: "resource_missing" } }, 404);
  }
  if (url.pathname === "/v1/refunds" && method === "GET") {
    return j({ object: "list", data: refundsMade.filter((r) => r.payment_intent === url.searchParams.get("payment_intent")), has_more: false });
  }
  if (url.pathname === "/v1/refunds" && method === "POST") {
    const r = { id: `re_${refundsMade.length + 1}`, object: "refund", amount: Number(form.get("amount")), status: "succeeded", payment_intent: form.get("payment_intent"),
      created: Math.floor(Date.now() / 1000), metadata: { op_id: form.get("metadata[op_id]"), submission: form.get("metadata[submission]") } };
    refundsMade.push(r);
    return j(r);
  }
  const oneRefund = url.pathname.match(/^\/v1\/refunds\/([^/]+)$/);
  if (oneRefund && method === "GET") { const r = refundsMade.find((x) => x.id === oneRefund[1]); return r ? j(r) : j({ error: { code: "resource_missing" } }, 404); }
  const price = url.pathname.match(/^\/v1\/prices\/([^/]+)$/);
  if (price && method === "GET") return j({ id: price[1], object: "price", recurring: { interval: "month", usage_type: price[1].includes("metered") ? "metered" : "licensed" } });
  const m = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/);
  if (m) {
    const s = subs[m[1]];
    if (!s) return j({ error: { code: "resource_missing" } }, 404);
    if (method === "GET" && failSubGets > 0) { failSubGets--; return j({ error: { type: "api_error" } }, 500); }
    if (method === "GET" && afterSubGet) { const answer = j(subJson(m[1], s)); const f = afterSubGet; afterSubGet = null; f(); return answer; }
    // PESSIMISTIC (Astra JOURNEY-BCORE-2 #7): Stripe documents no restriction on deleting a subscription a schedule holds, but the plan does not
    // rely on that: with a schedule attached the DELETE FAILS (400) until the schedule is released (or cancelled).
    if (method === "DELETE") {
      if (onSubDelete) { const f = onSubDelete; onSubDelete = null; f(); }
      if (deleteFails > 0) { deleteFails--; return j({ error: { type: "api_error" } }, 500); }
      if (s.schedule) return j({ error: { type: "invalid_request_error", message: "managed by a subscription schedule" } }, 400);
      s.status = "canceled"; return j(subJson(m[1], s));
    }
    // Stripe refuses any update of a canceled subscription (validation 400, nothing saved under the key).
    if (method === "POST" && s.status === "canceled") return j({ error: { type: "invalid_request_error", code: "resource_invalid_state" } }, 400);
    if (method === "POST") {
      if (form.get("cancel_at_period_end")) {
        if (reqKey && subKeyParams[reqKey] !== undefined && subKeyParams[reqKey] !== form.get("cancel_at_period_end")) return j({ error: { type: "idempotency_error" } }, 400);
        if (reqKey) subKeyParams[reqKey] = form.get("cancel_at_period_end")!;
        if (s.schedule) return j({ error: { type: "invalid_request_error", message: "managed by a subscription schedule" } }, 400);
        s.cancel_at_period_end = form.get("cancel_at_period_end") === "true";
      }
      if (form.has("cancel_at")) {
        if (s.schedule) return j({ error: { type: "invalid_request_error", message: "managed by a subscription schedule" } }, 400);
        s.cancel_at = form.get("cancel_at") ? Number(form.get("cancel_at")) : null; // Unix seconds, as Stripe
      }
    }
    return j(subJson(m[1], s));
  }
  // Astra JOURNEY-BCORE-6 #1: a charge of the fixture subscription's first invoice (a dispute is resolved to its home through it).
  const charge = url.pathname.match(/^\/v1\/charges\/([^/]+)$/);
  if (charge && method === "GET") return j({ id: charge[1], object: "charge", customer: "cus_1", invoice: "in_1", payment_intent: null });
  // An upgrade's quote (members-api.ts previewPriceChange).
  if (url.pathname === "/v1/invoices/create_preview" && method === "POST") return j({ amount_due: 1234, currency: "usd" });
  return j({ error: { code: "unexpected", path: url.pathname } }, 500);
};

const notifier: BillingNotifier = {
  async notify(e, n) {
    if (notifyFails) throw new Error("mail_down");
    notices.push({ id: n.id, kind: n.kind, data: n.data });
    await e.DB.prepare("INSERT INTO billing_notices (id,home_id,kind,payload,created_at,sent_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sent_at=COALESCE(sent_at,excluded.sent_at)")
      .bind(n.id, n.homeId, n.kind, JSON.stringify(n.data), Date.now(), Date.now()).run();
  },
};
let fluxLog: { hook: string; args: unknown }[];
const flux: Partial<FluxEntitlementHooks> = {
  async changePlan(_e, input) { fluxLog.push({ hook: "plan", args: input }); },
  async grantMonthlyCredits(_e, input) { fluxLog.push({ hook: "grant", args: input }); },
  async stopForBilling(_e, homeId, _d, options) { fluxLog.push({ hook: "stop", args: { homeId, ...options } }); },
};

// ---- members-area identity (the self-service harness) -----------------------------------------------------------------------------
const FACTOR = "7d3e0c1a-1111-4222-8333-944455566677";
const claimsOf = (tok: string) => JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()) as { sub: string; aal: string; email: string };
const authFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const c = claimsOf(String(new Headers(init?.headers).get("authorization")).replace(/^Bearer /, ""));
  return Response.json({ id: c.sub, email: c.email, email_confirmed_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    factors: [{ id: FACTOR, factor_type: "totp", status: "verified" }] });
}) as typeof fetch;
const jwksFetch = (async (input: RequestInfo | URL) => String(input) === JWKS_URL ? Response.json(jwks) : new Response("no", { status: 404 })) as typeof fetch;
const noNetwork = async () => { throw new Error("attempted network transport"); };
const provider = (db: D1Database): ProviderAdapter => fakeProvider(db);
let envOver: Record<string, string> = {};
function worker() {
  return createWorker(noNetwork, noNetwork, { provider }, {}, { notifier, stripeFetch, flux: flux as FluxEntitlementHooks },
    { jwksFetch, authFetch, now: () => Date.now() }, {});
}
function testEnv(): Env {
  return { ...env, CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_KEK_V1: KEK, CLOUD_CP0_STAGING: "1", CLOUD_B3_MODE: "fake", CLOUD_B3_CONFIG: JSON.stringify(CONFIG),
    CLOUD_B3_SIGNING_JWK: JSON.stringify(signingJwk), SUPABASE_URL: REF_ORIGIN, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_testkey_0123456789abcdef",
    MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined,
    STRIPE_SECRET_KEY: "sk_test_fixturefixturefixture", STRIPE_WEBHOOK_SECRET: "whsec_testonlyfixturesecret0123456789",
    BILLING_RETURN_ORIGIN: "https://cloud.murage.test", ...PRICES, ...envOver } as unknown as Env;
}
async function token(opts: { aal2?: boolean; sub?: string; email?: string } = {}) {
  const nowS = Math.floor(Date.now() / 1000);
  const claims = { iss: ISS, aud: "authenticated", exp: nowS + 3600, iat: nowS - 5, sub: opts.sub ?? SUB, email: opts.email ?? "pat@example.test", phone: "",
    app_metadata: { provider: "email", providers: ["email"], email_verified: true }, user_metadata: {}, role: "authenticated",
    aal: opts.aal2 ? "aal2" : "aal1", amr: opts.aal2 ? [{ method: "totp", timestamp: nowS - 30 }] : [{ method: "password", timestamp: nowS - 60 }],
    session_id: "0b1c2d3e-aaaa-4bbb-8ccc-123456789abc", is_anonymous: false, ...(opts.aal2 ? { mfa_factor_id: FACTOR } : {}) };
  const input = `${b64u(JSON.stringify({ alg: "ES256", kid: "ec-1", typ: "JWT" }))}.${b64u(JSON.stringify(claims))}`;
  return `${input}.${b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, new TextEncoder().encode(input)))}`;
}
async function trustFactorFor(tok: string) {
  let c: ReturnType<typeof claimsOf>;
  try { c = claimsOf(tok); } catch { return; }
  if (c.aal !== "aal2") return;
  const find = () => env.DB.prepare("SELECT user_id FROM supabase_identities WHERE sub=?").bind(c.sub).first<{ user_id: string }>();
  let row = await find();
  if (!row) {
    const ctx = createExecutionContext();
    await worker().fetch(new Request("https://auth.murage.test/v1/account/terms", { headers: { authorization: `Bearer ${tok}`, "CF-Connecting-IP": "203.0.113.10" } }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    row = await find();
  }
  if (!row) return;
  await env.DB.prepare("INSERT OR IGNORE INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state) VALUES (?,?,'totp','email_code',0,0,'active')")
    .bind(row.user_id, FACTOR).run();
}
async function call(path: string, bearer: string | null, body?: unknown, method?: string) {
  if (bearer && bearer !== ADMIN) await trustFactorFor(bearer);
  const headers = new Headers({ "CF-Connecting-IP": "203.0.113.10" });
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  const ctx = createExecutionContext();
  const res = await worker().fetch(new Request(`https://auth.murage.test${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers,
    body: body === undefined ? undefined : JSON.stringify(body) }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const admin = (path: string, body: unknown) => call(path, ADMIN, body);
const getHome = async () => (await env.DB.prepare("SELECT * FROM cloud_homes WHERE id='home-1'").first<Home>())!;
/** What a Keep the payment provider has not confirmed yet tells the customer (public-cancellation.ts KEEP_UNCONFIRMED). */
const KEEP_UNCONFIRMED = "Your plan is kept. We are still confirming it with our payment provider.";
const getSubRow = async () => (await env.DB.prepare("SELECT * FROM billing_subscriptions WHERE home_id='home-1'").first<Record<string, unknown>>())!;
const at = (ms: number) => vi.mocked(Date.now).mockReturnValue(ms);

let account: string;
let generation: number;
/** A paid, enrolled home owned by SUB, reserved and paid; `ready` runs its canary (the server-ready moment). */
async function paidHome(ready = true) {
  expect((await call("/v1/account/home", await token())).status).toBe(404); // creates the account; no home yet
  account = (await env.DB.prepare("SELECT user_id FROM supabase_identities WHERE sub=?").bind(SUB).first<{ user_id: string }>())!.user_id;
  await env.DB.prepare(`INSERT INTO installations (id,owner_user_id,client_instance_id,display_name,platform,created_at,updated_at)
    VALUES (?,?,?,'Journey test','linux',?,?)`).bind(INSTALL, account, INSTALL, NOW, NOW).run();
  expect((await admin("/v1/fake-b3/reserve", { homeId: "home-1", installationId: INSTALL, ownerId: account,
    publicOrigin: "https://home-1.murage.test", idempotencyKey: "reserve-key-home-1-0001" })).status).toBe(201);
  expect((await admin("/v1/fake-b3/payments", { eventId: "evt-1", homeId: "home-1", version: 1, status: "paid", paymentId: "payment-home-1" })).status).toBe(202);
  expect((await admin("/v1/fake-b3/reconcile", {})).status).toBe(200);
  const rotated = await (await admin("/v1/machines/home-1/rotate", {})).json<{ enrollmentToken: string }>();
  const enrolled = await (await call("/v1/machines/home-1/enroll", "", { token: rotated.enrollmentToken })).json<{ machineCredential: string; generation: number }>();
  generation = enrolled.generation;
  await env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,price_id,status,current_period_start,current_period_end,
    first_paid_at,first_invoice_id,first_invoice_cents,created_at,updated_at) VALUES ('home-1','cus_1','sub_1','pro',?,'active',?,?,?,'in_1',9900,?,?)`)
    .bind(PRICES.STRIPE_PRICE_PRO, PERIOD_START, PERIOD_END, PERIOD_START, PERIOD_START, PERIOD_START).run();
  subs.sub_1 = { status: "active", cancel_at_period_end: false, cancel_at: null, price: PRICES.STRIPE_PRICE_PRO, schedule: null, start: PERIOD_START, end: PERIOD_END };
  if (ready) await canary();
}
async function canary() {
  expect((await admin("/v1/fake-b3/homes/home-1/canary", { generation, imageDigest: IMAGE,
    checks: { authenticatedUI: true, engineRoundTrip: true, sandboxedBrowser: true, writableState: true, schedulerHeartbeat: true } })).status).toBe(200);
}
const summary = async (tok?: string) => call("/v1/account/cloud", tok ?? await token());
const deleteHold = async () => call("/v1/account/home/hold", await token({ aal2: true }), { action: "delete", confirm: "home-1" });
const cancelCalls = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/subscriptions/sub_1" && c.form.has("cancel_at_period_end"));
/** Integration with lane A (Astra JOURNEY-A-6 #1): a full refund ends a retained contract only on VERIFIED coverage (Stripe's refund listing
 *  shows the whole payment returned), never on the event's "refunded" flag alone. This makes Stripe show in_1's payment (pi_1, $99) refunded
 *  in full by a Dashboard refund; the charge.refunded events below name that payment. */
function externalFullRefund() {
  invoiceById.in_1 = { id: "in_1", object: "invoice", status: "paid", customer: "cus_1", subscription: "sub_1", payment_intent: "pi_1", amount_paid: 9900 };
  refundsMade.push({ id: "re_ext_1", object: "refund", amount: 9900, status: "succeeded", payment_intent: "pi_1", created: Math.floor(NOW / 1000), metadata: {} });
}

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  notices = []; stripeCalls = []; stripeDown = false; stripePostDown = false; failedKeys = {}; expiredKeys = new Set(); rateLimitedKeys = new Set(); subKeyParams = {}; validationKeys = new Set(); fetchRejects = false; subs = {}; fluxLog = []; envOver = {};
  deleteFails = 0; afterSubGet = null; failSubGets = 0; onSubDelete = null; onList = {}; notifyFails = false; paidInvoices = []; openInvoices = []; draftInvoices = []; invoiceLinePages = {}; invoiceById = {}; failLines = new Set(); refundsMade = [];
  ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", ec.publicKey)), kid: "ec-1", alg: "ES256", use: "sig", key_ops: ["verify"], ext: true }] };
  const signer = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  signingJwk = await crypto.subtle.exportKey("jwk", signer.privateKey);
});
afterEach(() => vi.restoreAllMocks());

// ---- B1 ----------------------------------------------------------------------------------------------------------------------------

describe("B1: Delete my Cloud ends the plan (never a further charge)", () => {
  beforeEach(async () => { await paidHome(); });
  const SENTENCE = `Your plan ends on ${isoDate(PERIOD_END)}. Renewals stop on ${isoDate(PERIOD_END)}. Any usage already served may still appear on a final invoice. Anything charged for time after ${isoDate(PERIOD_END)} is refunded.`;

  it("starting a deletion journals the in-app period-end cancellation, confirms it with Stripe and says so in the dialog and the hold email", async () => {
    const r = await deleteHold();
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ state: "recovery_hold", action: "delete",
      plan: { state: "ending", endsAt: PERIOD_END, noFurtherCharge: true, sentence: SENTENCE } });
    // The same journal and the same Stripe step as Cancel plan: one cancel_at_period_end=true, read back.
    expect(cancelCalls().map((c) => c.form.get("cancel_at_period_end"))).toEqual(["true"]);
    expect(await getSubRow()).toMatchObject({ cancel_at_period_end: 1, customer_cancel_at: NOW, cancel_terminal_sub: "sub_1" });
    // The same receipt as Cancel plan, and the hold email names the end date and that nothing is charged again.
    expect(notices.map((n) => n.kind).sort()).toEqual(["cancel_scheduled", "hold_started"]);
    expect(String(notices.find((n) => n.kind === "hold_started")!.data.emailText)).toContain(SENTENCE);
    // The summary shows the confirmed cancellation; no refund and no money moved.
    const s = await (await summary()).json<{ subscription: Record<string, unknown> }>();
    expect(s.subscription).toMatchObject({ cancelAtPeriodEnd: true, activeUntil: PERIOD_END, ended: false, cancellation: { state: "confirmed", endsAt: PERIOD_END } });
    expect(stripeCalls.some((c) => c.path.includes("refund") || c.path.includes("credit_notes"))).toBe(false);
  });

  it("cancelling the deletion within the hold does not take the plan end back (the email says how to keep the plan)", async () => {
    const { holdId } = await (await deleteHold()).json<{ holdId: string }>();
    stripeCalls = []; notices = [];
    at(NOW + HOUR);
    const r = await call("/v1/account/home/hold/cancel", await token(), { holdId });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ canceled: true, plan: { state: "ending", endsAt: PERIOD_END } });
    expect(stripeCalls.filter((c) => c.method === "POST")).toEqual([]);
    expect(await getSubRow()).toMatchObject({ cancel_at_period_end: 1 });
    const text = String(notices.find((n) => n.kind === "hold_canceled")!.data.emailText);
    expect(text).toContain("Your Cloud will not be deleted.");
    expect(text).toContain(SENTENCE);
    expect(text).toContain("Keep my plan");
    expect((await getHome()).desired_state).toBe("ready");
  });

  it("a plan already ending is left as it is: no second journal, no second Stripe call, no second receipt", async () => {
    expect(await (await call("/v1/account/cancel-plan", await token(), {})).json()).toMatchObject({ canceled: true });
    const rev = (await getSubRow()).cancel_intent_rev;
    stripeCalls = []; notices = [];
    expect(await (await deleteHold()).json()).toMatchObject({ plan: { state: "ending", endsAt: PERIOD_END, noFurtherCharge: true } });
    expect(stripeCalls.filter((c) => c.method === "POST")).toEqual([]);
    expect((await getSubRow()).cancel_intent_rev).toBe(rev);
    expect(notices.map((n) => n.kind)).toEqual(["hold_started"]);
  });

  it("an ended plan stays ended: nothing changes, and the dialog says nothing is charged again", async () => {
    // Stripe ended it (its webhook): the local status and THE Stripe-end checkpoint (INTEGRATED-2 RULE A).
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled',stripe_end_confirmed=subscription_id WHERE home_id='home-1'").run();
    expect(await (await deleteHold()).json()).toMatchObject({ plan: { state: "ended", noFurtherCharge: true, sentence: expect.stringContaining("Your plan has ended. Renewals stopped on ") } });
    expect(stripeCalls).toEqual([]);
    expect((await getSubRow()).customer_cancel_at).toBeNull();
  });

  it("Stripe down: the deletion still waits and the cancellation is recorded as pending (the sweep confirms it); asking again heals nothing twice", async () => {
    stripeDown = true;
    const r = await deleteHold();
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ plan: { state: "ending", endsAt: PERIOD_END } });
    expect(await getSubRow()).toMatchObject({ customer_cancel_at: NOW, cancel_at_period_end: 0 });
    expect((await (await summary()).json<{ subscription: { cancellation: { state: string } } }>()).subscription.cancellation.state).toBe("pending");
    // Asked again while it waits: the existing hold, the plan end already journaled (no second revision).
    const rev = (await getSubRow()).cancel_intent_rev;
    expect(await (await deleteHold()).json()).toMatchObject({ existing: true, plan: { state: "ending" } });
    expect((await getSubRow()).cancel_intent_rev).toBe(rev);
  });

  it("the deletion email states the end date and that nothing is charged again", async () => {
    await deleteHold();
    const data = await deletionNoticeData(testEnv(), "home-1", NOW + 4 * DAY);
    expect(String(data.emailText)).toContain(SENTENCE);
  });
});

// ---- B2 ----------------------------------------------------------------------------------------------------------------------------

describe("B2: the ended view (GET /v1/account/cloud) and Start again", () => {
  beforeEach(async () => { await paidHome(); });
  /** The lifecycle has deleted home-1: the state, the purge, the freed capacity slot, the "deleted" outbox entry. */
  async function deleted(at: number) {
    await env.DB.batch([
      env.DB.prepare("UPDATE cloud_homes SET desired_state='deleted',observed_state='deleted',updated_at=? WHERE id='home-1'").bind(at),
      env.DB.prepare("UPDATE cloud_capacity SET home_id=NULL,expires_at=NULL WHERE home_id='home-1'"),
      env.DB.prepare("INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) VALUES ('deleted:home-1','home-1',9,?,'deleted','{}',?)").bind(account, at),
    ]);
  }

  it("a running home: no data date (nothing is scheduled) and the plan as it is", async () => {
    const s = await (await summary()).json<Record<string, unknown>>();
    expect(s).toMatchObject({ homeId: "home-1", home: { id: "home-1", state: "ready" }, dataKeptUntil: null, startAgain: false,
      subscription: { plan: "pro", planName: "Pro", ended: false } });
  });

  it("an ended plan in its grace period: data kept until grace_until plus the retention; suspended: until delete_after", async () => {
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled',updated_at=? WHERE home_id='home-1'").bind(NOW).run();
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='payment_problem',grace_until=? WHERE id='home-1'").bind(NOW + 3 * DAY).run();
    expect(await (await summary()).json()).toMatchObject({ home: { state: "payment_problem" }, dataKeptUntil: NOW + 3 * DAY + 14 * DAY,
      subscription: { ended: true, endedAt: NOW, plan: "pro", planName: "Pro" } });
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='suspended',delete_after=? WHERE id='home-1'").bind(NOW + 17 * DAY).run();
    expect(await (await summary()).json()).toMatchObject({ home: { state: "suspended" }, dataKeptUntil: NOW + 17 * DAY, subscription: { ended: true } });
  });

  it("a deleted home answers the ended view instead of 404: the plan, when it ended, nothing kept, Start again", async () => {
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled',stripe_end_confirmed=subscription_id,updated_at=? WHERE home_id='home-1'").bind(NOW - DAY).run();
    await deleted(NOW + DAY);
    const r = await summary();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      homeId: null,
      home: { id: "home-1", state: "deleted", deletedAt: NOW + DAY },
      subscription: { plan: "pro", planName: "Pro", priceUsd: 99, status: "canceled", ended: true, endedAt: NOW - DAY, cancelAtPeriodEnd: true, activeUntil: NOW - DAY, endedReason: "cancelled", refundState: null,
        billing: { state: "ended", endsAt: NOW - DAY, confirmed: true, noFurtherCharge: true, sentence: expect.stringContaining("Your plan has ended. Renewals stopped on ") },
        cancellation: { state: null, endsAt: null, id: null, kind: null, keepable: false, keepIds: [] }, refundRequest: null },
      dataKeptUntil: null,
      startAgain: true,
    });
  });

  it("a Cloud deleted while its plan ran to the period end (Delete my Cloud): ended at the deletion, never charged again", async () => {
    await deleteHold();
    await deleted(NOW + 3 * DAY + HOUR);
    expect(await (await summary()).json()).toMatchObject({ homeId: null, subscription: { ended: true, endedAt: NOW + 3 * DAY + HOUR }, dataKeptUntil: null, startAgain: true });
  });

  it("another member with no home still gets 404; a member with no Cloud at all too", async () => {
    await deleted(NOW);
    expect((await summary(await token({ sub: OTHER_SUB, email: "someone@example.test" }))).status).toBe(404);
  });

  it("Start again: a deleted home never blocks a new reservation for the same account", async () => {
    await deleted(NOW);
    // Managed endpoints configured (portal reservations always get one), as in b5-reserve.test.ts.
    envOver = { CLOUD_HOME_HOST_SUFFIX: "murage.test", CLOUD_HOME_ZONE_ID: "0".repeat(32), CLOUD_HOME_ACCOUNT_ID: "0".repeat(32), CLOUD_HOME_API_TOKEN: "test-only-cloud-home-token-no-access" };
    const r = await reserveHomeForUser(testEnv(), account);
    expect(r.status).toBe(201);
    const created = await r.json<{ homeId: string; state: string }>();
    expect(created).toMatchObject({ state: "payment_pending", existing: false });
    expect(created.homeId).not.toBe("home-1");
    // The new reservation is now the live home the summary reads.
    expect((await (await summary()).json<{ homeId: string }>()).homeId).toBe(created.homeId);
  });
});

// ---- B3 ----------------------------------------------------------------------------------------------------------------------------

describe("B3: the refund clock runs from the later of the first payment and the day the server is ready", () => {
  const readyNotice = () => env.DB.prepare("SELECT created_at,payload FROM billing_notices WHERE kind='server_ready' AND home_id='home-1'").all<{ created_at: number; payload: string }>();

  it("paid, not ready yet: no deadline (refundWindowEndsAt null, refundWindowStartsWhenReady true) and the window is open", async () => {
    await paidHome(false);
    const s = await (await summary()).json<{ subscription: Record<string, unknown> }>();
    expect(s.subscription).toMatchObject({ refundWindowEndsAt: null, refundWindowStartsWhenReady: true });
    at(NOW + 30 * DAY); // long after the payment's own 7 days: still open, nothing is known yet
    expect((await quoteFirstMonthRefund(testEnv(), "home-1", NOW + 30 * DAY)).reason).not.toBe("window_expired");
    expect((await readyNotice()).results).toEqual([]);
  });

  it("the first canary pass stamps ready_at and queues the ready email in the same batch: one timestamp, then 7 days from it", async () => {
    await paidHome(false);
    const READY = NOW + 2 * DAY;
    at(READY);
    await canary();
    expect((await getHome()).ready_at).toBe(READY);
    const n = (await readyNotice()).results;
    expect(n).toHaveLength(1);
    expect(n[0].created_at).toBe(READY);
    const payload = JSON.parse(n[0].payload) as { emailText: string; refundWindowEndsAt: number; emailSubject: string };
    expect(payload.emailSubject).toBe("Murage Cloud: your server is ready");
    expect(payload.refundWindowEndsAt).toBe(aoeEnd(READY, 7));
    expect(payload.emailText).toContain("7 days from the day your server is ready, and we refund your first month in full.");
    // Astra JOURNEY-B-2 #6: the clock starts when the email is handed off, not when it is queued: until then the window stays open.
    expect((await (await summary()).json<{ subscription: Record<string, unknown> }>()).subscription).toMatchObject({ refundWindowEndsAt: null, refundWindowStartsWhenReady: true });
    await sweepBilling(testEnv(), { notifier, stripeFetch, flux: flux as FluxEntitlementHooks }).catch(() => undefined);
    const s = await (await summary()).json<{ subscription: Record<string, unknown> }>();
    expect(s.subscription).toMatchObject({ refundWindowEndsAt: aoeEnd(READY, 7), refundWindowStartsWhenReady: false });
    // The same rule decides eligibility: open after the payment's own 7 days, closed after the ready day's.
    expect((await quoteFirstMonthRefund(testEnv(), "home-1", aoeEnd(PERIOD_START, 7) + HOUR)).reason).not.toBe("window_expired");
    expect((await quoteFirstMonthRefund(testEnv(), "home-1", aoeEnd(READY, 7) + 1)).reason).toBe("window_expired");
  });

  it("ready_at is written once: a later ready moment (start fresh, a second canary) never moves it nor sends a second email", async () => {
    await paidHome();
    const first = (await getHome()).ready_at;
    await env.DB.batch([readyStamp(testEnv(), "home-1", NOW + 9 * DAY)]);
    expect((await getHome()).ready_at).toBe(first);
    expect((await readyNotice()).results).toHaveLength(1);
  });

  it("the deadline only grows: the payment rule when it is later, the frozen value when it is later; a legacy ready home keeps the payment rule", () => {
    const paid = NOW; const ready = NOW + 3 * DAY;
    expect(refundWindow(null, paid, { ready_at: ready, ready_legacy: 0 })).toEqual({ endsAt: aoeEnd(ready, 7), startsWhenReady: false });
    expect(refundWindow(null, ready, { ready_at: paid, ready_legacy: 0 })).toEqual({ endsAt: aoeEnd(ready, 7), startsWhenReady: false });
    expect(refundWindow(aoeEnd(NOW + 20 * DAY, 7), paid, { ready_at: ready, ready_legacy: 0 }).endsAt).toBe(aoeEnd(NOW + 20 * DAY, 7));
    expect(refundWindow(null, paid, { ready_at: null, ready_legacy: 1 })).toEqual({ endsAt: aoeEnd(paid, 7), startsWhenReady: false });
    expect(refundWindow(null, paid, { ready_at: null, ready_legacy: 0 })).toEqual({ endsAt: null, startsWhenReady: true });
  });
});

// ---- B4 ----------------------------------------------------------------------------------------------------------------------------

// ---- B5 ----------------------------------------------------------------------------------------------------------------------------

describe("B5: the in-app cancellation is keepable by its CX reference (Keep is sign-in only)", () => {
  beforeEach(async () => { await paidHome(); });
  const keep = async (id: string, tok?: string) => call(`/v1/account/cancellations/${id}/keep`, tok ?? await token(), {});
  type Cx = { state: string | null; id: string | null; kind: string | null; keepable: boolean; keepIds: string[] };
  const cancellation = async () => (await (await summary()).json<{ subscription: { cancellation: Cx; cancelAtPeriodEnd: boolean } }>()).subscription;

  it("Cancel plan -> its CX reference -> the summary offers Keep -> Keep without step-up -> Stripe cleared -> no cancellation", async () => {
    const c = await (await call("/v1/account/cancel-plan", await token(), {})).json<{ canceled: boolean; reference: string }>();
    expect(c.reference).toMatch(/^CX-[A-HJ-NP-Z2-9]{8}$/);
    expect((await cancellation()).cancellation).toEqual({ state: "confirmed", endsAt: PERIOD_END, id: c.reference, kind: "in_app", keepable: true, keepIds: [c.reference] });
    stripeCalls = [];
    const r = await keep(c.reference); // an aal1 (sign-in only) token
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "kept", stripeConfirmed: true });
    expect(cancelCalls().map((x) => x.form.get("cancel_at_period_end"))).toEqual(["false"]);
    const s = await cancellation();
    expect(s.cancelAtPeriodEnd).toBe(false);
    expect(s.cancellation).toEqual({ state: null, endsAt: null, id: null, kind: null, keepable: false, keepIds: [] });
    expect(await getSubRow()).toMatchObject({ customer_cancel_at: null, cancel_at_period_end: 0, cancel_terminal_sub: null });
    expect(stripeCalls.some((x) => x.path.includes("refund") || x.path.includes("invoices"))).toBe(false);
    // Pressed twice (a second tab): already kept.
    expect(await (await keep(c.reference)).json()).toEqual({ error: "already_kept" });
  });

  it("another member's reference is 404; after the end date 409 too_late; an unknown reference 404", async () => {
    const c = await (await call("/v1/account/cancel-plan", await token(), {})).json<{ reference: string }>();
    expect((await keep(c.reference, await token({ sub: OTHER_SUB, email: "someone@example.test" }))).status).toBe(404);
    expect((await keep("CX-ABCDEFGH")).status).toBe(404);
    at(PERIOD_END + 1);
    expect(await (await keep(c.reference)).json()).toEqual({ error: "too_late" });
  });

  it("Stripe down: Keep is recorded and final (keeping), the plan still shows its end until Stripe confirms; a late Stripe event never brings the cancel back", async () => {
    const c = await (await call("/v1/account/cancel-plan", await token(), {})).json<{ reference: string }>();
    stripeDown = true;
    expect(await (await keep(c.reference)).json()).toEqual({ status: "kept", stripeConfirmed: false, message: KEEP_UNCONFIRMED });
    expect((await cancellation()).cancellation).toMatchObject({ state: "keeping", id: null, keepable: false, keepIds: [] });
    stripeDown = false;
    // The cancellation's own event, delivered late (created before the Keep): it changes nothing about the customer's intent.
    const raw = JSON.stringify({ id: "evt_b5_late00001", type: "customer.subscription.updated", created: Math.floor((NOW - MIN) / 1000),
      data: { object: { ...subJson("sub_1", { ...subs.sub_1, cancel_at_period_end: true }), cancellation_details: { reason: "cancellation_requested" } } } });
    const ctx = createExecutionContext();
    await worker().fetch(new Request("https://auth.murage.test/v1/billing/webhook", { method: "POST", body: raw, headers: { "content-type": "application/json",
      "stripe-signature": await signStripePayload(raw, "whsec_testonlyfixturesecret0123456789", Math.floor(Date.now() / 1000)) } }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect((await getSubRow()).customer_cancel_at).toBeNull();
  });

  it("the plan end a deletion journaled has the same id: refused while the deletion waits, keepable once the deletion is cancelled", async () => {
    const hold = await (await deleteHold()).json<{ holdId: string; plan: { cancellationId: string } }>();
    expect(hold.plan.cancellationId).toMatch(/^CX-/);
    expect((await cancellation()).cancellation).toMatchObject({ id: hold.plan.cancellationId, kind: "in_app", keepable: false, keepIds: [] });
    expect(await (await keep(hold.plan.cancellationId)).json()).toEqual({ error: "not_keepable" });
    await call("/v1/account/home/hold/cancel", await token(), { holdId: hold.holdId });
    expect((await cancellation()).cancellation).toMatchObject({ keepable: true, keepIds: [hold.plan.cancellationId] });
    expect(await (await keep(hold.plan.cancellationId)).json()).toEqual({ status: "kept", stripeConfirmed: true });
    expect(subs.sub_1.cancel_at_period_end).toBe(false);
  });

});

// ---- Astra CANCEL-SUMMARY-2 ------------------------------------------------------------------------------------------------------------

/** A matched public declaration of sub_1 by the member (synced: Stripe confirmed its cancel_at). */
async function declare(id: string, o: { effectiveAt?: number; status?: string; kind?: string; synced?: boolean; received?: number } = {}) {
  const at = o.effectiveAt ?? PERIOD_END; const synced = o.synced ?? true;
  await env.DB.prepare(`INSERT INTO cancellation_requests (id,ref,received_at,fields_json,kind,entered_email,entered_name,confirm_email,language,match_state,
    attribution_basis,account_id,home_id,subscription_id,effective_at,hold_until,status,receipt_sha256,stripe_synced,stripe_cancel_at,last_op,created_at,updated_at,kept_by)
    VALUES (?,?,?,'{}',?,'pat@example.test','P','pat@example.test','en','matched','account_email',?,'home-1','sub_1',?,?,?,'00',?,?,?,?,?,?)`)
    .bind(id, `CX-${id.slice(0, 8).toUpperCase()}`, o.received ?? NOW - DAY, o.kind ?? "ordinary_earliest", account, at, at, o.status ?? "open", synced ? 1 : 0, synced ? at : null,
      `op-${id.slice(0, 6)}`, NOW - DAY, NOW - DAY, o.status === "kept" ? "customer" : null).run();
}
const hex = (c: string) => c.repeat(32);
const keepCall = async (id: string, tok?: string) => call(`/v1/account/cancellations/${id}/keep`, tok ?? await token(), {});

describe("Astra CANCEL-SUMMARY-2 #1 (P1): Keep reports the subscription's outcome, keeps every eligible cancellation, refuses an ended plan", () => {
  beforeEach(async () => { await paidHome(); });

  it("two public declarations: one Keep keeps both; Stripe's end is cleared and the plan renews (stripeConfirmed true only then)", async () => {
    await declare(hex("a"), { effectiveAt: PERIOD_END }); await declare(hex("b"), { effectiveAt: PERIOD_END + 30 * DAY });
    subs.sub_1.cancel_at = PERIOD_END / 1000;
    expect(await (await keepCall(hex("a"))).json()).toEqual({ status: "kept", stripeConfirmed: true });
    expect((await env.DB.prepare("SELECT status FROM cancellation_requests ORDER BY id").all()).results).toEqual([{ status: "kept" }, { status: "kept" }]);
    expect(subs.sub_1.cancel_at).toBeNull();
  });

  it("a cancellation the customer cannot keep still ends the plan: Keep answers stripeConfirmed false (never a false promise of renewal)", async () => {
    await declare(hex("a")); await declare(hex("c"), { kind: "extraordinary", status: "reason_pending", effectiveAt: PERIOD_END - DAY });
    expect(await (await keepCall(hex("a"))).json()).toEqual({ status: "kept", stripeConfirmed: false, message: KEEP_UNCONFIRMED });
  });

  it("a public Keep also keeps the customer's in-app cancellation of the same plan", async () => {
    await call("/v1/account/cancel-plan", await token(), {});
    await declare(hex("a"));
    expect(await (await keepCall(hex("a"))).json()).toEqual({ status: "kept", stripeConfirmed: true });
    expect(await getSubRow()).toMatchObject({ customer_cancel_at: null, cancel_at_period_end: 0 });
  });

  it("an ended (canceled) subscription is refused: 409 too_late, nothing kept (Stripe cannot reactivate it)", async () => {
    await declare(hex("a"));
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled' WHERE home_id='home-1'").run();
    expect(await (await keepCall(hex("a"))).json()).toEqual({ error: "too_late" });
    expect(await env.DB.prepare("SELECT status FROM cancellation_requests").first()).toEqual({ status: "open" });
  });
});

describe("Astra CANCEL-SUMMARY-2 #2 (P1): an email-only buyer never loses the Keep window to the 24 h factor hold", () => {
  beforeEach(async () => { await paidHome(); });

  it("Keep of a public-form cancellation is sign-in only, the same gate as Cancel plan: no second factor, none trusted, still kept", async () => {
    expect(needsStepUp("POST", `/v1/account/cancellations/${hex("a")}/keep`)).toBe(false);
    expect(needsStepUp("POST", "/v1/account/cancel-plan")).toBe(false);
    await declare(hex("a"));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_trusted_factors").first<{ n: number }>()).toEqual({ n: 0 }); // email-only: no factor at all
    const r = await keepCall(hex("a"), await token()); // aal1, password sign-in only
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "kept" });
  });
});

describe("Astra CANCEL-SUMMARY-2 #3 (P2): the summary's Keep id comes from what Keep accepts, whatever declaration is shown", () => {
  beforeEach(async () => { await paidHome(); });
  type Cx = { state: string | null; id: string | null; kind: string | null; keepable: boolean; keepIds: string[] };
  const cx = async () => (await (await summary()).json<{ subscription: { cancellation: Cx } }>()).subscription.cancellation;

  it("a held declaration is shown and keepable (it was left out, so Keep was hidden)", async () => {
    await declare(hex("d"), { status: "held" });
    expect(await cx()).toMatchObject({ id: hex("d"), kind: "ordinary_earliest", keepable: true, keepIds: [hex("d")] });
  });

  it("the earliest declaration is not keepable (a serious reason under check): the id is the keepable one, so Keep stays offered", async () => {
    await declare(hex("c"), { kind: "extraordinary", status: "reason_pending", effectiveAt: PERIOD_END - DAY });
    await declare(hex("a"), { effectiveAt: PERIOD_END });
    expect(await cx()).toMatchObject({ id: hex("a"), kind: "ordinary_earliest", keepable: true, keepIds: [hex("a")] });
  });

  it("an in-app cancellation has its id (CX reference) and is keepable from the summary", async () => {
    const c = await (await call("/v1/account/cancel-plan", await token(), {})).json<{ reference: string }>();
    expect(await cx()).toMatchObject({ id: c.reference, kind: "in_app", keepable: true, keepIds: [c.reference] });
  });
});

describe("Astra CANCEL-SUMMARY-2 #4 (P2): current-revision confirmation wins over an older cached end date", () => {
  beforeEach(async () => { await paidHome(); });
  const A_END = PERIOD_END - 5 * DAY; const B_END = PERIOD_END - DAY;
  /** A kept earlier, B open; Stripe confirmed B's date for the current revision, but the stamping batch failed (B unsynced, the row's
   *  cancel_at still A's). */
  async function staged(value: number | null) {
    await declare(hex("a"), { effectiveAt: A_END, status: "kept" });
    await declare(hex("b"), { effectiveAt: B_END, synced: false });
    await env.DB.prepare("UPDATE billing_subscriptions SET cancel_at=? WHERE home_id='home-1'").bind(A_END).run();
    const rows = (await env.DB.prepare("SELECT id,last_op FROM cancellation_requests").all<{ id: string; last_op: string }>()).results;
    const rev = `|${rows.map((r) => `${r.id}:${r.last_op}`).sort().join("|")}|`;
    await env.DB.prepare(`INSERT INTO cancellation_stripe_mutations (id,subscription_id,home_id,kind,value,idempotency_key,state,created_at,resolved_at,decl_rev,decl_n)
      VALUES ('m-cur','sub_1','home-1','cancel_at',?,'cxlmut:m-cur','confirmed',?,?,?,2)`).bind(value === null ? null : value / 1000, NOW, NOW, rev).run();
  }
  const sub = async () => (await (await summary()).json<{ subscription: { activeUntil: number; cancelAtPeriodEnd: boolean; cancellation: { state: string; endsAt: number } } }>()).subscription;

  it("Stripe confirmed B for the current revision: the plan ends at B, not at A's stale cached date", async () => {
    await staged(B_END);
    expect(await sub()).toMatchObject({ cancelAtPeriodEnd: true, activeUntil: B_END, cancellation: { state: "confirmed", endsAt: B_END } });
  });

  it("a confirmed clear for the current revision: the stale cached date no longer ends the plan", async () => {
    await staged(null);
    await env.DB.prepare("UPDATE cancellation_requests SET status='kept' WHERE id=?").bind(hex("b")).run();
    // the revision moved with that change: re-stage the mutation for it
    await env.DB.prepare("DELETE FROM cancellation_stripe_mutations").run();
    const rows = (await env.DB.prepare("SELECT id,last_op FROM cancellation_requests").all<{ id: string; last_op: string }>()).results;
    await env.DB.prepare(`INSERT INTO cancellation_stripe_mutations (id,subscription_id,home_id,kind,value,idempotency_key,state,created_at,resolved_at,decl_rev,decl_n)
      VALUES ('m-clr','sub_1','home-1','cancel_at',NULL,'cxlmut:m-clr','confirmed',?,?,?,2)`).bind(NOW, NOW, `|${rows.map((r) => `${r.id}:${r.last_op}`).sort().join("|")}|`).run();
    expect(await sub()).toMatchObject({ cancelAtPeriodEnd: false, activeUntil: PERIOD_END });
  });
});

describe("Astra CANCEL-SUMMARY-2 #5 (P2): no renewal reminder while a cancellation or a Keep is unresolved, whatever the cache says", () => {
  beforeEach(async () => {
    await paidHome();
    await env.DB.prepare(`INSERT INTO billing_notices (id,home_id,kind,payload,created_at) VALUES ('renewal_reminder:home-1:1','home-1','renewal_reminder',?,?)`)
      .bind(JSON.stringify({ subscriptionId: "sub_1" }), NOW).run();
  });
  const stands = async () => (await env.DB.prepare(`SELECT ${reminderStandsSql("n")} AS ok FROM billing_notices n WHERE n.kind='renewal_reminder'`).first<{ ok: number }>())!.ok;

  it("a renewing plan: the reminder stands", async () => { expect(await stands()).toBe(1); });
  it("a public cancellation Stripe has not confirmed yet (no cached end): no reminder", async () => {
    await declare(hex("a"), { synced: false });
    expect(await stands()).toBe(0);
  });
  it("Keep pressed, Stripe's clear not confirmed, and no cancel_at was ever cached: no reminder", async () => {
    await declare(hex("a"), { status: "kept", synced: false });
    expect((await getSubRow()).cancel_at).toBeNull();
    expect(await stands()).toBe(0);
  });
  it("an in-app Keep in flight (a revision Stripe has not confirmed): no reminder", async () => {
    await env.DB.prepare("UPDATE billing_subscriptions SET cancel_intent_rev=cancel_intent_rev+1 WHERE home_id='home-1'").run();
    expect(await stands()).toBe(0);
  });
});

describe("Astra CANCEL-SUMMARY-2 #6 (P2): the cancellation state is derived apart from 'ends this billing period'", () => {
  beforeEach(async () => { await paidHome(); });
  type S = { cancelAtPeriodEnd: boolean; activeUntil: number; cancellation: { state: string | null; endsAt: number | null } };
  const sub = async () => (await (await summary()).json<{ subscription: S }>()).subscription;

  it("a Stripe-confirmed chosen date beyond this period is confirmed (not pending); the plan renews once more first", async () => {
    const LATER = PERIOD_END + 40 * DAY;
    await declare(hex("e"), { kind: "ordinary_date", effectiveAt: LATER });
    expect(await sub()).toMatchObject({ cancelAtPeriodEnd: false, activeUntil: PERIOD_END, cancellation: { state: "confirmed", endsAt: LATER } });
  });

  it("Keep not confirmed by Stripe and no end date ever cached: keeping (not null), and the plan still shows its end until Stripe confirms", async () => {
    await declare(hex("a"), { status: "kept", synced: false, effectiveAt: PERIOD_END - DAY });
    expect((await getSubRow()).cancel_at).toBeNull();
    expect(await sub()).toMatchObject({ cancelAtPeriodEnd: true, activeUntil: PERIOD_END - DAY, cancellation: { state: "keeping", endsAt: PERIOD_END - DAY } });
  });

  it("a public cancellation Stripe has not confirmed yet is pending; an in-app one confirmed by Stripe is confirmed", async () => {
    await declare(hex("a"), { synced: false });
    expect((await sub()).cancellation.state).toBe("pending");
    await env.DB.prepare("DELETE FROM cancellation_requests").run();
    await call("/v1/account/cancel-plan", await token(), {});
    expect(await sub()).toMatchObject({ cancelAtPeriodEnd: true, cancellation: { state: "confirmed", endsAt: PERIOD_END } });
  });
});

describe("Astra CANCEL-SUMMARY-2 #7 (P2): endedAt is an immutable terminal timestamp", () => {
  beforeEach(async () => { await paidHome(); });

  async function webhook(type: string, object: Record<string, unknown>, created: number) {
    const raw = JSON.stringify({ id: `evt_a7_${Math.random().toString(36).slice(2, 10)}`, type, created: Math.floor(created / 1000), data: { object } });
    const ctx = createExecutionContext();
    const res = await worker().fetch(new Request("https://auth.murage.test/v1/billing/webhook", { method: "POST", body: raw, headers: { "content-type": "application/json",
      "stripe-signature": await signStripePayload(raw, "whsec_testonlyfixturesecret0123456789", Math.floor(Date.now() / 1000)) } }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
  }

  it("a delayed update after the end never moves endedAt or activeUntil", async () => {
    at(NOW + HOUR);
    subs.sub_1.status = "canceled";
    await webhook("customer.subscription.deleted", subJson("sub_1", subs.sub_1), NOW + HOUR);
    expect((await getSubRow()).ended_at).toBe(NOW + HOUR);
    at(NOW + 5 * DAY);
    await webhook("customer.subscription.updated", subJson("sub_1", subs.sub_1), NOW + 5 * DAY); // a late, delayed update
    expect((await getSubRow()).updated_at).toBe(NOW + 5 * DAY);
    expect((await getSubRow()).ended_at).toBe(NOW + HOUR);
    expect(await (await summary()).json()).toMatchObject({ subscription: { ended: true, endedAt: NOW + HOUR, activeUntil: NOW + HOUR } });
  });
});

describe("Astra CANCEL-SUMMARY-2 #8 (P3): the two documented plan-change errors for a plan Stripe shows ending", () => {
  beforeEach(async () => { await paidHome(); envOver = { CLOUD_PLAN_CHANGE: "1" }; });

  it("preview: 409 plan_change_unavailable (nothing quoted); a quote taken before: 409 quote_stale at the charge step", async () => {
    await env.DB.prepare(`INSERT INTO provision_choices (home_id,resource_generation,provider,server_type,location,arch,image,tried,created_at)
      SELECT id,resource_generation,'hetzner','cx33','fsn1','x86','img','[]',? FROM cloud_homes WHERE id='home-1'`).bind(NOW).run();
    subs.sub_1.cancel_at = PERIOD_END / 1000; // Stripe shows an end the local row has not learned yet
    expect(await (await call("/v1/account/plan/preview", await token(), { plan: "max" })).json()).toEqual({ error: "plan_change_unavailable" });
    subs.sub_1.cancel_at = null;
    const q = await (await call("/v1/account/plan/preview", await token(), { plan: "max" })).json<{ quoteId: string }>();
    expect(q.quoteId).toEqual(expect.any(String));
    subs.sub_1.cancel_at = PERIOD_END / 1000;
    expect(await (await call("/v1/account/plan", await token({ aal2: true }), { quoteId: q.quoteId })).json()).toEqual({ error: "quote_stale" });
    // A downgrade is refused as before B4, whatever Stripe shows.
    expect(await (await call("/v1/account/plan/preview", await token(), { plan: "starter" })).json()).toMatchObject({ error: "downgrade_not_available" });
  });
});

// ---- Astra JOURNEY-B-1 ---------------------------------------------------------------------------------------------------------------

describe("Astra JOURNEY-B-1: deletion, Keep and the refund clock", () => {
  beforeEach(async () => { await paidHome(); });
  const sweepDeps = () => ({ notifier, stripeFetch, flux: flux as FluxEntitlementHooks });
  const keepIt = async (id: string, tok?: string) => call(`/v1/account/cancellations/${id}/keep`, tok ?? await token(), {});
  const cancelPlan = async () => (await call("/v1/account/cancel-plan", await token(), {})).json<{ canceled: boolean; reference: string }>();
  const inAppRef = async () => (await env.DB.prepare("SELECT reference FROM plan_cancellations WHERE home_id='home-1'").first<{ reference: string }>())!.reference;
  async function hookEvent(type: string, object: Record<string, unknown>, createdMs = Date.now()) {
    const raw = JSON.stringify({ id: `evt_jb1_${Math.random().toString(36).slice(2, 10)}`, type, created: Math.floor(createdMs / 1000), data: { object } });
    const ctx = createExecutionContext();
    const res = await worker().fetch(new Request("https://auth.murage.test/v1/billing/webhook", { method: "POST", body: raw, headers: { "content-type": "application/json",
      "stripe-signature": await signStripePayload(raw, "whsec_testonlyfixturesecret0123456789", Math.floor(Date.now() / 1000)) } }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("#1: the deletion hold, the cancellation intent and its receipt commit in ONE transaction (an interruption leaves none of them)", async () => {
    await env.DB.prepare("CREATE TRIGGER jb1_interrupt BEFORE INSERT ON plan_cancellations BEGIN SELECT RAISE(ABORT, 'interrupted'); END").run();
    try { expect((await deleteHold()).status).not.toBe(202); }
    finally { await env.DB.prepare("DROP TRIGGER jb1_interrupt").run(); }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_recovery_holds WHERE home_id='home-1'").first()).toEqual({ n: 0 });
    expect(await getSubRow()).toMatchObject({ customer_cancel_at: null, cancel_intent_rev: 0 });
    expect(cancelCalls()).toEqual([]);
    // Uninterrupted: all three, then Stripe.
    expect((await deleteHold()).status).toBe(202);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_recovery_holds WHERE home_id='home-1' AND action='delete'").first()).toEqual({ n: 1 });
    expect(await getSubRow()).toMatchObject({ customer_cancel_at: NOW, cancel_at_period_end: 1 });
    expect(await inAppRef()).toMatch(/^CX-/);
  });

  it("#2: public Keep is refused while the deletion waits, and never keeps a replaced contract's cancellation through an old declaration", async () => {
    await deleteHold();
    await declare(hex("a"));
    expect(await (await keepCall(hex("a"))).json()).toEqual({ error: "not_keepable" });
    expect(await env.DB.prepare("SELECT status FROM cancellation_requests WHERE id=?").bind(hex("a")).first()).toEqual({ status: "open" });
    expect((await getSubRow()).customer_cancel_at).toBe(NOW);
  });
  it("#2: an old contract's declaration cannot clear the current subscription's in-app cancellation", async () => {
    await cancelPlan();
    await declare(hex("b"));
    await env.DB.prepare("UPDATE cancellation_requests SET subscription_id='sub_old' WHERE id=?").bind(hex("b")).run();
    expect(await (await keepCall(hex("b"))).json()).toEqual({ error: "not_keepable" });
    expect(await getSubRow()).toMatchObject({ customer_cancel_at: NOW, cancel_at_period_end: 1 });
  });

  it("#9: a never-ready home that failed keeps an open window; only persistent evidence (ready_at, ready_legacy) closes it", async () => {
    await env.DB.prepare("UPDATE cloud_homes SET ready_at=NULL,ready_pending_at=NULL,ready_legacy=0,desired_state='failed' WHERE id='home-1'").run();
    at(NOW + 30 * DAY);
    expect((await (await summary()).json<{ subscription: Record<string, unknown> }>()).subscription).toMatchObject({ refundWindowEndsAt: null, refundWindowStartsWhenReady: true });
    expect((await quoteFirstMonthRefund(testEnv(), "home-1", NOW + 30 * DAY)).reason).not.toBe("window_expired");
    await env.DB.prepare("UPDATE cloud_homes SET ready_legacy=1,desired_state='ready' WHERE id='home-1'").run();
    expect((await quoteFirstMonthRefund(testEnv(), "home-1", NOW + 30 * DAY)).reason).toBe("window_expired");
  });

  it("#10: Stripe shows the plan ended while the local row says active: public and in-app Keep both answer too_late, nothing kept", async () => {
    await declare(hex("a"));
    const c = await cancelPlan();
    subs.sub_1.status = "canceled";
    expect(await (await keepCall(hex("a"))).json()).toEqual({ error: "too_late" });
    expect(await (await keepIt(c.reference)).json()).toEqual({ error: "too_late" });
    expect(await env.DB.prepare("SELECT status FROM cancellation_requests WHERE id=?").bind(hex("a")).first()).toEqual({ status: "open" });
    expect((await getSubRow()).customer_cancel_at).toBe(NOW);
  });

  it("#11: after a confirmed Keep, the cancellation's own late event restores nothing and sends no cancel notice", async () => {
    const c = await cancelPlan();
    expect(await (await keepIt(c.reference)).json()).toEqual({ status: "kept", stripeConfirmed: true });
    notices = [];
    expect((await hookEvent("customer.subscription.updated", { ...subJson("sub_1", { ...subs.sub_1, cancel_at_period_end: true }),
      cancellation_details: { reason: "cancellation_requested" } }, NOW - MIN)).status).toBe(200);
    expect(await getSubRow()).toMatchObject({ cancel_at_period_end: 0, customer_cancel_at: null });
    expect(notices.filter((n) => n.kind === "cancel_scheduled")).toEqual([]);
  });

  it("#12: an in-app Keep Stripe has not confirmed is `keeping` even when no end was ever cached", async () => {
    stripeDown = true;
    await call("/v1/account/cancel-plan", await token(), {});
    expect(await getSubRow()).toMatchObject({ cancel_at_period_end: 0 });
    expect(await (await keepIt(await inAppRef())).json()).toEqual({ status: "kept", stripeConfirmed: false, message: KEEP_UNCONFIRMED });
    expect((await (await summary()).json<{ subscription: { cancellation: { state: string | null } } }>()).subscription.cancellation.state).toBe("keeping");
  });

  it("#13: a completed public cancellation Stripe has not settled blocks the renewal reminder", async () => {
    await env.DB.prepare(`INSERT INTO billing_notices (id,home_id,kind,payload,created_at) VALUES ('renewal_reminder:home-1:jb1','home-1','renewal_reminder',?,?)`)
      .bind(JSON.stringify({ subscriptionId: "sub_1" }), NOW).run();
    await declare(hex("a"), { status: "completed", synced: false, effectiveAt: NOW - HOUR });
    expect((await env.DB.prepare(`SELECT ${reminderStandsSql("n")} AS ok FROM billing_notices n WHERE n.kind='renewal_reminder'`).first<{ ok: number }>())!.ok).toBe(0);
  });

  it("#16: every receipt reference comes from the shared allocator: reserved across both tables, a collision retried", async () => {
    await deleteHold();
    const ref = await inAppRef();
    expect(await env.DB.prepare("SELECT owner FROM cancel_references WHERE reference=?").bind(ref).first()).toEqual({ owner: "plan:home-1:sub_1" });
    await env.DB.prepare("INSERT INTO cancel_references (reference,owner,created_at) VALUES ('CX-AAAAAAAA','public:taken',0)").run();
    const tries = ["CX-AAAAAAAA", "CX-BBBBBBBB"];
    expect(await allocateCancelRef(testEnv(), "plan:x:y", NOW, () => tries.shift()!)).toBe("CX-BBBBBBBB");
  });
});

describe("Astra JOURNEY-B-1 #7 (P2): the refund clock is anchored to the ready email, whose queueing is durable work", () => {
  it("#7: the refund clock starts when the ready email is queued; a queue that failed is retried durably, also days later", async () => {
    await paidHome(false);
    // The home's billing lease is busy when the canary passes: the ready email cannot be queued then.
    await env.DB.prepare(`INSERT INTO billing_home_leases (home_id,holder,lease_until) VALUES ('home-1','someone-else',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)+3600000)
      ON CONFLICT(home_id) DO UPDATE SET holder='someone-else',lease_until=excluded.lease_until`).run();
    at(NOW + DAY);
    await canary();
    expect(await getHome()).toMatchObject({ ready_at: null, ready_pending_at: NOW + DAY });
    expect((await (await summary()).json<{ subscription: Record<string, unknown> }>()).subscription).toMatchObject({ refundWindowEndsAt: null, refundWindowStartsWhenReady: true });
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    at(NOW + 4 * DAY); // long after the old 24-hour selection cutoff
    await sweepBilling(testEnv(), { notifier, stripeFetch, flux: flux as FluxEntitlementHooks }).catch(() => undefined);
    expect((await getHome()).ready_at).toBe(NOW + 4 * DAY);
    const n = await env.DB.prepare("SELECT created_at FROM billing_notices WHERE kind='server_ready' AND home_id='home-1'").all<{ created_at: number }>();
    expect(n.results).toEqual([{ created_at: NOW + 4 * DAY }]);
    // The notice-retry loop runs first in the sweep (Astra MAILRETRY-6 P1), so the email queued by this run goes out on the next one.
    await sweepBilling(testEnv(), { notifier, stripeFetch, flux: flux as FluxEntitlementHooks }).catch(() => undefined);
    expect((await (await summary()).json<{ subscription: Record<string, unknown> }>()).subscription).toMatchObject({ refundWindowEndsAt: aoeEnd(NOW + 4 * DAY, 7) });
  });

  it("#7 + auto-canary: the promotion batch committed but queueServerReady never ran; the billing sweep's readyUnqueued path sends the email", async () => {
    await paidHome(false);
    const passAt = NOW + 10 * MIN; // within the provisioning budget
    at(passAt);
    // Live evidence for the current generation, and a ready endpoint written during this provisioning budget.
    await env.DB.prepare("UPDATE cloud_homes SET heartbeat_at=? WHERE id='home-1'").bind(passAt).run();
    // ... with the home's own readiness checks passing (UI bundle complete, data volume writable, UI rendered).
    // ... and a render that just finished in the running app process (Astra AUTOCANARY-5 P1), all of it a report accepted at the home's
    // current evidence epoch (Astra AUTOCANARY-10).
    await env.DB.prepare(`INSERT INTO cloud_home_health (home_id,reported_at,app_reported_at,app_ok_at,generation,app_ok,ui_bundle_ok,data_writable_ok,ui_renders_ok,
        ui_rendered_at,ui_instance,ui_boot_id,boot_id,ui_age_ms,app_sampled_at,evidence_epoch,report_epoch,report_at,report_echo)
      VALUES ('home-1',?1,?1,?1,?2,1,1,1,1,?1,'AbCdEfGhIjKlMnOpQrSt_-','boot-1','boot-1',0,?1,0,0,?1,1)
      ON CONFLICT(home_id) DO UPDATE SET reported_at=excluded.reported_at,app_reported_at=excluded.app_reported_at,app_ok_at=excluded.app_ok_at,
        generation=excluded.generation,app_ok=1,ui_bundle_ok=1,data_writable_ok=1,ui_renders_ok=1,ui_rendered_at=excluded.ui_rendered_at,
        ui_instance=excluded.ui_instance,ui_boot_id=excluded.ui_boot_id,boot_id=excluded.boot_id,ui_age_ms=excluded.ui_age_ms,
        app_sampled_at=excluded.app_sampled_at,evidence_epoch=0,report_epoch=0,report_at=excluded.report_at,report_echo=1`)
      .bind(passAt, generation).run();
    await env.DB.prepare(`INSERT INTO machine_endpoints (machine_id,hostname,tunnel_name,tunnel_id,dns_record_id,status,created_at,updated_at)
      VALUES ('home-1','home-1.murage.test','tunnel-home-1','tunnel-1','dns-1','ready',?,?)
      ON CONFLICT(machine_id) DO UPDATE SET status='ready',tunnel_id='tunnel-1',dns_record_id='dns-1',updated_at=excluded.updated_at`).bind(passAt, passAt).run();
    // The step after the batch (queueServerReady under the home's billing lease) does not happen: the lease is held elsewhere, exactly as
    // if the Worker had died between the batch and that call.
    await env.DB.prepare(`INSERT INTO billing_home_leases (home_id,holder,lease_until) VALUES ('home-1','someone-else',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)+3600000)
      ON CONFLICT(home_id) DO UPDATE SET holder='someone-else',lease_until=excluded.lease_until`).run();
    // The control plane's probe: /api/health, then the public UI shell and its one entry script (b3-control probeHome).
    const servedHome = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/health") return Response.json({ app: "murage", ui: "ok", uiAt: passAt, instance: "AbCdEfGhIjKlMnOpQrSt_-" });
      if (path === "/") return new Response('<title>Murage</title><script type="module" crossorigin src="/assets/index-Ab12.js"></script><div id="root"></div>',
        { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response("export {};", { headers: { "content-type": "text/javascript" } });
    }) as typeof fetch;
    await reconcileB3(testEnv(), { provider, probeFetch: servedHome });
    expect(await getHome()).toMatchObject({ desired_state: "ready", ready_at: null, ready_pending_at: passAt });
    expect((await env.DB.prepare("SELECT 1 AS x FROM billing_notices WHERE kind='server_ready' AND home_id='home-1'").all()).results).toHaveLength(0);
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    at(NOW + 4 * DAY);
    await sweepBilling(testEnv(), { notifier, stripeFetch, flux: flux as FluxEntitlementHooks }).catch(() => undefined);
    expect((await getHome()).ready_at).toBe(NOW + 4 * DAY);
    const n = await env.DB.prepare("SELECT created_at FROM billing_notices WHERE kind='server_ready' AND home_id='home-1'").all<{ created_at: number }>();
    expect(n.results).toEqual([{ created_at: NOW + 4 * DAY }]);
  });

});

describe("Astra JOURNEY-B-2: deletion holds, aggregate Keep, late events, the ready email, references", () => {
  beforeEach(async () => { await paidHome(); });
  const sweepDeps = () => ({ notifier, stripeFetch, flux: flux as FluxEntitlementHooks });
  const keepIt = async (id: string, tok?: string) => call(`/v1/account/cancellations/${id}/keep`, tok ?? await token(), {});
  const cancelPlan = async () => (await call("/v1/account/cancel-plan", await token(), {})).json<{ canceled: boolean; reference: string }>();
  const declStatus = async (id: string) => (await env.DB.prepare("SELECT status FROM cancellation_requests WHERE id=?").bind(id).first<{ status: string }>())?.status;
  async function hookEvent(type: string, object: Record<string, unknown>, createdMs = Date.now()) {
    const raw = JSON.stringify({ id: `evt_jb2_${Math.random().toString(36).slice(2, 10)}`, type, created: Math.floor(createdMs / 1000), data: { object } });
    const ctx = createExecutionContext();
    const res = await worker().fetch(new Request("https://auth.murage.test/v1/billing/webhook", { method: "POST", body: raw, headers: { "content-type": "application/json",
      "stripe-signature": await signStripePayload(raw, "whsec_testonlyfixturesecret0123456789", Math.floor(Date.now() / 1000)) } }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }
  const renewCalls = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/subscriptions/sub_1" && c.form.get("cancel_at_period_end") === "false");

  it("#1: a deletion while a Keep is unconfirmed writes its own cancellation intent; renewal is never sent to Stripe while the deletion waits", async () => {
    const c = await cancelPlan();
    stripePostDown = true; // Keep pressed, Stripe's clear does not go through: the cached flag still says "ending"
    expect(await (await keepIt(c.reference)).json()).toEqual({ status: "kept", stripeConfirmed: false, message: KEEP_UNCONFIRMED });
    expect(await getSubRow()).toMatchObject({ customer_cancel_at: null, cancel_at_period_end: 1 });
    stripePostDown = false; stripeCalls = [];
    expect((await deleteHold()).status).toBe(202);
    expect((await getSubRow()).customer_cancel_at).toBe(NOW);
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    expect(renewCalls()).toEqual([]);
    expect(subs.sub_1.cancel_at_period_end).toBe(true);
    expect(await getSubRow()).toMatchObject({ cancel_at_period_end: 1 });
    expect((await getSubRow()).cancel_intent_rev).toBe((await getSubRow()).cancel_synced_rev);
  });

  it("#4: Keep commits every reversal in ONE batch: a failure in any part keeps nothing, and the retry keeps all (public pressed)", async () => {
    const c = await cancelPlan();
    await declare(hex("a"));
    await env.DB.prepare("CREATE TRIGGER jb2_keep_fail BEFORE INSERT ON plan_cancellation_keeps BEGIN SELECT RAISE(ABORT, 'interrupted'); END").run();
    try { expect((await keepCall(hex("a"))).status).not.toBe(200); }
    finally { await env.DB.prepare("DROP TRIGGER jb2_keep_fail").run(); }
    expect(await declStatus(hex("a"))).toBe("open");
    expect((await getSubRow()).customer_cancel_at).toBe(NOW);
    expect(await (await keepCall(hex("a"))).json()).toEqual({ status: "kept", stripeConfirmed: true });
    expect((await getSubRow()).customer_cancel_at).toBeNull();
    expect(await (await keepIt(c.reference)).json()).toEqual({ error: "already_kept" });
  });
  it("#4: the in-app direction too, and lease contention keeps nothing (busy), never half a plan", async () => {
    const c = await cancelPlan();
    await declare(hex("b"));
    await env.DB.prepare("CREATE TRIGGER jb2_decl_fail BEFORE UPDATE OF status ON cancellation_requests WHEN NEW.status='kept' BEGIN SELECT RAISE(ABORT, 'interrupted'); END").run();
    try { expect((await keepIt(c.reference)).status).not.toBe(200); }
    finally { await env.DB.prepare("DROP TRIGGER jb2_decl_fail").run(); }
    expect((await getSubRow()).customer_cancel_at).toBe(NOW);
    expect(await declStatus(hex("b"))).toBe("open");
    await env.DB.prepare(`INSERT INTO billing_home_leases (home_id,holder,lease_until) VALUES ('home-1','someone-else',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)+3600000)
      ON CONFLICT(home_id) DO UPDATE SET holder='someone-else',lease_until=excluded.lease_until`).run();
    expect(await (await keepIt(c.reference)).json()).toEqual({ error: "busy" });
    expect((await getSubRow()).customer_cancel_at).toBe(NOW);
    expect(await declStatus(hex("b"))).toBe("open");
    await env.DB.prepare("UPDATE billing_home_leases SET holder=NULL,lease_until=NULL WHERE home_id='home-1'").run();
    expect(await (await keepIt(c.reference)).json()).toEqual({ status: "kept", stripeConfirmed: true });
    expect(await declStatus(hex("b"))).toBe("kept");
    expect((await getSubRow()).customer_cancel_at).toBeNull();
  });

  it("#5: a cancellation event timestamped after the Keep, cancel_at unchanged, is checked against live Stripe: nothing restored, no notice, no re-cancel", async () => {
    const c = await cancelPlan();
    at(NOW + HOUR);
    expect(await (await keepIt(c.reference)).json()).toEqual({ status: "kept", stripeConfirmed: true });
    notices = []; stripeCalls = [];
    expect((await hookEvent("customer.subscription.updated", { ...subJson("sub_1", { ...subs.sub_1, cancel_at_period_end: true }),
      cancellation_details: { reason: "cancellation_requested" } }, NOW + 2 * HOUR)).status).toBe(200);
    expect(await getSubRow()).toMatchObject({ cancel_at_period_end: 0, customer_cancel_at: null });
    expect(notices.filter((n) => n.kind === "cancel_scheduled")).toEqual([]);
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    expect(cancelCalls().filter((x) => x.form.get("cancel_at_period_end") === "true")).toEqual([]);
    expect(subs.sub_1.cancel_at_period_end).toBe(false);
  });

  it("#9: a reference that cannot be reserved is never an unreserved CX: the declaration is filed under its id and the sweep reserves one", async () => {
    await env.DB.prepare("CREATE TRIGGER jb2_ref_fail BEFORE INSERT ON cancel_references BEGIN SELECT RAISE(ABORT, 'unavailable'); END").run();
    let res: Response;
    try {
      res = await call("/v1/public/cancellation", null, { type: "end_of_paid_month", email: "pat@example.test", name: "Pat", confirmationEmail: "pat@example.test" });
    } finally { await env.DB.prepare("DROP TRIGGER jb2_ref_fail").run(); }
    expect(res.status).toBe(201);
    const row = (await env.DB.prepare("SELECT id,ref FROM cancellation_requests").first<{ id: string; ref: string }>())!;
    expect(row.ref).toBe(row.id);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cancel_references WHERE owner=?").bind(`public:${row.id}`).first()).toEqual({ n: 0 });
    const { allocatePendingReferences } = await import("../src/public-cancellation");
    await allocatePendingReferences(testEnv(), NOW);
    const after = (await env.DB.prepare("SELECT ref FROM cancellation_requests WHERE id=?").bind(row.id).first<{ ref: string }>())!.ref;
    expect(after).toMatch(/^CX-/);
    expect(await env.DB.prepare("SELECT owner FROM cancel_references WHERE reference=?").bind(after).first()).toEqual({ owner: `public:${row.id}` });
  });

  it("#10: while a deletion waits, the summary offers no Keep for a public declaration either (Keep would refuse it)", async () => {
    await declare(hex("a"));
    type Cx = { keepIds: string[]; keepable: boolean };
    expect((await (await summary()).json<{ subscription: { cancellation: Cx } }>()).subscription.cancellation.keepIds).toEqual([hex("a")]);
    await deleteHold();
    const cx = (await (await summary()).json<{ subscription: { cancellation: Cx } }>()).subscription.cancellation;
    expect(cx.keepIds).toEqual([]);
    expect(await (await keepCall(hex("a"))).json()).toEqual({ error: "not_keepable" });
  });
});

describe("Astra JOURNEY-B-2 #6 and JOURNEY-A-3 #7: the refund clock starts at the ready email's handoff; every quote carries its window", () => {
  it("#6: queued but never handed off, a day-8 request is still inside the window; the handoff starts the 7 days", async () => {
    await paidHome(false);
    at(NOW + DAY);
    await canary();
    expect((await getHome()).ready_at).toBe(NOW + DAY);
    expect(await env.DB.prepare("SELECT sent_at FROM billing_notices WHERE id='server_ready:home-1:first'").first()).toEqual({ sent_at: null });
    const day8 = aoeEnd(NOW + DAY, 7) + HOUR;
    at(day8);
    const q = await quoteFirstMonthRefund(testEnv(), "home-1", day8);
    expect(q.reason).not.toBe("window_expired");
    expect(q.window).toEqual({ deadline: null, startsWhenReady: true });
    expect((await (await summary()).json<{ subscription: Record<string, unknown> }>()).subscription).toMatchObject({ refundWindowEndsAt: null, refundWindowStartsWhenReady: true });
    await sweepBilling(testEnv(), { notifier, stripeFetch, flux: flux as FluxEntitlementHooks }).catch(() => undefined);
    expect((await (await summary()).json<{ subscription: Record<string, unknown> }>()).subscription).toMatchObject({ refundWindowEndsAt: aoeEnd(day8, 7), refundWindowStartsWhenReady: false });
    expect((await quoteFirstMonthRefund(testEnv(), "home-1", aoeEnd(day8, 7) + 1)).window).toEqual({ deadline: aoeEnd(day8, 7), startsWhenReady: false });
  });
  it("A-3 #7: a not-ready home quotes { deadline: null, startsWhenReady: true } through the public quote function, in every outcome", async () => {
    await paidHome(false);
    const q = await quoteFirstMonthRefund(testEnv(), "home-1", NOW + 30 * DAY);
    expect(q.window).toEqual({ deadline: null, startsWhenReady: true });
    expect(q.startsWhenReady).toBe(true);
    await env.DB.prepare("UPDATE billing_subscriptions SET first_invoice_id=NULL WHERE home_id='home-1'").run();
    const none = await quoteFirstMonthRefund(testEnv(), "home-1", NOW + 30 * DAY);
    expect(none).toMatchObject({ reason: "no_first_payment", window: { deadline: null, startsWhenReady: true } });
  });
});

describe("Astra JOURNEY-B-3: unresolved renew keys", () => {
  beforeEach(async () => { await paidHome(); });
  const sweepDeps = () => ({ notifier, stripeFetch, flux: flux as FluxEntitlementHooks });
  const keepIt = async (id: string) => call(`/v1/account/cancellations/${id}/keep`, await token(), {});
  const cancelPlan = async () => (await call("/v1/account/cancel-plan", await token(), {})).json<{ canceled: boolean; reference: string }>();
  const synced = async () => { const r = await getSubRow(); return r.cancel_intent_rev === r.cancel_synced_rev; };
  const alertOf = (kind: string) => env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind=?").bind(kind).first<{ kind: string }>();

  it("#1: a rate-limited (429, not replayed) settle of the pending renew key never marks the cancellation synced; the delayed original cannot restore renewal", async () => {
    const c = await cancelPlan();
    stripePostDown = true; // Keep pressed; its renew request's answer is lost
    expect(await (await keepIt(c.reference)).json()).toEqual({ status: "kept", stripeConfirmed: false, message: KEEP_UNCONFIRMED });
    const renewKey = (await env.DB.prepare("SELECT idempotency_key AS k FROM sub_mutations WHERE desired_cancel=0 AND state='pending'").first<{ k: string }>())!.k;
    stripePostDown = false; rateLimitedKeys.add(renewKey);
    expect((await deleteHold()).status).toBe(202);
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    // The 429 settles nothing: the renew mutation stays pending and the cancellation is not called synced.
    expect(await env.DB.prepare("SELECT state FROM sub_mutations WHERE idempotency_key=?").bind(renewKey).first()).toEqual({ state: "pending" });
    expect(await synced()).toBe(false);
    // The delayed original renew request lands at Stripe now (the 429 did not consume its key).
    subKeyParams[renewKey] = "false"; subs.sub_1.cancel_at_period_end = false;
    rateLimitedKeys.clear();
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    // Its key answers definitively (spent, other parameters): settled; the end is sent under a fresh key and read back.
    expect(await env.DB.prepare("SELECT state FROM sub_mutations WHERE idempotency_key=?").bind(renewKey).first()).toEqual({ state: "superseded" });
    expect(subs.sub_1.cancel_at_period_end).toBe(true);
    expect(await synced()).toBe(true);
    expect(await getSubRow()).toMatchObject({ cancel_at_period_end: 1 });
  });

});

describe("Astra JOURNEY-B-3 #5: the ready email's refund deadline is generated at its handoff, with the eligibility clock", () => {
  async function queuedNotHandedOff() {
    await paidHome(false);
    at(NOW + DAY);
    await canary();
    expect(await env.DB.prepare("SELECT sent_at FROM billing_notices WHERE id='server_ready:home-1:first'").first()).toEqual({ sent_at: null });
    const day8 = aoeEnd(NOW + DAY, 7) + HOUR;
    at(day8);
    return day8;
  }
  it("a delayed handoff states the deadline that eligibility uses (custom notifier: the sweep regenerates it)", async () => {
    const day8 = await queuedNotHandedOff();
    await sweepBilling(testEnv(), { notifier, stripeFetch, flux: flux as FluxEntitlementHooks }).catch(() => undefined);
    const ready = notices.find((n) => n.kind === "server_ready")!;
    expect(ready.data.refundWindowEndsAt).toBe(aoeEnd(day8, 7));
    expect(String(ready.data.emailText)).toContain(`Ask by the end of ${aoeDate(aoeEnd(day8, 7))}`);
    expect((await (await summary()).json<{ subscription: Record<string, unknown> }>()).subscription).toMatchObject({ refundWindowEndsAt: aoeEnd(day8, 7) });
  });
  it("the default notifier generates it with the clock it records as sent_at", async () => {
    const day8 = await queuedNotHandedOff();
    const sent: { text: string }[] = [];
    const e = { ...testEnv(), EMAIL: { send: async (m: { text: string }) => { sent.push(m); } } } as unknown as Env;
    await sweepBilling(e, { stripeFetch, flux: flux as FluxEntitlementHooks }).catch(() => undefined);
    expect(await env.DB.prepare("SELECT sent_at FROM billing_notices WHERE id='server_ready:home-1:first'").first()).toEqual({ sent_at: day8 });
    const text = sent.map((m) => m.text).find((t) => t.includes("server is ready"))!;
    expect(text).toContain(`Ask by the end of ${aoeDate(aoeEnd(day8, 7))}`);
    expect((await quoteFirstMonthRefund(testEnv(), "home-1", day8)).window).toEqual({ deadline: aoeEnd(day8, 7), startsWhenReady: false });
  });
});

describe("Astra JOURNEY-B-4 #1 and JOURNEY-B-5 #1: only proven key settlement retires a pending renew request", () => {
  beforeEach(async () => { await paidHome(); });
  const sweepDeps = () => ({ notifier, stripeFetch, flux: flux as FluxEntitlementHooks });
  const keepIt = async (id: string) => call(`/v1/account/cancellations/${id}/keep`, await token(), {});
  const cancelPlan = async () => (await call("/v1/account/cancel-plan", await token(), {})).json<{ canceled: boolean; reference: string }>();
  const synced = async () => { const r = await getSubRow(); return r.cancel_intent_rev === r.cancel_synced_rev; };
  const alertOf = (kind: string) => env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind=?").bind(kind).first<{ kind: string }>();

  it("#1: an uncached validation 400 on the pending renew key settles nothing: not synced; the delayed original cannot restore renewal", async () => {
    const c = await cancelPlan();
    stripePostDown = true; // Keep pressed; its renew request's answer is lost
    expect(await (await keepIt(c.reference)).json()).toEqual({ status: "kept", stripeConfirmed: false, message: KEEP_UNCONFIRMED });
    const renewKey = (await env.DB.prepare("SELECT idempotency_key AS k FROM sub_mutations WHERE desired_cancel=0 AND state='pending'").first<{ k: string }>())!.k;
    stripePostDown = false; validationKeys.add(renewKey);
    expect((await deleteHold()).status).toBe(202);
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    // A validation refusal saved nothing under the key: the renew mutation stays pending and the cancellation is not called synced.
    expect(await env.DB.prepare("SELECT state FROM sub_mutations WHERE idempotency_key=?").bind(renewKey).first()).toEqual({ state: "pending" });
    expect(await synced()).toBe(false);
    // The delayed original renew request lands at Stripe now.
    subKeyParams[renewKey] = "false"; subs.sub_1.cancel_at_period_end = false;
    validationKeys.clear();
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    // Now its key answers an idempotency refusal (spent): settled; the end is sent under a fresh key and read back.
    expect(await env.DB.prepare("SELECT state FROM sub_mutations WHERE idempotency_key=?").bind(renewKey).first()).toEqual({ state: "superseded" });
    expect(subs.sub_1.cancel_at_period_end).toBe(true);
    expect(await synced()).toBe(true);
  });

  /** Keep pressed with its renew request's answer lost: the pending renew mutation and its key. */
  async function lostRenew() {
    const c = await cancelPlan();
    stripePostDown = true;
    expect(await (await keepIt(c.reference)).json()).toEqual({ status: "kept", stripeConfirmed: false, message: KEEP_UNCONFIRMED });
    stripePostDown = false;
    return (await env.DB.prepare("SELECT id,idempotency_key AS k FROM sub_mutations WHERE desired_cancel=0 AND state='pending'").first<{ id: string; k: string }>())!;
  }
  const mutation = (id: string) => env.DB.prepare("SELECT state,dispatched_at FROM sub_mutations WHERE id=?").bind(id).first<{ state: string; dispatched_at: string | null }>();

  it("JOURNEY-B-5 #1: a 25-hour-old row with a 181-second-old retry outstanding is NOT retired on a validation 400; ops are told; the delayed retry cannot restore renewal", async () => {
    const m = await lostRenew();
    // The row is 25 hours old; its latest attempt (a retry under the same key) went out 181 seconds ago and its answer never came back.
    await env.DB.prepare("UPDATE sub_mutations SET created_at=?,dispatched_at=json_array(?,?) WHERE id=?").bind(NOW - 25 * HOUR, NOW - 25 * HOUR, NOW - 181_000, m.id).run();
    validationKeys.add(m.k);
    expect((await deleteHold()).status).toBe(202);
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    expect((await mutation(m.id))!.state).toBe("pending"); // never retired on row age, nor on a validation refusal
    expect(await synced()).toBe(false);
    expect(await alertOf("cancel.key_unsettled")).toEqual({ kind: "cancel.key_unsettled" }); // reported, not retired
    // The outstanding attempts are on record; the ones Stripe answered now (refused) were taken off again (Astra JOURNEY-BCORE-1 #4).
    expect(JSON.parse((await mutation(m.id))!.dispatched_at!)).toEqual([NOW - 25 * HOUR, NOW - 181_000]);
    // The delayed retry lands now: Stripe renews again.
    subKeyParams[m.k] = "false"; subs.sub_1.cancel_at_period_end = false;
    validationKeys.clear();
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    // Its key now answers authoritatively (spent): settled, and the end is sent under a fresh key and read back. Renewal is not restored.
    expect((await mutation(m.id))!.state).toBe("superseded");
    expect(subs.sub_1.cancel_at_period_end).toBe(true);
    expect(await synced()).toBe(true);
    expect(await getSubRow()).toMatchObject({ cancel_at_period_end: 1 });
  });

  it("JOURNEY-B-5 #1: a renew request is retired without its key's answer only when Stripe shows the subscription ended AND every attempt is old", async () => {
    const m = await lostRenew();
    validationKeys.add(m.k);
    expect((await deleteHold()).status).toBe(202);
    // Ended at Stripe, but an attempt went out 181 seconds ago: still pending.
    subs.sub_1.status = "canceled";
    await env.DB.prepare("UPDATE sub_mutations SET created_at=?,dispatched_at=json_array(?,?) WHERE id=?").bind(NOW - 25 * HOUR, NOW - 25 * HOUR, NOW - 181_000, m.id).run();
    at(NOW + 1); // the sweep's own attempt is recorded at this moment; every later check is judged from here
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    expect((await mutation(m.id))!.state).toBe("pending");
    // Every attempt older than the request lifetime, the subscription ended at Stripe: nothing can renew it, so the request is retired.
    at(NOW + HOUR);
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    expect((await mutation(m.id))!.state).toBe("superseded");
    expect(JSON.parse((await env.DB.prepare("SELECT provider_error AS e FROM sub_mutations WHERE id=?").bind(m.id).first<{ e: string }>())!.e))
      .toMatchObject({ retired: "terminal", liveStatus: "canceled" });
  });

  it("a subscription Stripe refuses to cancel (another tool holds it, e.g. a schedule): pending, never confirmed, ops told after three refusals; the billing sweep touches no schedule", async () => {
    subs.sub_1.schedule = "sub_sched_foreign"; // the fixture refuses cancel_at_period_end with a validation 400, as Stripe does then
    expect(await (await call("/v1/account/cancel-plan", await token(), {})).json()).toEqual({ canceled: false, processing: true });
    for (let i = 1; i <= 3; i++) { at(NOW + i * 5 * MIN); await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined); } // the 5-minute cron
    expect(await synced()).toBe(false);
    expect(await getSubRow()).toMatchObject({ cancel_at_period_end: 0 });
    expect((await (await summary()).json<{ subscription: { cancellation: { state: string | null } } }>()).subscription.cancellation.state).toBe("pending");
    // Each refused request is closed with its refusal (its only attempt was answered: it can never land); none stays pending.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sub_mutations WHERE state='pending'").first()).toEqual({ n: 0 });
    expect(await alertOf("cancel.provider_failing")).toEqual({ kind: "cancel.provider_failing" });
    expect(stripeCalls.filter((x) => x.path.startsWith("/v1/subscription_schedules"))).toEqual([]);
    // Keep takes it back at once: nothing at Stripe was ever changed.
    const ref = (await env.DB.prepare("SELECT reference FROM plan_cancellations WHERE home_id='home-1'").first<{ reference: string }>())!.reference;
    expect(await (await keepIt(ref)).json()).toEqual({ status: "kept", stripeConfirmed: true });
  });
});

describe("Astra JOURNEY-B-4 #7: the ready email's moment is its actual handoff", () => {
  it("preparation crossing UTC midnight: the deadline is computed from the handoff date, the same moment as sent_at and eligibility", async () => {
    await paidHome(false);
    at(NOW + DAY);
    await canary();
    expect(await env.DB.prepare("SELECT sent_at FROM billing_notices WHERE id='server_ready:home-1:first'").first()).toEqual({ sent_at: null });
    const d = new Date(NOW + DAY);
    const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    const before = midnight - 100; const after = midnight + 100;
    at(before);
    // The message is prepared at `before`; its preparation (the trace id) carries the clock past UTC midnight.
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (alg, data) => {
      if (new TextDecoder().decode(data as Uint8Array) === "server_ready:home-1:first") at(after);
      return digest(alg, data);
    });
    const sent: { text: string }[] = [];
    const e = { ...testEnv(), EMAIL: { send: async (m: { text: string }) => { sent.push(m); } } } as unknown as Env;
    await sweepBilling(e, { stripeFetch, flux: flux as FluxEntitlementHooks }).catch(() => undefined);
    expect(aoeDate(aoeEnd(after, 7))).not.toBe(aoeDate(aoeEnd(before, 7)));
    expect(await env.DB.prepare("SELECT sent_at FROM billing_notices WHERE id='server_ready:home-1:first'").first()).toEqual({ sent_at: after });
    const text = sent.map((m) => m.text).find((t) => t.includes("server is ready"))!;
    expect(text).toContain(`Ask by the end of ${aoeDate(aoeEnd(after, 7))}`);
    expect((await quoteFirstMonthRefund(testEnv(), "home-1", after)).window).toEqual({ deadline: aoeEnd(after, 7), startsWhenReady: false });
  });
});

describe("Astra JOURNEY-BCORE-1: settlement, owned schedule resolution, fair sweeps, terminal reads, pending deletion words", () => {
  beforeEach(async () => { await paidHome(); });
  const sweepDeps = () => ({ notifier, stripeFetch, flux: flux as FluxEntitlementHooks });
  const cancelPlan = async () => (await call("/v1/account/cancel-plan", await token(), {})).json<Record<string, unknown>>();
  const keepIt = async (id: string) => call(`/v1/account/cancellations/${id}/keep`, await token(), {});
  const alertOf = (kind: string) => env.DB.prepare("SELECT kind FROM cloud_alerts WHERE kind=?").bind(kind).first<{ kind: string }>();
  const resolution = () => env.DB.prepare("SELECT * FROM cancel_resolutions WHERE subscription_id='sub_1' ORDER BY created_at DESC, rowid DESC").first<Record<string, unknown>>();
  const resolve = async (ms: number) => { at(ms); await sweepCancellations(testEnv(), sweepDeps()); };

  const providerCalls = () => stripeCalls.filter((c) => c.method === "DELETE" || c.path.startsWith("/v1/subscription_schedules")).map((c) => `${c.method} ${c.path}`);
  const deletes = () => stripeCalls.filter((c) => c.method === "DELETE" && c.path === "/v1/subscriptions/sub_1");
  const refOf = async () => (await env.DB.prepare("SELECT reference FROM plan_cancellations WHERE home_id='home-1'").first<{ reference: string }>())!.reference;
  const GEN = `in_app:${NOW}`;

  it("launch (BCORE-3 scope): a schedule refuses the normal cancel at the boundary -> parked as cancel.schedule_attached (one alert), no further write; once an operator removes the schedule the next sweep's normal cancel ends it", async () => {
    subs.sub_1.schedule = "sub_sched_foreign";
    expect(await cancelPlan()).toEqual({ canceled: false, processing: true });
    expect(await getSubRow()).toMatchObject({ cancel_promised_end: PERIOD_END, cancel_at_period_end: 0 });
    expect(await resolution()).toMatchObject({ state: "open", source: "in_app", generation: GEN, promised_end_at: PERIOD_END, due_at: PERIOD_END, next_attempt_at: PERIOD_END - 5000,
      schedule_id: null });
    // Nothing at the provider before the promised end.
    for (const t of [NOW + MIN, NOW + DAY, PERIOD_END - 2 * DAY, PERIOD_END - 6000]) await resolve(t);
    expect(providerCalls()).toEqual([]);
    // At the boundary: the normal cancel, once. Refused (a schedule is attached): parked, one alert, nothing else is sent.
    await resolve(PERIOD_END - 4000);
    expect(providerCalls()).toEqual(["DELETE /v1/subscriptions/sub_1"]);
    expect(deletes().map((c) => [c.form.get("prorate"), c.form.get("invoice_now"), c.key])).toEqual([["false", "true", `cxres:sub_1:${GEN}:delete:1`]]);
    expect(await resolution()).toMatchObject({ state: "open", schedule_id: "sub_sched_foreign", last_error: "cancel.schedule_attached" });
    const alerts = (await env.DB.prepare("SELECT detail FROM cloud_alerts WHERE kind='cancel.schedule_attached'").all<{ detail: string }>()).results;
    expect(alerts).toHaveLength(1);
    expect(JSON.parse(alerts[0].detail)).toMatchObject({ subscriptionId: "sub_1", scheduleId: "sub_sched_foreign", promisedEndAt: PERIOD_END, refusal: { status: 400 } });
    // Later passes only read: no write, no schedule call, no second alert. The customer sees the plan ending on its date, being confirmed.
    for (const t of [PERIOD_END + 2 * HOUR, PERIOD_END + 4 * HOUR]) await resolve(t);
    expect(providerCalls()).toEqual(["DELETE /v1/subscriptions/sub_1"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='cancel.schedule_attached'").first()).toEqual({ n: 1 });
    expect((await (await summary()).json<{ subscription: { cancellation: Record<string, unknown> } }>()).subscription.cancellation).toMatchObject({ state: "pending", endsAt: PERIOD_END });
    // The operator releases the schedule in the Stripe dashboard: the next sweep's normal cancel (a new key: the refusal was answered) ends it.
    subs.sub_1.schedule = null;
    await resolve(PERIOD_END + 6 * HOUR);
    expect(deletes().map((c) => c.key)).toEqual([`cxres:sub_1:${GEN}:delete:1`, `cxres:sub_1:${GEN}:delete:2`]);
    expect(subs.sub_1.status).toBe("canceled");
    expect(await resolution()).toMatchObject({ state: "resolved" });
    expect(await getSubRow()).toMatchObject({ status: "canceled" });
    expect(await alertOf("cancel.resolution_forced_end")).toEqual({ kind: "cancel.resolution_forced_end" });
  });

  it("#7: the DELETE is issued within the 5 s precision of the promised end, not an hour later", async () => {
    expect(await cancelPlan()).toMatchObject({ canceled: true });
    await resolve(PERIOD_END - 5001);
    expect(deletes()).toHaveLength(0);
    await resolve(PERIOD_END - 5000);
    expect(deletes()).toHaveLength(1);
    expect(subs.sub_1.status).toBe("canceled");
  });

  it("#7: Stripe ends it by itself at the period end -> terminated at the boundary with no DELETE", async () => {
    expect(await cancelPlan()).toMatchObject({ canceled: true });
    subs.sub_1.status = "canceled";
    await resolve(PERIOD_END);
    expect(deletes()).toHaveLength(0);
    expect(await resolution()).toMatchObject({ state: "resolved", ended_at: PERIOD_END });
    expect(await alertOf("cancel.resolution_forced_end")).toBeNull();
  });

  it("#7: a Stripe outage at the boundary: the row stays due (backoff at most 5 minutes), the unanswered key is sent again, ops are told after three attempts", async () => {
    await cancelPlan();
    deleteFails = 3;
    for (const t of [PERIOD_END, PERIOD_END + MIN, PERIOD_END + 3 * MIN]) await resolve(t);
    expect(await resolution()).toMatchObject({ state: "open", attempts: 3, last_error: "stripe_500" });
    const row = (await resolution())!;
    expect(Number(row.next_attempt_at) - Number(row.last_attempt_at)).toBeLessThanOrEqual(5 * MIN);
    expect(await alertOf("cancel.resolution_unresolved")).toEqual({ kind: "cancel.resolution_unresolved" });
    expect(subs.sub_1.status).toBe("active");
    await resolve(PERIOD_END + 10 * MIN);
    expect(subs.sub_1.status).toBe("canceled");
    // An answer that never came back is no authoritative failure: the same key every time.
    expect([...new Set(deletes().map((c) => c.key))]).toEqual([`cxres:sub_1:${GEN}:delete:1`]);
    expect(await resolution()).toMatchObject({ state: "resolved" });
  });

  it("BCORE-3 #3: a cached failure replayed under the key is confirmed by a live read and the key rotated; recovery then succeeds on the next attempt with a new key", async () => {
    await cancelPlan();
    deleteFails = 1; // the first answer is a fresh 500: unresolved, the key is kept
    await resolve(PERIOD_END);
    expect(await env.DB.prepare("SELECT seq,state FROM cancel_resolution_attempts").all().then((r) => r.results)).toEqual([{ seq: 1, state: "unresolved" }]);
    // Stripe cached that 500 under the key: every retry with it now replays the failure (Idempotent-Replayed), whatever Stripe's state.
    failedKeys[`cxres:sub_1:${GEN}:delete:1`] = 500;
    await resolve(PERIOD_END + 5 * MIN);
    expect(subs.sub_1.status).toBe("active");
    expect(await env.DB.prepare("SELECT seq,state FROM cancel_resolution_attempts").all().then((r) => r.results)).toEqual([{ seq: 1, state: "failed" }]);
    // Next attempt: a new key, and it works.
    await resolve(PERIOD_END + 10 * MIN);
    expect(deletes().map((c) => c.key)).toEqual([`cxres:sub_1:${GEN}:delete:1`, `cxres:sub_1:${GEN}:delete:1`, `cxres:sub_1:${GEN}:delete:2`]);
    expect(subs.sub_1.status).toBe("canceled");
    expect(await resolution()).toMatchObject({ state: "resolved" });
    expect(await env.DB.prepare("SELECT seq,state FROM cancel_resolution_attempts ORDER BY seq").all().then((r) => r.results)).toEqual([{ seq: 1, state: "failed" }, { seq: 2, state: "done" }]);
  });

  it("#2: a renewal charged after the frozen end is recorded (no amount, record only, alerted); an operator executes it by id with the amount they decide", async () => {
    await cancelPlan();
    // The plan renewed at the period end before anything could stop it.
    paidInvoices = [
      { id: "in_1", object: "invoice", status: "paid", amount_paid: 9900, created: PERIOD_START / 1000, payment_intent: "pi_1",
        lines: { data: [{ id: "il_1", amount: 9900, period: { start: PERIOD_START / 1000, end: PERIOD_END / 1000 } }], has_more: false } },
      { id: "in_late", object: "invoice", status: "paid", amount_paid: 9900, created: PERIOD_END / 1000, payment_intent: "pi_late",
        lines: { data: [{ id: "il_late", amount: 9900, period: { start: PERIOD_END / 1000, end: (PERIOD_END + 30 * DAY) / 1000 } }], has_more: false } },
    ];
    await resolve(PERIOD_END);
    expect(subs.sub_1.status).toBe("canceled");
    expect(await env.DB.prepare("SELECT id,invoice_id,paid_cents,payment_intent,promised_end_at,hint,executed_at FROM cancel_late_refunds").all().then((r) => r.results)).toEqual([
      { id: "cxr-late:sub_1:in_late", invoice_id: "in_late", paid_cents: 9900, payment_intent: "pi_late", promised_end_at: PERIOD_END, hint: "after_end", executed_at: null }]);
    expect(await env.DB.prepare("SELECT * FROM cancel_late_refunds").first()).not.toHaveProperty("amount_cents");
    expect(await alertOf("cancel.late_renewal_charge")).toEqual({ kind: "cancel.late_renewal_charge" });
    expect(stripeCalls.some((c) => c.path.includes("refund") || c.path.includes("credit_notes"))).toBe(false);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM refund_ops WHERE kind='cancellation_late'").first()).toEqual({ n: 0 });
    await resolve(PERIOD_END + 3 * HOUR);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cancel_late_refunds").first()).toEqual({ n: 1 });
    // The operator executes it by its id, with the amount: none given is refused, more than was paid is refused.
    expect((await call("/v1/admin/cancellations/late-refunds/cxr-late:sub_1:in_late/execute", await token(), { amountCents: 9900 })).status).toBe(401);
    expect((await admin("/v1/admin/cancellations/late-refunds/cxr-late:sub_1:in_late/execute", {})).status).toBe(400);
    expect((await admin("/v1/admin/cancellations/late-refunds/cxr-late:sub_1:in_late/execute", { amountCents: 9901 })).status).toBe(409);
    const r = await admin("/v1/admin/cancellations/late-refunds/cxr-late:sub_1:in_late/execute", { amountCents: 9000 });
    expect(r.status).toBe(200);
    const op = (await env.DB.prepare("SELECT kind,invoice_id,paid_cents,detail FROM refund_ops WHERE id='cxr-late:sub_1:in_late'").first<{ kind: string; invoice_id: string; paid_cents: number; detail: string }>())!;
    expect(op).toMatchObject({ kind: "cancellation_late", invoice_id: "in_late", paid_cents: 9900 });
    expect(JSON.parse(op.detail)).toMatchObject({ operatorCents: 9000, lateRecord: "cxr-late:sub_1:in_late" });
    expect(await env.DB.prepare("SELECT executed_cents FROM cancel_late_refunds").first()).toEqual({ executed_cents: 9000 });
  });

  it("#1: a Keep withdraws the resolution in the SAME batch that clears the cancellation: no release, nothing ended", async () => {
    subs.sub_1.schedule = "sub_sched_foreign";
    await cancelPlan();
    expect((await keepIt(await refOf())).status).toBe(200);
    // Withdrawn atomically with the Keep, before any sweep ran.
    expect(await resolution()).toMatchObject({ state: "withdrawn", generation: GEN });
    await resolve(PERIOD_END);
    expect(providerCalls()).toEqual([]);
    expect(subs.sub_1).toMatchObject({ schedule: "sub_sched_foreign", status: "active" });
  });

  it("#1: Cancel -> Keep -> renewal -> Cancel again: the old generation never acts, the new one is bound to the new period", async () => {
    await cancelPlan();
    expect((await keepIt(await refOf())).status).toBe(200);
    expect(await resolution()).toMatchObject({ state: "withdrawn", generation: GEN });
    // Even a stale row of the old generation (re-opened by hand, as a lost update would) cannot act: its generation is no longer current.
    await env.DB.prepare("UPDATE cancel_resolutions SET state='open',next_attempt_at=0").run();
    await resolve(PERIOD_END + 10_000);
    expect(deletes()).toHaveLength(0);
    expect(await resolution()).toMatchObject({ state: "withdrawn" });
    // The renewal happened; the customer cancels again.
    const NEXT_END = PERIOD_END + 30 * DAY;
    subs.sub_1.start = PERIOD_END; subs.sub_1.end = NEXT_END;
    await env.DB.prepare("UPDATE billing_subscriptions SET current_period_start=?,current_period_end=? WHERE home_id='home-1'").bind(PERIOD_END, NEXT_END).run();
    at(PERIOD_END + HOUR);
    expect(await cancelPlan()).toMatchObject({ canceled: true });
    expect(await resolution()).toMatchObject({ state: "open", generation: `in_app:${PERIOD_END + HOUR}`, promised_end_at: NEXT_END });
    await resolve(PERIOD_END + 2 * HOUR);
    await resolve(NEXT_END - 6000);
    expect(deletes()).toHaveLength(0);
    expect(subs.sub_1.status).toBe("active");
    await resolve(NEXT_END);
    expect(deletes()).toHaveLength(1);
    expect(await resolution()).toMatchObject({ state: "resolved", promised_end_at: NEXT_END });
  });

  it("#2 (outage recovery): the cancel could not reach Stripe, a renewal happened meanwhile -> the later end is never confirmed; the resolution ends it now", async () => {
    stripePostDown = true;
    expect(await cancelPlan()).toEqual({ canceled: false, processing: true });
    stripePostDown = false;
    subs.sub_1.start = PERIOD_END; subs.sub_1.end = PERIOD_END + 30 * DAY; // renewed during the outage; no schedule is attached
    at(PERIOD_END + 2 * DAY);
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    expect(notices.some((n) => n.kind === "cancel_scheduled")).toBe(false);
    expect(await getSubRow()).toMatchObject({ cancel_at_period_end: 0 });
    expect((await getSubRow()).cancel_synced_rev).not.toBe((await getSubRow()).cancel_intent_rev);
    expect((await (await summary()).json<{ subscription: { cancellation: { state: string | null } } }>()).subscription.cancellation.state).toBe("pending");
    // The resolution (due at the frozen promise) ends the subscription now.
    await sweepCancellations(testEnv(), sweepDeps());
    expect(deletes()).toHaveLength(1);
    expect(subs.sub_1.status).toBe("canceled");
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    expect(notices.some((n) => n.kind === "cancel_scheduled")).toBe(false);
    expect(await getSubRow()).toMatchObject({ status: "canceled" });
  });

  it("#2 (precision): Stripe's end one second after the promise is the same end (whole-second timestamps), still confirmed", async () => {
    stripePostDown = true;
    await cancelPlan();
    stripePostDown = false;
    subs.sub_1.end = PERIOD_END + 1000;
    at(NOW + HOUR);
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    expect(await getSubRow()).toMatchObject({ cancel_at_period_end: 1 });
    expect(notices.some((n) => n.kind === "cancel_scheduled")).toBe(true);
  });

  it("#3: fifty subscriptions Stripe keeps refusing never starve the fifty-first: attempts are persisted before work and rotated fairly", async () => {
    const stmts: D1PreparedStatement[] = [];
    const ids = [...Array.from({ length: 50 }, (_, i) => `home-a${String(i).padStart(2, "0")}`), "home-z"];
    for (const id of ids) {
      const sub = `sub_${id}`;
      stmts.push(env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
        VALUES (?,?,?,'ready','ready',?,'k',?,?)`).bind(id, `inst-${id}`, account, IMAGE, NOW, NOW));
      stmts.push(env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,price_id,status,current_period_start,current_period_end,
        customer_cancel_at,cancel_intent_rev,cancel_synced_rev,created_at,updated_at) VALUES (?,?,?,'pro',?,'active',?,?,?,1,0,?,?)`)
        .bind(id, `cus_${id}`, sub, PRICES.STRIPE_PRICE_PRO, PERIOD_START, PERIOD_END, NOW, NOW, NOW));
      // The first fifty are held by a schedule: Stripe refuses every cancellation of them. The fifty-first would be accepted.
      subs[sub] = { status: "active", cancel_at_period_end: false, cancel_at: null, price: PRICES.STRIPE_PRICE_PRO, schedule: id === "home-z" ? null : `sched_${id}`, start: PERIOD_START, end: PERIOD_END };
    }
    await env.DB.batch(stmts);
    const attemptsOn = (sub: string) => stripeCalls.filter((c) => c.method === "POST" && c.path === `/v1/subscriptions/${sub}`).length;
    for (let pass = 0; pass < 3; pass++) {
      at(NOW + pass * 5 * MIN);
      await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    }
    // The fifty-first was attempted (and, unrefused, confirmed) although fifty refused rows were always pending.
    expect(attemptsOn("sub_home-z")).toBeGreaterThanOrEqual(1);
    expect(subs["sub_home-z"].cancel_at_period_end).toBe(true);
    expect(await env.DB.prepare("SELECT cancel_at_period_end AS c, cancel_sync_failures AS f, cancel_sync_next_at AS n FROM billing_subscriptions WHERE home_id='home-z'").first())
      .toEqual({ c: 1, f: 0, n: null });
    // A refused row has its attempt and its backoff on record, written before the attempt.
    const a = (await env.DB.prepare("SELECT cancel_sync_attempt_at AS t, cancel_sync_failures AS f, cancel_sync_next_at AS n FROM billing_subscriptions WHERE home_id='home-a00'")
      .first<{ t: number; f: number; n: number }>())!;
    expect(a.f).toBeGreaterThanOrEqual(1);
    expect(a.n).toBeGreaterThan(a.t);
  }, 30_000); // a simulated fleet, budgeted like the suite's other fleet tests

  it("#4: a five-minute cron with refused attempts reaches the terminal read within two passes; local status ends canceled, no update of the canceled subscription", async () => {
    const c = await cancelPlan();
    stripePostDown = true; // Keep pressed; its renew request's answer is lost (outstanding from NOW)
    expect(await (await keepIt(String(c.reference))).json()).toEqual({ status: "kept", stripeConfirmed: false, message: KEEP_UNCONFIRMED });
    stripePostDown = false;
    const m = (await env.DB.prepare("SELECT id FROM sub_mutations WHERE desired_cancel=0 AND state='pending'").first<{ id: string }>())!;
    subs.sub_1.status = "canceled"; // Stripe ended the subscription meanwhile; every update of it is refused (validation 400)
    // Pass 1, one minute later: the retry is refused (answered: it is not outstanding); the lost attempt is too young to rule out.
    at(NOW + MIN);
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    const p1 = (await env.DB.prepare("SELECT state,dispatched_at FROM sub_mutations WHERE id=?").bind(m.id).first<{ state: string; dispatched_at: string }>())!;
    expect(p1.state).toBe("pending");
    expect(JSON.parse(p1.dispatched_at)).toEqual([NOW]);
    // Pass 2, five minutes later: the answered refusal never refreshed the gate; the lost attempt is older than Stripe's timeout plus margin.
    const posts = stripeCalls.filter((x) => x.method === "POST").length;
    at(NOW + 6 * MIN);
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    expect((await env.DB.prepare("SELECT state FROM sub_mutations WHERE id=?").bind(m.id).first<{ state: string }>())!.state).toBe("superseded");
    // Only the retry under the pending key was sent; nothing tried to update the canceled subscription afterwards.
    expect(stripeCalls.filter((x) => x.method === "POST").length).toBe(posts + 1);
    const row = await getSubRow();
    expect(row).toMatchObject({ status: "canceled", ended_at: NOW + 6 * MIN });
    expect(row.cancel_intent_rev).toBe(row.cancel_synced_rev);
  });

  it("#5: while Stripe has not confirmed the cancel, deletion says ending with confirmation pending, never 'You will not be charged again'", async () => {
    subs.sub_1.schedule = "sub_sched_foreign"; // Stripe refuses the cancellation
    const r = await deleteHold();
    expect(r.status).toBe(202);
    const plan = (await r.json<{ plan: Record<string, unknown> }>()).plan;
    expect(plan).toMatchObject({ state: "ending", endsAt: PERIOD_END, confirmed: false, noFurtherCharge: false });
    expect(String(plan.sentence)).toContain("still confirming");
    expect(String(plan.sentence)).not.toContain("not be charged again");
    expect(String(notices.find((n) => n.kind === "hold_started")!.data.emailText)).not.toContain("not be charged again");
    expect(String((await deletionNoticeData(testEnv(), "home-1", NOW + 4 * DAY)).emailText)).not.toContain("not be charged again");
    // The deleted-home view too.
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleted',observed_state='deleted',updated_at=? WHERE id='home-1'").bind(NOW + 3 * DAY).run();
    const v = await (await summary()).json<{ subscription: { billing: Record<string, unknown> } }>();
    expect(v.subscription.billing).toMatchObject({ state: "ending", confirmed: false, noFurtherCharge: false });
    expect(String(v.subscription.billing.sentence)).not.toContain("not be charged again");
    // Once Stripe confirms (the schedule is gone and the sweep syncs), the words are the confirmed ones.
    subs.sub_1.schedule = null;
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    const after = await (await summary()).json<{ subscription: { billing: Record<string, unknown> } }>();
    expect(after.subscription.billing).toMatchObject({ state: "ending", confirmed: true, noFurtherCharge: true, sentence: `Your plan ends on ${isoDate(PERIOD_END)}. Renewals stop on ${isoDate(PERIOD_END)}. Any usage already served may still appear on a final invoice. Anything charged for time after ${isoDate(PERIOD_END)} is refunded.` });
  });
});

describe("Astra JOURNEY-BCORE-2 round 3: charge reconciliation (D) and the words (E)", () => {
  beforeEach(async () => { await paidHome(); });
  const sweepDeps = () => ({ notifier, stripeFetch, flux: flux as FluxEntitlementHooks });
  const cancelPlan = async () => (await call("/v1/account/cancel-plan", await token(), {})).json<Record<string, unknown>>();
  const keepIt = async (id: string) => call(`/v1/account/cancellations/${id}/keep`, await token(), {});
  const resolution = () => env.DB.prepare("SELECT * FROM cancel_resolutions WHERE subscription_id='sub_1' ORDER BY created_at DESC, rowid DESC").first<Record<string, unknown>>();
  const resolve = async (ms: number) => { at(ms); await sweepCancellations(testEnv(), sweepDeps()); };
  const refOf = async () => (await env.DB.prepare("SELECT reference FROM plan_cancellations WHERE home_id='home-1'").first<{ reference: string }>())!.reference;
  const records = () => env.DB.prepare("SELECT id,invoice_id,paid_cents,hint,promised_end_at,executed_at FROM cancel_late_refunds ORDER BY id").all().then((r) => r.results);
  const NEXT_END = PERIOD_END + 30 * DAY;
  const renewalLine = (id: string, amount: number, start = PERIOD_END) => ({ id, amount, period: { start: start / 1000, end: (start + 30 * DAY) / 1000 },
    parent: { type: "subscription_item_details", subscription_item_details: { subscription: "sub_1", proration: false } }, pricing: { price_details: { price: PRICES.STRIPE_PRICE_PRO } } });
  const usageLine = (id: string, amount: number) => ({ id, amount, period: { start: (PERIOD_END - 30 * DAY) / 1000, end: PERIOD_END / 1000 },
    price: { id: "price_metered_usage", recurring: { usage_type: "metered" } }, parent: { type: "subscription_item_details", subscription_item_details: { subscription: "sub_1", proration: false } } });
  const invoice = (id: string, status: string, paid: number, lines: unknown[], hasMore = false, created = PERIOD_END) => ({ id, object: "invoice", status, amount_paid: status === "paid" ? paid : 0,
    amount_due: paid, created: created / 1000, payment_intent: `pi_${id}`, customer: "cus_1", subscription: "sub_1", total_taxes: [], lines: { data: lines, has_more: hasMore } });
  async function webhookPaid(inv: Record<string, unknown>, created = PERIOD_END + HOUR) {
    const raw = JSON.stringify({ id: `evt_r3_${Math.random().toString(36).slice(2, 10)}`, type: "invoice.paid", created: Math.floor(created / 1000), data: { object: inv } });
    const ctx = createExecutionContext();
    const res = await worker().fetch(new Request("https://auth.murage.test/v1/billing/webhook", { method: "POST", body: raw, headers: { "content-type": "application/json",
      "stripe-signature": await signStripePayload(raw, "whsec_testonlyfixturesecret0123456789", Math.floor(Date.now() / 1000)) } }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("#3: a renewal that settles AFTER the subscription was terminated is recorded the moment its invoice.paid arrives (one record, no amount)", async () => {
    await cancelPlan();
    await resolve(PERIOD_END);
    expect(await resolution()).toMatchObject({ state: "resolved" });
    expect(await records()).toEqual([]);
    at(PERIOD_END + 2 * HOUR);
    await webhookPaid(invoice("in_after", "paid", 9900, [renewalLine("il_after", 9900)]));
    expect(await records()).toEqual([{ id: "cxr-late:sub_1:in_after", invoice_id: "in_after", paid_cents: 9900, hint: "after_end", promised_end_at: PERIOD_END, executed_at: null }]);
    await webhookPaid(invoice("in_after", "paid", 9900, [renewalLine("il_after", 9900)]));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cancel_late_refunds").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM refund_ops WHERE kind='cancellation_late'").first()).toEqual({ n: 0 });
  });

  it("BCORE-3 #8: an invoice settling BETWEEN two listings is still recorded (lifecycle-order listings, tracked by id), also after the resolution", async () => {
    await cancelPlan();
    const open = invoice("in_x", "open", 9900, [renewalLine("il_x", 9900)]);
    const paid = invoice("in_x", "paid", 9900, [renewalLine("il_x", 9900)]);
    openInvoices = [open];
    // It is paid right when the open listing is asked for: the open listing no longer shows it, the paid listing (asked after it) does.
    onList.open = () => { openInvoices = []; paidInvoices = [paid]; };
    await resolve(PERIOD_END);
    expect(await resolution()).toMatchObject({ state: "resolved" });
    expect(await records()).toEqual([{ id: "cxr-late:sub_1:in_x", invoice_id: "in_x", paid_cents: 9900, hint: "after_end", promised_end_at: PERIOD_END, executed_at: null }]);
    // Seen open once, then settled with no listing ever showing it paid (and the webhook lost): read again by its id, after the resolution.
    const open2 = invoice("in_y", "open", 4900, [renewalLine("il_y", 4900)]);
    openInvoices = [open2]; paidInvoices = [];
    await resolve(PERIOD_END + 2 * HOUR);
    expect(await env.DB.prepare("SELECT status FROM cancel_invoice_checks WHERE invoice_id='in_y'").first()).toEqual({ status: "open" });
    openInvoices = []; invoiceById.in_y = invoice("in_y", "paid", 4900, [renewalLine("il_y", 4900)]);
    await resolve(PERIOD_END + 4 * HOUR);
    expect((await records()).map((r) => r.invoice_id)).toEqual(["in_x", "in_y"]);
    await resolve(PERIOD_END + 6 * HOUR);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cancel_late_refunds").first()).toEqual({ n: 2 });
  });

  it("BCORE-3 #5/#6: a MIXED invoice with lines on two pages is ONE record with every line (own taxes, discounts, price ids, hints) and no amount; the operator decides the amount", async () => {
    await cancelPlan();
    const usage = { ...usageLine("il_usage", 1500), taxes: [] };
    const renewal = { ...renewalLine("il_renew", 9900), taxes: [{ amount: 990, tax_behavior: "exclusive", taxable_amount: 9900, type: "tax_rate_details", tax_rate_details: { tax_rate: "txr_1" } }],
      discount_amounts: [{ amount: 1000, discount: "di_1" }] };
    invoiceLinePages["in_mixed"] = [[usage], [renewal]];
    paidInvoices = [{ ...invoice("in_mixed", "paid", 12390, [usage], true), total_taxes: [{ amount: 990 }] }];
    await resolve(PERIOD_END);
    const rec = (await env.DB.prepare("SELECT * FROM cancel_late_refunds").all<Record<string, unknown>>()).results;
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ invoice_id: "in_mixed", paid_cents: 12390, hint: "mixed", executed_at: null });
    expect(rec[0]).not.toHaveProperty("amount_cents");
    const snap = JSON.parse(String(rec[0].snapshot_json)) as { lines: Record<string, unknown>[]; invoice: Record<string, unknown> };
    expect(snap.invoice).toMatchObject({ id: "in_mixed", amountPaid: 12390, tax: 990 });
    expect(snap.lines.map((l) => [l.id, l.price, l.amount, l.hint])).toEqual([["il_usage", "price_metered_usage", 1500, "served_usage"], ["il_renew", PRICES.STRIPE_PRICE_PRO, 9900, "after_end"]]);
    expect(snap.lines[1]).toMatchObject({ taxes: [{ amount: 990, inclusive: false, taxableAmount: 9900, rate: "txr_1" }], discounts: [{ amount: 1000, discount: "di_1" }] });
    expect(await resolution()).toMatchObject({ state: "resolved" });
    const r = await admin("/v1/admin/cancellations/late-refunds/cxr-late:sub_1:in_mixed/execute", { amountCents: 9890 });
    expect(r.status).toBe(200);
    expect(JSON.parse((await env.DB.prepare("SELECT detail FROM refund_ops WHERE id='cxr-late:sub_1:in_mixed'").first<{ detail: string }>())!.detail)).toMatchObject({ operatorCents: 9890 });
  });

  it("BCORE-3 #7: a Basil metered usage line (price id only) is a served-usage HINT on the record, never an amount; pre-promise invoices record nothing", async () => {
    await cancelPlan();
    const basilUsage = { id: "il_u", amount: 1500, period: { start: (PERIOD_END - 30 * DAY) / 1000, end: PERIOD_END / 1000 },
      parent: { type: "subscription_item_details", subscription_item_details: { subscription: "sub_1", proration: false } }, pricing: { price_details: { price: "price_metered_usage" } } };
    at(PERIOD_END + HOUR);
    await webhookPaid({ ...invoice("in_final", "paid", 1500, [basilUsage]), status_transitions: { paid_at: (PERIOD_END + HOUR) / 1000 } });
    const rec = (await env.DB.prepare("SELECT hint,paid_cents,snapshot_json FROM cancel_late_refunds").all<{ hint: string; paid_cents: number; snapshot_json: string }>()).results;
    expect(rec.map((x) => [x.hint, x.paid_cents])).toEqual([["served_usage", 1500]]);
    expect((JSON.parse(rec[0].snapshot_json) as { lines: { usageType: string; hint: string }[] }).lines).toMatchObject([{ usageType: "metered", hint: "served_usage" }]);
    await webhookPaid(invoice("in_before", "paid", 9900, [renewalLine("il_b", 9900, PERIOD_START)], false, PERIOD_START), PERIOD_START + HOUR);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cancel_late_refunds").first()).toEqual({ n: 1 });
  });

  it("a Keep withdraws the promise: a later renewal is an ordinary one and is never recorded", async () => {
    await cancelPlan();
    expect((await keepIt(await refOf())).status).toBe(200);
    at(PERIOD_END + HOUR);
    await webhookPaid(invoice("in_ok", "paid", 9900, [renewalLine("il_ok", 9900)]));
    await resolve(PERIOD_END + 2 * HOUR);
    expect(await records()).toEqual([]);
  });

  it("#8: every response and email says renewals stop, that served usage may still be invoiced, and that time after the end is refunded; never a flat promise", async () => {
    const c = await cancelPlan();
    const day = isoDate(PERIOD_END);
    expect(c.sentence).toBe(`Renewals stop on ${day}. Any usage already served may still appear on a final invoice. Anything charged for time after ${day} is refunded.`);
    const cancelled = notices.find((n) => n.kind === "cancel_scheduled")!;
    expect(String(cancelled.data.emailText)).toContain(`Renewals stop on ${day}. Any usage already served may still appear on a final invoice.`);
    expect(JSON.stringify([c, notices])).not.toMatch(/not be charged again/);
    // Delete my Cloud: dialog and hold email.
    const hold = await (await deleteHoldFor()).json<{ plan: { sentence: string } }>().catch(() => null);
    if (hold) expect(hold.plan.sentence).not.toMatch(/not be charged again/);
  });

  it("#9: the delayed period-end confirmation of a home that is deleting says nothing about the server running, a later suspension or kept data", async () => {
    subs.sub_1.schedule = "sub_sched_foreign"; // Stripe refuses: the confirmation arrives later
    const r = await deleteHoldFor();
    expect(r.status).toBe(202);
    expect(notices.find((n) => n.kind === "cancel_scheduled")).toBeUndefined();
    subs.sub_1.schedule = null;
    at(NOW + 6 * MIN);
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    const text = String(notices.find((n) => n.kind === "cancel_scheduled")!.data.emailText);
    expect(text).toContain(`Renewals stop on ${isoDate(PERIOD_END)}.`);
    expect(text).not.toMatch(/keeps running|suspended|keep your data|Changed your mind/);
    expect(text).not.toMatch(/not be charged again/);
  });

  it("#9: the same confirmation for an ordinary Cancel plan still says the server runs until the end", async () => {
    subs.sub_1.schedule = "sub_sched_foreign";
    await cancelPlan();
    subs.sub_1.schedule = null;
    at(NOW + 6 * MIN);
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    const text = String(notices.find((n) => n.kind === "cancel_scheduled")!.data.emailText);
    expect(text).toContain("Your server keeps running until");
  });
  const deleteHoldFor = async () => call("/v1/account/home/hold", await token({ aal2: true }), { action: "delete", confirm: "home-1" });
});

describe("Astra JOURNEY-BCORE-3: date guard, one obligation per cancellation, Keep inside the lease, notices, displayed dates", () => {
  beforeEach(async () => { await paidHome(); });
  const sweepDeps = () => ({ notifier, stripeFetch, flux: flux as FluxEntitlementHooks });
  const cancelPlan = async () => (await call("/v1/account/cancel-plan", await token(), {})).json<Record<string, unknown>>();
  const keepIt = async (id: string) => call(`/v1/account/cancellations/${id}/keep`, await token(), {});
  const refOf = async () => (await env.DB.prepare("SELECT reference FROM plan_cancellations WHERE home_id='home-1'").first<{ reference: string }>())!.reference;
  const resolve = async (ms: number) => { at(ms); await sweepCancellations(testEnv(), sweepDeps()); };
  const deletes = () => stripeCalls.filter((c) => c.method === "DELETE" && c.path === "/v1/subscriptions/sub_1");
  const rows = () => env.DB.prepare("SELECT source,generation,promised_end_at,state FROM cancel_resolutions ORDER BY source,generation").all().then((r) => r.results);
  const NEXT_END = PERIOD_END + 30 * DAY;
  async function publicDecl(id: string, effectiveAt = PERIOD_END) {
    await declare(id, { effectiveAt });
    for (const [sql, binds] of publicResolutionQ(id, `op-${id.slice(0, 6)}`, NOW)) await env.DB.prepare(sql).bind(...(binds ?? [])).run();
  }

  it("#1: a later Stripe period never advances the resolution: no DELETE ten days before the promised end, even with its due time forced to now", async () => {
    stripePostDown = true;
    expect(await cancelPlan()).toEqual({ canceled: false, processing: true });
    stripePostDown = false;
    subs.sub_1.end = NEXT_END; // Stripe now shows a period ending after the frozen promise
    at(PERIOD_END - 10 * DAY);
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    await sweepCancellations(testEnv(), sweepDeps());
    expect(deletes()).toHaveLength(0);
    expect(await env.DB.prepare("SELECT next_attempt_at,state FROM cancel_resolutions").first()).toEqual({ next_attempt_at: PERIOD_END - 5000, state: "open" });
    // Whatever moves next_attempt_at (a lost update, an operator), the resolver's own date guard holds.
    await env.DB.prepare("UPDATE cancel_resolutions SET next_attempt_at=0").run();
    await resolve(PERIOD_END - 10 * DAY + MIN);
    await resolve(PERIOD_END - 5001);
    expect(deletes()).toHaveLength(0);
    expect(subs.sub_1.status).toBe("active");
    await resolve(PERIOD_END - 5000);
    expect(deletes()).toHaveLength(1);
    expect(subs.sub_1.status).toBe("canceled");
  });

  it("#2: a public cancellation and an in-app Delete with the SAME end keep one obligation each; holding the public one never stalls the Delete", async () => {
    const id = hex("a");
    await publicDecl(id);
    expect((await deleteHoldOf()).status).toBe(202);
    expect(await rows()).toEqual([{ source: "in_app", generation: `in_app:${NOW}`, promised_end_at: PERIOD_END, state: "open" },
      { source: "public", generation: `public:${id}:${PERIOD_END}`, promised_end_at: PERIOD_END, state: "open" }]);
    // "This wasn't me": the public one is held (it waits); the Delete's own obligation still ends the plan at the boundary.
    await env.DB.prepare("UPDATE cancellation_requests SET status='held',keep_at=? WHERE id=?").bind(PERIOD_END + 10 * DAY, id).run();
    await resolve(PERIOD_END);
    expect(deletes()).toHaveLength(1);
    expect(subs.sub_1.status).toBe("canceled");
    expect(await rows()).toMatchObject([{ source: "in_app", state: "resolved" }, { source: "public", state: "open" }]);
  });

  it("#2: the public cancellation is withdrawn (held, then closed as kept by timeout): the Delete is still enforced", async () => {
    const id = hex("b");
    await publicDecl(id);
    expect((await deleteHoldOf()).status).toBe(202);
    await env.DB.prepare("UPDATE cancellation_requests SET status='held',keep_at=? WHERE id=?").bind(PERIOD_END - DAY, id).run();
    await resolve(PERIOD_END - DAY);
    expect(await env.DB.prepare("SELECT status,kept_by FROM cancellation_requests WHERE id=?").bind(id).first()).toEqual({ status: "kept", kept_by: "timeout" });
    await resolve(PERIOD_END);
    expect(deletes()).toHaveLength(1);
    expect(await rows()).toMatchObject([{ source: "in_app", state: "resolved" }, { source: "public", state: "withdrawn" }]);
  });

  it("#4: the resolution ended the subscription before Keep's lease: Keep reads it inside the lease (no unleased precheck), too_late, the end is persisted", async () => {
    const id = hex("c");
    await declare(id);
    subs.sub_1.status = "canceled";
    const before = stripeCalls.length;
    const r = await keepCall(id);
    expect(stripeCalls.slice(before).filter((c) => c.method === "GET" && c.path === "/v1/subscriptions/sub_1")).toHaveLength(1);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "too_late" });
    expect(await env.DB.prepare("SELECT status FROM cancellation_requests WHERE id=?").bind(id).first()).toEqual({ status: "open" });
    expect(await getSubRow()).toMatchObject({ status: "canceled" });
  });

  it("#9: Cancel, Keep, Cancel again in the same period: the second confirmation is its own notice (subscription and generation), not the first one's id", async () => {
    await cancelPlan();
    expect((await keepIt(await refOf())).status).toBe(200);
    at(NOW + HOUR);
    await cancelPlan();
    const sent = notices.filter((n) => n.kind === "cancel_scheduled");
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((n) => n.id)).size).toBe(2);
    expect(sent.map((n) => n.id)).toEqual([`cancel_scheduled:home-1:sub_1:${NOW}:${PERIOD_END}`, `cancel_scheduled:home-1:sub_1:${NOW + HOUR}:${PERIOD_END}`]);
  });

  it("#10: a confirmation queued before a deletion is re-worded at delivery against the committed state (deletion-aware)", async () => {
    notifyFails = true;
    await cancelPlan();
    const queued = (await env.DB.prepare("SELECT payload FROM billing_notices WHERE kind='cancel_scheduled' AND sent_at IS NULL").first<{ payload: string }>())!;
    expect(String(JSON.parse(queued.payload).emailText)).toContain("Your server keeps running until");
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleting' WHERE id='home-1'").run();
    notifyFails = false;
    at(NOW + 10 * MIN);
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    const text = String(notices.find((n) => n.kind === "cancel_scheduled")!.data.emailText);
    expect(text).toContain("This confirms the billing end only.");
    expect(text).not.toMatch(/keeps running|suspended|keep your data|Changed your mind/);
  });

  it("#11: after a renewal moved current_period_end, the displayed cancellation date is still the earliest standing promise", async () => {
    expect(await cancelPlan()).toMatchObject({ canceled: true });
    await env.DB.prepare("UPDATE billing_subscriptions SET current_period_start=?,current_period_end=? WHERE home_id='home-1'").bind(PERIOD_END, NEXT_END).run();
    const v = await (await summary()).json<{ subscription: { activeUntil: number; cancellation: { endsAt: number } } }>();
    expect(v.subscription.cancellation.endsAt).toBe(PERIOD_END);
    expect(v.subscription.activeUntil).toBe(PERIOD_END);
  });
  const deleteHoldOf = async () => call("/v1/account/home/hold", await token({ aal2: true }), { action: "delete", confirm: "home-1" });
});

describe("Astra JOURNEY-BCORE-4: parking holds every writer, keys per subscription, usage billed at the end, stable dates, withdrawn notices", () => {
  beforeEach(async () => { await paidHome(); });
  const sweepDeps = () => ({ notifier, stripeFetch, flux: flux as FluxEntitlementHooks });
  const cancelPlan = async () => (await call("/v1/account/cancel-plan", await token(), {})).json<Record<string, unknown>>();
  const keepIt = async (id: string) => call(`/v1/account/cancellations/${id}/keep`, await token(), {});
  const refOf = async () => (await env.DB.prepare("SELECT reference FROM plan_cancellations WHERE home_id='home-1'").first<{ reference: string }>())!.reference;
  const resolve = async (ms: number) => { at(ms); await sweepCancellations(testEnv(), sweepDeps()); };
  const deletes = () => stripeCalls.filter((c) => c.method === "DELETE" && c.path === "/v1/subscriptions/sub_1");
  const subWrites = (from: number) => stripeCalls.slice(from).filter((c) => c.method !== "GET" && c.path.startsWith("/v1/subscription"));
  const parkAlerts = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='cancel.schedule_attached'").first<{ n: number }>())!.n;
  const NEXT_END = PERIOD_END + 30 * DAY;
  async function publicDecl(id: string, effectiveAt = PERIOD_END) {
    await declare(id, { effectiveAt });
    for (const [sql, binds] of publicResolutionQ(id, `op-${id.slice(0, 6)}`, NOW)) await env.DB.prepare(sql).bind(...(binds ?? [])).run();
  }

  it("#1: once parked, billing sync, the public reconciliation and the resolver only READ (no POST, no DELETE); a Keep still reverses locally", async () => {
    subs.sub_1.schedule = "sub_sched_x";
    const id = hex("d");
    await publicDecl(id);
    expect(await cancelPlan()).toEqual({ canceled: false, processing: true });
    await resolve(PERIOD_END - 4000);
    expect(deletes()).toHaveLength(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cancel_resolutions WHERE state='open' AND schedule_id='sub_sched_x'").first()).toEqual({ n: 2 });
    const parkedAt = stripeCalls.length;
    for (const t of [PERIOD_END + HOUR + MIN, PERIOD_END + 3 * HOUR, PERIOD_END + 8 * HOUR]) {
      at(t);
      await env.DB.prepare("UPDATE billing_subscriptions SET cancel_sync_next_at=NULL").run();
      await env.DB.prepare("UPDATE cancellation_requests SET stripe_synced=0").run();
      await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
      await sweepCancellations(testEnv(), sweepDeps());
    }
    expect(subWrites(parkedAt)).toEqual([]);
    expect(stripeCalls.slice(parkedAt).some((c) => c.method === "GET" && c.path === "/v1/subscriptions/sub_1")).toBe(true);
    expect(await parkAlerts()).toBe(1);
    // Astra JOURNEY-BCORE-5 #5: after the boundary, parked (Stripe still active): Keep reverses the in-app cancellation locally, the cached
    // period left as it is; Stripe is still not written.
    expect((await keepIt(await refOf())).status).toBe(200);
    expect((await getSubRow()).customer_cancel_at).toBeNull();
    expect(subWrites(parkedAt)).toEqual([]);
  });

  it("#1: the public reconciliation meets the schedule first: ONE DELETE, parked as the resolver parks it, never repeated", async () => {
    subs.sub_1.schedule = "sub_sched_y";
    const id = hex("e");
    await publicDecl(id);
    await env.DB.prepare("UPDATE cancellation_requests SET stripe_synced=0 WHERE id=?").bind(id).run();
    await resolve(PERIOD_END + 1000);
    for (const t of [PERIOD_END + 2 * HOUR, PERIOD_END + 4 * HOUR]) {
      await env.DB.prepare("UPDATE cancellation_requests SET stripe_synced=0").run();
      await resolve(t);
    }
    expect(deletes()).toHaveLength(1);
    expect(await env.DB.prepare("SELECT state,schedule_id,last_error FROM cancel_resolutions").first()).toEqual({ state: "open", schedule_id: "sub_sched_y", last_error: "cancel.schedule_attached" });
    expect(await parkAlerts()).toBe(1);
  });

  it("#2: two in-app cancellations stamped in the same millisecond (two subscriptions) get their own keys; both end", async () => {
    await env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,price_id,status,current_period_start,current_period_end,created_at,updated_at)
      VALUES ('home-2','cus_2','sub_2','pro',?,'active',?,?,?,?)`).bind(PRICES.STRIPE_PRICE_PRO, PERIOD_END - 30 * DAY, PERIOD_END, NOW, NOW).run();
    subs.sub_2 = { status: "active", cancel_at_period_end: false, cancel_at: null, price: PRICES.STRIPE_PRICE_PRO, schedule: null, start: PERIOD_END - 30 * DAY, end: PERIOD_END };
    for (const home of ["home-1", "home-2"]) {
      await env.DB.prepare(IN_APP_CANCEL_INTENT_SQL).bind(NOW, NOW, home).run();
      for (const [sql, binds] of inAppResolutionQ(home, NOW)) await env.DB.prepare(sql).bind(...(binds ?? [])).run();
    }
    expect(await env.DB.prepare("SELECT COUNT(DISTINCT generation) AS g, COUNT(*) AS n FROM cancel_resolutions").first()).toEqual({ g: 1, n: 2 });
    await resolve(PERIOD_END);
    const keys = stripeCalls.filter((c) => c.method === "DELETE").map((c) => c.key).sort();
    expect(keys).toEqual([`cxres:sub_1:in_app:${NOW}:delete:1`, `cxres:sub_2:in_app:${NOW}:delete:1`]);
    expect([subs.sub_1.status, subs.sub_2.status]).toEqual(["canceled", "canceled"]);
    expect((await env.DB.prepare("SELECT state FROM cancel_resolutions ORDER BY subscription_id").all()).results).toEqual([{ state: "resolved" }, { state: "resolved" }]);
  });

  it("#3: the public sweep ending the plan at the boundary bills un-invoiced usage now (invoice_now=true, prorate=false)", async () => {
    const id = hex("f");
    await publicDecl(id);
    await env.DB.prepare("UPDATE cancellation_requests SET stripe_synced=0 WHERE id=?").bind(id).run();
    await resolve(PERIOD_END + 1000);
    expect(subs.sub_1.status).toBe("canceled");
    expect(deletes().length).toBeGreaterThan(0);
    expect(deletes().map((c) => [c.form.get("invoice_now"), c.form.get("prorate")])).toEqual(deletes().map(() => ["true", "false"]));
  });

  it("#4: a failed hourly read keeps the subscription parked: no second DELETE, still read hourly, the normal cancel once the schedule is gone", async () => {
    subs.sub_1.schedule = "sub_sched_z";
    await cancelPlan();
    await resolve(PERIOD_END - 4000);
    expect(deletes()).toHaveLength(1);
    stripeDown = true;
    await resolve(PERIOD_END + HOUR);
    stripeDown = false;
    expect(await env.DB.prepare("SELECT state,schedule_id,next_attempt_at FROM cancel_resolutions").first()).toEqual({ state: "open", schedule_id: "sub_sched_z", next_attempt_at: PERIOD_END + 2 * HOUR });
    await resolve(PERIOD_END + 2 * HOUR + MIN);
    expect(deletes()).toHaveLength(1);
    subs.sub_1.schedule = null;
    await resolve(PERIOD_END + 4 * HOUR);
    expect(deletes()).toHaveLength(2);
    expect(subs.sub_1.status).toBe("canceled");
  });

  it("#5: an invoice whose lines cannot be read never blocks the others; it stays unjudged and is recorded on a later pass", async () => {
    await cancelPlan();
    const line = (id: string) => ({ id, amount: 9900, period: { start: PERIOD_END / 1000, end: NEXT_END / 1000 },
      parent: { type: "subscription_item_details", subscription_item_details: { subscription: "sub_1", proration: false } }, pricing: { price_details: { price: PRICES.STRIPE_PRICE_PRO } } });
    const inv = (id: string, hasMore: boolean) => ({ id, object: "invoice", status: "paid", amount_paid: 9900, amount_due: 9900, created: PERIOD_END / 1000, payment_intent: `pi_${id}`,
      customer: "cus_1", subscription: "sub_1", total_taxes: [], lines: { data: [line(`il_${id}`)], has_more: hasMore } });
    paidInvoices = [inv("in_bad", true), inv("in_good", false)];
    failLines.add("in_bad");
    await resolve(PERIOD_END);
    const recs = () => env.DB.prepare("SELECT invoice_id FROM cancel_late_refunds ORDER BY invoice_id").all().then((r) => r.results.map((x) => x.invoice_id));
    expect(await recs()).toEqual(["in_good"]);
    expect(await env.DB.prepare("SELECT status FROM cancel_invoice_checks WHERE invoice_id='in_bad'").first()).toEqual({ status: "paid_unjudged" });
    failLines.clear();
    invoiceLinePages.in_bad = [[line("il_in_bad")]];
    await resolve(PERIOD_END + 2 * HOUR);
    expect(await recs()).toEqual(["in_bad", "in_good"]);
  });

  it("#6: pressing Cancel again after a renewal moved the period still shows the standing promise", async () => {
    const first = await cancelPlan();
    expect(first).toMatchObject({ canceled: true, effectiveAt: PERIOD_END });
    await env.DB.prepare("UPDATE billing_subscriptions SET current_period_start=?,current_period_end=? WHERE home_id='home-1'").bind(PERIOD_END, NEXT_END).run();
    subs.sub_1.end = NEXT_END;
    const again = await cancelPlan();
    expect(again).toMatchObject({ canceled: true, alreadyScheduled: true, effectiveAt: PERIOD_END, activeUntil: PERIOD_END });
    expect(again.sentence).toBe(first.sentence);
  });

  it("#7: a cancellation email still queued when Keep lands is retired, never sent", async () => {
    notifyFails = true;
    await cancelPlan();
    expect((await keepIt(await refOf())).status).toBe(200);
    notifyFails = false;
    at(NOW + 10 * MIN);
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    expect(notices.filter((n) => n.kind === "cancel_scheduled")).toEqual([]);
    const row = await env.DB.prepare("SELECT sent_at,canceled_at FROM billing_notices WHERE kind='cancel_scheduled'").first<{ sent_at: number | null; canceled_at: number | null }>();
    expect(row?.sent_at).toBeNull();
    expect(row?.canceled_at).not.toBeNull();
  });

  it("#8: an in-app Keep that finds the plan ended at Stripe persists the end before answering too_late", async () => {
    await cancelPlan();
    subs.sub_1.status = "canceled";
    const r = await keepIt(await refOf());
    expect(await r.json()).toMatchObject({ error: "too_late" });
    expect(await getSubRow()).toMatchObject({ status: "canceled" });
  });
});

describe("Astra JOURNEY-BCORE-5: parked iff schedule_id is set; written before any read-back; nothing automated writes while parked", () => {
  beforeEach(async () => { await paidHome(); });
  const sweepDeps = () => ({ notifier, stripeFetch, flux: flux as FluxEntitlementHooks });
  const cancelPlan = async () => (await call("/v1/account/cancel-plan", await token(), {})).json<Record<string, unknown>>();
  const keepIt = async (id: string) => call(`/v1/account/cancellations/${id}/keep`, await token(), {});
  const refOf = async () => (await env.DB.prepare("SELECT reference FROM plan_cancellations WHERE home_id='home-1'").first<{ reference: string }>())!.reference;
  const resolve = async (ms: number) => { at(ms); await sweepCancellations(testEnv(), sweepDeps()); };
  const deletes = () => stripeCalls.filter((c) => c.method === "DELETE" && c.path === "/v1/subscriptions/sub_1");
  const subWrites = (from: number) => stripeCalls.slice(from).filter((c) => c.method !== "GET" && c.path.startsWith("/v1/subscription"));
  const parkAlerts = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='cancel.schedule_attached'").first<{ n: number }>())!.n;
  const parkedIds = async () => (await env.DB.prepare("SELECT DISTINCT schedule_id AS s FROM cancel_resolutions WHERE subscription_id='sub_1' AND schedule_id IS NOT NULL").all<{ s: string }>()).results.map((r) => r.s);
  const allSweeps = async (t: number) => {
    at(t);
    await env.DB.prepare("UPDATE billing_subscriptions SET cancel_sync_next_at=NULL").run();
    await env.DB.prepare("UPDATE cancellation_requests SET stripe_synced=0").run();
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    await sweepCancellations(testEnv(), sweepDeps());
  };

  it("#1: Keep withdraws the SOLE parked resolution: still parked, billing sync and every sweep write nothing; only the hourly read clears it", async () => {
    subs.sub_1.schedule = "sub_sched_k";
    expect(await cancelPlan()).toEqual({ canceled: false, processing: true });
    await resolve(PERIOD_END - 4000);
    expect(deletes()).toHaveLength(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cancel_resolutions").first()).toEqual({ n: 1 });
    const from = stripeCalls.length;
    at(PERIOD_END + HOUR);
    // #5 too: after the promised boundary, no period moved by hand.
    expect(await (await keepIt(await refOf())).json()).toEqual({ status: "kept", stripeConfirmed: false, message: KEEP_UNCONFIRMED });
    expect(await env.DB.prepare("SELECT state,schedule_id FROM cancel_resolutions").first()).toEqual({ state: "withdrawn", schedule_id: "sub_sched_k" });
    for (const t of [PERIOD_END + 2 * HOUR + MIN, PERIOD_END + 4 * HOUR]) await allSweeps(t);
    expect(subWrites(from)).toEqual([]);
    expect(await parkedIds()).toEqual(["sub_sched_k"]);
    // The operator removes the schedule: the hourly read-only inspection clears the parking; the kept plan is never ended.
    subs.sub_1.schedule = null;
    await allSweeps(PERIOD_END + 6 * HOUR);
    expect(await parkedIds()).toEqual([]);
    expect(deletes()).toHaveLength(1);
    expect(subs.sub_1.status).toBe("active");
  });

  it("#4: the DELETE is refused and the read-back fails: parked anyway with one alert; the next sweeps send no DELETE", async () => {
    subs.sub_1.schedule = "sub_sched_r";
    await cancelPlan();
    onSubDelete = () => { failSubGets = 1; };
    await resolve(PERIOD_END - 4000);
    expect(deletes()).toHaveLength(1);
    expect(await parkedIds()).toEqual(["sub_sched_r"]);
    expect(await parkAlerts()).toBe(1);
    for (const t of [PERIOD_END + HOUR + MIN, PERIOD_END + 3 * HOUR]) await allSweeps(t);
    expect(deletes()).toHaveLength(1);
    expect(await parkAlerts()).toBe(1);
  });

  it("#2: a public end attributed after its date gets an obligation due now; the refusal parks it durably; later sweeps send no DELETE", async () => {
    subs.sub_1.schedule = "sub_sched_o";
    const id = hex("9");
    const late = PERIOD_END + DAY;
    at(late);
    await declare(id, { effectiveAt: PERIOD_END, synced: false });
    for (const [sql, binds] of publicResolutionQ(id, `op-${id.slice(0, 6)}`, late)) await env.DB.prepare(sql).bind(...(binds ?? [])).run();
    expect(await env.DB.prepare("SELECT state,generation,promised_end_at FROM cancel_resolutions").first()).toEqual({ state: "open", generation: `public:${id}:${PERIOD_END}`, promised_end_at: PERIOD_END });
    await allSweeps(late + MIN);
    expect(deletes()).toHaveLength(1);
    expect(await parkedIds()).toEqual(["sub_sched_o"]);
    for (const t of [late + 2 * HOUR, late + 4 * HOUR]) await allSweeps(t);
    expect(deletes()).toHaveLength(1);
    expect(await parkAlerts()).toBe(1);
  });

  it("#2: with no resolution row at all, the refusal still parks the subscription (a carrier row); later sweeps send no DELETE", async () => {
    subs.sub_1.schedule = "sub_sched_n";
    const id = hex("8");
    await declare(id, { effectiveAt: PERIOD_END, synced: false });
    await allSweeps(PERIOD_END + MIN);
    expect(deletes()).toHaveLength(1);
    expect(await env.DB.prepare("SELECT source,state,schedule_id FROM cancel_resolutions").first()).toEqual({ source: "parked", state: "withdrawn", schedule_id: "sub_sched_n" });
    for (const t of [PERIOD_END + 2 * HOUR, PERIOD_END + 4 * HOUR]) await allSweeps(t);
    expect(deletes()).toHaveLength(1);
    expect(await parkAlerts()).toBe(1);
    subs.sub_1.schedule = null;
    await allSweeps(PERIOD_END + 6 * HOUR);
    expect(await parkedIds()).toEqual([]);
  });

  it("#3: Keep whose first read fails, then the sync finds the plan ended: too_late, the end persisted", async () => {
    await cancelPlan();
    subs.sub_1.status = "canceled";
    failSubGets = 1;
    expect(await (await keepIt(await refOf())).json()).toMatchObject({ error: "too_late" });
    expect(await getSubRow()).toMatchObject({ status: "canceled" });
  });

  it("#3: Keep while Stripe cannot be read at all: kept locally, unconfirmed, and the customer is told so", async () => {
    await cancelPlan();
    failSubGets = 100;
    expect(await (await keepIt(await refOf())).json()).toEqual({ status: "kept", stripeConfirmed: false, message: KEEP_UNCONFIRMED });
  });

  it("#5: a public declaration past its date, parked (Stripe still active): offered and kept, Stripe not written", async () => {
    subs.sub_1.schedule = "sub_sched_p";
    const id = hex("7");
    await declare(id, { effectiveAt: PERIOD_END, synced: false });
    for (const [sql, binds] of publicResolutionQ(id, `op-${id.slice(0, 6)}`, NOW)) await env.DB.prepare(sql).bind(...(binds ?? [])).run();
    await allSweeps(PERIOD_END + MIN);
    expect(deletes()).toHaveLength(1);
    at(PERIOD_END + HOUR);
    const v = await (await summary()).json<{ subscription: { cancellation: { keepIds: string[] } } }>();
    expect(v.subscription.cancellation.keepIds).toContain(id);
    const from = stripeCalls.length;
    expect((await keepCall(id)).status).toBe(200);
    expect(await env.DB.prepare("SELECT status FROM cancellation_requests WHERE id=?").bind(id).first()).toEqual({ status: "kept" });
    await allSweeps(PERIOD_END + 2 * HOUR + MIN);
    expect(subWrites(from)).toEqual([]);
    expect(await parkedIds()).toEqual(["sub_sched_p"]);
  });

  it("#6: Cancel pressed again after a confirmed cancellation was parked: journaled and answered processing, the date unchanged", async () => {
    expect(await cancelPlan()).toMatchObject({ canceled: true, effectiveAt: PERIOD_END });
    subs.sub_1.schedule = "sub_sched_c";
    await resolve(PERIOD_END - 4000);
    expect(await parkedIds()).toEqual(["sub_sched_c"]);
    const before = await getSubRow();
    expect(await cancelPlan()).toEqual({ canceled: false, processing: true });
    const after = await getSubRow();
    expect(after.cancel_intent_rev).toBe(Number(before.cancel_intent_rev) + 1);
    expect(after.cancel_promised_end).toBe(PERIOD_END);
  });
});

describe("Astra JOURNEY-BCORE-6: one gateway for every subscription write; overdue in-app obligations; every Keep read; parked display; alert with parking", () => {
  beforeEach(async () => { await paidHome(); });
  const sweepDeps = () => ({ notifier, stripeFetch, flux: flux as FluxEntitlementHooks });
  const cancelPlan = async () => (await call("/v1/account/cancel-plan", await token(), {})).json<Record<string, unknown>>();
  const refOf = async () => (await env.DB.prepare("SELECT reference FROM plan_cancellations WHERE home_id='home-1'").first<{ reference: string }>())!.reference;
  const resolve = async (ms: number) => { at(ms); await sweepCancellations(testEnv(), sweepDeps()); };
  const deletes = () => stripeCalls.filter((c) => c.method === "DELETE" && c.path === "/v1/subscriptions/sub_1");
  const subWrites = (from: number) => stripeCalls.slice(from).filter((c) => c.method !== "GET" && c.path.startsWith("/v1/subscription"));
  const parkAlerts = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='cancel.schedule_attached'").first<{ n: number }>())!.n;
  const parkedIds = async () => (await env.DB.prepare("SELECT DISTINCT schedule_id AS s FROM cancel_resolutions WHERE subscription_id='sub_1' AND schedule_id IS NOT NULL").all<{ s: string }>()).results.map((r) => r.s);
  const allSweeps = async (t: number) => {
    at(t);
    await env.DB.prepare("UPDATE billing_subscriptions SET cancel_sync_next_at=NULL").run();
    await env.DB.prepare("UPDATE cancellation_requests SET stripe_synced=0").run();
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    await sweepCancellations(testEnv(), sweepDeps());
  };
  /** Parked by ops' schedule exactly as parkOnSchedule leaves a subscription with no obligation (a carrier row), with its alert. */
  const park = async (scheduleId: string, t: number) => {
    subs.sub_1.schedule = scheduleId;
    await env.DB.prepare(`INSERT INTO cancel_resolutions (subscription_id,home_id,source,generation,promised_end_at,due_at,schedule_id,state,next_attempt_at,last_error,created_at,resolved_at)
      VALUES ('sub_1','home-1','parked','parked',?,?,?,'withdrawn',?,'cancel.schedule_attached',?,?)`).bind(t, t, scheduleId, t + HOUR, t, t).run();
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES ('cancel.schedule_attached:sub_1','home-1','cancel.schedule_attached','high','{}',?)").bind(t).run();
  };
  async function webhook(type: string, object: Record<string, unknown>, created: number) {
    const id = `evt_b6_${Math.random().toString(36).slice(2, 10)}`;
    const raw = JSON.stringify({ id, type, created: Math.floor(created / 1000), data: { object } });
    const ctx = createExecutionContext();
    await worker().fetch(new Request("https://auth.murage.test/v1/billing/webhook", { method: "POST", body: raw, headers: { "content-type": "application/json",
      "stripe-signature": await signStripePayload(raw, "whsec_testonlyfixturesecret0123456789", Math.floor(Date.now() / 1000)) } }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    return id;
  }
  const eventRow = async (id: string) => env.DB.prepare("SELECT processed_at,error FROM stripe_events WHERE id=?").bind(id).first<{ processed_at: number | null; error: string | null }>();

  it("#1: a refund retry on a parked subscription sends NO subscription write; it stays pending and ends the plan once the hourly read clears parking", async () => {
    at(NOW);
    await park("sub_sched_rf", NOW);
    const [sql, binds] = refundOpInsert({ id: "op-b6-refund", kind: "withdrawal", homeId: "home-1", userId: account, invoiceId: "in_1", paidCents: 9900, targetCents: 9900,
      endPlan: true, subscriptionId: "sub_1", inheritSubscription: false }, NOW);
    await env.DB.prepare(sql).bind(...(binds ?? [])).run();
    // Decided at nothing to pay: only the plan's end is at stake here (Astra JOURNEY-BCORE-7 #1 covers the money going back first).
    await env.DB.prepare("UPDATE refund_ops SET decided_at=?,amount_cents=0 WHERE id='op-b6-refund'").bind(NOW).run();
    const from = stripeCalls.length;
    for (const t of [NOW + MIN, NOW + 2 * HOUR, NOW + 4 * HOUR]) {
      await allSweeps(t);
      await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id='op-b6-refund'").run(); // every retry, at once
    }
    expect(subWrites(from)).toEqual([]);
    expect(await env.DB.prepare("SELECT canceled_at,done_at,last_error FROM refund_ops WHERE id='op-b6-refund'").first())
      .toEqual({ canceled_at: null, done_at: null, last_error: "subscription_parked:sub_1" });
    expect(await parkedIds()).toEqual(["sub_sched_rf"]);
    // Ops removes the schedule: the hourly read clears parking and makes the refund due now; its cancellation is then sent, once.
    subs.sub_1.schedule = null;
    await allSweeps(NOW + 6 * HOUR);
    expect(await parkedIds()).toEqual([]);
    expect((await env.DB.prepare("SELECT next_attempt_at FROM refund_ops WHERE id='op-b6-refund'").first<{ next_attempt_at: number }>())!.next_attempt_at).toBe(NOW + 6 * HOUR);
    await allSweeps(NOW + 6 * HOUR + MIN);
    expect(deletes()).toHaveLength(1);
    expect(subs.sub_1.status).toBe("canceled");
    expect((await env.DB.prepare("SELECT canceled_at FROM refund_ops WHERE id='op-b6-refund'").first<{ canceled_at: number | null }>())!.canceled_at).not.toBeNull();
  });

  it("#1: dispute and full-refund webhooks on a parked subscription send NO subscription write; the events stay pending until parking clears", async () => {
    at(NOW);
    await park("sub_sched_dw", NOW);
    const from = stripeCalls.length;
    const dispute = await webhook("charge.dispute.created", { id: "dp_1", object: "dispute", charge: "ch_1", reason: "fraudulent" }, NOW);
    externalFullRefund();
    const refund = await webhook("charge.refunded", { id: "ch_2", object: "charge", customer: "cus_1", invoice: "in_1", payment_intent: "pi_1", amount: 9900, refunded: true, refunds: { data: [] } }, NOW);
    for (const t of [NOW + 2 * HOUR, NOW + 4 * HOUR]) {
      await env.DB.prepare("UPDATE stripe_events SET next_attempt_at=NULL WHERE processed_at IS NULL").run(); // every retry, at once
      await allSweeps(t);
    }
    expect(subWrites(from)).toEqual([]);
    expect(await eventRow(dispute)).toEqual({ processed_at: null, error: "subscription_parked:sub_1" });
    expect(await eventRow(refund)).toEqual({ processed_at: null, error: "subscription_parked:sub_1" });
    expect(subs.sub_1.status).toBe("active");
    // Astra INTEGRATED-3 (gap a): parked, THE Stripe-end checkpoint stays unset across every replay; the plan reads ended but unconfirmed.
    expect((await getSubRow()).stripe_end_confirmed).toBeNull();
    expect(await planEndState(env, "home-1")).toMatchObject({ state: "ended", confirmed: false });
    // Cleared by the hourly read: both events are due at once and the plan is ended by ONE cancel.
    subs.sub_1.schedule = null;
    await allSweeps(NOW + 6 * HOUR);
    expect(await parkedIds()).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM stripe_events WHERE processed_at IS NULL AND next_attempt_at=?").bind(NOW + 6 * HOUR).first<{ n: number }>())!.n).toBe(2);
    await allSweeps(NOW + 6 * HOUR + MIN);
    expect(deletes().length).toBeGreaterThan(0);
    expect(subs.sub_1.status).toBe("canceled");
    // The full replay's end came from Stripe's own answer: THE checkpoint names this subscription, and only now is the end confirmed.
    expect((await getSubRow()).stripe_end_confirmed).toBe("sub_1");
    expect(await planEndState(env, "home-1")).toMatchObject({ state: "ended", confirmed: true });
  });

  it("#2: Keep after the boundary while parked, then Cancel in-app: an obligation due now with the frozen date, enforced once parking clears", async () => {
    subs.sub_1.schedule = "sub_sched_kc";
    await cancelPlan();
    await resolve(PERIOD_END - 4000);
    expect(deletes()).toHaveLength(1);
    expect(await parkedIds()).toEqual(["sub_sched_kc"]);
    at(PERIOD_END + HOUR);
    expect((await call(`/v1/account/cancellations/${await refOf()}/keep`, await token(), {})).status).toBe(200);
    at(PERIOD_END + 2 * HOUR);
    expect(await cancelPlan()).toEqual({ canceled: false, processing: true });
    const open = await env.DB.prepare("SELECT promised_end_at,next_attempt_at FROM cancel_resolutions WHERE state='open'").all<{ promised_end_at: number; next_attempt_at: number }>();
    expect(open.results).toHaveLength(1);
    expect(open.results[0].promised_end_at).toBe(PERIOD_END);
    expect(open.results[0].next_attempt_at).toBeLessThanOrEqual(PERIOD_END + 2 * HOUR);
    const from = stripeCalls.length;
    await allSweeps(PERIOD_END + 3 * HOUR);
    expect(subWrites(from)).toEqual([]);
    subs.sub_1.schedule = null;
    await allSweeps(PERIOD_END + 5 * HOUR);
    expect(deletes()).toHaveLength(2);
    expect(subs.sub_1.status).toBe("canceled");
    expect(await env.DB.prepare("SELECT state,promised_end_at FROM cancel_resolutions WHERE state='resolved'").first()).toEqual({ state: "resolved", promised_end_at: PERIOD_END });
    expect(await getSubRow()).toMatchObject({ status: "canceled" });
  });

  it("#3: public Keep whose two leased reads fail, then a later read shows the plan ended: too_late, the end persisted", async () => {
    const id = hex("6");
    await declare(id, { effectiveAt: PERIOD_END, synced: false });
    subs.sub_1.status = "canceled";
    failSubGets = 2;
    expect(await (await keepCall(id)).json()).toMatchObject({ error: "too_late" });
    expect(await getSubRow()).toMatchObject({ status: "canceled" });
  });

  it("#4: a parked COMPLETED declaration still shows its frozen date, being confirmed (never state null)", async () => {
    subs.sub_1.schedule = "sub_sched_cd";
    const id = hex("5");
    await declare(id, { effectiveAt: PERIOD_END, synced: false });
    for (const [sql, binds] of publicResolutionQ(id, `op-${id.slice(0, 6)}`, NOW)) await env.DB.prepare(sql).bind(...(binds ?? [])).run();
    await allSweeps(PERIOD_END + MIN);
    expect(await parkedIds()).toEqual(["sub_sched_cd"]);
    // As Astra's probe: the declaration marked completed, no Stripe end cached.
    await env.DB.prepare("UPDATE cancellation_requests SET status='completed',completed_at=? WHERE id=?").bind(PERIOD_END, id).run();
    await env.DB.prepare("UPDATE billing_subscriptions SET cancel_at=NULL,cancel_at_period_end=0").run();
    at(PERIOD_END + HOUR);
    const v = await (await summary()).json<{ subscription: { ended: boolean; cancellation: Record<string, unknown> } }>();
    expect(v.subscription.ended).toBe(false);
    expect(v.subscription.cancellation).toMatchObject({ state: "pending", endsAt: PERIOD_END, id, keepable: true });
  });

  it("#5: parking commits with its alert or not at all; a parked subscription missing its alert gets it at the next hourly read", async () => {
    subs.sub_1.schedule = "sub_sched_al";
    await cancelPlan();
    await env.DB.prepare("CREATE TRIGGER b6_alert_down BEFORE INSERT ON cloud_alerts WHEN NEW.kind='cancel.schedule_attached' BEGIN SELECT RAISE(ABORT,'alert_down'); END").run();
    await resolve(PERIOD_END - 4000);
    await env.DB.prepare("DROP TRIGGER b6_alert_down").run();
    // Never parked without its alert: the failed insert rolled the parking back too.
    expect(await parkedIds()).toEqual([]);
    expect(await parkAlerts()).toBe(0);
    // A subscription left parked with no alert (a build before this one): the hourly read-only inspection raises it.
    await env.DB.prepare("UPDATE cancel_resolutions SET schedule_id='sub_sched_al',next_attempt_at=? WHERE subscription_id='sub_1'").bind(PERIOD_END).run();
    const from = stripeCalls.length;
    await resolve(PERIOD_END + HOUR);
    expect(subWrites(from)).toEqual([]);
    expect(await parkAlerts()).toBe(1);
    expect(await parkedIds()).toEqual(["sub_sched_al"]);
  });
});

describe("Astra JOURNEY-BCORE-7: money before the parked end; no past promise without its obligation; terminal intent first; scoped wake; every terminal read; parked is never confirmed", () => {
  beforeEach(async () => { await paidHome(); });
  const sweepDeps = () => ({ notifier, stripeFetch, flux: flux as FluxEntitlementHooks });
  const cancelPlan = async () => (await call("/v1/account/cancel-plan", await token(), {})).json<Record<string, unknown>>();
  const refOf = async () => (await env.DB.prepare("SELECT reference FROM plan_cancellations WHERE home_id='home-1'").first<{ reference: string }>())!.reference;
  const deletes = () => stripeCalls.filter((c) => c.method === "DELETE" && c.path === "/v1/subscriptions/sub_1");
  const subWrites = (from: number) => stripeCalls.slice(from).filter((c) => c.method !== "GET" && c.path.startsWith("/v1/subscription"));
  const refundPosts = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/refunds");
  const allSweeps = async (t: number) => {
    at(t);
    await env.DB.prepare("UPDATE billing_subscriptions SET cancel_sync_next_at=NULL").run();
    await env.DB.prepare("UPDATE cancellation_requests SET stripe_synced=0").run();
    await sweepBilling(testEnv(), sweepDeps()).catch(() => undefined);
    await sweepCancellations(testEnv(), sweepDeps());
  };
  const park = async (scheduleId: string, t: number) => {
    subs.sub_1.schedule = scheduleId;
    await env.DB.prepare(`INSERT INTO cancel_resolutions (subscription_id,home_id,source,generation,promised_end_at,due_at,schedule_id,state,next_attempt_at,last_error,created_at,resolved_at)
      VALUES ('sub_1','home-1','parked','parked',?,?,?,'withdrawn',?,'cancel.schedule_attached',?,?)`).bind(t, t, scheduleId, t + HOUR, t, t).run();
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES ('cancel.schedule_attached:sub_1','home-1','cancel.schedule_attached','high','{}',?)").bind(t).run();
  };
  async function webhook(type: string, object: Record<string, unknown>, created: number) {
    const id = `evt_b7_${Math.random().toString(36).slice(2, 10)}`;
    const raw = JSON.stringify({ id, type, created: Math.floor(created / 1000), data: { object } });
    const ctx = createExecutionContext();
    await worker().fetch(new Request("https://auth.murage.test/v1/billing/webhook", { method: "POST", body: raw, headers: { "content-type": "application/json",
      "stripe-signature": await signStripePayload(raw, "whsec_testonlyfixturesecret0123456789", Math.floor(Date.now() / 1000)) } }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    return id;
  }
  const eventRow = async (id: string) => env.DB.prepare("SELECT processed_at,error FROM stripe_events WHERE id=?").bind(id).first<{ processed_at: number | null; error: string | null }>();
  const opRow = async () => env.DB.prepare("SELECT refunded_at,canceled_at,done_at,last_error,attempts FROM refund_ops WHERE id='op-b7'").first<Record<string, unknown>>();

  it("#1: a refund on a parked subscription returns the money at once; only the end waits, then completes once parking clears, never a second refund", async () => {
    at(NOW);
    await park("sub_sched_m", NOW);
    const [sql, binds] = refundOpInsert({ id: "op-b7", kind: "withdrawal", homeId: "home-1", userId: account, invoiceId: "in_1", paidCents: 9900, targetCents: 9900,
      endPlan: true, subscriptionId: "sub_1", inheritSubscription: false, paymentIntent: "pi_1" }, NOW);
    await env.DB.prepare(sql).bind(...(binds ?? [])).run();
    await env.DB.prepare("UPDATE refund_ops SET decided_at=?,amount_cents=9900 WHERE id='op-b7'").bind(NOW).run();
    const from = stripeCalls.length;
    for (const t of [NOW + MIN, NOW + 2 * HOUR, NOW + 4 * HOUR]) {
      await allSweeps(t);
      await env.DB.prepare("UPDATE refund_ops SET next_attempt_at=NULL WHERE id='op-b7'").run();
    }
    // Astra's probe: the money waited on ops. Now: refunded once, the customer told, no subscription write, only the end pending.
    expect(refundPosts()).toHaveLength(1);
    expect(subWrites(from)).toEqual([]);
    expect(await opRow()).toMatchObject({ canceled_at: null, done_at: null, last_error: "subscription_parked:sub_1", attempts: 0 });
    expect((await opRow())!.refunded_at).not.toBeNull();
    expect(notices.filter((n) => n.kind === "refunded")).toHaveLength(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='refund.stuck'").first<{ n: number }>())!.n).toBe(0);
    subs.sub_1.schedule = null;
    await allSweeps(NOW + 6 * HOUR);
    await allSweeps(NOW + 6 * HOUR + MIN);
    expect(deletes()).toHaveLength(1);
    expect(refundPosts()).toHaveLength(1);
    expect(notices.filter((n) => n.kind === "refunded")).toHaveLength(1);
    const done = (await opRow())!;
    expect(done.canceled_at).not.toBeNull();
    expect(done.done_at).not.toBeNull();
  });

  it("#2: Cancel against a stale cached period (Stripe renewed): the promise is the live period end, with its obligation", async () => {
    // The cached period ended; Stripe has renewed (the row has not learned it yet), and nothing is parked.
    subs.sub_1.start = PERIOD_END; subs.sub_1.end = PERIOD_END + 30 * DAY;
    at(PERIOD_END + HOUR);
    const r = await cancelPlan();
    expect(r).toMatchObject({ canceled: true, effectiveAt: PERIOD_END + 30 * DAY });
    expect(await getSubRow()).toMatchObject({ cancel_promised_end: PERIOD_END + 30 * DAY, cancel_at_period_end: 1 });
    const open = (await env.DB.prepare("SELECT promised_end_at FROM cancel_resolutions WHERE state='open'").all<{ promised_end_at: number }>()).results;
    expect(open).toEqual([{ promised_end_at: PERIOD_END + 30 * DAY }]);
  });

  it("#2: the live read fails: accepted at once, the promise pending (being confirmed), then frozen from Stripe with its obligation", async () => {
    subs.sub_1.start = PERIOD_END; subs.sub_1.end = PERIOD_END + 30 * DAY;
    at(PERIOD_END + HOUR);
    stripeDown = true;
    expect(await cancelPlan()).toEqual({ canceled: false, processing: true });
    expect(await getSubRow()).toMatchObject({ customer_cancel_at: PERIOD_END + HOUR, cancel_promised_end: null });
    expect((await (await summary()).json<{ subscription: { cancellation: Record<string, unknown> } }>()).subscription.cancellation).toMatchObject({ state: "pending", endsAt: null });
    stripeDown = false;
    await allSweeps(PERIOD_END + 2 * HOUR);
    expect(await getSubRow()).toMatchObject({ cancel_promised_end: PERIOD_END + 30 * DAY, cancel_at_period_end: 1 });
    expect((await env.DB.prepare("SELECT promised_end_at FROM cancel_resolutions WHERE state='open'").all()).results).toEqual([{ promised_end_at: PERIOD_END + 30 * DAY }]);
  });

  it("#2: an existing frozen promise already past is enforced even when nothing is parked", async () => {
    await cancelPlan();
    await env.DB.prepare("DELETE FROM cancel_resolutions").run();
    at(PERIOD_END + HOUR);
    for (const [sql, b] of inAppResolutionQ("home-1", PERIOD_END + HOUR)) await env.DB.prepare(sql).bind(...(b ?? [])).run();
    const row = await env.DB.prepare("SELECT promised_end_at,next_attempt_at FROM cancel_resolutions WHERE state='open'").first<{ promised_end_at: number; next_attempt_at: number }>();
    expect(row!.promised_end_at).toBe(PERIOD_END);
    expect(row!.next_attempt_at).toBeLessThanOrEqual(PERIOD_END + HOUR);
  });

  it("#3: a dispute on a parked subscription: disputed, service stopped and the customer told at once; only Stripe's end waits", async () => {
    at(NOW);
    await park("sub_sched_d", NOW);
    const from = stripeCalls.length;
    const id = await webhook("charge.dispute.created", { id: "dp_7", object: "dispute", charge: "ch_1", reason: "fraudulent" }, NOW);
    expect(subWrites(from)).toEqual([]);
    expect(await getSubRow()).toMatchObject({ status: "disputed" });
    expect(fluxLog.filter((l) => l.hook === "stop")).toHaveLength(1);
    expect(notices.some((n) => n.kind === "dispute_opened")).toBe(true);
    expect(await eventRow(id)).toEqual({ processed_at: null, error: "subscription_parked:sub_1" });
    // Astra INTEGRATED-3 (gap a): the local 'disputed' is never Stripe's word: no checkpoint, ended but unconfirmed, while parked.
    expect((await getSubRow()).stripe_end_confirmed).toBeNull();
    expect(await planEndState(env, "home-1")).toMatchObject({ state: "ended", confirmed: false });
    subs.sub_1.schedule = null;
    await allSweeps(NOW + 2 * HOUR);
    await allSweeps(NOW + 2 * HOUR + MIN);
    expect(deletes()).toHaveLength(1);
    expect((await eventRow(id))!.processed_at).not.toBeNull();
    expect(await getSubRow()).toMatchObject({ status: "disputed", stripe_end_confirmed: "sub_1" });
    expect(await planEndState(env, "home-1")).toMatchObject({ state: "ended", confirmed: true });
  });

  it("#3: a full refund on a parked subscription: ended locally, service stopped and told at once; the end is still sent after clearance", async () => {
    at(NOW);
    await park("sub_sched_r", NOW);
    const from = stripeCalls.length;
    externalFullRefund();
    const id = await webhook("charge.refunded", { id: "ch_7", object: "charge", customer: "cus_1", invoice: "in_1", payment_intent: "pi_1", amount: 9900, refunded: true, refunds: { data: [] } }, NOW);
    expect(subWrites(from)).toEqual([]);
    expect(await getSubRow()).toMatchObject({ status: "canceled" });
    expect(fluxLog.filter((l) => l.hook === "stop")).toHaveLength(1);
    expect(notices.some((n) => n.kind === "refunded")).toBe(true);
    expect(await eventRow(id)).toEqual({ processed_at: null, error: "subscription_parked:sub_1" });
    subs.sub_1.schedule = null;
    await allSweeps(NOW + 2 * HOUR);
    await allSweeps(NOW + 2 * HOUR + MIN);
    // The local 'canceled' written first does not hide the owed end: it is sent once parking clears.
    expect(deletes()).toHaveLength(1);
    expect(subs.sub_1.status).toBe("canceled");
    expect((await eventRow(id))!.processed_at).not.toBeNull();
  });

  it("#4: clearing one subscription wakes only the work parked on it", async () => {
    const far = NOW + 5 * HOUR;
    for (const [id, sub] of [["evt_a", "sub_1"], ["evt_b", "sub_2"]] as const) {
      await env.DB.prepare("INSERT INTO stripe_events (id,type,payload,received_at,attempts,error,next_attempt_at) VALUES (?,'charge.refunded','{}',?,1,?,?)")
        .bind(id, NOW, `subscription_parked:${sub}`, far).run();
    }
    for (const [sql, b] of unparkQs("sub_1", NOW)) await env.DB.prepare(sql).bind(...(b ?? [])).run();
    const rows = (await env.DB.prepare("SELECT id,next_attempt_at FROM stripe_events WHERE id IN ('evt_a','evt_b') ORDER BY id").all()).results;
    expect(rows).toEqual([{ id: "evt_a", next_attempt_at: NOW }, { id: "evt_b", next_attempt_at: far }]);
  });

  it("#5: in-app Keep whose sync saw the subscription ended, then every later read fails: too_late, the end persisted", async () => {
    await cancelPlan();
    // A renew request whose answer was lost long ago, still pending: the Keep's sync resends it, Stripe refuses (the subscription has ended),
    // and the sync's live read shows the end. Every read after that one fails.
    await env.DB.prepare(`INSERT INTO sub_mutations (id,home_id,subscription_id,desired_cancel,idempotency_key,state,created_at,dispatched_at)
      VALUES ('m-b7','home-1','sub_1',0,'submut:m-b7','pending',?,'[]')`).bind(NOW - DAY).run();
    subs.sub_1.status = "canceled";
    at(NOW + HOUR);
    failSubGets = 1; // the Keep's own leased read
    afterSubGet = () => { failSubGets = 100; };
    expect(await (await call(`/v1/account/cancellations/${await refOf()}/keep`, await token(), {})).json()).toMatchObject({ error: "too_late" });
    expect(await getSubRow()).toMatchObject({ status: "canceled" });
  });

  it("#6: Delete my Cloud on a confirmed cancellation later parked: ending with the frozen date, NOT confirmed", async () => {
    expect(await cancelPlan()).toMatchObject({ canceled: true, effectiveAt: PERIOD_END });
    await park("sub_sched_x", NOW);
    expect(await planEndState(testEnv(), "home-1")).toEqual({ state: "ending", endsAt: PERIOD_END, confirmed: false });
    expect(await (await deleteHold()).json()).toMatchObject({ plan: { state: "ending", endsAt: PERIOD_END, noFurtherCharge: false } });
  });

  it("#7: every routed writer, parked: the outgoing Stripe requests carry no subscription write", async () => {
    // In-app Cancel (syncCancellation), a public declaration's reconciliation, the resolver, an upgrade (members-api), a refund operation
    // and the dispute webhook (cancelConfirmed): each driven while parked, Stripe's requests inspected.
    envOver = { CLOUD_PLAN_CHANGE: "1" };
    await env.DB.prepare(`INSERT INTO provision_choices (home_id,resource_generation,provider,server_type,location,arch,image,tried,created_at)
      SELECT id,resource_generation,'hetzner','cx33','fsn1','x86','img','[]',? FROM cloud_homes WHERE id='home-1'`).bind(NOW).run();
    const quote = await (await call("/v1/account/plan/preview", await token(), { plan: "max" })).json<{ quoteId?: string }>();
    at(NOW);
    await park("sub_sched_all", NOW);
    const from = stripeCalls.length;
    expect(await cancelPlan()).toEqual({ canceled: false, processing: true });
    if (quote.quoteId) expect((await call("/v1/account/plan", await token({ aal2: true }), { quoteId: quote.quoteId })).status).toBe(409);
    const declId = hex("b");
    await declare(declId, { effectiveAt: PERIOD_END, synced: false });
    for (const [sql, b] of publicResolutionQ(declId, `op-${declId.slice(0, 6)}`, NOW)) await env.DB.prepare(sql).bind(...(b ?? [])).run();
    const [sql, binds] = refundOpInsert({ id: "op-b7", kind: "withdrawal", homeId: "home-1", userId: account, invoiceId: "in_1", paidCents: 9900, targetCents: 9900,
      endPlan: true, subscriptionId: "sub_1", inheritSubscription: false, paymentIntent: "pi_1" }, NOW);
    await env.DB.prepare(sql).bind(...(binds ?? [])).run();
    await env.DB.prepare("UPDATE refund_ops SET decided_at=?,amount_cents=0 WHERE id='op-b7'").bind(NOW).run();
    await webhook("charge.dispute.created", { id: "dp_8", object: "dispute", charge: "ch_1", reason: "fraudulent" }, NOW);
    await allSweeps(NOW + MIN);
    await allSweeps(PERIOD_END + MIN); // the resolver's due obligations, the public reconciliation, the in-app sync, the refund retry
    expect(subWrites(from)).toEqual([]);
  });
});

// ---- R16 ---------------------------------------------------------------------------------------------------------------------------

describe("R16: the account summary exposes the first-month refund request of the current first payment", () => {
  beforeEach(async () => { await paidHome(); });
  const subscriptionOf = async () => (await (await summary()).json<{ subscription: { refundRequest: unknown } }>()).subscription;
  const insertRequest = async (id: string, paymentKey: string, receivedAt: number, eligible: number, decidedAt: number | null) =>
    env.DB.prepare("INSERT INTO refund_requests (id,home_id,user_id,payment_key,received_at,eligible,decided_at) VALUES (?,?,?,?,?,?,?)")
      .bind(id, "home-1", account, paymentKey, receivedAt, eligible, decidedAt).run();
  const noMoneyMoved = () => {
    expect(stripeCalls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(stripeCalls.some((c) => c.path.includes("refund"))).toBe(false);
    expect(fluxLog).toEqual([]);
  };

  it("R16 summary: no request means refundRequest null", async () => {
    expect((await subscriptionOf()).refundRequest).toBeNull();
    noMoneyMoved();
  });
  it("R16 summary: an eligible request is shown with its id and receipt time", async () => {
    await insertRequest("rr-1", "in_1", NOW - HOUR, 1, null);
    expect((await subscriptionOf()).refundRequest).toEqual({ id: "rr-1", status: "eligible", receivedAt: NOW - HOUR, decidedAt: null });
    noMoneyMoved();
  });
  it("R16 summary: a request waiting for a person (not eligible yet) is pending", async () => {
    await insertRequest("rr-2", "in_1", NOW - HOUR, 0, null);
    expect((await subscriptionOf()).refundRequest).toEqual({ id: "rr-2", status: "pending", receivedAt: NOW - HOUR, decidedAt: null });
    noMoneyMoved();
  });
  it("R16 summary: a decided request is decided, with its decision time", async () => {
    await insertRequest("rr-3", "in_1", NOW - 2 * HOUR, 1, NOW - HOUR);
    expect((await subscriptionOf()).refundRequest).toEqual({ id: "rr-3", status: "decided", receivedAt: NOW - 2 * HOUR, decidedAt: NOW - HOUR });
    noMoneyMoved();
  });
  it("R16 summary: a request for an OLDER payment of the same home is not shown", async () => {
    await insertRequest("rr-old", "in_0", NOW - DAY, 1, null);
    expect((await subscriptionOf()).refundRequest).toBeNull();
    await insertRequest("rr-now", "in_1", NOW - HOUR, 0, null);
    expect((await subscriptionOf()).refundRequest).toMatchObject({ id: "rr-now", status: "pending" });
    noMoneyMoved();
  });
  it("D1 endedView: a deleted home's summary carries its refund request, payment-scoped like the live summary", async () => {
    await insertRequest("rr-old-d", "in_0", NOW - DAY, 1, null);
    await insertRequest("rr-del", "in_1", NOW - 2 * HOUR, 1, NOW - HOUR);
    await env.DB.prepare("INSERT INTO refund_requests (id,home_id,user_id,payment_key,received_at,eligible) VALUES ('rr-other-d','home-9','user-9','in_1',?,1)").bind(NOW - HOUR).run();
    const live = (await subscriptionOf()).refundRequest;
    expect(live).toEqual({ id: "rr-del", status: "decided", receivedAt: NOW - 2 * HOUR, decidedAt: NOW - HOUR });
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled',stripe_end_confirmed=subscription_id,updated_at=? WHERE home_id='home-1'").bind(NOW - DAY).run();
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleted',updated_at=? WHERE id='home-1'").bind(NOW + DAY).run();
    const r = await summary();
    expect(r.status).toBe(200);
    const body = await r.json<{ homeId: unknown; home: { state: string }; subscription: { refundRequest: unknown } }>();
    expect(body.homeId).toBeNull();
    expect(body.home.state).toBe("deleted");
    expect(body.subscription.refundRequest).toEqual(live);
    noMoneyMoved();
  });
  it("D1 endedView: a deleted home with no request for its current payment says refundRequest null", async () => {
    await insertRequest("rr-old-e", "in_0", NOW - DAY, 1, null);
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleted',updated_at=? WHERE id='home-1'").bind(NOW + DAY).run();
    expect((await subscriptionOf()).refundRequest).toBeNull();
  });
  it("R16 summary: another home's request for the same payment key is not shown", async () => {
    await env.DB.prepare("INSERT INTO refund_requests (id,home_id,user_id,payment_key,received_at,eligible) VALUES ('rr-other','home-9','user-9','in_1',?,1)").bind(NOW - HOUR).run();
    expect((await subscriptionOf()).refundRequest).toBeNull();
    noMoneyMoved();
  });
});
