import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { axeScriptPath } from "./axe";
let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-provider-error-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false, optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "lucide-react"] }, resolve: { alias: { "@": root + "/src" } },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "provider-error-fixture",
      resolveId(id) { if (id === "/__provider.js") return "\0provider-error-fixture"; },
      load(id) {
        if (id.endsWith("/src/styles.css")) return readFileSync(id, "utf8").replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "./components";');
        if (id !== "\0provider-error-fixture") return;
        return "import React from 'react';import {createRoot} from 'react-dom/client';import {ProviderErrorCard} from '/src/components/ProviderErrorCard.tsx';import {RuntimeErrorCard} from '/src/components/RuntimeErrorCard.tsx';import {setLocale} from '/src/lib/i18n.ts';import '/src/styles.css';const q=new URLSearchParams(location.search);setLocale(q.get('lang')||'en');document.documentElement.dataset.skin=q.get('skin')||'dark';window.retryCalls=0;window.settingsCalls=0;createRoot(document.getElementById('root')).render(React.createElement(q.has('runtime')?RuntimeErrorCard:ProviderErrorCard,{message:q.get('message')||'Internal error',details:q.has('detail')?'Internal error — diagnostic text beyond a short badge. Provider response: HTTP 500. Engine error code: -32603. <script>window.injected=true</script>':undefined,info:{kind:q.get('kind')||'credits',httpStatus:Number(q.get('status')||402),...(q.get('provider')==='flux-router'?{provider:'flux-router'}:{})},diagnostic:q.has('tracking')?(window.trackingFixture={version:1,diagnosticId:'ev-fixture-1',turnId:'00000000-0000-4000-8000-000000000001',rpcId:7,method:'session/prompt',rpcCode:-32603,httpStatus:402,terminalKind:'api',observedKind:'http',...(q.get('tracking')==='private'?{raw:'PRIVATE_DIAGNOSTIC_CANARY'}:{})}):undefined,turnId:q.has('tracking')?(q.get('tracking')==='mismatch'?'00000000-0000-4000-8000-000000000003':'00000000-0000-4000-8000-000000000001'):undefined,incident:q.has('incident')?{threadId:q.get('incident')==='invalid'?'../PRIVATE_PATH':'thread-fixture',messageId:'message-fixture'}:undefined,onRetry:q.has('noRetry')?undefined:()=>window.retryCalls++,onOpenProviderSettings:()=>window.settingsCalls++}));";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__provider?") && req.url !== "/__provider") return next();
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html lang="en" data-provider-fixture><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Provider error fixture</title><style>html[data-provider-fixture],html[data-provider-fixture] body,html[data-provider-fixture] #root{height:auto;min-height:100%;overflow:visible}</style></head><body style="margin:0;background:var(--color-app)"><main style="padding:24px;max-width:760px;margin:40px auto" id="root"></main><script type="module" src="/__provider.js"></script></body></html>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });

test("selected incident export is explicit, bound and safe on success cancellation and failure",async({page},info)=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.addInitScript(()=>{const w=window as any;w.exportCalls=[];w.exportMode="success";if(!new URLSearchParams(location.search).has("noBridge"))w.muragebox={exportDiagnostics:async(...args:unknown[])=>{w.exportCalls.push(args);if(w.exportMode==="hold")await new Promise(resolve=>w.releaseExport=resolve);if(w.exportMode==="error")throw Error("PRIVATE_EXPORT_ERROR_CANARY");return w.exportMode==="cancel"?null:"/PRIVATE_EXPORT_PATH/report.md";}};});
  const axe=readFileSync(axeScriptPath,"utf8");
  for(const runtime of [false,true])for(const width of [390,820,1440]){
    await page.setViewportSize({width,height:900});await page.goto(origin+"/__provider?kind=payment&status=402&skin=dark&tracking=valid&incident=saved"+(runtime?"&runtime=1":""));await page.waitForLoadState("networkidle");
    expect(await page.evaluate(()=>(window as any).exportCalls)).toEqual([]);
    await page.keyboard.press("Tab");await page.keyboard.press("Tab");await page.keyboard.press("Tab");await expect(page.getByText("Technical details",{exact:true})).toBeFocused();await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");await expect(page.getByRole("button",{name:"Copy diagnostic ID",exact:true})).toBeFocused();await page.keyboard.press("Tab");const button=page.getByRole("button",{name:"Export this incident",exact:true});await expect(button).toBeFocused();
    expect(await button.evaluate(node=>{const s=getComputedStyle(node);return s.outlineStyle!=="none"&&parseFloat(s.outlineWidth)>0||s.boxShadow!=="none";})).toBe(true);
    await page.keyboard.press("Enter");await expect(page.getByText("Incident diagnostics saved.",{exact:true})).toBeVisible();
    expect(await page.evaluate(()=>(window as any).exportCalls)).toEqual([[{threadId:"thread-fixture",messageId:"message-fixture",diagnosticId:"ev-fixture-1"}]]);
    expect(await page.evaluate(()=>[(window as any).retryCalls,(window as any).settingsCalls])).toEqual([0,0]);await expect(page.getByText("PRIVATE_EXPORT_PATH",{exact:false})).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.evaluate(axe);const audit=await page.evaluate(async()=>(window as any).axe.run(document.querySelector('[role="alert"]'),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}}));await info.attach(`incident-axe-${runtime?"runtime":"provider"}-${width}`,{body:JSON.stringify(audit),contentType:"application/json"});expect(audit.violations).toEqual([]);
    await page.screenshot({path:info.outputPath(`incident-${runtime?"runtime":"provider"}-${width}.png`),fullPage:true});
  }
  const button=page.getByRole("button",{name:"Export this incident",exact:true});
  await page.evaluate(()=>{(window as any).exportMode="cancel";});await button.click();await expect(page.getByText("Export cancelled. No report was saved.",{exact:true})).toBeVisible();await expect(page.getByText("Incident diagnostics saved.",{exact:true})).toHaveCount(0);
  await page.evaluate(()=>{(window as any).exportMode="error";});await button.click();await expect(page.getByText("Incident diagnostics could not be exported.",{exact:false})).toBeVisible();await expect(page.getByText("PRIVATE_EXPORT_ERROR_CANARY",{exact:false})).toHaveCount(0);
  await page.evaluate(()=>{(window as any).exportMode="hold";});await button.click();await expect(page.getByRole("button",{name:"Preparing incident export…",exact:true})).toBeDisabled();expect(await page.evaluate(()=>(window as any).exportCalls.length)).toBe(4);await page.evaluate(()=>(window as any).releaseExport());await expect(button).toBeEnabled();
  for(const query of ["tracking=valid","tracking=valid&incident=invalid","tracking=private&incident=saved","tracking=mismatch&incident=saved","incident=saved","tracking=valid&incident=saved&noBridge=1"]){
    await page.goto(origin+"/__provider?kind=payment&status=402&"+query);await page.getByText("Technical details",{exact:true}).click();await expect(page.getByRole("button",{name:"Export this incident",exact:true})).toHaveCount(0);expect(await page.evaluate(()=>(window as any).exportCalls)).toEqual([]);await expect(page.getByText("PRIVATE_PATH",{exact:false})).toHaveCount(0);
  }
  await page.goto(origin+"/__provider?kind=payment&status=402&tracking=valid&incident=saved");await page.getByText("Technical details",{exact:true}).click();await page.evaluate(()=>{(window as any).trackingFixture.raw="PRIVATE_LATE_EXPORT_CANARY";});await button.click();expect(await page.evaluate(()=>(window as any).exportCalls)).toEqual([]);await expect(page.getByText("PRIVATE_LATE_EXPORT_CANARY",{exact:false})).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("bound diagnostic tracking copies only its ID and rejects private or legacy data", async ({ page }, info) => {
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.context().grantPermissions(["clipboard-read","clipboard-write"]);
  const axe=readFileSync(axeScriptPath,"utf8");
  for(const runtime of [false,true])for(const width of [390,820,1440]){
    await page.setViewportSize({width,height:900});await page.goto(origin+"/__provider?kind=payment&status=402&skin=dark&tracking=valid"+(runtime?"&runtime=1":""));await page.waitForLoadState("networkidle");
    expect(await page.evaluate(()=>[(window as any).retryCalls,(window as any).settingsCalls])).toEqual([0,0]);
    for(const control of [page.getByRole("button",{name:"Provider settings",exact:true}),page.getByRole("button",{name:"Retry",exact:true}),page.getByText("Technical details",{exact:true})]){await page.keyboard.press("Tab");await expect(control).toBeFocused();}
    await page.keyboard.press("Enter");
    const facts=page.getByLabel("Diagnostic tracking facts");await expect(facts).toContainText("Terminal error kind");await expect(facts).toContainText("Observed error kind (not terminal)");await expect(facts).toContainText("session/prompt");await expect(facts).not.toContainText("Process generation");
    await page.keyboard.press("Tab");const copy=page.getByRole("button",{name:"Copy diagnostic ID",exact:true});await expect(copy).toBeFocused();
    expect(await copy.evaluate(node=>{const s=getComputedStyle(node);return s.outlineStyle!=="none"&&parseFloat(s.outlineWidth)>0||s.boxShadow!=="none";})).toBe(true);
    await page.keyboard.press("Enter");await expect(page.getByText("Diagnostic ID copied.",{exact:true})).toBeVisible();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe("ev-fixture-1");
    expect(await page.evaluate(()=>[(window as any).retryCalls,(window as any).settingsCalls])).toEqual([0,0]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.evaluate(axe);const audit=await page.evaluate(async()=>(window as any).axe.run(document.querySelector('[role="alert"]'),{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}}));
    await info.attach(`tracking-axe-${runtime?"runtime":"provider"}-${width}`,{body:JSON.stringify(audit),contentType:"application/json"});expect(audit.violations).toEqual([]);
    await page.screenshot({path:info.outputPath(`tracking-${runtime?"runtime":"provider"}-${width}.png`),fullPage:true});
  }
  await page.evaluate(()=>{Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async()=>{throw Error("PRIVATE_CLIPBOARD_CANARY");}}});});
  await page.getByRole("button",{name:"Copy diagnostic ID",exact:true}).click();await expect(page.getByText("Could not copy. Select the diagnostic ID above and copy it manually.",{exact:true})).toBeVisible();await expect(page.getByText("PRIVATE_CLIPBOARD_CANARY",{exact:false})).toHaveCount(0);
  for(const runtime of [false,true])for(const tracking of ["private","mismatch",""]){
    await page.goto(origin+"/__provider?kind=payment&status=402"+(runtime?"&runtime=1":"")+(tracking?"&tracking="+tracking:""));await page.getByText("Technical details",{exact:true}).click();await expect(page.getByRole("button",{name:"Copy diagnostic ID",exact:true})).toHaveCount(0);await expect(page.getByText("PRIVATE_DIAGNOSTIC_CANARY",{exact:false})).toHaveCount(0);
    await expect(page.getByRole("button",{name:"Retry",exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as any).retryCalls)).toBe(0);
  }
  // A payload changed after render must still be validated at the copy boundary.
  await page.goto(origin+"/__provider?kind=payment&status=402&tracking=valid");await page.getByText("Technical details",{exact:true}).click();await page.evaluate(async()=>{await navigator.clipboard.writeText("fictional-clipboard-unchanged");(window as any).trackingFixture.raw="PRIVATE_LATE_CANARY";});await page.getByRole("button",{name:"Copy diagnostic ID",exact:true}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe("fictional-clipboard-unchanged");await expect(page.getByText("PRIVATE_LATE_CANARY",{exact:false})).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("HTTP402 payment guidance is generic, translated and manual at three widths in both skins", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const axe = readFileSync(axeScriptPath, "utf8");
  for (const width of [390, 820, 1440]) for (const skin of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin + "/__provider?kind=payment&status=402&skin=" + skin); await page.waitForLoadState("networkidle");
    const alert = page.getByRole("alert");
    await expect(page.getByRole("heading", { name: "Provider payment or account access required", exact: true })).toBeVisible();
    await expect(alert).toContainText("does not establish that credits are exhausted");
    await expect(alert).toContainText("billing, account and selected-model access"); await expect(alert).toContainText("BYOK");
    await expect(page.getByRole("link")).toHaveCount(0); await expect(alert).not.toContainText("Flux Router");
    expect(await page.evaluate(() => [(window as any).retryCalls, (window as any).settingsCalls])).toEqual([0, 0]);
    const controls = [page.getByRole("button", { name: "Provider settings", exact: true }), page.getByRole("button", { name: "Retry", exact: true }), page.getByText("Technical details", { exact: true })];
    for (const control of controls) {
      await page.keyboard.press("Tab"); await expect(control).toBeFocused();
      expect(await control.evaluate(node => { const style = getComputedStyle(node); return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 || style.boxShadow !== "none"; })).toBe(true);
      await page.keyboard.press("Enter");
    }
    expect(await page.evaluate(() => [(window as any).retryCalls, (window as any).settingsCalls])).toEqual([1, 1]);
    await expect(alert).toContainText("Provider response: HTTP 402");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(axe); const audit = await page.evaluate(async () => (window as any).axe.run(document.querySelector('[role="alert"]'), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } }));
    await info.attach(`payment-axe-${width}-${skin}`, { body: JSON.stringify(audit), contentType: "application/json" }); expect(audit.violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`payment-${width}-${skin}.png`), fullPage: true });
  }
  // Even an explicit provider label must not manufacture a payment/top-up action.
  await page.goto(origin + "/__provider?kind=payment&status=402&provider=flux-router&noRetry=1");
  await expect(page.getByRole("link")).toHaveCount(0); await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).retryCalls)).toBe(0);
  for (const locale of ["de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
    const pack = JSON.parse(readFileSync(new URL("../locales/" + locale + ".json", import.meta.url), "utf8"));
    await page.setViewportSize({ width: 390, height: 900 }); await page.goto(origin + "/__provider?kind=payment&status=402&lang=" + locale);
    await expect(page.getByRole("heading", { name: pack["providerError.payment.title"], exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(pack["providerError.payment.resolution"]); await expect(page.getByRole("link")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test("provider safety card has no retry and keeps keyboard-readable details", async ({ page }, info) => {
  for (const width of [390, 820, 1440]) for (const skin of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin + "/__provider?runtime=1&skin=" + skin + "&message=" + encodeURIComponent("429 request blocked by our safety systems"));
    await expect(page.getByRole("heading", { name: "The provider blocked this request" })).toBeVisible();
    await expect(page.getByRole("button")).toHaveCount(0);
    await page.keyboard.press("Tab");
    await expect(page.getByText("Technical details", { exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("details[open] pre")).toContainText("429 request blocked");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => (window as any).retryCalls)).toBe(0);
    if (process.env.MURAGE_AXE_SCRIPT) {
      await page.addScriptTag({ path: process.env.MURAGE_AXE_SCRIPT });
      const audit = await page.evaluate(async () => (window as any).axe.run(document.querySelector('[role="alert"]'), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } }));
      await info.attach(`axe-${width}-${skin}`, { body: JSON.stringify(audit), contentType: "application/json" });
      expect(audit.violations).toEqual([]);
    }
    await page.screenshot({ path: info.outputPath(`safety-${width}-${skin}.png`), fullPage: true });
  }
});

for (const locale of ["de", "es", "fr", "hi", "ja", "pt-br", "zh"]) test("provider recovery renders translated actions on mobile: " + locale, async ({ page }, info) => {
  const pack = JSON.parse(readFileSync(new URL("../locales/" + locale + ".json", import.meta.url), "utf8"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/__provider?provider=flux-router&kind=credits&status=402&lang=" + locale);
  await expect(page.getByRole("heading", { name: pack["providerError.credits.title"].replace("{provider}", "Flux Router") })).toBeVisible();
  await expect(page.getByRole("button", { name: pack["providerError.settings"], exact: true })).toBeVisible();
  await page.getByRole("button", { name: pack["providerError.retry"], exact: true }).click();
  expect(await page.evaluate(() => (window as any).retryCalls)).toBe(1);
  await page.getByText(pack["providerError.details"], { exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(pack["providerError.status"].replace("{status}", "402"));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (["de", "ja"].includes(locale)) await page.screenshot({ path: info.outputPath("provider-error-" + locale + ".png"), fullPage: true });
});

test("Flux credits render a billing action, useful recovery details and keyboard-only manual actions", async ({ page }, info) => {
  await page.setViewportSize({ width: 980, height: 780 });
  await page.goto(origin + "/__provider?provider=flux-router&kind=credits&status=402&skin=dark");
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(page.getByRole("heading", { name: "Flux Router needs credits" })).toBeVisible();
  await expect(alert).toContainText("How to continue");
  const billing = page.getByRole("link", { name: "Add Flux credits" });
  await expect(billing).toHaveAttribute("href", "https://fluxrouter.ai/home/billing");
  await expect(billing).toHaveAttribute("rel", "noopener noreferrer");
  expect(await page.evaluate(() => (window as any).retryCalls)).toBe(0);
  await billing.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Provider settings" })).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as any).settingsCalls)).toBe(1);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as any).retryCalls)).toBe(1);
  await page.getByText("Technical details", { exact: true }).click();
  await expect(alert).toContainText("Provider response: HTTP 402");
  await expect(alert).not.toContainText("request ID");
  await page.screenshot({ path: info.outputPath("flux-credits-dark-desktop.png") });
});

for (const skin of ["light", "dark"]) test("provider recovery card fits mobile in " + skin, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/__provider?provider=flux-router&kind=credits&status=402&skin=" + skin);
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const label of ["Provider settings", "Retry"]) {
    const bounds = await page.getByRole("button", { name: label, exact: true }).boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: info.outputPath("flux-credits-" + skin + "-mobile.png") });
});

test("other provider failures use fixed recovery categories and never gain a billing link", async ({ page }) => {
  const scenarios = [
    { kind: "credits", status: 402, title: /needs credits/, resolution: /choose another configured engine/ },
    { kind: "authentication", status: 401, title: /could not authenticate/, resolution: /sign-in or API-key configuration/ },
    { kind: "permission", status: 403, title: /denied access/, resolution: /account has access/ },
    { kind: "rate-limit", status: 429, title: /request limit reached/, resolution: /limit and reset time before retrying/ },
    { kind: "unavailable", status: 503, title: /temporarily unavailable/, resolution: /Retry later/ },
  ];
  for (const scenario of scenarios) {
    await page.goto(origin + "/__provider?kind=" + scenario.kind + "&status=" + scenario.status + "&skin=light&noRetry=1");
    await expect(page.getByRole("heading", { name: scenario.title })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(scenario.resolution);
    await expect(page.getByRole("link")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).retryCalls)).toBe(0);
  }
});

for (const width of [390, 1000]) test(`runtime errors explain missing context and expand received details at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(origin + "/__provider?runtime=1");
  await expect(page.getByRole("heading", { name: "This request hit a problem" })).toBeVisible();
  await page.getByText("Technical details", { exact: true }).click();
  await expect(page.getByText("No additional error details were supplied by the engine.")).toBeVisible();
  expect(await page.evaluate(() => (window as any).retryCalls)).toBe(0);
  await page.goto(origin + "/__provider?runtime=1&detail=1");
  await page.getByText("Technical details", { exact: true }).click();
  await expect(page.locator("pre")).toContainText("Engine error code: -32603");
  await expect(page.locator("pre")).toContainText("<script>");
  expect(await page.evaluate(() => (window as any).injected)).toBeUndefined();
  await page.getByRole("button", { name: "Provider settings", exact: true }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  expect(await page.evaluate(() => [(window as any).settingsCalls, (window as any).retryCalls])).toEqual([1, 1]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`runtime-error-${width}.png`), fullPage: true });
});

const BUSY = "Another thread is using this computer. Wait for it to finish.";
for (const skin of ["light", "dark"]) for (const width of [390, 1000]) test(`local resource contention offers wait and retry guidance, not provider advice, in ${skin} at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(origin + "/__provider?runtime=1&skin=" + skin + "&message=" + encodeURIComponent(BUSY));
  const alert = page.getByRole("alert");
  await expect(page.getByRole("heading", { name: "Another thread is using this computer", exact: true })).toBeVisible();
  await expect(alert).toContainText("Wait for the other thread to finish, or stop it, then retry.");
  await expect(alert).not.toContainText(/provider|account|sign-in|API key|credits|configured model|hit a problem/i);
  await expect(page.getByRole("button", { name: "Provider settings" })).toHaveCount(0);
  await expect(page.getByRole("link")).toHaveCount(0);
  await expect(alert.getByRole("button")).toHaveCount(1);
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  expect((await retry.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  // Keyboard only: the first stop is Retry, then the diagnostics disclosure.
  await page.keyboard.press("Tab");
  await expect(retry).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => [(window as any).retryCalls, (window as any).settingsCalls])).toEqual([1, 0]);
  await page.keyboard.press("Tab");
  await expect(page.getByText("Technical details", { exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(alert.locator("pre")).toHaveText(BUSY);
  // The warning treatment is the theme's own token, not the danger card.
  const colors = await alert.evaluate(section => {
    const icon = section.querySelector("span[aria-hidden]")!;
    const probe = document.createElement("span"); probe.style.color = "var(--color-warning)"; document.body.append(probe);
    const warning = getComputedStyle(probe).color; probe.remove();
    return { icon: getComputedStyle(icon).color, warning, border: getComputedStyle(section).borderTopColor };
  });
  expect(colors.icon).toBe(colors.warning);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`resource-busy-${skin}-${width}.png`), fullPage: true });
});

test("an ordinary runtime error whose details repeat the busy copy keeps the diagnostic card", async ({ page }) => {
  await page.goto(origin + "/__provider?runtime=1&detail=1&message=" + encodeURIComponent(BUSY));
  await expect(page.getByRole("heading", { name: "This request hit a problem" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Provider settings", exact: true })).toBeVisible();
});
