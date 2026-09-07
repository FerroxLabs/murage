import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: ViteDevServer;
let origin: string;
let cache: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-engine-setup-"));
  server = await createServer({ configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: { "@": `${root}/src` } }, server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), { name: "engine-setup-fixture", enforce: "pre",
      resolveId(id) {
        if (id.endsWith("/src/state/store") || id === "@/state/store") return "\0fixture-store";
        if (id === "/__engine.js") return "\0fixture-engine";
      },
      load(id) {
        if (id === "\0fixture-store") return `
          export * from '/src/state/store.tsx?original';
          import {useSyncExternalStore} from 'react';
          export function useStore(){return useSyncExternalStore(window.subscribeFixture,()=>window.fixtureStore);}
        `;
        if (id !== "\0fixture-engine") return;
        return `
          import React from 'react'; import {createRoot} from 'react-dom/client';
          import {EnginesSettings} from '/src/components/EnginesSettings.tsx'; import '/src/styles.css';
          const listeners=new Set(); window.subscribeFixture=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
          window.fixtureInstance={instanceId:'claude',driverKind:'claudeAgent',displayName:'Claude',enabled:true,cliDefault:'claude',models:{default:'',options:[]},snapshot:{state:'unavailable',reason:'CLI not detected'},install:{command:{darwin:'fixture install',linux:'fixture install',win32:'fixture install'},signInCommand:'fixture login'}};
          const state={instances:[window.fixtureInstance]};
          const dispatch=action=>{if(action.type==='instances')state.instances=action.instances;window.fixtureStore={state:{...state},dispatch};listeners.forEach(fn=>fn());};dispatch({});
          window.muragebox={platform:'darwin',openInstallTerminal:()=>new Promise((resolve,reject)=>{window.resolveTerminal=resolve;window.rejectTerminal=reject;})};
          createRoot(document.getElementById('root')).render(React.createElement(EnginesSettings));
        `;
      },
      configureServer(vite) { vite.middlewares.use((req,res,next)=>{
        if(req.url!=="/__engine")return next(); res.setHeader("content-type","text/html");
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="max-width:440px;padding:20px"></div><script type="module" src="/__engine.js"></script>');
      }); },
    }],
  });
  await server.listen(0); const address=server.httpServer!.address();
  if(!address || typeof address==='string')throw new Error('No fixture port');
  origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await server?.close();rmSync(cache,{recursive:true,force:true});});

test("engine setup reports terminal and probe outcomes without claiming installation",async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto(`${origin}/__engine`);
  await page.getByRole('button',{name:'Open install in Terminal'}).click();
  await expect(page.getByRole('button',{name:'Opening Terminal…'})).toBeDisabled();
  await page.evaluate(()=> (window as any).resolveTerminal(false));
  await expect(page.getByRole('alert')).toContainText('Could not open Terminal');
  await expect(page.getByText('Command copied',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Open install in Terminal'}).click();
  await page.evaluate(()=> (window as any).rejectTerminal(new Error('fixture IPC rejected')));
  await expect(page.getByRole('alert')).toContainText('Could not open Terminal');
  await page.getByRole('button',{name:'Open install in Terminal'}).click();
  await page.evaluate(()=> (window as any).resolveTerminal(true));
  await expect(page.getByRole('button',{name:'Terminal opened'})).toBeVisible();
  await expect(page.getByText('CLI not detected',{exact:true})).toBeVisible();
  await expect(page.getByText(/Finish or cancel in Terminal/)).toBeVisible();
  await page.route('**/api/instances',route=>route.fulfill({status:503,json:{error:'Fixture check unavailable'}}));
  await page.getByRole('button',{name:'Check again'}).click();
  await expect(page.getByRole('alert')).toContainText('Fixture check unavailable');
  await expect(page.getByText('CLI not detected',{exact:true})).toBeVisible();
  await page.unroute('**/api/instances');
  const instance=await page.evaluate(()=>(window as any).fixtureInstance);
  await page.route('**/api/instances',route=>route.fulfill({json:{instances:[{...instance,snapshot:{state:'available',authenticated:false}}]}}));
  await page.getByRole('button',{name:'Check again'}).click();
  await expect(page.getByRole('button',{name:'Open sign-in in Terminal'})).toBeVisible();
  await expect(page.getByText('Detected · sign-in required',{exact:true})).toBeVisible();
  await expect(page.getByText('Ready',{exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('engine-sign-in-mobile.png')});
});
