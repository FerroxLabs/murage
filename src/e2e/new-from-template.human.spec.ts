// New Bot / New Team in a real browser against the REAL harness: the page's
// /api calls are proxied to a verification server, so the template search,
// preview and create all run for real.
import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";

let server: ViteDevServer, origin: string, cache: string, harness: VerificationServer, sable: { id: string; name: string; threadId: string };

test.beforeAll(async () => {
  harness = await launchVerificationServer(process.env);
  const secret = ((await (await fetch(harness.info.url + "/api/desktop-secret")).json()) as { secret: string }).secret;
  const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" };
  sable = ((await (await fetch(harness.info.url + "/api/bots", { method: "POST", headers, body: JSON.stringify({ name: "Sable", modelSelection: { instanceId: "verification", model: "fake" } }) })).json()) as { bot: typeof sable }).bot;

  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-new-template-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@/state/store", replacement: "/skills-fixture-store" }, { find: "@", replacement: root + "/src" }] },
    server: {
      host: "127.0.0.1", watch: null, hmr: false,
      proxy: { "/api": { target: harness.info.url, changeOrigin: true, headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret } } },
    },
    plugins: [tailwindcss(), {
      name: "skills-settings-fixture",
      resolveId(id) { if (id === "/__skills.js") return "\0skills-settings"; if (id === "/__botskills.js") return "\0bot-skills"; if (id === "/skills-fixture-store") return "\0skills-store"; },
      load(id) {
        // The real api() contract: JSON in and out, and a refusal carries its status and body.
        if (id === "\0skills-store") return "import React from 'react';export async function api(path,init){const r=await fetch(path,{...init,headers:{'content-type':'application/json',...(init&&init.headers)}});const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(data.error||r.statusText),{status:r.status,body:data});return data;}export function useStore(){return {state:{bots:window.fixtureBots||[]},dispatch(action){(window.dispatched=window.dispatched||[]).push(action.type)}};}";
        if (id !== "\0skills-settings") return;
        return "import React from 'react';import {createRoot} from 'react-dom/client';import {NewFromTemplateDialog} from '/src/components/NewFromTemplateDialog.tsx';import '/src/styles.css';const q=new URLSearchParams(location.search);document.documentElement.dataset.skin='dark';window.events=[];createRoot(document.getElementById('root')).render(React.createElement(NewFromTemplateDialog,{kind:q.get('kind')||'bot',onClose(){window.events.push('close')},onBlank(){window.events.push('blank')},onOpenFile(){window.events.push('file')},onCreated(r){window.events.push('created:'+r.members)}}));";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        const page = req.url === "/__skills" || req.url?.startsWith("/__skills?") ? "/__skills.js" : req.url?.startsWith("/__botskills?") ? "/__botskills.js" : null;
        if (!page) return next();
        res.setHeader("content-type", "text/html");
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:var(--color-app)"><main id="root" style="padding:16px;max-width:680px;margin:16px auto"></main><script type="module" src="' + page + '"></script>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => { await server?.close(); await harness?.close(); safeWipeSync(cache); });
// A module that fails to load leaves an empty page; say why.
test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => console.log("page error:", error.message));
  page.on("console", (message) => { if (message.type() === "error") console.log("console error:", message.text()); });
});


test("New Bot: describe the job, see the best matches, preview one, create it", async ({ page }, info) => {
  await page.goto(origin + "/__skills?kind=bot");
  await expect(page.getByRole("dialog", { name: "New Bot" })).toBeVisible();
  await expect(page.getByText("or browse:")).toBeVisible();
  await page.screenshot({ path: info.outputPath("new-bot-empty.png"), fullPage: true });
  // Nothing in the catalogue does this job: the box says so plainly
  await page.getByLabel("What should it do?").fill("chase unpaid invoices and follow up with clients");
  await expect(page.getByText("No template fits that yet.", { exact: false })).toBeVisible();
  // and a job that has a template finds it
  await page.getByLabel("What should it do?").fill("write sales page headlines and hooks");
  await expect(page.getByText("Best matches")).toBeVisible();
  const first = page.getByRole("dialog").getByRole("list").getByRole("button").filter({ hasText: "Copy" }).first();
  await expect(first).toBeVisible();
  await page.screenshot({ path: info.outputPath("new-bot-matches.png"), fullPage: true });
  await first.click();
  await expect(page.getByRole("button", { name: "Create" })).toBeEnabled();
  await page.screenshot({ path: info.outputPath("new-bot-preview.png"), fullPage: true });
  await page.getByRole("button", { name: "Create" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).events)).toContain("created:1");
});

test("New Team: browse a topic, and the preview names the team's bots", async ({ page }, info) => {
  await page.goto(origin + "/__skills?kind=team");
  await expect(page.getByRole("dialog", { name: "New Team" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button").filter({ hasText: /\d+$/ }).first().click();
  await expect(page.getByRole("button", { name: "All topics" })).toBeVisible();
  await page.getByRole("dialog").getByRole("list").getByRole("button").first().click();
  await expect(page.getByText("Bots:")).toBeVisible();
  await page.screenshot({ path: info.outputPath("new-team-preview.png"), fullPage: true });
});

test("Start blank and Open a file are there, and quiet", async ({ page }) => {
  await page.goto(origin + "/__skills?kind=bot");
  await page.getByRole("button", { name: "Start blank →" }).click();
  await page.getByRole("button", { name: "Open a file…" }).click();
  expect(await page.evaluate(() => (window as any).events)).toEqual(["blank", "file"]);
  await page.goto(origin + "/__skills?kind=team");
  await expect(page.getByRole("button", { name: "Pick from my bots →" })).toBeVisible();
});
