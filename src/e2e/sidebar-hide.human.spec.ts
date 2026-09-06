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
test.beforeAll(async()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));cache=mkdtempSync(join(tmpdir(),'murage-sidebar-hide-'));
  server=await createServer({configFile:false,root,cacheDir:cache,envFile:false,resolve:{alias:{'@':`${root}/src`}},server:{host:'127.0.0.1',watch:null,hmr:false},plugins:[tailwindcss(),{
    name:'sidebar-hide-fixture',enforce:'pre',resolveId(id){if(id.endsWith('/src/state/store')||id==='@/state/store')return '\0fixture-store';if(id==='/__hide.js')return '\0fixture-hide';},
    load(id){if(id==='\0fixture-store')return `export * from '/src/state/store.tsx?original';import {useSyncExternalStore} from 'react';export function useStore(){return useSyncExternalStore(window.subscribeFixture,()=>window.fixtureStore);}`;
      if(id!=='\0fixture-hide')return;return `import React from 'react';import {createRoot} from 'react-dom/client';import {initialState} from '/src/state/store.tsx?original';import {Sidebar} from '/src/components/Sidebar.tsx';import '/src/styles.css';
        const listeners=new Set();window.subscribeFixture=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
        window.fixtureBot={id:'chief',name:'Fixture Chief',chiefOfStaff:true,chiefScope:'workspace',color:'blue',threadId:'thread-chief',tasks:[],messages:[],modelSelection:{instanceId:'fixture',model:'test'},description:'',autoApprove:false};
        const state={...initialState,bots:[window.fixtureBot],selectedId:'chief',config:{features:{},box:{configured:false}},instances:[]};
        const dispatch=action=>{if(action.type==='botPatched')state.bots=state.bots.map(bot=>bot.id===action.bot.id?action.bot:bot);if(action.type==='select')state.selectedId=action.id;window.fixtureStore={state:{...state},dispatch};listeners.forEach(fn=>fn());};dispatch({});
        createRoot(document.getElementById('root')).render(React.createElement(Sidebar,{open:true,onClose:()=>{}}));`;
    },configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/__hide')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="height:100dvh"></div><script type="module" src="/__hide.js"></script>');});},
  }]});await server.listen(0);const address=server.httpServer!.address();if(!address||typeof address==='string')throw new Error('No fixture port');origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await server?.close();rmSync(cache,{recursive:true,force:true});});
test('hide and restore the last Chief without archiving or changing the selected conversation',async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});
  await page.route('**/api/config',route=>route.fulfill({json:{features:{}}}));
  await page.route('**/api/desktop-secret',route=>route.fulfill({json:{secret:'fixture-secret'}}));
  const patches:unknown[]=[];
  await page.route('**/api/bots/chief',async route=>{const patch=route.request().postDataJSON();patches.push(patch);const bot=await page.evaluate(()=>(window as any).fixtureBot);await route.fulfill({json:{bot:{...bot,...patch}}});});
  await page.goto(`${origin}/__hide`);
  await expect(page.getByText('Chief of Staff',{exact:true})).toBeVisible();
  await page.getByText('Fixture Chief',{exact:true}).click({button:'right'});
  await expect(page.getByRole('button',{name:'Archive',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Hide from sidebar',exact:true}).click();
  await expect(page.getByRole('button',{name:'Show hidden (1)',exact:true})).toBeVisible();
  expect(patches).toEqual([{sidebarHidden:true}]);
  expect(await page.evaluate(()=>(window as any).fixtureStore.state.selectedId)).toBe('chief');
  await page.getByRole('button',{name:'Show hidden (1)',exact:true}).click();
  await page.getByText('Fixture Chief',{exact:true}).click({button:'right'});
  await expect(page.getByRole('button',{name:'Archive',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Restore to sidebar',exact:true}).click();
  expect(patches).toEqual([{sidebarHidden:true},{sidebarHidden:false}]);
  await expect(page.getByRole('button',{name:/Show hidden|Hide hidden bots/})).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).fixtureStore.state.bots[0].chiefOfStaff)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('sidebar-restored-chief.png')});
});
