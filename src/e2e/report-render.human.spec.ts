import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
interface VerificationServer { info: { url: string; dataDir: string }; close(): Promise<void> }
const messageId = "11111111-1111-4111-8111-111111111111", artifactId = "22222222-2222-4222-8222-222222222222";
let fixture: VerificationServer, vite: ViteDevServer, origin: string;
test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href);
  fixture = await launchVerificationServer(process.env);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "render-vite"), resolve: { alias: { "@": join(root, "src") } },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } }, plugins: [react(), tailwindcss(), {
      name: "report-render-fixture", resolveId(id) { if (id === "/__render.js") return "\0report-render"; }, load(id) {
        if (id !== "\0report-render") return;
        return `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider,useStore} from '/src/state/store.tsx';import {ChatView} from '/src/components/ChatView.tsx';import '/src/styles.css';
        const report={id:'${messageId}',role:'bot',kind:'text',text:'Saved file: Timed report',at:1000,artifactIds:['${artifactId}']};
        function Surface(){const {state}=useStore();const [phase,setPhase]=useState('idle');const base=state.bots[0];if(!base)return null;const messages=phase==='idle'||phase==='waiting'||phase==='B'?[]:phase==='activity'?[report,{id:'activity',role:'bot',kind:'activity',at:1001,tool:{name:'error: interrupted',ok:false}}]:[report];
        const bot={...base,threadId:phase==='B'?'thread-B':'thread-A',tasks:[],messages,busy:phase==='waiting',activity:phase==='waiting'?'thinking':'idle',activeLeafId:undefined};
        return React.createElement(React.Fragment,null,React.createElement('nav',{'aria-label':'Fixture controls'},...['waiting','report','activity','B','A'].map(value=>React.createElement('button',{key:value,onClick:()=>setPhase(value)},value))),React.createElement('div',{style:{height:800,position:'relative'}},React.createElement(ChatView,{bot})));}
        createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,React.createElement(Surface)));`;
      }, configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/__render") return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__render.js"></script>'); }); },
    }] });
  await vite.listen(); const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw Error("No fixture port"); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });
for (const scenario of ["activity", "thread", "normal"]) test(`saved artifact settles after ${scenario}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route(`**/api/artifacts/${artifactId}`, route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ artifact: { id: artifactId, name: "Timed report", botName: "Fixture", kind: "html", bytes: 10, createdAt: 1000, savedState: "available", sourceState: "current", sourceConversationAvailable: true } }) }));
  await page.goto(origin + "/__render", { waitUntil: "domcontentloaded" });
  const controls = page.getByRole("navigation", { name: "Fixture controls" }); await expect(controls).toBeVisible();
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await controls.getByRole("button", { name: "waiting", exact: true }).click();
  await expect(page.locator(".turn-presence")).toBeVisible();
  await controls.getByRole("button", { name: "report", exact: true }).click();
  await expect(page.locator(".turn-answer")).toContainText("Saved file: Timed report");
  await page.clock.runFor(100);
  if (scenario === "activity") await controls.getByRole("button", { name: "activity", exact: true }).click();
  if (scenario === "thread") { await controls.getByRole("button", { name: "B", exact: true }).click(); await controls.getByRole("button", { name: "A", exact: true }).click(); }
  if (scenario === "normal") await expect(page.locator(".turn-answer")).toBeVisible();
  await page.clock.runFor(600);
  await expect(page.locator(`[data-mid="${messageId}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-artifact-id="${artifactId}"]`)).toBeVisible();
  await expect(page.locator(".turn-answer")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`${scenario}.png`) });
});
