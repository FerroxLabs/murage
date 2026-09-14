import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
let vite:ViteDevServer,cache:string,origin:string;
test.beforeAll(async()=>{
  const root=fileURLToPath(new URL("../../",import.meta.url));cache=mkdtempSync(join(tmpdir(),"murage-catalog-ui-"));
  vite=await createServer({configFile:false,envFile:false,root,cacheDir:cache,resolve:{alias:{"@":join(root,"src")}},server:{host:"127.0.0.1",watch:null,hmr:false},plugins:[react(),tailwindcss(),{
    name:"catalog-ui-fixture",enforce:"pre",
    resolveId(id){if(id==="/__catalog.js")return "\0catalog-ui";if(id==="/__catalog-store"||id==="@/state/store"||/\/src\/state\/store(?:\.tsx?)?$/.test(id))return "\0catalog-store";},
    load(id){
      if(id==="\0catalog-store")return `import React from 'react';const Context=React.createContext(null);
const models=['flux-auto','flux-reasoning','flux-standard','flux-fast'].map(id=>({id,label:id==='flux-auto'?'Flux Auto':id}));
export function FixtureProvider({children}){const[bot,setBot]=React.useState({id:'fixture',threadId:'task',name:'Fixture',busy:false,messages:[],modelSelection:{instanceId:'claude',model:'flux-auto'}});const refreshInstances=React.useCallback(async()=>{},[]);const dispatch=action=>{window.fixtureActions??=[];window.fixtureActions.push(action);if(action.type==='setModel')setBot(current=>({...current,modelSelection:action.selection}));};return React.createElement(Context.Provider,{value:{bot,state:{instances:[{instanceId:'claude',driverKind:'claudeAgent',displayName:'Claude Code',enabled:true,snapshot:{state:'available',authenticated:true},models:{default:'flux-auto',options:models}}]},dispatch,refreshInstances}},children);}
export function useStore(){return React.useContext(Context);}export async function api(path,options){const response=await fetch(path,options);if(!response.ok)throw Error('Fixture catalog unavailable');return response.json();}`;
      if(id!=="\0catalog-ui")return;
      return `import React from 'react';import{createRoot}from'react-dom/client';import{FixtureProvider,useStore}from'/__catalog-store';import{ModelPicker}from'/src/components/ModelPicker.tsx';import'/src/styles.css';function View(){const{bot}=useStore();return React.createElement('main',{style:{maxWidth:500,margin:'40px auto',padding:20}},React.createElement('h1',null,'Flux catalog fixture'),React.createElement(ModelPicker,{bot,threadId:'task',contained:true}),React.createElement('output',{'data-testid':'selection'},JSON.stringify(bot.modelSelection)));}createRoot(document.getElementById('root')).render(React.createElement(FixtureProvider,null,React.createElement(View)));`;
    },
    configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=="/__catalog")return next();res.setHeader("content-type","text/html");res.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Catalog fixture</title></head><body><div id="root"></div><script type="module" src="/__catalog.js"></script></body></html>');});},
  }]});await vite.listen(0);const address=vite.httpServer!.address();if(!address||typeof address==="string")throw Error("No fixture port");origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await vite?.close();safeWipeSync(cache);});

test("cold Flux discovery reveals pinned chat with exact selection and preserves cache on failure",async({page},info)=>{
  const connection={id:"legacy-flux",preset:"flux",label:"Flux Router",enabled:true,configured:true,revision:"fixture-r1",baseUrl:"https://api.fluxrouter.ai/v1",protocol:"openai",state:"saved",catalog:{connectionId:"legacy-flux",models:[] as any[],stale:false,assurance:"catalog-only"}};
  let state:any=connection,refreshes=0,fail=false,release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  await page.route("**/api/provider-connections",route=>route.fulfill({json:{connections:[state]}}));
  await page.route("**/api/provider-connections/legacy-flux/refresh",async route=>{
    refreshes++;
    if(fail){state={...state,catalog:{...state.catalog,stale:true,error:{code:"offline",message:"Fixture offline"}}};return route.fulfill({json:state.catalog});}
    await pending;
    const row=(id:string,chat:boolean)=>({connectionId:"legacy-flux",preset:"flux",id,label:id,enabled:true,chatEligible:chat,capabilities:{chat},outputModalities:[chat?"text":"image"]});
    state={...state,state:"catalog-ready",catalog:{...state.catalog,fetchedAt:1000,models:[row("flux-pinned-fixture-chat",true),row("flux-image-fixture-media",false)]}};
    return route.fulfill({json:state.catalog});
  });
  await page.setViewportSize({width:820,height:900});await page.goto(origin+"/__catalog");
  const trigger=page.locator('button[aria-haspopup="dialog"]').first();await trigger.click();
  const menu=page.getByRole("dialog",{name:"Choose model"});
  await expect(menu.locator('[data-model-choice]').filter({hasText:"Flux Auto"})).toBeVisible();
  await expect.poll(()=>refreshes).toBe(1);await expect(menu.getByRole("button",{name:"Refresh models"})).toBeDisabled();
  release();
  const search=menu.getByRole("textbox",{name:"Search models"});await search.fill("flux-pinned-fixture-chat");
  const pinned=menu.locator('[data-model-choice]').filter({hasText:"flux-pinned-fixture-chat"});await expect(pinned).toBeVisible();
  await page.screenshot({path:info.outputPath("expanded-flux-catalog.png")});
  await pinned.click();await expect(page.getByTestId("selection")).toHaveText(JSON.stringify({instanceId:"claude",connectionId:"legacy-flux",model:"flux-pinned-fixture-chat"}));
  await trigger.click();await search.fill("flux-image-fixture-media");await expect(menu.locator('[data-model-choice]').filter({hasText:"flux-image-fixture-media"})).toHaveCount(0);await expect(menu.getByText("0 compatible chat models",{exact:false})).toBeVisible();
  await search.fill("flux-pinned-fixture-chat");fail=true;await menu.getByRole("button",{name:"Refresh models"}).click();
  await expect.poll(()=>refreshes).toBe(2);await expect(pinned).toBeVisible();
  await expect(menu.getByRole("alert")).toBeVisible();
  await page.keyboard.press("Escape");await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);
  await trigger.click();await search.fill("flux-pinned-fixture-chat");await expect(pinned).toBeVisible();await page.waitForLoadState("networkidle");
  expect(refreshes).toBe(2);await expect(page.getByTestId("selection")).toContainText('"connectionId":"legacy-flux"');
});
