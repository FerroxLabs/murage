// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// R31 (1.0.19): the single bot-delete dialog shows "This also removes <address>." and, for a parked inbox, the
// DELETE /api/bots/:id request carries {"emailConfirm": token}. The routes are mocked; the dialog and the real store run.
import { test, expect } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: ViteDevServer, origin: string;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  server = await createServer({
    configFile: false, root, cacheDir: mkdtempSync(join(tmpdir(), "murage-delete-email-ui-")), envFile: false,
    resolve: { alias: [{ find: "@", replacement: root + "/src" }] },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "delete-email-fixture",
      resolveId(id) { if (id === "/__del.js") return "\0del"; },
      load(id) {
        if (id !== "\0del") return;
        return [
          "import React from 'react';import {createRoot} from 'react-dom/client';",
          "import {StoreProvider,useStore} from '/src/state/store.tsx';import {ConfirmDelete} from '/src/components/ConfirmDelete.tsx';import {Sidebar,ArchivedBotsPanel} from '/src/components/Sidebar.tsx';import '/src/styles.css';",
          "function Single(){const {dispatch}=useStore();return React.createElement(ConfirmDelete,{name:'Ada',kind:'bot',detail:'Ada goes.',preview:{botId:'b1'},onCancel:()=>{},",
          "onConfirm:(options)=>dispatch({type:'deleteBot',source:'local',botId:'b1',attempt:'a1',...(options?.emailConfirm?{emailConfirm:options.emailConfirm}:{})})});}",
          "const archived=['b1','b2'].map((id,i)=>({id,name:'Archived '+(i+1),hidden:true,tasks:[],messages:[],modelSelection:{instanceId:'x',model:'m'}}));",
          "const mode=new URLSearchParams(location.search).get('mode');",
          "const view=mode==='sidebar'?React.createElement(Sidebar,{open:true,onClose:()=>{}}):mode==='archived'?React.createElement(ArchivedBotsPanel,{bots:archived,groups:[],onClose:()=>{},onRestored:()=>{},onDeleted:()=>{}}):React.createElement(Single);",
          "createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,view));",
        ].join("");
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!(req.url === "/__del" || req.url?.startsWith("/__del?"))) return next();
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Delete</title><body style="margin:0"><div id="root"></div><script type="module" src="/__del.js"></script>');
      }); },
    }],
  });
  await server.listen();
  origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
});
test.afterAll(async () => { await server?.close(); });

test("the single delete dialog shows the address and the DELETE body carries the token", async ({ page }) => {
  let body: string | null | undefined;
  const json = (data: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/deletion-preview") return route.fulfill(json({ savedFiles: 0, email: { address: "ada+<tag>@example.com", confirm: "tok-e2e" } }));
    if (url.pathname === "/api/bots/b1" && route.request().method() === "DELETE") { body = route.request().postData(); return route.fulfill(json({ ok: true })); }
    return route.fulfill(json({}));
  });
  await page.goto(`${origin}/__del`);
  await expect(page.getByText("This also removes ada+<tag>@example.com.", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Type Ada to confirm" }).fill("Ada");
  await page.getByRole("button", { name: "Delete bot", exact: true }).click();
  await expect.poll(() => body).toBe(JSON.stringify({ emailConfirm: "tok-e2e" }));
});

const json = (data: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
const bot = { id: "b1", name: "Ada", color: "blue", threadId: "t-b1", tasks: [], messages: [], modelSelection: { instanceId: "fixture", model: "test" }, description: "", autoApprove: false };

for (const [label, size] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`the real Sidebar single delete shows the address, and sends the token (${label})`, async ({ page }) => {
    await page.setViewportSize(size);
    const deletes: Array<{ url: string; body: string | null }> = [];
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/bots" && url.searchParams.get("view") === "sidebar") return route.fulfill(json({ bots: [bot], groups: [] }));
      if (url.pathname === "/api/deletion-preview") return route.fulfill(json({ savedFiles: 0, email: { address: "ada+<tag>@example.com", confirm: "v1.9999999999.abc" } }));
      if (url.pathname === "/api/bots/b1" && route.request().method() === "DELETE") { deletes.push({ url: route.request().url(), body: route.request().postData() }); return route.fulfill(json({ ok: true, warning: "Cleanup incomplete", emailKept: { address: "ada+<tag>@example.com" } })); }
      return route.fulfill(json({}));
    });
    await page.goto(`${origin}/__del?mode=sidebar`);
    await page.getByRole("button", { name: "More actions for Ada" }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await expect(page.getByText("This also removes ada+<tag>@example.com.", { exact: true })).toBeVisible();
    const confirm = page.getByRole("button", { name: "Delete bot", exact: true });
    await expect(confirm).toBeDisabled();
    await page.getByRole("textbox", { name: "Type Ada to confirm" }).fill("Ada");
    await expect(confirm).toBeEnabled();
    const box = await confirm.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
    await confirm.click();
    await expect.poll(() => deletes.length).toBe(1);
    expect(deletes[0]!.body).toBe(JSON.stringify({ emailConfirm: "v1.9999999999.abc" }));
  });
}

test("the archived bulk delete shows one line, no address, and sends no token for any bot", async ({ page }) => {
  const deletes: Array<{ url: string; body: string | null }> = [];
  let previews = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/deletion-preview") { previews += 1; return route.fulfill(json({ savedFiles: 0, email: { address: "x@example.com", confirm: "tok" } })); }
    if (url.pathname.startsWith("/api/bots/") && route.request().method() === "DELETE") { deletes.push({ url: route.request().url(), body: route.request().postData() }); return route.fulfill(json({ ok: true, emailKept: { address: "x@example.com" } })); }
    return route.fulfill(json({}));
  });
  await page.goto(`${origin}/__del?mode=archived`);
  await page.getByRole("button", { name: "Delete all 2" }).click();
  await expect(page.getByText("Their email addresses stay until you choose Keep or Remove in Settings.", { exact: true })).toHaveCount(1);
  await expect(page.getByText("This also removes", { exact: false })).toHaveCount(0);
  await page.getByRole("textbox").fill(await page.getByRole("textbox").getAttribute("placeholder") ?? "");
  await page.getByRole("button", { name: "Delete 2 archived bots", exact: true }).click();
  await expect.poll(() => deletes.length).toBe(2);
  expect(deletes.map((d) => new URL(d.url).pathname).sort()).toEqual(["/api/bots/b1", "/api/bots/b2"]);
  for (const d of deletes) expect(d.body).toBeNull();
  expect(previews).toBe(0);
  await expect(page.getByText("was kept", { exact: false })).toHaveCount(0);
});
