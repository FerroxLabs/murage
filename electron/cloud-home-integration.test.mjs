// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 integration (WP1 + WP2): installCloudHome wired to the REAL Cloud-home client, proxying to the REAL in-process
// home (CloudSessions + createCloudRequestAuth). Proves: client.provider feeds the proxy, a 401 / 403 session-invalid
// triggers client.onAuthFailure once and ONE retry; a step-up 403 is driven from main (WP4): native confirm, one signed retry of the
// same bytes, deny means the original 403; a write while unreachable fails at once and is never replayed; add-device.
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CloudSessions } from "../server/cloud-sessions.ts";
import { cloudBodies, createCloudRequestAuth } from "../server/cloud-request-auth.ts";
import { buildDeviceRequest, createCloudHomeClient, parseDeviceCodePackage } from "./cloud-home-client.mjs";
import { installCloudHome } from "./cloud-home-window.mjs";
import { createCloudHomeStore, generateDeviceKeys } from "./cloud-home-store.mjs";

const ORIGIN = "https://home.example", CP = "https://cp.test", HOME = "home-1", ACCOUNT = "owner-1", BOOTSTRAP = "fixture-bootstrap-key-32-characters";
const cpKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const otherKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const cpJwk = cpKey.publicKey.export({ format: "jwk" });
const cpConfig = { staging: { baseUrl: CP, jwk: cpJwk }, prod: { baseUrl: "https://prod.test", jwk: null } };

const envelope = (claims, key = cpKey.privateKey) => {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { algorithm: "ES256", payload, signature: sign("sha256", Buffer.from(payload), { key, dsaEncoding: "ieee-p1363" }).toString("base64url") };
};
const claimsFor = (over = {}) => ({ type: "murage-home-key-v1", homeId: HOME, generation: 1, homeKey: "home-key-A", publicOrigin: ORIGIN, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 600_000, ...over });
const safeStorage = (backend = "gnome_libsecret", available = true) => ({
  isAsyncEncryptionAvailable: async () => available,
  getSelectedStorageBackend: () => backend,
  encryptString: (s) => Buffer.from("ENC1:" + Buffer.from(s).toString("base64")),
  decryptString: (b) => Buffer.from(b.toString().slice(5), "base64").toString(),
});

let root, sessions, server, identityClaims, identitySigner, healthVersion, reached, down, httpStatusOverride;
const appPaths = [];
let nonceCounter = 0;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wp2-")); vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  identityClaims = claimsFor(); identitySigner = cpKey.privateKey; healthVersion = "1.4.2"; reached = []; down = false; httpStatusOverride = null; appPaths.length = 0;
});
afterEach(async () => {
  if (server?.listening) { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; }
  if (sessions?.db.isOpen) sessions.db.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs();
});

async function startHome() {
  sessions = new CloudSessions(new DatabaseSync(join(root, "s.db")));
  const auth = createCloudRequestAuth({ sessions, publicOrigin: ORIGIN, bootstrapSecret: () => BOOTSTRAP, homeIdentity: () => ({ homeKey: envelope(identityClaims, identitySigner) }),
    // Stands in for the CP-signed pair-hold proof check (b1b-identity verifiedRecoveryHold, tested in cloud-auth-api.test.ts).
    // The fixture CP's proof: the hold and the device it was spent on (its digest), exactly what verifiedRecoveryHold returns.
    recoveryProof: (proof) => {
      if (typeof proof?.holdId !== "string" || typeof proof?.deviceKeyDigest !== "string") throw new Error("no proof");
      return { holdId: proof.holdId, deviceKeyDigest: proof.deviceKeyDigest };
    } });
  server = createServer(async (req, res) => {
    const handled = await auth(req, res, new URL(req.url, ORIGIN));
    if (handled) return;
    if (req.url === "/api/health") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ app: "murage", serverVersion: healthVersion, protocol: 1 })); return; }
    reached.push({ method: req.method, url: req.url, body: cloudBodies.get(req)?.body });
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ reachedHandler: true }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return server.address().port;
}

/** Routes https://home.example and https://cp.test onto the in-process servers. Counts every call. */
function makeFetch(port) {
  const calls = [];
  const raw = (method, path, headers, body) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, agent: false, headers: { host: "home.example", ...headers, ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}) } }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(new Response([204, 304].includes(res.statusCode) ? null : Buffer.concat(chunks), { status: httpStatusOverride ?? res.statusCode, headers: { "content-type": "application/json" } })));
    }); req.on("error", reject); req.end(body);
  });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), headers = Object.fromEntries(new Headers(init.headers).entries());
    calls.push({ origin: u.origin, method: init.method ?? "GET", path: u.pathname + u.search, bodyText: init.body === undefined ? undefined : Buffer.from(init.body).toString("utf8"), headers });
    if (down) throw new TypeError("fetch failed");
    if (u.origin === ORIGIN) return raw(init.method ?? "GET", u.pathname + u.search, headers, init.body === undefined ? undefined : Buffer.from(init.body));
    if (u.origin !== CP) throw new TypeError("unexpected origin " + u.origin);
    if (headers.authorization !== "Bearer cp-session") return Response.json({ error: "unauthorized" }, { status: 401 });
    const json = init.body ? JSON.parse(init.body) : {};
    if (u.pathname === "/v1/me") return Response.json({ user: { id: ACCOUNT, email: "o@example.test" } });
    if (u.pathname === "/v1/homes") return Response.json({ homes: [{ id: HOME, name: "Cloud home", status: "ready", publicOrigin: ORIGIN }] });
    if (u.pathname === `/v1/homes/${HOME}/pairing/device`) { // WP4 add-device: the CP signs, it does not talk to the home
      // The CP signs only with a completed 72-hour pair hold, and carries its proof; the home spends it.
      const nonce = String(++nonceCounter).padStart(24, "n"), pairHoldId = `hold-${nonce}`;
      const body = JSON.stringify({ operation: "/api/cloud/pairing", timestamp: Date.now() / 1000, nonce, account: ACCOUNT, ...json.device, ttl: 120,
        pairHoldId, pairHoldProof: { holdId: pairHoldId, deviceKeyDigest: createHash("sha256")
          .update(`murage-pair-device-v1\n${json.device.scope}\n${json.device.publicKey}\n${json.device.assertionKey}`).digest("hex") } });
      return Response.json({ body, signature: createHmac("sha256", BOOTSTRAP).update(body).digest("hex"), homeOrigin: ORIGIN, expiresIn: 120 });
    }
    return new Response("{}", { status: 404 });
  };
  return { fetchImpl, calls, homeCalls: () => calls.filter((c) => c.origin === ORIGIN) };
}

async function setup({ backend, platform = "darwin", confirm = async () => true, appVersion = "1.9.0", refreshAfterMs } = {}) {
  const port = await startHome(), net = makeFetch(port);
  const store = createCloudHomeStore({ safeStorage: safeStorage(backend), directory: join(root, "store"), platform });
  const confirmSpy = vi.fn(confirm);
  const client = createCloudHomeClient({ store, fetch: net.fetchImpl, appVersion, confirmStepUp: confirmSpy, cp: cpConfig, ...(refreshAfterMs === undefined ? {} : { refreshAfterMs }) });
  return { client, store, net, confirmSpy };
}
/** Pairs with a code the home's own session store mints for this app's public keys (the one CP-free pairing route left). */
const pairHome = async (ctx, keys = generateDeviceKeys()) => {
  const code = sessions.mint({ account: ACCOUNT, scope: "owner-desktop", publicKey: keys.sessionPublicKey, assertionKey: keys.assertionPublicKey });
  return ctx.client.pairWithDeviceCode({ homeId: HOME, homeOrigin: ORIGIN, code, account: ACCOUNT, cpEnvironment: "staging", keys });
};

function wire(ctx) {
  let handler;
  const ses = { protocol: { handle: (_scheme, h) => { handler = h; } }, setPermissionRequestHandler() {}, webRequest: { onBeforeRequest() {} } };
  const win = { isDestroyed: () => false, focus() {}, on() {}, loadURL: async () => {}, webContents: { on() {}, setWindowOpenHandler() {} } };
  const warnings = [];
  const authFailures = [];
  const realClient = ctx.client;
  const client = { provider: (id) => realClient.provider(id), onAuthFailure: async (id) => { authFailures.push(id); return realClient.onAuthFailure(id); }, stepUpRetry: (id, path, init) => realClient.stepUpRetry(id, path, init) };
  const cloud = installCloudHome({
    protocol: { registerSchemesAsPrivileged() {} }, session: { fromPartition: () => ses }, BrowserWindow: function () { return win; }, shell: { openExternal() {} },
    net: { fetch: (url, init) => ctx.net.fetchImpl(url, init) }, env: { MURAGE_DESKTOP_CLOUD: "1" }, packaged: false, distDir: "/nonexistent",
    createClient: () => client, warn: (m) => warnings.push(m),
  });
  cloud.open(HOME);
  const call = (path, init = {}) => handler(new Request(`murage-home://${HOME}${path}`, init));
  return { cloud, call, warnings, authFailures };
}
const homeHits = (ctx, p) => ctx.net.homeCalls().filter((c) => c.path === p);

describe("installCloudHome + the real client", () => {
  it("flag on: client.provider feeds the proxy (Bearer from the client's memory); nothing proxies before activate", async () => {
    const ctx = await setup(); await pairHome(ctx);
    const w = wire(ctx);
    expect((await w.call("/api/bots")).status).toBe(503); // provider is null until activate()
    expect(homeHits(ctx, "/api/bots")).toHaveLength(0);
    await ctx.client.activate(HOME);
    const r = await w.call("/api/bots");
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ reachedHandler: true });
    expect(w.authFailures).toEqual([]);
  });

  it("hard off (MURAGE_DESKTOP_CLOUD=0): no client is created", () => {
    const created = vi.fn();
    const off = installCloudHome({ protocol: {}, session: {}, BrowserWindow: function () {}, shell: {}, net: {}, env: { MURAGE_DESKTOP_CLOUD: "0" }, distDir: "/x", createClient: created });
    expect(off).toBeNull(); expect(created).not.toHaveBeenCalled();
  });

  it("a revoked access token (the home's 403 session-invalid) calls onAuthFailure once and retries once with a fresh token", async () => {
    const ctx = await setup(); await pairHome(ctx); await ctx.client.activate(HOME);
    const w = wire(ctx);
    const stale = ctx.client.provider(HOME).getAccessToken();
    sessions.db.exec("DELETE FROM cloud_access");
    const refreshes = () => homeHits(ctx, "/api/cloud/refresh").length, before = refreshes();
    const r = await w.call("/api/bots");
    expect(r.status).toBe(200);
    expect(w.authFailures).toEqual([HOME]);
    expect(refreshes() - before).toBe(1);
    expect(homeHits(ctx, "/api/bots")).toHaveLength(2); // the refused attempt and exactly one retry
    expect(ctx.client.provider(HOME).getAccessToken()).not.toBe(stale);
  });

  it("a buffered POST body is replayed byte-for-byte on that one retry", async () => {
    const ctx = await setup(); await pairHome(ctx); await ctx.client.activate(HOME);
    const w = wire(ctx);
    sessions.db.exec("DELETE FROM cloud_access");
    const body = JSON.stringify({ hello: "world" });
    const r = await w.call("/api/bots", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(r.status).toBe(200);
    expect(reached.filter((x) => x.method === "POST" && x.url === "/api/bots")).toEqual([{ method: "POST", url: "/api/bots", body: { hello: "world" } }]);
    expect(homeHits(ctx, "/api/bots")).toHaveLength(2);
  });

  it("a second refusal is returned, never a second retry", async () => {
    const ctx = await setup(); await pairHome(ctx); await ctx.client.activate(HOME);
    const w = wire(ctx);
    // The device is revoked: every token the client can obtain is refused. onAuthFailure then reports false: no retry at all.
    sessions.db.exec("UPDATE cloud_devices SET revoked=1; DELETE FROM cloud_access");
    const r = await w.call("/api/bots");
    expect([401, 403]).toContain(r.status);
    expect(w.authFailures).toEqual([HOME]);
    expect(homeHits(ctx, "/api/bots")).toHaveLength(1);
  });

  it("a refresh that succeeds but is still refused is retried exactly once (2 attempts total)", async () => {
    const ctx = await setup(); await pairHome(ctx); await ctx.client.activate(HOME);
    const w = wire(ctx);
    // /api/cloud/session-check style route does not exist; use a route the home always refuses for this scope instead:
    // unauthenticated-only behaviour is simulated by making netFetch always answer 401 for one path.
    const realFetch = ctx.net.fetchImpl; let hits = 0;
    const always401 = wire({ ...ctx, net: { ...ctx.net, fetchImpl: async (url, init) => { if (new URL(url).pathname === "/api/always401") { hits++; return Response.json({ error: "Sign in required" }, { status: 401 }); } return realFetch(url, init); } } });
    const r = await always401.call("/api/always401");
    expect(r.status).toBe(401);
    expect(hits).toBe(2);
    expect(always401.authFailures).toEqual([HOME]);
    void w;
  });

  const SKILL_PATH = "/api/skills/import";
  // Odd spacing and a non-ASCII character on purpose: what reaches the home must be these exact bytes, not a re-serialisation.
  const SKILL_BODY = '{ "link":"https://github.com/example/skill",   "note":"caf\u00e9" }';
  const postSkill = (w, body = SKILL_BODY) => w.call(SKILL_PATH, { method: "POST", headers: { "content-type": "application/json" }, body });

  it("a step-up write through the proxy: ONE native confirm, ONE signed retry, the very same bytes", async () => {
    const ctx = await setup(); await pairHome(ctx); await ctx.client.activate(HOME);
    const w = wire(ctx);
    const challengesBefore = homeHits(ctx, "/api/cloud/challenge").length;
    const r = await postSkill(w);
    expect(r.status).toBe(200);
    expect(ctx.confirmSpy).toHaveBeenCalledTimes(1);
    expect(ctx.confirmSpy.mock.calls[0][0]).toMatchObject({ homeId: HOME, method: "POST", path: SKILL_PATH, body: { link: "https://github.com/example/skill", note: "caf\u00e9" } });
    const attempts = homeHits(ctx, SKILL_PATH);
    expect(attempts).toHaveLength(2); // the refused write and exactly one signed retry, never a third
    expect(attempts[0].headers["x-murage-step-up"]).toBeUndefined();
    expect(attempts[1].headers["x-murage-step-up"]).toBeTruthy();
    expect(attempts[1].bodyText).toBe(SKILL_BODY); // byte-identical, not re-serialised
    expect(attempts[0].bodyText).toBe(SKILL_BODY);
    expect(homeHits(ctx, "/api/cloud/challenge").length - challengesBefore).toBe(1); // one challenge, for the step-up purpose
    expect(reached.filter((x) => x.url === SKILL_PATH)).toEqual([{ method: "POST", url: SKILL_PATH, body: { link: "https://github.com/example/skill", note: "caf\u00e9" } }]);
  });

  it("deny: the renderer gets the home's original 403, no signed retry is sent, nothing reaches the handler", async () => {
    const ctx = await setup({ confirm: async () => false }); await pairHome(ctx); await ctx.client.activate(HOME);
    const w = wire(ctx);
    const challengesBefore = homeHits(ctx, "/api/cloud/challenge").length;
    const r = await postSkill(w);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("step-up required");
    expect(ctx.confirmSpy).toHaveBeenCalledTimes(1);
    expect(homeHits(ctx, SKILL_PATH)).toHaveLength(1);
    expect(homeHits(ctx, SKILL_PATH).some((c) => c.headers["x-murage-step-up"])).toBe(false);
    expect(homeHits(ctx, "/api/cloud/challenge").length).toBe(challengesBefore);
    expect(reached.filter((x) => x.url === SKILL_PATH)).toHaveLength(0);
  });

  it("a body cannot change after the confirm: main signs and sends the bytes it buffered, whatever the confirm or the caller does", async () => {
    const original = Buffer.from(SKILL_BODY);
    let mutated = false;
    const ctx = await setup({ confirm: async ({ body }) => { body.link = "https://evil.example/skill"; original.fill(0x20); mutated = true; return true; } });
    await pairHome(ctx); await ctx.client.activate(HOME);
    const response = await ctx.client.stepUpRetry(HOME, SKILL_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: original });
    expect(mutated).toBe(true);
    expect(response.status).toBe(200);
    expect(homeHits(ctx, SKILL_PATH)).toHaveLength(1);
    expect(homeHits(ctx, SKILL_PATH)[0].bodyText).toBe(SKILL_BODY);
    expect(reached.filter((x) => x.url === SKILL_PATH)[0].body.link).toBe("https://github.com/example/skill");
  });

  it("stepUpRetry never loops: a signed retry the home still refuses is returned as it is", async () => {
    const ctx = await setup(); await pairHome(ctx); await ctx.client.activate(HOME);
    const w = wire(ctx);
    sessions.db.exec("UPDATE cloud_devices SET revoked=1");
    const r = await postSkill(w);
    expect([401, 403]).toContain(r.status);
    expect(homeHits(ctx, SKILL_PATH).length).toBeLessThanOrEqual(3);
    expect(ctx.confirmSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("a write while the home is unreachable fails at once, and is NOT replayed when the home returns", async () => {
    const ctx = await setup(); await pairHome(ctx); await ctx.client.activate(HOME);
    const w = wire(ctx);
    const posts = () => ctx.net.homeCalls().filter((c) => c.method === "POST" && c.path === "/api/bots");
    down = true;
    const failed = await w.call("/api/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ember" }) });
    expect(failed.status).toBe(502);
    expect(posts()).toHaveLength(1); // tried once, right away
    expect(ctx.client.queuesWrites).toBe(false);
    await expect(ctx.client.fetch(HOME, "/api/bots", { method: "POST", body: "{}" })).rejects.toMatchObject({ code: "unreachable" });
    const triedWhileDown = posts().length; // one attempt per call, each failing at once
    expect(triedWhileDown).toBe(2);
    down = false; // the home is back
    await new Promise((resolve) => setTimeout(resolve, 150));
    await ctx.client.getAccessToken(HOME);
    expect(posts()).toHaveLength(triedWhileDown); // nothing was queued, nothing was re-sent
    expect(reached.filter((x) => x.method === "POST" && x.url === "/api/bots")).toHaveLength(0);
    // A new request after the return works normally.
    expect((await w.call("/api/bots")).status).toBe(200);
  });

  it("ADD DEVICE: a paired desktop (step-up) mints a code bound to the new device's keys; the new device pairs with it", async () => {
    const ctx = await setup(); await pairHome(ctx);
    // The new device: its own store, its own keys.
    const second = { client: createCloudHomeClient({ store: createCloudHomeStore({ safeStorage: safeStorage(), directory: join(root, "second"), platform: "darwin" }), fetch: ctx.net.fetchImpl, appVersion: "1.9.0", confirmStepUp: async () => true, cp: cpConfig }) };
    const keys = generateDeviceKeys();
    const request = buildDeviceRequest(keys);
    expect(request).not.toMatch(/PRIVATE/);
    const challengesBefore = homeHits(ctx, "/api/cloud/challenge").length;
    const minted = await ctx.client.mintDeviceCode({ homeId: HOME, cpToken: "cp-session", request });
    expect(ctx.confirmSpy).toHaveBeenCalledTimes(1);
    expect(ctx.confirmSpy.mock.calls[0][0]).toMatchObject({ method: "POST", path: "/api/cloud/pairing", body: { operation: "/api/cloud/pairing", scope: "owner-desktop", publicKey: keys.sessionPublicKey } });
    expect(homeHits(ctx, "/api/cloud/pairing")).toHaveLength(1); // the first device was minted by the fake CP out of band; this is ours
    const mintCall = homeHits(ctx, "/api/cloud/pairing")[0];
    expect(mintCall.headers["x-murage-step-up"]).toBeTruthy(); // step-up on the FIRST request: the home spends the nonce before it checks
    expect(homeHits(ctx, "/api/cloud/challenge").length - challengesBefore).toBe(1);
    const parsedPackage = parseDeviceCodePackage(minted.package);
    expect(parsedPackage).toMatchObject({ homeId: HOME, homeOrigin: ORIGIN, account: ACCOUNT, code: minted.code });
    // The code is bound to the keys it was minted for: another device's keys cannot redeem it (and do not burn it).
    const third = { client: createCloudHomeClient({ store: createCloudHomeStore({ safeStorage: safeStorage(), directory: join(root, "third"), platform: "darwin" }), fetch: ctx.net.fetchImpl, appVersion: "1.9.0", confirmStepUp: async () => true, cp: cpConfig }) };
    await expect(third.client.pairWithDeviceCode({ package: minted.package, keys: generateDeviceKeys() })).rejects.toMatchObject({ code: "pairing-refused" });
    // The new device pairs with it.
    const paired = await second.client.pairWithDeviceCode({ package: minted.package, keys });
    expect(paired).toMatchObject({ homeId: HOME });
    expect((await second.client.fetch(HOME, "/api/bots")).status).toBe(200);
    // Single use.
    await expect(third.client.pairWithDeviceCode({ package: minted.package, keys })).rejects.toMatchObject({ code: "pairing-refused" });
  });

  it("ADD DEVICE: a 'no' at the confirm sends nothing; garbage requests and packages are refused before any network call", async () => {
    const ctx = await setup({ confirm: async () => false }); await pairHome(ctx);
    const request = buildDeviceRequest(generateDeviceKeys());
    const before = ctx.net.calls.length;
    await expect(ctx.client.mintDeviceCode({ homeId: HOME, cpToken: "cp-session", request })).rejects.toMatchObject({ code: "step-up-cancelled" });
    expect(homeHits(ctx, "/api/cloud/pairing")).toHaveLength(0); // nothing reached the home
    expect(ctx.net.calls.length - before).toBe(1); // just the CP signing call
    const after = ctx.net.calls.length;
    for (const bad of ["", "nope", "murage-device-request-1.!!!", buildDeviceRequest({ sessionPublicKey: "-----BEGIN PUBLIC KEY-----\nA\n-----END PUBLIC KEY-----", assertionPublicKey: "-----BEGIN PUBLIC KEY-----\nA\n-----END PUBLIC KEY-----" })]) {
      await expect(ctx.client.mintDeviceCode({ homeId: HOME, cpToken: "cp-session", request: bad })).rejects.toMatchObject({ code: "pairing-refused" });
    }
    await expect(ctx.client.pairWithDeviceCode({ package: "garbage", keys: generateDeviceKeys() })).rejects.toMatchObject({ code: "pairing-refused" });
    expect(ctx.net.calls.length).toBe(after);
  });
});
