// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 WP2. The Cloud-home client against the REAL in-process CloudSessions and createCloudRequestAuth
// (server/), with a fake control plane that mints through the home's real HMAC bootstrap route.
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CloudSessions } from "../server/cloud-sessions.ts";
import { cloudBodies, createCloudRequestAuth } from "../server/cloud-request-auth.ts";
import { verifiedDoorTicket } from "../server/cloud-home/b1b-identity.ts";
import { COPY, CloudHomeError, createCloudHomeClient, createNativeStepUpConfirm, stepPurpose, verifyHomeKey } from "./cloud-home-client.mjs";
import { createCloudHomeStore, generateDeviceKeys } from "./cloud-home-store.mjs";
import { LINUX_KEYRING_REQUIRED } from "./secret-storage-policy.mjs";

const ORIGIN = "https://h-0123456789abcdef0123456789abcdef.murage.ai", CP = "https://cp.test", HOME = "home-1", ACCOUNT = "owner-1", BOOTSTRAP = "fixture-bootstrap-key-32-characters";
const cpKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const otherKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const cpJwk = cpKey.publicKey.export({ format: "jwk" });
const SITE = "https://site.test";
const cpConfig = { staging: { baseUrl: CP, siteOrigin: SITE, jwk: cpJwk }, prod: { baseUrl: "https://prod.test", siteOrigin: SITE, jwk: null } };

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

let root, sessions, server, identityClaims, identitySigner, healthVersion, reached, down, httpStatusOverride, loseAnswerOf, answerOverride, opened;
const appPaths = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wp2-")); vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  identityClaims = claimsFor(); identitySigner = cpKey.privateKey; healthVersion = "1.4.2"; reached = []; down = false; httpStatusOverride = null; loseAnswerOf = null; answerOverride = null; opened = []; appPaths.length = 0;
});
afterEach(async () => {
  if (server?.listening) { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; }
  if (sessions?.db.isOpen) sessions.db.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs();
});

async function startHome() {
  sessions = new CloudSessions(new DatabaseSync(join(root, "s.db")));
  const auth = createCloudRequestAuth({ sessions, publicOrigin: ORIGIN, bootstrapSecret: () => BOOTSTRAP, homeIdentity: () => ({ homeKey: envelope(identityClaims, identitySigner) }),
    doorTicket: (signed) => verifiedDoorTicket(signed, cpJwk, HOME, identityClaims.generation, ORIGIN) });
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

/** Routes the home origin and https://cp.test onto the in-process servers. Counts every call. */
function makeFetch(port) {
  const calls = [];
  const raw = (method, path, headers, body) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, agent: false, headers: { host: new URL(ORIGIN).host, ...headers, ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}) } }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(new Response([204, 304].includes(res.statusCode) ? null : Buffer.concat(chunks), { status: httpStatusOverride ?? res.statusCode, headers: { "content-type": "application/json" } })));
    }); req.on("error", reject); req.end(body);
  });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), headers = Object.fromEntries(new Headers(init.headers).entries());
    calls.push({ origin: u.origin, method: init.method ?? "GET", path: u.pathname + u.search });
    if (down) throw new TypeError("fetch failed");
    if (u.origin === ORIGIN && answerOverride?.path === u.pathname) { const { status, body, headers: extra = {} } = answerOverride; return Response.json(body, { status, headers: extra }); }
    if (u.origin === ORIGIN && loseAnswerOf === u.pathname) {
      // The request reaches the home and the home acts on it; the answer never comes back.
      loseAnswerOf = null;
      await raw(init.method ?? "GET", u.pathname + u.search, headers, init.body === undefined ? undefined : Buffer.from(init.body));
      throw new TypeError("fetch failed");
    }
    if (u.origin === ORIGIN) return raw(init.method ?? "GET", u.pathname + u.search, headers, init.body === undefined ? undefined : Buffer.from(init.body));
    if (u.origin !== CP) throw new TypeError("unexpected origin " + u.origin);
    if (headers.authorization !== "Bearer cp-session") return Response.json({ error: "unauthorized" }, { status: 401 });
    const json = init.body ? JSON.parse(init.body) : {};
    if (u.pathname === "/v1/me") return Response.json({ user: { id: ACCOUNT, email: "o@example.test" } });
    if (u.pathname === "/v1/homes") return Response.json({ homes: [{ id: HOME, name: "Cloud home", status: "ready", publicOrigin: ORIGIN }] });
    return new Response("{}", { status: 404 });
  };
  return { fetchImpl, calls, homeCalls: () => calls.filter((c) => c.origin === ORIGIN) };
}

async function setup({ backend, platform = "darwin", confirm = async () => true, appVersion = "1.9.0", refreshAfterMs, now } = {}) {
  const port = await startHome(), net = makeFetch(port);
  const store = createCloudHomeStore({ safeStorage: safeStorage(backend), directory: join(root, "store"), platform });
  const confirmSpy = vi.fn(confirm);
  const client = createCloudHomeClient({ store, fetch: net.fetchImpl, appVersion, confirmStepUp: confirmSpy, cp: cpConfig, cpEnvironment: "staging",
    openExternal: async (url) => { opened.push(url); }, ...(now ? { now } : {}), ...(refreshAfterMs === undefined ? {} : { refreshAfterMs }) });
  return { client, store, net, confirmSpy };
}
/** A door v2 ticket signed by the CP key, exactly as the site's mint makes one. */
const doorTicket = (bind, over = {}) => {
  const t = Date.now();
  const signed = envelope({ type: "murage-door-v2", homeId: HOME, generation: 1, publicOrigin: ORIGIN, account: ACCOUNT, nonce: randomBytes(18).toString("base64url"),
    stepUpAt: t - 1000, issuedAt: t - 1000, expiresAt: t + 59_000, bind, kind: "desktop", ...over });
  return `${signed.payload}.${signed.signature}`;
};
const doorLink = (ticket) => `murage://door?h=${HOME}&o=${encodeURIComponent(ORIGIN)}#t=${ticket}`;
/** The k the browser was sent to: sha256 of the pending session key's SPKI DER. */
const openedBind = () => new URL(opened.at(-1)).searchParams.get("k");
const bindOfKey = (pem) => createHash("sha256").update(createPublicKey(pem).export({ type: "spki", format: "der" })).digest("hex");
const desktops = () => sessions.db.prepare("SELECT id FROM cloud_devices WHERE scope='owner-desktop' AND revoked=0 ORDER BY addedAt").all().map((row) => row.id);
/** Pairs with a code the home's own session store mints for this app's public keys (the one CP-free pairing route left). */
const pairHome = async (ctx, keys = generateDeviceKeys()) => {
  const code = sessions.mint({ account: ACCOUNT, scope: "owner-desktop", publicKey: keys.sessionPublicKey, assertionKey: keys.assertionPublicKey });
  return ctx.client.pairWithDeviceCode({ homeId: HOME, homeOrigin: ORIGIN, code, account: ACCOUNT, cpEnvironment: "staging", keys });
};
const rejects = async (promise, code) => {
  const error = await promise.then(() => null, (e) => e);
  expect(error, "expected a CloudHomeError").toBeInstanceOf(CloudHomeError);
  expect(error.code).toBe(code);
  return error;
};

describe("pairing", () => {
  it("pairs: verifies the CP-signed identity first, pins it, and stores two distinct keys encrypted", async () => {
    const ctx = await setup();
    const result = await pairHome(ctx);
    expect(result).toMatchObject({ homeId: HOME, publicOrigin: ORIGIN, generation: 1 });
    const record = await ctx.store.load(HOME);
    expect(record).toMatchObject({ homeId: HOME, publicOrigin: ORIGIN, environmentId: sessions.environmentId, homeKey: "home-key-A", generation: 1, account: ACCOUNT, cpEnvironment: "staging" });
    expect(record.sessionPrivateKey).not.toBe(record.assertionPrivateKey);
    const files = readdirSync(join(root, "store")); expect(files).toEqual([`cloud-home-${HOME}.bin`]);
    const onDisk = readFileSync(join(root, "store", files[0])).toString();
    expect(onDisk).not.toContain("PRIVATE KEY"); expect(onDisk).not.toContain(sessions.environmentId);
    expect(sessions.db.prepare("SELECT scope FROM cloud_devices").all()).toEqual([{ scope: "owner-desktop" }]);
    const token = await ctx.client.getAccessToken(HOME);
    expect(JSON.stringify(record)).not.toContain(token); // the token is never persisted
    expect(ctx.client.homeOrigin(HOME)).toBe(ORIGIN);
    expect(ctx.client.queuesWrites).toBe(false);
  });

  it("refuses a code the home does not know and writes nothing locally", async () => {
    const ctx = await setup();
    await rejects(ctx.client.pairWithDeviceCode({ homeId: HOME, homeOrigin: ORIGIN, code: "not-a-real-code", account: ACCOUNT, cpEnvironment: "staging", keys: generateDeviceKeys() }), "pairing-refused");
    expect(await ctx.store.list()).toEqual([]);
  });

  it("does not redeem the code when the home identity fails the CP signature check", async () => {
    identitySigner = otherKey.privateKey;
    const ctx = await setup();
    await rejects(pairHome(ctx), "pin-mismatch");
    expect(ctx.net.calls.some((c) => c.path === "/api/cloud/pair")).toBe(false);
  });

  it("refuses a production home while no production CP key is built in: Cloud is not open yet, nothing is sent", async () => {
    const ctx = await setup();
    const error = await rejects(ctx.client.pairWithDeviceCode({ homeId: HOME, homeOrigin: ORIGIN, code: "x", account: ACCOUNT, cpEnvironment: "prod", keys: generateDeviceKeys() }), "not-open");
    expect(error.message).toBe(COPY.notOpen);
    expect(ctx.net.calls).toHaveLength(0);
  });

  it("pairs with a code minted for this app's own public keys (the existing-device route)", async () => {
    const ctx = await setup(), keys = generateDeviceKeys();
    const code = sessions.mint({ account: ACCOUNT, scope: "owner-desktop", publicKey: keys.sessionPublicKey, assertionKey: keys.assertionPublicKey });
    await ctx.client.pairWithDeviceCode({ homeId: HOME, homeOrigin: ORIGIN, code, account: ACCOUNT, keys });
    expect((await ctx.client.fetch(HOME, "/api/bots")).status).toBe(200);
  });
});

describe("session", () => {
  it("refreshes through challenge/refresh when the token is due", async () => {
    const ctx = await setup({ refreshAfterMs: 0 }); await pairHome(ctx);
    const first = await ctx.client.getAccessToken(HOME), second = await ctx.client.getAccessToken(HOME);
    expect(second).not.toBe(first);
    expect(sessions.resolve(second)?.scope).toBe("owner-desktop");
  });

  it("a revoked access token gets exactly one refresh-retry (the home answers it 403 'paired device required')", async () => {
    const ctx = await setup(); await pairHome(ctx);
    await ctx.client.getAccessToken(HOME);
    sessions.db.exec("DELETE FROM cloud_access");
    const refreshes = () => ctx.net.homeCalls().filter((c) => c.path === "/api/cloud/refresh").length, before = refreshes();
    expect((await ctx.client.fetch(HOME, "/api/bots")).status).toBe(200);
    expect(refreshes() - before).toBe(1);
  });

  it("a revoked device cannot refresh and is told to pair again", async () => {
    const ctx = await setup(); await pairHome(ctx);
    sessions.db.exec("UPDATE cloud_devices SET revoked=1; DELETE FROM cloud_access");
    await rejects(ctx.client.fetch(HOME, "/api/bots"), "needs-repair");
  });
});

describe("WP1 provider", () => {
  it("is null until activated, then hands the proxy a sync in-memory token that a scheduled refresh replaces", async () => {
    const timers = [], ctx = await setup();
    await pairHome(ctx);
    const client = createCloudHomeClient({ store: ctx.store, fetch: ctx.net.fetchImpl, appVersion: "1.9.0", confirmStepUp: ctx.confirmSpy, cp: cpConfig, schedule: (fn) => { timers.push(fn); return 0; } });
    expect(client.provider(HOME)).toBeNull();
    await client.activate(HOME);
    const home = client.provider(HOME);
    expect(home).toMatchObject({ homeId: HOME, origin: ORIGIN }); expect(typeof home.getAccessToken()).toBe("string");
    expect(client.provider("Bad_Id")).toBeNull();
    const before = home.getAccessToken(); await timers.at(-1)(); await new Promise((r) => setTimeout(r, 100));
    expect(home.getAccessToken()).not.toBe(before);
    client.deactivate(HOME); expect(client.provider(HOME)).toBeNull();
  });
  it("onAuthFailure refreshes once and reports whether to retry", async () => {
    const ctx = await setup(); await pairHome(ctx); await ctx.client.activate(HOME);
    const old = ctx.client.provider(HOME).getAccessToken();
    expect(await ctx.client.onAuthFailure(HOME)).toBe(true);
    expect(ctx.client.provider(HOME).getAccessToken()).not.toBe(old);
    sessions.db.exec("UPDATE cloud_devices SET revoked=1");
    expect(await ctx.client.onAuthFailure(HOME)).toBe(false);
    expect(await ctx.client.onAuthFailure("nope")).toBe(false);
  });
});

describe("step-up, entirely in main", () => {
  it("confirms natively, signs the exact method/path/body with the assertion key, and retries with the held body", async () => {
    const ctx = await setup(); await pairHome(ctx);
    const body = { link: "https://github.com/example/skill" };
    const response = await ctx.client.fetch(HOME, "/api/skills/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    expect(ctx.confirmSpy).toHaveBeenCalledTimes(1);
    expect(ctx.confirmSpy.mock.calls[0][0]).toEqual({ homeId: HOME, method: "POST", path: "/api/skills/import", body });
    const posts = reached.filter((r) => r.url === "/api/skills/import");
    expect(posts).toHaveLength(1); expect(posts[0].body).toEqual(body);
  });

  it("includes the query string in the signed purpose (DELETE with no body)", async () => {
    const ctx = await setup(); await pairHome(ctx);
    const path = "/api/folder-trust?folder=%2Ftmp%2Ffixture";
    expect((await ctx.client.fetch(HOME, path, { method: "DELETE" })).status).toBe(200);
    expect(ctx.confirmSpy.mock.calls[0][0].path).toBe(path);
    expect(stepPurpose("DELETE", path, undefined)).toMatch(/^step:DELETE:\/api\/folder-trust\?folder=%2Ftmp%2Ffixture:[a-f0-9]{64}$/);
  });

  it("a cancelled confirmation changes nothing", async () => {
    const ctx = await setup({ confirm: async () => false }); await pairHome(ctx);
    const error = await rejects(ctx.client.fetch(HOME, "/api/skills/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link: "https://github.com/example/skill" }) }), "step-up-cancelled");
    expect(error.message).toBe(COPY.stepUpCancelled);
    expect(reached.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("a plain write needs no confirmation", async () => {
    const ctx = await setup(); await pairHome(ctx);
    expect((await ctx.client.fetch(HOME, "/api/bots")).status).toBe(200);
    expect(ctx.confirmSpy).not.toHaveBeenCalled();
  });
});

describe("WP5 authorizeUpgrade (the engine sign-in WebSocket)", () => {
  const PATH = "/api/engine-login/codex?action=login";
  it("confirms natively once and returns Bearer + a step-up the home's own auth accepts for that exact GET", async () => {
    const ctx = await setup(); await pairHome(ctx);
    const bare = await ctx.net.fetchImpl(ORIGIN + PATH, { headers: { authorization: `Bearer ${await ctx.client.getAccessToken(HOME)}` } });
    expect([bare.status, (await bare.json()).error]).toEqual([403, "step-up required"]);
    expect(ctx.confirmSpy).not.toHaveBeenCalled();
    const auth = await ctx.client.authorizeUpgrade(HOME, PATH);
    expect(ctx.confirmSpy).toHaveBeenCalledTimes(1);
    expect(ctx.confirmSpy.mock.calls[0][0]).toEqual({ homeId: HOME, method: "GET", path: PATH, body: {} });
    expect(auth.url).toBe(ORIGIN.replace("https:", "wss:") + PATH);
    expect(Object.keys(auth.headers).sort()).toEqual(["authorization", "x-murage-step-up"]);
    const ok = await ctx.net.fetchImpl(ORIGIN + PATH, { headers: auth.headers });
    expect([ok.status, (await ok.json()).reachedHandler]).toEqual([200, true]);
    // a different engine/action needs its own assertion: the purpose binds the path
    const replay = await ctx.net.fetchImpl(ORIGIN + "/api/engine-login/claudeAgent?action=login", { headers: auth.headers });
    expect(replay.status).toBe(403);
  });
  it("a cancelled confirmation yields no headers, and a non-/api path is refused before anything is sent", async () => {
    const ctx = await setup({ confirm: async () => false }); await pairHome(ctx);
    await rejects(ctx.client.authorizeUpgrade(HOME, PATH), "step-up-cancelled");
    await expect(ctx.client.authorizeUpgrade(HOME, "/x")).rejects.toThrow(TypeError);
    await expect(ctx.client.authorizeUpgrade(HOME, "//evil/api/x")).rejects.toThrow(TypeError);
  });
});

describe("pinning", () => {
  const protectedCalls = (ctx) => ctx.net.homeCalls().filter((c) => c.path.startsWith("/api/bots"));
  /** Pair, then start a "new app run": a fresh client whose pin comes only from the store. */
  async function pairedThen(mutate = () => {}) {
    const ctx = await setup(); await pairHome(ctx);
    const fresh = () => createCloudHomeClient({ store: ctx.store, fetch: ctx.net.fetchImpl, appVersion: "1.9.0", confirmStepUp: ctx.confirmSpy, cp: cpConfig });
    mutate(); return { ...ctx, fresh };
  }
  it.each([
    ["a different homeId in the signed identity", () => { identityClaims = claimsFor({ homeId: "other-home" }); }],
    ["a different publicOrigin", () => { identityClaims = claimsFor({ publicOrigin: "https://evil.example" }); }],
    ["a changed homeKey at the same generation", () => { identityClaims = claimsFor({ homeKey: "home-key-B" }); }],
    ["an identity signed by another key", () => { identitySigner = otherKey.privateKey; }],
    ["an expired identity", () => { identityClaims = claimsFor({ issuedAt: Date.now() - 7_200_000, expiresAt: Date.now() - 3_600_000 }); }],
    ["a different environmentId, even with a higher generation", () => { identityClaims = claimsFor({ generation: 2 }); sessions.environmentId = "another-environment"; }],
  ])("refuses %s and sends no protected request", async (_name, mutate) => {
    const ctx = await pairedThen(mutate), before = protectedCalls(ctx).length;
    const error = await rejects(ctx.fresh().fetch(HOME, "/api/bots"), "pin-mismatch");
    expect(error.message).toBe(COPY.pinMismatch);
    expect(protectedCalls(ctx).length).toBe(before);
  });

  it("refuses a rolled-back generation after a valid upgrade", async () => {
    const ctx = await pairedThen(() => { identityClaims = claimsFor({ generation: 3 }); });
    expect((await ctx.fresh().fetch(HOME, "/api/bots")).status).toBe(200);
    identityClaims = claimsFor({ generation: 2 }); const before = protectedCalls(ctx).length;
    await rejects(ctx.fresh().fetch(HOME, "/api/bots"), "pin-mismatch");
    expect(protectedCalls(ctx).length).toBe(before);
  });

  it("accepts a higher generation only with a valid CP signature, and re-pins it", async () => {
    const ctx = await pairedThen(() => { identityClaims = claimsFor({ generation: 2, homeKey: "home-key-B" }); });
    expect((await ctx.fresh().fetch(HOME, "/api/bots")).status).toBe(200);
    expect(await ctx.store.load(HOME)).toMatchObject({ generation: 2, homeKey: "home-key-B" });
    identityClaims = claimsFor({ generation: 2, homeKey: "home-key-A" }); // the old key at the new generation
    await rejects(ctx.fresh().fetch(HOME, "/api/bots"), "pin-mismatch");
  });

  it("refuses a higher generation whose signature is not the CP's, and keeps the old pin", async () => {
    const ctx = await pairedThen(() => { identityClaims = claimsFor({ generation: 2, homeKey: "home-key-B" }); identitySigner = otherKey.privateKey; });
    await rejects(ctx.fresh().fetch(HOME, "/api/bots"), "pin-mismatch");
    expect(await ctx.store.load(HOME)).toMatchObject({ generation: 1, homeKey: "home-key-A" });
  });

  it("verifyHomeKey rejects a tampered payload, a private JWK and unknown fields, and accepts a good one", () => {
    const good = envelope(claimsFor({ generation: 2 }));
    const forged = { ...good, payload: Buffer.from(JSON.stringify(claimsFor({ generation: 9 }))).toString("base64url") };
    expect(() => verifyHomeKey(forged, cpJwk)).toThrow(CloudHomeError);
    expect(() => verifyHomeKey(good, { ...cpJwk, d: "x" })).toThrow(CloudHomeError);
    expect(() => verifyHomeKey(envelope({ ...claimsFor(), extra: 1 }), cpJwk)).toThrow(CloudHomeError);
    expect(verifyHomeKey(good, cpJwk).generation).toBe(2);
  });
});

describe("storage policy", () => {
  it("refuses Linux basic_text even with the plaintext opt-in set, pairs nothing and stores nothing", async () => {
    vi.stubEnv("MURAGE_ALLOW_PLAINTEXT_SECRETS", "1");
    const ctx = await setup({ backend: "basic_text", platform: "linux" });
    await expect(pairHome(ctx)).rejects.toMatchObject({ code: "store-refused", message: LINUX_KEYRING_REQUIRED });
    expect(ctx.net.calls.some((c) => c.path === "/api/cloud/pair")).toBe(false); // refused before the home was touched
    expect(await ctx.store.list()).toEqual([]);
    await expect(ctx.store.save({ homeId: HOME, cpEnvironment: "staging", publicOrigin: ORIGIN, environmentId: "e", homeKey: "k", generation: 1, deviceId: "d", account: "a", sessionPrivateKey: "s", assertionPrivateKey: "t", pinnedAt: 1 }))
      .rejects.toMatchObject({ code: "store-refused" });
  });
  it("a Linux keyring (gnome_libsecret) is accepted, and the store refuses identical session and assertion keys", async () => {
    const ctx = await setup({ backend: "gnome_libsecret", platform: "linux" });
    await pairHome(ctx);
    const record = await ctx.store.load(HOME);
    await expect(ctx.store.save({ ...record, assertionPrivateKey: record.sessionPrivateKey })).rejects.toMatchObject({ code: "invalid-record" });
  });
  it("an unavailable store on any platform refuses", async () => {
    const store = createCloudHomeStore({ safeStorage: safeStorage("x", false), directory: join(root, "s2"), platform: "darwin" });
    await expect(store.assertWritable()).rejects.toMatchObject({ code: "store-refused" });
  });
  it("generated device keys are two different ed25519 pairs", () => {
    const keys = generateDeviceKeys();
    expect(keys.sessionPublicKey).not.toBe(keys.assertionPublicKey); expect(keys.sessionPrivateKey).not.toBe(keys.assertionPrivateKey);
  });
});

describe("version and reachability", () => {
  it("refuses a major-version mismatch with 'the versions need to match' and writes nothing", async () => {
    const ctx = await setup(); await pairHome(ctx);
    const fresh = createCloudHomeClient({ store: ctx.store, fetch: ctx.net.fetchImpl, appVersion: "2.0.0", confirmStepUp: ctx.confirmSpy, cp: cpConfig });
    const error = await rejects(fresh.fetch(HOME, "/api/skills/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link: "https://x.example/a" }) }), "version-mismatch");
    expect(error.message).toBe("the versions need to match");
    expect(reached.filter((r) => r.method === "POST")).toHaveLength(0);
    expect(ctx.confirmSpy).not.toHaveBeenCalled();
  });
  it("a major mismatch right after pairing forgets the new pairing locally", async () => {
    healthVersion = "3.0.0";
    const ctx = await setup(); await rejects(pairHome(ctx), "version-mismatch");
    expect(await ctx.store.list()).toEqual([]);
  });
  it("a minor/patch difference is fine", async () => {
    healthVersion = "1.0.0"; const ctx = await setup({ appVersion: "1.9.9" }); await pairHome(ctx);
    expect((await ctx.client.fetch(HOME, "/api/bots")).status).toBe(200);
  });
  it("an unreachable home fails the write at once: one attempt, no queue, no retry", async () => {
    const ctx = await setup(); await pairHome(ctx);
    const fresh = createCloudHomeClient({ store: ctx.store, fetch: ctx.net.fetchImpl, appVersion: "1.9.0", confirmStepUp: ctx.confirmSpy, cp: cpConfig });
    down = true; const before = ctx.net.calls.length, started = Date.now();
    const error = await rejects(fresh.fetch(HOME, "/api/bots/b1/respond", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) }), "unreachable");
    expect(error.message).toBe("Your Cloud home isn't reachable");
    expect(ctx.net.calls.length - before).toBe(1); expect(Date.now() - started).toBeLessThan(1000);
    await new Promise((r) => setTimeout(r, 150)); down = false;
    expect(ctx.net.calls.length - before).toBe(1); // nothing was queued and replayed
    expect(reached.filter((r) => r.url.endsWith("/respond"))).toHaveLength(0);
  });
  it.each([502, 504, 522, 530])("a gateway status %i from the edge is also 'not reachable'", async (status) => {
    const ctx = await setup(); await pairHome(ctx);
    await ctx.client.getAccessToken(HOME); httpStatusOverride = status;
    await rejects(ctx.client.fetch(HOME, "/api/bots"), "unreachable");
  });
});

describe("native step-up confirmation", () => {
  const dialog = (response) => ({ showMessageBox: vi.fn(async () => ({ response })) });
  it("uses Touch ID on a Mac that can prompt; the reason names the action in words, never the query or the body", async () => {
    const systemPreferences = { canPromptTouchID: () => true, promptTouchID: vi.fn(async () => undefined) };
    const confirm = createNativeStepUpConfirm({ systemPreferences, dialog: dialog(1), platform: "darwin" });
    expect(await confirm({ method: "POST", path: "/api/x?secret=1", body: { token: "s3cret" } })).toBe(true);
    expect(systemPreferences.promptTouchID.mock.calls[0][0]).toBe("Make a change on your Cloud home");
    expect(await confirm({ method: "POST", path: "/api/routines/r-1/run" })).toBe(true);
    expect(systemPreferences.promptTouchID.mock.calls[1][0]).toBe("Run a routine now");
    expect(JSON.stringify(systemPreferences.promptTouchID.mock.calls)).not.toMatch(/secret|s3cret/);
  });
  it("a cancelled Touch ID is a no", async () => {
    const systemPreferences = { canPromptTouchID: () => true, promptTouchID: async () => { throw new Error("cancelled"); } };
    expect(await createNativeStepUpConfirm({ systemPreferences, dialog: dialog(0), platform: "darwin" })({ method: "POST", path: "/a" })).toBe(false);
  });
  it("falls back to a confirm dialog without Touch ID and elsewhere; Cancel is a no", async () => {
    const yes = dialog(0), no = dialog(1);
    expect(await createNativeStepUpConfirm({ systemPreferences: { canPromptTouchID: () => false }, dialog: yes, platform: "darwin" })({ method: "PUT", path: "/a" })).toBe(true);
    expect(await createNativeStepUpConfirm({ systemPreferences: {}, dialog: no, platform: "linux", getWindow: () => ({ id: 1 }) })({ method: "PUT", path: "/a" })).toBe(false);
    expect(no.showMessageBox.mock.calls[0]).toHaveLength(2);
  });
});

describe("door v2: the pending key's states", () => {
  it("door: refuses a ticket bound to another key before any request", async () => {
    const ctx = await setup();
    await ctx.client.startConnect();
    const other = generateDeviceKeys();
    const error = await rejects(ctx.client.acceptDoorLink(doorLink(doorTicket(bindOfKey(other.sessionPublicKey)))), "other-connect");
    expect(error.message).toBe(COPY.otherConnect);
    await rejects(ctx.client.acceptDoorLink(doorLink(doorTicket(undefined))), "other-connect"); // a ticket with no bind at all
    expect(ctx.net.homeCalls()).toEqual([]);
    expect((await ctx.client.connectStatus()).lastResult).toMatchObject({ code: "other-connect", message: COPY.otherConnect });
    expect((await ctx.store.loadPending()).attempted).toBeUndefined();
  });

  it("door: lost answer keeps the key and retries as known device", async () => {
    const ctx = await setup();
    const firstDesktop = (await pairHome(ctx)).deviceId; // this home already has a desktop: a second one needs a completed pair hold
    await ctx.client.startConnect();
    const bind = openedBind();
    const key = (await ctx.store.loadPending()).sessionPublicKey;
    loseAnswerOf = "/api/cloud/enter";
    const lost = await rejects(ctx.client.acceptDoorLink(doorLink(doorTicket(bind, { pairHold: "hold-0123456789abcdef" }))), "lost");
    expect(lost.message).toBe(COPY.lostAnswer);
    expect(desktops()).toHaveLength(2); // the home did enroll it, and spent the hold
    const enrolledAtHome = desktops().find((id) => id !== firstDesktop);
    const kept = await ctx.store.loadPending();
    expect(kept.sessionPublicKey).toBe(key);
    expect(kept.attempted).toMatchObject({ homeId: HOME, origin: ORIGIN });
    expect(kept.enrolled).toBeUndefined();
    expect(await ctx.client.connectStatus()).toMatchObject({ pending: true, attempted: true, lastResult: { code: "lost", message: COPY.lostAnswer } });
    // Connect again reuses the same key and reopens the same page; the site mints a new ticket for the same k, with no hold.
    await ctx.client.startConnect();
    expect(openedBind()).toBe(bind);
    expect((await ctx.store.loadPending()).attempted).toMatchObject({ homeId: HOME });
    const done = await ctx.client.acceptDoorLink(doorLink(doorTicket(bind)));
    expect(desktops()).toHaveLength(2);
    expect(done.deviceId).toBe(enrolledAtHome); // the same device id: the home found the key as known
    expect(await ctx.store.loadPending()).toBeNull();
    expect((await ctx.client.connectStatus()).lastResult).toBeNull();
    expect((await ctx.client.fetch(HOME, "/api/bots")).status).toBe(200);
  });

  it("door: 403 reasons map to copy", async () => {
    const ctx = await setup();
    await ctx.client.startConnect();
    const bind = openedBind();
    const cases = [
      ["expired", "expired", COPY.linkExpired],
      ["hold_required", "hold-required", COPY.holdRequired],
      ["too_many_devices", "too-many-devices", COPY.tooManyDevices],
      ["refused", "refused", COPY.connectRefused],
      ["something_new", "refused", COPY.connectRefused],
    ];
    for (const [reason, code, message] of cases) {
      answerOverride = { path: "/api/cloud/enter", status: 403, body: { error: "Door refused", reason } };
      const error = await rejects(ctx.client.acceptDoorLink(doorLink(doorTicket(bind))), code);
      expect(error.message).toBe(message);
      expect((await ctx.client.connectStatus()).lastResult).toMatchObject({ code, message });
      const pending = await ctx.store.loadPending();
      expect(pending.attempted).toBeUndefined(); // the home answered and enrolled nothing: back to made
      expect(pending.lastResult).toMatchObject({ code, message });
    }
    // The real home's refusal for an expired ticket comes back the same way.
    answerOverride = null;
    await rejects(ctx.client.acceptDoorLink(doorLink(doorTicket(bind, { issuedAt: Date.now() - 120_000, stepUpAt: Date.now() - 120_000, expiresAt: Date.now() - 61_000 }))), "expired");
    answerOverride = { path: "/api/cloud/enter", status: 503, body: { error: "busy" } };
    await rejects(ctx.client.acceptDoorLink(doorLink(doorTicket(bind))), "home-busy");
    answerOverride = { path: "/api/cloud/enter", status: 500, body: {} };
    await rejects(ctx.client.acceptDoorLink(doorLink(doorTicket(bind))), "lost"); // a 5xx says nothing about what the home did
    for (const message of Object.values(COPY)) expect(message).not.toMatch(/\u2014|\b(?:safe|safely|safety|unsafe)\b/i);
  });

  it("door: 429 keeps the key with retry-after", async () => {
    const ctx = await setup();
    await ctx.client.startConnect();
    const key = (await ctx.store.loadPending()).sessionPublicKey;
    answerOverride = { path: "/api/cloud/enter", status: 429, body: { error: "Too many attempts" }, headers: { "retry-after": "600" } };
    const error = await rejects(ctx.client.acceptDoorLink(doorLink(doorTicket(openedBind()))), "too-many-tries");
    expect(error.message).toBe(COPY.tooManyTries);
    expect(COPY.tooManyTries).toBe("Too many tries. Wait ten minutes, then press Connect again.");
    const status = await ctx.client.connectStatus();
    expect(status).toMatchObject({ pending: true, attempted: false, lastResult: { code: "too-many-tries", retryAfterMs: 600_000 } });
    expect((await ctx.store.loadPending()).sessionPublicKey).toBe(key);
    await ctx.client.startConnect();
    expect((await ctx.store.loadPending()).sessionPublicKey).toBe(key); // the next Connect reuses it
  });

  it("connect: made pending expires at 10 min, attempted never", async () => {
    let clock = Date.now();
    // The home's signed identity is checked against the client's clock: keep it current as the clock moves.
    const signedAt = (time) => { identityClaims = claimsFor({ issuedAt: time - 1000, expiresAt: time + 600_000 }); };
    const ctx = await setup({ now: () => clock });
    await ctx.client.startConnect();
    const firstBind = openedBind();
    clock += 9 * 60_000;
    expect((await ctx.client.connectStatus()).pending).toBe(true);
    clock += 61_000;
    expect(await ctx.client.connectStatus()).toMatchObject({ pending: false, lastResult: { code: "took-too-long", message: COPY.tookTooLong } });
    expect(await ctx.store.loadPending()).toBeNull();
    expect(await ctx.client.acceptDoorLink(doorLink(doorTicket(firstBind)))).toEqual({ ignored: true }); // no matching pending key
    expect(ctx.net.homeCalls()).toEqual([]);
    // A new Connect makes a new key; its redeem is attempted and the answer is lost.
    await ctx.client.startConnect();
    expect(openedBind()).not.toBe(firstBind);
    signedAt(clock);
    loseAnswerOf = "/api/cloud/enter";
    await rejects(ctx.client.acceptDoorLink(doorLink(doorTicket(openedBind()))), "lost");
    clock += 24 * 60 * 60_000;
    signedAt(clock);
    expect(await ctx.client.connectStatus()).toMatchObject({ pending: true, attempted: true });
    expect((await ctx.store.loadPending()).attempted).toBeTruthy();
    // A fresh process over the same storage still holds it, and still finishes with it.
    const again = createCloudHomeClient({ store: ctx.store, fetch: ctx.net.fetchImpl, appVersion: "1.9.0", confirmStepUp: async () => true, cp: cpConfig, cpEnvironment: "staging", now: () => clock, openExternal: async (url) => { opened.push(url); } });
    expect(await again.connectStatus()).toMatchObject({ pending: true, attempted: true, lastResult: null }); // the words fade after ten minutes; the key does not
    const done = await again.acceptDoorLink(doorLink(doorTicket(openedBind())));
    expect(done.deviceId).toBe(desktops()[0]);
    expect(desktops()).toHaveLength(1);
  });

  it("connect: cancel after lost answer", async () => {
    const ctx = await setup();
    await ctx.client.startConnect();
    loseAnswerOf = "/api/cloud/enter";
    await rejects(ctx.client.acceptDoorLink(doorLink(doorTicket(openedBind()))), "lost");
    expect(await ctx.client.cancelConnect()).toEqual({ pending: false });
    expect(await ctx.store.loadPending()).toBeNull();
    const status = await ctx.client.connectStatus();
    expect(status).toMatchObject({ pending: false, attempted: false, lastResult: { code: "remove-on-my-cloud", message: COPY.removeOnMyCloud } });
    expect(COPY.removeOnMyCloud).toBe("If this computer appears on My Cloud, remove it there.");
    // A Cancel with nothing attempted says nothing.
    await ctx.client.startConnect();
    await ctx.client.cancelConnect();
    expect((await ctx.client.connectStatus()).lastResult).toBeNull();
  });
});
