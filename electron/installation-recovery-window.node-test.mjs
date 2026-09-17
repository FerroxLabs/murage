import assert from "node:assert/strict";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { EventEmitter } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import vm from "node:vm";
import test from "node:test";
import { openInstallationRecoveryWindow } from "./installation-recovery-window.mjs";

test("encrypted key selection and lazy reread await host verification", async () => {
  for (const failAt of [1, 2]) {
    const root = mkdtempSync(path.join(tmpdir(), "murage-key-order-"));
    try {
      const data = path.join(root, "data"), key = path.join(root, "key.txt"); mkdirSync(data);
      // The missing file in case one proves verification refuses before reading.
      if (failAt === 2) writeFileSync(key, "# public key: age1" + "q".repeat(58) + "\nAGE-SECRET-KEY-1" + "A".repeat(60) + "\n");
      let handler, verified = 0, ran = 0;
      class Window extends EventEmitter {
        constructor() { super(); this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: "" }; this.webContents.setWindowOpenHandler = () => {}; }
        isDestroyed() { return false; }
        loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; return Promise.resolve(); }
      }
      const opened = openInstallationRecoveryWindow({ BrowserWindow: Window,
        ipcMain: { handle: (_channel, fn) => { handler = fn; }, removeHandler() {} },
        baseDir: path.resolve("electron"), context: { dataDirectory: data }, isAvailable: () => true, encryptedAvailable: () => true,
        dialog: { showSaveDialog: async () => ({ canceled: false, filePath: path.join(root, "output.age") }),
          showOpenDialog: async () => ({ canceled: false, filePaths: [key] }), showMessageBox: async () => ({ response: 1 }) },
        verifyEncrypted: async () => { if (++verified === failAt) throw Object.assign(Error("unverified"), { code: "AGE_TOOL_UNVERIFIED" }); },
        run: async (_operation, parameters) => { ran++; await parameters.readIdentity(); throw Error("unexpected identity acceptance"); },
      });
      const wc = opened.window.webContents;
      const state = await handler({ sender: wc, senderFrame: wc.mainFrame }, { action: "backup-encrypted" });
      assert.equal(state.error, "AGE_TOOL_UNVERIFIED"); assert.equal(verified, failAt); assert.equal(ran, failAt - 1);
    } finally { safeWipeSync(root); }
  }
});

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
