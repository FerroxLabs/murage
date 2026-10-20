// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud customer identity from the murage.ai members area (Supabase Auth). Real-shaped JWKS and tokens: ES256 (P-256)
// and RS256 keys generated here (RS256 published but never accepted), JWKS served exactly as https://<ref>.supabase.co/auth/v1/.well-known/jwks.json does.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import { resolveCloudAccount, type CurrentUserLoader } from "../src/cloud-accounts";
import { readConfig } from "../src/config";
import { HTTPError } from "../src/http";
import { createWorker } from "../src/index";
import hookSql from "../supabase/custom-access-token-hook.sql?raw";
import {
  JWKS_FAILURE_COOLDOWN_MS, JWKS_TIMEOUT_MS, JwksCache, JwksUnavailable, readSupabaseAuthConfig, stepUpFresh, TokenRejected, verifySupabaseToken,
  type SupabaseAuthConfig,
} from "../src/supabase-jwt";

const REF_ORIGIN = "https://testref.supabase.co";
const PUBLISHABLE = "sb_publishable_testkey_0123456789abcdef";
const ISS = `${REF_ORIGIN}/auth/v1`;
const JWKS_URL = `${ISS}/.well-known/jwks.json`;
const NOW = 1_790_000_000_000;
const nowS = Math.floor(NOW / 1000);
const SUB = "5f0c1b2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";

const b64u = (b: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? Buffer.from(b) : b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");

let ec: CryptoKeyPair; let rsa: CryptoKeyPair; let otherEc: CryptoKeyPair;
let jwks: { keys: Record<string, unknown>[] };
let jwksCalls = 0;
const jwksFetch = (async (input: RequestInfo | URL) => {
  jwksCalls += 1;
  if (String(input) !== JWKS_URL) return new Response("no", { status: 404 });
  return Response.json(jwks);
}) as typeof fetch;

beforeAll(async () => {
  ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  otherEc = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  rsa = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]) as CryptoKeyPair;
  const pub = async (k: CryptoKey) => crypto.subtle.exportKey("jwk", k) as Promise<Record<string, unknown>>;
  // Supabase's published shape: kid, alg, use, key_ops, ext alongside the public parameters.
  jwks = { keys: [
    { ...(await pub(ec.publicKey)), kid: "ec-1", alg: "ES256", use: "sig", key_ops: ["verify"], ext: true },
    { ...(await pub(rsa.publicKey)), kid: "rsa-1", alg: "RS256", use: "sig", key_ops: ["verify"], ext: true },
  ] };
});

interface Claims { [k: string]: unknown }
function claims(over: Claims = {}): Claims {
  return {
    iss: ISS, aud: "authenticated", exp: nowS + 3600, iat: nowS - 5, sub: SUB, email: "pat@example.test", phone: "",
    app_metadata: { provider: "email", providers: ["email"], email_verified: true }, user_metadata: {},
    role: "authenticated", aal: "aal1", amr: [{ method: "password", timestamp: nowS - 60 }], session_id: "0b1c2d3e-aaaa-4bbb-8ccc-123456789abc",
    is_anonymous: false, ...over,
  };
}
async function sign(c: Claims, opts: { kid?: string; alg?: string; key?: CryptoKey; header?: Claims } = {}) {
  const alg = opts.alg ?? "ES256";
  const header = { alg, kid: opts.kid ?? (alg === "RS256" ? "rsa-1" : "ec-1"), typ: "JWT", ...opts.header };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(c))}`;
  const key = opts.key ?? (alg === "RS256" ? rsa.privateKey : ec.privateKey);
  const params = alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };
  return `${input}.${b64u(await crypto.subtle.sign(params, key, new TextEncoder().encode(input)))}`;
}
const config = (): SupabaseAuthConfig => readSupabaseAuthConfig({ ...env, SUPABASE_URL: REF_ORIGIN, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE } as unknown as Env)!;
const verify = (t: string, now = NOW) => verifySupabaseToken(t, config(), new JwksCache(jwksFetch, () => now), now);
async function rejected(t: string) {
  try { await verify(t); } catch (e) { if (e instanceof TokenRejected) return e.reason; throw e; }
  return "accepted";
}

describe("Supabase access-token verification", () => {
  it("accepts real-shaped ES256 tokens and reads sub, email, aal, amr", async () => {
    const es = await verify(await sign(claims()));
    expect(es).toMatchObject({ sub: SUB, email: "pat@example.test", aal: "aal1", sessionId: "0b1c2d3e-aaaa-4bbb-8ccc-123456789abc" });
    expect((await verify(await sign(claims({ email: "Pat@Example.TEST" })))).email).toBe("pat@example.test");
  });

  it("is ES256-only: a validly signed RS256 token is refused before any JWKS lookup (Astra MAKERKIT1 #4)", async () => {
    jwksCalls = 0;
    const cache = new JwksCache(jwksFetch, () => NOW);
    await expect(verifySupabaseToken(await sign(claims(), { alg: "RS256" }), config(), cache, NOW)).rejects.toMatchObject({ reason: "alg_not_allowed" });
    expect(jwksCalls).toBe(0);
    // An ES256 header pointed at the published RSA key is refused too (the key must be EC P-256).
    expect(await rejected(await sign(claims(), { kid: "rsa-1" }))).toBe("key_mismatch");
  });

  it("refuses expired, forged, alg-none, HS256, wrong issuer/audience/role, anonymous and unverified-email tokens", async () => {
    expect(await rejected(await sign(claims({ exp: nowS - 1 })))).toBe("expired");
    expect(await rejected(await sign(claims({ exp: nowS })))).toBe("expired");
    // Forged: signed by a key that is not in the project's JWKS, under a published kid.
    expect(await rejected(await sign(claims(), { key: otherEc.privateKey }))).toBe("bad_signature");
    // Tampered payload, original signature.
    const good = await sign(claims());
    const [h, , s] = good.split(".");
    expect(await rejected(`${h}.${b64u(JSON.stringify(claims({ sub: "someone-else" })))}.${s}`)).toBe("bad_signature");
    // alg none, with and without a signature segment.
    const none = `${b64u(JSON.stringify({ alg: "none", kid: "ec-1" }))}.${b64u(JSON.stringify(claims()))}`;
    expect(await rejected(`${none}.`)).toBe("malformed");
    expect(await rejected(`${none}.AAAA`)).toBe("alg_not_allowed");
    // HS256 (the legacy shared secret) is never accepted, whatever the key.
    const hsKey = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]) as CryptoKey;
    const hsIn = `${b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64u(JSON.stringify(claims()))}`;
    expect(await rejected(`${hsIn}.${b64u(await crypto.subtle.sign("HMAC", hsKey, new TextEncoder().encode(hsIn)))}`)).toBe("alg_not_allowed");
    // Algorithm confusion: an RS256 header pointed at the EC key never reaches the key.
    expect(await rejected(await sign(claims(), { alg: "RS256", kid: "ec-1" }))).toBe("alg_not_allowed");
    expect(await rejected(await sign(claims(), { kid: "nope" }))).toBe("unknown_key");
    expect(await rejected(await sign(claims({ iss: "https://other.supabase.co/auth/v1" })))).toBe("wrong_issuer");
    expect(await rejected(await sign(claims({ aud: "anon" })))).toBe("wrong_audience");
    expect(await rejected(await sign(claims({ role: "service_role" })))).toBe("wrong_role");
    expect(await rejected(await sign(claims({ is_anonymous: true })))).toBe("anonymous");
    expect(await rejected(await sign(claims({ iat: nowS + 120 })))).toBe("not_yet_valid");
    expect(await rejected(await sign(claims({ app_metadata: { provider: "email" } })))).toBe("email_unverified");
    expect(await rejected(await sign(claims({ app_metadata: { email_verified: "true" } })))).toBe("email_unverified");
    // user_metadata is user-writable (auth.updateUser({ data })): it never counts.
    expect(await rejected(await sign(claims({ app_metadata: {}, user_metadata: { email_verified: true } })))).toBe("email_unverified");
    expect(await rejected(await sign(claims({ email: "" })))).toBe("no_email");
    expect(await rejected("not.a.jwt!")).toBe("malformed");
    expect(await rejected(await sign(claims(), { header: { crit: ["exp"] } }))).toBe("malformed");
  });

  it("accepts an aud array that includes authenticated", async () => {
    expect((await verify(await sign(claims({ aud: ["authenticated", "other"] })))).sub).toBe(SUB);
  });

  it("caches the JWKS and refetches an unknown kid at most once a minute", async () => {
    let now = NOW;
    const cache = new JwksCache(jwksFetch, () => now);
    jwksCalls = 0;
    await verifySupabaseToken(await sign(claims()), config(), cache, now);
    await verifySupabaseToken(await sign(claims({ iat: nowS - 1 })), config(), cache, now);
    expect(jwksCalls).toBe(1);
    await expect(verifySupabaseToken(await sign(claims(), { kid: "rotated" }), config(), cache, now)).rejects.toThrow("unknown_key");
    expect(jwksCalls).toBe(1);
    now += 61_000;
    await expect(verifySupabaseToken(await sign(claims({ exp: nowS + 7200 }), { kid: "rotated" }), config(), cache, now)).rejects.toThrow("unknown_key");
    expect(jwksCalls).toBe(2);
  });
});

describe("issuer and JWKS configuration (Astra MAKERKIT1 #5)", () => {
  const cfg = (extra: Record<string, string>) => readSupabaseAuthConfig({ ...env, SUPABASE_URL: REF_ORIGIN, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE, ...extra } as unknown as Env)!;
  it("derives both from the project URL by default", () => {
    expect(cfg({})).toMatchObject({ issuer: ISS, jwksUrl: JWKS_URL });
  });
  it("keeps the project-domain issuer when keys are fetched through a custom domain", async () => {
    const custom = "https://auth.murage.test/auth/v1/.well-known/jwks.json";
    const c = cfg({ SUPABASE_JWKS_URL: custom });
    expect(c).toMatchObject({ issuer: ISS, jwksUrl: custom });
    const seen: string[] = [];
    const f = (async (input: RequestInfo | URL) => { seen.push(String(input)); return Response.json(jwks); }) as typeof fetch;
    expect((await verifySupabaseToken(await sign(claims()), c, new JwksCache(f, () => NOW), NOW)).sub).toBe(SUB);
    expect(seen).toEqual([custom]);
    // A token naming the custom domain as issuer is not the project's issuer: refused.
    await expect(verifySupabaseToken(await sign(claims({ iss: "https://auth.murage.test/auth/v1" })), c, new JwksCache(f, () => NOW), NOW))
      .rejects.toMatchObject({ reason: "wrong_issuer" });
  });
  it("takes an explicit issuer exactly, and refuses non-https or malformed overrides", () => {
    expect(cfg({ SUPABASE_JWT_ISSUER: "https://issuer.murage.test/auth/v1" }).issuer).toBe("https://issuer.murage.test/auth/v1");
    expect(() => cfg({ SUPABASE_JWT_ISSUER: "http://testref.supabase.co/auth/v1" })).toThrow();
    expect(() => cfg({ SUPABASE_JWT_ISSUER: "https://testref.supabase.co" })).toThrow();
    expect(() => cfg({ SUPABASE_JWKS_URL: "https://x.test/jwks?kid=1" })).toThrow();
    expect(() => readSupabaseAuthConfig({ ...env, SUPABASE_URL: "https://auth.murage.test/auth/v1", SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE } as unknown as Env)).toThrow();
  });
});

describe("JWKS transport failures (Astra MAKERKIT1 #8)", () => {
  it("turns a network error into JwksUnavailable, with a timeout signal, and holds off retries for the cooldown", async () => {
    let now = NOW; let calls = 0; let signal: AbortSignal | undefined; let down = true;
    const f = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      calls += 1; signal = init?.signal ?? undefined;
      if (down) throw new TypeError("network connection lost");
      return Response.json(jwks);
    }) as typeof fetch;
    const cache = new JwksCache(f, () => now);
    const t = await sign(claims());
    await expect(verifySupabaseToken(t, config(), cache, now)).rejects.toBeInstanceOf(JwksUnavailable);
    expect(calls).toBe(1);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(JWKS_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    // Within the cooldown: no new fetch, still fails closed.
    down = false;
    now += JWKS_FAILURE_COOLDOWN_MS - 1;
    await expect(verifySupabaseToken(t, config(), cache, now)).rejects.toBeInstanceOf(JwksUnavailable);
    expect(calls).toBe(1);
    now += 2;
    expect((await verifySupabaseToken(t, config(), cache, now)).sub).toBe(SUB);
    expect(calls).toBe(2);
  });
  it("treats a timeout (aborted fetch) and an HTTP error the same way", async () => {
    const aborted = (async () => { throw new DOMException("timed out", "TimeoutError"); }) as typeof fetch;
    await expect(verifySupabaseToken(await sign(claims()), config(), new JwksCache(aborted, () => NOW), NOW)).rejects.toBeInstanceOf(JwksUnavailable);
    const http500 = (async () => new Response("down", { status: 500 })) as typeof fetch;
    await expect(verifySupabaseToken(await sign(claims()), config(), new JwksCache(http500, () => NOW), NOW)).rejects.toBeInstanceOf(JwksUnavailable);
  });
  it("never follows a redirect from the JWKS endpoint: manual mode, and a 3xx is JwksUnavailable (Astra MAKERKIT4 #5)", async () => {
    let redirect: RequestRedirect | undefined;
    const moved = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      redirect = init?.redirect;
      return new Response(null, { status: 302, headers: { location: "https://evil.example/jwks.json" } });
    }) as typeof fetch;
    await expect(verifySupabaseToken(await sign(claims()), config(), new JwksCache(moved, () => NOW), NOW)).rejects.toBeInstanceOf(JwksUnavailable);
    expect(redirect).toBe("manual");
  });
  it("answers 503 identity_unavailable on the worker, never 500", async () => {
    const broken = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    const w = createWorker(fetch, fetch, {}, {}, {}, { jwksFetch: broken, now: () => NOW });
    const ctx = createExecutionContext();
    const res = await w.fetch(new Request("https://auth.murage.test/v1/account/terms", { headers: { authorization: `Bearer ${await sign(claims())}` } }),
      { ...env, SUPABASE_URL: REF_ORIGIN, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE, MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined } as unknown as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect([res.status, await res.json()]).toEqual([503, { error: "identity_unavailable" }]);
  });
});

describe("Custom Access Token Hook SQL (Astra MAKERKIT1 #6)", () => {
  const sql = hookSql.replace(/--.*$/gm, "").replace(/\s+/g, " ").toLowerCase();
  it("ships the function with the schema grant MakerKit needs, execute only for supabase_auth_admin, and no security definer", () => {
    expect(sql).toContain("create or replace function public.custom_access_token_hook(event jsonb)");
    expect(sql).toContain("email_confirmed_at is not null");
    expect(sql).toContain("'{app_metadata,email_verified}'");
    expect(sql).toContain("grant usage on schema public to supabase_auth_admin;");
    expect(sql).toContain("grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;");
    expect(sql).toContain("revoke execute on function public.custom_access_token_hook(jsonb) from public, anon, authenticated;");
    expect(sql).not.toContain("security definer");
    expect(sql).not.toContain("user_metadata");
    expect(hookSql).toContain('uri = "pg-functions://postgres/public/custom_access_token_hook"');
  });
});

describe("step-up freshness (aal2 + amr)", () => {
  const at = async (c: Claims) => stepUpFresh(await verify(await sign(claims(c))), config(), NOW);
  it("needs aal2 from TOTP or a WebAuthn MFA factor proved within 10 minutes", async () => {
    expect(await at({ aal: "aal2", amr: [{ method: "totp", timestamp: nowS - 30 }, { method: "password", timestamp: nowS - 900 }] })).toBe(true);
    expect(await at({ aal: "aal2", amr: [{ method: "mfa/webauthn", timestamp: nowS - 599 }] })).toBe(true);
  });
  it("refuses aal1, a passkey sign-in alone, a stale factor, and SMS or recovery codes", async () => {
    expect(await at({ aal: "aal1", amr: [{ method: "passkey", timestamp: nowS - 5 }] })).toBe(false);
    expect(await at({ aal: "aal1", amr: [{ method: "totp", timestamp: nowS - 5 }] })).toBe(false);
    expect(await at({ aal: "aal2", amr: [{ method: "totp", timestamp: nowS - 601 }, { method: "password", timestamp: nowS - 5 }] })).toBe(false);
    expect(await at({ aal: "aal2", amr: [{ method: "mfa/phone", timestamp: nowS - 5 }] })).toBe(false);
    expect(await at({ aal: "aal2", amr: [{ method: "mfa/recovery-code", timestamp: nowS - 5 }] })).toBe(false);
    expect(await at({ aal: "aal2", amr: [{ method: "totp", timestamp: nowS + 600 }] })).toBe(false);
  });
});

describe("account mapping (no automatic linking)", () => {
  const base = { sub: SUB, email: "pat@example.test", sessionId: "s", aal: "aal1", amr: [], mfaFactorId: null, exp: nowS + 60, iat: nowS };
  const events = async (sub = SUB) => (await env.DB.prepare("SELECT kind,user_id FROM account_link_events WHERE sub=? ORDER BY at, rowid").bind(sub)
    .all<{ kind: string; user_id: string }>()).results;
  /** A Cloud account's stored contact address (its "user".email is synthetic and never a login). */
  const storedEmail = async (id: string) => (await env.DB.prepare("SELECT contact_email AS email FROM supabase_identities WHERE user_id=?").bind(id).first<{ email: string }>())!.email;
  const setStored = (id: string, email: string) => env.DB.prepare("UPDATE supabase_identities SET contact_email=? WHERE user_id=?").bind(email, id).run();
  /** Supabase Auth's answer to GET /auth/v1/user: the member's current confirmed email. */
  const supabaseSays = (email: string, id = SUB): CurrentUserLoader => async () => ({ id, email });
  const notAsked: CurrentUserLoader = async () => { throw new Error("Supabase must not be asked when the token agrees with the stored email"); };
  /** Another CLOUD account holding this contact address. */
  const takenBy = (id: string, email: string) => env.DB.batch([
    env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(id, id, `cloud-${id}@cloud-account.invalid`, NOW, NOW),
    env.DB.prepare("INSERT INTO supabase_identities (sub,user_id,via,created_at,contact_email) VALUES (?,?,'created',?,?)").bind(`sub-${id}`, id, NOW, email),
  ]);
  /** A phone-companion (Better Auth) account with this address: a separate account, never consulted by Cloud. */
  const companion = (id: string, email: string) => env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)')
    .bind(id, id, email, NOW, NOW).run();

  it("creates an account on first use and maps the same sub to it afterwards", async () => {
    const first = await resolveCloudAccount(env.DB, base, NOW, notAsked);
    expect(first).toMatchObject({ email: "pat@example.test", emailVerified: true });
    // The "user" row's email is synthetic and undeliverable: never a Better Auth login. The contact address is separate.
    expect(await env.DB.prepare('SELECT email FROM "user" WHERE id=?').bind(first.id).first()).toEqual({ email: `cloud-${first.id}@cloud-account.invalid` });
    expect(await storedEmail(first.id)).toBe("pat@example.test");
    expect((await resolveCloudAccount(env.DB, base, NOW + 1, notAsked)).id).toBe(first.id);
    expect(await events()).toEqual([{ kind: "created", user_id: first.id }]);
  });

  it("never attaches a new Supabase user to another Cloud account by email, even a verified one (Astra MAKERKIT1 #1)", async () => {
    await takenBy("cloud-pat", "pat@example.test");
    await expect(resolveCloudAccount(env.DB, base, NOW, notAsked)).rejects.toMatchObject({ status: 409, code: "account_email_taken" });
    await expect(resolveCloudAccount(env.DB, { ...base, sub: "other-sub" }, NOW, notAsked)).rejects.toMatchObject({ status: 409, code: "account_email_taken" });
    expect(await events()).toEqual([{ kind: "refused_email_taken", user_id: "cloud-pat" }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM supabase_identities").first<{ n: number }>()).toEqual({ n: 1 });
    // The schema itself has no 'linked' mapping any more.
    await expect(env.DB.prepare("INSERT INTO supabase_identities (sub,user_id,via,created_at) VALUES ('x','cloud-pat','linked',0)").run()).rejects.toThrow();
  });

  it("a phone-companion account with the same email coexists with the Cloud account: no conflict, no link, either order", async () => {
    // Companion first, then the Cloud member signs up with the same address.
    await companion("companion-pat", "pat@example.test");
    const cloud = await resolveCloudAccount(env.DB, base, NOW, notAsked);
    expect(cloud.id).not.toBe("companion-pat");
    expect(cloud.email).toBe("pat@example.test");
    // The Cloud member moves to an address a companion account uses: it moves, no conflict.
    await companion("companion-new", "new@example.test");
    expect((await resolveCloudAccount(env.DB, { ...base, email: "new@example.test" }, NOW, supabaseSays("new@example.test"))).email).toBe("new@example.test");
    expect((await events()).map((e) => e.kind)).toEqual(["created", "email_updated"]);
    // The companion rows are untouched and unlinked.
    expect((await env.DB.prepare('SELECT id,email FROM "user" WHERE id IN (?,?) ORDER BY id').bind("companion-new", "companion-pat").all()).results)
      .toEqual([{ id: "companion-new", email: "new@example.test" }, { id: "companion-pat", email: "pat@example.test" }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM supabase_identities WHERE user_id LIKE 'companion-%'").first()).toEqual({ n: 0 });
  });

  it("follows Supabase's current email, never token order: equal iat in either arrival order ends on the confirmed address (Astra MAKERKIT2 #1)", async () => {
    // Order 1: old@ then new@, both iat=100 (the round-2 reproduction stored old@).
    const a = await resolveCloudAccount(env.DB, { ...base, email: "old@example.test", iat: 100 }, NOW, notAsked);
    expect((await resolveCloudAccount(env.DB, { ...base, email: "new@example.test", iat: 100 }, NOW, supabaseSays("new@example.test"))).email).toBe("new@example.test");
    // The old token, still valid, same iat: Supabase says new@, so nothing changes.
    expect((await resolveCloudAccount(env.DB, { ...base, email: "old@example.test", iat: 100 }, NOW, supabaseSays("new@example.test"))).email).toBe("new@example.test");
    // A LATER-issued token naming a former address changes nothing either: the ordering key is Supabase, not iat.
    expect((await resolveCloudAccount(env.DB, { ...base, email: "old@example.test", iat: 999 }, NOW, supabaseSays("new@example.test"))).email).toBe("new@example.test");
    expect(await storedEmail(a.id)).toBe("new@example.test");
    // Order 2 (another member): new@ then old@, same iat: also ends on Supabase's address.
    const sub2 = "6a1d2c3f-4b5e-4f60-9bac-1d2e3f4a5b6c";
    const b = await resolveCloudAccount(env.DB, { ...base, sub: sub2, email: "b-old@example.test", iat: 50 }, NOW, notAsked);
    expect((await resolveCloudAccount(env.DB, { ...base, sub: sub2, email: "b-new@example.test", iat: 100 }, NOW, supabaseSays("b-new@example.test", sub2))).email).toBe("b-new@example.test");
    expect((await resolveCloudAccount(env.DB, { ...base, sub: sub2, email: "b-old@example.test", iat: 100 }, NOW, supabaseSays("b-new@example.test", sub2))).email).toBe("b-new@example.test");
    expect(await storedEmail(b.id)).toBe("b-new@example.test");
    expect((await events()).map((e) => e.kind)).toEqual(["created", "email_updated"]);
  });

  it("a stale intermediate address left by a concurrent request is corrected by the next request, and a lost compare-and-swap re-reads (Astra MAKERKIT2 #1)", async () => {
    const a = await resolveCloudAccount(env.DB, base, NOW, notAsked);
    // A concurrent request moved the email while this one was asking Supabase: this one's swap (from pat@) must not apply.
    let asked = 0;
    const racing: CurrentUserLoader = async () => {
      asked += 1;
      if (asked === 1) await setStored(a.id, "mid@example.test");
      return { id: SUB, email: "final@example.test" };
    };
    expect((await resolveCloudAccount(env.DB, { ...base, email: "final@example.test" }, NOW, racing)).email).toBe("final@example.test");
    expect(asked).toBe(2); // the loser read Supabase again before writing
    expect(await storedEmail(a.id)).toBe("final@example.test");
    // The round-2 reproduction: an intermediate address is stored and the later token must still be able to correct it.
    await setStored(a.id, "mid@example.test");
    expect((await resolveCloudAccount(env.DB, { ...base, email: "final@example.test", iat: 1 }, NOW, supabaseSays("final@example.test"))).email).toBe("final@example.test");
    // Supabase is the check on the token's id: another user's answer is refused.
    await setStored(a.id, "mid@example.test");
    await expect(resolveCloudAccount(env.DB, { ...base, email: "final@example.test" }, NOW, supabaseSays("final@example.test", "someone-else")))
      .rejects.toMatchObject({ status: 401 });
    // Supabase unreachable or the session gone: the loader's error stands (503 / 401), nothing is written.
    await expect(resolveCloudAccount(env.DB, { ...base, email: "final@example.test" }, NOW, async () => { throw new HTTPError(503, "identity_unavailable"); }))
      .rejects.toMatchObject({ status: 503 });
    expect(await storedEmail(a.id)).toBe("mid@example.test");
  });

  it("an email conflict is persisted: every token for that member is refused, the former address included, until it clears (Astra MAKERKIT2 #2)", async () => {
    const a = await resolveCloudAccount(env.DB, base, NOW, notAsked);
    await takenBy("taken", "taken@example.test");
    const nowTaken = supabaseSays("taken@example.test");
    await expect(resolveCloudAccount(env.DB, { ...base, email: "taken@example.test" }, NOW, nowTaken))
      .rejects.toMatchObject({ status: 409, code: "account_email_conflict" });
    expect(await env.DB.prepare("SELECT email_conflict AS c FROM supabase_identities WHERE sub=?").bind(SUB).first()).toEqual({ c: "taken@example.test" });
    // The round-2 reproduction: a still-valid token for the FORMER address used to resolve. Now it is refused too.
    await expect(resolveCloudAccount(env.DB, base, NOW, nowTaken)).rejects.toMatchObject({ status: 409, code: "account_email_conflict" });
    expect(await storedEmail(a.id)).toBe("pat@example.test");
    expect((await events()).map((e) => e.kind)).toEqual(["created", "email_conflict"]); // logged once, refused every time
    // Sean frees the address: the next request moves the email and clears the conflict in one transaction.
    await env.DB.batch([env.DB.prepare("DELETE FROM supabase_identities WHERE user_id=?").bind("taken"), env.DB.prepare('DELETE FROM "user" WHERE id=?').bind("taken")]);
    expect((await resolveCloudAccount(env.DB, base, NOW, nowTaken)).email).toBe("taken@example.test");
    expect(await env.DB.prepare("SELECT email_conflict AS c FROM supabase_identities WHERE sub=?").bind(SUB).first()).toEqual({ c: null });
    // Or the member changes back to the stored address: the conflict clears without a move.
    await takenBy("other", "other@example.test");
    await expect(resolveCloudAccount(env.DB, { ...base, email: "other@example.test" }, NOW, supabaseSays("other@example.test"))).rejects.toMatchObject({ status: 409 });
    expect((await resolveCloudAccount(env.DB, { ...base, email: "taken@example.test" }, NOW, supabaseSays("taken@example.test"))).email).toBe("taken@example.test");
    expect((await events()).map((e) => e.kind)).toEqual(["created", "email_conflict", "email_updated", "email_conflict", "email_conflict_cleared"]);
  });

  it("one revision covers email and conflict: an address changed away and back is not overwritten by a delayed answer (Astra MAKERKIT4 #3)", async () => {
    const a = await resolveCloudAccount(env.DB, { ...base, email: "old@example.test" }, NOW, notAsked);
    // The delayed request holds a token naming mid@ and reads stored old@. While it waits on Supabase, other requests
    // move the address to final@ and back to old@. Supabase's (stale) answer to the delayed request is mid@.
    let asked = 0;
    const delayed: CurrentUserLoader = async () => {
      asked += 1;
      if (asked === 1) {
        await resolveCloudAccount(env.DB, { ...base, email: "final@example.test" }, NOW, supabaseSays("final@example.test"));
        await resolveCloudAccount(env.DB, { ...base, email: "old@example.test" }, NOW, supabaseSays("old@example.test"));
        return { id: SUB, email: "mid@example.test" };
      }
      return { id: SUB, email: "old@example.test" }; // asked again: Supabase's current answer
    };
    expect((await resolveCloudAccount(env.DB, { ...base, email: "mid@example.test" }, NOW, delayed)).email).toBe("old@example.test");
    expect(asked).toBe(2);
    expect(await storedEmail(a.id)).toBe("old@example.test");
    // So a token naming mid@ is still reconciled (Supabase is asked), never accepted as stored.
    let checked = false;
    await resolveCloudAccount(env.DB, { ...base, email: "mid@example.test" }, NOW, async () => { checked = true; return { id: SUB, email: "old@example.test" }; });
    expect(checked).toBe(true);
    expect((await env.DB.prepare("SELECT email_revision AS r FROM supabase_identities WHERE sub=?").bind(SUB).first<{ r: number }>())!.r).toBe(2);
  });

  it("a delayed conflict clear cannot erase a newer conflict (Astra MAKERKIT4 #3)", async () => {
    await resolveCloudAccount(env.DB, { ...base, email: "old@example.test" }, NOW, notAsked);
    await takenBy("t1", "taken@example.test");
    await takenBy("t2", "taken2@example.test");
    await expect(resolveCloudAccount(env.DB, { ...base, email: "taken@example.test" }, NOW, supabaseSays("taken@example.test")))
      .rejects.toMatchObject({ status: 409, code: "account_email_conflict" });
    // The delayed request saw the earlier conflict and gets Supabase's stale old@ (which would clear it). Meanwhile another
    // request records the newer taken2@ conflict.
    let asked = 0;
    const delayed: CurrentUserLoader = async () => {
      asked += 1;
      if (asked === 1) {
        await expect(resolveCloudAccount(env.DB, { ...base, email: "taken2@example.test" }, NOW, supabaseSays("taken2@example.test")))
          .rejects.toMatchObject({ status: 409 });
        return { id: SUB, email: "old@example.test" };
      }
      return { id: SUB, email: "taken2@example.test" };
    };
    await expect(resolveCloudAccount(env.DB, { ...base, email: "old@example.test" }, NOW, delayed)).rejects.toMatchObject({ status: 409, code: "account_email_conflict" });
    expect(asked).toBe(2);
    expect(await env.DB.prepare("SELECT email_conflict AS c FROM supabase_identities WHERE sub=?").bind(SUB).first()).toEqual({ c: "taken2@example.test" });
    // The next former-address token is still refused (Supabase is asked; nothing was cleared).
    await expect(resolveCloudAccount(env.DB, { ...base, email: "old@example.test" }, NOW, supabaseSays("taken2@example.test")))
      .rejects.toMatchObject({ status: 409 });
    expect((await events()).map((e) => e.kind)).toEqual(["created", "email_conflict", "email_conflict"]);
  });

  it("gives up with 503 after three lost rounds, never writing on a stale read (Astra MAKERKIT4 #3)", async () => {
    const a = await resolveCloudAccount(env.DB, { ...base, email: "old@example.test" }, NOW, notAsked);
    let asked = 0;
    const alwaysRaced: CurrentUserLoader = async () => {
      asked += 1;
      await env.DB.prepare("UPDATE supabase_identities SET email_revision=email_revision+1 WHERE sub=?").bind(SUB).run();
      return { id: SUB, email: "new@example.test" };
    };
    await expect(resolveCloudAccount(env.DB, { ...base, email: "new@example.test" }, NOW, alwaysRaced)).rejects.toMatchObject({ status: 503 });
    expect(asked).toBe(3);
    expect(await storedEmail(a.id)).toBe("old@example.test");
  });

  it("a phone-companion email-code sign-in with a Cloud member's address signs in its OWN account, never the Cloud one", async () => {
    const cloud = await resolveCloudAccount(env.DB, base, NOW, notAsked);
    const ctx = createExecutionContext();
    const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
    const otp = await auth.api.createVerificationOTP({ body: { email: "pat@example.test", type: "sign-in" } });
    await waitOnExecutionContext(ctx);
    const ctx2 = createExecutionContext();
    const res = await createWorker(fetch, fetch).fetch(new Request("https://auth.murage.test/api/auth/sign-in/email-otp", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "pat@example.test", otp }),
    }), env, ctx2);
    await waitOnExecutionContext(ctx2);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-auth-token")).toBeTruthy();
    const { user } = await res.json<{ user: { id: string; email: string } }>();
    expect(user.id).not.toBe(cloud.id);
    expect(user.email).toBe("pat@example.test");
    // No session for the Cloud account, and the Cloud account is unchanged (no conflict, no link).
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "session" WHERE "userId"=?').bind(cloud.id).first()).toEqual({ n: 0 });
    expect((await resolveCloudAccount(env.DB, base, NOW, notAsked)).id).toBe(cloud.id);
    expect(await env.DB.prepare("SELECT email_conflict AS c FROM supabase_identities WHERE sub=?").bind(SUB).first()).toEqual({ c: null });
  });
});

describe("Cloud customer routes on the worker", () => {
  // Supabase Auth's GET /auth/v1/user, as the project answers it.
  let supabaseUser: { status: number; body?: Record<string, unknown> } | "down" = { status: 200, body: {} };
  const userCalls: { url: string; apikey: string | null; authorization: string | null }[] = [];
  const authFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    userCalls.push({ url: String(input), apikey: h.get("apikey"), authorization: h.get("authorization") });
    if (supabaseUser === "down") throw new TypeError("network");
    return Response.json(supabaseUser.body ?? {}, { status: supabaseUser.status });
  }) as typeof fetch;
  const worker = createWorker(fetch, fetch, {}, {}, {}, { jwksFetch, authFetch, now: () => NOW });
  const supaEnv = (extra: Record<string, string> = {}) =>
    ({ ...env, SUPABASE_URL: REF_ORIGIN, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE, MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined, ...extra }) as unknown as Env;
  async function call(path: string, token: string | null, opts: { body?: unknown; env?: Env } = {}) {
    const headers = new Headers();
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`https://auth.murage.test${path}`, {
      method: opts.body === undefined ? "GET" : "POST", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }), opts.env ?? supaEnv(), ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  /** The member's TOTP factor, trusted and out of its hold (trusted-factors.ts): only its proof counts for step-up. */
  const FACTOR = "7d3e0c1a-1111-4222-8333-944455566677";
  async function trustFactor(sub = SUB, factorId = FACTOR, usableAt = 0) {
    expect((await call("/v1/account/terms", await sign(claims({ sub })))).status).toBe(200);
    const { user_id } = (await env.DB.prepare("SELECT user_id FROM supabase_identities WHERE sub=?").bind(sub).first<{ user_id: string }>())!;
    await env.DB.prepare("INSERT INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state) VALUES (?,?,'totp','email_code',0,?,'active')")
      .bind(user_id, factorId, usableAt).run();
    // ...and Supabase still lists it as verified (the gate asks: Astra MAKERKIT8 #2).
    supabaseUser = { status: 200, body: { id: sub, email: claims({ sub }).email, email_confirmed_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
      factors: [{ id: factorId, factor_type: "totp", status: "verified" }] } };
    return user_id;
  }

  it("reconciles an email change with Supabase Auth's current user, sending the token and the publishable key (Astra MAKERKIT2 #1)", async () => {
    userCalls.length = 0;
    expect((await call("/v1/account/terms", await sign(claims()))).status).toBe(200);
    expect(userCalls).toHaveLength(0); // the token agrees with the stored email: Supabase is not asked
    const confirmed = { id: SUB, email: "New@Example.test", email_confirmed_at: "2026-10-10T00:00:00Z" };
    supabaseUser = { status: 200, body: confirmed };
    const changed = await sign(claims({ email: "new@example.test" }));
    expect((await call("/v1/account/terms", changed)).status).toBe(200);
    expect(userCalls).toEqual([{ url: `${REF_ORIGIN}/auth/v1/user`, apikey: PUBLISHABLE, authorization: `Bearer ${changed}` }]);
    expect(await env.DB.prepare("SELECT contact_email AS email FROM supabase_identities WHERE sub=?").bind(SUB).first())
      .toEqual({ email: "new@example.test" });
    // The former address's token, still unexpired: Supabase says new@, nothing moves back.
    expect((await call("/v1/account/terms", await sign(claims()))).status).toBe(200);
    expect(await env.DB.prepare("SELECT contact_email AS email FROM supabase_identities WHERE sub=?").bind(SUB).first())
      .toEqual({ email: "new@example.test" });
    // A session Supabase no longer honours is 401; Supabase unreachable or erroring is 503 identity_unavailable (retryable); an
    // unconfirmed email is 401. Never 500.
    const stale = await sign(claims());
    for (const [answer, status] of [[{ status: 403 }, 401], [{ status: 500 }, 503], ["down", 503],
      [{ status: 200, body: { ...confirmed, email: "pat@example.test", email_confirmed_at: null } }, 401]] as const) {
      supabaseUser = answer as typeof supabaseUser;
      const res = await call("/v1/account/terms", stale);
      expect([JSON.stringify(answer), res.status]).toEqual([JSON.stringify(answer), status]);
    }
    supabaseUser = { status: 200, body: {} };
  });

  it("asks Supabase Auth with redirect manual and refuses a redirect as 503, never following it with the token (Astra MAKERKIT4 #5)", async () => {
    expect((await call("/v1/account/terms", await sign(claims()))).status).toBe(200);
    const modes: (RequestRedirect | undefined)[] = [];
    const redirecting = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      modes.push(init?.redirect);
      return new Response(null, { status: 307, headers: { location: "https://evil.example/auth/v1/user" } });
    }) as typeof fetch;
    const w = createWorker(fetch, fetch, {}, {}, {}, { jwksFetch, authFetch: redirecting, now: () => NOW });
    const ctx = createExecutionContext();
    const res = await w.fetch(new Request("https://auth.murage.test/v1/account/terms", { headers: { authorization: `Bearer ${await sign(claims({ email: "new@example.test" }))}` } }), supaEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([503, "identity_unavailable"]);
    expect(modes).toEqual(["manual"]);
  });

  it("needs the project's publishable key, and refuses a secret or service_role key in its place", async () => {
    const t = await sign(claims());
    const serviceRoleJwt = `${b64u(JSON.stringify({ alg: "HS256" }))}.${b64u(JSON.stringify({ role: "service_role", iss: "supabase" }))}.c2lnbmF0dXJl`;
    for (const key of ["", "sb_secret_0123456789abcdefghij", serviceRoleJwt]) {
      const res = await call("/v1/account/terms", t, { env: supaEnv({ SUPABASE_PUBLISHABLE_KEY: key }) });
      expect([key.slice(0, 10), res.status, (await res.json<{ error: string }>()).error]).toEqual([key.slice(0, 10), 503, "customer_auth_misconfigured"]);
    }
  });

  it("signs the customer in from the members-area token and creates their account", async () => {
    expect((await call("/v1/account/terms", await sign(claims()))).status).toBe(200);
    expect(await env.DB.prepare("SELECT via FROM supabase_identities WHERE sub=?").bind(SUB).first()).toEqual({ via: "created" });
  });

  it("answers 401 for missing, expired, forged and unverified-email tokens", async () => {
    expect((await call("/v1/account/terms", null)).status).toBe(401);
    expect((await call("/v1/account/terms", await sign(claims({ exp: nowS - 10 })))).status).toBe(401);
    expect((await call("/v1/account/terms", await sign(claims(), { key: otherEc.privateKey }))).status).toBe(401);
    expect((await call("/v1/account/terms", await sign(claims({ app_metadata: {} })))).status).toBe(401);
    expect((await call("/v1/account/terms", await sign(claims({ aud: "anon" })))).status).toBe(401);
  });

  it("refuses aal1 and a stale second factor on money routes, and lets a fresh aal2 through the gate", async () => {
    const aal1 = await sign(claims({ amr: [{ method: "passkey", timestamp: nowS - 5 }] }));
    const stale = await sign(claims({ aal: "aal2", amr: [{ method: "totp", timestamp: nowS - 1200 }] }));
    const fresh = await sign(claims({ aal: "aal2", amr: [{ method: "totp", timestamp: nowS - 60 }, { method: "password", timestamp: nowS - 3000 }], mfa_factor_id: FACTOR }));
    await trustFactor();
    for (const [path, body] of [["/v1/billing/portal", {}], ["/v1/account/export-request", {}],
      ["/v1/billing/checkout/resume", {}], ["/v1/account/plan", { plan: "pro", expectedAmountCents: 0 }],
      ["/v1/billing/checkout", { plan: "pro" }], ["/v1/account/topup", { enabled: true, amountUsd: 10, thresholdUsd: 5, capUsd: 50 }]] as const) {
      for (const token of [aal1, stale]) {
        const res = await call(path, token, { body });
        expect([path, res.status, (await res.json<{ error: string }>()).error]).toEqual([path, 403, "step_up_required"]);
      }
      const res = await call(path, stale, { body });
      // The purchase routes also say the first-purchase bootstrap does not apply (this account has a trusted factor: purchase-bootstrap.ts).
      const purchase = path === "/v1/billing/checkout" || path === "/v1/billing/checkout/resume";
      expect(await res.json()).toEqual({ error: "step_up_required",
        step_up: { reason: "stale", methods: ["totp", "email_code"], max_age_seconds: 600, verified_at: nowS - 1200, ...(purchase ? { bootstrap: false } : {}),
          email_code: { available: true, digits: 6, ttl_seconds: 600, grant_ttl_seconds: 600, intent_id: expect.stringMatching(/^si_[0-9a-f]{32}$/) } } });
      const ok = await call(path, fresh, { body });
      expect([path, ok.status === 401 || ok.status === 403 || (await ok.clone().json<{ error?: string }>()).error === "identity_unavailable"]).toEqual([path, false]);
    }
    expect((await call("/v1/billing/portal", null, { body: {} })).status).toBe(401);
  });

  it("journey A3: a top-up change that only switches off or lowers needs sign-in only (aal1); an enable or a raise keeps the step-up", async () => {
    const aal1 = await sign(claims({ amr: [{ method: "password", timestamp: nowS - 5 }] }));
    const userId = await trustFactor();
    const topupRow = (enabled: number) => env.DB.prepare(`INSERT OR REPLACE INTO topup_settings (home_id,user_id,enabled,amount_cents,threshold_cents,cap_cents,cap_period,cap_resets,consent_id,updated_at)
      VALUES ('home-a3',?,?,2000,500,10000,'calendar_month','00:00 UTC on the first day of each month',NULL,1)`).bind(userId, enabled).run();
    await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,entitlement,image_digest,home_key,created_at,updated_at)
      VALUES ('home-a3','inst-a3',?,'ready','ready','paid','sha256:x','k',1,1)`).bind(userId).run();
    const post = async (body: unknown) => { const r = await call("/v1/account/topup", aal1, { body }); return [r.status, (await r.clone().json<{ error?: string }>()).error ?? null] as const; };
    const refused = [403, "step_up_required"];
    await topupRow(1);
    expect(await post({ enabled: true, amountUsd: 25, thresholdUsd: 5, capUsd: 100 })).toEqual(refused); // raises the amount
    expect(await post({ enabled: true, amountUsd: 20, thresholdUsd: 6, capUsd: 100 })).toEqual(refused); // raises the threshold
    expect(await post({ enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 101 })).toEqual(refused); // raises the cap
    expect(await post({ enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100, homeId: "home-other" })).toEqual(refused); // not their home
    expect((await post({ enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100, extra: 1 }))[0]).toBe(403); // a crafted body
    // Each step is no higher than the one before it (the handler stores each change, so "today" moves down with them).
    for (const lower of [{ enabled: true, amountUsd: 15, thresholdUsd: 5, capUsd: 100 }, { enabled: true, amountUsd: 15, thresholdUsd: 3, capUsd: 80 },
      { enabled: true, amountUsd: 15, thresholdUsd: 3, capUsd: 80 }, { enabled: false, amountUsd: 20, thresholdUsd: 5, capUsd: 100 }]) {
      const [status, error] = await post(lower);
      expect([lower, status, error]).toEqual([lower, 200, null]);
    }
    // Now it is off: switching it on again (even with the same numbers) is an increase of spending and needs the second factor.
    await topupRow(0);
    expect(await post({ enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100 })).toEqual(refused);
    expect(await post({ enabled: true, amountUsd: 5, thresholdUsd: 1, capUsd: 5 })).toEqual(refused);
    expect((await post({ enabled: false, amountUsd: 20, thresholdUsd: 5, capUsd: 100 }))[0]).toBe(200);
    // No home: nothing to compare with, so nothing is exempt.
    await env.DB.prepare("DELETE FROM cloud_homes WHERE id='home-a3'").run();
    expect(await post({ enabled: false, amountUsd: 20, thresholdUsd: 5, capUsd: 100 })).toEqual(refused);
  });

  it("lets cancel and withdraw through with sign-in only (aal1, no step-up; Sean 2026-10-10)", async () => {
    const aal1 = await sign(claims({ amr: [{ method: "password", timestamp: nowS - 3000 }] }));
    for (const [path, body] of [["/v1/account/cancel-plan", {}], ["/v1/account/withdraw", { confirm: true }]] as const) {
      const res = await call(path, aal1, { body });
      const code = (await res.json<{ error?: string }>()).error;
      expect([path, res.status === 401 || code === "step_up_required"]).toEqual([path, false]);
    }
  });

  it("tells the members area what a step-up needs: aal1 (no factor this session) vs stale (re-verify while aal2), on checkout too (Astra MAKERKIT1 #3); reserve is sign-in only", async () => {
    // An account with something to protect (a trusted factor here): a fresh account's first purchase is the bootstrap path instead
    // (test/purchase-bootstrap.test.ts), and every refusal on a purchase route says so (bootstrap: false).
    await trustFactor();
    const aal1 = await sign(claims({ amr: [{ method: "password", timestamp: nowS - 5 }] }));
    const r1 = await call("/v1/billing/checkout", aal1, { body: { plan: "pro" } });
    expect([r1.status, await r1.json()]).toEqual([403, { error: "step_up_required",
      step_up: { reason: "aal1", methods: ["totp", "email_code"], max_age_seconds: 600, verified_at: null, bootstrap: false,
        email_code: { available: true, digits: 6, ttl_seconds: 600, grant_ttl_seconds: 600, intent_id: expect.stringMatching(/^si_[0-9a-f]{32}$/) } } }]);
    const stale = await sign(claims({ aal: "aal2", amr: [{ method: "totp", timestamp: nowS - 601 }] }));
    const r2 = await call("/v1/billing/checkout", stale, { body: { plan: "pro" } });
    expect([r2.status, await r2.json()]).toEqual([403, { error: "step_up_required",
      step_up: { reason: "stale", methods: ["totp", "email_code"], max_age_seconds: 600, verified_at: nowS - 601, bootstrap: false,
        email_code: { available: true, digits: 6, ttl_seconds: 600, grant_ttl_seconds: 600, intent_id: expect.stringMatching(/^si_[0-9a-f]{32}$/) } } }]);
    // An SMS factor raises the session to aal2 but is not accepted: still "stale" with no accepted proof.
    const sms = await sign(claims({ aal: "aal2", amr: [{ method: "mfa/phone", timestamp: nowS - 5 }] }));
    expect(await (await call("/v1/billing/checkout", sms, { body: { plan: "pro" } })).json())
      .toMatchObject({ step_up: { reason: "stale", verified_at: null, bootstrap: false } });
    const staleTrusted = await sign(claims({ aal: "aal2", amr: [{ method: "totp", timestamp: nowS - 601 }], mfa_factor_id: FACTOR }));
    const cfgd = await call("/v1/billing/checkout", staleTrusted, { body: { plan: "pro" }, env: supaEnv({ CLOUD_STEPUP_MAX_AGE_SECONDS: "900" }) });
    // A longer configured window lets the same token through the gate.
    expect((await cfgd.json<{ error?: string }>()).error).not.toMatch(/step_up_required|identity_unavailable/);
    // Reserve is sign-in only (one purchase = at most one emailed code, asked at checkout): never a step-up refusal.
    expect((await (await call("/v1/billing/reserve", aal1, { body: {} })).json<{ error?: string }>()).error).not.toBe("step_up_required");
  });

  it("retires the old portal 2FA routes for good", async () => {
    expect((await call("/v1/account/2fa", await sign(claims()))).status).toBe(410);
    expect((await call("/v1/account/2fa", await sign(claims()), { env: supaEnv({ CLOUD_LEGACY_CUSTOMER_AUTH: "1" }) })).status).toBe(410);
  });

  it("answers 503 when SUPABASE_URL is unset, and the retired legacy switch changes nothing", async () => {
    const noSupa = { ...env, MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined } as unknown as Env;
    expect((await call("/v1/account/terms", await sign(claims()), { env: noSupa })).status).toBe(503);
    expect((await call("/v1/account/terms", await sign(claims()), { env: supaEnv({ CLOUD_LEGACY_CUSTOMER_AUTH: "1" }) })).status).toBe(200);
  });

  /** A phone-companion (Better Auth email-code) session for this address, as the desktop gets it. */
  async function companionToken(email: string) {
    const ctx = createExecutionContext();
    const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
    const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
    await waitOnExecutionContext(ctx);
    const ctx2 = createExecutionContext();
    const res = await worker.fetch(new Request("https://auth.murage.test/api/auth/sign-in/email-otp", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, otp }),
    }), supaEnv(), ctx2);
    await waitOnExecutionContext(ctx2);
    const token = res.headers.get("set-auth-token");
    if (!token) throw new Error(`no companion token (${res.status})`);
    return { token, id: (await res.json<{ user: { id: string } }>()).user.id };
  }
  async function send(method: string, path: string, token: string, env2: Env = supaEnv(), body = "{}") {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`https://auth.murage.test${path}`, { method, headers: { authorization: `Bearer ${token}`,
      "content-type": "application/json" }, body: method === "GET" || method === "DELETE" ? undefined : body }), env2, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }
  const CLOUD_ROUTES: readonly (readonly [string, string])[] = [
    ["GET", "/v1/account/cloud"], ["GET", "/v1/account/confirmation"], ["GET", "/v1/account/terms"], ["GET", "/v1/account/topup"],
    ["POST", "/v1/account/terms/accept"], ["POST", "/v1/account/export-request"], ["POST", "/v1/account/cancel-plan"], ["POST", "/v1/account/withdraw"],
    ["POST", "/v1/account/topup"], ["POST", "/v1/account/homes/home-x/desktop-code"],
    ["POST", "/v1/billing/reserve"], ["POST", "/v1/billing/checkout"], ["POST", "/v1/billing/portal"], ["POST", "/v1/legal/quote"],
    ["GET", "/v1/homes"], ["POST", "/v1/homes/home-x/pairing/start"], ["POST", "/v1/homes/home-x/pairing/code"], ["POST", "/v1/homes/home-x/pairing/device"],
  ];
  /** A well-formed body where a route validates before it authenticates, so the 401 is the identity's, not the body's. */
  const VALID_BODY: Record<string, unknown> = { "/v1/account/withdraw": { confirm: true }, "/v1/legal/quote": { plan: "pro", country: "US" } };
  const COMPANION_ROUTES: readonly (readonly [string, string])[] = [
    ["GET", "/v1/me"], ["GET", "/v1/installations"], ["POST", "/v1/installations"],
    ["POST", "/v1/installations/inst-x/credentials/rotate"], ["DELETE", "/v1/installations/inst-x"],
  ];

  it("route scope: a Better Auth (companion) session never reaches a Cloud route, also for the Cloud member's own address", async () => {
    const cloud = await sign(claims());
    expect((await call("/v1/account/terms", cloud)).status).toBe(200); // the Cloud account exists, same address
    const companion = await companionToken("pat@example.test");
    for (const [method, path] of CLOUD_ROUTES) {
      for (const e of [supaEnv(), supaEnv({ CLOUD_LEGACY_CUSTOMER_AUTH: "1" })]) {
        const res = await send(method, path, companion.token, e, JSON.stringify(VALID_BODY[path] ?? {}));
        // Always 401: the caller is authenticated before any config or body check (Astra MAKERKIT7 #1).
        expect([method, path, res.status, (await res.json<{ error: string }>()).error]).toEqual([method, path, 401, "unauthorized"]);
      }
    }
    // The companion session itself works where it belongs.
    expect((await send("GET", "/v1/me", companion.token)).status).toBe(200);
    expect((await send("GET", "/v1/installations", companion.token)).status).toBe(200);
  });

  it("every Cloud route authenticates before any config or body check: billing disabled or misconfigured, any body, still 401 (Astra MAKERKIT7 #1)", async () => {
    const companion = await companionToken("pat@example.test");
    const ROUTES = [...CLOUD_ROUTES, ["GET", "/v1/account/mfa/factors"], ["POST", "/v1/account/mfa/trust-code"], ["POST", "/v1/account/mfa/trust"]] as const;
    const disabled = supaEnv({ STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined } as unknown as Record<string, string>);
    const misconfigured = supaEnv({ STRIPE_SECRET_KEY: "not-a-key", STRIPE_WEBHOOK_SECRET: "not-a-secret" });
    for (const e of [disabled, misconfigured]) {
      for (const [method, path] of ROUTES) {
        for (const bearer of [companion.token, "not-a-jwt.at-all", null]) {
          for (const body of [undefined, "not json", "{}"]) {
            const ctx = createExecutionContext();
            const headers = new Headers();
            if (bearer) headers.set("authorization", `Bearer ${bearer}`);
            // No content type on purpose for the non-JSON body: the 415 must not come first either.
            if (body === "{}") headers.set("content-type", "application/json");
            const res = await worker.fetch(new Request(`https://auth.murage.test${path}`, { method, headers,
              body: method === "GET" ? undefined : body }), e, ctx);
            await waitOnExecutionContext(ctx);
            expect([method, path, bearer?.slice(0, 8) ?? null, body ?? null, res.status, (await res.json<{ error: string }>()).error])
              .toEqual([method, path, bearer?.slice(0, 8) ?? null, body ?? null, 401, "unauthorized"]);
          }
        }
      }
    }
    // The retired portal 2FA routes stay 410 for everyone.
    expect((await send("POST", "/v1/account/2fa", companion.token, disabled)).status).toBe(410);
  });

  it("authentication comes before the body cap (413) and the per-IP edge limiter (429) on every Cloud route (Astra MAKERKIT8 P3)", async () => {
    const companion = await companionToken("pat@example.test");
    const saturated = { limit: async () => ({ success: false }) };
    const limited = { ...supaEnv(), MACHINE_OPEN_LIMIT: saturated, MACHINE_BEARER_LIMIT: saturated } as unknown as Env;
    const big = JSON.stringify({ pad: "x".repeat(64 * 1024) });
    const ROUTES = [...CLOUD_ROUTES, ["POST", "/v1/account/mfa/trust-code"], ["POST", "/v1/account/mfa/trust"]] as const;
    for (const [method, path] of ROUTES) {
      for (const bearer of [companion.token, "not-a-jwt.at-all", null]) {
        for (const [e, body] of [[supaEnv(), big], [limited, "{}"], [limited, big]] as const) {
          const ctx = createExecutionContext();
          const headers = new Headers({ "content-type": "application/json", "cf-connecting-ip": "198.51.100.7" });
          if (bearer) headers.set("authorization", `Bearer ${bearer}`);
          const res = await worker.fetch(new Request(`https://auth.murage.test${path}`, { method, headers, body: method === "GET" ? undefined : body }), e, ctx);
          await waitOnExecutionContext(ctx);
          expect([method, path, bearer?.slice(0, 8) ?? null, body.length, res.status]).toEqual([method, path, bearer?.slice(0, 8) ?? null, body.length, 401]);
        }
      }
    }
    // An authenticated member still meets both: the cap and the limiter are unchanged, they just come second.
    const cloud = await sign(claims());
    expect((await send("POST", "/v1/homes/home-x/pairing/start", cloud, limited)).status).toBe(429);
    expect((await send("POST", "/v1/account/terms/accept", cloud, supaEnv(), big)).status).toBe(413);
  });

  it("route scope: a Supabase (Cloud) token never reaches a companion route", async () => {
    const cloud = await sign(claims());
    expect((await call("/v1/account/terms", cloud)).status).toBe(200);
    for (const [method, path] of COMPANION_ROUTES) {
      const res = await send(method, path, cloud);
      expect([method, path, res.status]).toEqual([method, path, 401]);
    }
    // A Cloud token is no Better Auth session either way: nothing is looked up as one.
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "session"').first()).toEqual({ n: 0 });
  });

  it("a same-email companion account and Cloud account coexist end to end: each sees only its own account", async () => {
    const cloud = await sign(claims());
    expect((await call("/v1/account/terms", cloud)).status).toBe(200);
    const companion = await companionToken("pat@example.test");
    const cloudId = (await env.DB.prepare("SELECT user_id FROM supabase_identities WHERE sub=?").bind(SUB).first<{ user_id: string }>())!.user_id;
    expect(companion.id).not.toBe(cloudId);
    const me = await (await send("GET", "/v1/me", companion.token)).json<{ user: { id: string; email: string } }>();
    expect(me.user).toMatchObject({ id: companion.id, email: "pat@example.test" });
    // The Cloud member still resolves, with no account_email_taken or conflict, before and after the companion sign-in.
    expect((await call("/v1/account/terms", await sign(claims()))).status).toBe(200);
    // A Cloud member signing up AFTER a companion account exists with that address: also no conflict.
    const later = "6a1d2c3f-4b5e-4f60-9bac-1d2e3f4a5b6c";
    const other = await companionToken("lee@example.test");
    expect((await call("/v1/account/terms", await sign(claims({ sub: later, email: "lee@example.test" })))).status).toBe(200);
    const laterId = (await env.DB.prepare("SELECT user_id FROM supabase_identities WHERE sub=?").bind(later).first<{ user_id: string }>())!.user_id;
    expect(laterId).not.toBe(other.id);
    expect((await (await send("GET", "/v1/me", other.token)).json<{ user: { id: string } }>()).user.id).toBe(other.id);
  });

  it("serves /v1/homes to the members area, and leaves /v1/me on Better Auth", async () => {
    const homes = await call("/v1/homes", await sign(claims()));
    expect(homes.status).toBe(200);
    expect(await homes.json()).toEqual({ homes: [] });
    expect((await call("/v1/homes", "not-a-jwt.signature")).status).toBe(401);
    expect((await call("/v1/me", await sign(claims()))).status).toBe(401);
  });

  it("accepts the members area's server-side calls with Origin https://murage.ai", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://auth.murage.test/v1/account/terms", {
      headers: { authorization: `Bearer ${await sign(claims())}`, origin: "https://murage.ai" },
    }), supaEnv({ ALLOWED_ORIGINS: "https://cloud.murage.ai,https://murage.ai" }), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
  });

  it("serves every members-area read route with the Supabase bearer", async () => {
    const t = await sign(claims());
    for (const path of ["/v1/account/terms", "/v1/account/cloud", "/v1/account/confirmation", "/v1/account/topup", "/v1/legal/disclosure?plan=pro"]) {
      const res = await call(path, t);
      expect([path, res.status === 401 || res.status === 403]).toEqual([path, false]);
    }
    for (const [path, body] of [["/v1/account/terms/accept", {}], ["/v1/legal/quote", { plan: "pro", country: "US" }]] as const) {
      const res = await call(path, t, { body });
      expect([path, res.status === 401 || res.status === 403]).toEqual([path, false]);
    }
  });
});
