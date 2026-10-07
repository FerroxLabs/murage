// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Add a server by pasting a link (MCP-LINK T12, T13) in a real browser against
// the REAL harness, with a fake link server (server/testing/fake-remote-mcp.ts)
// and a fake command server. The page's /api calls are proxied to a
// verification server with the desktop proof, so inspect, save, test and turn
// on all run for real. There is no desktop shell in a browser, so the parts
// that need one (saving through credentials.bin, the browser sign-in) are
// covered two other ways: the dev path here (values in the request body, which
// the harness accepts only with no shell) and a stub bridge that shows the
// waiting and cancel states. The real browser sign-in runs once against a
// harness with a desktop shell and main's own sign-in code behind the bridge
// (server/testing/desktop-shell.ts).
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { startFakeRemoteMcp, type FakeRemoteMcp } from "../../server/testing/fake-remote-mcp.ts";
import { startDesktopShell } from "../../server/testing/desktop-shell.ts";
import { axeScriptPath } from "./axe";

const KEY = "sk-e2e-THE-API-KEY-7731";
const VIEWPORTS = [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }] as const;

let server: ViteDevServer, origin: string, cache: string, harness: VerificationServer, headers: Record<string, string>, fake: FakeRemoteMcp, scratch: string;
type Listing = { name: string; kind?: string; enabled: boolean; headerNames?: string[]; status?: string };
const list = async (): Promise<{ servers: Listing[] }> => (await (await fetch(harness.info.url + "/api/mcp/servers", { headers })).json()) as { servers: Listing[] };
const removeAll = async () => { for (const entry of (await list()).servers) await fetch(harness.info.url + `/api/mcp/servers/${entry.name}`, { method: "DELETE", headers }); };

test.beforeAll(async () => {
  harness = await launchVerificationServer(process.env);
  const secret = ((await (await fetch(harness.info.url + "/api/desktop-secret")).json()) as { secret: string }).secret;
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" };
  // ComfyUI's shape: sign-in is offered, and an API key in X-API-Key works too.
  fake = await startFakeRemoteMcp({ auth: "both", apiKey: KEY, apiKeyHeader: "x-api-key", unauthorized: "comfy" });
  scratch = mkdtempSync(join(tmpdir(), "murage-mcp-link-scratch-"));
  writeFileSync(join(scratch, "stdio-server.mjs"), `
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") send({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-stdio", version: "1" } } });
  else if (frame.method === "tools/list") send({ jsonrpc: "2.0", id: frame.id, result: { tools: [{ name: "read_note", inputSchema: { type: "object", properties: {} } }, { name: "write_note", inputSchema: { type: "object", properties: {} } }] } });
});
`);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-mcp-link-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@/state/store", replacement: "/mcp-link-fixture-store" }, { find: "@", replacement: root + "/src" }] },
    server: {
      host: "127.0.0.1", watch: null, hmr: false,
      proxy: { "/api": { target: harness.info.url, changeOrigin: true, headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret } } },
    },
    plugins: [tailwindcss(), {
      name: "mcp-link-fixture",
      resolveId(id) { if (id === "/__mcp.js") return "\0mcp-page"; if (id === "/__card.js") return "\0mcp-card"; if (id === "/mcp-link-fixture-store") return "\0mcp-store"; },
      load(id) {
        // The real api() contract: JSON in and out, a refusal carries its message.
        if (id === "\0mcp-store") return "export async function api(path,init){const r=await fetch(path,{...init,headers:{'content-type':'application/json',...(init&&init.headers)}});const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(data.error||r.statusText),{status:r.status,body:data});return data;}";
        if (id === "\0mcp-page") return "import React from 'react';import {createRoot} from 'react-dom/client';import {McpServersPanel} from '/src/components/McpServersPanel.tsx';import '/src/styles.css';const q=new URLSearchParams(location.search);document.documentElement.dataset.skin=q.get('skin')||'dark';createRoot(document.getElementById('root')).render(React.createElement(McpServersPanel));";
        if (id === "\0mcp-card") return "import React from 'react';import {createRoot} from 'react-dom/client';import {McpSignInCard} from '/src/components/McpSignInCard.tsx';import '/src/styles.css';const q=new URLSearchParams(location.search);document.documentElement.dataset.skin=q.get('skin')||'dark';if(q.get('mode')==='desktop'){window.muragebox={mcpServers:{signIn:async()=>({ok:true})}};}const message={id:'m1',role:'bot',kind:'mcpSignIn',at:1,mcpSignIn:{name:'comfy',host:'cloud.comfy.org',bot:'Sable',reason:'sign-in-ended',status:q.get('status')||'required',resumeKey:'mcp-abc',title:'Sign in to cloud.comfy.org',body:'x',phone:'Finish sign-in on the computer running Murage.'}};createRoot(document.getElementById('root')).render(React.createElement('div',{style:{padding:16,maxWidth:560}},React.createElement(McpSignInCard,{botId:'b1',threadId:'t1',message})));";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (url === "/__mcp" || url.startsWith("/__mcp?")) {
          res.setHeader("content-type", "text/html");
          res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP servers</title><body style="margin:0;background:var(--color-app);color:var(--color-ink)"><main style="display:flex;flex-direction:column;height:100dvh"><header style="padding:16px 16px 0"><h1 style="font-size:12px;margin:0 0 4px">Murage</h1><h2 style="font-size:20px;margin:0 0 12px">Connected apps</h2></header><div id="root" style="display:flex;flex-direction:column;flex:1;min-height:0"></div></main><script type="module" src="/__mcp.js"></script>');
          return;
        }
        if (url === "/__card" || url.startsWith("/__card?")) {
          res.setHeader("content-type", "text/html");
          res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign-in card</title><body style="margin:0;background:var(--color-app);color:var(--color-ink)"><main><h2 style="font-size:16px;margin:16px">Chat</h2><div id="root"></div></main><script type="module" src="/__card.js"></script>');
          return;
        }
        next();
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => { await server?.close(); await fake?.close(); await harness?.close(); safeWipeSync(cache); safeWipeSync(scratch); });
test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => console.log("page error:", error.message));
  page.on("console", (message) => { if (message.type() === "error") console.log("console error:", message.text()); });
  page.on("dialog", (dialog) => { throw new Error(`a native ${dialog.type()} dialog opened`); });
});
test.afterEach(async () => { await removeAll(); });

const paste = async (page: Page, text: string) => { await page.getByLabel("Paste a link, a command, or a config snippet").fill(text); await page.getByRole("button", { name: "Continue", exact: true }).click(); };
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}: a pasted link that offers sign-in and an API key, added with the key`, async ({ page }, info) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(origin + "/__mcp");
    await expect(page.getByRole("heading", { name: "Your MCP servers" })).toBeVisible();
    await expect(page.getByText("No servers yet. Paste a link to add your first one.")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`mcp-${viewport.name}-1-empty.png`), fullPage: true });

    await page.getByRole("button", { name: "Add server" }).click();
    const sentBefore = fake.requests.length;
    await paste(page, fake.mcpUrl);
    // a link to this computer asks first, and nothing has been sent to it yet
    await expect(page.getByText("This link points to this computer. Only continue if you started this server yourself.")).toBeVisible();
    expect(fake.requests.slice(sentBefore).filter((request) => request.method === "POST")).toHaveLength(0);
    await page.screenshot({ path: info.outputPath(`mcp-${viewport.name}-2-local-confirm.png`), fullPage: true });
    await page.getByRole("button", { name: "Continue", exact: true }).nth(1).click();

    // the ComfyUI shape: both ways in
    const host = "127.0.0.1:" + fake.port;
    await expect(page.getByText(`${host} uses sign-in.`)).toBeVisible();
    await expect(page.getByRole("button", { name: `Sign in to ${host}` })).toBeVisible();
    await expect(page.getByRole("button", { name: "Use an API key instead" })).toBeVisible();
    // no desktop shell in a browser: the button says why it cannot be used
    await expect(page.getByRole("button", { name: `Sign in to ${host}` })).toBeDisabled();
    await expect(page.getByText("Sign in needs the Murage desktop app.")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`mcp-${viewport.name}-3-both-ways.png`), fullPage: true });

    await page.getByRole("button", { name: "Use an API key instead" }).click();
    await expect(page.getByLabel("API key")).toBeVisible();
    await page.getByText("Sent as").click();
    await expect(page.getByLabel("X-API-Key")).toBeChecked();
    await page.getByLabel("API key").fill(KEY);
    await page.screenshot({ path: info.outputPath(`mcp-${viewport.name}-4-key.png`), fullPage: true });
    await page.getByRole("button", { name: "Save and test" }).click();

    await expect(page.getByText("Connected. 2 tools found.")).toBeVisible();
    // the key is not left in the page
    expect(await page.locator("input[type=password]").count()).toBe(0);
    await page.screenshot({ path: info.outputPath(`mcp-${viewport.name}-5-connected.png`), fullPage: true });
    // saved OFF, key held by the harness, never listed back
    const before = (await list()).servers.find((entry) => entry.kind === "remote");
    expect(before).toMatchObject({ enabled: false, headerNames: ["X-API-Key"] });
    expect(JSON.stringify(await list())).not.toContain(KEY);

    await page.getByRole("button", { name: "Turn on for my bots" }).click();
    await expect(page.getByText(/is on\./)).toBeVisible();
    await expect.poll(async () => (await list()).servers.find((entry) => entry.kind === "remote")?.enabled).toBe(true);
    expect(fake.requests.some((request) => request.headers["x-api-key"] === KEY)).toBe(true);
    expect(JSON.stringify(await list())).not.toContain(KEY);

    await expect(page.getByRole("heading", { name: "Your MCP servers" })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`mcp-${viewport.name}-6-list.png`), fullPage: true });
    expect(await noOverflow(page)).toBe(true);
  });
}

test("a pasted command with a secret becomes a labelled field, and is added off, tested and turned on", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin + "/__mcp");
  await page.getByRole("button", { name: "Add server" }).click();
  await paste(page, `NOTES_TOKEN=abc123 node ${join(scratch, "stdio-server.mjs")}`);
  await expect(page.getByText("NOTES_TOKEN", { exact: true })).toBeVisible();
  await expect(page.locator("input[type=password]")).toHaveCount(1);
  // the paste box is emptied, and the secret sits only in its password field
  await expect(page.getByLabel("Paste a link, a command, or a config snippet")).toHaveValue("");
  await expect(page.getByText("The secret you pasted is hidden now. It is filled in below.")).toBeVisible();
  await expect(page.locator("input[type=password]")).toHaveValue("abc123");
  expect(await page.evaluate(() => document.body.innerText)).not.toContain("abc123");
  await page.getByRole("button", { name: "Add and test" }).click();
  await expect(page.getByText("Connected. 2 tools found.")).toBeVisible();
  const entry = (await list()).servers.find((candidate) => candidate.kind !== "remote");
  expect(entry).toMatchObject({ enabled: false });
  await page.getByRole("button", { name: "Turn on for my bots" }).click();
  await expect.poll(async () => (await list()).servers.find((candidate) => candidate.kind !== "remote")?.enabled).toBe(true);
  await page.screenshot({ path: info.outputPath("mcp-desktop-7-command.png"), fullPage: true });
});

test("a paste that cannot be read says why and sends nothing", async ({ page }) => {
  await page.goto(origin + "/__mcp");
  await page.getByRole("button", { name: "Add server" }).click();
  await paste(page, '[mcp_servers.x]\ncommand = "npx"');
  await expect(page.getByRole("alert")).toContainText("Codex config.toml files are not supported yet.");
  expect((await list()).servers).toHaveLength(0);
});

test("the sign-in waits for the browser and Cancel goes back (stub shell)", async ({ page }, info) => {
  // A stub bridge that holds the sign-in open, to show the waiting and Cancel states.
  await page.addInitScript(() => {
    let release: (value: { ok: boolean; error?: string; message?: string }) => void = () => {};
    (window as any).muragebox = {
      mcpServers: {
        mode: async () => "desktop",
        saveSecrets: async () => ({ ok: true }),
        signIn: () => new Promise((resolve) => { release = resolve; }),
        cancelSignIn: async () => { release({ ok: false, error: "cancelled", message: "Sign-in was cancelled." }); return true; },
        signOut: async () => ({ ok: true, revoked: false, message: "" }),
        remove: async (name: string) => { await fetch(`/api/mcp/servers/${name}`, { method: "DELETE" }); return { ok: true, revoked: null, message: "Removed." }; },
      },
    };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/__mcp");
  await page.getByRole("button", { name: "Add server" }).click();
  await paste(page, fake.mcpUrl);
  await page.getByRole("button", { name: "Continue", exact: true }).nth(1).click();
  const host = "127.0.0.1:" + fake.port;
  await page.getByRole("button", { name: `Sign in to ${host}` }).click();
  await expect(page.getByText("Finish signing in in your browser. This window updates when you are done.")).toBeVisible();
  // the entry exists already, saved off as a sign-in entry, so the shell can act on it
  expect((await list()).servers.find((entry) => entry.kind === "remote")).toMatchObject({ enabled: false });
  await page.screenshot({ path: info.outputPath("mcp-phone-8-waiting.png"), fullPage: true });
  await page.getByRole("button", { name: "Cancel" }).last().click();
  await expect(page.getByRole("button", { name: `Sign in to ${host}` })).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
});

test("the browser sign-in runs end to end through main's sign-in code, against the fake authorization server", async ({ page }, info) => {
  // The harness as the desktop app runs it (server/testing/desktop-shell.ts):
  // Electron's private port, values never in a body, and main's own MCP service
  // (electron/mcp-signin/service.mjs) behind window.muragebox.mcpServers. Electron
  // itself is not started: the fake browser approves the authorize URL and calls
  // the loopback, and credentials.bin is held in this process.
  const home = mkdtempSync(join(tmpdir(), "murage-mcp-link-shell-"));
  const signInFake = await startFakeRemoteMcp({ auth: "bearer", unauthorized: "comfy" });
  const shell = await startDesktopShell({ home });
  try {
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      try {
        const answer = await fetch(shell.base + url.pathname + url.search, {
          method: request.method(),
          headers: { ...shell.headers(), ...(request.postData() !== null ? { "content-type": "application/json" } : {}) },
          ...(request.postData() !== null ? { body: request.postData()! } : {}),
        });
        await route.fulfill({ status: answer.status, contentType: "application/json", body: await answer.text() });
      } catch {
        await route.abort().catch(() => {});
      }
    });
    await page.exposeBinding("__mcpShell", async (_source, method: string, args: unknown[]) => {
      const service = shell.service as unknown as Record<string, (...input: unknown[]) => unknown>;
      if (!["saveSecrets", "signIn", "cancelSignIn", "signOut", "remove"].includes(method)) throw new Error("not a bridge method");
      return service[method]!(...args);
    });
    await page.addInitScript(() => {
      const call = (method: string) => (...args: unknown[]) => (window as any).__mcpShell(method, args);
      (window as any).muragebox = {
        mcpServers: {
          mode: async () => "desktop",
          saveSecrets: call("saveSecrets"), signIn: call("signIn"), cancelSignIn: call("cancelSignIn"), signOut: call("signOut"), remove: call("remove"),
        },
      };
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(origin + "/__mcp");
    await page.getByRole("button", { name: "Add server" }).click();
    await paste(page, signInFake.mcpUrl);
    await page.getByRole("button", { name: "Continue", exact: true }).nth(1).click();
    const host = "127.0.0.1:" + signInFake.port;
    await page.getByRole("button", { name: `Sign in to ${host}` }).click();
    await expect(page.getByText("Connected. 2 tools found.")).toBeVisible({ timeout: 20_000 });
    // the saved row below says so too: it does not keep the status it had before the sign-in
    await expect(page.getByText("Needs sign-in")).toHaveCount(0);
    // the sign-in really ran: DCR, PKCE S256 bound to the link, a token exchanged
    expect(signInFake.registrations).toHaveLength(1);
    expect(signInFake.authorizeRequests[0]).toMatchObject({ code_challenge_method: "S256", resource: signInFake.mcpUrl });
    expect(signInFake.tokenRequests.some((row) => row.grant_type === "authorization_code")).toBe(true);
    const stored = Object.values(shell.credentials().mcpServerSecrets as Record<string, any>)[0];
    expect(stored.oauth.accessToken).toBe(signInFake.issuedAccessTokens().at(-1));
    // Test sent that token upstream; the page never held it
    expect(signInFake.requests.some((request) => request.headers.authorization === `Bearer ${stored.oauth.accessToken}`)).toBe(true);
    expect(await page.content()).not.toContain(stored.oauth.accessToken);
    await page.screenshot({ path: info.outputPath("mcp-desktop-9-signed-in.png"), fullPage: true });
    await page.getByRole("button", { name: "Turn on for my bots" }).click();
    await expect.poll(async () => ((await shell.desktop("GET", "/api/mcp/servers")).body.servers as Array<{ enabled: boolean; status?: string }>)[0]).toMatchObject({ enabled: true, status: "ready" });
  } catch (error) {
    console.log(`desktop-shell harness stderr (tail):\n${shell.stderr().slice(-4000)}`);
    throw error;
  } finally {
    // nothing from this page may reach the harness once it stops
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.goto("about:blank").catch(() => {});
    await shell.stop();
    await signInFake.close();
    safeWipeSync(home);
  }
});

test("the panel has no accessibility violations", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin + "/__mcp");
  await page.getByRole("button", { name: "Add server" }).click();
  await paste(page, fake.mcpUrl);
  await page.getByRole("button", { name: "Continue", exact: true }).nth(1).click();
  await expect(page.getByRole("button", { name: "Use an API key instead" })).toBeVisible();
  await page.addScriptTag({ content: readFileSync(axeScriptPath, "utf8") });
  const report = await page.evaluate(async () => (window as any).axe.run(document));
  writeFileSync(info.outputPath("mcp-axe.json"), JSON.stringify(report, null, 2));
  expect(report.violations.map((violation: { id: string }) => violation.id)).toEqual([]);
});

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}: the mid-turn sign-in card, on the desktop and as a phone reads it`, async ({ page }, info) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(origin + "/__card?mode=desktop");
    await expect(page.getByText("Sign in to cloud.comfy.org")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`mcp-card-${viewport.name}-desktop.png`), fullPage: true });
    await page.goto(origin + "/__card?mode=phone");
    await expect(page.getByText("Finish sign-in on the computer running Murage.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`mcp-card-${viewport.name}-phone.png`), fullPage: true });
    expect(await noOverflow(page)).toBe(true);
  });
}
