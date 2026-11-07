import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLOUD_OPEN_MS, CLOUD_RETRY_MS, cloudHomeEnabled, cloudRequestAllowed, createDistReader, installCloudHome } from "./cloud-home-window.mjs";
import { cloudHomeNavigationAction, createMainNavigationGuard } from "./main-ipc-trust.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

function deps(env, extra = {}) {
  const log = [];
  const proxy = (name) => new Proxy(function () {}, { get: (_t, p) => (p === "then" ? undefined : (...a) => { log.push([name, String(p), a.length]); return proxy(`${name}.${String(p)}`); }), apply: (...x) => { log.push([name, "call"]); return undefined; } });
  const protocol = { registerSchemesAsPrivileged: (list) => log.push(["registerSchemesAsPrivileged", list]) };
  const session = { fromPartition: (p) => { log.push(["fromPartition", p]); return proxy("session"); } };
  return { log, args: { protocol, session, BrowserWindow: function () { log.push(["BrowserWindow"]); }, shell: proxy("shell"), net: proxy("net"), env, distDir: "/nonexistent", ...extra } };
}

test("MURAGE_DESKTOP_CLOUD=0 is a hard off: nothing registered and nothing touched", () => {
  const { log, args } = deps({ MURAGE_DESKTOP_CLOUD: "0" });
  assert.equal(installCloudHome(args), null);
  assert.deepEqual(log, []);
});

test("no flag: the scheme is registered but inert (inactive, open refuses, no window, nothing else touched)", () => {
  for (const env of [{}, { MURAGE_DESKTOP_CLOUD: "" }, { MURAGE_DESKTOP_CLOUD: "true" }]) {
    const { log, args } = deps(env);
    const cloud = installCloudHome(args);
    assert.equal(cloud.active(), false);
    assert.equal(log.length, 1);
    assert.equal(log[0][0], "registerSchemesAsPrivileged");
    assert.throws(() => cloud.open("11111111-1111-4111-8111-111111111111"), /isn't available/);
    assert.equal(log.length, 1);
  }
});

test("flag on (unpackaged build) registers exactly the privileged scheme, opens no window until asked", () => {
  const { log, args } = deps({ MURAGE_DESKTOP_CLOUD: "1" }, { packaged: false });
  const cloud = installCloudHome(args);
  assert.ok(cloud);
  assert.equal(log.length, 1);
  const [name, list] = log[0];
  assert.equal(name, "registerSchemesAsPrivileged");
  assert.deepEqual(list, [{ scheme: "murage-home", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
  assert.throws(() => cloud.open("../x"));
});

test("flag file in user data turns it on in an unpackaged build only; env 0 wins over the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-flag-"));
  const dev = { packaged: false };
  try {
    assert.equal(cloudHomeEnabled({ env: {}, userDataDir: dir, ...dev }), false);
    fs.writeFileSync(path.join(dir, "desktop-flags.json"), JSON.stringify({ cloud: true }));
    assert.equal(cloudHomeEnabled({ env: {}, userDataDir: dir, ...dev }), true);
    assert.equal(cloudHomeEnabled({ env: {}, userDataDir: () => dir, ...dev }), true);
    assert.equal(cloudHomeEnabled({ env: { MURAGE_DESKTOP_CLOUD: "0" }, userDataDir: dir, ...dev }), false);
    assert.equal(cloudHomeEnabled({ env: {}, userDataDir: dir, packaged: true }), false, "packaged: the file is ignored");
    assert.equal(cloudHomeEnabled({ env: { MURAGE_DESKTOP_CLOUD: "1" }, userDataDir: dir, packaged: true }), false, "packaged: =1 is ignored");
    assert.equal(cloudHomeEnabled({ env: { MURAGE_DESKTOP_CLOUD: "1" }, userDataDir: dir }), false, "no packaged flag: fails closed");
    fs.writeFileSync(path.join(dir, "desktop-flags.json"), "not json");
    assert.equal(cloudHomeEnabled({ env: {}, userDataDir: dir, ...dev }), false);
  } finally { safeWipeSync(dir); }
});

test("dist reader stays inside dist", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-dist-"));
  try {
    fs.mkdirSync(path.join(dir, "dist", "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "index.html"), "ok");
    fs.writeFileSync(path.join(dir, "secret.txt"), "no");
    const read = createDistReader(path.join(dir, "dist"));
    assert.equal((await read("index.html")).toString(), "ok");
    assert.equal(await read("../secret.txt"), null);
    assert.equal(await read("assets"), null, "directory");
    assert.equal(await read("nope.js"), null);
  } finally { safeWipeSync(dir); }
});

test("cloud partition blocks every request outside the scheme", () => {
  assert.equal(cloudRequestAllowed("murage-home://h/x"), true);
  for (const u of ["https://evil.example/", "http://127.0.0.1:8799/", "wss://x/", "file:///etc/passwd", "ftp://x", "not a url"]) assert.equal(cloudRequestAllowed(u), false, u);
});

test("nav guard: the top frame may load asar paths only", () => {
  const a = (u) => cloudHomeNavigationAction(u, { homeId: "h-abc" });
  assert.equal(a("murage-home://h-abc/"), "allow");
  assert.equal(a("murage-home://h-abc/settings"), "allow");
  assert.equal(a("murage-home://h-abc/assets/x.js"), "allow");
  for (const u of ["murage-home://h-abc/api/threads", "murage-home://h-abc/api", "murage-home://h-abc/api/events", "murage-home://h-abc/%61pi/x",
    "murage-home://h-other/", "murage-home://h-abc/%252e%252e/x", "murage-home://h-abc/a//b", "murage-home://u:p@h-abc/", "murage-home://h-abc:81/", "murage-home://h-abc.evil/",
    "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "about:blank", "", "garbage"]) assert.equal(a(u), "deny", u);
  assert.equal(a("https://example.com/docs"), "external");
  assert.equal(a("https://u:p@example.com/"), "deny");
  assert.equal(cloudHomeNavigationAction("murage-home://h-abc/", {}), "deny");
});

test("nav guard wired through createMainNavigationGuard blocks, redirects and opens externals", () => {
  const opened = [], warned = [];
  const guard = createMainNavigationGuard({
    origin: () => "murage-home://h-abc/", action: (u) => cloudHomeNavigationAction(u, { homeId: "h-abc" }),
    openExternal: (u) => { opened.push(u); return Promise.resolve(); }, warn: (m) => warned.push(m),
  });
  const ev = (url, isMainFrame = true) => ({ url, isMainFrame, prevented: false, preventDefault() { this.prevented = true; } });
  const ok = ev("murage-home://h-abc/settings"); guard.willNavigate(ok); assert.equal(ok.prevented, false);
  const api = ev("murage-home://h-abc/api/threads"); guard.willNavigate(api); assert.equal(api.prevented, true);
  const ext = ev("https://example.com/x"); guard.willNavigate(ext); assert.equal(ext.prevented, true); assert.deepEqual(opened, ["https://example.com/x"]);
  const redirect = ev("murage-home://h-abc/api/x"); guard.willRedirect(redirect); assert.equal(redirect.prevented, true);
  const sub = ev("https://evil/", false); guard.willNavigate(sub); assert.equal(sub.prevented, false, "subframes are not governed here");
  assert.ok(warned.length >= 2);
});

// F43 (upstream 8c960af7b): a Cloud window that never loads shows the offline screen, looks again by itself, and Try again
// is a fresh watched load. On the base the window stayed blank: loadURL's failure was only a warning.
function windowWorld() {
  const loads = [], timers = new Map(), warned = [];
  let nextTimer = 0;
  const handlers = {}, contents = {
    url: "", stopped: 0,
    on: (name, fn) => { handlers[name] = fn; },
    stop() { contents.stopped += 1; },
    getURL: () => contents.url,
    setWindowOpenHandler() {},
  };
  const winEvents = {};
  function BrowserWindow() {
    this.webContents = contents;
    this.on = (name, fn) => { winEvents[name] = fn; };
    this.isDestroyed = () => false;
    this.loadURL = (url) => new Promise((resolve, reject) => { contents.url = url; loads.push({ url, resolve, reject }); });
  }
  const timerApi = { set: (work, ms) => { const id = ++nextTimer; timers.set(id, { work, ms }); return id; }, clear: (id) => { timers.delete(id); } };
  const fire = (ms) => { for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.work(); } };
  const session = { fromPartition: () => ({ protocol: { handle() {} }, setPermissionRequestHandler() {}, webRequest: { onBeforeRequest() {} } }) };
  const cloud = installCloudHome({ protocol: { registerSchemesAsPrivileged() {} }, session, BrowserWindow, shell: { openExternal: async () => {} }, net: { fetch: async () => null },
    env: { MURAGE_DESKTOP_CLOUD: "1" }, packaged: false, distDir: "/nonexistent", warn: (m) => warned.push(m), timers: timerApi });
  return { cloud, loads, timers, fire, handlers, winEvents, contents, warned };
}
const HOME = "11111111-1111-4111-8111-111111111111";
const tick = () => new Promise((r) => setImmediate(r));

test("F43: a Cloud page that hasn't loaded in 30 s shows the offline screen, then looks again by itself", async () => {
  const w = windowWorld();
  w.cloud.open(HOME);
  assert.equal(w.loads.length, 1);
  assert.equal(w.loads[0].url, `murage-home://${HOME}/`);
  assert.deepEqual([...w.timers.values()].map((t) => t.ms), [CLOUD_OPEN_MS]);
  w.fire(CLOUD_OPEN_MS);
  assert.equal(w.contents.stopped, 1);
  assert.equal(w.loads.length, 2);
  assert.ok(w.loads[1].url.startsWith("data:text/html"), "the offline screen, not a blank window");
  const page = decodeURIComponent(w.loads[1].url);
  assert.match(page, /Can't reach your Cloud right now/);
  assert.match(page, new RegExp(`href="murage-home://${HOME}/"[^>]*>Try again`));
  assert.doesNotMatch(page, /<script/i);
  // The stopped first load rejecting late changes nothing.
  w.loads[0].reject(Object.assign(new Error("aborted"), { code: "ERR_ABORTED" }));
  await tick();
  assert.equal(w.loads.length, 2);
  assert.deepEqual([...w.timers.values()].map((t) => t.ms), [CLOUD_RETRY_MS]);
  w.fire(CLOUD_RETRY_MS);
  assert.equal(w.loads.length, 3);
  assert.equal(w.loads[2].url, `murage-home://${HOME}/`);
  w.loads[2].resolve();
  await tick();
  assert.equal(w.timers.size, 0, "loaded: no watchdog, no retry left running");
  assert.equal(w.loads.length, 3);
});

test("F43: a failed load shows the offline screen at once; Try again is a fresh watched load", async () => {
  const w = windowWorld();
  w.cloud.open(HOME);
  w.loads[0].reject(Object.assign(new Error("net::ERR_FAILED"), { code: "ERR_FAILED" }));
  await tick();
  assert.ok(w.loads[1].url.startsWith("data:text/html"));
  assert.ok(w.warned.some((m) => /ERR_FAILED/.test(m)));
  const click = { url: `murage-home://${HOME}/`, isMainFrame: true, prevented: false, preventDefault() { this.prevented = true; } };
  w.handlers["will-navigate"](click);
  assert.equal(click.prevented, true, "the page's own navigation is replaced by a watched load");
  assert.equal(w.loads.length, 3);
  assert.equal(w.loads[2].url, `murage-home://${HOME}/`);
  assert.deepEqual([...w.timers.values()].map((t) => t.ms), [CLOUD_OPEN_MS], "Try again is watched too, and the auto retry is replaced");
  // Off the offline screen, navigation goes through the guard as before.
  const api = { url: `murage-home://${HOME}/api/threads`, isMainFrame: true, prevented: false, preventDefault() { this.prevented = true; } };
  w.handlers["will-navigate"](api);
  assert.equal(api.prevented, true);
  assert.equal(w.loads.length, 3);
});

test("F43: ERR_ABORTED is the page moving on, not offline; closing the window stops every timer", async () => {
  const w = windowWorld();
  w.cloud.open(HOME);
  w.loads[0].reject(Object.assign(new Error("aborted"), { code: "ERR_ABORTED" }));
  await tick();
  assert.equal(w.loads.length, 1, "no offline screen for a hand-over");
  w.contents.url = `murage-home://${HOME}/settings`;
  w.handlers["did-finish-load"]();
  assert.equal(w.timers.size, 0, "the page that took over finished: the watchdog ends");
  const w2 = windowWorld();
  w2.cloud.open(HOME);
  w2.winEvents.closed();
  assert.equal(w2.timers.size, 0);
  w2.loads[0].reject(Object.assign(new Error("x"), { code: "ERR_FAILED" }));
  await tick();
  assert.equal(w2.loads.length, 1, "a closed window never loads the offline screen");
});
