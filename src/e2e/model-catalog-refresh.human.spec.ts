import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-model-refresh-"));
  server = await createServer({ configFile: false, root, cacheDir: cache, envFile: false,
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "lucide-react"] },
    resolve: { alias: { "@": `${root}/src` } }, server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), { name: "model-refresh-fixture", enforce: "pre",
      resolveId(id) { if (id.endsWith("/src/state/store") || id === "@/state/store") return "\0fixture-store"; if (id === "/__models.js") return "\0fixture-models"; },
      load(id) {
        if (id.endsWith("/src/styles.css")) return readFileSync(id, "utf8").replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "./components";');
        if (id === "\0fixture-store") return `
          export async function api(url, options = {}) { const response=await fetch(url,{...options,headers:{'content-type':'application/json'}}); const value=await response.json(); if(!response.ok)throw new Error(value.error||'Request failed'); return value; }
          import {useSyncExternalStore} from 'react'; export function useStore(){return useSyncExternalStore(window.subscribeFixture,()=>window.fixtureStore);}
        `;
        if (id !== "\0fixture-models") return;
        return `
          import React from 'react'; import {createRoot} from 'react-dom/client';
          import {ModelPicker} from '/src/components/ModelPicker.tsx'; import {api} from '@/state/store'; import '/src/styles.css';
          const listeners=new Set();window.subscribeFixture=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
          const state={instances:[{instanceId:'codex',driverKind:'codex',displayName:'Codex',enabled:true,snapshot:{state:'available',authenticated:true},models:{default:'gpt-current',options:[{id:'gpt-current',label:'Current native'}]}}]};
          const bot={id:'fixture-bot',modelSelection:{instanceId:'codex',connectionId:'account-one',model:'gpt-provider-old',effort:'medium'}};window.fixtureBot=bot;window.fixtureActions=[];
          const dispatch=action=>{window.fixtureActions.push(action);};
          const publish=()=>{window.fixtureStore={state:{...state},dispatch,refreshInstances};listeners.forEach(fn=>fn());};
          async function refreshInstances(){const result=await api('/api/instances');state.instances=result.instances;publish();}
          publish();createRoot(document.getElementById('root')).render(React.createElement(ModelPicker,{bot,contained:true}));
        `;
      },
      configureServer(vite) { vite.middlewares.use((req,res,next)=>{
        if(req.url!=="/__models")return next();res.setHeader("content-type","text/html");res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="max-width:500px;padding:12px"></div><script type="module" src="/__models.js"></script>');
      }); },
    }],
  });
  await server.listen(0);const address=server.httpServer!.address();if(!address||typeof address==='string')throw new Error('No fixture port');origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await server?.close();safeWipeSync(cache);});

test("manual catalog refresh discovers current rows while preserving a removed choice and honest metadata",async({page},testInfo)=>{
 let refreshed=0,instanceReads=0,fail=false;const refreshIds:string[]=[];
 const model=(id:string,label:string,chat=true)=>({connectionId:'account-one',preset:'openai',id,label,enabled:true,chatEligible:chat,capabilities:{chat},outputModalities:chat?['text']:['image']});
 const catalog=()=>({connectionId:'account-one',fetchedAt:1234,stale:false,assurance:'catalog-only',models:[model(refreshed?'gpt-provider-new':'gpt-provider-old',refreshed?'Provider discovered':'Provider original'),model('image-only','Excluded image',false)]});
 await page.route('**/api/provider-connections',route=>route.fulfill({json:{connections:[{id:'account-one',preset:'openai',label:'Work OpenAI',enabled:true,revision:'fixture-revision',protocol:'responses',configured:true,state:'catalog-ready',catalog:catalog()},{id:'disabled',preset:'openai',label:'Disabled account',enabled:false,revision:'disabled',protocol:'responses',configured:true,state:'saved',catalog:{...catalog(),models:[]}}]}}));
 await page.route('**/api/provider-connections/*/refresh',route=>{refreshIds.push(route.request().url().split('/').at(-2)!);expect(route.request().method()).toBe('POST');if(fail)return route.fulfill({status:503,json:{error:'Fixture catalog unavailable'}});refreshed++;return route.fulfill({json:catalog()});});
 await page.route('**/api/instances',route=>{instanceReads++;return route.fulfill({json:{instances:[{instanceId:'codex',driverKind:'codex',displayName:'Codex',enabled:true,snapshot:{state:'available',authenticated:true},models:{default:'gpt-current',options:[{id:'gpt-current',label:'Current native'},...(instanceReads>1?[{id:'gpt-native-new',label:'Native discovered'}]:[])]}}]}});});
 await page.goto(`${origin}/__models`);await page.locator('button[aria-haspopup="dialog"]').click();
 await expect(page.getByRole('dialog').getByRole('button',{name:/^Provider original/})).toBeVisible();expect(refreshed).toBe(0);
 const before=await page.evaluate(()=>(window as any).fixtureBot.modelSelection);
 await page.getByRole('button',{name:'Refresh models',exact:true}).click();
 await expect(page.getByRole('dialog').getByRole('button',{name:/^Provider discovered/})).toBeVisible();await expect(page.getByRole('dialog').getByRole('button',{name:/^Native discovered/})).toBeVisible();
 await expect(page.getByText(/your selection is preserved/)).toBeVisible();
 expect(await page.evaluate(()=>(window as any).fixtureBot.modelSelection)).toEqual(before);
 expect(await page.evaluate(()=>(window as any).fixtureActions)).toEqual([]);
 expect(refreshIds).toEqual(['account-one']);
 await expect(page.getByText('Price unavailable',{exact:true}).first()).toBeVisible();
 await expect(page.getByText('Excluded image',{exact:true})).toHaveCount(0);await expect(page.getByText('GPT-6 Astra',{exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath('refreshed-models.png')});
 fail=true;await page.getByRole('button',{name:'Refresh models',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Fixture catalog unavailable');
 await expect(page.getByRole('dialog').getByRole('button',{name:/^Provider discovered/})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).fixtureBot.modelSelection)).toEqual(before);
});
