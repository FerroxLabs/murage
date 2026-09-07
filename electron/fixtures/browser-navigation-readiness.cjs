"use strict";
// Diagnostic contract: expose the current early-empty navigation response,
// with real Chromium and host calls but no external website or user data.
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { app, BrowserWindow, WebContentsView } = require("electron");
const { createBrowserSurfaceManager } = require("../browser-surface.cjs");
const { createBrowserHost } = require("../browser-host.cjs");
const privateRoot = mkdtempSync(join(tmpdir(), "murage-navigation-readiness-"));
app.setPath("userData", privateRoot);
app.setPath("sessionData", privateRoot);
app.whenReady().then(async () => {
  const owner = new BrowserWindow({ show: false });
  let view;
  const manager = createBrowserSurfaceManager({
    owner,
    createView: options => (view = new WebContentsView(options)),
    resolveHost: async (_session, hostname) => {
      assert.equal(hostname, "readiness.example.test");
      return { endpoints: [{ address: "93.184.216.34" }] };
    },
    // Deliberately retain production settleMs/loadWaitMs defaults.
  });
  const token = "a".repeat(64), capability = "b".repeat(64);
  const host = createBrowserHost({ manager, token });
  const base = await host.start();
  const call = async (operation, body = {}, expected = 200) => {
    const response = await fetch(`${base}/v1/bots/readiness/${operation}`, {
      method: "POST", headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, profile: "" }),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  };
  try {
    manager.ensure("readiness", "");
    manager.setHumanControl("readiness", false, "");
    const registered = await fetch(`${base}/v1/capabilities/register`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ token: capability, botId: "readiness", profile: "", expiresAt: Date.now() + 60000 }),
    });
    assert.equal(registered.status, 200);
    const requests = [];
    view.webContents.session.protocol.handle("https", request => {
      const url = new URL(request.url);
      assert.equal(url.hostname, "readiness.example.test");
      requests.push(url.pathname);
      const mode = url.pathname.slice(1);
      const render = `document.body.innerHTML = '<a href="#one">One</a><a href="#two">Two</a>'; window.renderedAt = performance.now();`;
      const script = mode === "delayed" ? `setTimeout(() => { ${render} }, 2000);` : mode === "quick" ? render : "";
      return new Response(`<!doctype html><html><head><title>${mode}</title></head><body><script>${script}</script></body></html>`, { headers: { "content-type": "text/html" } });
    });
    let events = [], start = 0;
    for (const name of ["dom-ready", "did-finish-load", "did-stop-loading"]) {
      view.webContents.on(name, () => events.push({ name, ms: Date.now() - start }));
    }
    for (const mode of ["quick", "blank", "delayed"]) {
      events = []; start = Date.now();
      const first = await call("navigate", { url: `https://readiness.example.test/${mode}` });
      const returnedMs = Date.now() - start;
      const state = await view.webContents.executeJavaScript(`({readyState:document.readyState,links:document.links.length,renderedAt:window.renderedAt ?? null})`);
      const loading = view.webContents.isLoading();
      assert.equal(loading, false);
      assert.equal(state.readyState, "complete");
      assert.ok(events.some(event => event.name === "did-finish-load"));
      assert.ok(events.some(event => event.name === "did-stop-loading"));
      if (mode === "quick") assert.match(first.yaml, /link "One"/);
      else assert.equal(first.yaml, "");
      const record = { mode, returnedMs, lifecycle: [...events], loading, state, firstYaml: first.yaml };
      if (mode === "delayed") {
        assert.equal(state.links, 0);
        // Read-only observation waits for the fixture's own timer; no reload,
        // DOM mutation, click, or production wait behavior is injected.
        await view.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const deadline=Date.now()+5000;const poll=()=>{if(window.renderedAt)resolve();else if(Date.now()>deadline)reject(new Error('render timeout'));else setTimeout(poll,25)};poll()})`);
        const later = await call("snapshot");
        assert.equal(later.url, first.url);
        assert.match(later.yaml, /link "One"/);
        assert.match(later.yaml, /link "Two"/);
        record.laterMs = Date.now() - start;
        record.laterYaml = later.yaml;
      }
      process.stdout.write(JSON.stringify(record) + "\n");
    }
    await assert.rejects(manager.navigate("readiness", "http://127.0.0.1/", ""), /Local and private-network/);
    assert.deepEqual(requests.filter(path => path !== "/favicon.ico"), ["/quick", "/blank", "/delayed"]);
    process.stdout.write("actual-host-navigation-early-empty-reproduced; private-network-block-preserved\n");
  } finally {
    await host.stop(); manager.closeAll(); owner.destroy();
  }
}).then(() => { rmSync(privateRoot, { recursive: true, force: true }); app.exit(0); }).catch(error => {
  process.stderr.write(error.stack + "\n");
  rmSync(privateRoot, { recursive: true, force: true }); app.exit(1);
});
