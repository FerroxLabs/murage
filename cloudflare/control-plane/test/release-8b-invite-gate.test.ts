// SPDX-License-Identifier: AGPL-3.0-or-later
// RELEASE 8b merge cut (B1 + ch1 + 8b): CLOUD_SALES_OPEN="invite" still gates EVERY sales route (reserve, checkout, checkout/resume, plan preview, plan)
// with 403 not_invited for an uninvited verified member, even when B1 dark-launch CLOUD_SALES_ALLOWLIST lists that member. Rig copied from charter-ch1-worker.test.ts.
// (was: CH1 through the real Worker fetch handler: the sales switch with the CLOUD_SALES_OPEN binding DELETED (not set to ""), "invite" with an
// uninvited verified session, and the invited positive control. Purchase routes: reserve, checkout, checkout/resume (isPurchaseRoute).
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";

const REF_ORIGIN = "https://testref.supabase.co";
const ISS = `${REF_ORIGIN}/auth/v1`;
const SUB = "7b2e3d40-5c6f-4a71-8bcd-2e3f4a5b6c7d";
const EMAIL = "owner@example.test";
const ROUTES = ["/v1/billing/reserve", "/v1/billing/checkout", "/v1/billing/checkout/resume", "/v1/account/plan/preview", "/v1/account/plan"];

const b64u = (b: ArrayBuffer | string) => Buffer.from(typeof b === "string" ? Buffer.from(b) : new Uint8Array(b)).toString("base64url");
let ec: CryptoKeyPair;
let jwks: { keys: Record<string, unknown>[] };
let signingJwk: JsonWebKey;
beforeAll(async () => {
  ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", ec.publicKey) as Record<string, unknown>), kid: "ec-1", alg: "ES256", use: "sig" }] };
  const b3 = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  signingJwk = await crypto.subtle.exportKey("jwk", b3.privateKey);
});
const factorOf = (sub: string) => `${sub.slice(0, 24)}000000000f01`;
async function token(sub: string, email: string) {
  const at = Math.floor(Date.now() / 1000);
  const c = { iss: ISS, aud: "authenticated", exp: at + 3600, iat: at - 5, sub, email, role: "authenticated", is_anonymous: false,
    app_metadata: { provider: "email", email_verified: true }, user_metadata: {}, session_id: `sess-${sub}`,
    mfa_factor_id: factorOf(sub), aal: "aal1", amr: [{ method: "password", timestamp: at - 5 }] };
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
const workerAt = () => createWorker(fetch, fetch, {}, {}, {}, { jwksFetch, authFetch });

const OPEN_ENV = { CLOUD_B3_MODE: "fake", STRIPE_SECRET_KEY: ["sk_test_", "abcdefgh", "ijklmnop"].join(""), STRIPE_WEBHOOK_SECRET: "whsec_abcdefghij",
  STRIPE_PRICE_STARTER: "price_AAAAAAAA", STRIPE_PRICE_PRO: "price_BBBBBBBB", STRIPE_PRICE_MAX: "price_CCCCCCCC", BILLING_RETURN_ORIGIN: "https://cloud.murage.test",
  REFUND_KEY_SECRET: undefined, CLOUD_KEK_V1: btoa("k".repeat(32)),
  CLOUD_B3_CONFIG: JSON.stringify({ reservationMs: 1_800_000, graceMs: 259_200_000, retentionMs: 2_592_000_000, imageDigest: `sha256:${"a".repeat(64)}`,
    engineSubscriptionGates: { claudeAgent: true, codex: true, grokAgent: true, kimiAgent: true, opencodeGo: true }, quarantineRelayIP: "192.0.2.1", capacity: [] }),
  CLOUD_HOME_HOST_SUFFIX: "murage.test", CLOUD_HOME_ZONE_ID: "0".repeat(32), CLOUD_HOME_ACCOUNT_ID: "0".repeat(32), CLOUD_HOME_API_TOKEN: "test-only-cloud-home-token-no-access" };

/** The rig env with CLOUD_SALES_OPEN set to `mode`, or, when `mode` is "UNSET", with the key REMOVED from the object (not "" and not undefined). */
function envWith(mode: string, db: D1Database = env.DB): Env {
  const e: Record<string, unknown> = { ...env, CLOUD_B3_SIGNING_JWK: JSON.stringify(signingJwk), SUPABASE_URL: REF_ORIGIN,
    SUPABASE_PUBLISHABLE_KEY: ["sb_publi", "shable_t", "estkey_0", "12345678", "9abcdef"].join(""), CLOUD_PLAN_CHANGE: "1", CLOUD_SALES_ALLOWLIST: EMAIL, MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined, ...OPEN_ENV, DB: db };
  if (mode === "UNSET") delete e.CLOUD_SALES_OPEN; else e.CLOUD_SALES_OPEN = mode;
  return e as unknown as Env;
}
/** Records every statement that is not a SELECT/WITH and refuses batch/exec. */
const writeLog = (writes: string[]) => new Proxy(env.DB, { get(t, p) {
  if (p === "prepare") return (sql: string) => { if (!/^\s*(SELECT|WITH)\b/i.test(sql)) writes.push(sql.slice(0, 80)); return t.prepare(sql); };
  if (p === "batch" || p === "exec") return () => { writes.push(String(p)); throw new Error("write"); };
  const v = Reflect.get(t, p, t); return typeof v === "function" ? v.bind(t) : v;
} }) as D1Database;

async function post(path: string, bearerToken: string, e: Env) {
  const ctx = createExecutionContext();
  const res = await workerAt().fetch(new Request(`https://auth.murage.test${path}`, { method: "POST",
    headers: { authorization: `Bearer ${bearerToken}`, "content-type": "application/json" }, body: JSON.stringify(path.endsWith("/preview") ? { plan: "pro" } : path.endsWith("/plan") ? { quoteId: "11111111-1111-4111-8111-111111111111" } : {}) }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
/** First sight of the account (the sign-in's own write), outside the routes under test. */
async function signIn(sub: string, email: string) {
  const t = await token(sub, email);
  const ctx = createExecutionContext();
  const res = await workerAt().fetch(new Request("https://auth.murage.test/v1/account/terms", { headers: { authorization: `Bearer ${t}` } }), envWith("true"), ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return t;
}
const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

describe("release 8b: the invite gate survives the B1 merge on every sales route", () => {
  it("invite mode, uninvited verified member (even listed on CLOUD_SALES_ALLOWLIST): 403 not_invited on reserve, checkout, checkout/resume, plan preview and plan; no write, no fetch", async () => {
    const t = await signIn(SUB, EMAIL);
    expect(await env.DB.prepare("SELECT 1 AS x FROM sales_invites WHERE email=?").bind(EMAIL).first()).toBeNull();
    const before = { intents: await count("cloud_stepup_intents"), homes: await count("cloud_homes"), invites: await count("sales_invites") };
    const fetched = vi.spyOn(globalThis, "fetch");
    try {
      for (const path of ROUTES) {
        const writes: string[] = [];
        const res = await post(path, t, envWith("invite", writeLog(writes)));
        expect(res.status, path).toBe(403);
        expect(await res.json(), path).toEqual({ error: "not_invited" });
        expect(writes, path).toEqual([]);
      }
      expect(fetched).not.toHaveBeenCalled();
    } finally { fetched.mockRestore(); }
    expect({ intents: await count("cloud_stepup_intents"), homes: await count("cloud_homes"), invites: await count("sales_invites") }).toEqual(before);
  });
  it("shut (\"false\") with the member NOT listed stays 503 sales_closed on the three purchase routes; \"invite\" is never read as open to everyone", async () => {
    const t = await signIn(SUB, "other@example.test");
    const e = { ...envWith("false"), CLOUD_SALES_ALLOWLIST: "someone-else@example.test" } as unknown as Env;
    for (const path of ROUTES.slice(0, 3)) {
      const res = await post(path, t, e);
      expect(res.status, path).toBe(503);
      expect(await res.json(), path).toEqual({ error: "sales_closed" });
    }
  });
});
