// Murage Cloud B3 WP7: with the Cloud flag off the desktop is the train's desktop.
//
//   - registered IPC channels: ipc-channel-classes.node-test.mjs pins them to the snapshot (cloud-v2/b3 @ 471d88479);
//     this file re-checks that snapshot and adds the part that file cannot see, the renderer-facing bridge;
//   - the bridge (window.muragebox): every member path of the shared preload, flag off, equals the train's list in the
//     snapshot; the Cloud pairing and engine-login members exist only when main passed --murage-cloud=1;
//   - main passes that argument only when installCloudHome returned a controller (the flag is on);
//   - the flag itself is off with no environment variable and no flag file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { cloudHomeEnabled, installCloudHome } from "./cloud-home-window.mjs";
import { loadIpcInventory } from "./ipc-inventory-harness.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(electronDir, name), "utf8");
const snapshot = JSON.parse(read("ipc-channels.flag-off.snapshot.json"));
const MAIN_ORIGIN = "http://127.0.0.1:8799";

function bridgeMembers({ cloud }) {
  let exposed = null;
  const electron = {
    contextBridge: { exposeInMainWorld: (_key, value) => { exposed = value; } },
    ipcRenderer: { send() {}, sendSync: () => "", invoke: () => Promise.resolve(), on() {}, removeListener() {} },
    webUtils: { getPathForFile: () => "" },
  };
  const argv = ["electron", `--murage-renderer-origin=${MAIN_ORIGIN}`, ...(cloud ? ["--murage-cloud=1"] : [])];
  vm.runInNewContext(read("preload.cjs"), { require: () => electron, process: { platform: "darwin", argv }, location: { origin: MAIN_ORIGIN }, URL, queueMicrotask, setTimeout, console });
  assert.ok(exposed, "the main origin gets the bridge");
  const out = [];
  const walk = (object, prefix) => {
    for (const key of Object.keys(object).sort()) {
      const value = object[key];
      out.push(prefix + key + (typeof value === "function" ? "()" : ""));
      if (value && typeof value === "object") walk(value, `${prefix}${key}.`);
    }
  };
  walk(exposed, "");
  return out;
}

test("flag off: the shared preload exposes exactly the train's window.muragebox members", () => {
  assert.ok(Array.isArray(snapshot.bridgeMembers) && snapshot.bridgeMembers.length > 100);
  assert.deepEqual(bridgeMembers({ cloud: false }), snapshot.bridgeMembers);
});

test("flag on adds only the Cloud pairing and engine sign-in members to the bridge, and removes nothing", () => {
  const off = bridgeMembers({ cloud: false });
  const on = bridgeMembers({ cloud: true });
  assert.deepEqual(off.filter((member) => !on.includes(member)), []);
  assert.deepEqual(on.filter((member) => !off.includes(member)), [
    "cloudEngineLogin", "cloudEngineLogin.input()", "cloudEngineLogin.onClosed()", "cloudEngineLogin.onData()", "cloudEngineLogin.openLink()", "cloudEngineLogin.start()", "cloudEngineLogin.stop()",
    "cloudHome", "cloudHome.connectCancel()", "cloudHome.connectPaste()", "cloudHome.connectStart()", "cloudHome.connectStatus()", "cloudHome.disconnect()",
    "cloudHome.listBots()", "cloudHome.listHomes()", "cloudHome.onLinkEvent()", "cloudHome.onLive()", "cloudHome.onShowConnect()", "cloudHome.open()", "cloudHome.state()",
  ]);
});

test("main hands the preload --murage-cloud=1 only when installCloudHome returned a controller", () => {
  const main = read("main.mjs");
  const start = main.indexOf("function createWindow(");
  const createWindow = main.slice(start, main.indexOf("\n}\n", start));
  assert.equal([...createWindow.matchAll(/--murage-cloud=1/g)].length, 1);
  assert.match(createWindow, /\.\.\.\(cloudHome \? \["--murage-cloud=1"\] : \[\]\)/);
  assert.equal([...main.matchAll(/--murage-cloud=1/g)].length, 1, "no other window gets the argument");
  assert.equal([...read("cloud-home-window.mjs").matchAll(/--murage-cloud=1/g)].length, 0, "the Cloud window never gets the main bridge flag");
});

test("flag off: nothing turns the Cloud on by itself", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-flag-"));
  try {
    assert.equal(cloudHomeEnabled({ env: {}, userDataDir: dir }), false, "no variable, no flag file");
    assert.equal(cloudHomeEnabled({ env: { MURAGE_DESKTOP_CLOUD: "0" }, userDataDir: dir }), false);
    assert.equal(cloudHomeEnabled({ env: { MURAGE_DESKTOP_CLOUD: "true" }, userDataDir: dir }), false, "only \"1\" turns it on");
    fs.writeFileSync(path.join(dir, "desktop-flags.json"), "{ not json");
    assert.equal(cloudHomeEnabled({ env: {}, userDataDir: dir }), false, "a broken flag file is off");
    fs.writeFileSync(path.join(dir, "desktop-flags.json"), JSON.stringify({ cloud: "yes" }));
    assert.equal(cloudHomeEnabled({ env: {}, userDataDir: dir }), false, "only true turns it on");
  } finally {
    safeWipeSync(dir);
  }
  const touched = [];
  const spy = new Proxy({}, { get: (_t, name) => (...args) => { touched.push(String(name)); return undefined; } });
  const args = { protocol: spy, session: spy, BrowserWindow: function () { touched.push("BrowserWindow"); }, shell: spy, net: spy, distDir: "/nonexistent" };
  assert.equal(installCloudHome({ ...args, env: { MURAGE_DESKTOP_CLOUD: "0" } }), null);
  assert.deepEqual(touched, [], "hard off registers no scheme, opens no session, makes no window");
  const inert = installCloudHome({ ...args, env: {} });
  assert.equal(inert.active(), false);
  assert.deepEqual(touched, ["registerSchemesAsPrivileged"], "not live: only the inert scheme; no session, no window");
});

test("flag off: the registered channels are the snapshot's, none of them cloud-home:*", () => {
  const inventory = loadIpcInventory({ electronDir, env: { MURAGE_DESKTOP_CLOUD: "0" } });
  assert.deepEqual({ handles: inventory.handles, ons: inventory.ons }, { handles: snapshot.handles, ons: snapshot.ons });
  assert.deepEqual([...inventory.handles, ...inventory.ons].filter((channel) => channel.startsWith("cloud-home:")), []);
});
