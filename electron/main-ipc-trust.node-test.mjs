// Owned-main-window trust sweep (0.1.52 S1-T3, audit B6).
//
// Four layers, each against the code the app runs:
//   - the IPC gate and navigation guard, with the real owned-main predicate;
//   - the real preload.cjs, evaluated with a recording Electron bridge;
//   - the real main.mjs, loaded under an inert Electron stub: every channel it
//     registers must refuse a foreign sender before its listener runs;
//   - the inventory: every channel the preload can reach is registered through
//     the gate, including the CUA, Android and updater registrars.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  OWNED_MAIN_IPC_REFUSAL,
  RENDERER_ORIGIN_ARGUMENT,
  createMainNavigationGuard,
  createOwnedMainIpc,
  mainNavigationAction,
  rendererOriginArguments,
} from "./main-ipc-trust.mjs";
import { isOwnedMainSender } from "./main-trust.mjs";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://127.0.0.1:8799";

function ownedFixture(url = `${ORIGIN}/`) {
  const mainFrame = { url, detached: false };
  const webContents = { mainFrame, isDestroyed: () => false };
  const window = { webContents, isDestroyed: () => false };
  return { window, webContents, mainFrame, event: { sender: webContents, senderFrame: mainFrame } };
}

function recordingIpc() {
  const handles = new Map();
  const listeners = new Map();
  return {
    ipcMain: { handle: (channel, fn) => handles.set(channel, fn), on: (channel, fn) => listeners.set(channel, fn) },
    handles,
    listeners,
  };
}

// ── the gate ────────────────────────────────────────────────────────────────

test("a trusted sender reaches the listener with its arguments", async () => {
  const owned = ownedFixture();
  const raw = recordingIpc();
  const gate = createOwnedMainIpc({ ipcMain: raw.ipcMain, isTrusted: (event) => isOwnedMainSender(event, { window: owned.window, origin: ORIGIN }) });
  gate.handle("credential:set", (_event, name, value) => ({ name, value }));
  assert.deepEqual(await raw.handles.get("credential:set")(owned.event, "xaiApiKey", "fixture"), { name: "xaiApiKey", value: "fixture" });
  let secretEvent = { ...owned.event };
  gate.on("desktop:surface-secret", (event) => { event.returnValue = "fixture-secret"; }, { refusedReturnValue: "" });
  raw.listeners.get("desktop:surface-secret")(secretEvent);
  assert.equal(secretEvent.returnValue, "fixture-secret");
  assert.deepEqual(gate.registrations(), [
    { channel: "credential:set", kind: "handle" },
    { channel: "desktop:surface-secret", kind: "sync" },
  ]);
});

test("every untrusted sender is refused before the listener runs", async () => {
  const owned = ownedFixture();
  const other = ownedFixture();
  const raw = recordingIpc();
  const refused = [];
  let calls = 0;
  const gate = createOwnedMainIpc({
    ipcMain: raw.ipcMain,
    isTrusted: (event) => isOwnedMainSender(event, { window: owned.window, origin: ORIGIN }),
    onRefused: (channel) => refused.push(channel),
  });
  gate.handle("screen:frame", () => { calls++; return "captured"; });
  gate.on("desktop:surface-secret", (event) => { calls++; event.returnValue = "secret"; }, { refusedReturnValue: "" });
  gate.on("screen:preview-intent", (event) => { calls++; event.returnValue = true; }, { refusedReturnValue: false });
  gate.on("desktop:unread-count", () => { calls++; });

  const navigatedAway = ownedFixture("https://example.com/");
  const detached = ownedFixture();
  detached.mainFrame.detached = true;
  const senders = {
    "another window": other.event,
    "a subframe": { sender: owned.webContents, senderFrame: { url: `${ORIGIN}/`, detached: false } },
    "a navigated-away origin": { sender: navigatedAway.webContents, senderFrame: navigatedAway.mainFrame },
    "a look-alike port": (() => { const f = ownedFixture("http://127.0.0.1:8800/"); return { sender: f.webContents, senderFrame: f.mainFrame }; })(),
    "a detached frame": { sender: detached.webContents, senderFrame: detached.mainFrame },
    "no event": undefined,
  };
  for (const [label, event] of Object.entries(senders)) {
    // The navigated/look-alike fixtures are separate windows too; point the
    // owned window at them so only their origin or frame state differs.
    const window = label === "a navigated-away origin" ? navigatedAway.window
      : label === "a look-alike port" ? { webContents: event.sender, isDestroyed: () => false }
      : label === "a detached frame" ? detached.window : owned.window;
    const scoped = recordingIpc();
    const scopedGate = createOwnedMainIpc({ ipcMain: scoped.ipcMain, isTrusted: (e) => isOwnedMainSender(e, { window, origin: ORIGIN }), onRefused: (c) => refused.push(c) });
    scopedGate.handle("screen:frame", () => { calls++; return "captured"; });
    await assert.rejects(scoped.handles.get("screen:frame")(event), (error) => error.code === OWNED_MAIN_IPC_REFUSAL && /main Murage window/.test(error.message), label);
  }
  await assert.rejects(raw.handles.get("screen:frame")(other.event), { code: OWNED_MAIN_IPC_REFUSAL });

  const secretEvent = { ...other.event };
  raw.listeners.get("desktop:surface-secret")(secretEvent);
  assert.equal(secretEvent.returnValue, "", "a refused secret request is answered with no secret");
  const intentEvent = { ...other.event };
  raw.listeners.get("screen:preview-intent")(intentEvent);
  assert.equal(intentEvent.returnValue, false, "a refused capture intent arms nothing");
  const unreadEvent = { ...other.event };
  raw.listeners.get("desktop:unread-count")(unreadEvent, 3);
  assert.equal(Object.hasOwn(unreadEvent, "returnValue"), false, "an async message gets no synthetic reply");

  assert.equal(calls, 0, "no listener ran for an untrusted sender");
  assert.ok(refused.includes("screen:frame") && refused.includes("desktop:surface-secret"));
});

test("a throwing trust check or refusal logger still refuses", async () => {
  const raw = recordingIpc();
  const gate = createOwnedMainIpc({
    ipcMain: raw.ipcMain,
    isTrusted: () => { throw new Error("window destroyed"); },
    onRefused: () => { throw new Error("log unavailable"); },
  });
  let ran = false;
  gate.handle("update:install", () => { ran = true; });
  await assert.rejects(raw.handles.get("update:install")({}), { code: OWNED_MAIN_IPC_REFUSAL });
  const truthy = recordingIpc();
  createOwnedMainIpc({ ipcMain: truthy.ipcMain, isTrusted: () => "yes" }).handle("update:install", () => { ran = true; });
  await assert.rejects(truthy.handles.get("update:install")({}), { code: OWNED_MAIN_IPC_REFUSAL }, "only a literal true is trust");
  assert.equal(ran, false);
});

// ── navigation ──────────────────────────────────────────────────────────────

test("the main window stays on its renderer origin", () => {
  assert.equal(mainNavigationAction(`${ORIGIN}/settings#x`, { origin: ORIGIN }), "allow");
  assert.equal(mainNavigationAction("https://example.com/docs", { origin: ORIGIN }), "external");
  assert.equal(mainNavigationAction("http://127.0.0.1:8800/", { origin: ORIGIN }), "external", "a look-alike port is another site");
  for (const url of [
    "https://user:pass@example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x",
    "about:blank", "murage://install?x", "x-apple.systempreferences:com.apple.preference.security", "", "not a url", undefined,
  ]) {
    assert.equal(mainNavigationAction(url, { origin: ORIGIN }), "deny", String(url));
  }
  assert.equal(mainNavigationAction(`${ORIGIN}/`, { origin: null }), "external", "an unusable origin never allows in place");
  assert.equal(mainNavigationAction("data:text/html,x", { origin: "data:text/html,x" }), "deny", "opaque origins never match");
});

test("will-navigate refuses and opens web links externally; will-redirect only refuses", async () => {
  const opened = [];
  const warnings = [];
  const guard = createMainNavigationGuard({ origin: () => ORIGIN, openExternal: (url) => { opened.push(url); }, warn: (m) => warnings.push(m) });
  const event = (fields) => {
    const value = { prevented: false, preventDefault() { this.prevented = true; }, ...fields };
    return value;
  };

  const same = event({ url: `${ORIGIN}/bots`, isMainFrame: true });
  guard.willNavigate(same);
  assert.equal(same.prevented, false);

  const foreign = event({ url: "https://example.com/a b", isMainFrame: true });
  guard.willNavigate(foreign);
  assert.equal(foreign.prevented, true);
  assert.deepEqual(opened, ["https://example.com/a%20b"]);

  // Deprecated positional arguments (event, url, isInPlace, isMainFrame).
  const legacy = event({});
  guard.willNavigate(legacy, "file:///Users/me/secret.txt", false, true);
  assert.equal(legacy.prevented, true);
  assert.equal(opened.length, 1, "non-web targets are never handed to the OS");

  const missingFrameFlag = event({ url: "https://example.com/" });
  guard.willNavigate(missingFrameFlag);
  assert.equal(missingFrameFlag.prevented, true, "an unknown frame is treated as the main frame");

  const subframe = event({ url: "https://example.com/embed", isMainFrame: false });
  guard.willNavigate(subframe);
  guard.willRedirect(subframe);
  assert.equal(subframe.prevented, false, "subframes are governed by the IPC gate, not here");

  const redirect = event({ url: "https://example.com/landing", isMainFrame: true });
  guard.willRedirect(redirect);
  assert.equal(redirect.prevented, true);
  const sameRedirect = event({ url: `${ORIGIN}/index.html`, isMainFrame: true });
  guard.willRedirect(sameRedirect);
  assert.equal(sameRedirect.prevented, false);
  assert.equal(opened.length, 2, "only the missing-frame navigation opened; redirects never open");

  const failing = createMainNavigationGuard({ origin: () => ORIGIN, openExternal: () => { throw new Error("no browser"); }, warn: (m) => warnings.push(m) });
  const rejecting = createMainNavigationGuard({ origin: () => ORIGIN, openExternal: async () => { throw new Error("no browser"); }, warn: (m) => warnings.push(m) });
  const a = event({ url: "https://example.com/", isMainFrame: true });
  const b = event({ url: "https://example.com/", isMainFrame: true });
  failing.willNavigate(a);
  rejecting.willNavigate(b);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(a.prevented && b.prevented, true);
  assert.ok(warnings.filter((m) => m === "The external web link could not be opened").length >= 2);
  assert.ok(warnings.every((m) => !m.includes("example.com")), "warnings never echo the address");
});

// ── preload ─────────────────────────────────────────────────────────────────

const preloadSource = fs.readFileSync(path.join(electronDir, "preload.cjs"), "utf8");

function runPreload({ argv, origin }) {
  const calls = { sendSync: [], on: [], invoke: [] };
  let exposed = null;
  const electron = {
    contextBridge: { exposeInMainWorld: (key, value) => { exposed = { key, value }; } },
    ipcRenderer: {
      sendSync: (channel) => { calls.sendSync.push(channel); return channel === "desktop:surface-secret" ? "fixture-secret" : false; },
      on: (channel) => calls.on.push(channel),
      removeListener() {},
      invoke: (channel, ...args) => { calls.invoke.push(channel); return Promise.resolve([channel, ...args]); },
      send() {},
    },
    webUtils: { getPathForFile: () => "" },
  };
  vm.runInNewContext(preloadSource, {
    require: (name) => { assert.equal(name, "electron"); return electron; },
    process: { platform: "darwin", argv },
    location: origin === undefined ? undefined : { origin },
    URL,
    queueMicrotask,
  });
  return { exposed, calls };
}

test("the preload exposes the bridge and asks for the secret only on the named origin", async () => {
  const owned = runPreload({ argv: ["electron", ...rendererOriginArguments(`${ORIGIN}/ignored/path`)], origin: ORIGIN });
  assert.equal(owned.exposed.key, "muragebox");
  assert.equal(owned.exposed.value.desktopSurfaceSecret, "fixture-secret");
  assert.deepEqual(owned.calls.sendSync, ["desktop:surface-secret"]);
  assert.deepEqual(await owned.exposed.value.companion.refreshTailscale(), ["companion:refresh-tailscale"]);

  const refusedCases = {
    "a foreign origin": { argv: rendererOriginArguments(ORIGIN), origin: "https://example.com" },
    "a look-alike port": { argv: rendererOriginArguments(ORIGIN), origin: "http://127.0.0.1:8800" },
    "an opaque data: document": { argv: rendererOriginArguments(ORIGIN), origin: "null" },
    "a window without the argument": { argv: ["electron"], origin: ORIGIN },
    "an opaque named origin": { argv: [`${RENDERER_ORIGIN_ARGUMENT}null`], origin: "null" },
    "a malformed argument": { argv: [`${RENDERER_ORIGIN_ARGUMENT}::::`], origin: ORIGIN },
    "no location": { argv: rendererOriginArguments(ORIGIN), origin: undefined },
  };
  for (const [label, input] of Object.entries(refusedCases)) {
    const result = runPreload(input);
    assert.equal(result.exposed, null, `${label}: no bridge`);
    assert.deepEqual(result.calls, { sendSync: [], on: [], invoke: [] }, `${label}: no IPC at all`);
  }
});

test("main hands the preload a normalized origin argument, or none", () => {
  assert.deepEqual(rendererOriginArguments(`${ORIGIN}/index.html`), [`${RENDERER_ORIGIN_ARGUMENT}${ORIGIN}`]);
  for (const bad of [null, undefined, "", "file:///x.html", "data:text/html,x", "nope"]) {
    assert.deepEqual(rendererOriginArguments(bad), [], String(bad));
  }
});

// ── the real main.mjs ───────────────────────────────────────────────────────

function electronNamedImports() {
  const names = new Set(["app", "ipcMain"]);
  for (const name of fs.readdirSync(electronDir).filter((file) => file.endsWith(".mjs"))) {
    const source = fs.readFileSync(path.join(electronDir, name), "utf8");
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']electron["']/g)) {
      for (const part of match[1].split(",")) {
        const imported = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (imported) names.add(imported);
      }
    }
  }
  return [...names].sort();
}

// Only "electron" is replaced. Every API is an inert stand-in; ipcMain keeps
// the listeners main.mjs registers, and app.whenReady never resolves, so no
// window, server, lease or helper exists. mainWindow therefore stays null and
// the gate must refuse everything; a handler that runs its own body instead
// answers differently and fails the test.
const childSource = String.raw`
import { registerHooks } from "node:module";
const exportNames = JSON.parse(process.env.MURAGE_TEST_ELECTRON_EXPORTS);
const stubUrl = "murage-test:electron";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "electron") return { url: stubUrl, format: "module", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== stubUrl) return nextLoad(url, context);
    const lines = exportNames.filter((name) => name !== "app" && name !== "ipcMain")
      .map((name) => "export const " + name + " = inert(" + JSON.stringify(name) + ");");
    return { format: "module", shortCircuit: true, source: [
      "const record = globalThis.__murageIpc;",
      "function inert(label) {",
      "  const target = function () {};",
      "  return new Proxy(target, {",
      "    get(_t, key) {",
      "      if (key === 'then') return undefined;",
      "      if (key === Symbol.toPrimitive) return () => '';",
      "      if (key === Symbol.iterator) return undefined;",
      "      return inert(label + '.' + String(key));",
      "    },",
      "    apply() { return inert(label + '()'); },",
      "    construct() { return inert('new ' + label); },",
      "  });",
      "}",
      "const paths = JSON.parse(process.env.MURAGE_TEST_ELECTRON_PATHS);",
      "export const app = new Proxy({",
      "  isPackaged: false,",
      "  getPath: (name) => paths[name] ?? paths.userData,",
      "  getVersion: () => '0.0.0-test',",
      "  getName: () => 'Murage',",
      "  requestSingleInstanceLock: () => true,",
      "  whenReady: () => new Promise(() => {}),",
      "}, { get(target, key) { return key in target ? target[key] : key === 'then' ? undefined : inert('app.' + String(key)); } });",
      "export const ipcMain = {",
      "  handle(channel, listener) { record.handles.set(channel, listener); },",
      "  on(channel, listener) { record.ons.set(channel, listener); },",
      "  once(channel, listener) { record.ons.set(channel, listener); },",
      "  removeHandler() {}, removeListener() {}, removeAllListeners() {},",
      "};",
      ...lines,
      "export default { app, ipcMain, " + exportNames.filter((name) => name !== "app" && name !== "ipcMain").join(", ") + " };",
    ].join("\n") };
  },
});
globalThis.__murageIpc = { handles: new Map(), ons: new Map() };
const report = { handles: {}, ons: {}, registrars: {} };
try {
  const mainUrl = process.env.MURAGE_TEST_MAIN_URL;
  await import(mainUrl);
  const record = globalThis.__murageIpc;
  // A plausible foreign sender: a top frame, but not the owned window's.
  const foreignEvent = () => {
    const mainFrame = { url: "https://attacker.test/", detached: false };
    return { sender: { mainFrame, isDestroyed: () => false }, senderFrame: mainFrame };
  };
  for (const [channel, listener] of record.handles) {
    try {
      const value = await listener(foreignEvent(), "fixture-argument");
      report.handles[channel] = { settled: "resolved", type: typeof value };
    } catch (error) {
      report.handles[channel] = { settled: "rejected", code: error?.code ?? null, message: String(error?.message ?? error) };
    }
  }
  for (const [channel, listener] of record.ons) {
    const event = foreignEvent();
    try {
      listener(event, "fixture-argument");
      report.ons[channel] = { threw: false, hasReturnValue: Object.hasOwn(event, "returnValue"), returnValue: event.returnValue ?? null };
    } catch (error) {
      report.ons[channel] = { threw: true, message: String(error?.message ?? error) };
    }
  }
  // The registrars main.mjs calls after app readiness must register on the
  // ipc object they are given, never on Electron's raw ipcMain.
  const before = record.handles.size;
  for (const [name, specifier, register] of [
    ["cua", "./cua.mjs", (m, ipc) => m.registerCuaIpc(ipc)],
    ["updater", "./updater.mjs", (m, ipc) => m.registerUpdaterIpc(ipc)],
  ]) {
    const mod = await import(new URL(specifier, mainUrl).href);
    const channels = [];
    register(mod, { handle: (channel) => channels.push(channel), on: (channel) => channels.push(channel) });
    report.registrars[name] = channels;
  }
  report.rawRegistrationsByRegistrars = record.handles.size - before;
  process.stdout.write("MURAGE_IPC_TRUST " + JSON.stringify({ ok: true, ...report }) + "\n");
  process.exit(0);
} catch (error) {
  process.stdout.write("MURAGE_IPC_TRUST " + JSON.stringify({ ok: false, error: String(error?.stack ?? error) }) + "\n");
  process.exit(1);
}
`;

function loadMainUnderStub() {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "murage-ipc-trust-")));
  try {
    const home = path.join(scratch, "home");
    const userData = path.join(scratch, "user-data");
    const dataDir = path.join(scratch, "data");
    for (const directory of [home, userData, dataDir]) fs.mkdirSync(directory, { recursive: true });
    const paths = { home, userData, sessionData: userData, logs: path.join(userData, "logs"), temp: scratch,
      appData: scratch, downloads: scratch, desktop: scratch, documents: scratch, exe: process.execPath };
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (key.startsWith("MURAGE_") || key.startsWith("ELECTRON_")) delete environment[key];
    }
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...environment,
        HOME: home,
        USERPROFILE: home,
        MURAGE_DATA_DIR: dataDir,
        MURAGE_USER_DATA: userData,
        MURAGE_TEST_MAIN_URL: pathToFileURL(path.join(electronDir, "main.mjs")).href,
        MURAGE_TEST_ELECTRON_EXPORTS: JSON.stringify(electronNamedImports()),
        MURAGE_TEST_ELECTRON_PATHS: JSON.stringify(paths),
      },
    });
    assert.equal(result.error, undefined, String(result.error));
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("MURAGE_IPC_TRUST "));
    assert.ok(line, `main.mjs produced no report (status ${result.status}):\n${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(line.slice("MURAGE_IPC_TRUST ".length));
    assert.equal(report.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return report;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const preloadChannels = [...preloadSource.matchAll(/ipcRenderer\.(invoke|sendSync|send)\("([^"]+)"/g)]
  .map((match) => ({ method: match[1], channel: match[2] }));
// Registered after app readiness by these modules, through the gate (checked below).
const REGISTRAR_CHANNELS = {
  cua: ["cua:connection", "cua:permissions", "cua:linux-status", "cua:linux-enable", "cua:linux-disable", "cua:linux-retry"],
  updater: ["update:get-state", "update:check", "update:download", "update:install", "update:retry"],
  android: ["android-device:status", "android-device:frame", "android-device:input"],
};

test("every IPC channel main.mjs registers refuses a foreign sender before its listener runs", () => {
  const report = loadMainUnderStub();
  const handles = Object.entries(report.handles);
  assert.ok(handles.length >= 50, `expected the full handler inventory, got ${handles.length}`);
  for (const [channel, outcome] of handles) {
    assert.deepEqual(
      { settled: outcome.settled, code: outcome.code },
      { settled: "rejected", code: OWNED_MAIN_IPC_REFUSAL },
      `${channel} must be refused by the owned-main gate (${outcome.message ?? outcome.type})`,
    );
  }
  assert.deepEqual(report.ons, {
    "screen:preview-intent": { threw: false, hasReturnValue: true, returnValue: false },
    "desktop:surface-secret": { threw: false, hasReturnValue: true, returnValue: "" },
    "desktop:unread-count": { threw: false, hasReturnValue: false, returnValue: null },
  });

  // Every channel the preload can reach is registered by main.mjs through the
  // gate, or by a registrar main.mjs hands the gate.
  const registrarChannels = new Set(Object.values(REGISTRAR_CHANNELS).flat());
  for (const { method, channel } of preloadChannels) {
    if (registrarChannels.has(channel)) continue;
    const table = method === "invoke" ? report.handles : report.ons;
    assert.ok(Object.hasOwn(table, channel), `${method} ${channel} has no gated main.mjs registration`);
  }
  assert.deepEqual(report.registrars, { cua: REGISTRAR_CHANNELS.cua, updater: REGISTRAR_CHANNELS.updater });
  assert.equal(report.rawRegistrationsByRegistrars, 0, "registrars must not fall back to Electron's raw ipcMain");
});

test("main.mjs routes its registrars and the main window through the B6 policy", () => {
  const source = fs.readFileSync(path.join(electronDir, "main.mjs"), "utf8");
  // The raw Electron ipcMain is reachable in exactly three places: its import,
  // the gate that wraps it, and the recovery window with its own exact-file
  // sender check (installation-recovery-window.node-test.mjs).
  assert.match(source, /import \{[^}]*\bipcMain as electronIpcMain\b[^}]*\} from "electron";/);
  assert.equal([...source.matchAll(/\belectronIpcMain\b/g)].length, 3);
  assert.match(source, /const ipcMain = createOwnedMainIpc\(\{\s*ipcMain: electronIpcMain,/);
  assert.match(source, /BrowserWindow, ipcMain: electronIpcMain, dialog, baseDir: __dirname,/);
  assert.match(source, /registerCuaIpc\(ipcMain\);/);
  assert.match(source, /androidDevice\.registerIpc\(ipcMain\);/);
  assert.match(source, /registerUpdaterIpc\(ipcMain\);/);

  const start = source.indexOf("function createWindow(");
  const createWindow = source.slice(start, source.indexOf("\n}\n", start));
  assert.match(createWindow, /preload: path\.join\(__dirname, "preload\.cjs"\),\s*\/\/[^\n]*\n\s*additionalArguments: rendererOriginArguments\(trustedRendererOrigin\(\)\),/);
  assert.match(createWindow, /win\.webContents\.on\("will-navigate", navigationGuard\.willNavigate\);/);
  assert.match(createWindow, /win\.webContents\.on\("will-redirect", navigationGuard\.willRedirect\);/);
  assert.match(createWindow, /createMainNavigationGuard\(\{\s*origin: trustedRendererOrigin,/);
});
