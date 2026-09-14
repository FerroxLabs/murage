// Real StoreProvider + live-events + notification delivery, fake SSE/native bridge.
// No app profile, OS notifications, audio, or provider calls.
import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
let vite: ViteDevServer, cache: string, origin: string;
test.beforeAll(async()=>{
  cache=mkdtempSync(join(tmpdir(),"murage-approval-alerts-evidence-"));
  const root=fileURLToPath(new URL("../../",import.meta.url));
  vite=await createServer({configFile:false,envFile:false,root,cacheDir:cache,resolve:{alias:{"@":join(root,"src")}},server:{host:"127.0.0.1",watch:null,hmr:false},plugins:[react(),{
    name:"approval-alert-fixture",
    resolveId(id){if(id==="/__approval.js")return "\0approval-fixture";},
    load(id){if(id!=="\0approval-fixture")return;return `import React from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider,useStore} from '/src/state/store.tsx';
function View(){const {state,dispatch}=useStore();window.fixtureState=state;return React.createElement('main',null,React.createElement('button',{onClick:()=>dispatch({type:'toggleInspector'})},'Focus and redraw'),React.createElement('pre',{'data-testid':'selected'},state.selectedId));}
createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,React.createElement(View)));`;},
    configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=="/__approval")return next();res.setHeader("content-type","text/html");res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__approval.js"></script>');});},
  }]});
  await vite.listen(0);const address=vite.httpServer!.address();if(!address||typeof address==="string")throw Error("Missing fixture port");origin=`http://127.0.0.1:${address.port}`;
  console.info("Approval fake-bridge fixture",JSON.stringify({origin,cache}));
});
test.afterAll(async()=>{await vite?.close();safeWipeSync(cache);console.info("Approval fake-bridge fixture closed",origin);});

test("fresh approvals cue once; replay and redraw stay quiet; native click opens the exact task",async({page})=>{
  const base={name:"Fixture",color:"blue",description:"",messages:[],modelSelection:{instanceId:"fake",model:"fake"},notifications:true,speakReplies:false,busy:false};
  const bots=[{...base,id:"a",threadId:"a-task",tasks:[{threadId:"a-task",title:"A"}]},{...base,id:"b",threadId:"b-task",tasks:[{threadId:"b-task",title:"B"},{threadId:"b-detached",title:"Detached"}]}];
  const writes:string[]=[];
  await page.route("**/api/**",async route=>{
    const path=new URL(route.request().url()).pathname;
    if(route.request().method()!=="GET")writes.push(path);
    const json=path==="/api/bots"?{bots,groups:[],computerControl:{}}:path==="/api/instances"?{instances:[]}:path==="/api/config"?{}:path==="/api/routines"?{routines:[],runs:[]}:path==="/api/webhooks"?{webhooks:[],attempts:[]}:path==="/api/bots/b/tasks/b-detached"?{bot:{...bots[1],threadId:"b-detached"}}:{};
    return route.fulfill({json});
  });
  await page.addInitScript(()=>{
    const w=window as any;w.nativeCalls=[];w.webCalls=[];w.sources=[];w.permission="granted";w.nextHello={kind:"hello",cursor:"fixture:0",resumed:false};
    Object.defineProperty(window,"Notification",{configurable:true,value:class{static get permission(){return w.permission;}constructor(title:string,options:unknown){w.webCalls.push({title,options});}}});
    Object.defineProperty(window,"muragebox",{configurable:true,value:{platform:"darwin",desktopSurfaceSecret:"fake-proof",approvalNotifications:{show:async(payload:unknown)=>{w.nativeCalls.push(payload);return{accepted:true};},onOpen:(cb:unknown)=>{w.nativeClick=cb;return()=>{w.nativeClick=null;};}}}});
    Object.defineProperty(window,"EventSource",{configurable:true,value:class{
      onopen:any;onerror:any;onmessage:any;closed=false;
      constructor(){w.sources.push(this);const hello=w.nextHello;setTimeout(()=>{this.onopen?.();this.onmessage?.({data:JSON.stringify(hello)});},0);}
      close(){this.closed=true;}
    }});
    w.emit=(frame:unknown,id:string)=>w.sources.at(-1).onmessage?.({data:JSON.stringify(frame),lastEventId:id});
  });
  await page.goto(origin+"/__approval");
  await expect(page.getByTestId("selected")).toHaveText("a");
  await page.getByRole("button",{name:"Focus and redraw"}).click();
  expect(await page.evaluate(()=>document.hasFocus())).toBe(true);
  const approval={kind:"approval",botId:"a",threadId:"a-task",requestId:"one",messageId:"card-one",title:"Murage",body:"Your attention is needed.",privatePreview:true};
  await page.evaluate(frame=>(window as any).emit({kind:"notify",notification:frame},"fixture:1"),approval);
  await expect.poll(()=>page.evaluate(()=>(window as any).nativeCalls.length)).toBe(1);
  await page.evaluate(frame=>(window as any).emit({kind:"notify",notification:frame},"fixture:2"),approval);
  await page.getByRole("button",{name:"Focus and redraw"}).click();
  expect(await page.evaluate(()=>(window as any).nativeCalls.length)).toBe(1);
  await page.evaluate(()=>{const w=window as any;w.nextHello={kind:"hello",cursor:"fixture:9",resumed:true};w.sources.at(-1).onerror();});
  await expect.poll(()=>page.evaluate(()=>(window as any).sources.length)).toBe(2);
  await page.evaluate(frame=>{
    const w=window as any;
    w.emit({kind:"notify",notification:{...frame,requestId:"unseen-old",messageId:"old-card"}},"fixture:5");
    w.emit({kind:"message",threadId:"a-task",message:{id:"replayed-message",role:"bot",kind:"text",text:"Replayed data retained",createdAt:1}},"fixture:9");
  },approval);
  await expect.poll(()=>page.evaluate(()=>(window as any).fixtureState.bots[0].messages.some((m:any)=>m.id==="replayed-message"))).toBe(true);
  expect(await page.evaluate(()=>(window as any).nativeCalls.length)).toBe(1);
  const detached={...approval,botId:"b",threadId:"b-detached",requestId:"two",messageId:"card-two"};
  await page.evaluate(frame=>(window as any).emit({kind:"notify",notification:frame},"fixture:10"),detached);
  await expect.poll(()=>page.evaluate(()=>(window as any).nativeCalls.length)).toBe(2);
  await page.evaluate(()=>{(window as any).nativeClick({botId:"b",threadId:"b-detached"});});
  await expect(page.getByTestId("selected")).toHaveText("b");
  await expect.poll(()=>page.evaluate(()=>(window as any).fixtureState.bots.find((b:any)=>b.id==="b").threadId)).toBe("b-detached");
  expect(writes).toContain("/api/bots/b/tasks/b-detached");
  expect(writes.some(path=>path.endsWith("/respond"))).toBe(false);
  await page.evaluate(frame=>{(window as any).permission="denied";(window as any).emit({kind:"notify",notification:{...frame,requestId:"denied",messageId:"denied-card"}},"fixture:11");},approval);
  expect(await page.evaluate(()=>(window as any).nativeCalls.length)).toBe(2);
  expect(await page.evaluate(()=>(window as any).webCalls.length)).toBe(0);
});
