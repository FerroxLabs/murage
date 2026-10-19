import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { CloudLiveProbeError, createCloudLiveGate, createCloudLiveStatus, evaluateCloudLive, CLOUD_LIVE_CACHE_FILE } from "./cloud-live.mjs";
import { cloudHomeEnabled, installCloudHome } from "./cloud-home-window.mjs";
import { registerCloudHomeIpc } from "./cloud-home-ipc.mjs";
import { registerEngineLoginIpc } from "./cloud-home-engine-login.mjs";
import { CLOUD_HOME_CP } from "./cloud-control-plane.mjs";

const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const prod = { environment: "prod", baseUrl: "https://accounts.murage.ai", jwk };
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "cloud-live-"));
function installArgs(extra = {}) {
  const log = [];
  const proxy = () => new Proxy(function () {}, { get: (_t, p) => (p === "then" ? undefined : () => proxy()), apply: () => undefined });
  return { log, args: { protocol: { registerSchemesAsPrivileged: (l) => log.push(l) }, session: proxy(), BrowserWindow: function () {}, shell: proxy(), net: proxy(), env: {}, distDir: "/nonexistent", ...extra } };
}

test("policy: only live:true from the pinned prod origin with a JWK", () => {
  assert.equal(evaluateCloudLive(prod, { live: true, origin: prod.baseUrl }), true);
  assert.equal(evaluateCloudLive(prod, { live: false, origin: prod.baseUrl }), false);
  assert.equal(evaluateCloudLive(prod, { live: true, origin: "https://evil.example" }), false, "wrong origin");
  assert.equal(evaluateCloudLive({ ...prod, jwk: null }, { live: true, origin: prod.baseUrl }), false, "missing JWK");
  assert.equal(evaluateCloudLive(null, { live: true, origin: prod.baseUrl }), false, "refused control plane");
  const staging = { environment: "staging", baseUrl: CLOUD_HOME_CP.staging.baseUrl, jwk };
  assert.equal(evaluateCloudLive(staging, { live: true, origin: staging.baseUrl }), false, "staging never customer-facing");
});

function fakeSession(handlers) {
  const noop = () => {};
  return { fromPartition: () => ({ protocol: { handle: (_scheme, fn) => handlers.push(fn) }, setPermissionRequestHandler: noop, webRequest: { onBeforeRequest: noop } }) };
}
function windowArgs(extra = {}) {
  const handlers = []; const windows = []; const registered = [];
  const BrowserWindow = function () { const win = { closed: false, on() {}, focus() {}, isDestroyed: () => false, close() { win.closed = true; }, webContents: { on() {}, setWindowOpenHandler() {} }, loadURL: async () => {} }; windows.push(win); return win; };
  return { handlers, windows, registered, args: { protocol: { registerSchemesAsPrivileged: (l) => registered.push(l) }, session: fakeSession(handlers), BrowserWindow, shell: {}, net: { fetch: async () => new Response("served") }, env: {}, distDir: "/nonexistent", ...extra } };
}
const HOME = "11111111-1111-4111-8111-111111111111";

test("not live: scheme registered but inert; every request and IPC call refused, no window, no entry", async () => {
  const d = dir();
  try {
    const gate = createCloudLiveGate({ resolve: () => prod, cloudLiveStatus: async () => ({ live: false, origin: prod.baseUrl }), cacheDir: d });
    assert.equal(await gate.refresh(), false);
    const { args, windows, registered } = windowArgs({ liveGate: gate });
    const cloud = installCloudHome(args);
    assert.ok(cloud); assert.equal(registered.length, 1, "scheme registered at start, before ready");
    assert.equal(cloud.active(), false);
    assert.throws(() => cloud.open(HOME), /isn't available/);
    assert.equal(windows.length, 0, "no window");
    // IPC stubs: every channel refuses, and no work runs
    const channels = new Map(); let worked = 0;
    registerCloudHomeIpc({ handle: (c, fn) => channels.set(c, fn) }, { cloudHome: { ...cloud, client: new Proxy({}, { get: () => () => { worked++; } }) }, getCpToken: () => "t", generateDeviceKeys: () => ({}) });
    assert.ok(channels.size >= 6);
    for (const [name, fn] of channels) await assert.rejects(async () => fn({}, HOME, "123456"), /isn't available/, name);
    assert.equal(worked, 0);
    const engine = new Map(); let relayCalls = 0;
    registerEngineLoginIpc({ ipcMain: { handle: (c, fn) => engine.set(c, fn) }, active: () => cloud.active(), relay: new Proxy({}, { get: (_t, p) => (p === "isOpen" ? () => false : () => { relayCalls++; }) }) });
    for (const [name, fn] of engine) await assert.rejects(async () => fn({}, { homeId: HOME }), /isn't available/, name);
    assert.equal(relayCalls, 0);
    // no verified live answer, a missing JWK, or a refused control plane all stay inert
    assert.equal(installCloudHome({ ...args, liveGate: createCloudLiveGate({ resolve: () => ({ ...prod, jwk: null }), cacheDir: d }) }).active(), false);
  } finally { safeWipeSync(d); }
});

test("MURAGE_DESKTOP_CLOUD=0 is a hard off: nothing registered, even when live", async () => {
  const d = dir();
  try {
    const gate = createCloudLiveGate({ resolve: () => prod, cloudLiveStatus: async () => ({ live: true, origin: prod.baseUrl }), cacheDir: d });
    await gate.refresh();
    const { args, registered } = windowArgs({ liveGate: gate, env: { MURAGE_DESKTOP_CLOUD: "0" } });
    assert.equal(installCloudHome(args), null);
    assert.deepEqual(registered, []);
  } finally { safeWipeSync(d); }
});

test("live flips on at runtime with no restart, the renderer is told, and live:false flips it back off", async () => {
  const d = dir(); let answer = { live: true, origin: prod.baseUrl };
  try {
    const gate = createCloudLiveGate({ resolve: () => prod, cloudLiveStatus: async () => answer, cacheDir: d });
    const { args, windows, handlers } = windowArgs({ liveGate: gate });
    const cloud = installCloudHome(args);
    const told = []; cloud.onActiveChange((live) => told.push(live));
    assert.equal(cloud.active(), false);
    assert.equal(await gate.refresh(), true);
    assert.equal(cloud.active(), true); assert.deepEqual(told, [true]);
    cloud.open(HOME);
    assert.equal(windows.length, 1); assert.equal(handlers.length, 1);
    const channels = new Map();
    registerCloudHomeIpc({ handle: (c, fn) => channels.set(c, fn) }, { cloudHome: { ...cloud, client: { pairedHomes: async () => [] } }, getCpToken: () => "t", generateDeviceKeys: () => ({}) });
    assert.deepEqual(await channels.get("cloud-home:state")({}), { enabled: true, cpSignedIn: true, paired: [] });
    answer = { live: false, origin: prod.baseUrl };
    assert.equal(await gate.refresh(), false);
    assert.deepEqual(told, [true, false]);
    assert.equal(windows[0].closed, false, "an open Cloud window is never closed by going not-live");
    await assert.rejects(async () => channels.get("cloud-home:state")({}), /isn't available/);
    assert.throws(() => cloud.open("22222222-2222-4222-8222-222222222222"), /isn't available/, "new opens refused");
  } finally { safeWipeSync(d); }
});

test("focus probe is throttled to once per 10 minutes", async () => {
  const d = dir(); let t = 1_000_000_000_000; let calls = 0;
  try {
    const gate = createCloudLiveGate({ resolve: () => prod, cacheDir: d, now: () => t, cloudLiveStatus: async () => { calls++; return { live: false }; } });
    gate.probeOnFocus(); await new Promise((r) => setImmediate(r)); assert.equal(calls, 1);
    t += 9 * 60_000; gate.probeOnFocus(); await new Promise((r) => setImmediate(r)); assert.equal(calls, 1);
    t += 2 * 60_000; gate.probeOnFocus(); await new Promise((r) => setImmediate(r)); assert.equal(calls, 2);
  } finally { safeWipeSync(d); }
});

test("a fabricated fresh live cache never enables Cloud: off at first paint, zero probes, only this run's verified probe turns it on", async () => {
  const d = dir(); let calls = 0;
  try {
    fs.writeFileSync(path.join(d, CLOUD_LIVE_CACHE_FILE), JSON.stringify({ live: true, origin: prod.baseUrl, checkedAt: Date.now() }));
    const gate = createCloudLiveGate({ resolve: () => prod, cacheDir: d, cloudLiveStatus: async () => { calls++; return { live: true, origin: prod.baseUrl }; } });
    assert.equal(gate.isLive(), false, "a local file is not a verified answer");
    const { args, windows } = windowArgs({ liveGate: gate });
    const cloud = installCloudHome(args);
    assert.equal(cloud.active(), false);
    assert.throws(() => cloud.open(HOME), /isn't available/);
    assert.equal(windows.length, 0); assert.equal(calls, 0, "no status request made, nothing activated");
    assert.equal(await gate.refresh(), true); assert.equal(calls, 1);
    assert.equal(cloud.active(), true, "the first verified probe in this process is what turns it on");
    assert.equal(fs.existsSync(path.join(d, CLOUD_LIVE_CACHE_FILE)), false, "the old file is removed, never rewritten");
    const next = createCloudLiveGate({ resolve: () => prod, cacheDir: d, cloudLiveStatus: async () => ({ live: true, origin: prod.baseUrl }) });
    assert.equal(next.isLive(), false, "a new process starts off again until its own probe");
  } finally { safeWipeSync(d); }
});

test("a packaged build honours only the hard off: MURAGE_DESKTOP_CLOUD=1 and the flag file never turn Cloud on", async () => {
  const d = dir();
  try {
    fs.writeFileSync(path.join(d, "desktop-flags.json"), JSON.stringify({ cloud: true }));
    const notLive = createCloudLiveGate({ resolve: () => prod, cacheDir: d, cloudLiveStatus: async () => ({ live: false, origin: prod.baseUrl }) });
    for (const env of [{ MURAGE_DESKTOP_CLOUD: "1" }, {}]) {
      for (const packaged of [true, undefined]) {
        const { args, windows } = windowArgs({ liveGate: notLive, env, userDataDir: d, ...(packaged === undefined ? {} : { packaged }) });
        const cloud = installCloudHome(args);
        assert.equal(cloud.active(), false, `packaged=${packaged} env=${JSON.stringify(env)}`);
        assert.throws(() => cloud.open(HOME), /isn't available/);
        assert.equal(windows.length, 0);
        assert.equal(cloudHomeEnabled({ env, userDataDir: d, ...(packaged === undefined ? {} : { packaged }) }), false);
      }
      const { args } = windowArgs({ liveGate: notLive, env, userDataDir: d, packaged: false });
      assert.equal(installCloudHome(args).active(), true, "unpackaged development or qualification build: force-on works");
    }
    const { args, registered } = windowArgs({ liveGate: notLive, env: { MURAGE_DESKTOP_CLOUD: "0" }, userDataDir: d, packaged: true });
    assert.equal(installCloudHome(args), null, "packaged: =0 is still the hard off"); assert.deepEqual(registered, []);
  } finally { safeWipeSync(d); }
});

test("going not-live keeps an open Cloud window and its work; only new opens and new work are refused", async () => {
  const d = dir(); let answer = { live: true, origin: prod.baseUrl };
  try {
    const gate = createCloudLiveGate({ resolve: () => prod, cloudLiveStatus: async () => answer, cacheDir: d });
    const { args, windows, handlers } = windowArgs({ liveGate: gate });
    const cloud = installCloudHome(args);
    await gate.refresh(); cloud.open(HOME);
    const before = await handlers[0](new Request(`murage-home://${HOME}/`));
    answer = { live: false, origin: prod.baseUrl }; assert.equal(await gate.refresh(), false);
    assert.equal(cloud.active(), false);
    assert.equal(windows[0].closed, false, "not closed");
    assert.equal(cloud.windowOpen(HOME), true);
    const after = await handlers[0](new Request(`murage-home://${HOME}/`));
    assert.notEqual(after.status, 403, "the open window is still served"); assert.equal(after.status, before.status);
    assert.throws(() => cloud.open("22222222-2222-4222-8222-222222222222"), /isn't available/, "new window refused");
    // IPC: the open window's own reachability check keeps working; every channel that starts new work is refused.
    const winEvent = { from: "open-cloud-window" };
    const channels = new Map(); let worked = 0;
    const client = new Proxy({}, { get: (_t, p) => (p === "status" ? async () => ({ ok: true }) : () => { worked++; }) });
    registerCloudHomeIpc({ handle: (c, fn) => channels.set(c, fn) }, { cloudHome: { ...cloud, client, senderHomeId: (e) => (e === winEvent ? HOME : null) }, getCpToken: () => "t", generateDeviceKeys: () => ({}) });
    assert.deepEqual(await channels.get("cloud-home:reachable")(winEvent), { ok: true });
    await assert.rejects(async () => channels.get("cloud-home:reachable")({}), /isn't available/, "not from an open Cloud window");
    for (const [name, fn] of channels) if (name !== "cloud-home:reachable") await assert.rejects(async () => fn(winEvent, HOME, "123456"), /isn't available/, name);
    assert.equal(worked, 0);
    // A sign-in already running keeps its input, stop and link; a new sign-in is refused.
    const engine = new Map(); const relayed = [];
    registerEngineLoginIpc({ ipcMain: { handle: (c, fn) => engine.set(c, fn) }, active: () => cloud.active(),
      relay: { isOpen: () => true, start: () => relayed.push("start"), input: () => relayed.push("input"), stop: () => relayed.push("stop"), openLink: () => relayed.push("openLink") } });
    for (const [name, fn] of engine) {
      if (/start/.test(name)) await assert.rejects(async () => fn({}, { homeId: HOME }), /isn't available/, name);
      else await fn({}, { id: "x" });
    }
    assert.deepEqual(relayed.sort(), ["input", "openLink", "stop"]);
    // Once the person closes it, its scheme is refused like any other.
    cloud.windows().get(HOME).isDestroyed = () => true;
    assert.equal((await handlers[0](new Request(`murage-home://${HOME}/`))).status, 403);
  } finally { safeWipeSync(d); }
});

test("a network failure, timeout, non-200 or malformed answer is not a verified live:false: Cloud stays on", async () => {
  const d = dir(); let fetchImpl = async (url) => ({ status: 200, url, json: async () => ({ live: true }) });
  try {
    const gate = createCloudLiveGate({ resolve: () => prod, cacheDir: d, cloudLiveStatus: createCloudLiveStatus({ resolve: () => prod, fetch: (...a) => fetchImpl(...a) }) });
    const { args, windows } = windowArgs({ liveGate: gate });
    const cloud = installCloudHome(args); const told = []; cloud.onActiveChange((v) => told.push(v));
    assert.equal(await gate.refresh(), true); cloud.open(HOME);
    for (const failing of [
      async () => { throw new TypeError("fetch failed"); },
      async (url) => ({ status: 503, url, json: async () => ({ live: false }) }),
      async (url) => ({ status: 200, url, json: async () => { throw new SyntaxError("x"); } }),
      async (url) => ({ status: 200, url, json: async () => ({ live: false, extra: 1 }) }),
    ]) {
      fetchImpl = failing;
      assert.equal(await gate.refresh(), true); assert.equal(cloud.active(), true);
    }
    assert.deepEqual(told, [true], "no flip"); assert.equal(windows[0].closed, false);
    fetchImpl = async (url) => ({ status: 200, url, json: async () => ({ live: false }) });
    assert.equal(await gate.refresh(), false, "only a verified live:false turns it off");
  } finally { safeWipeSync(d); }
});

test("wrong origin, missing JWK and a non-TLS origin each refused and leave nothing cached", async () => {
  const cases = [
    [prod, { live: true, origin: "https://evil.example" }],
    [{ ...prod, jwk: null }, { live: true, origin: prod.baseUrl }],
    [{ ...prod, baseUrl: "http://accounts.murage.ai" }, { live: true, origin: "http://accounts.murage.ai" }],
  ];
  for (const [cp, answer] of cases) {
    const d = dir();
    try {
      const gate = createCloudLiveGate({ resolve: () => cp, cloudLiveStatus: async () => answer, cacheDir: d });
      assert.equal(await gate.refresh(), false);
      assert.equal(gate.isLive(), false);
      assert.equal(fs.existsSync(path.join(d, CLOUD_LIVE_CACHE_FILE)), false);
    } finally { safeWipeSync(d); }
  }
});

test("a failed probe keeps the state, and nothing live is ever written to disk", async () => {
  const d = dir(); let fail = false;
  try {
    const gate = createCloudLiveGate({ resolve: () => prod, cacheDir: d,
      cloudLiveStatus: async () => { if (fail) throw new Error("down"); return { live: true, origin: prod.baseUrl }; } });
    assert.equal(await gate.refresh(), true);
    assert.equal(fs.existsSync(path.join(d, CLOUD_LIVE_CACHE_FILE)), false, "no cache written");
    fail = true; assert.equal(await gate.refresh(), true, "outage is not not-live");
    const refused = createCloudLiveGate({ resolve: () => null, cacheDir: d, cloudLiveStatus: async () => ({ live: true, origin: prod.baseUrl }) });
    assert.equal(await refused.refresh(), false, "a refused control plane is off");
  } finally { safeWipeSync(d); }
});

test("probe never blocks startup or first paint: hung status, start() returns at once, timers are deferred", async () => {
  const d = dir(); const timers = [];
  try {
    let called = 0;
    const gate = createCloudLiveGate({ resolve: () => prod, cacheDir: d, cloudLiveStatus: () => { called++; return new Promise(() => {}); },
      setTimer: (fn, ms) => { timers.push([fn, ms]); return timers.length; }, clearTimer: () => {} });
    const t0 = performance.now();
    const { args } = installArgs({ liveGate: gate });
    assert.equal(installCloudHome(args).active(), false);
    gate.start();
    assert.ok(performance.now() - t0 < 100);
    assert.equal(called, 0, "no probe during startup");
    assert.equal(timers.length, 1);
    assert.ok(timers[0][1] >= 5000, "first probe is deferred");
    timers[0][0](); assert.equal(called, 1);
    assert.equal(gate.isLive(), false, "still synchronous while the probe hangs");
    gate.stop();
  } finally { safeWipeSync(d); }
});

test("adapter: GET /v1/status on the pinned origin, redirect error, no-store, bounded timeout", async () => {
  const seen = [];
  const ok = (body, extra = {}) => async (url, init) => { seen.push([url, init]); return { status: 200, url, json: async () => body, ...extra }; };
  assert.deepEqual(await createCloudLiveStatus({ resolve: () => prod, fetch: ok({ live: true }) })(), { live: true, origin: prod.baseUrl });
  const [url, init] = seen[0];
  assert.equal(url, "https://accounts.murage.ai/v1/status");
  assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store"); assert.equal(init.credentials, "omit"); assert.ok(init.signal);
  const status = (fetch, cp = prod) => createCloudLiveStatus({ resolve: () => cp, fetch })();
  const noAnswer = (p, msg) => assert.rejects(p, CloudLiveProbeError, msg);
  await noAnswer(status(ok({ live: "yes" })));
  await noAnswer(status(ok({ live: "true" })), "string true");
  await noAnswer(status(ok({ live: true, extra: 1 })), "extra keys");
  await noAnswer(status(ok({ live: true, signed: {} })), "extra keys");
  await noAnswer(status(ok({})), "no key");
  await noAnswer(status(ok([true])), "array");
  await noAnswer(status(ok({ live: 1 })), "number");
  assert.deepEqual(await status(ok({ live: false })), { live: false, origin: prod.baseUrl });
  await noAnswer(status(async () => { const e = new TypeError("fetch failed"); e.cause = { code: "ERR_REDIRECT" }; throw e; }), "redirect: fetch with redirect error rejects");
  await noAnswer(status(ok(null)));
  await noAnswer(status(ok({ live: true }, { status: 503 })));
  await noAnswer(status(ok({ live: true }, { url: "https://evil.example/v1/status" })), "other origin");
  await noAnswer(status(async () => { throw new TypeError("redirect"); }));
  await noAnswer(status(async () => ({ status: 200, json: async () => { throw new SyntaxError("x"); } })), "non-JSON");
  await noAnswer(status(ok({ live: true }), null), "refused control plane");
  const t0 = Date.now();
  await noAnswer(createCloudLiveStatus({ resolve: () => prod, timeoutMs: 20, fetch: (u, i) => new Promise((_, rej) => i.signal.addEventListener("abort", () => rej(new Error("t")))) })());
  assert.ok(Date.now() - t0 < 2000);
});

test("probeNow: hard-off and missing JWK stay off", async () => {
  const d = dir();
  try {
    let calls = 0;
    const yes = async () => { calls++; return { live: true, origin: prod.baseUrl }; };
    // A missing prod JWK: the shared resolver refuses (null) or hands a pin without its key. Either way, off, and no flip.
    for (const resolve of [() => null, () => ({ ...prod, jwk: null })]) {
      const gate = createCloudLiveGate({ resolve, cloudLiveStatus: yes, cacheDir: d });
      const told = []; gate.onChange((live) => told.push(live));
      assert.equal(await gate.probeNow(), false);
      assert.equal(gate.isLive(), false);
      assert.deepEqual(told, []);
    }
    // MURAGE_DESKTOP_CLOUD=0: nothing probes at all.
    calls = 0;
    const off = createCloudLiveGate({ resolve: () => prod, cloudLiveStatus: yes, cacheDir: d, hardOff: () => true });
    assert.equal(await off.probeNow(), false);
    assert.equal(await off.refresh(), false);
    assert.equal(calls, 0);
    assert.equal(off.isLive(), false);
    // Live from the pinned prod origin: probeNow flips it, through the same policy.
    const on = createCloudLiveGate({ resolve: () => prod, cloudLiveStatus: yes, cacheDir: d });
    const told = []; on.onChange((live) => told.push(live));
    assert.equal(await on.probeNow(), true);
    assert.deepEqual(told, [true]);
    // Bounded: a probe that never answers resolves with the current state after the timeout and changes nothing.
    const timers = [];
    const stuck = createCloudLiveGate({ resolve: () => prod, cloudLiveStatus: () => new Promise(() => {}), cacheDir: d,
      setTimer: (fn, ms) => { timers.push(ms); return setTimeout(fn, 1); }, clearTimer: clearTimeout });
    assert.equal(await stuck.probeNow(), false);
    assert.deepEqual(timers, [5000]);
    // A probe already in flight is shared, not doubled.
    let release; calls = 0;
    const slow = createCloudLiveGate({ resolve: () => prod, cloudLiveStatus: () => { calls++; return new Promise((resolve) => { release = () => resolve({ live: true, origin: prod.baseUrl }); }); }, cacheDir: d });
    const first = slow.refresh(), second = slow.probeNow();
    release();
    assert.equal(await first, true); assert.equal(await second, true); assert.equal(calls, 1);
  } finally { safeWipeSync(d); }
});
