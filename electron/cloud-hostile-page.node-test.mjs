// Murage Cloud B3 WP7: the hostile page. A page served from murage-home://<homeId>/ is hostile by assumption (it is the
// owner's own app code today, but the home is a remote machine and its /api responses are data). This file plays that
// page against the real modules, with no Electron:
//
//   1. its bridge: preload-cloud.cjs run in a vm, driven with hostile documents and hostile arguments; the only channels
//      it can ever reach are the cloud-safe / cloud-only ones, and nothing is exposed off its own home;
//   2. main's gate: EVERY channel main can register (flag on, plus junk and prototype names), called from every hostile
//      sender (the page, a sub-frame, a popup, a navigated-away page, another home, a destroyed window), is refused
//      unless it is cloud-safe / cloud-only from the genuine top frame; each refusal is in main's log exactly once, by
//      channel name, with no payload; the listener never runs; a refused sendSync is answered (no hang);
//   3. its network: the proxy handler under forged auth/secret/Origin headers, traversal, other-home and credential URLs,
//      redirects and HTML from /api.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { CLASS_CLOUD_ONLY, CLASS_CLOUD_SAFE, CLASS_LOCAL_ONLY, channelClass } from "./ipc-channel-classes.mjs";
import { loadIpcInventory } from "./ipc-inventory-harness.mjs";
import { createCloudHomeHandler } from "./cloud-home-protocol.mjs";
import { CLOUD_WINDOW_IPC_REFUSAL, OWNED_MAIN_IPC_REFUSAL, createOwnedMainIpc } from "./main-ipc-trust.mjs";
import { isCloudHomeSender, isOwnedMainSender } from "./main-trust.mjs";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(electronDir, name), "utf8");
const HOME = "h-abc";
const ORIGIN = "http://127.0.0.1:8799";
const flagOn = loadIpcInventory({ electronDir, env: { MURAGE_DESKTOP_CLOUD: "1" } });

// ── 1. the bridge ───────────────────────────────────────────────────────────

function runCloudPreload({ argv, location }) {
  const sent = [], invoked = [], listened = [], invokedArgs = [];
  let exposed = null;
  const electron = {
    contextBridge: { exposeInMainWorld: (key, value) => { exposed = { key, value }; } },
    ipcRenderer: {
      send: (channel) => sent.push(channel),
      sendSync: (channel) => { sent.push(channel); return ""; },
      invoke: (channel, ...args) => { invoked.push(channel); invokedArgs.push([channel, ...args]); return Promise.resolve({ ok: true }); },
      on: (channel) => listened.push(channel),
      removeListener() {},
    },
  };
  vm.runInNewContext(read("preload-cloud.cjs"), { require: () => electron, process: { platform: "darwin", argv }, globalThis: { location }, location, URL, queueMicrotask });
  return { exposed, sent, invoked, listened, invokedArgs };
}

test("the Cloud bridge hands main the address unchanged, and adds nothing to it", async () => {
  const { exposed, invokedArgs } = runCloudPreload({ argv: ["electron", `--murage-cloud-home=${HOME}`], location: { protocol: "murage-home:", hostname: HOME } });
  await exposed.value.openExternal("https://example.com/x");
  assert.deepEqual(invokedArgs, [["desktop:open-external", "https://example.com/x"]]);
});

test("hostile page: the Cloud bridge appears only on its own home's document", () => {
  const argv = ["electron", `--murage-cloud-home=${HOME}`];
  for (const [label, location] of Object.entries({
    "another home": { protocol: "murage-home:", hostname: "h-other" },
    "a web page": { protocol: "https:", hostname: HOME },
    "the desktop origin": { protocol: "http:", hostname: "127.0.0.1" },
    "file": { protocol: "file:", hostname: "" },
    "no location": undefined,
  })) {
    assert.equal(runCloudPreload({ argv, location }).exposed, null, label);
  }
  for (const bad of [["electron"], ["electron", "--murage-cloud-home="], ["electron", "--murage-cloud-home=../x"], ["electron", "--murage-cloud-home=A"], ["electron", `--murage-cloud-home=${"a".repeat(64)}`]]) {
    assert.equal(runCloudPreload({ argv: bad, location: { protocol: "murage-home:", hostname: HOME } }).exposed, null, bad.join(" "));
  }
  const own = runCloudPreload({ argv, location: { protocol: "murage-home:", hostname: HOME } });
  assert.equal(own.exposed?.key, "muragecloud");
});

test("hostile page: whatever the page passes to the bridge, only cloud-safe / cloud-only channels are reached", async () => {
  const { exposed, sent, invoked, listened } = runCloudPreload({ argv: ["electron", `--murage-cloud-home=${HOME}`], location: { protocol: "murage-home:", hostname: HOME } });
  const bridge = exposed.value;
  assert.deepEqual(Object.keys(bridge).sort(), ["approvalNotifications", "disconnectThisComputer", "homeId", "openExternal", "platform", "reachable", "setUnreadCount"]);
  assert.equal(Object.hasOwn(bridge, "ipcRenderer") || Object.hasOwn(bridge, "invoke") || Object.hasOwn(bridge, "send"), false, "no raw IPC handle");
  const hostile = [undefined, null, "../../x", { channel: "credential:set" }, { toString() { throw new Error("boom"); } }, JSON.parse('{"__proto__":{"channel":"credential:set"}}'), "x".repeat(1_000_000), -1, NaN, [], () => {}];
  for (const arg of hostile) {
    for (const call of [
      () => bridge.setUnreadCount(arg),
      () => bridge.reachable(arg),
      () => bridge.disconnectThisComputer(arg),
      () => bridge.openExternal(arg),
      () => bridge.approvalNotifications.show(arg),
      () => bridge.approvalNotifications.onOpen(arg),
    ]) {
      try { await call(); } catch { /* a throwing page argument is its own problem; it still reached no other channel */ }
    }
  }
  // `listened` is main -> page (approval-notification:open): the page can only receive it, never send on it.
  assert.deepEqual([...new Set(listened)], ["approval-notification:open"]);
  const reached = new Set([...sent, ...invoked]);
  assert.deepEqual([...reached].sort(), ["approval-notification:show", "cloud-home:disconnect-this", "cloud-home:reachable", "desktop:open-external", "desktop:unread-count"]);
  for (const channel of reached) assert.notEqual(channelClass(channel), CLASS_LOCAL_ONLY, channel);
});

// ── 2. main's gate ──────────────────────────────────────────────────────────

function frameFixture(url, extra = {}) {
  const mainFrame = { url, detached: false };
  const webContents = { mainFrame, isDestroyed: () => false };
  return { window: { webContents, isDestroyed: () => false }, webContents, mainFrame, event: { sender: webContents, senderFrame: mainFrame, ...extra } };
}

test("hostile page: every channel x every hostile sender is refused in main's log (or is cloud-safe from the genuine top frame)", async () => {
  const main = frameFixture(`${ORIGIN}/`);
  const cloud = frameFixture(`murage-home://${HOME}/`);
  const raw = { handles: new Map(), listeners: new Map() };
  const refused = [], cloudRefused = [], ran = [];
  const gate = createOwnedMainIpc({
    ipcMain: { handle: (c, f) => raw.handles.set(c, f), on: (c, f) => raw.listeners.set(c, f) },
    isTrusted: (event) => isOwnedMainSender(event, { window: main.window, origin: ORIGIN }),
    onRefused: (channel, ...rest) => { assert.equal(rest.length, 0, "refusal log carries the name only"); refused.push(channel); },
    cloud: { isCloudSender: (event) => isCloudHomeSender(event, { window: cloud.window, homeId: HOME }), classOf: channelClass, onRefused: (c, ...rest) => { assert.equal(rest.length, 0); cloudRefused.push(c); } },
  });
  const junk = ["__proto__", "constructor", "toString", "", "cloud-home:", "cloud-home:../credential:set", "CREDENTIAL:SET", "credential:set ", "backup-closed:anything", "companion:anything", "cua:anything"];
  const handles = [...new Set([...flagOn.handles, ...junk])];
  const ons = [...new Set(flagOn.ons)];
  for (const channel of handles) gate.handle(channel, () => { ran.push(channel); return "ran"; });
  for (const channel of ons) gate.on(channel, () => { ran.push(channel); }, { refusedReturnValue: "" });

  const popup = frameFixture(`murage-home://${HOME}/`);
  const hostileSenders = {
    "sub-frame of the page": { sender: cloud.webContents, senderFrame: { url: `murage-home://${HOME}/`, parent: {}, detached: false } },
    "popup window (not the Cloud window)": popup.event,
    "the page navigated to a web origin": { sender: cloud.webContents, senderFrame: { url: "https://evil.example/", detached: false } },
    "the page on another home's host": { sender: cloud.webContents, senderFrame: { url: "murage-home://h-other/", detached: false } },
    "the page with credentials in its URL": { sender: cloud.webContents, senderFrame: { url: `murage-home://u:p@${HOME}/`, detached: false } },
    "a detached frame": { sender: cloud.webContents, senderFrame: { url: `murage-home://${HOME}/`, detached: true } },
    "no frame": { sender: cloud.webContents },
    "nothing": {},
  };
  let expectedOther = 0;
  for (const [label, event] of Object.entries(hostileSenders)) {
    for (const channel of handles) {
      const error = await raw.handles.get(channel)({ ...event }).then(() => null, (e) => e);
      assert.equal(error?.code, OWNED_MAIN_IPC_REFUSAL, `${label} -> ${channel} must be refused like any foreign sender`);
      expectedOther++;
    }
    for (const channel of ons) {
      const e = { ...event };
      raw.listeners.get(channel)(e);
      assert.equal(e.returnValue, "", `${label} -> ${channel}: a refused message is still answered`);
      expectedOther++;
    }
  }
  assert.equal(refused.length, expectedOther, "one log line per hostile call, none lost");
  assert.deepEqual(cloudRefused, []);
  assert.deepEqual(ran, [], "no listener ran for any hostile sender");

  // the genuine top frame of the Cloud window, on every channel
  let expectedCloud = 0;
  for (const channel of handles) {
    const klass = channelClass(channel);
    const outcome = await Promise.resolve().then(() => raw.handles.get(channel)({ ...cloud.event })).then((v) => ({ v }), (e) => ({ e }));
    if (klass === CLASS_CLOUD_SAFE || klass === CLASS_CLOUD_ONLY) assert.equal(outcome.v, "ran", channel);
    else {
      assert.equal(outcome.e?.code, CLOUD_WINDOW_IPC_REFUSAL, channel);
      assert.match(outcome.e.message, /LOCAL_ONLY_CHANNEL/);
      expectedCloud++;
    }
  }
  for (const channel of ons) {
    const klass = channelClass(channel);
    const e = { ...cloud.event };
    raw.listeners.get(channel)(e);
    if (klass === CLASS_LOCAL_ONLY) { assert.equal(e.returnValue, "", channel); expectedCloud++; }
  }
  assert.equal(cloudRefused.length, expectedCloud, "every refused bridge call from the Cloud window is in main's log, once");
  assert.ok(expectedCloud > 100, `expected the whole local-only surface to be exercised (${expectedCloud})`);
  assert.ok(cloudRefused.every((entry) => typeof entry === "string"));
  for (const channel of ran) assert.notEqual(channelClass(channel), CLASS_LOCAL_ONLY, `${channel} ran for the cloud window`);
  assert.equal(refused.length, expectedOther, "the Cloud window's refusals did not leak into the other log");
});

// ── 3. the network ──────────────────────────────────────────────────────────

const HOME_ORIGIN = "https://h-abc.murage.ai";
const req = (url, { method = "GET", headers = {}, body } = {}) => ({ url, method, headers: new Headers(headers), body });
function network(upstream) {
  const calls = [];
  const handler = createCloudHomeHandler({
    homeId: HOME,
    home: () => ({ homeId: HOME, origin: HOME_ORIGIN, getAccessToken: () => "MAIN-TOKEN" }),
    netFetch: async (url, init) => { calls.push({ url, init }); return upstream ? upstream(url, init) : new Response("{}", { headers: { "content-type": "application/json" } }); },
    readAsset: async (rel) => (rel === "index.html" ? Buffer.from("<html>app</html>") : null),
  });
  return { handler, calls };
}

test("hostile page: forged auth, secret and Origin headers never reach the home; the token and Origin are main's", async () => {
  const { handler, calls } = network();
  const forged = {
    authorization: "Bearer page-token", origin: "https://evil.example", cookie: "s=1", "x-murage-surface": "desktop",
    "x-murage-surface-secret": "STOLEN", "x-murage-companion": "1", "x-forwarded-for": "1.2.3.4", host: "evil.example", referer: "https://evil.example/",
  };
  for (const path of ["/api/bots?surfaceSecret=STOLEN&a=1", "/api/events", "/api/health"]) {
    await handler(req(`murage-home://${HOME}${path}`, { headers: forged }));
  }
  assert.equal(calls.length, 3);
  for (const { url, init } of calls) {
    assert.ok(url.startsWith(`${HOME_ORIGIN}/api/`), url);
    assert.equal(url.includes("STOLEN"), false);
    assert.equal(init.headers.get("authorization"), "Bearer MAIN-TOKEN");
    assert.equal(init.headers.get("origin"), HOME_ORIGIN);
    for (const name of ["x-murage-surface-secret", "cookie"]) assert.equal(init.headers.has(name), false, name);
    assert.ok([...init.headers.values()].every((value) => !value.includes("STOLEN") && !value.includes("page-token") && !value.includes("evil.example") || value === HOME_ORIGIN));
  }
});

test("hostile page: it cannot make the proxy leave the home, read outside dist/, or read another home's files", async () => {
  const { handler, calls } = network();
  const bad = [
    `murage-home://${HOME}/api/../../etc/passwd`, `murage-home://${HOME}//evil.example/api/x`, `murage-home://${HOME}/%2e%2e/api`, `murage-home://${HOME}/api%2f..%2fx`,
    `murage-home://${HOME}@evil.example/api/x`, `murage-home://u:p@${HOME}/api/x`, `murage-home://h-other/api/x`, `murage-home://${HOME}:81/api/x`, "https://h-abc.murage.ai/api/x", "file:///etc/passwd",
  ];
  for (const url of bad) {
    const r = await handler(req(url));
    assert.ok(r.status >= 400 || r.status === 200, url);
  }
  for (const { url } of calls) assert.ok(url.startsWith(`${HOME_ORIGIN}/api`) && !url.includes("evil.example") && !url.includes("passwd"), url);
  for (const url of bad.filter((u) => u.includes("h-other") || u.startsWith("https:") || u.startsWith("file:") || u.includes("u:p@"))) {
    assert.ok((await handler(req(url))).status >= 400, url);
  }
});

test("hostile page: HTML a home returns from /api cannot run as the app; redirects and writes to static fail closed", async () => {
  const html = network(() => new Response("<script>parent.muragecloud</script>", { headers: { "content-type": "text/html; charset=utf-8", "set-cookie": "a=b" } }));
  const r = await html.handler(req(`murage-home://${HOME}/api/export/page`));
  assert.equal(r.headers.get("content-security-policy"), "sandbox");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.has("set-cookie"), false);
  const redirect = network(() => new Response(null, { status: 307, headers: { location: "https://evil.example/" } }));
  assert.equal((await redirect.handler(req(`murage-home://${HOME}/api/x`))).status, 502);
  const { handler } = network();
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) assert.equal((await handler(req(`murage-home://${HOME}/index.html`, { method }))).status, 405, method);
});
