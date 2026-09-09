// P08 real browser -> owner HTTP -> authority -> fake-provider recall proof.
// Each viewport project owns an isolated server/data directory and Vite port.
// Synthetic source-backed candidates are seeded before the browser opens;
// review/correction/sharing/pinning/forgetting go through the actual UI/API.
// No intercepted routes, external models, existing server or user profile.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchVerificationServer, runControlMurage, type VerificationServer } from "../../scripts/control-murage.ts";
import { openSidebar } from "./fixtures.ts";

const ORIGINAL = "ORCHIDREVIEW Original launch date is Tuesday.";
const CORRECTED = "ORCHIDREVIEW Corrected launch date is Thursday.";
const PRIVATE = "PRIVATE_OTHER_BOT_CANARY";
let fixture: VerificationServer;
let vite: ViteDevServer;
let origin: string;
let desktop: Record<string,string>;
let bot: {id:string;threadId:string};
let botScope: string;
let roomScope: string;
let database: DatabaseSync;
let closed=false;
async function closeFixture() {
  if(closed)return;closed=true;
  try {await vite?.close();}finally{try{database?.close();}finally{await fixture?.close();}}
}

async function api(method:string,path:string,body?:unknown) {
  const response=await fetch(`${fixture.info.url}${path}`,{method,headers:{...desktop,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const result=await response.json();
  expect(response.ok,`${method} ${path}: ${response.status}`).toBe(true);
  return result as any;
}
const action=(body:Record<string,unknown>)=>api("POST","/api/memory/action",body);
const scope=(kind:string,owner:string)=>{
  const row=database.prepare("SELECT id FROM memory_scopes WHERE kind=? AND owner_key=?").get(kind,owner);
  expect(row,`Fixture ${kind} scope missing`).toBeTruthy();
  return String(row!.id);
};
function seed(id:string,scopeId:string,text:string,threadId:string) {
  const payload=JSON.stringify({text,kind:"text",speaker:"owner",outcome:"recorded"});
  const hash=createHash("sha256").update(payload).digest("hex");
  database.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state) VALUES(?,?,?,?,1,?,'text','owner','recorded','active')")
    .run(`source-${id}`,scopeId,threadId,`message-${id}`,hash);
  database.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES(?,1,?,?,1)").run(`source-${id}`,hash,payload);
  database.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,created_at) VALUES(?,1,?,'fact',?,'owner-statement','candidate',0,1,1)")
    .run(id,scopeId,text);
  database.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES(?,1,?,1,0,?)").run(id,`source-${id}`,Buffer.byteLength(text));
}

test.beforeAll(async()=>{
  fixture=await launchVerificationServer(process.env, undefined, {
    instrumentationSource: `process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => String(input).startsWith("https://api.fluxrouter.ai/")
        ? Promise.resolve(new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{content:"[]"}}]})))
        : originalFetch(input, init);`,
  });
  try {
    desktop={};
    const deniedStatus=await fetch(`${fixture.info.url}/api/memory/status`);
    expect(deniedStatus.status).toBe(404);
    const deniedConfigure=await fetch(`${fixture.info.url}/api/memory/action`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"configure",mode:"active"})});
    expect(deniedConfigure.status).toBe(404);
    const proof=await api("GET","/api/desktop-secret");
    desktop={"x-murage-surface":"desktop","x-murage-surface-secret":proof.secret};
    bot=(await api("POST","/api/bots",{name:"Memory browser fixture",title:"Review coordinator",section:"Memory Browser"})).bot;
    const other=(await api("POST","/api/bots",{name:"Other private fixture",section:"Memory Browser"})).bot;
    const room=(await api("POST","/api/groups",{name:"Reviewed audience",memberIds:[bot.id,other.id],setup:{bulletin:"Synthetic review audience",defaultResponder:{kind:"member",botId:bot.id}}})).group;
    database=new DatabaseSync(join(fixture.info.dataDir,"messages.db"));
    expect(database.prepare("SELECT mode FROM memory_meta WHERE id=1").get()?.mode).toBe("active");
    database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    botScope=scope("bot",bot.id);roomScope=scope("room",room.id);
    seed("browser-candidate",botScope,ORIGINAL,bot.threadId);
    seed("browser-private",scope("bot",other.id),PRIVATE,other.threadId);
    database.exec("UPDATE memory_meta SET data_revision=data_revision+1; COMMIT");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    await action({action:"configure",mode:"active"});
    const root=fileURLToPath(new URL("../../",import.meta.url));
    vite=await createServer({configFile:false,root,envFile:false,cacheDir:join(fixture.info.dataDir,"vite-cache"),
      resolve:{alias:{"@":join(root,"src")}},plugins:[react(),tailwindcss()],
      server:{host:"127.0.0.1",port:0,watch:null,hmr:false,proxy:{"/api":{target:fixture.info.url}}}});
    await vite.listen(0);
    const address=vite.httpServer!.address();
    if(!address||typeof address==="string")throw Error("Memory UI fixture has no port");
    origin=`http://127.0.0.1:${address.port}`;
  }catch(error){await closeFixture();throw error;}
});
test.afterAll(closeFixture);

async function currentProviderPrompt(text:string) {
  rmSync(fixture.fixtureDumpPath,{force:true});
  await api("POST",`/api/bots/${bot.id}/messages`,{text});
  let prompt:string|undefined;
  await expect.poll(()=>{
    try {
      const dumped=JSON.parse(readFileSync(fixture.fixtureDumpPath,"utf8"));
      prompt=dumped.prompt?.message?.content;
      return typeof prompt==="string";
    }catch{return false;}
  },{timeout:15000}).toBe(true);
  const result=await runControlMurage(["wait","--bot",bot.id,"--timeout","30","--url",fixture.info.url]) as {status:string};
  expect(result.status).toBe("settled");
  return prompt!;
}
async function fitsViewport(page:Page) {
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const panel=page.getByRole("heading",{name:"Workspace memory",exact:true});
  await expect(panel).toBeVisible();
}
async function clickAction(page:Page,label:string,action:string) {
  const response=page.waitForResponse(response=>response.url().endsWith("/api/memory/action")&&response.request().method()==="POST"&&response.request().postDataJSON()?.action===action);
  await page.getByRole("button",{name:label,exact:true}).click();
  expect((await response).ok(),`${action} owner action failed`).toBe(true);
}
async function inspectActive(page:Page,id:string) {
  await page.getByRole("combobox",{name:"Audience",exact:true}).selectOption(botScope);
  await page.getByRole("combobox",{name:"Record status",exact:true}).selectOption("active");
  await clickAction(page,"Search","list");
  await page.locator(`[data-memory-id="${id}"]`).getByRole("button",{name:"Inspect memory",exact:true}).click();
  await expect(page.getByRole("region",{name:"Memory details",exact:true})).toHaveAttribute("data-memory-detail-id",id);
}

test("reviewed memory survives sharing and correction, then forgetting excludes future recall",async({page},info)=>{
  const screenshot=async(name:string)=>{
    const path=info.outputPath(`${name}-${info.project.name}.png`);
    await page.screenshot({path,fullPage:true});console.log(JSON.stringify({memoryScreenshot:path}));
  };
  await page.addInitScript(()=>localStorage.setItem("murage-email-gate","skipped"));
  await page.goto(origin);
  await expect(page.getByRole("button",{name:/^Open .+'s profile$/}).first()).toBeVisible();
  const invitation=page.getByRole("complementary",{name:"Let your bots pick the right model",exact:true});
  await expect(invitation).toBeVisible();
  await invitation.getByRole("button",{name:"Not now",exact:true}).last().click();
  await expect(invitation).not.toBeVisible();
  const sidebar=await openSidebar(page);
  await sidebar.getByRole("button",{name:"More",exact:true}).click();
  await sidebar.getByRole("menuitem",{name:"Team map",exact:true}).click();
  await page.getByRole("button",{name:"Manage memory",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Workspace memory",exact:true})).toBeVisible();
  const audience=page.getByRole("combobox",{name:"Audience",exact:true});
  const status=page.getByRole("combobox",{name:"Record status",exact:true});
  const search=page.getByRole("textbox",{name:"Search memory",exact:true});
  await expect(audience).toBeVisible();await expect(status).toBeVisible();await expect(search).toBeVisible();
  await audience.selectOption(botScope);
  await status.selectOption("candidate");
  await search.fill("ORCHIDREVIEW");
  await clickAction(page,"Search","list");
  const inspect=page.locator('[data-memory-id="browser-candidate"]').getByRole("button",{name:"Inspect memory",exact:true});
  await expect(inspect).toBeVisible();
  await page.locator("summary").filter({hasText:/^Local model$/}).click();
  await expect(page.getByTestId("memory-model-status")).toHaveText("Local model: missing");
  await expect(page.getByText("Semantic recall is unavailable until the local model is verified. Lexical recall can still be used.",{exact:true})).toBeVisible();
  await fitsViewport(page);
  await screenshot("memory-settings");
  await inspect.focus();await expect(inspect).toBeFocused();await page.keyboard.press("Enter");
  await expect(page.getByRole("heading",{name:"Memory details",exact:true})).toBeVisible();
  await expect(page.getByText(ORIGINAL,{exact:true}).first()).toBeVisible();
  const details=page.getByRole("region",{name:"Memory details",exact:true});
  await details.locator("summary").filter({hasText:"source-browser-candidate"}).click();
  await expect(details.getByText(/Source hash:/)).toBeVisible();
  await screenshot("memory-review");
  await clickAction(page,"Approve candidate","approve");
  await inspectActive(page,"browser-candidate");
  await expect(page.getByRole("button",{name:"Save correction",exact:true})).toBeVisible();
  await page.getByRole("textbox",{name:"Correction text",exact:true}).fill(CORRECTED);
  await clickAction(page,"Save correction","correct");
  const original=await action({action:"list",scopeId:botScope,state:"active",query:"ORCHIDREVIEW"});
  const current=original.records.find((record:any)=>record.text===CORRECTED);
  expect(current).toBeTruthy();
  await inspectActive(page,current.id);
  await expect(page.getByRole("textbox",{name:"Correction text",exact:true})).toHaveValue(CORRECTED);
  await page.getByRole("combobox",{name:"Share with audience",exact:true}).selectOption(roomScope);
  await clickAction(page,"Share memory","promote");
  const shared=await action({action:"list",scopeId:roomScope,state:"active",query:"ORCHIDREVIEW"});
  expect(shared.records.some((record:any)=>record.text===CORRECTED)).toBe(true);
  // Re-select the current source record after sharing; it is this audience's
  // owner pin that must reach the bot even while local embeddings are absent.
  await inspectActive(page,current.id);
  const pin=page.getByRole("button",{name:"Pin memory",exact:true});
  if(await pin.isVisible()){await clickAction(page,"Pin memory","pin");await inspectActive(page,current.id);}
  await expect(page.getByRole("button",{name:"Unpin memory",exact:true})).toBeVisible();
  const before=await currentProviderPrompt("browser-memory-recall-before-forget");
  expect(before).toContain(CORRECTED);expect(before).not.toContain(ORIGINAL);expect(before).not.toContain(PRIVATE);
  await expect(page.getByRole("checkbox",{name:"Confirm forgetting this memory",exact:true})).not.toBeChecked();
  await expect(page.getByRole("button",{name:"Forget memory",exact:true})).toBeDisabled();
  await page.getByRole("checkbox",{name:"Confirm forgetting this memory",exact:true}).check();
  await clickAction(page,"Forget memory","forget");
  const remaining=await action({action:"list",scopeId:botScope,state:"active",query:"ORCHIDREVIEW"});
  expect(remaining.records.some((record:any)=>record.id===current.id)).toBe(false);
  const after=await currentProviderPrompt("browser-memory-recall-after-forget");
  expect(after).not.toContain(CORRECTED);expect(after).not.toContain(ORIGINAL);expect(after).not.toContain(PRIVATE);
  await fitsViewport(page);
  await screenshot("memory-forgotten");
});


test("bot memory keeps workspace settings out of the narrow profile panel", async ({page}, info) => {
  await action({action:"configure",mode:"off"});
  await page.addInitScript(()=>localStorage.setItem("murage-flux-invite-dismissed","1"));
  await page.addInitScript(()=>localStorage.setItem("murage-email-gate","skipped"));
  await page.goto(origin);
  const invitation=page.getByRole("complementary",{name:"Let your bots pick the right model",exact:true});
  if(await invitation.count())await invitation.getByRole("button",{name:"Not now",exact:true}).last().click();
  const sidebar=await openSidebar(page);
  await sidebar.getByText("Memory browser fixture",{exact:true}).click();
  await page.getByRole("button",{name:"Open Memory browser fixture's profile",exact:true}).first().click();
  await page.getByRole("button",{name:"Open memory for Memory browser fixture",exact:true}).last().click();
  const memory=page.getByRole("region",{name:"Bot memory",exact:true});
  await expect(memory.getByRole("combobox",{name:"Audience",exact:true})).toBeVisible();
  await expect(memory.getByRole("combobox",{name:"Memory mode",exact:true})).toHaveCount(0);
  await expect(memory.getByText("Workspace mode: Off",{exact:false})).toBeVisible();
  expect(await memory.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await memory.scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath("bot-memory-profile.png")});
  await memory.getByRole("button",{name:"Open workspace memory settings",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Workspace memory",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Enable and import notebooks",exact:true}).click();
  await expect(page.getByText("Capture and recall enabled. Detected bot notebooks are being imported; originals are preserved.",{exact:true})).toBeVisible();
  expect((await api("GET","/api/memory/status")).mode).toBe("active");
  expect((await api("GET","/api/memory/status")).configuration.extractorInstanceId).toBeNull();
  await page.screenshot({path:info.outputPath("workspace-memory-settings.png")});
});

test("owner imports full notebooks, tracks changes, and selects existing Flux extraction", async ({page}, info) => {
  const root=join(fixture.info.dataDir,"workspaces",bot.id);
  mkdirSync(join(root,"memory"),{recursive:true});
  const original=Array.from({length:230},(_,n)=>`Line ${n}: notebook context.`).join("\n")+"\nFULL_NOTEBOOK_TAIL";
  writeFileSync(join(root,"MEMORY.md"),original);
  writeFileSync(join(root,"memory","detail.md"),"TOPIC_NOTE_CANARY");
  await api("PUT","/api/config",{flux:{apiKey:"isolated-memory-ui-fixture-key"}});
  await page.addInitScript(()=>localStorage.setItem("murage-email-gate","skipped"));
  await page.goto(origin);
  await expect(page.getByRole("button",{name:/^Open .+'s profile$/}).first()).toBeVisible();
  const sidebar=await openSidebar(page);
  await sidebar.getByRole("button",{name:"More",exact:true}).click();
  await sidebar.getByRole("menuitem",{name:"Team map",exact:true}).click();
  await page.getByRole("button",{name:"Manage memory",exact:true}).click();
  await page.getByText("Workspace settings and processing",{exact:true}).click();
  await page.getByRole("combobox",{name:"Extractor preference",exact:true}).selectOption("@murage/flux-fast");
  await clickAction(page,"Save memory settings","configure");
  expect((await api("GET","/api/memory/status")).configuration.extractorInstanceId).toBe("@murage/flux-fast");
  await page.screenshot({path:info.outputPath("flux-memory-choice.png")});
  await page.getByText("Import existing notes",{exact:true}).click();
  await clickAction(page,"Find existing notebooks","import-inventory");
  await page.getByRole("checkbox",{name:"Memory browser fixture · MEMORY.md",exact:true}).check();
  await page.getByRole("checkbox",{name:"Memory browser fixture · detail.md",exact:true}).check();
  await page.getByRole("checkbox",{name:/Keep imported notebooks updated/}).check();
  await clickAction(page,"Preview selected notebooks","import-preview");
  const preview=page.getByRole("region",{name:"Import preview",exact:true});
  await expect(preview.getByText(original,{exact:true})).toBeVisible();
  await expect(preview.getByText("TOPIC_NOTE_CANARY",{exact:true})).toBeVisible();
  await clickAction(page,"Import selected notes","import-commit");
  expect(readFileSync(join(root,"MEMORY.md"),"utf8")).toBe(original);
  writeFileSync(join(root,"MEMORY.md"),"CHANGED_NOTEBOOK_CANARY");
  await expect.poll(async()=> (await action({action:"list",botId:bot.id,state:"active",query:"CHANGED_NOTEBOOK_CANARY"})).records.length,{timeout:30000}).toBeGreaterThan(0);
  await clickAction(page,"Find existing notebooks","import-inventory");
  const tracked=page.getByRole("group",{name:"Tracked notebook: Memory browser fixture · MEMORY.md",exact:true});
  await expect(tracked).toBeVisible();
  await tracked.scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath("tracked-notebook.png")});
  await tracked.getByRole("button",{name:"Stop tracking",exact:true}).click();
  await expect(tracked).toHaveCount(0);
  await fitsViewport(page);
});

test("paged bot memory handles 3000 records in both skins without accumulating cards", async ({page}, info) => {
  await page.addInitScript(()=>localStorage.setItem("murage-flux-invite-dismissed","1"));
  database.exec("BEGIN IMMEDIATE");
  for(let n=0;n<3000;n++)database.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,created_at) VALUES(?,1,?,'fact',?,'owner-statement','active',?,?,?)")
    .run(`paged-${String(n).padStart(4,"0")}`,botScope,`PAGEDMEMORY: useful note ${n}`,n===2999?1:0,Date.UTC(2026,8,1)+n,Date.UTC(2026,8,1)+n);
  seed("paged-candidate",botScope,"PAGEDMEMORY: proposed detail",bot.threadId);
  database.exec("UPDATE memory_meta SET data_revision=data_revision+1; COMMIT");
  await page.addInitScript(()=>localStorage.setItem("murage-email-gate","skipped"));
  await page.goto(origin);
  const invitation=page.getByRole("complementary",{name:"Let your bots pick the right model",exact:true});
  if(await invitation.count())await invitation.getByRole("button",{name:"Not now",exact:true}).last().click();
  const sidebar=await openSidebar(page);
  await sidebar.getByText("Memory browser fixture",{exact:true}).click();
  await page.getByRole("button",{name:"Open memory for Memory browser fixture",exact:true}).first().click();
  const panel=page.getByRole("region",{name:"Bot memory",exact:true});
  await panel.getByRole("textbox",{name:"Search memory",exact:true}).fill("PAGEDMEMORY");
  await panel.getByRole("button",{name:"Search",exact:true}).click();
  await expect(panel.locator("[data-memory-id]")).toHaveCount(50);
  await expect(panel.locator("[data-memory-id]").first()).toHaveAttribute("data-memory-id","paged-2999");
  await panel.getByRole("button",{name:"Next page",exact:true}).click();
  await expect(panel.getByText("Page 2",{exact:true})).toBeVisible();
  await expect(panel.locator("[data-memory-id]")).toHaveCount(50);
  await expect(panel.locator("[data-memory-id]").first()).toHaveAttribute("data-memory-id","paged-2949");
  await panel.getByRole("button",{name:"Previous page",exact:true}).click();
  await expect(panel.locator("[data-memory-id]").first()).toHaveAttribute("data-memory-id","paged-2999");
  await panel.getByRole("button",{name:"Important",exact:true}).click();
  await expect(panel.locator("[data-memory-id]")).toHaveCount(1);
  await panel.getByRole("button",{name:"Needs review",exact:true}).click();
  await expect(panel.locator("[data-memory-id]")).toHaveCount(1);
  await expect(panel.locator("[data-memory-id]").first()).toHaveAttribute("data-memory-id","paged-candidate");
  for(const skin of ["light","dark"]){
    await page.evaluate(skin=>{document.documentElement.dataset.skin=skin;},skin);
    await panel.scrollIntoViewIfNeeded();
    expect(await panel.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    await page.screenshot({path:info.outputPath(`paged-memory-${skin}-${info.project.name}.png`)});
  }
});
