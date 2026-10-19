// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra MAKERKIT4 #2: a Supabase-identity Cloud customer pairs a desktop with a one-time code made in the members area
// (signed in, fresh aal2), never with a Better Auth login. Kept for a future Cloud-home desktop feature; the desktop does
// not use it at launch. CONTRACT.md section 8.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { createHmac, timingSafeEqual } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { classifyEdge } from "../src/edge-limits";
import { createWorker } from "../src/index";
import { base64, keyWrapperFor, stagingKeyWrapper } from "../src/key-wrapper";
import type { PairingDependencies } from "../src/pairing";
import { dropSink, engagedSink, installSink, realSends, sunk } from "./sink-fixture";

const REF_ORIGIN = "https://testref.supabase.co";
const ISS = `${REF_ORIGIN}/auth/v1`;
const OWNER_SUB = "5f0c1b2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
const OTHER_SUB = "6a1d2c3f-4b5e-4f60-9bac-1d2e3f4a5b6c";
const KEK = btoa("x".repeat(32));
const HOME = "home-desk";
const HOSTNAME = "h-desk0123.murage.test";
const BOOTSTRAP = crypto.getRandomValues(new Uint8Array(32));
const DEVICE = { scope: "owner-desktop", publicKey: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
  assertionKey: "-----BEGIN PUBLIC KEY-----\nBBBB\n-----END PUBLIC KEY-----\n" };

const b64u = (b: ArrayBuffer | string) => Buffer.from(typeof b === "string" ? Buffer.from(b) : new Uint8Array(b)).toString("base64url");
let ec: CryptoKeyPair;
let jwks: { keys: Record<string, unknown>[] };
beforeAll(async () => {
  ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", ec.publicKey) as Record<string, unknown>), kid: "ec-1", alg: "ES256", use: "sig" }] };
});
/** Each member's TOTP factor; member() puts it on the account's trusted list (trusted-factors.ts). */
const factorOf = (sub: string) => `${sub.slice(0, 24)}000000000f01`;
async function token(sub: string, email: string, aal2 = true) {
  const s = Math.floor(Date.now() / 1000);
  const c = { iss: ISS, aud: "authenticated", exp: s + 3600, iat: s - 5, sub, email, role: "authenticated", is_anonymous: false,
    app_metadata: { provider: "email", email_verified: true }, user_metadata: {}, session_id: crypto.randomUUID(),
    mfa_factor_id: factorOf(sub), aal: aal2 ? "aal2" : "aal1", amr: aal2 ? [{ method: "totp", timestamp: s - 10 }, { method: "otp", timestamp: s - 60 }] : [{ method: "otp", timestamp: s - 60 }] };
  const input = `${b64u(JSON.stringify({ alg: "ES256", kid: "ec-1", typ: "JWT" }))}.${b64u(JSON.stringify(c))}`;
  return `${input}.${b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, new TextEncoder().encode(input)))}`;
}

class FakeHome {
  calls: { url: string; init: RequestInit }[] = [];
  hasDevices = false;
  async fetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
    this.calls.push({ url: String(url), init: init ?? {} });
    const raw = String(init?.body);
    const signature = String((init?.headers as Record<string, string>)["x-murage-signature"]);
    if (!validSignature(raw, signature)) return new Response("{}", { status: 400 });
    if (this.hasDevices) return Response.json({ error: "step-up required" }, { status: 403 });
    return Response.json({ code: "PAIRCODE0123456789", expiresIn: (JSON.parse(raw) as { ttl: number }).ttl });
  }
}
function validSignature(raw: string, signature: string) {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(createHmac("sha256", base64(BOOTSTRAP)).update(raw).digest(), Buffer.from(signature, "hex"));
}

const sent: { to: string; subject: string; text: string }[] = [];
let failSend = false;
/** Runs inside a send, before it returns: a home that moves while the owner's notice is in flight. */
let onSend: ((m: { subject: string }) => Promise<void>) | null = null;
/** Runs after the bootstrap secret is unwrapped, before anything is signed or recorded: a home that moves during the unwrap. */
let onUnwrap: (() => Promise<void>) | null = null;
const home = new FakeHome();
const deps: PairingDependencies = {
  emailSender: () => ({ async send(m) { if (failSend) throw new Error("provider down"); await onSend?.(m); sent.push({ to: m.to, subject: m.subject, text: m.text }); } }),
  homeFetch: ((url: string | URL | Request, init?: RequestInit) => home.fetch(url, init)) as typeof fetch,
  keyWrapper: (e) => { const real = keyWrapperFor(e);
    return { wrap: (h, b) => real.wrap(h, b), unwrap: async (h, w) => { const out = await real.unwrap(h, w); await onUnwrap?.(); return out; } }; },
};
const jwksFetch = (async () => Response.json(jwks)) as typeof fetch;
// Supabase Auth's current record of the token's member: the step-up gate checks that the factor that verified the session
// is still enrolled (Astra MAKERKIT8 #2). Each member has exactly the one verified factor named in their tokens.
const authFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const bearer = new Headers(init?.headers).get("authorization")!.slice("Bearer ".length);
  const c = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString()) as { sub: string; email: string };
  return Response.json({ id: c.sub, email: c.email, email_confirmed_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    factors: [{ id: factorOf(c.sub), factor_type: "totp", status: "verified", friendly_name: "" }] });
}) as typeof fetch;
const worker = createWorker(fetch, fetch, {}, deps, {}, { jwksFetch, authFetch });
// The same worker with NO injected email sender: the production default, which is the staging sink when it is engaged (Astra TRUSTCODE-1 P3-3).
const sinkWorker = createWorker(fetch, fetch, {}, { homeFetch: deps.homeFetch }, {}, { jwksFetch, authFetch });
let sinkOn = false;
let signingJwk: JsonWebKey | undefined;
async function signer() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  signingJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
}
/** A completed 72-hour pair hold for HOME at the home's generation (self-service add-device requires one). */
async function pairHold() {
  const now = Date.now(); const done = now - 60_000;
  await env.DB.prepare(`INSERT INTO cloud_recovery_holds (id,home_id,action,generation,started_at,completes_at,completed_at,canceled_at,source)
    VALUES (?,?,'pair',1,?,?,?,NULL,'customer')`).bind(`hold-${crypto.randomUUID()}`, HOME, done - 72 * 3_600_000, done, done).run();
}
const testEnv = (extra: Record<string, string> = {}) => ({ ...env, CLOUD_B3_SIGNING_JWK: signingJwk ? JSON.stringify(signingJwk) : undefined, SUPABASE_URL: REF_ORIGIN, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_testkey_0123456789abcdef",
  MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined, CLOUD_KEK_V1: KEK, ...extra }) as unknown as Env;

async function call(path: string, bearer: string | null, body?: unknown, extra: Record<string, string> = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  const ctx = createExecutionContext();
  const res = await (sinkOn ? sinkWorker : worker).fetch(new Request(`https://auth.murage.test${path}`, { method: "POST", headers, body: JSON.stringify(body ?? {}) }),
    testEnv({ ...(sinkOn ? engagedSink() as Record<string, string> : {}), ...extra }), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
/** The member's control-plane account, created by their first members-area call. */
async function member(sub: string, email: string) {
  const t = await token(sub, email);
  const ctx = createExecutionContext();
  expect((await worker.fetch(new Request("https://auth.murage.test/v1/account/terms", { headers: { authorization: `Bearer ${t}` } }), testEnv(), ctx)).status).toBe(200);
  await waitOnExecutionContext(ctx);
  const row = await env.DB.prepare("SELECT user_id FROM supabase_identities WHERE sub=?").bind(sub).first<{ user_id: string }>();
  await env.DB.prepare("INSERT OR IGNORE INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state) VALUES (?,?,'totp','email_code',0,0,'active')")
    .bind(row!.user_id, factorOf(sub)).run();
  return { token: t, id: row!.user_id };
}
async function seedHome(ownerId: string) {
  const wrapper = stagingKeyWrapper(KEK);
  const wrapped = await Promise.all([1, 2, 3].map((i) => wrapper.wrap(HOME, i === 2 ? BOOTSTRAP : crypto.getRandomValues(new Uint8Array(32)))));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO cloud_machines (id,home_id,generation,state,created_at,public_origin,admin_url) VALUES (?,?,1,'active',?,?,?)`)
      .bind(HOME, HOME, now, `https://${HOSTNAME}`, "https://admin.murage.test"),
    env.DB.prepare("INSERT INTO cloud_home_keys VALUES (?,?,?,?,?)").bind(HOME, wrapped[0], wrapped[1], wrapped[2], "v1"),
    env.DB.prepare(`INSERT INTO machine_endpoints (machine_id,hostname,tunnel_name,status,created_at,updated_at) VALUES (?,?,?,'ready',?,?)`)
      .bind(HOME, HOSTNAME, `t-${HOME}`, now, now),
    env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
      VALUES (?,?,?,'ready','ready','sha256:x','k',?,?)`).bind(HOME, "inst-1", ownerId, now, now),
  ]);
}
const makeCode = (t: string) => call(`/v1/account/homes/${HOME}/desktop-code`, t);
const redeem = (code: string, mode: "first" | "add" = "first") => call("/v1/pairing/desktop", null, { code, device: DEVICE, mode });

afterEach(() => { sent.length = 0; home.calls = []; home.hasDevices = false; failSend = false; onSend = null; onUnwrap = null; });

describe("desktop pairing for a members-area (Supabase) customer (Astra MAKERKIT4 #2)", () => {
  it("makes a one-time code for the owner with a fresh second factor, emails the owner, and stores only its HMAC", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const aal1 = await makeCode(await token(OWNER_SUB, "owner@example.test", false));
    expect(aal1.status).toBe(403);
    expect((await aal1.json<{ error: string }>()).error).toBe("step_up_required");
    expect(sent).toHaveLength(0);
    const res = await makeCode(owner.token);
    expect(res.status).toBe(201);
    const body = await res.json<{ code: string; homeId: string; expiresIn: number }>();
    expect(body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(body).toMatchObject({ homeId: HOME, expiresIn: 600 });
    expect(sent).toEqual([expect.objectContaining({ to: "owner@example.test", subject: "A code to connect a desktop to your Murage Cloud home" })]);
    expect(sent[0].text).not.toContain(body.code);
    const rows = (await env.DB.prepare("SELECT * FROM desktop_pairing_codes").all<Record<string, unknown>>()).results;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(body.code.replaceAll("-", ""));
    expect(rows[0]).toMatchObject({ account_id: owner.id, home_id: HOME });
  });

  it("first device: the desktop redeems the code once, with no account session, and gets the home's pairing code", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const { code } = await (await makeCode(owner.token)).json<{ code: string }>();
    // Typed loosely: lower case, no dashes, O for 0 and I/L for 1 are folded.
    const typed = code.toLowerCase().replaceAll("-", "").replaceAll("0", "o").replaceAll("1", "l");
    const res = await redeem(typed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "first", homeId: HOME, account: owner.id, code: "PAIRCODE0123456789", expiresIn: 120, homeOrigin: `https://${HOSTNAME}` });
    expect(home.calls).toHaveLength(1);
    expect(home.calls[0].url).toBe(`https://${HOSTNAME}/api/cloud/pairing`);
    expect(home.calls[0].init.redirect).toBe("manual");
    // The signed request names the generation the code was issued for (Astra STEPUP-EMAIL-6 #1).
    expect(JSON.parse(String(home.calls[0].init.body))).toMatchObject({ operation: "/api/cloud/pairing", account: owner.id, ...DEVICE, generation: 1 });
    expect(sent.map((m) => m.subject)).toEqual(["A code to connect a desktop to your Murage Cloud home", "A desktop is connecting to your Murage Cloud home"]);
    // Single use.
    expect((await redeem(code)).status).toBe(403);
    expect(home.calls).toHaveLength(1);
  });

  it("STEPUP-EMAIL-6 #1: the home moving 1 -> 2 during the redemption notice is 409 home_changed, never a 200 signed with the newer key", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const { code } = await (await makeCode(owner.token)).json<{ code: string }>();
    const newer = crypto.getRandomValues(new Uint8Array(32));
    onSend = async (m) => {
      if (!m.subject.startsWith("A desktop is connecting")) return;
      const wrapped = await stagingKeyWrapper(KEK).wrap(HOME, newer);
      await env.DB.batch([
        env.DB.prepare("UPDATE cloud_homes SET generation=2 WHERE id=?").bind(HOME),
        env.DB.prepare("UPDATE cloud_machines SET generation=2 WHERE id=?").bind(HOME),
        env.DB.prepare("UPDATE cloud_home_keys SET wrapped_bootstrap_secret=? WHERE home_id=?").bind(wrapped, HOME),
      ]);
    };
    const res = await redeem(code);
    expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([409, "home_changed"]);
    expect(home.calls).toHaveLength(0);
    // Spent: the code never pairs the new generation either.
    onSend = null;
    expect((await redeem(code)).status).toBe(403);
    expect(home.calls).toHaveLength(0);
  });

  it("STEPUP-EMAIL-6 #1: machine and home generations must both equal the code's; a machine alone at a newer generation is refused", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const { code } = await (await makeCode(owner.token)).json<{ code: string }>();
    await env.DB.prepare("UPDATE cloud_machines SET generation=2 WHERE id=?").bind(HOME).run();
    const res = await redeem(code);
    expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([409, "home_changed"]);
    expect(home.calls).toHaveLength(0);
  });

  it("add device without a completed pair hold is refused 409 pair_hold_required, like the add-device route; the code is spent", async () => {
    await signer();
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const { code } = await (await makeCode(owner.token)).json<{ code: string }>();
    const res = await redeem(code, "add");
    expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([409, "pair_hold_required"]);
    expect(home.calls).toHaveLength(0);
    expect((await redeem(code, "add")).status).toBe(403);
  });

  it("add device: an already-paired desktop with a completed pair hold gets the signed body to send with its own step-up; the CP never calls the home", async () => {
    await signer();
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    await pairHold();
    const { code } = await (await makeCode(owner.token)).json<{ code: string }>();
    const res = await redeem(code, "add");
    expect(res.status).toBe(200);
    const body = await res.json<{ mode: string; account: string; body: string; signature: string; homeOrigin: string; expiresIn: number }>();
    expect(body).toMatchObject({ mode: "add", homeId: HOME, account: owner.id, homeOrigin: `https://${HOSTNAME}`, expiresIn: 120 });
    expect(validSignature(body.body, body.signature)).toBe(true);
    expect(JSON.parse(body.body)).toMatchObject({ operation: "/api/cloud/pairing", account: owner.id, ...DEVICE });
    expect(JSON.parse(body.body)).toHaveProperty("pairHoldProof");
    expect(home.calls).toHaveLength(0);
  });

  it("STEPUP-EMAIL-7 #1: add device, the home moving 1 -> 2 DURING the key unwrap (same bootstrap secret) is 409, never a generation-1 signature", async () => {
    await signer();
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    await pairHold();
    const { code } = await (await makeCode(owner.token)).json<{ code: string }>();
    onUnwrap = async () => {
      await env.DB.batch([
        env.DB.prepare("UPDATE cloud_homes SET generation=2 WHERE id=?").bind(HOME),
        env.DB.prepare("UPDATE cloud_machines SET generation=2 WHERE id=?").bind(HOME),
      ]);
    };
    const res = await redeem(code, "add");
    const text = await res.text();
    expect(res.status).toBe(409);
    expect(JSON.parse(text)).toEqual({ error: "home_changed" });
    expect(text).not.toContain("signature");
    expect(text).not.toContain("pairHoldProof");
    expect(home.calls).toHaveLength(0);
    const logged = await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_unwrap_log WHERE home_id=? AND outcome='pairing_device_signed'").bind(HOME).first<{ n: number }>();
    expect(logged!.n).toBe(0);
  });

  it("STEPUP-EMAIL-7 #1: first device, a generation change during the unwrap is 409 home_changed, and the body it sent names generation 1", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const { code } = await (await makeCode(owner.token)).json<{ code: string }>();
    onUnwrap = async () => { await env.DB.prepare("UPDATE cloud_machines SET generation=2 WHERE id=?").bind(HOME).run(); };
    const res = await redeem(code);
    expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([409, "home_changed"]);
    // Whatever reached the home is signed for generation 1, which a home pinned to 2 refuses (server/cloud-request-auth.ts).
    for (const c of home.calls) expect(JSON.parse(String(c.init.body)).generation).toBe(1);
  });

  it("first-device mode on a home that already has devices is 409 already_paired, and the code is spent", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    home.hasDevices = true;
    const { code } = await (await makeCode(owner.token)).json<{ code: string }>();
    const res = await redeem(code);
    expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([409, "already_paired"]);
    expect((await redeem(code, "add")).status).toBe(403);
  });

  it("refuses an unknown, expired, replaced or malformed code, a stranger's request, and a home that changed owner", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    const other = await member(OTHER_SUB, "other@example.test");
    await seedHome(owner.id);
    // A stranger cannot make a code for the owner's home.
    const foreign = await makeCode(other.token);
    expect([foreign.status, (await foreign.json<{ error: string }>()).error]).toEqual([403, "pairing_refused"]);
    expect((await redeem("ABCD-EFGH-JKMN-PQRS")).status).toBe(403);
    expect((await call("/v1/pairing/desktop", null, { code: "short", device: DEVICE, mode: "first" })).status).toBe(400);
    expect((await call("/v1/pairing/desktop", null, { code: "ABCD-EFGH-JKMN-PQRS", device: DEVICE, mode: "recover" })).status).toBe(400);
    // A new code replaces the last one.
    const first = (await (await makeCode(owner.token)).json<{ code: string }>()).code;
    const second = (await (await makeCode(owner.token)).json<{ code: string }>()).code;
    expect((await redeem(first)).status).toBe(403);
    // Expired.
    await env.DB.prepare("UPDATE desktop_pairing_codes SET expires_at=?").bind(Date.now() - 1).run();
    expect((await redeem(second)).status).toBe(403);
    // The home changed owner after the code was made.
    const third = (await (await makeCode(owner.token)).json<{ code: string }>()).code;
    await env.DB.prepare("UPDATE cloud_homes SET owner_id=? WHERE id=?").bind(other.id, HOME).run();
    expect((await redeem(third)).status).toBe(403);
    expect(home.calls).toHaveLength(0);
  });

  it("no code exists when the owner cannot be emailed, and the route is members-area only", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    failSend = true;
    const res = await makeCode(owner.token);
    expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([503, "email_unavailable"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM desktop_pairing_codes").first()).toEqual({ n: 0 });
    failSend = false;
    expect((await call(`/v1/account/homes/${HOME}/desktop-code`, null)).status).toBe(401);
    // A Better Auth (companion) bearer is no session on a Cloud route, and the retired legacy switch changes nothing.
    expect((await call(`/v1/account/homes/${HOME}/desktop-code`, "companiontoken.signature")).status).toBe(401);
    expect((await call(`/v1/account/homes/${HOME}/desktop-code`, owner.token, {}, { CLOUD_LEGACY_CUSTOMER_AUTH: "1" })).status).toBe(201);
    // The redemption is unauthenticated, so the per-IP edge limiter covers it.
    expect(classifyEdge(new Request("https://auth.murage.test/v1/pairing/desktop", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.9" } })))
      .toEqual({ limiter: "MACHINE_OPEN_LIMIT", key: "203.0.113.9" });
  });
});

describe("the staging mail sink through the production sender (Astra TRUSTCODE-1 P3-3)", () => {
  it("pairing notices (sendDesktopNotice): creating and redeeming a desktop code write both sink rows with no injected sender; nothing reaches a provider", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    await installSink();
    sinkOn = true;
    try {
      const made = await makeCode(owner.token);
      expect(made.status).toBe(201);
      const { code } = await made.json<{ code: string }>();
      expect((await redeem(code)).status).toBe(200);
      expect(sent).toEqual([]);
      expect((await sunk()).map((r) => [r.to_addr, r.subject])).toEqual([
        ["owner@example.test", "A code to connect a desktop to your Murage Cloud home"],
        ["owner@example.test", "A desktop is connecting to your Murage Cloud home"],
      ]);
      expect(realSends).toEqual([]);
    } finally { sinkOn = false; await dropSink(); }
  });
});
