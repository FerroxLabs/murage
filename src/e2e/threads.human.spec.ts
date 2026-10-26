import { test,expect,type Page } from "./page-error-guard";
import { createServer,type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launchVerificationServer,type VerificationServer } from "../../scripts/control-murage.ts";
import { openSidebar, SEND_KEY } from "./fixtures.ts";
import { expectApprovalLevel, openThreadModel, threadModelTrigger } from "./chat-controls.ts";

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
  await page.getByRole("button",{name:"Chat list",exact:true}).click();
  await page.getByRole("button",{name:new RegExp(`^${title}`)}).click();
  // The list dismisses itself a beat after a pick (TASK_PICKER_DISMISS_MS). A
  // click on "Chat list" inside that beat closes it instead of opening it.
  await expect(page.locator("[data-task-nav]")).toHaveCount(0);
}
// The header and the composer both offer Stop for the visible conversation;
// the header's (titled "Stop this turn", the composer's is titled "Stop") is
// the thread control this spec follows.
const headerStop=(page:Page)=>page.getByTitle("Stop this turn",{exact:true});
async function send(page:Page,text:string,threadId:string){
  const sent=page.waitForResponse(response=>response.url().endsWith(`/api/bots/${botId}/messages`)&&response.request().method()==="POST");
  await page.getByRole("textbox",{name:"Message Threads UI fixture",exact:true}).fill(text);
  await page.getByRole("textbox",{name:"Message Threads UI fixture",exact:true}).press(SEND_KEY);
  const response=await sent;expect(response.status()).toBe(202);expect(response.request().postDataJSON().threadId).toBe(threadId);
}
// 1.0.4 SL-K K1 (server/store.ts createTask): a new chat is born following its
// bot's model, even when it is opened from a chat with a pick of its own.
test("New task follows the bot's model after click and reload, even from a chat with its own pick",async({page},info)=>{
  await page.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const before=await state();
  const selection={...before.tasks.find((task:any)=>task.threadId===second).modelSelection,effort:"high"};
  await api("PATCH",`/api/bots/${botId}/tasks/${second}`,{modelSelection:selection});
  await page.addInitScript(()=>localStorage.setItem("murage-email-gate","skipped"));await page.goto(origin);
  const sidebar=await openSidebar(page);await sidebar.getByText("Threads UI fixture",{exact:true}).click();
  const invitation=page.getByRole("complementary",{name:"Let your bots pick the right model",exact:true});
  if(await invitation.count())await invitation.getByRole("button",{name:"Not now",exact:true}).last().click();
  await choose(page,"Second thread");
  await page.keyboard.press("Escape");
  // The chip on a wide screen; a phone's picker trigger is not drawn, and its label still names the thread's model.
  const model=await threadModelTrigger(page);
  const expectedLabel=`Thread model: ${labelTwo} · high effort`;
  const followLabel=`Thread model: ${labelOne}`;
  await expect(model).toHaveAttribute("aria-label",expectedLabel);
  await expect.poll(async()=>(await state()).threadId).toBe(second);
  const created=page.waitForResponse(response=>response.url().endsWith(`/api/bots/${botId}/tasks`)&&response.request().method()==="POST");
  await page.getByRole("button",{name:"Chat list",exact:true}).click();
  // Chats slice 1 (CHATS-FINDABILITY-DESIGN section 7, commit 2f4985767) puts a "+" New chat
  // beside the header chip as well; it has no text of its own. This test opens
  // the chat from the list's own New chat row, the one with words.
  await page.getByRole("button",{name:"New chat",exact:true}).filter({hasText:"New chat"}).click();
  const response=await created;expect(response.status()).toBe(201);
  const result=await response.json(),threadId=result.task.threadId;
  // The stored title keeps its internal name; the chip shows the UI noun
  // (CHATS-FINDABILITY-DESIGN section 2.6, src/lib/all-chats.ts chatTitle).
  expect(result.task.title).toBe("New task");
  const shownTitle="New chat";
  expect(before.tasks.some((task:any)=>task.threadId===threadId)).toBe(false);
  expect(result.task.modelSelection).toBeUndefined();
  const readback=await state();
  expect(readback.threadId).toBe(threadId);
  expect(readback.tasks).toHaveLength(before.tasks.length+1);
  expect(readback.tasks.find((task:any)=>task.threadId===threadId).modelSelection).toBeUndefined();
  // The chat it was opened from keeps its own pick.
  expect(readback.tasks.find((task:any)=>task.threadId===second).modelSelection).toEqual(selection);
  expect((await api("GET",`/api/threads/${threadId}/messages?limit=10`)).messages).toEqual([]);
  await expect(model).toHaveAttribute("aria-label",followLabel);
  const tasks=page.getByRole("button",{name:"Chat list",exact:true});
  await expect(tasks).toContainText(shownTitle);
  await expect(tasks).toContainText(String(before.tasks.length+1));
  await page.reload();
  // A reload lands on the Chief (store.tsx hydrate: nothing in the page keeps
  // the selection); coming back to the bot must find the new task still open
  // and still following the bot.
  await (await openSidebar(page)).getByText("Threads UI fixture",{exact:true}).click();
  await expect(model).toHaveAttribute("aria-label",followLabel);
  await expect(tasks).toContainText(shownTitle);
  expect((await state()).threadId).toBe(threadId);
  await info.attach("new-task-readback",{body:JSON.stringify({threadId,selection,taskCount:readback.tasks.length}),contentType:"application/json"});
  await page.screenshot({path:info.outputPath("new-task-selection-desktop.png")});
});
test("thread controls, sends, Stop and read state follow the visible conversation",async({page},info)=>{
  // The fixture is shared: the New task test (or a retry of this one) leaves
  // an effort on the threads. This test starts both from their plain model.
  for(const threadId of [first,second]){
    // A chat with no pick of its own follows the bot (1.0.4 SL-K K1): nothing to strip.
    const own=(await state()).tasks.find((task:any)=>task.threadId===threadId).modelSelection;
    if(!own)continue;
    const {effort:_effort,...plain}=own;
    await api("PATCH",`/api/bots/${botId}/tasks/${threadId}`,{modelSelection:plain});
  }
  await page.addInitScript(()=>localStorage.setItem("murage-email-gate","skipped"));await page.goto(origin);
  const sidebar=await openSidebar(page);await sidebar.getByText("Threads UI fixture",{exact:true}).click();
  const invitation=page.getByRole("complementary",{name:"Let your bots pick the right model",exact:true});
  if(await invitation.count())await invitation.getByRole("button",{name:"Not now",exact:true}).last().click();
  await choose(page,"First thread");
  // The chip on a wide screen; a phone's picker trigger is not drawn, and its label still names the thread's model.
  const model=await threadModelTrigger(page);
  await expect(model).toHaveAttribute("aria-label",`Thread model: ${labelOne}`);
  await openThreadModel(page);await page.getByRole("combobox",{name:"Thread effort",exact:true}).selectOption("high");await page.keyboard.press("Escape");
  await expect(model).toHaveAttribute("aria-label",`Thread model: ${labelOne} · high effort`);
  await expectApprovalLevel(page,"Ask for approval","Ask");
  await send(page,"__fixture_hold_authority__ first UI conversation",first);
  await expect.poll(async()=>(await state()).tasks.find((task:any)=>task.threadId===first).busy).toBe(true);
  await choose(page,"Second thread");
  await expect(model).toHaveAttribute("aria-label",`Thread model: ${labelTwo}`);
  await expectApprovalLevel(page,"Auto mode","Auto");
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
  await headerStop(page).click();
  const stopped=await stop;expect(stopped.status()).toBe(200);expect(stopped.request().postDataJSON().threadId).toBe(first);
  await expect.poll(async()=>(await state()).tasks.find((task:any)=>task.threadId===first).busy).toBe(false);
  const snapshot=await state();expect(snapshot.tasks.find((task:any)=>task.threadId===second)).toMatchObject({busy:true,unread:true});
  await expect(model).toBeEnabled();await expect(page.getByRole("button",{name:"Stop this turn",exact:true})).toHaveCount(0);
  for(const skin of ["light","dark"]){await page.evaluate(skin=>{document.documentElement.dataset.skin=skin;},skin);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:info.outputPath(`independent-${skin}-${info.project.name}.png`)});}
  await choose(page,"Second thread");await expect(model).toHaveAttribute("aria-label",`Thread model: ${labelTwo}`);await expectApprovalLevel(page,"Auto mode","Auto");
  await headerStop(page).click();
  await expect.poll(async()=>(await state()).tasks.some((task:any)=>task.busy)).toBe(false);
});
