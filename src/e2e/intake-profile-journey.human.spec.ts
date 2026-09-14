import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
let fixture:VerificationServer,vite:ViteDevServer,origin:string,headers:Record<string,string>,chiefId:string;
let seeded:{id:string;threadId:string;chiefOfStaff?:boolean};
const root=fileURLToPath(new URL("../../",import.meta.url));
async function api(method:string,path:string,body?:unknown){const response=await fetch(fixture.info.url+path,{method,headers:{...headers,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();expect(response.ok,JSON.stringify({path,status:response.status,data})).toBe(true);return data;}
test.beforeAll(async()=>{
  fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`const fetchOriginal=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('External network disabled in intake journey');return fetchOriginal(input,init);};`});
  headers={"x-murage-surface":"desktop","x-murage-surface-secret":(await api("GET","/api/desktop-secret")).secret};
  const initialRoster=(await api("GET","/api/bots")).bots;expect(initialRoster).toHaveLength(1);const initial=initialRoster[0];seeded={id:initial.id,threadId:initial.threadId,chiefOfStaff:initial.chiefOfStaff};
  await api("PATCH",`/api/bots/${initial.id}`,{name:"Fixture Chief",chiefOfStaff:true,chiefScope:"workspace",computer:"off",browser:false});chiefId=initial.id;
  const catalog=(await api("GET","/api/team-library/catalog")).teams;const cowork=catalog.find((entry:any)=>entry.slug==="cowork");expect(cowork).toMatchObject({members:1,adaptable:true,profileReviewHash:expect.stringMatching(/^[a-f0-9]{64}$/)});expect(cowork.playbooks.length).toBeGreaterThan(0);
  vite=await createServer({configFile:false,envFile:false,root,cacheDir:join(fixture.info.dataDir,"intake-vite"),resolve:{alias:{"@":join(root,"src")}},plugins:[react(),tailwindcss()],server:{host:"127.0.0.1",watch:null,hmr:false,proxy:{"/api":{target:fixture.info.url}}}});
  await vite.listen(0);const address=vite.httpServer!.address();if(!address||typeof address==="string")throw Error("No fixture port");origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{try{await vite?.close();}finally{await fixture?.close();}if(fixture)expect(existsSync(fixture.info.dataDir)).toBe(false);});
test.beforeEach(async({page})=>{await page.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());});

test("seeded first entry stays chat-led and server restart does not create another bot",async({page},info)=>{
  expect(seeded.chiefOfStaff).not.toBe(true);
  await page.addInitScript(()=>{localStorage.removeItem("murage-email-gate");localStorage.setItem("murage-flux-invite-dismissed","1");});
  await page.setViewportSize({width:1440,height:1000});await page.goto(origin);
  await expect(page.getByRole("textbox",{name:"Message Fixture Chief",exact:true})).toBeVisible();
  await expect(page.getByRole("main",{name:"Set up your workspace",exact:true})).toHaveCount(0);await expect(page.getByLabel("Choose your first outcome",{exact:true})).toHaveCount(0);
  await expect(page.getByTestId("chat-scroll").getByText("What do you actually want me for?",{exact:true})).toBeVisible();
  const before=(await api("GET","/api/bots")).bots;await fixture.restart();headers={"x-murage-surface":"desktop","x-murage-surface-secret":(await api("GET","/api/desktop-secret")).secret};
  await page.reload();await expect(page.getByRole("textbox",{name:"Message Fixture Chief",exact:true})).toBeVisible();
  const after=(await api("GET","/api/bots")).bots;expect(after.map((bot:any)=>({id:bot.id,threadId:bot.threadId}))).toEqual(before.map((bot:any)=>({id:bot.id,threadId:bot.threadId})));expect(after[0]).toMatchObject({id:seeded.id,threadId:seeded.threadId});
  expect(existsSync(fixture.fixtureDumpPath)).toBe(false);await page.screenshot({path:info.outputPath("seeded-chat-after-restart.png"),fullPage:true});
});

test("companion surface renders profile guidance without desktop installation actions",async({page},info)=>{
  const bot=(await api("POST","/api/bots",{name:"Companion helper"})).bot;
  for(const text of ["I want cowork","That's about right"]){const messages=(await api("GET",`/api/threads/${bot.threadId}/messages?limit=200`)).messages;const question=messages.findLast((m:any)=>m.card?.intake&&m.card.answered===undefined&&!m.card.dismissed);expect(question).toBeTruthy();await api("POST",`/api/bots/${bot.id}/intake`,{messageId:question.id,text});}
  await page.route("**/api/config",async route=>{const response=await route.fetch();const data=await response.json();await route.fulfill({json:{...data,surface:"remote"}});});
  const writes:string[]=[];page.on("request",request=>{if(request.method()!=="GET"&&/\/api\/bots\/[^/]+\/(assistant-profile|skills)/.test(request.url()))writes.push(request.url());});
  await page.setViewportSize({width:1440,height:1000});await page.goto(origin);await expect(page.getByText("Companion helper",{exact:true}).first()).toBeVisible();await page.getByText("Companion helper",{exact:true}).first().click();
  await expect(page.getByRole("textbox",{name:"Message Companion helper",exact:true})).toBeVisible();await expect(page.getByTestId("chat-scroll").getByText("Add this on your desktop",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Set that up",exact:true})).toHaveCount(0);expect(writes).toEqual([]);
  await expect(page.getByRole("main",{name:"Set up your workspace",exact:true})).toHaveCount(0);expect(existsSync(fixture.fixtureDumpPath)).toBe(false);await page.screenshot({path:info.outputPath("companion-profile-guidance.png"),fullPage:true});
});

test("Tango keeps its identity/history/Chief while conversationally adopting reviewed Cowork",async({page},info)=>{
  await page.addInitScript(()=>{localStorage.setItem("murage-email-gate","skipped");localStorage.setItem("murage-flux-invite-dismissed","1");});
  await page.setViewportSize({width:1440,height:1000});await page.goto(origin);
  await expect(page.getByRole("button",{name:"Open Fixture Chief's profile",exact:true}).first()).toBeVisible();
  const beforeRoster=(await api("GET","/api/bots")).bots;
  await page.getByRole("button",{name:"New or share",exact:true}).click();await page.getByRole("button",{name:"Blank Bot",exact:true}).click();
  await expect.poll(async()=>(await api("GET","/api/bots")).bots.length).toBe(beforeRoster.length+1);
  const target=(await api("GET","/api/bots")).bots.find((bot:any)=>!beforeRoster.some((old:any)=>old.id===bot.id));
  await api("PATCH",`/api/bots/${target.id}`,{name:"Tango",computer:"off",browser:false,composio:false});
  const composer=page.getByRole("textbox",{name:"Message Tango",exact:true});await expect(composer).toBeVisible();
  await expect(page.getByTestId("chat-scroll").getByText("What do you actually want me for?",{exact:true})).toBeVisible();
  await composer.fill("I want cowork");await composer.press("Enter");
  const current=async()=>(await api("GET","/api/bots")).bots.find((bot:any)=>bot.id===target.id);
  await expect.poll(async()=>(await current()).messages.findLast((message:any)=>message.card?.intake&&!message.card.answered)?.card.intake.step).toBe("narrow");
  const narrow=(await current()).messages.findLast((message:any)=>message.card?.intake&&!message.card.answered).card;
  expect(narrow.intake).toMatchObject({asked:2,candidate:{slug:"cowork"}});
  await composer.fill("That's about right");await composer.press("Enter");
  await expect(page.getByRole("button",{name:"Set that up",exact:true})).toBeVisible();
  const before=await current();const confirm=before.messages.findLast((message:any)=>message.card?.intake&&!message.card.answered).card;
  const catalog=(await api("GET","/api/team-library/catalog")).teams.find((entry:any)=>entry.slug==="cowork");
  expect(confirm.intake).toMatchObject({step:"confirm",asked:2,outcome:"profile",candidate:{slug:"cowork",profileReviewHash:catalog.profileReviewHash}});
  expect(before.messages.filter((message:any)=>message.card?.intake&&message.card.intake.step!=="confirm")).toHaveLength(2);
  const routinesBefore=await api("GET","/api/routines");
  await page.screenshot({path:info.outputPath("tango-reviewed-cowork.png"),fullPage:true});
  const applied=page.waitForResponse(response=>response.url().endsWith(`/api/bots/${target.id}/assistant-profile`)&&response.request().method()==="POST");
  await page.getByRole("button",{name:"Set that up",exact:true}).click();const response=await applied;
  expect(response.request().postDataJSON()).toEqual({slug:"cowork",rename:false,profileReviewHash:catalog.profileReviewHash});expect(response.ok()).toBe(true);
  await expect(page.getByTestId("chat-scroll").getByText("Right, I'm Cowork now. Ask me for something.",{exact:true})).toBeVisible();
  const after=await current();
  for(const key of ["id","name","threadId","chiefOfStaff","chiefScope","modelSelection","composio","computer","browser","autoApprove","alwaysAllow"])expect(after[key],key).toEqual(before[key]);
  for(const message of before.messages)expect(after.messages.some((next:any)=>next.id===message.id)).toBe(true);
  const source=JSON.parse(readFileSync(join(root,"bot-library/builtins/cowork.json"),"utf8")).package;
  for(const key of source.agents[0].playbooks){const expected=source.playbooks.find((book:any)=>book.key===key);expect(after.playbooks.find((book:any)=>book.key===key)).toEqual(expected);}
  expect((await api("GET","/api/bots")).bots.find((bot:any)=>bot.id===chiefId)).toMatchObject({chiefOfStaff:true,chiefScope:"workspace"});
  expect((await api("GET","/api/bots")).bots).toHaveLength(beforeRoster.length+1);expect(await api("GET","/api/routines")).toEqual(routinesBefore);
  expect(existsSync(join(fixture.info.dataDir,"fake-claude-dump.json"))).toBe(false);
  await page.screenshot({path:info.outputPath("tango-adapted-cowork.png"),fullPage:true});
});
