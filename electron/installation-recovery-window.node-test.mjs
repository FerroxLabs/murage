import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { openInstallationRecoveryWindow } from "./installation-recovery-window.mjs";

test("dedicated recovery window checks exact main frame and exposes only its narrow bridge", async () => {
  let options, handler, removed = false;
  class Window extends EventEmitter {
    constructor(input) { super(); options = input; this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: "" }; this.webContents.setWindowOpenHandler = callback => { this.openWindow = callback; }; }
    isDestroyed() { return false; }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; return Promise.resolve(); }
  }
  const ipcMain = { handle: (_channel, callback) => { handler = callback; }, removeHandler: () => { removed = true; } };
  const opened = openInstallationRecoveryWindow({ BrowserWindow: Window, ipcMain, dialog: {}, baseDir: path.resolve("electron"), context: { skin: "dark", reason: "fixture" }, isAvailable: () => true });
  const wc = opened.window.webContents;
  assert.deepEqual(options.webPreferences, { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, preload: path.resolve("electron/recovery/preload.cjs") });
  assert.equal((await handler({ sender: wc, senderFrame: wc.mainFrame }, { action: "state" })).context.reason, "fixture");
  await assert.rejects(handler({ sender: {}, senderFrame: wc.mainFrame }, { action: "state" }), /UNTRUSTED/);
  await assert.rejects(handler({ sender: wc, senderFrame: { url: wc.mainFrame.url } }, { action: "state" }), /UNTRUSTED/);
  wc.mainFrame.url += "?foreign";
  await assert.rejects(handler({ sender: wc, senderFrame: wc.mainFrame }, { action: "state" }), /UNTRUSTED/);
  let prevented = false;
  wc.emit("will-navigate", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(opened.window.openWindow(), { action: "deny" });
  opened.window.emit("closed"); assert.equal(removed, true);

  let exposed;
  vm.runInNewContext(readFileSync(new URL("./recovery/preload.cjs", import.meta.url), "utf8"), { require: name => {
    assert.equal(name, "electron");
    return { contextBridge: { exposeInMainWorld: (key, value) => { exposed = { key, value }; } }, ipcRenderer: { invoke: (...args) => args } };
  } });
  assert.equal(exposed.key, "murageRecovery");
  assert.deepEqual(Object.keys(exposed.value), ["action"]);
  assert.equal(exposed.value.action("state")[0], "installation-recovery:action");
});
