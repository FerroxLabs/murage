// Real StoreProvider/reducer/Composer; fake SSE and API, no provider responses.
import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
let vite: ViteDevServer, cache: string, origin: string;
test.beforeAll(async () => {
  cache = mkdtempSync(join(tmpdir(), "murage-deletion-fixture-"));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  vite = await createServer({ configFile:false, envFile:false, root, cacheDir:cache, resolve:{alias:{"@":join(root,"src")}}, server:{host:"127.0.0.1",watch:null,hmr:false}, plugins:[react(),tailwindcss(),{
    name:"deletion-fixture", resolveId(id){if(id==="/__deletion.js")return "\0deletion-fixture";},
    load(id){if(id!=="\0deletion-fixture")return;return `import React from 'react';import{createRoot}from'react-dom/client';import{StoreProvider,useStore}from'/src/state/store.tsx';import{Composer}from'/src/components/Composer.tsx';import{DesktopCapabilitiesProvider}from'/src/components/DesktopCapabilities.tsx';import'/src/styles.css';
function View(){const{state,dispatch}=useStore();window.fixtureDispatch=dispatch;window.fixtureState=state;const bot=state.bots[0];return React.createElement('main',{style:{maxWidth:800,margin:'auto',padding:16}},React.createElement('h1',null,'Deletion continuity fixture'),bot&&React.createElement(React.Fragment,null,React.createElement('output',{'data-testid':'thread'},bot.threadId),React.createElement('section',{'data-testid':'transcript'},bot.messages.map(message=>React.createElement('p',{key:message.id},message.text||message.id))),React.createElement(Composer,{bot})));}createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,React.createElement(DesktopCapabilitiesProvider,null,React.createElement(View))));`;},
    configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=="/__deletion")return next();res.setHeader("content-type","text/html");res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__deletion.js"></script>');});},
  }]});
  await vite.listen(0);const address=vite.httpServer!.address();if(!address||typeof address==="string")throw Error("Missing fixture port");origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await vite?.close();safeWipeSync(cache);});

test("deleted approval is inert until replacement snapshot; late snapshots preserve navigation",async({page},testInfo)=>{
  const old={id:"old-approval",role:"bot",kind:"options",createdAt:1,card:{requestId:"old-request",tool:"Bash",title:"Run old command",subtitle:"Old command",options:["Allow","Deny"]}};
  const base={id:"bot",name:"Fixture",color:"blue",description:"",modelSelection:{instanceId:"fake",model:"fake"},notifications:false,busy:false,computer:"off",browser:false};
  const tasks=[{threadId:"a",title:"A",createdAt:1},{threadId:"b",title:"B",createdAt:2},{threadId:"c",title:"C",createdAt:3}];
  const initial={...base,threadId:"a",tasks,messages:[old],activeLeafId:old.id};
  const writes:string[]=[];
  await page.route("**/api/**",route=>{
    const path=new URL(route.request().url()).pathname;
    if(route.request().method()!=="GET")writes.push(path);
    const json=path==="/api/bots"?{bots:[initial],groups:[],computerControl:{}}:path==="/api/instances"?{instances:[]}:path==="/api/routines"?{routines:[],runs:[]}:path==="/api/webhooks"?{webhooks:[],attempts:[]}:{ };
    return route.fulfill({json});
  });
  await page.addInitScript(()=>{
    const w=window as any;w.sources=[];
    Object.defineProperty(window,"EventSource",{configurable:true,value:class{
      onopen:any;onmessage:any;constructor(){w.sources.push(this);setTimeout(()=>{this.onopen?.();this.onmessage?.({data:JSON.stringify({kind:"hello",cursor:"fixture:0",resumed:false})});},0);}close(){}
    }});
    w.emit=(frame:unknown)=>w.sources.at(-1).onmessage?.({data:JSON.stringify(frame)});
  });
  await page.goto(origin+"/__deletion");
  await expect(page.getByTestId("thread")).toHaveText("a");
  await expect(page.getByTestId("transcript")).toContainText("old-approval");
  const replacement={...base,threadId:"b",tasks:tasks.slice(1)};
  await page.evaluate(bot=>(window as any).emit({kind:"bot",bot}),replacement);
  await expect(page.getByTestId("thread")).toHaveText("b");
  await expect(page.getByTestId("transcript")).toBeEmpty();
  const composer=page.locator("textarea");
  await expect(composer).toBeDisabled();
  await expect(composer).toHaveAttribute("aria-busy","true");
  await page.evaluate(()=>{
    const dispatch=(window as any).fixtureDispatch;
    dispatch({type:"decideRequest",threadId:"a",requestId:"old-request",behavior:"allow"});
    dispatch({type:"send",botId:"bot",threadId:"b",text:"must not send"});
  });
  expect(writes.filter(path=>path.endsWith("/respond")||path.endsWith("/messages"))).toEqual([]);
  await page.screenshot({path:testInfo.outputPath("deletion-pending.png")});
  const message={id:"survivor",role:"bot",kind:"text",text:"Surviving transcript",createdAt:2};
  await page.evaluate(message=>(window as any).emit({kind:"message.patch",threadId:"b",message:{...message,text:"Newer live text"}}),message);
  await page.evaluate(bot=>(window as any).emit({kind:"bot",bot}),{...replacement,messages:[message],activeLeafId:message.id});
  await expect(composer).toBeEnabled();
  await expect(page.getByTestId("transcript")).toHaveText("Newer live text");
  await page.evaluate(bot=>(window as any).emit({kind:"bot",bot}),{...replacement,messages:[message],activeLeafId:message.id});
  await expect(page.getByTestId("transcript")).toHaveText("Newer live text");
  await composer.fill("Ready for the surviving conversation");
  await page.screenshot({path:testInfo.outputPath("deletion-restored.png")});
  await page.evaluate(bot=>(window as any).fixtureDispatch({type:"taskSwitched",bot}),{...replacement,threadId:"c",messages:[{...message,id:"third",text:"Third transcript"}]});
  await page.evaluate(bot=>(window as any).emit({kind:"bot",bot}),{...replacement,messages:[message],activeLeafId:message.id});
  await expect(page.getByTestId("thread")).toHaveText("c");
  await expect(page.getByTestId("transcript")).toHaveText("Third transcript");
  expect(writes.filter(path=>path.endsWith("/respond")||path.endsWith("/messages"))).toEqual([]);
});
