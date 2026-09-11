import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
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
        const dispatch=action=>{if(action.type==='fixtureRoster'){state.bots=action.bots;state.groups=action.groups;}if(action.type==='botPatched')state.bots=state.bots.map(bot=>bot.id===action.bot.id?action.bot:bot);if(action.type==='select')state.selectedId=action.id;window.fixtureStore={state:{...state},dispatch};listeners.forEach(fn=>fn());};dispatch({});
        createRoot(document.getElementById('root')).render(React.createElement(Sidebar,{open:true,onClose:()=>{}}));`;
    },configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/__hide')return next();res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root" style="height:100dvh"></div><script type="module" src="/__hide.js"></script></body></html>');});},
  }]});await server.listen(0);const address=server.httpServer!.address();if(!address||typeof address==='string')throw new Error('No fixture port');origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await server?.close();safeWipeSync(cache);});
test('sidebar roster readability',async({page},testInfo)=>{
  test.setTimeout(60000);
  await page.setViewportSize({width:1280,height:900});
  await page.addInitScript(()=>localStorage.setItem('murage.sidebarDensity','comfortable'));
  await page.route('**/api/config',route=>route.fulfill({json:{features:{}}}));
  await page.route('**/api/desktop-secret',route=>route.fulfill({json:{secret:'fixture-secret'}}));
  await page.goto(`${origin}/__hide`);
  await page.evaluate(()=>document.fonts.ready);
  expect(await page.evaluate(()=>document.compatMode)).toBe('CSS1Compat');
  await expect(page.getByRole('complementary',{name:'Bots and navigation'})).toHaveCSS('width','320px');
  // A mobile/touch project stays hover:none when its viewport is widened.
  // The production row deliberately reserves its touch controls in that case.
  const canHover=await page.evaluate(()=>matchMedia('(hover: hover)').matches);
  await expect(page.getByText('Fixture Chief',{exact:true})).toBeVisible();
  await page.evaluate(()=>{
    const fixture=(window as any).fixtureStore;
    const base=(window as any).fixtureBot;
    fixture.state.bots=[base,{...base,id:'lead',name:'Research Director',chiefScope:undefined,section:'Research'},
      {...base,id:'analyst',name:'Market Research Analyst',chiefOfStaff:false,chiefScope:undefined,section:'Research',unread:true}];
    fixture.state.groups=[{id:'room',name:'Research planning',memberIds:['lead','analyst'],messages:[],createdAt:Date.now(),unread:true}];
    fixture.dispatch({type:'fixtureRoster',bots:fixture.state.bots,groups:fixture.state.groups});
  });
  await expect(page.getByText('Market Research Analyst',{exact:true})).toBeVisible();
  await page.mouse.move(1200,850);
  await page.screenshot({path:testInfo.outputPath(process.env.SIDEBAR_BASELINE ? 'sidebar-before.png' : 'sidebar-after.png')});
  if(process.env.SIDEBAR_BASELINE)return;
  const row=page.locator('div[role="button"]').filter({has:page.getByText('Market Research Analyst',{exact:true})});
  await expect(row).toHaveCSS('padding-right',canHover?'12px':'84px');
  const name=page.getByText('Market Research Analyst',{exact:true});
  if(canHover){
    const metrics=await name.evaluate(element=>{const style=getComputedStyle(element);return {scrollWidth:element.scrollWidth,clientWidth:element.clientWidth,width:element.getBoundingClientRect().width,fontFamily:style.fontFamily,fontSize:style.fontSize,fontWeight:style.fontWeight};});
    await testInfo.attach('desktop-name-metrics',{body:JSON.stringify(metrics),contentType:'application/json'});
    // Keep the real desktop clipping gate; do not substitute a narrower font
    // or allow ellipsis merely because another platform's font is wider.
    expect(metrics.scrollWidth,JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth);
    await row.hover();
    await expect(row).toHaveCSS('padding-right','84px');
  }else{
    await expect(name).toHaveAttribute('aria-label','Rename Market Research Analyst');
  }
  await expect(page.getByRole('button',{name:'More actions for Market Research Analyst'})).toHaveCSS('opacity','1');
  await row.focus();
  await page.mouse.move(1200,850);
  await expect(row).toHaveCSS('padding-right','84px');
  await row.press('Shift+F10');
  await expect(page.getByRole('button',{name:'Hide from sidebar',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'More actions for Market Research Analyst'}).click();
  await expect(page.getByRole('button',{name:'Hide from sidebar',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Choose sidebar density'}).click();
  await page.getByRole('button',{name:'compact',exact:true}).click();
  await page.mouse.move(1200,850);
  await expect(row).toHaveCSS('padding-right',canHover?'8px':'84px');
  await page.screenshot({path:testInfo.outputPath('sidebar-compact.png')});
  await page.getByRole('button',{name:'Collapse sidebar to avatars'}).click();
  await expect(page.getByRole('button',{name:'Market Research Analyst',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Expand sidebar'}).click();
  await page.setViewportSize({width:390,height:844});
  await expect(row).toHaveCSS('padding-right','84px');
  await expect(page.getByRole('button',{name:'More actions for Market Research Analyst'})).toHaveCSS('opacity','1');
  await page.screenshot({path:testInfo.outputPath('sidebar-phone.png')});
});
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
