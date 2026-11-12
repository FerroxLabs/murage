// SPDX-License-Identifier: AGPL-3.0-or-later
// CH1 N1 (Astra r1, round 2); builds on M1's rig. M1 (Astra r1): in invite mode an uninvited caller is refused BEFORE any row is written, including the caller's own first sight (user,
// supabase_identities, account_link_events) and the email reconcile of a changed address. Every table of the database is counted.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";

const REF_ORIGIN = "https://testref.supabase.co";
const ISS = `${REF_ORIGIN}/auth/v1`;
const SUB = "7b2e3d40-5c6f-4a71-8bcd-2e3f4a5b6c7d";
const EMAIL = "owner@example.test";
const ROUTES = ["/v1/billing/reserve", "/v1/billing/checkout", "/v1/billing/checkout/resume"];
const NEW_EMAIL = "moved@example.test";

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
/** Supabase Auth's CURRENT confirmed address, independent of the token's (null: follow the token). */
let authEmail: string | null = null;
/** CH1 P1: when set, the Nth Supabase Auth read answers seq[N] (the last entry for every later read), so a confirmed-address change BETWEEN two reads is exercised. */
let authSeq: string[] | null = null;
let authCalls = 0;
const authFetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
  const bearer = new Headers(init?.headers).get("authorization")!.slice("Bearer ".length);
  const c = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString()) as { sub: string; email: string };
  const answer = authSeq ? authSeq[Math.min(authCalls, authSeq.length - 1)] : (authEmail ?? c.email);
  authCalls++;
  return Response.json({ id: c.sub, email: answer, email_confirmed_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
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
    SUPABASE_PUBLISHABLE_KEY: ["sb_publi", "shable_t", "estkey_0", "12345678", "9abcdef"].join(""), MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined, ...OPEN_ENV, DB: db };
  if (mode === "UNSET") delete e.CLOUD_SALES_OPEN; else e.CLOUD_SALES_OPEN = mode;
  return e as unknown as Env;
}
async function post(path: string, bearerToken: string, e: Env) {
  const ctx = createExecutionContext();
  const res = await workerAt().fetch(new Request(`https://auth.murage.test${path}`, { method: "POST",
    headers: { authorization: `Bearer ${bearerToken}`, "content-type": "application/json" }, body: "{}" }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
async function signIn(sub: string, email: string) {
  const t = await token(sub, email);
  const ctx = createExecutionContext();
  const res = await workerAt().fetch(new Request("https://auth.murage.test/v1/account/terms", { headers: { authorization: `Bearer ${t}` } }), envWith("true"), ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return t;
}
/** Every table's full content, so ANY new or changed row (not only homes and intents) fails the comparison. */
async function snapshot(): Promise<Record<string, unknown[]>> {
  const names = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>()).results;
  const out: Record<string, unknown[]> = {};
  for (const { name } of names) out[name] = (await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results;
  return out;
}

const A = "stored-a@example.test", B = "token-b@example.test", C = "current-c@example.test";
const invite = (email: string) => env.DB.prepare("INSERT INTO sales_invites (email,added_at,added_by,note) VALUES (?,?,?,NULL)").bind(email, 1, "sean").run();

describe("CH1 N1 (Astra r1): the invite check sees the EFFECTIVE confirmed identity before any reconciliation write", () => {
  it("stored A, a still-valid INVITED token for B, current confirmed UNINVITED C: 403 not_invited on every purchase route with zero changed rows in every table", async () => {
    authEmail = null;
    await signIn(SUB, A);                         // the mapping is stored at A
    await invite(B);                              // only B is invited
    const stale = await token(SUB, B);            // a still-valid token that names B
    authEmail = C;                                // Supabase Auth now says C
    const before = await snapshot();
    expect(JSON.stringify(before.supabase_identities)).toContain(A);
    for (const path of ROUTES) {
      const res = await post(path, stale, envWith("invite"));
      expect(res.status, path).toBe(403);
      expect(await res.json(), path).toEqual({ error: "not_invited" });
    }
    expect(await snapshot()).toEqual(before);
  });
  it("control: stored A, token B (invited), current confirmed B (invited): admitted, and only then reconciled to B", async () => {
    authEmail = null;
    await signIn(SUB, A);
    await invite(B);
    const t = await token(SUB, B);
    authEmail = B;
    const res = await post("/v1/billing/reserve", t, envWith("invite"));
    expect((await res.json() as { error?: string }).error).not.toBe("not_invited");
    expect(JSON.stringify((await snapshot()).supabase_identities)).toContain(B);
  });
});

describe("CH1 P1 (Astra r2): admission and reconciliation share ONE Supabase read", () => {
  it("stored A, invited token B, Supabase answers B on the first read and uninvited C on every later one: the identity admission checked (B) is the one written; C is never persisted in any table", async () => {
    authSeq = null; authEmail = null;
    await signIn(SUB, A);
    await invite(B);
    const stale = await token(SUB, B);
    authSeq = [B, C]; authCalls = 0;
    const res = await post("/v1/billing/reserve", stale, envWith("invite"));
    authSeq = null;
    expect((await res.json() as { error?: string }).error).not.toBe("not_invited");
    const after = JSON.stringify(await snapshot());
    expect(after).not.toContain(C);
    expect(JSON.stringify((await snapshot()).supabase_identities)).toContain(B);
  });
  it("control: an invited B that stays B is reconciled to B (one read each, nothing else changes)", async () => {
    authSeq = null; authEmail = null;
    await signIn(SUB, A);
    await invite(B);
    const t = await token(SUB, B);
    authSeq = [B]; authCalls = 0;
    const res = await post("/v1/billing/reserve", t, envWith("invite"));
    authSeq = null;
    expect(res.status).not.toBe(403);
    expect(JSON.stringify((await snapshot()).supabase_identities)).toContain(B);
  });
});
