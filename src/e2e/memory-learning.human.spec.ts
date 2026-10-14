// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fresh isolated desktop. All Flux requests are intercepted inside the fixture.
import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { openSidebar } from "./fixtures.ts";
let fixture: VerificationServer, vite: ViteDevServer, origin: string;
let headers: Record<string, string>;
async function api(path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method: body ? "POST" : "GET", headers: { ...headers, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  expect(response.ok, `${path}: ${response.status}`).toBe(true); return response.json();
}
test.beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `const originalFetch=globalThis.fetch;globalThis.fetch=(input,init)=>String(input).startsWith("https://api.fluxrouter.ai/")?Promise.resolve(new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{content:"[]"}}]}))):originalFetch(input,init);` });
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json(); headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    await api("/api/whats-new/seen", { version: JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version });
    const connection = await api("/api/flux-connection");
    await api("/api/flux-connection/mutate", { action: "connect", revision: connection.revision, key: "sk-flux-FAKE_MEMORY_LEARNING" });
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "learning-ui-vite"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(0); const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw Error("Memory fixture did not bind"); origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });
test("a fresh desktop shows learning immediately and saves per-bot choices", async ({ page }, info) => {
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); });
  await page.goto(origin);
  const sidebar = await openSidebar(page); await sidebar.getByRole("button", { name: "App settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("textbox", { name: "Search settings" }).fill("learning");
  await expect(dialog.getByRole("navigation").getByRole("button", { name: "Memory", exact: true })).toBeVisible();
  await dialog.getByRole("navigation").getByRole("button", { name: "Memory", exact: true }).click();
  const learning = dialog.getByRole("region", { name: "Learning", exact: true });
  // Default-off activation still learns candidates; no disclosure is opened to see it.
  await expect(learning.getByRole("status")).toHaveText("Learning is on. Memories that need your yes wait in Needs you.");
  await expect(learning.getByRole("combobox", { name: "Connection", exact: true })).toHaveValue("");
  const status = await api("/api/memory/status"); expect(status.configuration.extractorInstanceId).toBeNull(); expect(status.learning.connection).toMatchObject({ source: "default", instanceId: "@murage/flux-fast" });
  const bots = dialog.getByRole("region", { name: "Bots", exact: true }); const toggle = bots.getByRole("switch").first();
  await expect(toggle).toBeChecked(); await toggle.click(); await expect(toggle).not.toBeChecked();
  await expect.poll(async () => (await api("/api/memory/status")).learning.settings.botsPaused.length).toBe(1);
  await expect(toggle).toBeEnabled(); await toggle.click(); await expect(toggle).toBeChecked();
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const chats = learning.getByRole("switch", { name: "My chats", exact: true });
    await chats.scrollIntoViewIfNeeded(); await chats.focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
    await expect(chats).toBeFocused(); expect(await chats.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.addScriptTag({ path: fileURLToPath(new URL("../../node_modules/axe-core/axe.min.js", import.meta.url)) });
    const audit = await page.evaluate(async () => (window as unknown as { axe: { run(element: Element | null): Promise<{ violations: Array<{ impact: string }> }> } }).axe.run(document.querySelector('[role="dialog"]')));
    expect(audit.violations.filter(item => ["critical", "serious"].includes(item.impact))).toEqual([]);
    await info.attach(`memory-axe-${width}`, { body: JSON.stringify(audit), contentType: "application/json" });
    await page.screenshot({ path: info.outputPath(`memory-learning-${width}.png`), fullPage: true });
  }
});

// Renderer race fixture: server behavior is covered by learning-routes.test.ts.
for(const mutation of ["forget","correct"] as const)test(`workspace ${mutation} refreshes history and discards an older in-flight page`,async({page})=>{
 await page.addInitScript(()=>{localStorage.setItem("murage-email-gate","skipped");localStorage.setItem("murage-flux-invite-dismissed","1");});
 const record={id:"history-fixture",version:1,scopeId:"fixture",kind:"fact",text:"FORGET_HISTORY_CANARY",assertion:"owner-statement",state:"active",ownerPinned:false,validFrom:1,validTo:null};
 const event={id:"learned-fixture",kind:"activated",record_id:record.id,record_version:1,created_at:1,undone_at:null,kept_at:null,record,scopeLabel:"Workspace",source:{threadId:"fixture",messageId:"message",botName:"Fixture bot",roomName:null}};
 let forgotten=false,corrected=false,historyCalls=0,release!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;});
 await page.route("**/api/memory/action",async route=>{
  const body=route.request().postDataJSON();
  if(body.action==="learning-history"){
   historyCalls++;
   if(body.cursor){await held;return route.fulfill({json:{events:[{...event,id:"stale-page"}],nextCursor:null}});}
   return route.fulfill({json:{events:forgotten?[]:[corrected?{...event,record:{...record,version:2,text:"CORRECTED_HISTORY_CANARY"}}:event],nextCursor:forgotten||corrected?null:"older"}});
  }
  if(body.action==="list")return route.fulfill({json:{records:forgotten?[]:[corrected?{...record,version:2,text:"CORRECTED_HISTORY_CANARY"}:record],nextCursor:null}});
  if(body.action==="inspect")return route.fulfill({json:{record,evidence:[],lineage:[]}});
  if(body.action==="forget"){forgotten=true;return route.fulfill({json:{ok:true}});}
  if(body.action==="correct"){corrected=true;return route.fulfill({json:{ok:true}});}
  return route.continue();
 });
 try{
  await page.goto(origin);const sidebar=await openSidebar(page);await sidebar.getByRole("button",{name:"App settings",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Settings",exact:true});await dialog.getByRole("navigation").getByRole("button",{name:"Memory",exact:true}).click();
  const history=dialog.getByRole("region",{name:"What it learned",exact:true});await expect(history.getByText(record.text,{exact:true})).toBeVisible();
  // The dev renderer runs under React StrictMode, which mounts the section's
  // effects twice, so the first page can be asked for twice; count from here.
  const firstPage=historyCalls;expect(firstPage).toBeGreaterThanOrEqual(1);
  await history.getByRole("button",{name:"Show more",exact:true}).click();await expect.poll(()=>historyCalls).toBe(firstPage+1);
  await dialog.getByRole("button",{name:"Inspect memory",exact:true}).click();
  const detail=dialog.getByRole("region",{name:"Memory details",exact:true});
  if(mutation==="forget"){await detail.getByRole("checkbox",{name:"Confirm forgetting this memory"}).check();await detail.getByRole("button",{name:"Forget memory",exact:true}).click();}
  else{await detail.getByRole("textbox",{name:"Correction text",exact:true}).fill("CORRECTED_HISTORY_CANARY");await detail.getByRole("button",{name:"Save correction",exact:true}).click();}
  await expect.poll(()=>historyCalls).toBe(firstPage+2);await expect(history.getByText(record.text,{exact:true})).toHaveCount(0);if(mutation==="forget")await expect(history.getByRole("link")).toHaveCount(0);
  const staleResponse=page.waitForResponse(response=>response.url().endsWith("/api/memory/action")&&response.request().postDataJSON()?.cursor==="older");
  release();await staleResponse;await expect(history.getByText(mutation==="forget"?"Nothing learned yet. New learning will appear here with its source.":"CORRECTED_HISTORY_CANARY",{exact:true})).toBeVisible();await expect(history.getByText(record.text,{exact:true})).toHaveCount(0);
 }finally{release();}
});
