// Murage Cloud B3 WP3: IPC channel classes.
//
//   - coverage (like server/route-policy.test.ts): every channel main registers, every channel the preload can call
//     and every module that registers IPC is classified; an unclassified registration fails this file;
//   - enforcement: createOwnedMainIpc, given the Cloud-home sender kind, checks it BEFORE the listener runs;
//   - the named never-from-the-cloud channels are refused by name, with a channel-name-only log line;
//   - flag off: the gate and the registered channel set are the train's (snapshot taken from cloud-v2/b3).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  CLASS_CLOUD_ONLY, CLASS_CLOUD_SAFE, CLASS_LOCAL_ONLY, CLOUD_ONLY_CHANNELS, CLOUD_ONLY_PREFIXES, CLOUD_REFUSED_PATTERNS, CLOUD_SAFE_CHANNELS,
  LOCAL_ONLY_CHANNELS, LOCAL_ONLY_PREFIXES, channelClass, isClassified, isCloudRefusedChannel,
} from "./ipc-channel-classes.mjs";
import { loadIpcInventory } from "./ipc-inventory-harness.mjs";
import { installCloudHome } from "./cloud-home-window.mjs";
import { CLOUD_WINDOW_IPC_REFUSAL, OWNED_MAIN_IPC_REFUSAL, createOwnedMainIpc, rendererOriginArguments } from "./main-ipc-trust.mjs";
import { isCloudHomeSender, isOwnedMainSender } from "./main-trust.mjs";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://127.0.0.1:8799";
const HOME = "h-abc";
const read = (name) => fs.readFileSync(path.join(electronDir, name), "utf8");

function windowFixture(url) {
  const mainFrame = { url, detached: false };
  const webContents = { mainFrame, isDestroyed: () => false };
  const window = { webContents, isDestroyed: () => false };
  return { window, webContents, mainFrame, event: { sender: webContents, senderFrame: mainFrame } };
}

// "Flag off" is now the hard off: MURAGE_DESKTOP_CLOUD=0. With no variable the channels are registered as refusing stubs (inertDefault).
const inventory = loadIpcInventory({ electronDir, env: { MURAGE_DESKTOP_CLOUD: "0" } });
const inertDefault = loadIpcInventory({ electronDir });
const flagOn = loadIpcInventory({ electronDir, env: { MURAGE_DESKTOP_CLOUD: "1" } });
// Flag off: the train's channels. Flag on adds ONLY the cloud-home:* channels (WP4). Coverage is judged on the union, so a channel registered only behind the flag is classified too.
const registered = new Set([...inventory.handles, ...inventory.ons, ...flagOn.handles, ...flagOn.ons]);
const preloadSource = read("preload.cjs");
// The preload calls channels directly or through its own invokeShown(channel, ...) wrapper; the wrapper's own body is the one non-literal use.
const preloadBody = preloadSource.replace("function invokeShown(channel, ...args) {\n  return ipcRenderer.invoke(channel, ...args)", "");
const preloadCalls = [...preloadBody.matchAll(/(?:ipcRenderer\.(?:invoke|sendSync|send)|\binvokeShown)\("([^"]+)"/g)].map((m) => m[1]);

// ── coverage ────────────────────────────────────────────────────────────────

test("every channel main registers has an explicit class", () => {
  assert.ok(registered.size >= 100, `expected the full inventory, got ${registered.size}`);
  const missing = [...registered].filter((channel) => !isClassified(channel));
  assert.deepEqual(missing, [], `IPC channels with no class in ipc-channel-classes.mjs: ${missing.join(", ")}`);
});

test("every channel the preload can call has an explicit class, and none is built dynamically", () => {
  assert.ok(preloadCalls.length >= 100);
  assert.deepEqual(preloadCalls.filter((channel) => !isClassified(channel)), []);
  assert.equal([...preloadBody.matchAll(/(?:ipcRenderer\.(?:invoke|sendSync|send)|\binvokeShown)\(\s*[^"\s)]/g)].length, 0, "a preload channel must be a string literal");
  assert.ok(preloadBody.includes("invokeShown(\"") , "the wrapper's callers are scanned too");
});

test("only the known modules register IPC, so a new registrar cannot slip past the classes", () => {
  // cloud-home-engine-login.mjs (WP5) registers through the gate main.mjs hands it, only with the Cloud flag on; its channels are MAIN_ONLY_CLOUD_CHANNELS.
  const KNOWN = new Set(["main.mjs", "cua.mjs", "updater.mjs", "android-device.mjs", "installation-recovery-window.mjs", "main-ipc-trust.mjs", "cloud-home-engine-login.mjs"]);
  const offenders = fs.readdirSync(electronDir)
    .filter((file) => /\.(mjs|cjs)$/.test(file) && !/\.(node-test|test|electron-smoke)\.mjs$/.test(file) && file !== "preload.cjs")
    .filter((file) => /\bipcMain\.(handle|on|once)\(/.test(read(file)) && !KNOWN.has(file));
  assert.deepEqual(offenders, [], "register new IPC through the gate and add the module here with its channels classified");
  for (const file of ["main.mjs", "cua.mjs", "updater.mjs", "android-device.mjs"]) {
    for (const m of read(file).matchAll(/\bipcMain\.(?:handle|on|once)\(\s*(["'`])([^"'`]+)\1/g)) {
      if (m[2].includes("${")) assert.ok(LOCAL_ONLY_PREFIXES.some((p) => m[2].startsWith(p)), `template channel ${m[2]} needs a prefix rule`);
      else assert.ok(isClassified(m[2]), `${file}: ${m[2]} has no class`);
    }
  }
});

test("the tables have no stale entries and no entry contradicts the refused list", () => {
  for (const channel of [...LOCAL_ONLY_CHANNELS, ...CLOUD_SAFE_CHANNELS, ...CLOUD_ONLY_CHANNELS]) assert.ok(registered.has(channel), `${channel} is classified but not registered`);
  for (const channel of [...CLOUD_SAFE_CHANNELS, ...CLOUD_ONLY_CHANNELS]) assert.equal(isCloudRefusedChannel(channel), false, `${channel} is cloud-reachable but on the refused list`);
  const all = [...LOCAL_ONLY_CHANNELS, ...CLOUD_SAFE_CHANNELS, ...CLOUD_ONLY_CHANNELS];
  assert.equal(new Set(all).size, all.length, "a channel is in one class only");
});

test("WP4: the cloud-home:* channels are exactly the pairing set (local-only, main window) plus reachable and disconnect-this (cloud-only), all registered ONLY with the flag on", () => {
  // The WP5 engine sign-in relay (cloud-home:engine-login:*) is main-window only too; it is pinned by the flag-on test above.
  const cloudHome = (list) => list.filter((c) => c.startsWith("cloud-home:") && !c.startsWith("cloud-home:engine-login:"));
  assert.deepEqual(cloudHome([...inventory.handles, ...inventory.ons]), [], "flag off registers no cloud-home channel");
  assert.deepEqual(cloudHome(flagOn.handles), ["cloud-home:connect-cancel", "cloud-home:connect-paste", "cloud-home:connect-start", "cloud-home:connect-status", "cloud-home:disconnect", "cloud-home:disconnect-this", "cloud-home:list-bots", "cloud-home:list-homes", "cloud-home:open", "cloud-home:reachable", "cloud-home:state"]);
  for (const channel of ["cloud-home:connect-cancel", "cloud-home:connect-paste", "cloud-home:connect-start", "cloud-home:connect-status", "cloud-home:disconnect", "cloud-home:list-bots", "cloud-home:list-homes", "cloud-home:open", "cloud-home:state"]) {
    assert.equal(channelClass(channel), CLASS_LOCAL_ONLY, `${channel}: pairing runs in the MAIN window, the Cloud window must never reach it`);
    assert.ok(LOCAL_ONLY_CHANNELS.includes(channel), `${channel} must be listed explicitly`);
  }
  assert.deepEqual([...CLOUD_ONLY_CHANNELS], ["cloud-home:reachable", "cloud-home:disconnect-this"]);
  assert.equal(channelClass("cloud-home:disconnect-this"), CLASS_CLOUD_ONLY);
  assert.equal(channelClass("cloud-home:reachable"), CLASS_CLOUD_ONLY);
  // every registered cloud-home channel is listed explicitly, so none falls to the cloud-only PREFIX by accident.
  for (const channel of cloudHome(flagOn.handles)) assert.ok(LOCAL_ONLY_CHANNELS.includes(channel) || CLOUD_ONLY_CHANNELS.includes(channel), `${channel} has no explicit entry`);
});

test("WP4: the Cloud window's own preload reaches only cloud-safe and cloud-only channels, and exposes nothing off its own home", () => {
  const source = read("preload-cloud.cjs");
  const channels = [...source.matchAll(/ipcRenderer\.(?:invoke|sendSync|send|on|removeListener)\("([^"]+)"/g)].map((m) => m[1]);
  assert.ok(channels.length >= 3);
  for (const channel of channels) {
    if (channel === "approval-notification:open") continue; // main -> window push, not a request
    assert.notEqual(channelClass(channel), CLASS_LOCAL_ONLY, `${channel}: the Cloud preload must not call a local-only channel`);
  }
  assert.equal([...source.matchAll(/ipcRenderer\.(?:invoke|sendSync|send)\(\s*[^"\s)]/g)].length, 0, "channels are string literals");
  assert.ok(!/exposeInMainWorld\("muragebox"/.test(source), "never the desktop bridge");
  const run = (argv, location) => {
    let exposed = null; const calls = [];
    const electron = { contextBridge: { exposeInMainWorld: (key, value) => { exposed = { key, value }; } },
      ipcRenderer: { invoke: (c) => { calls.push(c); return Promise.resolve({ ok: true }); }, send: (c) => calls.push(c), on() {}, removeListener() {}, sendSync: () => { calls.push("sync"); return ""; } } };
    vm.runInNewContext(source, { require: () => electron, process: { platform: "darwin", argv }, location, URL });
    return { exposed, calls };
  };
  const ok = run(["electron", "--murage-cloud-home=h-abc"], { protocol: "murage-home:", hostname: "h-abc" });
  assert.equal(ok.exposed.key, "muragecloud");
  assert.deepEqual(Object.keys(ok.exposed.value).sort(), ["approvalNotifications", "disconnectThisComputer", "homeId", "openExternal", "platform", "reachable", "setUnreadCount"]);
  for (const [label, argv, location] of [
    ["no argument", ["electron"], { protocol: "murage-home:", hostname: "h-abc" }],
    ["another home's host", ["electron", "--murage-cloud-home=h-abc"], { protocol: "murage-home:", hostname: "h-other" }],
    ["the main window's origin", ["electron", "--murage-cloud-home=h-abc"], { protocol: "http:", hostname: "127.0.0.1" }],
    ["a bad home id", ["electron", "--murage-cloud-home=../x"], { protocol: "murage-home:", hostname: "../x" }],
  ]) assert.equal(run(argv, location).exposed, null, label);
});

test("class counts", () => {
  const counts = { [CLASS_LOCAL_ONLY]: 0, [CLASS_CLOUD_SAFE]: 0, [CLASS_CLOUD_ONLY]: 0 };
  for (const channel of registered) counts[channelClass(channel)]++;
  assert.deepEqual(counts, { [CLASS_LOCAL_ONLY]: registered.size - CLOUD_SAFE_CHANNELS.length - CLOUD_ONLY_CHANNELS.length, [CLASS_CLOUD_SAFE]: CLOUD_SAFE_CHANNELS.length, [CLASS_CLOUD_ONLY]: CLOUD_ONLY_CHANNELS.length });
  assert.equal(channelClass("not:registered"), CLASS_LOCAL_ONLY, "unknown fails closed");
  assert.equal(channelClass(undefined), CLASS_LOCAL_ONLY);
  assert.equal(channelClass("cloud-home:engine-login:open"), CLASS_CLOUD_ONLY);
  console.log(`# classes: local-only ${counts[CLASS_LOCAL_ONLY]}, cloud-safe ${counts[CLASS_CLOUD_SAFE]}, cloud-only ${counts[CLASS_CLOUD_ONLY]} (of ${registered.size})`);
});

// ── enforcement ─────────────────────────────────────────────────────────────

function gateFixture({ withCloud = true } = {}) {
  const raw = { handles: new Map(), listeners: new Map() };
  const ipcMain = { handle: (c, f) => raw.handles.set(c, f), on: (c, f) => raw.listeners.set(c, f) };
  const main = windowFixture(`${ORIGIN}/`);
  const cloudWindow = windowFixture(`murage-home://${HOME}/`);
  const refused = [], cloudRefused = [], ran = [];
  const gate = createOwnedMainIpc({
    ipcMain,
    isTrusted: (event) => isOwnedMainSender(event, { window: main.window, origin: ORIGIN }),
    onRefused: (channel) => refused.push(channel),
    cloud: withCloud ? { isCloudSender: (event) => isCloudHomeSender(event, { window: cloudWindow.window, homeId: HOME }), classOf: channelClass, onRefused: (c) => cloudRefused.push(c) } : undefined,
  });
  return { gate, raw, main, cloudWindow, refused, cloudRefused, ran };
}

const cloudRejects = async (promise) => {
  const error = await promise.then(() => null, (e) => e);
  assert.ok(error, "expected a rejection (not a hang, not a value)");
  assert.equal(error.code, CLOUD_WINDOW_IPC_REFUSAL);
  assert.match(error.message, /LOCAL_ONLY_CHANNEL/, "the code travels in the message: only the message crosses invoke");
};

test("every registered channel: the Cloud-home window reaches it only if cloud-safe/cloud-only; the main window never reaches cloud-only", async () => {
  const f = gateFixture();
  for (const channel of flagOn.handles) f.gate.handle(channel, () => { f.ran.push(channel); return "ran"; });
  for (const channel of flagOn.ons) f.gate.on(channel, () => { f.ran.push(channel); });
  for (const channel of flagOn.handles) {
    f.ran.length = 0;
    const call = f.raw.handles.get(channel);
    if (channelClass(channel) === CLASS_LOCAL_ONLY) {
      await cloudRejects(call(f.cloudWindow.event));
      assert.deepEqual(f.ran, [], `${channel}: listener must not run for the cloud window`);
    } else {
      assert.equal(await call(f.cloudWindow.event), "ran", channel);
    }
    if (channelClass(channel) === CLASS_CLOUD_ONLY) {
      const refused = await call(f.main.event).then(() => null, (e) => e);
      assert.equal(refused?.code, OWNED_MAIN_IPC_REFUSAL, `${channel}: the main window never reaches a cloud-only channel`);
    } else assert.equal(await call(f.main.event), "ran", `${channel}: the main window keeps every non-cloud-only channel`);
  }
  for (const channel of flagOn.ons) {
    f.ran.length = 0;
    f.raw.listeners.get(channel)(f.cloudWindow.event);
    assert.deepEqual(f.ran, channelClass(channel) === CLASS_LOCAL_ONLY ? [] : [channel], channel);
  }
});

test("the named channels are refused for the Cloud-home window, by name, before the listener runs", async () => {
  const named = [
    ...inventory.handles.filter((c) => c.startsWith("cua:")),
    "engine:open-terminal", "engine:open-setup-terminal", "desktop:pick-folder", "credential:set",
    ...inventory.handles.filter((c) => c.startsWith("model-signin:")),
    ...inventory.handles.filter((c) => c.startsWith("backup-")),
    ...inventory.handles.filter((c) => c.startsWith("companion:")),
    ...inventory.handles.filter((c) => c.startsWith("mcp-servers:")),
  ];
  assert.ok(named.length > 40);
  for (const must of ["cua:connection", "model-signin:start", "backup-mode:status", "backup-remote:save", "companion:state", "mcp-servers:mode"]) assert.ok(named.includes(must), must);
  const f = gateFixture();
  for (const channel of named) {
    assert.ok(registered.has(channel), `${channel} is not registered`);
    assert.equal(channelClass(channel), CLASS_LOCAL_ONLY, channel);
    assert.equal(isCloudRefusedChannel(channel), true, channel);
    f.gate.handle(channel, () => { f.ran.push(channel); return "secret"; });
    await cloudRejects(f.raw.handles.get(channel)(f.cloudWindow.event, "payload-that-must-not-be-logged"));
  }
  assert.deepEqual(f.ran, []);
  assert.deepEqual(f.cloudRefused, named, "every refusal is logged, once per call, by channel name");
  assert.deepEqual(f.refused, [], "the main-window refusal log is untouched");
  assert.ok(f.cloudRefused.every((entry) => typeof entry === "string" && !entry.includes("payload")), "channel name only");
});

test("desktop:surface-secret returns \"\" to the Cloud-home window and never runs; the main window still gets the secret", () => {
  const f = gateFixture();
  f.gate.on("desktop:surface-secret", (event) => { f.ran.push("surface-secret"); event.returnValue = "fixture-secret"; }, { refusedReturnValue: "" });
  const cloudEvent = { ...f.cloudWindow.event };
  f.raw.listeners.get("desktop:surface-secret")(cloudEvent);
  assert.equal(cloudEvent.returnValue, "");
  assert.deepEqual(f.ran, []);
  assert.deepEqual(f.cloudRefused, ["desktop:surface-secret"]);
  const mainEvent = { ...f.main.event };
  f.raw.listeners.get("desktop:surface-secret")(mainEvent);
  assert.equal(mainEvent.returnValue, "fixture-secret");
  assert.ok(inventory.ons.includes("desktop:surface-secret"));
});

test("every synchronous channel answers a refused Cloud-home sender (no hang)", () => {
  const syncChannels = [...preloadSource.matchAll(/ipcRenderer\.sendSync\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(syncChannels.sort(), ["desktop:surface-secret", "screen:preview-intent"]);
  const f = gateFixture();
  f.gate.on("screen:preview-intent", () => { f.ran.push("x"); }, { refusedReturnValue: false });
  const event = { ...f.cloudWindow.event };
  f.raw.listeners.get("screen:preview-intent")(event);
  assert.equal(Object.hasOwn(event, "returnValue"), true);
  assert.equal(event.returnValue, false);
  assert.match(read("main.mjs"), /ipcMain\.on\("screen:preview-intent"[\s\S]{0,200}refusedReturnValue: false/);
  assert.match(read("main.mjs"), /ipcMain\.on\("desktop:surface-secret"[\s\S]{0,200}refusedReturnValue: ""/);
});

test("cloud-safe channels work from both windows; cloud-only channels only from the Cloud-home window", async () => {
  const f = gateFixture();
  f.gate.handle("desktop:open-external", () => "opened");
  f.gate.handle("cloud-home:ping", () => "pong");
  assert.equal(await f.raw.handles.get("desktop:open-external")(f.cloudWindow.event), "opened");
  assert.equal(await f.raw.handles.get("desktop:open-external")(f.main.event), "opened");
  assert.equal(await f.raw.handles.get("cloud-home:ping")(f.cloudWindow.event), "pong");
  const error = await f.raw.handles.get("cloud-home:ping")(f.main.event).then(() => null, (e) => e);
  assert.equal(error.code, OWNED_MAIN_IPC_REFUSAL, "the main window may not use a cloud-only channel");
  assert.deepEqual(f.refused, ["cloud-home:ping"]);
});

test("a cloud-looking sender that is not the Cloud-home top frame is refused like any foreign sender", async () => {
  const f = gateFixture();
  f.gate.handle("desktop:open-external", () => "opened");
  const sub = windowFixture(`murage-home://${HOME}/`);
  const subframe = { ...sub.event, senderFrame: { url: `murage-home://${HOME}/`, parent: {}, detached: false } };
  const other = windowFixture(`murage-home://${HOME}/`);
  for (const event of [subframe, other.event, { sender: f.cloudWindow.webContents, senderFrame: { url: "https://evil.example/", detached: false } }]) {
    const error = await f.raw.handles.get("desktop:open-external")(event).then(() => null, (e) => e);
    assert.equal(error?.code, OWNED_MAIN_IPC_REFUSAL);
  }
  assert.deepEqual(f.cloudRefused, [], "foreign senders go to the ordinary refusal log");
  assert.equal(f.refused.length, 3);
});

test("isCloudHomeSender: top frame on murage-home://<homeId>/ only", () => {
  const ok = windowFixture(`murage-home://${HOME}/settings`);
  assert.equal(isCloudHomeSender(ok.event, { window: ok.window, homeId: HOME }), true);
  for (const [label, url] of Object.entries({ "another home": "murage-home://h-other/", "web page": "https://h-abc/", credentials: `murage-home://u:p@${HOME}/`, port: `murage-home://${HOME}:81/`, garbage: "not a url" })) {
    const f = windowFixture(url);
    assert.equal(isCloudHomeSender(f.event, { window: f.window, homeId: HOME }), false, label);
  }
  assert.equal(isCloudHomeSender(ok.event, { window: { ...ok.window, isDestroyed: () => true }, homeId: HOME }), false, "destroyed");
  assert.equal(isCloudHomeSender(ok.event, { window: ok.window }), false, "no homeId");
  assert.equal(isCloudHomeSender(null, { window: ok.window, homeId: HOME }), false);
  assert.equal(isOwnedMainSender(ok.event, { window: ok.window, origin: `murage-home://${HOME}` }), false, "the main predicate never accepts an opaque scheme origin");
});

test("installCloudHome's controller recognises its own windows as the cloud sender kind", () => {
  const wins = [];
  const proxy = () => new Proxy(function () {}, { get: (_t, p) => (p === "then" ? undefined : proxy()), apply: () => undefined });
  const BrowserWindow = function () {
    const w = windowFixture(`murage-home://${HOME}/`);
    Object.assign(w.window, { focus() {}, on() {}, loadURL: async () => {}, webContents: Object.assign(w.webContents, { on() {}, setWindowOpenHandler() {} }) });
    wins.push(w);
    return w.window;
  };
  const cloud = installCloudHome({ protocol: { registerSchemesAsPrivileged() {} }, session: { fromPartition: () => proxy() }, BrowserWindow, shell: proxy(), net: proxy(), env: { MURAGE_DESKTOP_CLOUD: "1" }, packaged: false, distDir: "/nonexistent" });
  assert.equal(cloud.isCloudSender(windowFixture(`murage-home://${HOME}/`).event), false, "no window open yet");
  cloud.open(HOME);
  assert.equal(cloud.isCloudSender(wins[0].event), true);
  assert.equal(cloud.isCloudSender(windowFixture(`${ORIGIN}/`).event), false);
});

// ── flag off ────────────────────────────────────────────────────────────────

test("flag off: the gate without `cloud` is the train's main-window-only gate", async () => {
  const f = gateFixture({ withCloud: false });
  f.gate.handle("desktop:open-external", () => "opened");
  f.gate.handle("credential:set", () => "set");
  f.gate.on("desktop:surface-secret", (e) => { e.returnValue = "s"; }, { refusedReturnValue: "" });
  assert.equal(await f.raw.handles.get("credential:set")(f.main.event), "set");
  for (const channel of ["desktop:open-external", "credential:set"]) {
    const error = await f.raw.handles.get(channel)(f.cloudWindow.event).then(() => null, (e) => e);
    assert.equal(error.code, OWNED_MAIN_IPC_REFUSAL, `${channel}: a cloud-looking sender is just a foreign sender`);
  }
  assert.deepEqual(f.cloudRefused, []);
  assert.deepEqual(f.gate.registrations(), [{ channel: "desktop:open-external", kind: "handle" }, { channel: "credential:set", kind: "handle" }, { channel: "desktop:surface-secret", kind: "sync" }]);
});

test("main.mjs hands the gate the Cloud sender kind only when the flag installed the Cloud home", () => {
  const main = read("main.mjs");
  assert.match(main, /const ipcMain = createOwnedMainIpc\(\{\s*ipcMain: electronIpcMain,\s*(?:\/\/[^\n]*\n\s*)*cloud: cloudHome \? \{ isCloudSender: \(event\) => cloudHome\.isCloudSender\(event\), classOf: channelClass,/);
  assert.match(main, /\} : undefined,\s*isTrusted:/);
  assert.match(main, /const cloudHome = installCloudHome\(/);
  assert.ok(main.indexOf("const cloudHome = installCloudHome(") < main.indexOf("const ipcMain = createOwnedMainIpc("), "cloudHome exists before the gate is built");
});

test("flag off: the registered channel set is exactly cloud-v2/b3's (snapshot), and the flag adds only the engine sign-in relay", () => {
  const snapshot = JSON.parse(read("ipc-channels.flag-off.snapshot.json"));
  assert.equal(snapshot.base, "cloud-v2/b3 @ 471d88479");
  assert.deepEqual({ handles: inventory.handles, ons: inventory.ons }, { handles: snapshot.handles, ons: snapshot.ons });
  const added = flagOn.handles.filter((c) => !inventory.handles.includes(c));
  assert.deepEqual(added, ["cloud-home:connect-cancel", "cloud-home:connect-paste", "cloud-home:connect-start", "cloud-home:connect-status", "cloud-home:disconnect", "cloud-home:disconnect-this", "cloud-home:engine-login:input", "cloud-home:engine-login:open-link", "cloud-home:engine-login:start", "cloud-home:engine-login:stop", "cloud-home:list-bots", "cloud-home:list-homes", "cloud-home:open", "cloud-home:reachable", "cloud-home:state"], "flag on adds ONLY the WP4 cloud-home:* channels and the WP5 engine sign-in relay");
  assert.deepEqual(flagOn.ons, inventory.ons, "flag on adds no listener channel");
  assert.deepEqual(inventory.handles.filter((c) => !flagOn.handles.includes(c)), [], "flag on removes nothing");
  for (const channel of added.filter((c) => c.startsWith("cloud-home:engine-login:"))) assert.equal(channelClass(channel), CLASS_LOCAL_ONLY, `${channel} is main-window only`);
});

// ── preload ─────────────────────────────────────────────────────────────────

test("if the Cloud-home window ever loads the shared preload it gets no bridge: the origin argument is the main window's", () => {
  const run = (argv, origin) => {
    const calls = { sendSync: 0, on: 0, invoke: 0 };
    let exposed = null;
    const electron = {
      contextBridge: { exposeInMainWorld: (key, value) => { exposed = { key, value }; } },
      ipcRenderer: { sendSync: () => { calls.sendSync++; return ""; }, on: () => calls.on++, removeListener() {}, invoke: () => { calls.invoke++; return Promise.resolve(); }, send() {} },
      webUtils: { getPathForFile: () => "" },
    };
    vm.runInNewContext(preloadSource, { require: () => electron, process: { platform: "darwin", argv }, location: { origin }, URL, queueMicrotask });
    return { exposed, calls };
  };
  // A cloud window has no --murage-renderer-origin argument, and murage-home:// has an opaque origin ("null"): fail closed.
  for (const [label, argv, origin] of [["no argument", ["electron"], "murage-home://h-abc"], ["the main origin argument on the scheme", rendererOriginArguments(ORIGIN), "murage-home://h-abc"]]) {
    const result = run(argv, origin);
    assert.equal(result.exposed, null, label);
    assert.deepEqual(result.calls, { sendSync: 0, on: 0, invoke: 0 }, label);
  }
});

test("no flag: the same channels as flag on are registered, as stubs that refuse until Cloud is live", () => {
  assert.deepEqual(inertDefault.handles, flagOn.handles);
  assert.deepEqual(inertDefault.ons, flagOn.ons);
});
