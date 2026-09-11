"use strict";
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { app, BrowserWindow, WebContentsView, nativeImage } = require("electron");
const { createBrowserSurfaceManager } = require("../browser-surface.cjs");
const { createBrowserHost } = require("../browser-host.cjs");
const { safeWipeSync } = require("../../server/testing/safe-wipe.mjs");
const privateRoot = mkdtempSync(join(tmpdir(), "murage-click-after-shot-"));
app.setPath("userData", privateRoot);
app.setPath("sessionData", privateRoot);
app.whenReady().then(async () => {
  const owner = new BrowserWindow({ show: false, width: 1500, height: 1000 });
  let view, failNextCapture = false;
  const manager = createBrowserSurfaceManager({ owner, createView: options => (view = new WebContentsView(options)), settleMs: 0, loadWaitMs: 1000 });
  const host = createBrowserHost({ manager, token: "a".repeat(64) });
  const url = await host.start(), cap = "b".repeat(64);
  const call = async (operation, body = {}) => {
    const response = await fetch(`${url}/v1/bots/probe/${operation}`, { method: "POST", headers: { authorization: `Bearer ${cap}`, "content-type": "application/json" }, body: JSON.stringify({ ...body, profile: "" }) });
    const result = await response.json();
    assert.equal(response.status, 200, `${operation}: ${result.error}`);
    return result;
  };
  try {
    manager.ensure("probe", "");
    const registered = await fetch(`${url}/v1/capabilities/register`, { method: "POST", headers: { authorization: `Bearer ${"a".repeat(64)}`, "content-type": "application/json" }, body: JSON.stringify({ token: cap, botId: "probe", profile: "", expiresAt: Date.now() + 60000 }) });
    assert.equal(registered.status, 200);
    const command = view.webContents.debugger.sendCommand.bind(view.webContents.debugger);
    view.webContents.debugger.sendCommand = async (method, params) => {
      const result = await command(method, params);
      // Real capture changes Chromium state first; then exercise the native
      // fallback path without simulating pointer delivery or the DOM target.
      if (method === "Page.captureScreenshot" && failNextCapture) { failNextCapture = false; throw new Error("injected post-capture failure"); }
      return result;
    };
    const html = `<!doctype html><html><body style="margin:0;background:lightblue"><a id="link" href="#activated" style="position:absolute;left:420px;top:180px;width:200px;height:50px;display:block" onclick="event.preventDefault();window.activated++">Learn more</a><button id="button" style="position:absolute;left:420px;top:280px;width:200px;height:50px" onclick="window.activated++">Activate button</button><script>window.activated=0;window.events=[];document.addEventListener('click',e=>window.events.push({target:e.target.id,trusted:e.isTrusted}),true)</script></body></html>`;
    for (const bounds of [{ width: 287, height: 115 }, { width: 400, height: 250 }, { width: 1280, height: 800 }]) {
      manager.layout("probe", { x: 10, y: 10, ...bounds }, "", "compact");
      await view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      manager.setHumanControl("probe", false, "");
      let activated = 0;
      for (const capture of ["none", "normal", "normal", "fallback"]) {
        if (capture !== "none") {
          failNextCapture = capture === "fallback";
          const shot = await call("screenshot");
          assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(shot.png, "base64")).getSize(), { width: 1024, height: 640 });
        }
        const metrics = await view.webContents.executeJavaScript(`({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})`);
        assert.equal(metrics.width, 1280, `${capture} viewport width at ${bounds.width}`);
        assert.equal(metrics.height, 800, `${capture} viewport height at ${bounds.height}`);
        for (const [role, target] of [["link", "link"], ["button", "button"]]) {
          const snapshot = await call("snapshot");
          const ref = String(snapshot.yaml).match(new RegExp(`${role}[^\\n]*\\[ref=(e\\d+)\\]`))?.[1];
          assert.ok(ref, `Missing ${role} ref`);
          await call("click", { ref });
          activated++;
          const state = await view.webContents.executeJavaScript(`({activated,event:events.at(-1)})`);
          assert.deepEqual(state, { activated, event: { target, trusted: true } }, `${capture} missed ${target} at ${JSON.stringify(bounds)}`);
        }
        process.stdout.write(JSON.stringify({ bounds, capture, metrics, activated }) + "\n");
      }
    }
    process.stdout.write("actual-host-screenshot-click-regression-passed\n");
  } finally { await host.stop(); manager.closeAll(); owner.destroy(); }
}).then(() => { safeWipeSync(privateRoot); app.exit(0); }).catch(error => {
  process.stderr.write(error.stack + "\n");
  safeWipeSync(privateRoot);
  app.exit(1);
});
