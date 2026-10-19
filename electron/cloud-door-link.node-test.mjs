// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cloud Door v2, desktop side (design 6.4 + r4.2): the murage://door and murage://connect-cloud links, the sealed pending
// Connect, and the client's startConnect / acceptDoorLink / pasteDoorLink / resume / disconnect. Self-contained: a fake home
// and a fake control-plane identity behind an injected fetch, a fake safeStorage, a real temp directory. No Electron.
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CLOUD_HOME_CP, COPY, CloudHomeError, createCloudHomeClient, resolveCloudCpEnvironment } from "./cloud-home-client.mjs";
import { HOME_ORIGIN, doorLinkFromCommandLine, doorLinkFromDeepLink, doorLinkKind, parseDoorLink, parseOpenCloudLink } from "./cloud-door-link.mjs";
import { createCloudHomeStore } from "./cloud-home-store.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const HOME = "home-1", HEX32 = "0123456789abcdef0123456789abcdef", ORIGIN = `https://h-${HEX32}.murage.ai`, ACCOUNT = "owner-1", SITE = "https://murage.example", CP = "https://cp.test";
const cpKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const cpConfig = { staging: { baseUrl: CP, siteOrigin: SITE, jwk: cpKey.publicKey.export({ format: "jwk" }) }, prod: { baseUrl: "https://prod.test", siteOrigin: SITE, jwk: null } };

const envelope = (claims) => {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { algorithm: "ES256", payload, signature: sign("sha256", Buffer.from(payload), { key: cpKey.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
};
const identityClaims = (over = {}) => ({ type: "murage-home-key-v1", homeId: HOME, generation: 1, homeKey: "home-key-A", publicOrigin: ORIGIN, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 600_000, ...over });
const safeStorage = () => ({
  isAsyncEncryptionAvailable: async () => true,
  getSelectedStorageBackend: () => "gnome_libsecret",
  encryptString: (s) => Buffer.from("ENC1:" + Buffer.from(s).toString("base64")),
  decryptString: (b) => Buffer.from(b.toString().slice(5), "base64").toString(),
});
const bindOf = (publicKeyPem) => createHash("sha256").update(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" })).digest("hex");
/** The k the browser was last sent to: a ticket the site mints is bound to it. */
const currentBind = () => (opened.length ? new URL(opened.at(-1).url).searchParams.get("k") : undefined);
const ticketFor = (over = {}, tail = "c2lnbmF0dXJl") => `${Buffer.from(JSON.stringify({ account: ACCOUNT, homeId: HOME, publicOrigin: ORIGIN, bind: currentBind(), ...over })).toString("base64url")}.${tail}`;
const doorUrl = (ticket, { h = HOME, o = ORIGIN } = {}) => `murage://door?h=${encodeURIComponent(h)}&o=${encodeURIComponent(o)}#t=${ticket}`;

// Every console line, so a test can prove a ticket never reached a log.
const logged = [];
for (const method of ["log", "info", "warn", "error", "debug"]) {
  const original = console[method].bind(console);
  console[method] = (...args) => { logged.push(args.map(String).join(" ")); original(...args); };
}

let root, home, opened, storeDir;
function newHome() {
  return {
    identity: identityClaims(), enter: { status: 200, body: { state: "signed-in", reason: "signed_in_first", deviceId: "dev-1", scope: "owner-desktop", expiresIn: 900, accessToken: "tok-1" } },
    refreshStatus: 200, refreshReason: undefined, healthStatus: 200, healthFailures: 0, forgetStatus: 200, forgetRefusedFor: [], hold: null, calls: [],
  };
}
function fetchImpl(url, init = {}) {
  const u = new URL(url), method = init.method ?? "GET", headers = Object.fromEntries(new Headers(init.headers).entries());
  const body = init.body ? JSON.parse(init.body) : undefined;
  home.calls.push({ origin: u.origin, method, path: u.pathname, headers, body });
  const json = (value, status = 200) => Response.json(value, { status });
  if (u.origin !== ORIGIN) return json({}, 404);
  if (u.pathname === "/.well-known/murage/environment") return json({ environmentId: "env-1", homeKey: envelope(home.identity) });
  if (u.pathname === "/api/health") {
    // only the signed-in check after /enter fails; the anonymous one before it answers
    if (home.healthFailures > 0 && headers.authorization) { home.healthFailures--; return json({}, home.healthStatus); }
    return json({ app: "murage", serverVersion: "1.4.2", protocol: 1 });
  }
  if (u.pathname === "/api/cloud/enter" && method === "POST") {
    if (home.enter.status === 200) {
      const okProof = verify(null, Buffer.from(`murage-door-v2:${body.ticket}`), createPublicKey(body.device.publicKey), Buffer.from(body.device.proof, "base64url"));
      if (!okProof) return json({ error: "bad proof" }, 403);
    }
    return json(home.enter.body, home.enter.status);
  }
  const refusedBody = () => ({ error: "That sign-in request was refused.", ...(home.refreshReason ? { reason: home.refreshReason } : {}) });
  if (u.pathname === "/api/cloud/challenge") return home.refreshStatus === 403 ? json(refusedBody(), 403) : json({ challenge: "c1", environmentId: "env-1" });
  if (u.pathname === "/api/cloud/refresh") return home.refreshStatus === 403 ? json(refusedBody(), 403) : json({ accessToken: "tok-2", scope: "owner-desktop" });
  if (u.pathname === "/api/cloud/devices/forget" && method === "POST") return home.forgetStatus === 200 && !home.forgetRefusedFor.includes(headers.authorization) ? json({ forgotten: true }) : json({ error: "busy" }, home.forgetStatus === 200 ? 503 : home.forgetStatus);
  if (u.pathname === "/api/cloud/devices/dev-1" && method === "DELETE") return home.refreshStatus === 403 ? json({ error: "Open this on a device you've paired with your Cloud." }, 403) : json({ revoked: true });
  return json({}, 404);
}

const slept = [];
/** A request to `path` waits until release(); `reached` resolves when it arrives. */
function holdAt(pathname) {
  let release, reached;
  const arrived = new Promise((resolve) => { reached = resolve; });
  home.hold = { path: pathname, wait: new Promise((resolve) => { release = resolve; }), reached };
  return { arrived, release: () => release() };
}
async function holdingFetch(url, init) {
  const hold = home.hold;
  if (hold && new URL(url).pathname === hold.path) { home.hold = null; hold.reached(); await hold.wait; }
  return fetchImpl(url, init);
}
function makeClient() {
  const store = createCloudHomeStore({ safeStorage: safeStorage(), directory: storeDir, platform: "darwin" });
  const client = createCloudHomeClient({
    store, fetch: holdingFetch, appVersion: "1.9.0", confirmStepUp: async () => true, cp: cpConfig, cpEnvironment: "staging",
    schedule: () => 0, sleep: async (ms) => { slept.push(ms); }, openExternal: async (url) => { opened.push({ url, pendingFileExisted: existsSync(path.join(storeDir, "cloud-connect-pending.bin")) }); },
  });
  return { store, client };
}
const pendingKeys = async (store) => store.loadPending();
const enterPosts = () => home.calls.filter((c) => c.path === "/api/cloud/enter");
const refused = async (promise, code) => {
  const error = await promise.then(() => null, (e) => e);
  assert.ok(error instanceof CloudHomeError, `expected a CloudHomeError, got ${error}`);
  assert.equal(error.code, code);
  return error;
};

test.beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "door-link-")); storeDir = path.join(root, "store"); home = newHome(); opened = []; logged.length = 0; slept.length = 0;
});
test.afterEach(() => { safeWipeSync(root); });

// ── the links ──────────────────────────────────────────────────────────────────────────────────────────────

test("a door link is parsed from its query and fragment; anything else is null", () => {
  const ticket = ticketFor();
  assert.deepEqual(parseDoorLink(doorUrl(ticket)), { homeId: HOME, origin: ORIGIN, ticket });
  assert.equal(parseDoorLink("murage://install?url=https%3A%2F%2Fgithub.com%2Fa%2Fb.md"), null);
  assert.equal(parseDoorLink(`https://x.example/door?h=${HOME}&o=${ORIGIN}#t=${ticket}`), null);
  assert.equal(parseDoorLink(doorUrl(ticket, { h: "bad id!" })), null);
  assert.equal(parseDoorLink(doorUrl(ticket, { o: ORIGIN.replace("https:", "http:") })), null);
  assert.equal(parseDoorLink(doorUrl(ticket, { o: `${ORIGIN}/path` })), null);
  assert.equal(parseDoorLink(`murage://door?h=${HOME}&o=${ORIGIN}`), null, "no fragment");
  assert.equal(parseDoorLink(`murage://door?h=${HOME}&o=${ORIGIN}#t=nodot`), null, "not a ticket");
  assert.equal(parseDoorLink(`murage://door?h=${HOME}&o=${ORIGIN}#t=${"a".repeat(8300)}.b`), null, "over 8300 characters");
  assert.ok(parseDoorLink(`murage://door?h=${HOME}&o=${ORIGIN}#t=${"a".repeat(8000)}.b`));
  assert.equal(parseDoorLink(`murage://door?h=${HOME}&o=${ORIGIN}&x=1#t=${ticket}&y=2`), null, "extra fragment text is not a ticket");
});

test("door: origin must be h-<32 hex>.murage.ai", () => {
  const ticket = ticketFor();
  assert.ok(parseDoorLink(doorUrl(ticket)));
  assert.ok(HOME_ORIGIN.test(ORIGIN));
  const refusedOrigins = [
    `https://h-${HEX32.slice(1)}.murage.ai`, // 31 hex
    `https://h-${HEX32}0.murage.ai`, // 33 hex
    `https://h-${HEX32.toUpperCase()}.murage.ai`, // uppercase
    `https://h-${HEX32}.murage.ai:8443`, // port
    `https://h-${HEX32}.murage.ai/enter`, // path
    `https://h-${HEX32}.murage.ai/`, // trailing slash
    `http://h-${HEX32}.murage.ai`, // not https
    `https://h-${HEX32}.murage.ai.evil.example`, // another domain
    `https://x.h-${HEX32}.murage.ai`, // a subdomain
    `https://h-${HEX32.replace("a", "g")}.murage.ai`, // not hex
    "https://murage.ai", "https://home.example",
  ];
  for (const origin of refusedOrigins) {
    assert.equal(parseDoorLink(doorUrl(ticket, { o: origin })), null, origin);
    assert.equal(HOME_ORIGIN.test(origin), false, origin);
  }
});

test("open-cloud: parses h", () => {
  const homeId = "home-0123456789abcdef01234567";
  assert.equal(doorLinkKind(`murage://open-cloud?h=${homeId}`), "open-cloud");
  assert.deepEqual(doorLinkFromDeepLink(`murage://open-cloud?h=${homeId}`), { kind: "open-cloud", url: `murage://open-cloud?h=${homeId}` });
  assert.deepEqual(parseOpenCloudLink(`murage://open-cloud?h=${homeId}`), { homeId });
  assert.deepEqual(parseOpenCloudLink(`  murage://open-cloud?h=${homeId}  `), { homeId });
  assert.equal(doorLinkFromCommandLine(["Murage", `murage://open-cloud?h=${homeId}`])?.kind, "open-cloud");
  assert.equal(parseOpenCloudLink("murage://connect-cloud"), null, "another kind");
  assert.equal(parseOpenCloudLink(doorUrl(ticketFor())), null, "a door link is not open-cloud");
});

test("open-cloud: bad h means connect", () => {
  for (const h of ["", "home-1", "home-0123456789ABCDEF01234567", "home-0123456789abcdef0123456", "home-0123456789abcdef012345678", "../x", "home-0123456789abcdef01234567&x=1"]) {
    assert.deepEqual(parseOpenCloudLink(`murage://open-cloud?h=${encodeURIComponent(h)}`), { homeId: null }, h);
  }
  assert.deepEqual(parseOpenCloudLink("murage://open-cloud"), { homeId: null });
});

test("doorLinkFromDeepLink: door, connect-cloud and open-cloud only", () => {
  assert.deepEqual(doorLinkFromDeepLink("murage://connect-cloud"), { kind: "connect-cloud", url: "murage://connect-cloud" });
  assert.equal(doorLinkFromDeepLink(doorUrl(ticketFor()))?.kind, "door");
  assert.equal(doorLinkFromDeepLink("murage://install?url=x"), null);
  assert.equal(doorLinkFromDeepLink("https://murage.ai/door"), null);
  assert.equal(doorLinkFromDeepLink("not a url"), null);
  assert.equal(doorLinkFromDeepLink(undefined), null);
});

test("doorLinkFromCommandLine takes only the FIRST murage:// argument", () => {
  const door = doorUrl(ticketFor());
  assert.equal(doorLinkFromCommandLine(["Murage", "--flag", door])?.kind, "door");
  assert.equal(doorLinkFromCommandLine(["Murage", "murage://connect-cloud"])?.kind, "connect-cloud");
  assert.equal(doorLinkFromCommandLine(["Murage", "murage://install?url=https%3A%2F%2Fgithub.com%2Fa%2Fb.md", door]), null, "a later door link does not rescue an earlier package link");
  assert.equal(doorLinkFromCommandLine(["Murage", door, "murage://connect-cloud"])?.url, door);
  assert.equal(doorLinkFromCommandLine(["Murage", "--flag"]), null);
  assert.equal(doorLinkFromCommandLine(undefined), null);
});

// ── startConnect / the sealed pending Connect ─────────────────────────────────────────────────────────

test("startConnect opens exactly connect-app?k=<sha256 of the session key DER>, with the pending pair sealed and saved BEFORE the browser opens", async () => {
  const { client, store } = makeClient();
  const started = await client.startConnect();
  assert.equal(started.pending, true);
  const pending = await pendingKeys(store);
  const k = bindOf(pending.sessionPublicKey);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].url, `${SITE}/home/cloud/connect-app?k=${k}`);
  assert.equal(opened[0].pendingFileExisted, true, "sealed on disk before the browser opened");
  const onDisk = readFileSync(path.join(storeDir, "cloud-connect-pending.bin")).toString();
  assert.ok(!onDisk.includes("PRIVATE KEY"), "the file is sealed, not plain");
  assert.notEqual(pending.sessionPrivateKey, pending.assertionPrivateKey);
  assert.deepEqual(readdirSync(storeDir).filter((n) => /^cloud-home-[\w-]+\.bin$/.test(n)), [], "a pending Connect is not a paired home");
  assert.deepEqual(await client.pairedHomes(), []);
  assert.deepEqual({ ...(await client.connectStatus()), startedAt: 0 }, { pending: true, startedAt: 0, attempted: false, paired: false, lastResult: null, disconnected: false, open: true });
});

test("a second startConnect reuses the pending key (one pending Connect at a time) and reopens the same page", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  const first = await pendingKeys(store);
  await client.startConnect();
  const second = await pendingKeys(store);
  assert.equal(second.sessionPrivateKey, first.sessionPrivateKey);
  assert.equal(second.assertionPrivateKey, first.assertionPrivateKey);
  assert.equal(opened.length, 2);
  assert.equal(opened[1].url, opened[0].url, "Connect again opens the same k");
});

test("restart: a new client over the same storage resumes the same pending key and enrolls with it", async () => {
  const a = makeClient();
  await a.client.startConnect();
  const k = new URL(opened[0].url).searchParams.get("k");
  const b = makeClient(); // the app restarted: nothing in memory, only the sealed file
  assert.equal((await b.client.connectStatus()).pending, true);
  await b.client.startConnect();
  assert.equal(new URL(opened[1].url).searchParams.get("k"), k, "same key after a restart");
  const result = await b.client.acceptDoorLink(doorUrl(ticketFor()));
  assert.equal(result.homeId, HOME);
  const sent = enterPosts()[0].body.device;
  assert.equal(bindOf(sent.publicKey), k, "the home saw the key the browser was told about");
});

test("restart without pressing Connect again: a fresh process can still finish from the link", async () => {
  await makeClient().client.startConnect();
  const b = makeClient();
  const result = await b.client.acceptDoorLink(doorUrl(ticketFor()));
  assert.equal(result.homeId, HOME);
  assert.equal((await b.client.connectStatus()).pending, false);
});

test("cancelConnect clears the pending key; the next Connect makes a new one", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  const k = new URL(opened[0].url).searchParams.get("k");
  await client.cancelConnect();
  assert.equal(existsSync(path.join(storeDir, "cloud-connect-pending.bin")), false);
  assert.equal(await store.loadPending(), null);
  assert.equal((await client.connectStatus()).pending, false);
  assert.deepEqual(await client.acceptDoorLink(doorUrl(ticketFor())), { ignored: true });
  await client.startConnect();
  assert.notEqual(new URL(opened[1].url).searchParams.get("k"), k);
});

test("a production (packaged) build resolves the prod control plane and opens murage.ai, never the staging preview", async () => {
  assert.equal(resolveCloudCpEnvironment({ isPackaged: true, environment: {} }), "prod");
  assert.equal(resolveCloudCpEnvironment({ isPackaged: false, environment: {} }), "staging");
  assert.equal(resolveCloudCpEnvironment({ isPackaged: true, environment: { MURAGE_CLOUD_CP: "staging" } }), "staging", "staging only when asked for");
  assert.equal(resolveCloudCpEnvironment({ isPackaged: false, environment: { MURAGE_CLOUD_CP: "prod" } }), "prod");
  assert.equal(resolveCloudCpEnvironment({ isPackaged: true, environment: { MURAGE_CLOUD_CP: "preview" } }), "prod", "an unknown value falls back to the build's own default");
  assert.equal(CLOUD_HOME_CP.prod.siteOrigin, "https://murage.ai");
  assert.equal(CLOUD_HOME_CP.prod.baseUrl, "https://accounts.murage.ai");
  // The built-in config pins the production verification key (public P-256 members only). Whether Cloud shows to customers is
  // the runtime live gate's call, not this client's.
  assert.deepEqual(Object.keys(CLOUD_HOME_CP.prod.jwk).sort(), ["crv", "kty", "x", "y"]);
  assert.equal(CLOUD_HOME_CP.prod.jwk.d, undefined);
  const store = createCloudHomeStore({ safeStorage: safeStorage(), directory: storeDir, platform: "darwin" });
  const packaged = { store, fetch: async (url, init) => fetchImpl(url, init), appVersion: "1.9.0", confirmStepUp: async () => true, schedule: () => 0, openExternal: async (url) => { opened.push({ url }); } };
  // A table whose prod entry has no key is still refused: no browser, no key sealed, nothing sent.
  const keyless = { ...CLOUD_HOME_CP, prod: { ...CLOUD_HOME_CP.prod, jwk: null } };
  const closed = createCloudHomeClient({ ...packaged, cp: keyless, cpEnvironment: "prod" });
  const notOpen = await refused(closed.startConnect(), "not-open");
  assert.equal(notOpen.message, COPY.notOpen);
  assert.equal(opened.length, 0, "no browser");
  assert.equal(existsSync(path.join(storeDir, "cloud-connect-pending.bin")), false, "no key sealed");
  assert.equal(home.calls.length, 0, "nothing sent");
  assert.equal((await closed.connectStatus()).open, false);
  // With the shipped key, the same code opens murage.ai, never the staging preview. With no environment passed it defaults to prod.
  const ready = createCloudHomeClient({ ...packaged, cpEnvironment: resolveCloudCpEnvironment({ isPackaged: true, environment: {} }) });
  assert.equal((await ready.connectStatus()).open, true);
  await ready.startConnect();
  assert.equal(opened.length, 1);
  assert.equal(new URL(opened[0].url).origin, "https://murage.ai");
  assert.match(opened[0].url, /^https:\/\/murage\.ai\/home\/cloud\/connect-app\?k=[0-9a-f]{64}$/);
  assert.ok(!opened[0].url.includes("vercel.app"));
  assert.equal((await createCloudHomeClient(packaged).connectStatus()).open, true, "bare client defaults to prod");
  // The staging entry has its key: a development run is open as before.
  assert.equal((await createCloudHomeClient({ ...packaged, cp: cpConfig, cpEnvironment: "staging" }).connectStatus()).open, true);
});

test("startConnect needs a safe place to keep keys and a real site origin", async () => {
  const store = createCloudHomeStore({ safeStorage: { ...safeStorage(), getSelectedStorageBackend: () => "basic_text" }, directory: storeDir, platform: "linux" });
  const client = createCloudHomeClient({ store, fetch: async () => fetchImpl(), appVersion: "1.9.0", confirmStepUp: async () => true, cp: cpConfig, cpEnvironment: "staging", openExternal: async (url) => opened.push({ url }) });
  await assert.rejects(client.startConnect());
  assert.equal(opened.length, 0, "no browser when the key could not be kept");
  const bare = createCloudHomeClient({ store: makeClient().store, fetch: async () => fetchImpl(), appVersion: "1.9.0", confirmStepUp: async () => true, cp: { staging: { baseUrl: CP, jwk: cpConfig.staging.jwk } }, cpEnvironment: "staging", openExternal: async (url) => opened.push({ url }) });
  await refused(bare.startConnect(), "pairing-refused");
  assert.equal(opened.length, 0);
});

// ── acceptDoorLink ─────────────────────────────────────────────────────────────────────────────────────

test("acceptDoorLink ignores a link when no Connect is pending: nothing is sent", async () => {
  const { client } = makeClient();
  assert.deepEqual(await client.acceptDoorLink(doorUrl(ticketFor())), { ignored: true });
  assert.equal(home.calls.length, 0);
});

test("an identity mismatch is refused BEFORE any POST", async () => {
  const { client } = makeClient();
  await client.startConnect();
  home.identity = identityClaims({ homeId: "other-home" });
  await refused(client.acceptDoorLink(doorUrl(ticketFor())), "pin-mismatch");
  home.identity = identityClaims({ publicOrigin: "https://elsewhere.example" });
  await refused(client.acceptDoorLink(doorUrl(ticketFor())), "pin-mismatch");
  assert.equal(enterPosts().length, 0, "the ticket was never posted");
  assert.equal((await client.connectStatus()).pending, true, "the pending Connect is kept");
});

test("a ticket that names another home or origin is refused before anything is sent", async () => {
  const { client } = makeClient();
  await client.startConnect();
  await refused(client.acceptDoorLink(doorUrl(ticketFor({ homeId: "other-home" }))), "bad-link");
  await refused(client.acceptDoorLink(doorUrl(ticketFor({ publicOrigin: "https://elsewhere.example" }))), "bad-link");
  await refused(client.acceptDoorLink(doorUrl(ticketFor({ account: "" }))), "bad-link");
  await refused(client.acceptDoorLink("murage://door?h=x"), "bad-link");
  assert.equal(home.calls.length, 0);
});

test("a good link posts ONCE with Origin: o, a proof by the session key, and saves the record", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  const pending = await pendingKeys(store);
  const ticket = ticketFor();
  const result = await client.acceptDoorLink(doorUrl(ticket));
  assert.deepEqual(result, { homeId: HOME, deviceId: "dev-1", publicOrigin: ORIGIN, generation: 1 });
  const posts = enterPosts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers.origin, ORIGIN);
  assert.equal(posts[0].body.ticket, ticket);
  assert.equal(posts[0].body.device.deviceId, null);
  assert.equal(posts[0].body.device.publicKey, pending.sessionPublicKey);
  assert.equal(posts[0].body.device.assertionKey, pending.assertionPublicKey);
  assert.ok(verify(null, Buffer.from(`murage-door-v2:${ticket}`), createPublicKey(pending.sessionPublicKey), Buffer.from(posts[0].body.device.proof, "base64url")));
  const record = await store.load(HOME);
  assert.deepEqual({ homeId: record.homeId, publicOrigin: record.publicOrigin, deviceId: record.deviceId, account: record.account, environmentId: record.environmentId, homeKey: record.homeKey, generation: record.generation, cpEnvironment: record.cpEnvironment },
    { homeId: HOME, publicOrigin: ORIGIN, deviceId: "dev-1", account: ACCOUNT, environmentId: "env-1", homeKey: "home-key-A", generation: 1, cpEnvironment: "staging" });
  assert.equal(record.sessionPrivateKey, pending.sessionPrivateKey);
  assert.equal(record.assertionPrivateKey, pending.assertionPrivateKey);
  assert.ok(!JSON.stringify(record).includes("tok-1"), "the token is never stored");
  assert.equal(await store.loadPending(), null, "the pending key is cleared once enrolled");
  assert.deepEqual(await client.pairedHomes(), [{ homeId: HOME, origin: ORIGIN }]);
  assert.equal(await client.getAccessToken(HOME), "tok-1");
  assert.deepEqual(await client.acceptDoorLink(doorUrl(ticket)), { ignored: true }, "a replayed link finds no pending Connect");
  assert.equal(enterPosts().length, 1);
});

test("refusals map to plain copy and keep the pending Connect", async () => {
  const { client } = makeClient();
  await client.startConnect();
  const cases = [
    [{ status: 403, body: { error: "x", reason: "expired" } }, "expired", COPY.linkExpired],
    [{ status: 403, body: { error: "x", reason: "hold_required" } }, "hold-required", COPY.holdRequired],
    [{ status: 403, body: { error: "x", reason: "too_many_devices" } }, "too-many-devices", COPY.tooManyDevices],
    [{ status: 403, body: { error: "x", reason: "refused" } }, "refused", COPY.connectRefused],
    [{ status: 429, body: { error: "slow down" } }, "too-many-tries", COPY.tooManyTries],
    [{ status: 503, body: { error: "busy" } }, "home-busy", COPY.homeBusy],
    [{ status: 500, body: {} }, "lost", COPY.lostAnswer],
  ];
  for (const [answer, code, message] of cases) {
    home.enter = answer;
    const error = await refused(client.acceptDoorLink(doorUrl(ticketFor())), code);
    assert.equal(error.message, message);
    const { lastResult } = await client.connectStatus();
    assert.deepEqual({ code: lastResult.code, message: lastResult.message }, { code, message });
  }
  assert.equal(COPY.holdRequired, "Start adding this computer on My Cloud. It can connect after the 72-hour check.");
  assert.equal(COPY.linkExpired, "This link has expired. Press Connect again.");
  assert.equal((await client.connectStatus()).pending, true);
  assert.deepEqual(await client.pairedHomes(), []);
  for (const copy of [COPY.holdRequired, COPY.linkExpired, COPY.badLink, COPY.disconnected, COPY.connectRefused, COPY.tooManyTries, COPY.tooManyDevices, COPY.homeBusy, COPY.lostAnswer, COPY.tookTooLong, COPY.removeOnMyCloud, COPY.otherConnect, COPY.notLive]) {
    assert.ok(!/—|\bsafe\b|\bunsafe\b/i.test(copy), copy);
  }
});

test("the link and its ticket never reach a log", async () => {
  const { client } = makeClient();
  await client.startConnect();
  const ticket = ticketFor({}, "SECRETTAIL0123456789");
  home.enter = { status: 403, body: { reason: "expired" } };
  await refused(client.acceptDoorLink(doorUrl(ticket)), "expired");
  home.enter = newHome().enter;
  await client.acceptDoorLink(doorUrl(ticket));
  await refused(client.pasteDoorLink(`https://x.example/?t=${ticket}`), "bad-link");
  assert.equal(logged.filter((line) => line.includes("SECRETTAIL") || line.includes(ticket)).length, 0);
});

test("main.mjs logs a reason only for a Cloud link, queues every source, and wires the hooks", () => {
  const main = readFileSync(path.join(electronDir, "main.mjs"), "utf8");
  const start = main.indexOf("async function handleCloudLink"), end = main.indexOf('app.on("second-instance"');
  assert.ok(start > 0 && end > start);
  const block = main.slice(start, end);
  const consoleLines = block.split("\n").filter((line) => /console\./.test(line));
  assert.ok(consoleLines.length >= 6);
  for (const line of consoleLines) assert.ok(/\[cloud\] door: /.test(line) && !/\burl\b|\blink\b|rawLink|commandLine|ticket/i.test(line.replace("[cloud] door: ", "")), line);
  assert.match(block, /function queueCloudLink\(rawLink\)/);
  assert.doesNotMatch(main, /void handleDoorLink|handleCloudLink\(link\);/, "nothing handles a link outside the queue");
  assert.match(main, /app\.on\("open-url", \(event, url\) => \{\s*if \(queueCloudLink\(url\)\)/);
  const second = main.slice(end, main.indexOf("// Packaged: the harness"));
  assert.match(second, /doorLinkFromCommandLine\(commandLine\)/);
  assert.match(second, /queueCloudLink\(cloudLink\)/);
  assert.ok(second.indexOf("CLOSED_DUE_FLAG") < second.indexOf("doorLinkFromCommandLine"));
  // Drains: the window's load, the end of startup, the live flip.
  assert.match(main, /did-finish-load", \(\) => \{ deliverPackageInstall\(win\); cloudLinks\.drain\(\); \}/);
  assert.match(main, /desktopStartup\.then\(\(\) => cloudLinks\.drain\(\)\)/);
  assert.match(main, /onActiveChange\(\(live\) => \{ if \(live\) cloudLinks\.drain\(\); \}\)/);
  // The handoff runs first thing at ready; the Linux handler at ready; the not-live words are main's own.
  assert.match(main, /app\.whenReady\(\)\.then\(async \(\) => \{\s*if \(await takeLaunchCloudLink\(\)\) return;/);
  assert.match(main, /process\.platform === "linux"\) void ensureLinuxUrlHandler\(\{ app \}\)/);
  assert.match(block, /probe: async \(\) => \{ if \(!cloudHome\) return false; await cloudLive\.probeNow\(\); return cloudHome\.active\(\) === true; \}/);
  assert.match(block, /message: CLOUD_COPY\.notLive/);
  assert.match(main, /powerMonitor\.on\("resume",\(\)=>\{\s*const client=cloudHome\?\.client;[\s\S]*client\.resume\(homeId\)/);
  // The window hears a kind and an open-cloud home id, never the link.
  for (const send of block.match(/send\("cloud-home:link-event"[^)]*\)/g) ?? []) assert.doesNotMatch(send, /url|link\.url|ticket/, send);
});

// ── pasteDoorLink ────────────────────────────────────────────────────────────────────────────────────────

test("pasteDoorLink refuses https:// links, murage://package and junk, and accepts a copied door link", async () => {
  const { client } = makeClient();
  await client.startConnect();
  const ticket = ticketFor();
  await refused(client.pasteDoorLink(`https://${ORIGIN.slice(8)}/enter#t=${ticket}`), "bad-link");
  await refused(client.pasteDoorLink("murage://package?url=https%3A%2F%2Fgithub.com%2Fa%2Fb.md"), "bad-link");
  await refused(client.pasteDoorLink("murage://install?url=https%3A%2F%2Fgithub.com%2Fa%2Fb.md"), "bad-link");
  await refused(client.pasteDoorLink("hello"), "bad-link");
  await refused(client.pasteDoorLink(""), "bad-link");
  await refused(client.pasteDoorLink(undefined), "bad-link");
  await refused(client.pasteDoorLink("murage://door" + "x".repeat(9000)), "bad-link");
  assert.equal(home.calls.length, 0);
  assert.equal(COPY.badLink, "That is not a Murage connect link.");
  const done = await client.pasteDoorLink(`  ${doorUrl(ticket)}  `);
  assert.equal(done.homeId, HOME);
  assert.equal(enterPosts().length, 1);
});

// ── resume / disconnect ──────────────────────────────────────────────────────────────────────────────────

test("resume refreshes silently through challenge and refresh", async () => {
  const { client } = makeClient();
  await client.startConnect();
  await client.acceptDoorLink(doorUrl(ticketFor()));
  home.calls.length = 0;
  assert.deepEqual(await client.resume(HOME), { ok: true });
  assert.deepEqual(home.calls.map((c) => c.path), ["/api/cloud/challenge", "/api/cloud/refresh"]);
  assert.equal(await client.getAccessToken(HOME), "tok-2");
});

test("resume: a 403 that says revoked; the record is forgotten and the Connect panel gets its notice", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  await client.acceptDoorLink(doorUrl(ticketFor()));
  home.refreshStatus = 403; home.refreshReason = "revoked";
  const result = await client.resume(HOME);
  assert.deepEqual(result, { ok: false, disconnected: true, code: "disconnected", message: "This computer was disconnected from your Cloud home. Connect it again." });
  assert.equal(await store.load(HOME), null);
  assert.deepEqual(await client.pairedHomes(), []);
  assert.equal((await client.connectStatus()).disconnected, true);
  await client.startConnect();
  assert.equal((await client.connectStatus()).disconnected, false, "pressing Connect clears the notice");
});

test("resume: a paused (suspended) account keeps the credential, and the computer comes back when the home lets it in", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  await client.acceptDoorLink(doorUrl(ticketFor()));
  home.refreshStatus = 403; home.refreshReason = "suspended";
  const result = await client.resume(HOME);
  assert.deepEqual(result, { ok: false, code: "suspended", message: COPY.suspended });
  assert.ok(await store.load(HOME), "the record stays");
  assert.equal((await client.connectStatus()).disconnected, false);
  assert.deepEqual((await client.pairedHomes()).map((h) => h.homeId), [HOME]);
  home.refreshStatus = 200; home.refreshReason = undefined;
  assert.deepEqual(await client.resume(HOME), { ok: true }, "unsuspended: the same credential works again");
});

test("resume: a 403 with no reason is not a revocation either", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  await client.acceptDoorLink(doorUrl(ticketFor()));
  home.refreshStatus = 403;
  assert.deepEqual(await client.resume(HOME), { ok: false, code: "sign-in-refused", message: COPY.signInRefused });
  assert.ok(await store.load(HOME), "the record stays");
});

test("disconnect while the account is paused does not forget a device the home still has", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  await client.acceptDoorLink(doorUrl(ticketFor()));
  home.refreshStatus = 403; home.refreshReason = "suspended";
  await client.resume(HOME);
  await assert.rejects(client.disconnect(HOME));
  assert.ok(await store.load(HOME), "kept: the home still lists this computer");
});

// ── after the home enrolled the key (Astra 4A High 2) ─────────────────────────────────────────────────

test("a health failure after /enter keeps the enrolled record and retries with backoff", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  home.healthStatus = 503; home.healthFailures = 2;
  const done = await client.acceptDoorLink(doorUrl(ticketFor()));
  assert.equal(done.homeId, HOME);
  assert.deepEqual(slept, [1_000, 3_000], "two waits, growing");
  assert.ok(await store.load(HOME));
  assert.equal(await store.loadPending(), null);
});

test("a home that stays down after /enter: the record is still kept and the computer is connected", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  home.healthStatus = 503; home.healthFailures = 99;
  await refused(client.acceptDoorLink(doorUrl(ticketFor())), "unreachable");
  assert.equal(enterPosts().length, 1);
  const record = await store.load(HOME);
  assert.equal(record.deviceId, "dev-1", "never deleted: the ticket is spent and the home has this device");
  assert.deepEqual((await client.pairedHomes()).map((h) => h.homeId), [HOME]);
  assert.equal((await client.connectStatus()).pending, false);
  home.healthFailures = 0;
  assert.deepEqual(await client.resume(HOME), { ok: true }, "refresh works with the saved device id");
});

test("the device id is sealed with the pending keys as soon as /enter answers, so a failed save finishes later", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  const save = store.save;
  let failOnce = true;
  store.save = async (record) => { if (failOnce) { failOnce = false; throw new Error("disk full"); } return save.call(store, record); };
  await assert.rejects(client.acceptDoorLink(doorUrl(ticketFor())));
  const sealed = await store.loadPending();
  assert.equal(sealed.enrolled.deviceId, "dev-1");
  assert.equal(sealed.enrolled.homeId, HOME);
  assert.equal(await store.load(HOME), null);
  const status = await client.connectStatus();
  assert.equal(status.paired, true, "finished from the sealed keys, no second link");
  assert.equal(enterPosts().length, 1);
  assert.equal((await store.load(HOME)).deviceId, "dev-1");
  assert.equal(await store.loadPending(), null);
});

// ── Cancel during an exchange (Astra 4A Medium 3) ─────────────────────────────────────────────────────

test("Cancel while the home identity is checked: nothing is posted and nothing is saved", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  const hold = holdAt("/.well-known/murage/environment");
  const accepting = client.acceptDoorLink(doorUrl(ticketFor()));
  await hold.arrived;
  await client.cancelConnect();
  hold.release();
  await refused(accepting, "cancelled");
  assert.equal(enterPosts().length, 0, "the ticket was never posted");
  assert.equal(await store.load(HOME), null);
  assert.equal(await store.loadPending(), null);
});

test("Cancel while /enter is in flight: the enrolled device forgets itself and nothing is saved", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  const hold = holdAt("/api/cloud/enter");
  const accepting = client.acceptDoorLink(doorUrl(ticketFor()));
  await hold.arrived;
  await client.cancelConnect();
  hold.release();
  await refused(accepting, "cancelled");
  const forget = home.calls.find((c) => c.path === "/api/cloud/devices/forget");
  assert.ok(forget, "the device the home just enrolled is removed again");
  assert.equal(forget.headers.authorization, "Bearer tok-1");
  assert.equal(await store.load(HOME), null);
  assert.equal(await store.loadPending(), null);
});

// ── Cancel after the home enrolled the key (Astra 4A R2 High 1 + Medium 3) ─────────────────────────────────────

const forgetPosts = () => home.calls.filter((c) => c.path === "/api/cloud/devices/forget");
/** Stalls the first call to store[method] that `when` accepts until release(). */
function holdStore(store, method, when = () => true) {
  const original = store[method].bind(store);
  let release, reached;
  const arrived = new Promise((resolve) => { reached = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  let held = false;
  store[method] = async (...args) => { if (!held && when(...args)) { held = true; reached(); await wait; } return original(...args); };
  return { arrived, release: () => release() };
}
const settled = (promise) => { let done = false; promise.then(() => { done = true; }, () => { done = true; }); return () => done; };

test("Cancel while /enter is in flight and the home cannot forget the device yet: the credentials are kept until the home confirms", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  home.forgetStatus = 503;
  const hold = holdAt("/api/cloud/enter");
  const accepting = client.acceptDoorLink(doorUrl(ticketFor()));
  await hold.arrived;
  await client.cancelConnect();
  hold.release();
  await refused(accepting, "cancelled");
  assert.equal(forgetPosts().length, 1, "one forget was tried with the enrollment token");
  assert.equal(forgetPosts()[0].headers.authorization, "Bearer tok-1");
  assert.equal(await store.load(HOME), null, "not a paired home");
  assert.equal(await store.loadPending(), null, "the Connect is cancelled");
  assert.equal((await client.connectStatus()).paired, false);
  let queued = await store.loadRevocations();
  assert.equal(queued.length, 1, "the device the home still has is kept for removal");
  assert.equal(queued[0].deviceId, "dev-1");
  assert.equal(queued[0].publicOrigin, ORIGIN);
  assert.ok(typeof queued[0].sessionPrivateKey === "string" && queued[0].sessionPrivateKey.includes("PRIVATE KEY"), "the session key signs the retry's sign-in");
  assert.ok(existsSync(path.join(storeDir, "cloud-revoke-pending.bin")));
  // The home answered 503 again on that status call's retry; the entry stays.
  queued = await store.loadRevocations();
  assert.equal(queued.length, 1);
  // The home is back: the next door open signs in with the kept key, forgets the device, and the queue empties.
  home.forgetStatus = 200;
  const before = home.calls.length;
  const next = makeClient().client; // a restart: a fresh client over the same storage
  await next.connectStatus();
  const retry = home.calls.slice(before);
  assert.deepEqual(retry.map((c) => c.path), ["/api/cloud/challenge", "/api/cloud/refresh", "/api/cloud/devices/forget"]);
  assert.equal(retry[0].body.deviceId, "dev-1");
  assert.equal(retry[2].headers.authorization, "Bearer tok-2", "the retry's own token, not the stale one");
  assert.deepEqual(await store.loadRevocations(), []);
  assert.equal(existsSync(path.join(storeDir, "cloud-revoke-pending.bin")), false);
  assert.equal(await store.load(HOME), null, "still not a paired home");
});

test("a queued device the home already revoked on My Cloud leaves the queue without a forget post; a paused home keeps it", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  home.forgetStatus = 503;
  const hold = holdAt("/api/cloud/enter");
  const accepting = client.acceptDoorLink(doorUrl(ticketFor()));
  await hold.arrived;
  await client.cancelConnect();
  hold.release();
  await refused(accepting, "cancelled");
  assert.equal((await store.loadRevocations()).length, 1);
  // Paused: the sign-in says "suspended"; the device still exists there, so the entry stays.
  home.refreshStatus = 403; home.refreshReason = "suspended";
  await makeClient().client.connectStatus();
  assert.equal((await store.loadRevocations()).length, 1, "a paused home still has the device");
  // Revoked on My Cloud: the sign-in says so; nothing is left to remove.
  home.refreshReason = "revoked";
  const before = forgetPosts().length;
  await makeClient().client.connectStatus();
  assert.deepEqual(await store.loadRevocations(), []);
  assert.equal(forgetPosts().length, before, "no forget post for a device the home no longer has");
});

// ── The revocation queue under concurrency and at scale (Astra door-v2 tip, Highs 1 and 2) ─────────────────────

/** A queued device that is not this test's Connect: its own key pair, so the fake home signs it in like any other. */
function queuedDevice(deviceId) {
  const key = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { homeId: HOME, cpEnvironment: "staging", publicOrigin: ORIGIN, environmentId: "env-1", homeKey: "home-key-A", generation: 1, deviceId, account: ACCOUNT,
    sessionPrivateKey: key(), assertionPrivateKey: key(), pinnedAt: Date.now(), cancelledAt: Date.now() };
}

test("Cancel queues device B while device A is being retried: A's confirmed removal never writes over B's credentials", async () => {
  const { client, store } = makeClient();
  await client.startConnect(); // the queue is empty here, so this start retries nothing
  const enter = holdAt("/api/cloud/enter");
  const accepting = client.acceptDoorLink(doorUrl(ticketFor()));
  await enter.arrived;
  // Device A, cancelled earlier, waits in the queue; a door open starts its retry and A's forget is in flight.
  const deviceA = queuedDevice("dev-A");
  await store.saveRevocations([deviceA]);
  const forgetA = holdAt("/api/cloud/devices/forget");
  const retrying = client.connectStatus();
  await forgetA.arrived;
  // Meanwhile Cancel wins for device B (dev-1): the home cannot forget B yet, so B is queued with its credentials.
  home.forgetRefusedFor = ["Bearer tok-1"];
  await client.cancelConnect();
  enter.release();
  await refused(accepting, "cancelled");
  assert.deepEqual((await store.loadRevocations()).map((entry) => entry.deviceId).sort(), ["dev-1", "dev-A"], "both devices are queued");
  // Now the home confirms A.
  forgetA.release();
  await retrying;
  const left = await store.loadRevocations();
  assert.deepEqual(left.map((entry) => entry.deviceId), ["dev-1"], "only A, which the home confirmed, left the queue");
  assert.ok(left[0].sessionPrivateKey.includes("PRIVATE KEY"), "B keeps the key its retry signs in with");
  // B is removed on a later retry, once the home confirms it.
  home.forgetRefusedFor = [];
  await makeClient().client.connectStatus();
  assert.deepEqual(await store.loadRevocations(), []);
});

test("21 and more queued revocations all keep their credentials until each home confirms", async () => {
  const { store } = makeClient();
  const devices = Array.from({ length: 25 }, (_, index) => queuedDevice(`dev-q${index}`));
  for (let count = 1; count <= devices.length; count++) await store.saveRevocations(devices.slice(0, count));
  let queued = await store.loadRevocations();
  assert.equal(queued.length, 25, "nothing is dropped past 20");
  assert.deepEqual(queued.map((entry) => entry.sessionPrivateKey), devices.map((entry) => entry.sessionPrivateKey));
  // The home cannot confirm yet: every one stays.
  home.forgetStatus = 503;
  await makeClient().client.connectStatus();
  queued = await store.loadRevocations();
  assert.equal(queued.length, 25, "an unconfirmed device is never removed");
  // The home confirms: every one leaves.
  home.forgetStatus = 200;
  await makeClient().client.connectStatus();
  assert.deepEqual(await store.loadRevocations(), []);
  assert.equal(forgetPosts().length, 50);
});

test("past the queue's bound a new revocation is refused with plain words and every queued device is kept", async () => {
  const store = createCloudHomeStore({ safeStorage: safeStorage(), directory: storeDir, platform: "darwin", maxQueuedRevocations: 3 });
  const devices = Array.from({ length: 3 }, (_, index) => queuedDevice(`dev-b${index}`));
  await store.saveRevocations(devices);
  const error = await store.saveRevocations([...devices, queuedDevice("dev-b3")]).then(() => null, (e) => e);
  assert.equal(error?.code, "queue-full");
  assert.ok(!/—/.test(error.message), error.message);
  assert.deepEqual((await store.loadRevocations()).map((entry) => entry.deviceId), ["dev-b0", "dev-b1", "dev-b2"], "nothing queued was dropped");
});

test("a Cancel the full queue cannot take keeps the device as this computer's connection, never loses its credentials", async () => {
  const store = createCloudHomeStore({ safeStorage: safeStorage(), directory: storeDir, platform: "darwin", maxQueuedRevocations: 2 });
  const client = createCloudHomeClient({
    store, fetch: holdingFetch, appVersion: "1.9.0", confirmStepUp: async () => true, cp: cpConfig, cpEnvironment: "staging",
    schedule: () => 0, sleep: async () => {}, openExternal: async (url) => { opened.push({ url }); },
  });
  await client.startConnect();
  home.forgetStatus = 503;
  const enter = holdAt("/api/cloud/enter");
  const accepting = client.acceptDoorLink(doorUrl(ticketFor()));
  await enter.arrived;
  await store.saveRevocations([queuedDevice("dev-f0"), queuedDevice("dev-f1")]);
  await client.cancelConnect();
  enter.release();
  const error = await refused(accepting, "cancel-kept");
  assert.equal(error.message, COPY.cancelKept);
  assert.deepEqual((await store.loadRevocations()).map((entry) => entry.deviceId), ["dev-f0", "dev-f1"], "the queued devices are all kept");
  const kept = await store.load(HOME);
  assert.equal(kept?.deviceId, "dev-1", "the device the home still has keeps its credentials here");
  assert.ok(kept.sessionPrivateKey.includes("PRIVATE KEY"));
});

test("a re-pin that finishes after Disconnect removed the record does not bring the record back", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  await client.acceptDoorLink(doorUrl(ticketFor()));
  assert.ok(await store.load(HOME));
  // The home rotated to generation 2; the next check reads its identity and re-pins.
  home.identity = identityClaims({ generation: 2, homeKey: "home-key-B" });
  const fresh = makeClient().client;
  const identity = holdAt("/.well-known/murage/environment");
  const checking = fresh.status(HOME);
  await identity.arrived;
  await fresh.unpair(HOME);
  identity.release();
  await checking;
  assert.equal(await store.load(HOME), null, "the removed home stays removed");
});

test("restart recovery never connects a device that was cancelled: an enrolled pending key in the revocation queue is cleared", async () => {
  const { store } = makeClient();
  const keys = (await (async () => { const { client } = makeClient(); await client.startConnect(); return store.loadPending(); })());
  const enrolled = { homeId: HOME, publicOrigin: ORIGIN, environmentId: "env-1", homeKey: "home-key-A", generation: 1, deviceId: "dev-1", account: ACCOUNT };
  await store.savePending({ ...keys, enrolled });
  await store.saveRevocations([{ homeId: HOME, cpEnvironment: "staging", publicOrigin: ORIGIN, environmentId: "env-1", homeKey: "home-key-A", generation: 1, deviceId: "dev-1", account: ACCOUNT,
    sessionPrivateKey: keys.sessionPrivateKey, assertionPrivateKey: keys.assertionPrivateKey, pinnedAt: Date.now(), cancelledAt: Date.now() }]);
  home.forgetStatus = 503;
  const status = await makeClient().client.connectStatus();
  assert.equal(status.paired, false, "a cancelled device is not a paired home");
  assert.equal(status.pending, false, "and not a pending Connect either");
  assert.equal(await store.load(HOME), null);
  assert.equal(await store.loadPending(), null);
  assert.equal((await store.loadRevocations()).length, 1, "still queued until the home confirms");
});

test("Cancel while the enrolled pending key is being saved: Cancel waits its turn, then wins; the device is forgotten and nothing is kept", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  const hold = holdStore(store, "savePending", (value) => Boolean(value.enrolled));
  const accepting = client.acceptDoorLink(doorUrl(ticketFor()));
  await hold.arrived;
  const cancel = client.cancelConnect();
  const cancelDone = settled(cancel);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cancelDone(), false, "Cancel does not clear the pending file in the middle of a save");
  hold.release();
  await refused(accepting, "cancelled");
  await cancel;
  assert.equal(forgetPosts().length, 1, "the device the home enrolled is removed again");
  assert.equal(forgetPosts()[0].headers.authorization, "Bearer tok-1");
  assert.equal(await store.load(HOME), null, "no record: the person cancelled");
  assert.equal(await store.loadPending(), null);
  assert.deepEqual(await store.loadRevocations(), [], "the home confirmed, nothing is queued");
  assert.equal((await client.connectStatus()).paired, false);
  assert.equal(await store.load(HOME), null, "and the restart recovery does not bring it back");
});

test("Cancel while the record is being written: the record is removed again and the device forgotten", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  const hold = holdStore(store, "save");
  const accepting = client.acceptDoorLink(doorUrl(ticketFor()));
  await hold.arrived;
  const cancel = client.cancelConnect();
  hold.release();
  await refused(accepting, "cancelled");
  await cancel;
  assert.equal(forgetPosts().length, 1);
  assert.equal(await store.load(HOME), null, "the record that was just saved is gone");
  assert.equal(await store.loadPending(), null);
  assert.equal(readdirSync(storeDir).filter((name) => name.startsWith("cloud-home-")).length, 0);
  assert.equal((await client.connectStatus()).paired, false);
});

test("a new Connect during an exchange also stops the old one", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  const hold = holdAt("/.well-known/murage/environment");
  const accepting = client.acceptDoorLink(doorUrl(ticketFor()));
  await hold.arrived;
  await client.cancelConnect();
  await client.startConnect();
  hold.release();
  await refused(accepting, "cancelled");
  assert.equal(enterPosts().length, 0);
  assert.equal(await store.load(HOME), null);
  assert.ok(await store.loadPending(), "the new Connect's key stays");
});

test("resume: an unreachable home is not a revocation", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  await client.acceptDoorLink(doorUrl(ticketFor()));
  const offline = createCloudHomeClient({ store, fetch: async () => { throw new TypeError("fetch failed"); }, appVersion: "1.9.0", confirmStepUp: async () => true, cp: cpConfig });
  const result = await offline.resume(HOME);
  assert.equal(result.ok, false);
  assert.equal(result.disconnected, undefined);
  assert.ok(await store.load(HOME), "the record stays");
});

test("disconnect revokes this device at the home, then forgets the record", async () => {
  const { client, store } = makeClient();
  await client.startConnect();
  await client.acceptDoorLink(doorUrl(ticketFor()));
  assert.deepEqual(await client.disconnect(HOME), { disconnected: true });
  const revoke = home.calls.find((c) => c.method === "DELETE");
  assert.equal(revoke.path, "/api/cloud/devices/dev-1");
  assert.equal(revoke.headers.origin, ORIGIN);
  assert.equal(await store.load(HOME), null);
});

test("mintDeviceCode and the old code-entry channels are not reachable from the UI", () => {
  const preload = readFileSync(path.join(electronDir, "preload.cjs"), "utf8");
  const ipc = readFileSync(path.join(electronDir, "cloud-home-ipc.mjs"), "utf8");
  for (const text of [preload, ipc]) {
    assert.ok(!/cloud-home:start-pairing|cloud-home:pair"/.test(text.replace(/^\s*\/\/.*$/gm, "")), "the code-entry channels are gone");
    assert.ok(!/mintDeviceCode/.test(text), "mintDeviceCode has no IPC or preload path");
  }
  for (const channel of ["connect-start", "connect-cancel", "connect-paste", "connect-status", "disconnect"]) assert.ok(ipc.includes(`cloud-home:${channel}`) && preload.includes(`cloud-home:${channel}`), channel);
});
