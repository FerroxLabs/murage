// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { createHmac, timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyPayload } from "../src/b3-signatures";
import { createAuth } from "../src/auth";
import { readConfig } from "../src/config";
import { createWorker } from "../src/index";
import { authFetch, cloudMember, jwksFetch, supabaseEnv } from "./cloud-member";
import { base64, stagingKeyWrapper } from "../src/key-wrapper";
import { pairDeviceDigest, type PairingDependencies } from "../src/pairing";
import contract from "../../../shared/self-service-contract.json";

const KEK = btoa("x".repeat(32));
const HOME = "home-pair";
const HOSTNAME = "h-0123abcd.murage.test";
const BOOTSTRAP = crypto.getRandomValues(new Uint8Array(32));
const DEVICE = { scope: "owner-desktop", publicKey: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
  assertionKey: "-----BEGIN PUBLIC KEY-----\nBBBB\n-----END PUBLIC KEY-----\n" };

// The home's check, reimplemented from server/cloud-sessions.ts verifyBootstrap + cloud-request-auth.ts.
class FakeHome {
  calls: { url: string; init: RequestInit }[] = [];
  nonces = new Set<string>();
  hasDevices = false;
  redirect = false;
  async fetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
    this.calls.push({ url: String(url), init: init ?? {} });
    if (this.redirect) return new Response(null, { status: 302, headers: { location: "https://evil.example/api/cloud/pairing" } });
    // cloud-request-auth.ts refuses a POST whose Origin is not the home itself.
    if ((init?.headers as Record<string, string>).origin !== new URL(String(url)).origin) {
      return Response.json({ error: "Request origin refused" }, { status: 403 });
    }
    const raw = String(init?.body);
    const signature = String((init?.headers as Record<string, string>)["x-murage-signature"]);
    if (!/^[a-f0-9]{64}$/.test(signature)) return new Response("{}", { status: 400 });
    const expected = createHmac("sha256", base64(BOOTSTRAP)).update(raw).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return new Response("{}", { status: 400 });
    const input = JSON.parse(raw) as Record<string, unknown>;
    if (typeof input.timestamp !== "number" || Math.abs(Date.now() / 1000 - input.timestamp) > 300
      || typeof input.nonce !== "string" || input.nonce.length < 16 || input.nonce.length > 128
      || this.nonces.has(input.nonce) || input.operation !== "/api/cloud/pairing") return new Response("{}", { status: 400 });
    this.nonces.add(input.nonce);
    if (this.hasDevices) return Response.json({ error: "step-up required" }, { status: 403 });
    const ttl = input.ttl as number;
    if (!input.account || !Number.isInteger(ttl) || ttl <= 0 || ttl > 600) return new Response("{}", { status: 400 });
    return Response.json({ code: "PAIRCODE0123456789", expiresIn: ttl });
  }
}

const sent: { to: string; text: string }[] = [];
const home = new FakeHome();
let failSend = false;
let staging = false;
const deps: PairingDependencies = {
  emailSender: () => ({ async send(message) { if (failSend) throw new Error("provider down"); sent.push({ to: message.to, text: message.text }); } }),
  homeFetch: ((url: string | URL | Request, init?: RequestInit) => home.fetch(url, init)) as typeof fetch,
};
const worker = createWorker(undefined, undefined, {}, deps, {}, { jwksFetch, authFetch });
// These tests send no CF-Connecting-IP, so every call would share one edge-limiter key; the edge gate has its own tests.
let signingJwk: JsonWebKey | undefined;
let signingPublic: JsonWebKey | undefined;
const testEnv = () => ({ ...env, ...supabaseEnv, MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined, CLOUD_KEK_V1: KEK, CLOUD_CP0_STAGING: staging ? "1" : "0",
  CLOUD_B3_SIGNING_JWK: signingJwk ? JSON.stringify(signingJwk) : undefined }) as Env;
async function signer() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  signingJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  signingPublic = await crypto.subtle.exportKey("jwk", pair.publicKey);
}
/** A pair hold for HOME: completed 72 hours after it started (or not yet, or cancelled), at the home's generation. */
async function pairHold(opts: { completed?: boolean; canceled?: boolean; generation?: number; completedAgoMs?: number } = {}) {
  const now = Date.now(); const id = `hold-${crypto.randomUUID()}`;
  const completedAt = now - (opts.completedAgoMs ?? 60_000);
  await env.DB.prepare(`INSERT INTO cloud_recovery_holds (id,home_id,action,generation,started_at,completes_at,completed_at,canceled_at,source)
    VALUES (?,?,'pair',?,?,?,?,?,'customer')`).bind(id, HOME, opts.generation ?? 1, completedAt - 72 * 3_600_000, completedAt,
    opts.completed === false ? null : completedAt, opts.canceled ? now : null).run();
  return id;
}

async function call(path: string, token: string | null, body?: unknown) {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://auth.murage.test${path}`, {
    method: "POST", headers, body: JSON.stringify(body ?? {}),
  }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
// The owner is a Cloud member: these are Cloud routes, which take only the Supabase identity (customer-identity.ts).
const signIn = cloudMember;
async function seedHome(ownerId: string, hostname = HOSTNAME) {
  const wrapper = stagingKeyWrapper(KEK);
  const wrapped = (await Promise.all([1, 2, 3].map((i) => i === 2
    ? wrapper.wrap(HOME, BOOTSTRAP) : wrapper.wrap(HOME, crypto.getRandomValues(new Uint8Array(32))))));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO cloud_machines (id,home_id,generation,state,created_at,public_origin,admin_url)
      VALUES (?,?,1,'active',?,?,?)`).bind(HOME, HOME, now, `https://${hostname}`, "https://admin.murage.test"),
    env.DB.prepare("INSERT INTO cloud_home_keys VALUES (?,?,?,?,?)").bind(HOME, wrapped[0], wrapped[1], wrapped[2], "v1"),
    env.DB.prepare(`INSERT INTO machine_endpoints (machine_id,hostname,tunnel_name,status,created_at,updated_at)
      VALUES (?,?,?,'ready',?,?)`).bind(HOME, hostname, `t-${HOME}`, now, now),
    env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
      VALUES (?,?,?,'ready','ready','sha256:x','k',?,?)`).bind(HOME, "inst-1", ownerId, now, now),
  ]);
}
const lastCode = () => /\b(\d{6})\b/.exec(sent[sent.length - 1].text)![1];
const wrongCode = () => (lastCode() === "000000" ? "000001" : "000000");

afterEach(async () => {
  failSend = false; staging = false; signingJwk = undefined;
  await env.DB.prepare("DELETE FROM cloud_recovery_holds").run();
  await env.DB.prepare("DELETE FROM machine_owners").run();
  sent.length = 0; home.calls = []; home.nonces.clear(); home.hasDevices = false; home.redirect = false;
  await env.DB.batch([env.DB.prepare("DELETE FROM pairing_email_codes")]);
  vi.restoreAllMocks();
});

describe("first-device pairing", () => {
  it("emails a code to the owner and returns a pairing code the home would mint", async () => {
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    expect((await call(`/v1/homes/${HOME}/pairing/start`, owner.token)).status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@example.test");
    const response = await call(`/v1/homes/${HOME}/pairing/code`, owner.token, { emailCode: lastCode(), device: DEVICE });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: "PAIRCODE0123456789", expiresIn: 120, homeOrigin: `https://${HOSTNAME}` });
    expect(home.calls).toHaveLength(1);
    expect(home.calls[0].url).toBe(`https://${HOSTNAME}/api/cloud/pairing`);
    expect(home.calls[0].init.redirect).toBe("manual");
    const sentBody = JSON.parse(String(home.calls[0].init.body));
    expect(sentBody).toMatchObject({ operation: "/api/cloud/pairing", account: owner.userId, ttl: 120, ...DEVICE });
    expect(Object.keys(sentBody).sort()).toEqual(["account", "assertionKey", "generation", "nonce", "operation", "publicKey", "scope", "timestamp", "ttl"]);
  });

  it("start answers identically for unknown, foreign and owned homes, and sends mail only to the owner", async () => {
    const owner = await signIn("owner@example.test");
    const other = await signIn("other@example.test");
    await seedHome(owner.userId);
    const unknown = await call("/v1/homes/no-such-home/pairing/start", other.token);
    const foreign = await call(`/v1/homes/${HOME}/pairing/start`, other.token);
    expect(unknown.status).toBe(202); expect(foreign.status).toBe(202);
    expect(await unknown.text()).toBe(await foreign.text());
    expect(sent).toHaveLength(0);
    expect((await call(`/v1/homes/${HOME}/pairing/start`, null)).status).toBe(401);
  });

  it("a non-owner cannot redeem, even with the owner's code", async () => {
    const owner = await signIn("owner@example.test");
    const other = await signIn("other@example.test");
    await seedHome(owner.userId);
    await call(`/v1/homes/${HOME}/pairing/start`, owner.token);
    const refused = await call(`/v1/homes/${HOME}/pairing/code`, other.token, { emailCode: lastCode(), device: DEVICE });
    const unknown = await call("/v1/homes/no-such-home/pairing/code", other.token, { emailCode: lastCode(), device: DEVICE });
    expect(refused.status).toBe(403); expect(unknown.status).toBe(403);
    expect(await refused.text()).toBe(await unknown.text());
    expect(home.calls).toHaveLength(0);
  });

  it("wrong, expired and reused codes all get the same refusal; a code is single use", async () => {
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    const redeem = (emailCode: string) => call(`/v1/homes/${HOME}/pairing/code`, owner.token, { emailCode, device: DEVICE });
    expect((await redeem("123456")).status).toBe(403); // nothing started
    await call(`/v1/homes/${HOME}/pairing/start`, owner.token);
    const wrong = await redeem(wrongCode());
    expect(wrong.status).toBe(403);
    const wrongBody = await wrong.json();
    const good = lastCode();
    expect((await redeem(good)).status).toBe(200);
    const reused = await redeem(good);
    expect(reused.status).toBe(403);
    expect(await reused.json()).toEqual(wrongBody);
    await call(`/v1/homes/${HOME}/pairing/start`, owner.token);
    await env.DB.prepare("UPDATE pairing_email_codes SET expires_at=?").bind(Date.now() - 1).run();
    const expired = await redeem(lastCode());
    expect(expired.status).toBe(403);
    expect(await expired.json()).toEqual(wrongBody);
    expect(home.calls).toHaveLength(1);
  });

  it("locks the code after five wrong attempts, even for the right code", async () => {
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    await call(`/v1/homes/${HOME}/pairing/start`, owner.token);
    const good = lastCode();
    const bad = wrongCode();
    for (let i = 0; i < 5; i++) {
      expect((await call(`/v1/homes/${HOME}/pairing/code`, owner.token, { emailCode: bad, device: DEVICE })).status).toBe(403);
    }
    expect((await call(`/v1/homes/${HOME}/pairing/code`, owner.token, { emailCode: good, device: DEVICE })).status).toBe(403);
    expect(home.calls).toHaveLength(0);
  });

  it("rate-limits starts per account and per home", async () => {
    const owner = await signIn("owner@example.test");
    const other = await signIn("other@example.test");
    await seedHome(owner.userId);
    for (let i = 0; i < 5; i++) expect((await call(`/v1/homes/${HOME}/pairing/start`, owner.token)).status).toBe(202);
    expect((await call(`/v1/homes/${HOME}/pairing/start`, owner.token)).status).toBe(429);
    expect(sent).toHaveLength(5);
    // A stranger hammering the owner's home never reaches the per-home counter.
    for (let i = 0; i < 5; i++) await call(`/v1/homes/${HOME}/pairing/start`, other.token);
    expect((await call(`/v1/homes/${HOME}/pairing/start`, other.token)).status).toBe(429);
    await env.DB.prepare("DELETE FROM announcement_rate_limits").run();
  });

  it("returns 409 already_paired when the home already has a device", async () => {
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    home.hasDevices = true;
    await call(`/v1/homes/${HOME}/pairing/start`, owner.token);
    const response = await call(`/v1/homes/${HOME}/pairing/code`, owner.token, { emailCode: lastCode(), device: DEVICE });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "already_paired" });
  });

  it("does not follow a redirect from the home", async () => {
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    home.redirect = true;
    await call(`/v1/homes/${HOME}/pairing/start`, owner.token);
    const response = await call(`/v1/homes/${HOME}/pairing/code`, owner.token, { emailCode: lastCode(), device: DEVICE });
    expect(response.status).toBe(502);
    expect(home.calls).toHaveLength(1);
    expect(home.calls[0].init.redirect).toBe("manual");
  });

  it("only ever calls the stored hostname, ignoring any caller-supplied URL", async () => {
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    await call(`/v1/homes/${HOME}/pairing/start`, owner.token);
    const strict = await call(`/v1/homes/${HOME}/pairing/code`, owner.token,
      { emailCode: lastCode(), device: DEVICE, homeOrigin: "https://evil.example" });
    expect(strict.status).toBe(400);
    expect(home.calls).toHaveLength(0);
  });

  it("never exposes the bootstrap secret, the email code or logs them", async () => {
    const log = vi.spyOn(console, "log"); const error = vi.spyOn(console, "error"); const warn = vi.spyOn(console, "warn");
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    const started = await call(`/v1/homes/${HOME}/pairing/start`, owner.token);
    const emailCode = lastCode();
    const paired = await call(`/v1/homes/${HOME}/pairing/code`, owner.token, { emailCode, device: DEVICE });
    const refused = await call(`/v1/homes/${HOME}/pairing/code`, owner.token, { emailCode, device: DEVICE });
    const secret = base64(BOOTSTRAP);
    for (const response of [started, paired, refused]) {
      const text = await response.text();
      expect(text).not.toContain(secret); expect(text).not.toContain(emailCode);
      expect(text).not.toContain(Buffer.from(BOOTSTRAP).toString("hex"));
    }
    const logged = JSON.stringify([...log.mock.calls, ...error.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain(secret); expect(logged).not.toContain(emailCode); expect(logged).not.toContain("PAIRCODE0123456789");
    const stored = JSON.stringify(await env.DB.prepare("SELECT * FROM pairing_email_codes").all());
    expect(stored).not.toContain(emailCode);
    const audit = await env.DB.prepare("SELECT outcome FROM cloud_unwrap_log WHERE home_id=?").bind(HOME).all<{ outcome: string }>();
    expect(audit.results.map((r) => r.outcome)).toEqual(["pairing_ok"]);
  });

  it("reports email failure only to the owner, and deletes the stored code", async () => {
    const owner = await signIn("owner@example.test");
    const other = await signIn("other@example.test");
    await seedHome(owner.userId);
    failSend = true;
    const foreign = await call(`/v1/homes/${HOME}/pairing/start`, other.token);
    const unknown = await call("/v1/homes/no-such-home/pairing/start", other.token);
    expect(foreign.status).toBe(202); expect(unknown.status).toBe(202);
    expect(await foreign.text()).toBe(await unknown.text());
    const failed = await call(`/v1/homes/${HOME}/pairing/start`, owner.token);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "email_unavailable" });
    expect(await env.DB.prepare("SELECT 1 FROM pairing_email_codes").first()).toBeNull();
  });

  it("staging machine_owners fallback: owner pairs, flag off is a dead path, cloud_homes wins", async () => {
    const owner = await signIn("owner@example.test");
    const other = await signIn("other@example.test");
    await seedHome(other.userId);
    await env.DB.prepare("DELETE FROM cloud_homes WHERE id=?").bind(HOME).run();
    await env.DB.prepare("INSERT INTO machine_owners VALUES (?,?,?)").bind(HOME, owner.userId, Date.now()).run();
    // Flag off: the assignment is ignored entirely.
    expect((await call(`/v1/homes/${HOME}/pairing/start`, owner.token)).status).toBe(202);
    expect(sent).toHaveLength(0);
    expect((await call(`/v1/homes/${HOME}/pairing/code`, owner.token, { emailCode: "123456", device: DEVICE })).status).toBe(403);
    // Flag on: the assigned owner pairs; another account does not.
    staging = true;
    expect((await call(`/v1/homes/${HOME}/pairing/start`, other.token)).status).toBe(202);
    expect(sent).toHaveLength(0);
    expect((await call(`/v1/homes/${HOME}/pairing/start`, owner.token)).status).toBe(202);
    expect(sent).toHaveLength(1);
    expect((await call(`/v1/homes/${HOME}/pairing/code`, owner.token, { emailCode: lastCode(), device: DEVICE })).status).toBe(200);
    // A cloud_homes row takes precedence over machine_owners.
    await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
      VALUES (?,?,?,'ready','ready','sha256:x','k',?,?)`).bind(HOME, "inst-1", other.userId, Date.now(), Date.now()).run();
    await env.DB.prepare("DELETE FROM announcement_rate_limits").run();
    sent.length = 0;
    expect((await call(`/v1/homes/${HOME}/pairing/start`, owner.token)).status).toBe(202);
    expect(sent).toHaveLength(0);
  });
});

describe("add-device pairing (B3 WP4)", () => {
  const NEW_DEVICE = { scope: "owner-desktop", publicKey: "-----BEGIN PUBLIC KEY-----\nCCCC\n-----END PUBLIC KEY-----\n",
    assertionKey: "-----BEGIN PUBLIC KEY-----\nDDDD\n-----END PUBLIC KEY-----\n" };
  const addDevice = (token: string | null, body: unknown = { device: NEW_DEVICE }, homeId = HOME) => call(`/v1/homes/${homeId}/pairing/device`, token, body);

  beforeEach(async () => { await signer(); });

  it("returns the exact home body and its bootstrap HMAC for the owner, and never calls the home", async () => {
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    const holdId = await pairHold();
    const response = await addDevice(owner.token);
    expect(response.status).toBe(200);
    const answer = await response.json<{ body: string; signature: string; homeOrigin: string; expiresIn: number }>();
    expect(answer.homeOrigin).toBe(`https://${HOSTNAME}`);
    expect(answer.expiresIn).toBe(120);
    expect(JSON.parse(answer.body)).toMatchObject({ operation: "/api/cloud/pairing", account: owner.userId, ttl: 120, pairHoldId: holdId, ...NEW_DEVICE });
    expect(Object.keys(JSON.parse(answer.body)).sort()).toEqual(["account", "assertionKey", "generation", "nonce", "operation", "pairHoldId", "pairHoldProof", "publicKey", "scope", "timestamp", "ttl"]);
    // The signed request names the hold's (the home's) generation it was signed at (Astra STEPUP-EMAIL-6 #1).
    expect(JSON.parse(answer.body).generation).toBe(1);
    // The proof is the CP-signed recovery proof the home verifies (b1b-identity.ts verifiedRecoveryHold): action pair, this hold, fresh.
    const claims = await verifyPayload(JSON.parse(answer.body).pairHoldProof, signingPublic!) as Record<string, unknown>;
    expect(claims).toMatchObject({ type: "murage-recovery-v1", homeId: HOME, generation: 1, holdId, action: "pair", cancelState: "not_canceled" });
    expect((claims.holdCompletedAt as number) - (claims.holdStartedAt as number)).toBeGreaterThanOrEqual(72 * 3_600_000);
    expect((claims.expiresAt as number) - (claims.issuedAt as number)).toBe(5 * 60_000);
    // The HMAC is over exactly those bytes, keyed the way the home keys it.
    const expected = createHmac("sha256", base64(BOOTSTRAP)).update(answer.body).digest("hex");
    expect(answer.signature).toBe(expected);
    expect(home.calls).toHaveLength(0);
    // The home would still refuse it without a step-up from a paired device (its own rule, mirrored by FakeHome).
    home.hasDevices = true;
    const refused = await home.fetch(`${answer.homeOrigin}/api/cloud/pairing`, { method: "POST", headers: { "x-murage-signature": answer.signature, origin: answer.homeOrigin }, body: answer.body });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "step-up required" });
  });

  it("never signs an add-device request without a completed pair hold (Astra SELFSERVICE1 #2): none, pending, cancelled, stale generation or too old", async () => {
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    const refused = async () => { const r = await addDevice(owner.token); return [r.status, (await r.json<{ error: string }>()).error]; };
    expect(await refused()).toEqual([409, "pair_hold_required"]);
    await pairHold({ completed: false });
    expect(await refused()).toEqual([409, "pair_hold_required"]);
    await pairHold({ canceled: true });
    expect(await refused()).toEqual([409, "pair_hold_required"]);
    await pairHold({ generation: 2 });
    expect(await refused()).toEqual([409, "pair_hold_required"]);
    await pairHold({ completedAgoMs: 8 * 24 * 3_600_000 });
    expect(await refused()).toEqual([409, "pair_hold_required"]);
    expect(home.calls).toHaveLength(0);
    await pairHold();
    expect((await addDevice(owner.token)).status).toBe(200);
  });

  it("spends the hold in control-plane state on exactly one device, whatever the home remembers (Astra SELFSERVICE2 #2)", async () => {
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    const holdId = await pairHold();
    const first = await addDevice(owner.token);
    expect(first.status).toBe(200);
    const claims = await verifyPayload(JSON.parse((await first.json<{ body: string }>()).body).pairHoldProof, signingPublic!) as Record<string, unknown>;
    expect(claims.deviceKeyDigest).toBe(await pairDeviceDigest(NEW_DEVICE));
    expect(await env.DB.prepare("SELECT spent_device_digest FROM cloud_recovery_holds WHERE id=?").bind(holdId).first())
      .toEqual({ spent_device_digest: await pairDeviceDigest(NEW_DEVICE) });
    // The same device may ask again (its answer was lost); any other device is refused, so a home whose own ledger was rolled back
    // (a restore) still cannot be given a second device for this hold.
    expect((await addDevice(owner.token)).status).toBe(200);
    const other = { ...NEW_DEVICE, publicKey: "-----BEGIN PUBLIC KEY-----\nEEEE\n-----END PUBLIC KEY-----\n" };
    const refused = await addDevice(owner.token, { device: other });
    expect([refused.status, (await refused.json<{ error: string }>()).error]).toEqual([409, "pair_hold_required"]);
    // A second hold is a second device.
    await pairHold();
    expect((await addDevice(owner.token, { device: other })).status).toBe(200);
    // The digest is the one the home computes (shared contract vector).
    expect(await pairDeviceDigest(contract.pairDeviceDigestVector.device)).toBe(contract.pairDeviceDigestVector.digest);
  });

  it("a fresh nonce every time", async () => {
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    await pairHold();
    const nonces = new Set<string>();
    for (let i = 0; i < 3; i++) nonces.add(JSON.parse((await (await addDevice(owner.token)).json<{ body: string }>()).body).nonce);
    expect(nonces.size).toBe(3);
  });

  it("refuses a stranger and an unknown home identically, and an anonymous caller with 401", async () => {
    const owner = await signIn("owner@example.test");
    const other = await signIn("other@example.test");
    await seedHome(owner.userId);
    const foreign = await addDevice(other.token);
    const unknown = await addDevice(other.token, { device: NEW_DEVICE }, "no-such-home");
    expect(foreign.status).toBe(403); expect(unknown.status).toBe(403);
    expect(await foreign.text()).toBe(await unknown.text());
    expect((await addDevice(null)).status).toBe(401);
  });

  it("takes the strictest shape: owner-desktop only, two different keys, nothing extra", async () => {
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    for (const bad of [
      { device: { ...NEW_DEVICE, scope: "owner-phone" } },
      { device: { ...NEW_DEVICE, scope: "browser" } },
      { device: { ...NEW_DEVICE, scope: "service" } },
      { device: { ...NEW_DEVICE, assertionKey: NEW_DEVICE.publicKey } },
      { device: { ...NEW_DEVICE, browserFactor: { credentialId: "c", rpId: "r", origin: "https://x", counter: 0 } } },
      { device: { ...NEW_DEVICE, recovery: true } },
      { device: NEW_DEVICE, recovery: true, recoveryId: "r" },
      { device: { scope: "owner-desktop", publicKey: NEW_DEVICE.publicKey } },
      {},
    ]) expect((await addDevice(owner.token, bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    expect((await call(`/v1/homes/${HOME}/pairing/device`, owner.token, "not json")).status).toBeGreaterThanOrEqual(400);
  });

  it("does not need, spend or reveal an email code, and is rate limited per account", async () => {
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    await pairHold();
    for (let i = 0; i < 10; i++) expect((await addDevice(owner.token)).status).toBe(200);
    expect((await addDevice(owner.token)).status).toBe(429);
    expect(sent).toHaveLength(0);
    await env.DB.prepare("DELETE FROM announcement_rate_limits").run();
  });

  it("503 when the home is not active; the stored hostname is the only origin", async () => {
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    await pairHold();
    await env.DB.prepare("UPDATE cloud_machines SET state='stopped' WHERE id=?").bind(HOME).run();
    expect((await addDevice(owner.token)).status).toBe(503);
  });

  it("logs the signing, and the first-device routes are unchanged", async () => {
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    await pairHold();
    await addDevice(owner.token);
    expect((await env.DB.prepare("SELECT outcome FROM cloud_unwrap_log WHERE home_id=? ORDER BY at DESC").bind(HOME).first<{ outcome: string }>())?.outcome).toBe("pairing_device_signed");
    expect((await call(`/v1/homes/${HOME}/pairing/start`, owner.token)).status).toBe(202);
    expect((await call(`/v1/homes/${HOME}/pairing/code`, owner.token, { emailCode: lastCode(), device: DEVICE })).status).toBe(200);
  });
});
