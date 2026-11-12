// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /v1/status ({live}) and GET /v1/account/step-up/state ({fresh, freshUntil?}), src/status.ts.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { assertSalesOpen, salesAllowed, salesMode, salesShut } from "../src/b5-config";
import { assertInvited, normalizeInviteEmail } from "../src/sales-invite";
import { cloudOperating } from "../src/status";
import { CAPACITY_LINE } from "../src/self-service";
import { assertImageEpochCurrent } from "../src/image-admission";
import { setImageReadinessForTests } from "./../src/image-readiness";
import { okProbe } from "./setup";
import { createCheckout, reserveHomeRoute } from "../src/b5-billing";
import { resumeCheckout } from "../src/members-api";

const REF_ORIGIN = "https://testref.supabase.co";
const ISS = `${REF_ORIGIN}/auth/v1`;
const SUB_A = "7b2e3d40-5c6f-4a71-8bcd-2e3f4a5b6c7d";
const SUB_C = "9d405f62-7e81-4c93-8def-4a5b6c7d8e9f";
const SUB_B = "8c3f4e51-6d70-4b82-9cde-3f4a5b6c7d8e";
const STATE = "https://auth.murage.test/v1/account/step-up/state";
const DOOR_WINDOW_MS = 900_000;

const b64u = (b: ArrayBuffer | string) => Buffer.from(typeof b === "string" ? Buffer.from(b) : new Uint8Array(b)).toString("base64url");
let ec: CryptoKeyPair;
let jwks: { keys: Record<string, unknown>[] };
let signingJwk: JsonWebKey;
beforeAll(async () => {
  ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", ec.publicKey) as Record<string, unknown>), kid: "ec-1", alg: "ES256", use: "sig" }] };
  // The B3 signing key (CLOUD_B3_SIGNING_JWK): /door signs its ticket with it, so the parity tests below reach a real 200.
  const b3 = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  signingJwk = await crypto.subtle.exportKey("jwk", b3.privateKey);
});
const factorOf = (sub: string) => `${sub.slice(0, 24)}000000000f01`;
type Amr = { method: string; timestamp: number };
/** A member's token issued at clock `at` (s) in session `sessionId`, with exactly these amr entries. */
async function token(sub: string, email: string, o: { at: number; aal: "aal1" | "aal2"; amr: Amr[]; sessionId?: string }) {
  const c = { iss: ISS, aud: "authenticated", exp: o.at + 3600, iat: o.at - 5, sub, email, role: "authenticated", is_anonymous: false,
    app_metadata: { provider: "email", email_verified: true }, user_metadata: {}, session_id: o.sessionId ?? `sess-${sub}`,
    mfa_factor_id: factorOf(sub), aal: o.aal, amr: o.amr };
  const input = `${b64u(JSON.stringify({ alg: "ES256", kid: "ec-1", typ: "JWT" }))}.${b64u(JSON.stringify(c))}`;
  return `${input}.${b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, new TextEncoder().encode(input)))}`;
}
const jwksFetch = (async () => Response.json(jwks)) as typeof fetch;
const authFetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
  const bearer = new Headers(init?.headers).get("authorization")!.slice("Bearer ".length);
  const c = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString()) as { sub: string; email: string };
  return Response.json({ id: c.sub, email: c.email, email_confirmed_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    factors: [{ id: factorOf(c.sub), factor_type: "totp", status: "verified", friendly_name: "" }] });
}) as typeof fetch;
const workerAt = (now?: () => number) => createWorker(fetch, fetch, {}, {}, {}, { jwksFetch, authFetch, ...(now ? { now } : {}) });
const baseEnv = (extra: Record<string, unknown> = {}) => ({ ...env, CLOUD_B3_SIGNING_JWK: JSON.stringify(signingJwk), SUPABASE_URL: REF_ORIGIN, SUPABASE_PUBLISHABLE_KEY: ["sb_publi", "shable_t", "estkey_0", "12345678", "9abcdef"].join(""),
  MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined, ...extra }) as unknown as Env;

async function send(w: ReturnType<typeof createWorker>, url: string, init: RequestInit = {}, e: Env = baseEnv()) {
  const ctx = createExecutionContext();
  const res = await w.fetch(new Request(url, init), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const bearer = (t: string | null): RequestInit => ({ headers: t ? { authorization: `Bearer ${t}` } : {} });
/** Creates the Cloud account (the sign-in's own first-sight write, outside the endpoint under test) and trusts its TOTP factor. */
async function member(sub: string, email: string, trust = true, home: "v1" | "v2" | null = "v2") {
  const t = await token(sub, email, { at: Math.floor(Date.now() / 1000), aal: "aal1", amr: [{ method: "password", timestamp: 1 }] });
  expect((await send(workerAt(), "https://auth.murage.test/v1/account/terms", bearer(t))).status).toBe(200);
  const row = await env.DB.prepare("SELECT user_id FROM supabase_identities WHERE sub=?").bind(sub).first<{ user_id: string }>();
  if (trust) await env.DB.prepare("INSERT OR IGNORE INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state) VALUES (?,?,'totp','email_code',0,0,'active')")
    .bind(row!.user_id, factorOf(sub)).run();
  if (home) await setHome(row!.user_id, home);
  return row!.user_id;
}
/** The member's owned home number n, READY (desired_state ready, a ready endpoint with tunnel, DNS record and hostname), at this door version (v1: door_version NULL, like a home that never sent a v2 heartbeat). */
async function setHome(userId: string, version: "v1" | "v2" | null, n = 1) {
  const id = `home-${userId}-${n}`;
  await env.DB.prepare("DELETE FROM machine_endpoints WHERE machine_id=?").bind(id).run();
  await env.DB.prepare("DELETE FROM cloud_homes WHERE id=?").bind(id).run();
  if (!version) return;
  await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,generation,created_at,updated_at,door_version)
    VALUES (?,?,?,'ready','ready',?,'k',3,1,1,?)`).bind(id, `inst-${userId}-${n}`, userId, `sha256:${"a".repeat(64)}`, version === "v2" ? "v2" : null).run();
  const host = `h-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}.murage.test`;
  await env.DB.prepare("INSERT INTO machine_endpoints (machine_id,hostname,tunnel_name,tunnel_id,dns_record_id,status,created_at,updated_at) VALUES (?,?,?,?,?,'ready',1,1)")
    .bind(id, host, `t-${id}`, `tun-${id}`, `dns-${id}`).run();
}
/** POST /v1/homes/<id>/door as the owner at this clock, with the body that home's door version needs (v2: {bind, kind}; v1: {}). */
async function doorStatus(t: string, clock: number, userId: string, version: "v1" | "v2", n = 1) {
  const body = version === "v2" ? { bind: "ab".repeat(32), kind: "browser" } : {};
  return (await send(workerAt(() => clock), `https://auth.murage.test/v1/homes/home-${userId}-${n}/door`,
    { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify(body) })).status;
}
/** A DB that records every statement that is not a SELECT (and refuses batch/exec): the route must write nothing. */
const readOnlyDb = (writes: string[], onSelect?: (sql: string) => void) => new Proxy(env.DB, { get(t, p) {
  if (p === "prepare") return (sql: string) => { if (!/^\s*(SELECT|WITH)\b/i.test(sql)) writes.push(sql.slice(0, 60)); else onSelect?.(sql); return t.prepare(sql); };
  if (p === "batch" || p === "exec") return () => { writes.push(String(p)); throw new Error("write"); };
  const v = Reflect.get(t, p, t); return typeof v === "function" ? v.bind(t) : v;
} }) as D1Database;
const stateOf = async (res: Response) => ({ status: res.status, body: await res.json() as Record<string, unknown> });

// ---- GET /v1/status ------------------------------------------------------------------------------------------------------------------
const OPEN_ENV = { CLOUD_SALES_OPEN: "true", CLOUD_B3_MODE: "fake", STRIPE_SECRET_KEY: ["sk_test_", "abcdefgh", "ijklmnop"].join(""), STRIPE_WEBHOOK_SECRET: "whsec_abcdefghij",
  STRIPE_PRICE_STARTER: "price_AAAAAAAA", STRIPE_PRICE_PRO: "price_BBBBBBBB", STRIPE_PRICE_MAX: "price_CCCCCCCC", BILLING_RETURN_ORIGIN: "https://cloud.murage.test",
  REFUND_KEY_SECRET: undefined, CLOUD_KEK_V1: btoa("k".repeat(32)),
  CLOUD_B3_CONFIG: JSON.stringify({ reservationMs: 1_800_000, graceMs: 259_200_000, retentionMs: 2_592_000_000, imageDigest: `sha256:${"a".repeat(64)}`,
    engineSubscriptionGates: { claudeAgent: true, codex: true, grokAgent: true, kimiAgent: true, opencodeGo: true }, quarantineRelayIP: "192.0.2.1", capacity: [] }),
  CLOUD_HOME_HOST_SUFFIX: "murage.test", CLOUD_HOME_ZONE_ID: "0".repeat(32), CLOUD_HOME_ACCOUNT_ID: "0".repeat(32), CLOUD_HOME_API_TOKEN: "test-only-cloud-home-token-no-access" };
const KMS = { AWS_KMS_KEY_ARN: "arn:aws:kms:eu-west-1:149471050106:key/0c7fb20d-226b-4ccc-91c5-93fd414c1afb", AWS_KMS_REGION: "eu-west-1",
  AWS_ACCESS_KEY_ID: "AKIATESTONLY", AWS_SECRET_ACCESS_KEY: "test-only-secret" };
const status = async (extra: Record<string, unknown> = {}, init: RequestInit = {}) =>
  send(workerAt(), "https://auth.murage.test/v1/status", init, baseEnv({ ...OPEN_ENV, ...extra }));

describe("GET /v1/status", () => {
  it("open: live true; JSON only, no other field, no-store, no CORS, no auth", async () => {
    const res = await status();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ live: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("sales closed: the switch unset, \"false\" or anything but \"true\" leaves live true (existing customers keep Cloud)", async () => {
    for (const v of [undefined, "false", "", "1", "TRUE", "yes"]) {
      const res = await status({ CLOUD_SALES_OPEN: v });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ live: true });
    }
  });
  it("the body is exactly {live} (the desktop rejects any extra key) and a signing key the signer cannot use is live false", async () => {
    const res = await status();
    expect(Object.keys(await res.json() as object)).toEqual(["live"]);
    const shut = await status({ CLOUD_SALES_OPEN: "false" });
    expect(Object.keys(await shut.json() as object)).toEqual(["live"]);
    for (const jwk of ["{}", "null", "not json", JSON.stringify({ kty: "EC", crv: "P-256" }), JSON.stringify({ ...signingJwk, d: undefined }), JSON.stringify({ ...signingJwk, crv: "P-384" }), JSON.stringify({ ...signingJwk, x: "AAAA" })]) {
      expect(await (await status({ CLOUD_B3_SIGNING_JWK: jwk })).json(), jwk).toEqual({ live: false });
    }
    expect(await (await status({ CLOUD_B3_SIGNING_JWK: undefined })).json()).toEqual({ live: false });
  });
  it("checkout-only secrets do not decide live: removing or malforming REFUND_KEY_SECRET / CHECKOUT_DISCLOSURE_TOKEN_SECRET leaves existing customers live", async () => {
    for (const b of [{ CHECKOUT_DISCLOSURE_TOKEN_SECRET: undefined }, { CHECKOUT_DISCLOSURE_TOKEN_SECRET: "short" }, { REFUND_KEY_SECRET: undefined },
      { REFUND_KEY_SECRET: "short" }, { REFUND_KEY_SECRET: undefined, CHECKOUT_DISCLOSURE_TOKEN_SECRET: undefined, CLOUD_SALES_OPEN: "false" }]) {
      expect(await (await status(b)).json(), JSON.stringify(Object.keys(b))).toEqual({ live: true });
    }
  });
  it("KMS production wrapper: full KMS settings (with or without the legacy KEK) are live; KMS needs no network call to answer", async () => {
    const noNet = vi.fn(() => { throw new Error("no network"); });
    vi.stubGlobal("fetch", noNet);
    try {
      expect(await (await status({ ...KMS, CLOUD_KEK_V1: undefined })).json()).toEqual({ live: true });
      expect(await (await status({ ...KMS })).json()).toEqual({ live: true });
    } finally { vi.unstubAllGlobals(); }
    expect(noNet).not.toHaveBeenCalled();
  });
  it("G3: a live-mode Stripe key on the staging rig is refused as a mixed environment (503 env_mixed), not reported as live:false", async () => {
    const res = await status({ STRIPE_SECRET_KEY: ["sk_live_", "abcdefgh", "ijklmnop"].join("") }); // secret-scan: fixture
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "env_mixed" });
  });
  it("broken config is live false, never an error: bad keys, live Stripe key not allowed, half prices, engine off, no key wrapper", async () => {
    const broken: Record<string, unknown>[] = [
      { STRIPE_SECRET_KEY: "garbage" },
      { STRIPE_PRICE_PRO: undefined }, { STRIPE_PRICE_PRO: "price_AAAAAAAA" }, { BILLING_RETURN_ORIGIN: "http://insecure.test" },
      { STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined }, { CLOUD_B3_MODE: undefined },
      { STRIPE_API_VERSION: "2020-01-01" },
      // Every environment-only prerequisite of a sale (Astra STATUS1 #1): the control plane's own config, Supabase sign-in, the B3 config, the managed-home endpoints.
      { BETTER_AUTH_URL: "nope" }, { ALLOWED_ORIGINS: undefined }, { BETTER_AUTH_SECRET: "short" }, { SUPABASE_URL: undefined }, { SUPABASE_PUBLISHABLE_KEY: undefined },
      { SUPABASE_PUBLISHABLE_KEY: "short" }, { CLOUD_B3_CONFIG: "{not json" }, { CLOUD_B3_CONFIG: undefined }, { CLOUD_B3_CONFIG: "{}" },
      // The home-key wrapper pairing and provisioning use (key-wrapper.ts keyWrapperFor): no KEK and no KMS, or KMS half configured.
      { CLOUD_KEK_V1: undefined }, { CLOUD_KEK_V1: "short" },
      { CLOUD_KEK_V1: undefined, AWS_KMS_KEY_ARN: KMS.AWS_KMS_KEY_ARN }, { ...KMS, AWS_KMS_REGION: undefined }, { ...KMS, AWS_KMS_REGION: " " }, { ...KMS, AWS_KMS_REGION: "us-east-1" }, { ...KMS, AWS_KMS_REGION: "eu-west-1/x" }, { ...KMS, AWS_ACCESS_KEY_ID: undefined },
      { ...KMS, AWS_SECRET_ACCESS_KEY: undefined, CLOUD_KEK_V1: undefined }, { ...KMS, AWS_KMS_KEY_ARN: undefined, CLOUD_KEK_V1: undefined },
      { CLOUD_HOME_API_TOKEN: undefined }, { CLOUD_HOME_ZONE_ID: "nothex" }, { CLOUD_HOME_HOST_SUFFIX: undefined }, { CLOUD_HOME_HOST_SUFFIX: undefined, CLOUD_HOME_ZONE_ID: undefined, CLOUD_HOME_ACCOUNT_ID: undefined, CLOUD_HOME_API_TOKEN: undefined },
    ];
    for (const b of broken) {
      const res = await status(b);
      expect(res.status, JSON.stringify(Object.keys(b))).toBe(200);
      expect(await res.json()).toEqual({ live: false });
      // Closed sales with the same broken config is still live:false (a broken service is not operating).
      expect(await (await status({ ...b, CLOUD_SALES_OPEN: "false" })).json()).toEqual({ live: false });
    }
    // The control plane's own configuration (readConfig) broken: the worker is down for everything else, and status is a plain live:false.
    expect((await send(workerAt(), "https://auth.murage.test/healthz", {}, baseEnv({ ...OPEN_ENV, ALLOWED_ORIGINS: undefined, BETTER_AUTH_URL: "nope" }))).status).toBe(503);
    const res = await status({ ALLOWED_ORIGINS: undefined, BETTER_AUTH_URL: "nope" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ live: false });
    // A config that throws on read is false too.
    expect(await cloudOperating(new Proxy({} as Env, { get() { throw new Error("boom"); } }))).toBe(false);
  });
  it("is the switch checkout honors: live true => checkout/reserve not shut; shut (\"false\") => live false and reserve/checkout 503 sales_closed", async () => {
    expect(() => assertSalesOpen({ CLOUD_SALES_OPEN: "false" })).toThrow();
    expect(() => assertSalesOpen({ CLOUD_SALES_OPEN: "true" })).not.toThrow();
    expect(() => assertSalesOpen({})).toThrow();           // strict: unset is shut (CH1)
    expect(() => assertSalesOpen({ CLOUD_SALES_OPEN: "invite" })).not.toThrow();
    await member(SUB_A, "owner@example.test");
    const s = Math.floor(Date.now() / 1000);
    // aal2 with a trusted, fresh authenticator: the step-up gate (checkout and resume are gated) passes, so the sales switch is what refuses.
    const t = await token(SUB_A, "owner@example.test", { at: s, aal: "aal2", amr: [{ method: "totp", timestamp: s - 5 }] });
    for (const path of ["/v1/billing/reserve", "/v1/billing/checkout", "/v1/billing/checkout/resume"]) {
      const res = await send(workerAt(), `https://auth.murage.test${path}`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: "{}" },
        baseEnv({ ...OPEN_ENV, CLOUD_SALES_OPEN: "false" }));
      expect(res.status, path).toBe(503);
      expect(await res.json()).toEqual({ error: "sales_closed" });
    }
    expect(await (await status({ CLOUD_SALES_OPEN: "false" })).json()).toEqual({ live: true });
  });
  it("is edge-limited per IP like the other public GETs, answers 429 with no body of its own, and other methods are 405", async () => {
    const keys: string[] = [];
    const limiter = { async limit(o: { key: string }) { keys.push(o.key); return { success: false }; } };
    const res = await send(workerAt(), "https://auth.murage.test/v1/status", { headers: { "cf-connecting-ip": "203.0.113.9" } }, baseEnv({ ...OPEN_ENV, MACHINE_OPEN_LIMIT: limiter }));
    expect(res.status).toBe(429);
    expect(keys).toEqual(["status:203.0.113.9"]);
    const ok = { async limit() { return { success: true }; } };
    expect((await send(workerAt(), "https://auth.murage.test/v1/status", {}, baseEnv({ ...OPEN_ENV, MACHINE_OPEN_LIMIT: ok }))).status).toBe(200);
    expect((await send(workerAt(), "https://auth.murage.test/v1/status", { method: "POST", body: "{}" }, baseEnv(OPEN_ENV))).status).not.toBe(200);
  });
  it("touches no D1", async () => {
    const seen: string[] = [];
    const db = new Proxy(env.DB, { get(t, p) { if (p === "prepare" || p === "batch" || p === "exec") return () => { seen.push(String(p)); throw new Error("no D1"); }; const v = Reflect.get(t, p, t); return typeof v === "function" ? v.bind(t) : v; } });
    const res = await send(workerAt(), "https://auth.murage.test/v1/status", {}, baseEnv({ ...OPEN_ENV, DB: db }));
    expect(await res.json()).toEqual({ live: true });
    expect(seen).toEqual([]);
  });
});

// ---- GET /v1/account/step-up/state ---------------------------------------------------------------------------------------------------
describe("GET /v1/account/step-up/state", () => {
  const now = () => Math.floor(Date.now() / 1000);
  it("fresh: an emailed sign-in 100 s old is fresh until exactly its time + 900 s", async () => {
    await member(SUB_A, "owner@example.test");
    const s = now();
    const t = await token(SUB_A, "owner@example.test", { at: s, aal: "aal1", amr: [{ method: "otp", timestamp: s - 100 }] });
    expect(await stateOf(await send(workerAt(), STATE, bearer(t)))).toEqual({ status: 200, body: { fresh: true, freshUntil: (s - 100) * 1000 + DOOR_WINDOW_MS } });
  });
  it("fresh: a trusted authenticator proved 10 s ago (aal2 totp) is fresh until the gate's 600 s window ends (the default, under the door's 900 s)", async () => {
    await member(SUB_A, "owner@example.test");
    const s = now();
    const t = await token(SUB_A, "owner@example.test", { at: s, aal: "aal2", amr: [{ method: "totp", timestamp: s - 10 }, { method: "password", timestamp: s - 900 }] });
    expect(await stateOf(await send(workerAt(), STATE, bearer(t)))).toEqual({ status: 200, body: { fresh: true, freshUntil: (s - 10 + 601) * 1000 - 1 } });
  });
  it("fresh: a CP-granted emailed code in THIS session counts", async () => {
    const id = await member(SUB_A, "owner@example.test");
    const s = now();
    const at = s * 1000 - 200_000;
    await env.DB.prepare("INSERT INTO cloud_stepup_events (id,user_id,session_id,kind,intent_id,challenge_id,at) VALUES (?,?,?,'granted',NULL,NULL,?)")
      .bind(crypto.randomUUID(), id, "sess-granted", at).run();
    const t = await token(SUB_A, "owner@example.test", { at: s, aal: "aal1", amr: [{ method: "password", timestamp: s - 60 }], sessionId: "sess-granted" });
    expect(await stateOf(await send(workerAt(), STATE, bearer(t)))).toEqual({ status: 200, body: { fresh: true, freshUntil: at + DOOR_WINDOW_MS } });
  });
  it("stale: proofs older than 900 s are not fresh, and freshUntil is omitted", async () => {
    await member(SUB_A, "owner@example.test");
    const s = now();
    for (const [aal, amr] of [["aal1", [{ method: "otp", timestamp: s - 2000 }]], ["aal2", [{ method: "totp", timestamp: s - 2000 }]]] as const) {
      const t = await token(SUB_A, "owner@example.test", { at: s, aal, amr: [...amr] });
      expect(await stateOf(await send(workerAt(), STATE, bearer(t)))).toEqual({ status: 200, body: { fresh: false } });
    }
  });
  it("never stepped up: a password-only session, and an aal2 session whose factor is not trusted, are not fresh", async () => {
    await member(SUB_A, "owner@example.test", false);
    const s = now();
    const pw = await token(SUB_A, "owner@example.test", { at: s, aal: "aal1", amr: [{ method: "password", timestamp: s - 5 }] });
    expect(await stateOf(await send(workerAt(), STATE, bearer(pw)))).toEqual({ status: 200, body: { fresh: false } });
    const untrusted = await token(SUB_A, "owner@example.test", { at: s, aal: "aal2", amr: [{ method: "totp", timestamp: s - 5 }] });
    expect(await stateOf(await send(workerAt(), STATE, bearer(untrusted)))).toEqual({ status: 200, body: { fresh: false } });
  });
  it("wrong user: another member's granted code in the same session id never makes you fresh", async () => {
    const a = await member(SUB_A, "owner@example.test");
    await member(SUB_B, "other@example.test", false);
    const s = now();
    await env.DB.prepare("INSERT INTO cloud_stepup_events (id,user_id,session_id,kind,intent_id,challenge_id,at) VALUES (?,?,?,'granted',NULL,NULL,?)")
      .bind(crypto.randomUUID(), a, "sess-shared", s * 1000 - 1000).run();
    const b = await token(SUB_B, "other@example.test", { at: s, aal: "aal1", amr: [{ method: "password", timestamp: s - 5 }], sessionId: "sess-shared" });
    expect(await stateOf(await send(workerAt(), STATE, bearer(b)))).toEqual({ status: 200, body: { fresh: false } });
  });
  it("unauthenticated: no token, a garbage token, and a Better Auth style bearer are 401; other methods are refused", async () => {
    expect((await send(workerAt(), STATE, {})).status).toBe(401);
    expect((await send(workerAt(), STATE, bearer("not.a.jwt"))).status).toBe(401);
    await member(SUB_A, "owner@example.test");
    const t = await token(SUB_A, "owner@example.test", { at: now(), aal: "aal1", amr: [{ method: "otp", timestamp: now() }] });
    expect((await send(workerAt(), STATE, { method: "POST", ...bearer(t), body: "{}" })).status).not.toBe(200);
  });
  it("freshUntil is the /door boundary: fresh at it, and /door asks for a code one millisecond later", async () => {
    const id = await member(SUB_A, "owner@example.test");
    const s = now();
    const t = await token(SUB_A, "owner@example.test", { at: s, aal: "aal1", amr: [{ method: "otp", timestamp: s }] });
    const until = s * 1000 + DOOR_WINDOW_MS;
    const at = async (clock: number) => stateOf(await send(workerAt(() => clock), STATE, bearer(t)));
    const early = await at(s * 1000 + 1000);
    expect(early.body).toEqual({ fresh: true, freshUntil: until });
    // At the boundary: the state is fresh and the door's gate lets the request through to its home lookup (not 403).
    expect((await at(until)).body).toEqual({ fresh: true, freshUntil: until });
    expect(await doorStatus(t, until, id, "v2")).toBe(200);
    // One millisecond later: not fresh, and the door demands a second step.
    expect((await at(until + 1)).body).toEqual({ fresh: false });
    const late = await send(workerAt(() => until + 1), "https://auth.murage.test/v1/homes/home-" + id + "-1/door", { method: "POST",
      headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify({ bind: "ab".repeat(32), kind: "browser" }) });
    expect(late.status).toBe(403);
    expect(await late.json()).toMatchObject({ error: "step_up_required" });
  });
  it("writes nothing: no INSERT/UPDATE/DELETE statement, and the step-up tables are unchanged, for fresh, stale and trusted-factor answers", async () => {
    await member(SUB_A, "owner@example.test");
    const s = now();
    const count = async () => JSON.stringify(await Promise.all(["cloud_stepup_events", "cloud_stepup_intents", "cloud_trusted_factors", "supabase_identities", "user"]
      .map((tb) => env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(rowid AS TEXT))),0) AS r FROM "${tb}"`).first())));
    const before = await count();
    const writes: string[] = [];
    const db = new Proxy(env.DB, { get(t, p) {
      if (p === "prepare") return (sql: string) => { if (!/^\s*(SELECT|WITH)\b/i.test(sql)) writes.push(sql.slice(0, 60)); return t.prepare(sql); };
      if (p === "batch" || p === "exec") return () => { writes.push(String(p)); throw new Error("write"); };
      const v = Reflect.get(t, p, t); return typeof v === "function" ? v.bind(t) : v;
    } }) as D1Database;
    for (const [aal, amr] of [["aal1", [{ method: "otp", timestamp: s - 5 }]], ["aal1", [{ method: "otp", timestamp: s - 5000 }]], ["aal2", [{ method: "totp", timestamp: s - 5 }]]] as const) {
      const t = await token(SUB_A, "owner@example.test", { at: s, aal, amr: [...amr] });
      const res = await send(workerAt(), STATE, bearer(t), baseEnv({ DB: db }));
      expect(res.status).toBe(200);
    }
    expect(writes).toEqual([]);
    expect(await count()).toBe(before);
  });
});

// ---- Astra STATUS1 #2-#6 -------------------------------------------------------------------------------------------------------------
describe("GET /v1/account/step-up/state: the real /door expiry (Astra STATUS1 #3-#5)", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const stateAt = async (t: string, clock: number, e?: Env) => stateOf(await send(workerAt(() => clock), STATE, bearer(t), e));
  it("a v1 home keeps the 300 s window: an emailed sign-in 400 s old is NOT fresh, 100 s old is fresh until its time + 300 s; the same proof on a v2 home is fresh until + 900 s", async () => {
    const id = await member(SUB_A, "owner@example.test", true, "v1");
    const s = now();
    const old = await token(SUB_A, "owner@example.test", { at: s, aal: "aal1", amr: [{ method: "otp", timestamp: s - 400 }] });
    expect(await stateOf(await send(workerAt(), STATE, bearer(old)))).toEqual({ status: 200, body: { fresh: false } });
    const young = await token(SUB_A, "owner@example.test", { at: s, aal: "aal1", amr: [{ method: "otp", timestamp: s - 100 }] });
    const until = (s - 100) * 1000 + 300_000;
    expect(await stateOf(await send(workerAt(), STATE, bearer(young)))).toEqual({ status: 200, body: { fresh: true, freshUntil: until } });
    expect((await stateAt(young, until)).body).toEqual({ fresh: true, freshUntil: until });
    expect((await stateAt(young, until + 1)).body).toEqual({ fresh: false });
    // The v1 /door agrees on both sides of its 300 s boundary.
    expect(await doorStatus(young, until, id, "v1")).toBe(200);
    expect(await doorStatus(young, until + 1, id, "v1")).toBe(403);
    await setHome(id, "v2");
    expect(await stateOf(await send(workerAt(), STATE, bearer(old)))).toEqual({ status: 200, body: { fresh: true, freshUntil: (s - 400) * 1000 + DOOR_WINDOW_MS } });
  });
  it("no owned home is not fresh; with several homes the most restrictive window (a v1 among v2) applies; a deleted home does not count", async () => {
    const id = await member(SUB_A, "owner@example.test", true, null);
    const s = now();
    const t = await token(SUB_A, "owner@example.test", { at: s, aal: "aal1", amr: [{ method: "otp", timestamp: s - 400 }] });
    expect((await stateOf(await send(workerAt(), STATE, bearer(t)))).body).toEqual({ fresh: false });
    await setHome(id, "v2", 1); await setHome(id, "v1", 2);
    expect((await stateOf(await send(workerAt(), STATE, bearer(t)))).body).toEqual({ fresh: false });
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleted' WHERE id=?").bind(`home-${id}-2`).run();
    expect((await stateOf(await send(workerAt(), STATE, bearer(t)))).body).toEqual({ fresh: true, freshUntil: (s - 400) * 1000 + DOOR_WINDOW_MS });
  });
  it("a TOTP-only session at the default 600 s: freshUntil is the proof + 601 s boundary (not + 900 s), and /door agrees on both sides of it", async () => {
    const id = await member(SUB_A, "owner@example.test");
    const s = now();
    const t = await token(SUB_A, "owner@example.test", { at: s, aal: "aal2", amr: [{ method: "totp", timestamp: s - 10 }] });
    const until = (s - 10 + 601) * 1000 - 1;
    expect((await stateAt(t, s * 1000)).body).toEqual({ fresh: true, freshUntil: until });
    expect((await stateAt(t, until)).body).toEqual({ fresh: true, freshUntil: until });
    expect(await doorStatus(t, until, id, "v2")).toBe(200);
    expect((await stateAt(t, until + 1)).body).toEqual({ fresh: false });
    expect(await doorStatus(t, until + 1, id, "v2")).toBe(403);
    // A configured window under 600 s is the bound too.
    const e = baseEnv({ CLOUD_STEPUP_MAX_AGE_SECONDS: "120" });
    expect((await stateAt(t, s * 1000, e)).body).toEqual({ fresh: true, freshUntil: (s - 10 + 121) * 1000 - 1 });
  });
  it("alternative proofs: a stale authenticator beside a fresh emailed sign-in lasts as long as the emailed one", async () => {
    const id = await member(SUB_A, "owner@example.test");
    const s = now();
    const t = await token(SUB_A, "owner@example.test", { at: s, aal: "aal2", amr: [{ method: "totp", timestamp: s - 10 }, { method: "otp", timestamp: s - 200 }] });
    // The authenticator (freshest) ends at +601 s; the emailed sign-in then still opens the door until its own + 900 s.
    expect((await stateAt(t, s * 1000)).body).toEqual({ fresh: true, freshUntil: (s - 200) * 1000 + DOOR_WINDOW_MS });
    expect(await doorStatus(t, (s - 10 + 700) * 1000, id, "v2")).toBe(200);
  });
  it("the clock is read again after the reads: a proof that expires during them is not fresh", async () => {
    await member(SUB_A, "owner@example.test");
    const s = now();
    const t = await token(SUB_A, "owner@example.test", { at: s, aal: "aal1", amr: [{ method: "otp", timestamp: s - 100 }] });
    const until = (s - 100) * 1000 + DOOR_WINDOW_MS;
    let late = false;
    const db = readOnlyDb([], (sql) => { if (/cloud_stepup_events/.test(sql)) late = true; });
    const w = workerAt(() => (late ? until + 1 : s * 1000));
    const res = await stateOf(await send(w, STATE, bearer(t), baseEnv({ DB: db })));
    expect(late).toBe(true);
    expect(res).toEqual({ status: 200, body: { fresh: false } });
    // Control: the same reads without the clock moving are fresh.
    expect((await stateOf(await send(workerAt(() => s * 1000), STATE, bearer(t)))).body).toEqual({ fresh: true, freshUntil: until });
  });
});

describe("GET /v1/account/step-up/state: no D1 write, even while authenticating (Astra STATUS1 #2)", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const count = async () => JSON.stringify(await Promise.all(["supabase_identities", "user", "cloud_stepup_events", "cloud_stepup_intents"]
    .map((tb) => env.DB.prepare(`SELECT COUNT(*) AS n FROM "${tb}"`).first()))) + JSON.stringify((await env.DB.prepare("SELECT sub,contact_email,email_conflict,email_revision FROM supabase_identities ORDER BY sub").all()).results);
  it("a first-seen subject is {fresh:false}: no account, mapping or audit row is created", async () => {
    await member(SUB_A, "owner@example.test");
    const before = await count();
    const writes: string[] = [];
    const s = now();
    const t = await token(SUB_C, "newcomer@example.test", { at: s, aal: "aal1", amr: [{ method: "otp", timestamp: s - 5 }] });
    const res = await stateOf(await send(workerAt(), STATE, bearer(t), baseEnv({ DB: readOnlyDb(writes) })));
    expect(res).toEqual({ status: 200, body: { fresh: false } });
    expect(writes).toEqual([]);
    expect(await count()).toBe(before);
    // Garbage and a Better Auth style bearer are still 401, and the signature is still checked.
    expect((await send(workerAt(), STATE, bearer("not.a.jwt"), baseEnv({ DB: readOnlyDb(writes) }))).status).toBe(401);
  });
  it("a changed address (reconciliation would write) and a recorded email conflict are {fresh:false} with every write forbidden", async () => {
    const id = await member(SUB_A, "owner@example.test");
    const s = now();
    const before = await count();
    const writes: string[] = [];
    const db = readOnlyDb(writes);
    const moved = await token(SUB_A, "changed@example.test", { at: s, aal: "aal1", amr: [{ method: "otp", timestamp: s - 5 }] });
    expect(await stateOf(await send(workerAt(), STATE, bearer(moved), baseEnv({ DB: db })))).toEqual({ status: 200, body: { fresh: false } });
    await env.DB.prepare("UPDATE supabase_identities SET email_conflict='other@example.test' WHERE user_id=?").bind(id).run();
    const conflicted = await token(SUB_A, "owner@example.test", { at: s, aal: "aal1", amr: [{ method: "otp", timestamp: s - 5 }] });
    expect(await stateOf(await send(workerAt(), STATE, bearer(conflicted), baseEnv({ DB: db })))).toEqual({ status: 200, body: { fresh: false } });
    expect(writes).toEqual([]);
    const row = await env.DB.prepare("SELECT contact_email,email_conflict FROM supabase_identities WHERE user_id=?").bind(id).first();
    expect(row).toEqual({ contact_email: "owner@example.test", email_conflict: "other@example.test" });
    expect(before.length).toBeGreaterThan(0);
  });
});

describe("sales closed: the purchase routes answer 503 before any step-up handling (Astra STATUS1 #6)", () => {
  it("a customer WITHOUT a fresh second step gets 503 sales_closed, not 403 step_up_required, and no step-up intent row is written", async () => {
    await member(SUB_A, "owner@example.test");
    const s = Math.floor(Date.now() / 1000);
    const t = await token(SUB_A, "owner@example.test", { at: s, aal: "aal1", amr: [{ method: "password", timestamp: s - 5 }] });
    const intents = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_stepup_intents").first<{ n: number }>())!.n;
    const post = (path: string, e: Env) => send(workerAt(), `https://auth.murage.test${path}`,
      { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: "{}" }, e);
    for (const path of ["/v1/billing/reserve", "/v1/billing/checkout", "/v1/billing/checkout/resume"]) {
      const closed = await post(path, baseEnv({ ...OPEN_ENV, CLOUD_SALES_OPEN: "false" }));
      expect(closed.status, path).toBe(503);
      expect(await closed.json()).toEqual({ error: "sales_closed" });
    }
    // The closed answers wrote no intent row.
    expect(await intents()).toBe(0);
    // Control: with the switch "true" the same customer is NOT told sales are closed (checkout meets the ordinary step-up refusal, which does write an intent).
    const open = await post("/v1/billing/checkout", baseEnv({ ...OPEN_ENV, CLOUD_SALES_OPEN: "true" }));
    expect(open.status).toBe(403);
    expect(await intents()).toBeGreaterThan(0);
  });
  it("an unauthenticated caller is still 401 first", async () => {
    const res = await send(workerAt(), "https://auth.murage.test/v1/billing/checkout", { method: "POST", body: "{}" }, baseEnv({ ...OPEN_ENV, CLOUD_SALES_OPEN: "false" }));
    expect(res.status).toBe(401);
  });
});

// ---- sales admission against the durable image-policy epoch (KMS design 12.3) ---------------------------------------------------------
describe("sales admission compares the readiness row's epoch with the current durable policy epoch", () => {
  /** The running bundle carries this policy epoch (its readiness rows are stamped with it). */
  const asBundle = (epoch: number) => setImageReadinessForTests({ check: okProbe, bundleEpoch: epoch });
  const bump = (epoch: number) => env.DB.prepare("UPDATE image_policy SET epoch=? WHERE id='current'").bind(epoch).run();
  const paths = ["/v1/billing/reserve", "/v1/billing/checkout", "/v1/billing/checkout/resume"];

  it("interrupted right after the epoch bump, with fresh positive old-bundle readiness: reserve, checkout and resume refuse with the capacity line, and write no step-up intent", async () => {
    await member(SUB_A, "owner@example.test");
    const s = Math.floor(Date.now() / 1000);
    const t = await token(SUB_A, "owner@example.test", { at: s, aal: "aal2", amr: [{ method: "totp", timestamp: s - 5 }] });
    const post = (path: string, e: Env) => send(workerAt(), `https://auth.murage.test${path}`,
      { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: "{}" }, e);
    asBundle(3); await bump(3); // the old bundle (epoch 3) runs with fresh positive readiness at epoch 3
    await bump(4);              // the new bundle's deploy raised the durable epoch, then the upload stalled
    for (const path of paths) {
      const res = await post(path, baseEnv({ ...OPEN_ENV }));
      expect(res.status, path).toBe(503);
      expect(await res.json(), path).toEqual({ error: "sales_closed", notice: CAPACITY_LINE });
    }
    expect(CAPACITY_LINE).toBe("We are adding capacity. Your home will start as soon as it is ready.");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_stepup_intents").first<{ n: number }>())!.n).toBe(0);
    // Control: the new bundle (epoch 4) recomputes the readiness inline: the same customer is no longer held by the epoch.
    asBundle(4);
    const open = await post("/v1/billing/checkout", baseEnv({ ...OPEN_ENV }));
    expect(await open.json()).not.toMatchObject({ notice: CAPACITY_LINE });
  });
  it("each handler checks the epoch itself, before it reads anything of the request (the route gate is not the only guard)", async () => {
    asBundle(3); await bump(3); await bump(4);
    const e = baseEnv({ ...OPEN_ENV });
    const req = () => new Request("https://auth.murage.test/x", { method: "POST", body: "{}" });
    for (const call of [() => createCheckout(req(), e, {} as never, {} as never), () => reserveHomeRoute(req(), e, {} as never, {} as never),
      () => resumeCheckout(req(), e, {} as never, {} as never)]) {
      await expect(call()).rejects.toMatchObject({ status: 503, code: "sales_closed", extra: { notice: CAPACITY_LINE } });
    }
  });
  it("the check itself: a missing row is computed inline; a difference from the durable epoch holds with the capacity notice; an unreadable table holds", async () => {
    asBundle(1);
    await assertImageEpochCurrent(env); // no readiness row: computed inline, stored, admitted
    expect(await env.DB.prepare("SELECT epoch FROM image_readiness").first()).toEqual({ epoch: 1 });
    asBundle(2);
    await assertImageEpochCurrent(env); // a bundle with a new epoch recomputes and raises the durable epoch to its own
    await bump(3);
    await expect(assertImageEpochCurrent(env)).rejects.toMatchObject({ status: 503, code: "sales_closed", extra: { notice: CAPACITY_LINE } });
    await expect(assertImageEpochCurrent({ DB: new Proxy(env.DB, { get(t, p) { if (p === "prepare") return () => { throw new Error("d1 down"); }; const v = Reflect.get(t, p, t); return typeof v === "function" ? v.bind(t) : v; } }) } as never))
      .rejects.toMatchObject({ status: 503, code: "sales_closed" });
  });
});

// ---- CH1: strict switch parsing and invite-only sales --------------------------------------------------------------------------------
// @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
const configSources = import.meta.glob("../src/b5-config.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("CH1: CLOUD_SALES_OPEN is parsed strictly", () => {
  it("\"true\" is open, \"invite\" is invite, \"false\" is shut; unset, empty, other cases, padded and junk values are all SHUT", () => {
    expect(salesMode({ CLOUD_SALES_OPEN: "true" })).toBe("open");
    expect(salesMode({ CLOUD_SALES_OPEN: "invite" })).toBe("invite");
    expect(salesMode({ CLOUD_SALES_OPEN: "false" })).toBe("shut");
    for (const v of [undefined, "", "TRUE", "True", "Invite", "INVITE", " true", "true ", "invite ", "1", "0", "yes", "on", "open", "null", "undefined", "tru", "invited"]) {
      expect(salesMode({ CLOUD_SALES_OPEN: v }), String(v)).toBe("shut");
      expect(salesShut({ CLOUD_SALES_OPEN: v }), String(v)).toBe(true);
      expect(() => assertSalesOpen({ CLOUD_SALES_OPEN: v }), String(v)).toThrow(expect.objectContaining({ status: 503, code: "sales_closed" }));
    }
    expect(salesShut({ CLOUD_SALES_OPEN: "invite" })).toBe(false);
  });
  it("the parser itself changed: the old test (only \"false\" shuts) is gone, so \"invite\" can never be read as open to everyone", () => {
    const text = Object.values(configSources)[0];
    expect(text).toContain("export function salesMode");
    expect(text).not.toMatch(/CLOUD_SALES_OPEN\s*===\s*"false"/);
    // What the old parser did with these two values, and the new one's answer: an unset switch used to be open, "invite" used to be open to all.
    expect(salesMode({})).toBe("shut");
    expect(salesMode({ CLOUD_SALES_OPEN: "invite" })).not.toBe("open");
  });
});

describe("CH1: invite-only sales", () => {
  const INVITE_ENV = { ...OPEN_ENV, CLOUD_SALES_OPEN: "invite" };
  const invite = (email: string, by = "sean") => env.DB.prepare("INSERT INTO sales_invites (email,added_at,added_by,note) VALUES (?,?,?,NULL)").bind(email, 1, by).run();
  /** A DB that records every statement prepared on it. */
  const recording = (seen: string[]) => new Proxy(env.DB, { get(t, p) {
    if (p === "prepare") return (sql: string) => { seen.push(sql); return t.prepare(sql); };
    if (p === "batch" || p === "exec") return () => { seen.push(String(p)); throw new Error("write"); };
    const v = Reflect.get(t, p, t); return typeof v === "function" ? v.bind(t) : v;
  } }) as D1Database;

  it("outside invite mode it does nothing: no lookup, no session read", async () => {
    const seen: string[] = [];
    for (const v of ["true", "false", undefined]) {
      await assertInvited({ CLOUD_SALES_OPEN: v, DB: recording(seen) }, async () => { throw new Error("session read"); });
    }
    expect(seen).toEqual([]);
  });
  it("normalises case and whitespace on both sides, with ONE point lookup by primary key", async () => {
    expect(normalizeInviteEmail("  Owner@Example.TEST \n")).toBe("owner@example.test");
    await invite("owner@example.test");
    const seen: string[] = [];
    await assertInvited({ CLOUD_SALES_OPEN: "invite", DB: recording(seen) }, async () => ({ email: "  Owner@Example.TEST ", emailVerified: true }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^SELECT 1 AS x FROM sales_invites WHERE email=\? LIMIT 1$/);
    // The table refuses an address that is not already normalised, so the two sides can never disagree on form.
    await expect(invite(" Mixed@Example.test")).rejects.toThrow();
    await expect(invite("")).rejects.toThrow();
  });
  it("refuses not_invited: no session, an unverified address, no address, an address not on the list", async () => {
    await invite("owner@example.test");
    const e = { CLOUD_SALES_OPEN: "invite", DB: env.DB };
    for (const u of [null, undefined, { email: "owner@example.test", emailVerified: false }, { email: "owner@example.test" }, { email: "owner@example.test", emailVerified: null },
      { emailVerified: true }, { email: null, emailVerified: true }, { email: "   ", emailVerified: true }, { email: "other@example.test", emailVerified: true },
      { email: "owner@example.org", emailVerified: true }, { email: "wner@example.test", emailVerified: true }]) {
      await expect(assertInvited(e, async () => u), JSON.stringify(u)).rejects.toMatchObject({ status: 403, code: "not_invited" });
    }
    await expect(assertInvited(e, async () => ({ email: "OWNER@example.test", emailVerified: true }))).resolves.toBeUndefined();
  });
  it("each purchase handler refuses an uninvited caller FIRST: the only statement is the invite lookup, and no Stripe or provider fetch happens", async () => {
    const seen: string[] = [];
    const fetched = vi.spyOn(globalThis, "fetch");
    try {
      const e = baseEnv({ ...INVITE_ENV, DB: recording(seen) });
      const deps = { accountUser: async () => ({ id: "u-1", email: "nobody@example.test", emailVerified: true }) } as never;
      const req = () => new Request("https://auth.murage.test/x", { method: "POST", body: "{}" });
      for (const call of [() => createCheckout(req(), e, deps, {} as never), () => reserveHomeRoute(req(), e, deps, {} as never), () => resumeCheckout(req(), e, deps, {} as never)]) {
        await expect(call()).rejects.toMatchObject({ status: 403, code: "not_invited" });
      }
      expect(seen).toHaveLength(3);
      for (const sql of seen) expect(sql).toMatch(/FROM sales_invites WHERE email=\?/);
      expect(fetched).not.toHaveBeenCalled();
    } finally { fetched.mockRestore(); }
  });
  it("the handlers never take the email from the request: a body, query or header naming an invited address does not help", async () => {
    await invite("owner@example.test");
    const e = baseEnv({ ...INVITE_ENV });
    const deps = { accountUser: async () => ({ id: "u-1", email: "nobody@example.test", emailVerified: true }) } as never;
    const req = new Request("https://auth.murage.test/x?email=owner@example.test", { method: "POST", headers: { "x-email": "owner@example.test", "x-forwarded-email": "owner@example.test" },
      body: JSON.stringify({ email: "owner@example.test", emailVerified: true }) });
    await expect(reserveHomeRoute(req, e, deps, {} as never)).rejects.toMatchObject({ status: 403, code: "not_invited" });
  });
  it("through the Worker: an uninvited member gets 403 not_invited on all three purchase routes, before step-up (no intent row), with no Stripe call", async () => {
    await member(SUB_A, "owner@example.test");
    const s = Math.floor(Date.now() / 1000);
    const t = await token(SUB_A, "owner@example.test", { at: s, aal: "aal1", amr: [{ method: "password", timestamp: s - 5 }] });
    const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
    const before = { intents: await count("cloud_stepup_intents"), homes: await count("cloud_homes") };
    const fetched = vi.spyOn(globalThis, "fetch");
    try {
      for (const path of ["/v1/billing/reserve", "/v1/billing/checkout", "/v1/billing/checkout/resume"]) {
        const res = await send(workerAt(), `https://auth.murage.test${path}`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify({ email: "owner@example.test" }) }, baseEnv(INVITE_ENV));
        expect(res.status, path).toBe(403);
        expect(await res.json(), path).toEqual({ error: "not_invited" });
      }
      expect(fetched).not.toHaveBeenCalled();
    } finally { fetched.mockRestore(); }
    expect({ intents: await count("cloud_stepup_intents"), homes: await count("cloud_homes") }).toEqual(before);
  });
  it("through the Worker: once the verified session email is on the list the same member passes the invite gate (and meets the ordinary step-up instead)", async () => {
    await member(SUB_A, "owner@example.test");
    await invite("owner@example.test");
    const s = Math.floor(Date.now() / 1000);
    const t = await token(SUB_A, "owner@example.test", { at: s, aal: "aal1", amr: [{ method: "password", timestamp: s - 5 }] });
    const res = await send(workerAt(), "https://auth.murage.test/v1/billing/checkout", { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: "{}" }, baseEnv(INVITE_ENV));
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).not.toBe("not_invited");
  });
  it("through the Worker: shut stays 503 sales_closed for an invited member, and an unauthenticated caller is still 401 first", async () => {
    await member(SUB_A, "owner@example.test");
    await invite("owner@example.test");
    const s = Math.floor(Date.now() / 1000);
    const t = await token(SUB_A, "owner@example.test", { at: s, aal: "aal1", amr: [{ method: "password", timestamp: s - 5 }] });
    const shut = await send(workerAt(), "https://auth.murage.test/v1/billing/reserve", { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: "{}" }, baseEnv({ ...OPEN_ENV, CLOUD_SALES_OPEN: "false" }));
    expect(shut.status).toBe(503);
    expect((await send(workerAt(), "https://auth.murage.test/v1/billing/reserve", { method: "POST", body: "{}" }, baseEnv(INVITE_ENV))).status).toBe(401);
  });
});

// ---- dark launch: CLOUD_SALES_ALLOWLIST (the signed-in account's email only) -----------------------------------------------------------
describe("dark launch: while sales are shut, only signed-in accounts on CLOUD_SALES_ALLOWLIST may reserve, check out and resume", () => {
  const paths = ["/v1/billing/reserve", "/v1/billing/checkout", "/v1/billing/checkout/resume"];
  const SHUT = { ...OPEN_ENV, CLOUD_SALES_OPEN: "false" };
  async function signedIn(sub: string, email: string) {
    await member(sub, email);
    const s = Math.floor(Date.now() / 1000);
    // aal2 with a trusted, fresh authenticator: the step-up gate passes, so the sales gate is what decides.
    return token(sub, email, { at: s, aal: "aal2", amr: [{ method: "totp", timestamp: s - 5 }] });
  }
  const post = (t: string, path: string, e: Env, body = "{}") => send(workerAt(), `https://auth.murage.test${path}`,
    { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body }, e);
  const answer = async (res: Response) => ({ status: res.status, body: await res.json() });
  const CLOSED = { status: 503, body: { error: "sales_closed" } };

  it("a listed email passes all three exactly as with sales open; upper or mixed case and spaces in the var still match", async () => {
    const t = await signedIn(SUB_A, "owner@example.test");
    for (const list of ["owner@example.test", "  OWNER@Example.Test  ", "other@example.test, Owner@EXAMPLE.test ,,"]) {
      for (const path of paths) {
        const open = await answer(await post(t, path, baseEnv({ ...OPEN_ENV })));
        expect(open, path).not.toEqual(CLOSED);
        expect(await answer(await post(t, path, baseEnv({ ...SHUT, CLOUD_SALES_ALLOWLIST: list }))), `${path} ${list}`).toEqual(open);
      }
    }
  });
  it("an unlisted email gets 503 sales_closed on all three, and an email in the request body never counts", async () => {
    const t = await signedIn(SUB_B, "stranger@example.test");
    const e = baseEnv({ ...SHUT, CLOUD_SALES_ALLOWLIST: "owner@example.test" });
    for (const path of paths) {
      expect(await answer(await post(t, path, e)), path).toEqual(CLOSED);
      expect(await answer(await post(t, path, e, JSON.stringify({ email: "owner@example.test" }))), path).toEqual(CLOSED);
      expect(await answer(await post(t, path, e, JSON.stringify({ user: { email: "owner@example.test" }, accountEmail: "owner@example.test" }))), path).toEqual(CLOSED);
    }
  });
  it("an empty or missing var is exactly today's shut behaviour", async () => {
    const t = await signedIn(SUB_A, "owner@example.test");
    for (const list of [undefined, "", " , ,"]) {
      for (const path of paths) expect(await answer(await post(t, path, baseEnv({ ...SHUT, CLOUD_SALES_ALLOWLIST: list }))), `${path} ${String(list)}`).toEqual(CLOSED);
    }
  });
  it("sales open (\"true\" or \"invite\") ignores the list: an unlisted account is not told sales are closed", async () => {
    const t = await signedIn(SUB_B, "stranger@example.test");
    for (const flag of ["true", "invite"]) {
      for (const path of paths) {
        const res = await answer(await post(t, path, baseEnv({ ...OPEN_ENV, CLOUD_SALES_OPEN: flag, CLOUD_SALES_ALLOWLIST: "owner@example.test" })));
        expect(res, path).not.toEqual(CLOSED);
      }
    }
  });
  it("each handler checks the signed-in account itself (the route gate is not the only guard); a session that cannot be resolved is closed", async () => {
    const e = baseEnv({ ...SHUT, CLOUD_SALES_ALLOWLIST: " Invited@Example.test " });
    const req = (body = "{}") => new Request("https://auth.murage.test/x", { method: "POST", body });
    const as = (user: { id: string; email?: string } | null | "throws") => ({ accountUser: async () => { if (user === "throws") throw new Error("identity down"); return user; } }) as never;
    const gate = async (p: Promise<unknown>) => {
      try { await p; return "passed"; } catch (x) {
        const err = x as { code?: string; extra?: { notice?: string } };
        return err?.code === "sales_closed" && err.extra?.notice === undefined ? "closed" : "passed";
      }
    };
    const handlers = [(d: never, b?: string) => createCheckout(req(b), e, d, {} as never), (d: never, b?: string) => reserveHomeRoute(req(b), e, d, {} as never),
      (d: never, b?: string) => resumeCheckout(req(b), e, d, {} as never)];
    for (const h of handlers) {
      expect(await gate(h(as({ id: "u1", email: "invited@example.test" })))).toBe("passed");
      expect(await gate(h(as({ id: "u1", email: "INVITED@example.TEST" })))).toBe("passed");
      expect(await gate(h(as({ id: "u2", email: "stranger@example.test" })))).toBe("closed");
      expect(await gate(h(as({ id: "u2", email: "stranger@example.test" }), JSON.stringify({ email: "invited@example.test" })))).toBe("closed");
      expect(await gate(h(as({ id: "u3" })))).toBe("closed");
      expect(await gate(h(as(null)))).toBe("closed");
      expect(await gate(h(as("throws")))).toBe("closed");
    }
  });
  it("salesAllowed: open ignores the list; shut needs an exact listed address (trimmed, lowercased; no wildcards or domains)", () => {
    const shut = (list?: string) => ({ CLOUD_SALES_OPEN: "false", CLOUD_SALES_ALLOWLIST: list });
    expect(salesAllowed({ CLOUD_SALES_OPEN: "true" }, null)).toBe(true);
    expect(salesAllowed({ CLOUD_SALES_OPEN: "invite" }, null)).toBe(true);
    expect(salesAllowed({}, null)).toBe(false); // CH1 strict parse: unset is shut
    expect(salesAllowed({ CLOUD_SALES_OPEN: "true", CLOUD_SALES_ALLOWLIST: "a@x.test" }, "b@y.test")).toBe(true);
    expect(salesAllowed(shut("a@x.test"), "a@x.test")).toBe(true);
    expect(salesAllowed(shut(" A@X.Test , b@y.test"), "  a@x.TEST ")).toBe(true);
    expect(salesAllowed(shut("a@x.test"), "b@x.test")).toBe(false);
    expect(salesAllowed(shut("*@x.test"), "a@x.test")).toBe(false);
    expect(salesAllowed(shut("x.test"), "a@x.test")).toBe(false);
    expect(salesAllowed(shut("@x.test"), "a@x.test")).toBe(false);
    expect(salesAllowed(shut("a@x.test"), "a@example.org")).toBe(false);
    expect(salesAllowed(shut(""), "")).toBe(false);
    expect(salesAllowed(shut(","), "")).toBe(false);
    expect(salesAllowed(shut(undefined), "a@x.test")).toBe(false);
    expect(salesAllowed(shut("a@x.test"), undefined)).toBe(false);
    expect(() => assertSalesOpen(shut("a@x.test"), "A@x.test")).not.toThrow();
    expect(() => assertSalesOpen(shut("a@x.test"), "b@x.test")).toThrow();
    expect(() => assertSalesOpen(shut("a@x.test"))).toThrow();
  });
});
