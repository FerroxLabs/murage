import { test,expect,type Page } from "@playwright/test";
import { createServer,type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launchVerificationServer,type VerificationServer } from "../../scripts/control-murage.ts";
import { openSidebar } from "./fixtures.ts";

let fixture:VerificationServer,vite:ViteDevServer,origin:string,headers:Record<string,string>={};
let botId:string,first:string,second:string,labelOne:string,labelTwo:string;
const api=async(method:string,path:string,body?:unknown)=>{
  const response=await fetch(`${fixture.info.url}${path}`,{method,headers:{...headers,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();expect(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(result)}`).toBe(true);return result as any;
};
const state=async()=> (await api("GET","/api/bots?messages=0")).bots.find((bot:any)=>bot.id===botId);
test.beforeAll(async()=>{
  fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
    const fs=await import('node:fs');const path=await import('node:path');const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');
    const cfg=JSON.parse(fs.readFileSync(file,'utf8'));cfg.instances.second={...cfg.instances.verification,displayName:'Second fixture account'};fs.writeFileSync(file,JSON.stringify(cfg));
  `});
  const proof=await api("GET","/api/desktop-secret");headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.secret};
  const engines=(await api("GET","/api/instances")).instances,models=engines.find((engine:any)=>engine.instanceId==="verification").models.options;
  labelOne=models[0].label;labelTwo=models[1].label;
  const bot=(await api("POST","/api/bots",{name:"Threads UI fixture",modelSelection:{instanceId:"verification",model:models[0].id}})).bot;
  botId=bot.id;
  await api("PATCH",`/api/bots/${botId}`,{computer:"off",browser:false,composio:false});
  // Independent provider turns begin in two new empty tasks. Preserve the
  // original greeting/intake thread and verify the actual send precondition.
  first=(await api("POST",`/api/bots/${botId}/tasks`,{title:"First thread"})).task.threadId;
  second=(await api("POST",`/api/bots/${botId}/tasks`,{title:"Second thread"})).task.threadId;
  for(const threadId of [first,second])expect((await api("GET",`/api/threads/${threadId}/messages?limit=10`)).messages).toEqual([]);
  await api("PATCH",`/api/bots/${botId}/tasks/${second}`,{modelSelection:{instanceId:"second",model:models[1].id},autoApprove:true});
  const root=fileURLToPath(new URL("../../",import.meta.url));
  vite=await createServer({configFile:false,root,envFile:false,cacheDir:join(fixture.info.dataDir,"vite-cache"),resolve:{alias:{"@":join(root,"src")}},plugins:[react(),tailwindcss()],server:{host:"127.0.0.1",port:0,watch:null,hmr:false,proxy:{"/api":{target:fixture.info.url}}}});
  await vite.listen(0);const address=vite.httpServer!.address();if(!address||typeof address==="string")throw Error("No fixture UI port");origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{try{await vite?.close();}finally{await fixture?.close();}});
async function choose(page:Page,title:string){
  await page.getByRole("button",{name:"All threads",exact:true}).click();
  await page.getByRole("button",{name:new RegExp(`^${title}`)}).click();
}
async function send(page:Page,text:string,threadId:string){
  const sent=page.waitForResponse(response=>response.url().endsWith(`/api/bots/${botId}/messages`)&&response.request().method()==="POST");
  await page.getByRole("textbox",{name:"Message Threads UI fixture",exact:true}).fill(text);
  await page.getByRole("textbox",{name:"Message Threads UI fixture",exact:true}).press("Enter");
  const response=await sent;expect(response.status()).toBe(202);expect(response.request().postDataJSON().threadId).toBe(threadId);
}
test("thread controls, sends, Stop and read state follow the visible conversation",async({page},info)=>{
  await page.addInitScript(()=>localStorage.setItem("murage-email-gate","skipped"));await page.goto(origin);
  const sidebar=await openSidebar(page);await sidebar.getByText("Threads UI fixture",{exact:true}).click();
  const invitation=page.getByRole("complementary",{name:"Let your bots pick the right model",exact:true});
  if(await invitation.count())await invitation.getByRole("button",{name:"Not now",exact:true}).last().click();
  await choose(page,"First thread");
  const model=page.getByRole("button",{name:/^Thread model:/});
  await expect(model).toHaveAttribute("aria-label",`Thread model: ${labelOne}`);
  await model.click();await page.getByRole("combobox",{name:"Thread effort",exact:true}).selectOption("high");await page.keyboard.press("Escape");
  await expect(model).toHaveAttribute("aria-label",`Thread model: ${labelOne} · high effort`);
  await expect(page.getByRole("button",{name:"Ask for approval",exact:true})).toBeVisible();
  await send(page,"__fixture_hold_authority__ first UI conversation",first);
  await expect.poll(async()=>(await state()).tasks.find((task:any)=>task.threadId===first).busy).toBe(true);
  await choose(page,"Second thread");
  await expect(model).toHaveAttribute("aria-label",`Thread model: ${labelTwo}`);
  await expect(page.getByRole("button",{name:"Auto mode",exact:true})).toBeVisible();
  await send(page,"__fixture_hold_authority__ second UI conversation",second);
  await expect.poll(async()=>(await state()).tasks.filter((task:any)=>task.busy).length).toBe(2);
  // A busy-thread send may use native steering or the server queue. Its
  // destination must remain explicit in either supported path.
  await send(page,"A follow-up for the second thread only",second);
  await api("PATCH",`/api/bots/${botId}/tasks/${first}`,{unread:true});
  await expect.poll(async()=>(await state()).tasks.find((task:any)=>task.threadId===first).unread).toBe(true);
  await choose(page,"First thread");
  await expect(model).toHaveAttribute("aria-label",`Thread model: ${labelOne} · high effort`);
  await expect.poll(async()=>(await state()).tasks.find((task:any)=>task.threadId===first).unread).toBe(false);
  await api("PATCH",`/api/bots/${botId}/tasks/${second}`,{unread:true});
  const stop=page.waitForResponse(response=>response.url().endsWith(`/api/bots/${botId}/interrupt`));
  await page.getByLabel("Stop this turn",{exact:true}).click();
  const stopped=await stop;expect(stopped.status()).toBe(200);expect(stopped.request().postDataJSON().threadId).toBe(first);
  await expect.poll(async()=>(await state()).tasks.find((task:any)=>task.threadId===first).busy).toBe(false);
  const snapshot=await state();expect(snapshot.tasks.find((task:any)=>task.threadId===second)).toMatchObject({busy:true,unread:true});
  await expect(model).toBeEnabled();await expect(page.getByRole("button",{name:"Stop this turn",exact:true})).toHaveCount(0);
  for(const skin of ["light","dark"]){await page.evaluate(skin=>{document.documentElement.dataset.skin=skin;},skin);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:info.outputPath(`independent-${skin}-${info.project.name}.png`)});}
  await choose(page,"Second thread");await expect(model).toHaveAttribute("aria-label",`Thread model: ${labelTwo}`);await expect(page.getByRole("button",{name:"Auto mode",exact:true})).toBeVisible();
  await page.getByLabel("Stop this turn",{exact:true}).click();
  await expect.poll(async()=>(await state()).tasks.some((task:any)=>task.busy)).toBe(false);
});
