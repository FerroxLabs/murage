import { test, expect } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
// The mobile project has a touch screen, where Return is a newline (composer-enter.ts).
import { SEND_KEY } from "./fixtures.ts";
let fixture:VerificationServer,vite:ViteDevServer,origin:string,headers:Record<string,string>,chiefId:string;
let seeded:{id:string;threadId:string;chiefOfStaff?:boolean};
const root=fileURLToPath(new URL("../../",import.meta.url));
// Every engine turn of this fixture answers with the next of these, in order, and is logged one line per launch
// (fixtureTurnLogPath), so the answer to each sentence is read from the turns and parent links, never guessed from
// a prompt (a fresh turn's prompt can replay the earlier sentence as history).
const REPLIES=["Reply one from fake claude","Reply two from fake claude"];
async function api(method:string,path:string,body?:unknown){const response=await fetch(fixture.info.url+path,{method,headers:{...headers,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();expect(response.ok,JSON.stringify({path,status:response.status,data})).toBe(true);return data;}
test.beforeAll(async()=>{
  fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`const fetchOriginal=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('External network disabled in intake journey');return fetchOriginal(input,init);};`,turnLog:{replies:REPLIES}});
  headers={"x-murage-surface":"desktop","x-murage-surface-secret":(await api("GET","/api/desktop-secret")).secret};
  // This harness reads as an update, so What's new would open over every test; a person sees it once.
  await api("POST","/api/whats-new/seen",{version:JSON.parse(readFileSync(join(root,"package.json"),"utf8")).version});
  const initialRoster=(await api("GET","/api/bots")).bots;expect(initialRoster).toHaveLength(1);const initial=initialRoster[0];seeded={id:initial.id,threadId:initial.threadId,chiefOfStaff:initial.chiefOfStaff};
  await api("PATCH",`/api/bots/${initial.id}`,{name:"Fixture Chief",chiefOfStaff:true,chiefScope:"workspace",computer:"off",browser:false});chiefId=initial.id;
  const catalog=(await api("GET","/api/team-library/catalog")).teams;const cowork=catalog.find((entry:any)=>entry.slug==="cowork");expect(cowork).toMatchObject({members:1,adaptable:true,profileReviewHash:expect.stringMatching(/^[a-f0-9]{64}$/)});expect(cowork.playbooks.length).toBeGreaterThan(0);
  vite=await createServer({configFile:false,envFile:false,root,cacheDir:join(fixture.info.dataDir,"intake-vite"),resolve:{alias:{"@":join(root,"src")}},plugins:[react(),tailwindcss()],server:{host:"127.0.0.1",watch:null,hmr:false,proxy:{"/api":{target:fixture.info.url}}}});
  await vite.listen(0);const address=vite.httpServer!.address();if(!address||typeof address==="string")throw Error("No fixture port");origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{try{await vite?.close();}finally{await fixture?.close();}if(fixture)expect(existsSync(fixture.info.dataDir)).toBe(false);});
test.beforeEach(async({page})=>{await page.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());});

test("a fresh install opens on the welcome screen despite the seeded bot, and a server restart does not create another bot",async({page},info)=>{
  expect(seeded.chiefOfStaff).not.toBe(true);
  await page.addInitScript(()=>{localStorage.removeItem("murage-email-gate");localStorage.setItem("murage-flux-invite-dismissed","1");});
  await page.setViewportSize({width:1440,height:1000});await page.goto(origin);
  // The only thing here is the untouched seeded bot, so this is a first run.
  // The first load compiles the app in this spec's own Vite server.
  // Since 0.1.58 (311387b1) the first run is the Chief's conversation, and it opens on his first question.
  await expect(page.getByText(/Where should I send your setup guide\?/i).first()).toBeVisible({timeout:60_000});
  const before=(await api("GET","/api/bots")).bots;await fixture.restart();headers={"x-murage-surface":"desktop","x-murage-surface-secret":(await api("GET","/api/desktop-secret")).secret};
  await page.reload();await expect(page.getByText(/Where should I send your setup guide\?/i).first()).toBeVisible({timeout:60_000});
  const after=(await api("GET","/api/bots")).bots;expect(after.map((bot:any)=>({id:bot.id,threadId:bot.threadId}))).toEqual(before.map((bot:any)=>({id:bot.id,threadId:bot.threadId})));expect(after[0]).toMatchObject({id:seeded.id,threadId:seeded.threadId});
  expect(existsSync(fixture.fixtureDumpPath)).toBe(false);await page.screenshot({path:info.outputPath("seeded-welcome-after-restart.png"),fullPage:true});
});

test("companion surface renders profile guidance without desktop installation actions",async({page},info)=>{
  const bot=(await api("POST","/api/bots",{name:"Companion helper"})).bot;
  for(const text of ["I want cowork","That's about right"]){const messages=(await api("GET",`/api/threads/${bot.threadId}/messages?limit=200`)).messages;const question=messages.findLast((m:any)=>m.card?.intake&&m.card.answered===undefined&&!m.card.dismissed);expect(question).toBeTruthy();await api("POST",`/api/bots/${bot.id}/intake`,{messageId:question.id,text});}
  await page.route("**/api/config",async route=>{const response=await route.fetch();const data=await response.json();await route.fulfill({json:{...data,surface:"remote"}});});
  const writes:string[]=[];page.on("request",request=>{if(request.method()!=="GET"&&/\/api\/bots\/[^/]+\/(assistant-profile|skills)/.test(request.url()))writes.push(request.url());});
  await page.setViewportSize({width:1440,height:1000});await page.goto(origin);await expect(page.getByText("Companion helper",{exact:true}).first()).toBeVisible();await page.getByText("Companion helper",{exact:true}).first().click();
  await expect(page.getByRole("textbox",{name:"Message Companion helper",exact:true})).toBeVisible();await expect(page.getByTestId("chat-scroll").getByText("Add this on your desktop",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Set that up",exact:true})).toHaveCount(0);expect(writes).toEqual([]);
  await expect(page.getByText(/Where should I send your setup guide\?/i)).toHaveCount(0);expect(existsSync(fixture.fixtureDumpPath)).toBe(false);await page.screenshot({path:info.outputPath("companion-profile-guidance.png"),fullPage:true});
});

test("Tango keeps its identity/history/Chief while conversationally adopting reviewed Cowork",async({page},info)=>{
  await page.addInitScript(()=>{localStorage.setItem("murage-email-gate","skipped");localStorage.setItem("murage-flux-invite-dismissed","1");});
  await page.setViewportSize({width:1440,height:1000});await page.goto(origin);
  await expect(page.getByRole("button",{name:"Open Fixture Chief's profile",exact:true}).first()).toBeVisible();
  const beforeRoster=(await api("GET","/api/bots")).bots;
  await page.getByRole("button",{name:"New or share",exact:true}).click();await page.getByRole("button",{name:"New Bot",exact:true}).click();
  // New Bot opens the chooser (2274a095); Start blank makes the plain bot.
  await page.getByRole("button",{name:"Start blank →",exact:true}).click();
  await expect.poll(async()=>(await api("GET","/api/bots")).bots.length).toBe(beforeRoster.length+1);
  const target=(await api("GET","/api/bots")).bots.find((bot:any)=>!beforeRoster.some((old:any)=>old.id===bot.id));
  await api("PATCH",`/api/bots/${target.id}`,{name:"Tango",computer:"off",browser:false,composio:false});
  const composer=page.getByRole("textbox",{name:"Message Tango",exact:true});await expect(composer).toBeVisible();
  await expect(page.getByTestId("chat-scroll").getByText("What do you actually want me for?",{exact:true})).toBeVisible();
  await composer.fill("I want cowork");await composer.press(SEND_KEY);
  const current=async()=>(await api("GET","/api/bots")).bots.find((bot:any)=>bot.id===target.id);
  await expect.poll(async()=>(await current()).messages.findLast((message:any)=>message.card?.intake&&!message.card.answered)?.card.intake.step).toBe("narrow");
  const narrow=(await current()).messages.findLast((message:any)=>message.card?.intake&&!message.card.answered).card;
  expect(narrow.intake).toMatchObject({asked:2,candidate:{slug:"cowork"}});
  await composer.fill("That's about right");await composer.press(SEND_KEY);
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
  // THE TURNS RAN. This asserted the OPPOSITE until M1: the setup
  // conversation took the composer's send instead of the bot, so nothing the
  // person typed ever reached an engine and the dump was proof of it. That is
  // the bug. Tango is asked for something and answers, AND adopts Cowork from
  // the same two sentences — alongside, never instead.
  // The engine launches when the turn dispatches, which can trail the intake
  // cards (memory recall runs first, within its budget), so this waits for it.
  // Whether the second sentence is steered into the first turn or runs as a
  // turn of its own is the engine's timing, not the product's choice (a phone
  // run answers the first sentence before the second is sent), so both are
  // accepted; what is proved either way is that each sentence reached Tango and
  // was answered, read from the fake's own turn record and the parent links.
  expect(before.messages.filter((message:any)=>message.role==="user"&&message.text==="I want cowork")).toHaveLength(1);
  const logLines=()=>existsSync(fixture.fixtureTurnLogPath)?readFileSync(fixture.fixtureTurnLogPath,"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line)):[];
  // launch lines of Tango's turns (each names the provider turn from its credential file); steer lines name the turn they went into
  const turns=()=>logLines().filter((turn:any)=>turn.botId===target.id&&turn.steer===undefined);
  const steerLines=(turnId:string)=>logLines().filter((line:any)=>line.steer!==undefined&&line.turnId===turnId);
  const ancestors=(messages:any[],id:string)=>{const byId=new Map(messages.map((message:any)=>[message.id,message]));const out=new Set<string>();for(let cur=byId.get(id)?.parentId;cur&&!out.has(cur);cur=byId.get(cur)?.parentId)out.add(cur);return out;};
  const botRow=(messages:any[],text:string)=>messages.find((message:any)=>message.role==="bot"&&message.kind==="text"&&message.text===text);
  // Settled: both sentences are on the transcript (a queued one lands when it is drained, as its turn starts),
  // Tango is idle, and every launched turn has answered.
  await expect.poll(async()=>{const bot=await current();const launched=turns().length;return bot.busy!==true&&launched>0&&bot.messages.some((message:any)=>message.role==="user"&&message.text==="That's about right")&&REPLIES.slice(0,launched).every(reply=>botRow(bot.messages,reply));},{timeout:30_000}).toBe(true);
  const launches=turns();const messages=(await current()).messages;
  expect(launches.length,JSON.stringify(launches.map((turn:any)=>turn.prompt))).toBeLessThanOrEqual(2);
  const steered=launches.length===1;
  const first=messages.find((message:any)=>message.role==="user"&&message.text==="I want cowork");
  const reply1=botRow(messages,REPLIES[0]);
  expect(first).toBeTruthy();expect(reply1).toBeTruthy();
  // "I want cowork" went to Tango and Tango answered it, never swallowed by the intake.
  expect(ancestors(messages,reply1.id).has(first.id)).toBe(true);
  // The server stamped the row with the provider turn it released the sentence to (BOTADDED-DESIGN-V3 r6 §5): that turn's
  // launch carried the sentence and its answer is reply1. A never-dispatched or only-replayed sentence has no stamp.
  const T1=first.dispatchedIn;
  expect(T1,"the first sentence names the turn it was dispatched in").toBeTruthy();
  const launch1=launches.find((turn:any)=>turn.turnId===T1);
  expect(launch1,JSON.stringify(launches.map((turn:any)=>turn.turnId))).toBeTruthy();
  expect(launch1.prompt).toContain("I want cowork");
  expect(reply1.turnId).toBe(T1);
  expect(launches[0].prompt).toContain("I want cowork");
  const second=messages.find((message:any)=>message.role==="user"&&message.text==="That's about right");
  if(second?.dispatchedIn===T1&&steerLines(T1).some((line:any)=>String(line.steer).includes("That's about right"))){
    // steered into the running turn T1: the steer line names T1
    expect(second.steered).toBe(true);
  }else if(steered){
    // one turn answered both sentences: no second answer, and its launch carried both
    expect(botRow(messages,REPLIES[1])).toBeUndefined();
    expect(launches[0].prompt).toContain("That's about right");
  }else{
    // a turn of its own: sent after the first answer, and answered in its turn
    const reply2=botRow(messages,REPLIES[1]);
    expect(second).toBeTruthy();expect(reply2).toBeTruthy();
    expect(ancestors(messages,second.id).has(reply1.id)).toBe(true);
    expect(ancestors(messages,reply2.id).has(second.id)).toBe(true);
    expect(launches[1].prompt).toContain("That's about right");
    // two turns, two turn ids on the answers; the second sentence names its own turn T2, whose launch carried it
    expect(reply1.turnId).toBeTruthy();expect(reply2.turnId).toBeTruthy();expect(reply2.turnId).not.toBe(reply1.turnId);
    expect(second.dispatchedIn).toBe(reply2.turnId);
    expect(launches.find((turn:any)=>turn.turnId===second.dispatchedIn)?.prompt).toContain("That's about right");
  }
  await page.screenshot({path:info.outputPath("tango-adapted-cowork.png"),fullPage:true});
});
