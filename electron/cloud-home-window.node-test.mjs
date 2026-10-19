import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cloudHomeEnabled, cloudRequestAllowed, createDistReader, installCloudHome } from "./cloud-home-window.mjs";
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
