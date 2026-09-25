import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { saveImage } from "./attachments.ts";
import { describeArtifact } from "./artifacts.ts";
import { IMAGE_APPROVAL_TIMEOUT_MS, ImageOperations, imageReferences, publishImage } from "./image-operations.ts";
import { ImageGenerationService, type ImageReference } from "./image-generation.ts";
import { managedImageOutputPath } from "./output-publication.ts";
import { composeMessage } from "../src/lib/composer-attachments.ts";
import { writeInstallationArchive } from "./installation-archive.ts";
import { prepareInstallationRestore } from "./installation-restore-preparation.ts";
import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { assertRestoreReviewed } from "../electron/restore-review.mjs";
// C2 fault injection: attachment storage refuses the next N image commits.
const faults = vi.hoisted(() => ({ saveImage: 0 }));
vi.mock("./attachments.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./attachments.ts")>();
  return { ...actual, saveImage: (...args: Parameters<typeof actual.saveImage>) => {
    if (faults.saveImage > 0) { faults.saveImage--; throw Object.assign(new Error("attachments storage is full"), { status: 507 }); }
    return actual.saveImage(...args);
  } };
});
beforeEach(() => { faults.saveImage = 0; });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const detail = { connectionId: "openai", provider: "openai" as const, model: "gpt-image-2", operation: "generate" as const, count: 1 as const, referenceCount: 0 };
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, {recursive:true,force:true}); mkdirSync(DATA_DIR,{recursive:true}); });
afterEach(() => closeDatabase());
function fixture() {
  const store = new Store(() => ({instanceId:"fixture",model:"fixture"})); const bot = store.createBot();
  const controller = new AbortController(); let active = true;
  const actor = { botId:bot.id,threadId:bot.threadId,generation:randomUUID(),signal:controller.signal,assertActive:()=>{if(!active)throw Error("revoked");} };
  const waiting = vi.fn(), operations = new ImageOperations({store,waiting});
  const card = async () => { await vi.waitFor(()=>expect(store.messagesFor(bot.threadId).some(m=>m.card?.tool==="generate_image" && !m.card.answered)).toBe(true)); return store.messagesFor(bot.threadId).find(m=>m.card?.tool==="generate_image"&&!m.card.answered)!; };
  return {store,bot,actor,controller,operations,waiting,card,revoke:()=>{active=false;}};
}
function generationFixture() {
 const f=fixture();
 const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({data:[{b64_json:png.toString("base64")}]})));
 const service=new ImageGenerationService({resolveConnection:()=>({id:"flux",provider:"flux",apiKey:"FAKE_B15",revision:"1"}),connectionIds:()=>["flux"],fetch:fetcher});
 const run=(id:string,request:Record<string,unknown>,refs:ImageReference[]=[])=>f.operations.execute(f.actor,id,request,(reserve,publish)=>service.generate(request,{reserve,publish,assertActive:f.actor.assertActive,signal:f.actor.signal},refs));
 return {...f,fetcher,run,request:{connectionId:"flux",prompt:"fixture"}};
}
it("B15 permits corrected same-turn local size/reference validation with exactly one approval and POST",async()=>{
 for(const invalid of [{size:"1536x1024"},{operation:"edit"}]){
  const f=generationFixture();await expect(f.run("correctable",{...f.request,...invalid})).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();expect(f.waiting).not.toHaveBeenCalled();
  expect(database().prepare("SELECT id FROM image_operations WHERE generation=?").all(f.actor.generation)).toHaveLength(0);
  const job=f.run("correctable",f.request);
  expect(()=>f.run("concurrent",f.request)).toThrow("already active");
  const card=await f.card();f.operations.resolve(f.actor.threadId,card.card!.requestId!,"allow");await job;
  expect(f.fetcher).toHaveBeenCalledOnce();expect(f.waiting.mock.calls.filter(call=>call[1])).toHaveLength(1);
  expect(()=>f.run("extra",f.request)).toThrow("One image attempt");
 }
});
it("B15 denial, cancellation and unknown preflight failures cannot acquire approval with a new ID",async()=>{
 for(const mode of ["deny","cancel","unknown"]){
  const f=generationFixture();
  if(mode==="unknown") {
   await expect(f.operations.execute(f.actor,"first",f.request,async()=>{throw Error("unknown preflight");})).rejects.toThrow("unknown");
  } else {
   const job=f.run("first",f.request),refused=expect(job).rejects.toThrow();const card=await f.card();
   if(mode==="cancel")f.controller.abort();else f.operations.resolve(f.actor.threadId,card.card!.requestId!,"deny");await refused;
  }
  expect(()=>f.run("new-id",f.request)).toThrow("One image attempt");expect(f.fetcher).not.toHaveBeenCalled();
 }
});
it("B15 timeout, 5xx and malformed provider responses fence both replay and a fresh request ID",async()=>{
 for(const mode of ["timeout","5xx","decode"]){
  const f=generationFixture();f.fetcher.mockImplementationOnce(async()=>{if(mode==="timeout")throw Error("lost response");return mode==="5xx"?new Response("failed",{status:503}):new Response("invalid json");});
  const job=f.run("first",f.request),refused=expect(job).rejects.toThrow();const card=await f.card();f.operations.resolve(f.actor.threadId,card.card!.requestId!,"allow");await refused;
  expect(()=>f.run("first",f.request)).toThrow("will not be retried");expect(()=>f.run("new-id",f.request)).toThrow("One image attempt");expect(f.fetcher).toHaveBeenCalledOnce();
 }
});
it("lets the same turn try again after an image request that never reached a provider",async()=>{
 const f=fixture();
 let connection:{id:string;provider:"flux";apiKey:string;revision:string}|null=null;
 const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({data:[{b64_json:png.toString("base64")}]})));
 const service=new ImageGenerationService({resolveConnection:()=>connection,connectionIds:()=>connection?["flux"]:[],fetch:fetcher});
 const request={connectionId:"flux",prompt:"fixture"};
 const run=(id:string)=>f.operations.execute(f.actor,id,request,(reserve,publish)=>service.generate(request,{reserve,publish,assertActive:f.actor.assertActive,signal:f.actor.signal}));
 await expect(run("first")).rejects.toThrow("Settings");
 expect(fetcher).not.toHaveBeenCalled();expect(f.waiting).not.toHaveBeenCalled();
 // the attempt is not spent: the row is gone, so fixing Settings and asking
 // again in the same turn works instead of 409 then 429
 expect(database().prepare("SELECT id FROM image_operations WHERE generation=?").all(f.actor.generation)).toHaveLength(0);
 connection={id:"flux",provider:"flux",apiKey:"FAKE_B15",revision:"1"};
 const job=run("first");const card=await f.card();f.operations.resolve(f.actor.threadId,card.card!.requestId!,"allow");await job;
 expect(fetcher).toHaveBeenCalledOnce();
});
it("clears an image request abandoned at its approval card when the app restarts",async()=>{
 const f=generationFixture();f.operations.resumePendingPublications();
 const id=createHash("sha256").update(`${f.actor.botId}:${f.actor.threadId}:${f.actor.generation}:abandoned`).digest("hex");
 const requestHash=createHash("sha256").update(JSON.stringify(f.request)).digest("hex");
 database().prepare("INSERT INTO image_operations VALUES(?,?,?,'awaiting',NULL,?)").run(id,f.actor.generation,requestHash,Date.now());
 closeDatabase();
 const restarted=new ImageOperations({store:f.store,waiting:f.waiting});
 restarted.resumePendingPublications();
 expect(database().prepare("SELECT id FROM image_operations WHERE id=?").all(id)).toHaveLength(0);
 const job=restarted.execute(f.actor,"abandoned",f.request,(reserve,publish)=>new ImageGenerationService({resolveConnection:()=>({id:"flux",provider:"flux",apiKey:"FAKE_B15",revision:"1"}),connectionIds:()=>["flux"],fetch:f.fetcher}).generate(f.request,{reserve,publish,assertActive:f.actor.assertActive,signal:f.actor.signal}));
 const card=await f.card();restarted.resolve(f.actor.threadId,card.card!.requestId!,"allow");await job;
 expect(f.fetcher).toHaveBeenCalledOnce();
});
it("leaves a dispatched image request fenced after a restart",async()=>{
 const f=generationFixture();f.operations.resumePendingPublications();
 const id=createHash("sha256").update(`${f.actor.botId}:${f.actor.threadId}:${f.actor.generation}:dispatched`).digest("hex");
 const requestHash=createHash("sha256").update(JSON.stringify(f.request)).digest("hex");
 database().prepare("INSERT INTO image_operations VALUES(?,?,?,'running',NULL,?)").run(id,f.actor.generation,requestHash,Date.now());
 closeDatabase();
 const restarted=new ImageOperations({store:f.store,waiting:f.waiting});
 restarted.resumePendingPublications();
 // the provider may already have been asked, and billed: that row stays
 expect(database().prepare("SELECT id FROM image_operations WHERE id=?").all(id)).toHaveLength(1);
});
it("B15 retains crash boundaries before and after approval and allows a genuinely new turn",async()=>{
 for(const state of ["awaiting","running"]){
  const f=generationFixture();f.operations.resumePendingPublications();
  const id=createHash("sha256").update(`${f.actor.botId}:${f.actor.threadId}:${f.actor.generation}:crashed`).digest("hex");
  const requestHash=createHash("sha256").update(JSON.stringify(f.request)).digest("hex");
  database().prepare("INSERT INTO image_operations VALUES(?,?,?,?,NULL,?)").run(id,f.actor.generation,requestHash,state,Date.now());
  expect(()=>f.run("crashed",f.request)).toThrow("will not be retried");expect(()=>f.run("new-id",f.request)).toThrow("One image attempt");
  f.actor.generation=randomUUID();const job=f.run("next-turn",f.request);const card=await f.card();f.operations.resolve(f.actor.threadId,card.card!.requestId!,"allow");await job;expect(f.fetcher).toHaveBeenCalledOnce();
 }
});
it("requires an exact owner count approval before work and persists a real artifact",async()=>{
 const f=fixture(), provider=vi.fn();
 const job=f.operations.execute(f.actor,"first",{prompt:"draw fixture"},async reserve=>{const ticket=await reserve(detail);provider();const artifact=publishImage(f.store,f.actor,{bytes:png,mime:"image/png"},detail);ticket.finish("published");return artifact;});
 const card=await f.card();expect(provider).not.toHaveBeenCalled();expect(card.card?.subtitle).toContain("One image");expect(card.card?.allowKey).toBeUndefined();
 expect(f.operations.resolve("different-thread",card.card!.requestId!,"allow")).toBe("unavailable");expect(provider).not.toHaveBeenCalled();
 expect(f.operations.resolve(f.actor.threadId,card.card!.requestId!,"allow")).toBe("allowed-once");
 const result=await job;expect(provider).toHaveBeenCalledOnce();expect(readFileSync(result.path)).toEqual(png);expect(result.url).toMatch(/^\/api\/attachments\//);
 expect(f.store.messagesFor(f.actor.threadId).at(-1)?.attachments?.[0].kind).toBe("image");
 expect(imageReferences(f.store,f.actor.threadId,[result.referenceId])[0].bytes).toEqual(png);
 expect(f.waiting.mock.calls.map(c=>c[1])).toEqual([true,false]);
});
it("still asks before it spends when the bot is on Full access",async()=>{
 const f=generationFixture();
 f.store.patchBot(f.bot.id,{autoApprove:true,fullAccess:true,fullAccessAcknowledgedAt:1});
 expect(f.store.projectBotForTask(f.bot.id,f.bot.threadId)?.fullAccess).toBe(true);
 const job=f.run("full-access",f.request);
 const card=await f.card();
 expect(card.card!.title).toBe("Approve image generation");
 expect(f.fetcher).not.toHaveBeenCalled();
 f.operations.resolve(f.actor.threadId,card.card!.requestId!,"allow");await job;
 expect(f.fetcher).toHaveBeenCalledOnce();
});
it("denial or cancellation cannot start a provider request",async()=>{
 const f=fixture(),provider=vi.fn();const job=f.operations.execute(f.actor,"denied",{prompt:"fixture"},async reserve=>{await reserve(detail);provider();});
 const rejected=expect(job).rejects.toThrow("not approved");const card=await f.card();f.operations.resolve(f.actor.threadId,card.card!.requestId!,"deny");await rejected;expect(provider).not.toHaveBeenCalled();
 const other=fixture();const aborted=other.operations.execute(other.actor,"abort",{prompt:"fixture"},async reserve=>{await reserve(detail);provider();});const refusal=expect(aborted).rejects.toThrow();await other.card();other.controller.abort();await refusal;expect(provider).not.toHaveBeenCalled();
});
it("rechecks actor revocation when the owner answers",async()=>{
 const f=fixture(),provider=vi.fn();const job=f.operations.execute(f.actor,"revoke",{prompt:"fixture"},async reserve=>{await reserve(detail);provider();});const refusal=expect(job).rejects.toThrow();const card=await f.card();f.revoke();expect(f.operations.resolve(f.actor.threadId,card.card!.requestId!,"allow")).toBe("unavailable");await refusal;expect(provider).not.toHaveBeenCalled();
});
it("deduplicates a request and retains one-attempt count across manager reload",async()=>{
 const f=fixture(),provider=vi.fn();const work=async(reserve:any)=>{const ticket=await reserve(detail);provider();ticket.finish("published");return{ok:true};};
 const job=f.operations.execute(f.actor,"same",{prompt:"fixture"},work);const duplicate=f.operations.execute(f.actor,"same",{prompt:"fixture"},work);
 const card=await f.card();f.operations.resolve(f.actor.threadId,card.card!.requestId!,"allow");expect(await job).toEqual(await duplicate);expect(provider).toHaveBeenCalledOnce();
 const reloaded=new ImageOperations({store:f.store,waiting:()=>{}});expect(await reloaded.execute(f.actor,"same",{prompt:"fixture"},work)).toEqual({ok:true});
 expect(()=>reloaded.execute(f.actor,"same",{prompt:"different"},work)).toThrow("different request");
 expect(()=>reloaded.execute(f.actor,"other",{prompt:"fixture"},work)).toThrow("One image attempt");expect(provider).toHaveBeenCalledOnce();
});
it("allows only one active image operation in a workspace",async()=>{
 const f=fixture();const job=f.operations.execute(f.actor,"one",{prompt:"fixture"},async reserve=>{await reserve(detail);});const refusal=expect(job).rejects.toThrow();await f.card();
 expect(()=>f.operations.execute({...f.actor,generation:randomUUID()},"two",{prompt:"fixture"},async()=>{})).toThrow("already active");f.operations.cancelThread(f.actor.threadId);await refusal;
});
it("does not repeat an uncertain provider attempt",async()=>{
 const f=fixture();const work=async(reserve:any)=>{const ticket=await reserve(detail);ticket.finish("uncertain");throw Error("uncertain");};const job=f.operations.execute(f.actor,"unknown",{prompt:"fixture"},work);const refusal=expect(job).rejects.toThrow("uncertain");const card=await f.card();f.operations.resolve(f.actor.threadId,card.card!.requestId!,"allow");await refusal;
 expect(()=>f.operations.execute(f.actor,"unknown",{prompt:"fixture"},work)).toThrow("will not be retried");
});
it("rejects foreign conversation references and arbitrary file or URL inputs",()=>{
 const f=fixture(),saved=saveImage(png,"image/png"),name=saved.path.split(/[\\/]/).at(-1)!;
 expect(()=>imageReferences(f.store,f.actor.threadId,[name])).toThrow("unavailable");
 for(const input of [["../secret.png"],["https://example.test/image.png"],["/tmp/image.png"],Array(5).fill(name)])expect(()=>imageReferences(f.store,f.actor.threadId,input)).toThrow();
 f.store.appendMessage(f.actor.threadId,{role:"user",kind:"text",text:"reference",attachments:[{kind:"image",path:saved.path,mime:saved.mime}]});expect(imageReferences(f.store,f.actor.threadId,[name])).toHaveLength(1);
});
// F5-T4 (IMG-SEED): an image the person uploaded with a message rides in its
// text as an <attached-image> tag, not in message.attachments. It is a
// reference of that conversation; the same tag in a bot's text is not.
it("accepts an image the person uploaded to this conversation and nothing a bot merely names",()=>{
 const f=fixture(),mine=saveImage(Buffer.concat([png,Buffer.from([1])]),"image/png"),named=saveImage(Buffer.concat([png,Buffer.from([2])]),"image/png");
 const id=(path:string)=>path.split(/[\\/]/).at(-1)!;
 f.store.appendMessage(f.actor.threadId,{role:"user",kind:"text",text:composeMessage("edit this",[{kind:"image",id:"chip",path:mine.path,name:"mine.png",size:mine.bytes,mime:"image/png"}])});
 f.store.appendMessage(f.actor.threadId,{role:"bot",kind:"text",text:`<attached-image path="${named.path}" />`});
 expect(imageReferences(f.store,f.actor.threadId,[id(mine.path)])[0].bytes).toEqual(readFileSync(mine.path));
 expect(()=>imageReferences(f.store,f.actor.threadId,[id(named.path)])).toThrow("unavailable");
 const other=fixture();expect(()=>imageReferences(other.store,other.actor.threadId,[id(mine.path)])).toThrow("unavailable");
});
it("names the reference count in the owner's paid approval",async()=>{
 const f=fixture(),provider=vi.fn();
 const job=f.operations.execute(f.actor,"refs",{prompt:"edit"},async reserve=>{await reserve({...detail,operation:"edit",referenceCount:3});provider();});
 const refusal=expect(job).rejects.toThrow("not approved");const card=await f.card();
 expect(card.card?.title).toBe("Approve image edit");expect(card.card?.subtitle).toContain("One image from 3 reference images · openai · gpt-image-2");
 f.operations.resolve(f.actor.threadId,card.card!.requestId!,"deny");await refusal;expect(provider).not.toHaveBeenCalled();
});
it("names the pinned upstream endpoint in an OpenRouter approval and nothing for other providers",async()=>{
 const f=fixture(),provider=vi.fn();
 const routed={...detail,connectionId:"openrouter",provider:"openrouter" as const,model:"openai/gpt-image-2",operation:"edit" as const,referenceCount:2,endpointTag:"openai"};
 const job=f.operations.execute(f.actor,"pinned",{prompt:"edit"},async reserve=>{await reserve(routed);provider();});
 const refusal=expect(job).rejects.toThrow("not approved");const card=await f.card();
 expect(card.card?.subtitle).toContain("One image from 2 reference images · openrouter · openai/gpt-image-2 (pinned to openai, no fallback)");
 f.operations.resolve(f.actor.threadId,card.card!.requestId!,"deny");await refusal;expect(provider).not.toHaveBeenCalled();
 const g=fixture();
 const plain=g.operations.execute(g.actor,"plain",{prompt:"draw"},async reserve=>{await reserve(detail);provider();});
 const plainRefusal=expect(plain).rejects.toThrow("not approved");const plainCard=await g.card();
 expect(plainCard.card?.subtitle).toContain("One image · openai · gpt-image-2.");expect(plainCard.card?.subtitle).not.toContain("pinned");
 g.operations.resolve(g.actor.threadId,plainCard.card!.requestId!,"deny");await plainRefusal;expect(provider).not.toHaveBeenCalled();
});
it.skipIf(process.platform==="win32")("refuses symlinked image workspaces without writing outside the bot",()=>{
 const f=fixture(),parent=join(DATA_DIR,"workspaces"),target=join(DATA_DIR,"other-private-workspace");mkdirSync(parent,{recursive:true});mkdirSync(target);symlinkSync(target,join(parent,f.bot.id));
 expect(()=>publishImage(f.store,f.actor,{bytes:png,mime:"image/png"},detail)).toThrow("private directory");expect(existsSync(join(target,"generated-images"))).toBe(false);
});
it("refuses publication after authority is revoked",()=>{
 const f=fixture();f.revoke();expect(()=>publishImage(f.store,f.actor,{bytes:png,mime:"image/png"},detail)).toThrow("revoked");expect(existsSync(join(DATA_DIR,"workspaces",f.bot.id,"generated-images"))).toBe(false);
});

// R3-T4 / C2: local output receipts and provider-free resume.
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
type ReceiptRow = { id: string; stage: string; error_category: string | null; sha256: string; path_token: string; artifact_id: string | null; message_id: string | null };
const imageReceipts = () => database().prepare("SELECT id,stage,error_category,sha256,path_token,artifact_id,message_id FROM output_publications WHERE producer='image-operation' ORDER BY created_at").all() as unknown as ReceiptRow[];
const imageMessages = (f: ReturnType<typeof fixture>) => f.store.messagesFor(f.actor.threadId).filter(message => message.attachments?.length);
const imageAccess = (f: ReturnType<typeof fixture>) => ({ owner: true, scopes: [{ botId: f.bot.id, botName: f.bot.name, threadId: f.bot.threadId, workspaceRoot: managedImageOutputPath(DATA_DIR, f.bot.id, f.bot.threadId), managedOutput: true }] });
function operationWork(provider: () => void) {
  return async (reserve: any, publish: any) => {
    const ticket = await reserve(detail); provider();
    try { const artifact = await publish({ bytes: png, mime: "image/png" }, detail); ticket.finish("published"); return { artifact, metadata: detail }; }
    catch (e) { ticket.finish("uncertain"); throw e; }
  };
}
async function approveNext(f: ReturnType<typeof fixture>) {
  const card = await f.card();
  expect(f.operations.resolve(f.actor.threadId, card.card!.requestId!, "allow")).toBe("allowed-once");
}

it("backs up production startup schema and WAL data with image receipts into an inactive restore", async () => {
  const f = fixture(), provider = vi.fn(), work = operationWork(provider);
  expect(f.operations.resumePendingPublications()).toBe(0);
  const publishedJob = f.operations.execute(f.actor, "published", { prompt: "fixture" }, work);
  await approveNext(f);
  const published = await publishedJob;
  const pendingActor = { ...f.actor, generation: randomUUID() };
  faults.saveImage = 1;
  const pendingJob = f.operations.execute(pendingActor, "pending", { prompt: "fixture" }, work);
  const refusal = expect(pendingJob).rejects.toThrow("kept locally");
  await approveNext(f); await refusal;
  const db = database();
  db.exec("PRAGMA wal_autocheckpoint=0");
  const message = f.store.appendMessage(f.bot.threadId, { role: "user", kind: "text", text: "WAL backup canary" });
  db.exec("INSERT INTO memory_scopes VALUES('backup-scope','bot','backup-owner','[]',0)");
  db.exec("INSERT INTO memory_records VALUES('backup-memory',1,'backup-scope','fact','Retain this memory','owner-statement','active',0,1,NULL,NULL,1)");
  const operations = db.prepare("SELECT * FROM image_operations ORDER BY id").all();
  const receipts = db.prepare("SELECT * FROM output_publications ORDER BY id").all();
  const memory = db.prepare("SELECT * FROM memory_records WHERE id='backup-memory'").get();
  const originalDb = readFileSync(join(DATA_DIR, "messages.db"));
  const originalWal = readFileSync(join(DATA_DIR, "messages.db-wal"));
  const parent = dirname(DATA_DIR), archive = join(parent, "image-backup.zip");
  await writeInstallationArchive(DATA_DIR, archive);
  const prepared = await prepareInstallationRestore(archive, parent);
  expect(prepared.activationAvailable).toBe(false);
  expect(() => assertRestoreReviewed(prepared.stateDirectory)).toThrowError(expect.objectContaining({ code: "RESTORE_REVIEW_REQUIRED" }));
  const restored = new DatabaseSync(join(prepared.stateDirectory, "messages.db"), { readOnly: true });
  try {
    expect(inspectInstallationDatabase(restored).messages).toBe(db.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n);
    expect(restored.prepare("SELECT * FROM image_operations ORDER BY id").all()).toEqual(operations);
    expect(restored.prepare("SELECT * FROM output_publications ORDER BY id").all()).toEqual(receipts);
    expect(restored.prepare("SELECT * FROM memory_records WHERE id='backup-memory'").get()).toEqual(memory);
    expect(restored.prepare("SELECT mode FROM memory_meta").get()!.mode).toBe("paused");
    expect(restored.prepare("SELECT text FROM messages WHERE id=?").get(message.id)!.text).toBe("WAL backup canary");
    expect(restored.prepare("SELECT id FROM artifacts WHERE id=?").get(published.artifact.artifactId)!.id).toBe(published.artifact.artifactId);
    for (const receipt of receipts) {
      const bytes = readFileSync(join(managedImageOutputPath(prepared.stateDirectory, String(receipt.bot_id), String(receipt.thread_id)), String(receipt.path_token)));
      expect(sha(bytes)).toBe(receipt.sha256);
      expect(bytes).toEqual(png);
    }
  } finally { restored.close(); }
  expect(readFileSync(join(DATA_DIR, "messages.db"))).toEqual(originalDb);
  expect(readFileSync(join(DATA_DIR, "messages.db-wal"))).toEqual(originalWal);
  expect(provider).toHaveBeenCalledTimes(2);
});

it("retains received image bytes when attachment storage fails and resumes publication with zero provider calls", async () => {
  const f = fixture(), provider = vi.fn(), work = operationWork(provider);
  faults.saveImage = 1;
  const job = f.operations.execute(f.actor, "quota", { prompt: "fixture" }, work);
  const refusal = expect(job).rejects.toThrow("no new provider request will be sent");
  await approveNext(f); await refusal;
  expect(provider).toHaveBeenCalledOnce();
  const [receipt] = imageReceipts();
  expect(receipt).toMatchObject({ stage: "failed", error_category: "quota", sha256: sha(png), artifact_id: null, message_id: null });
  expect(readFileSync(join(managedImageOutputPath(DATA_DIR, f.bot.id, f.bot.threadId), receipt!.path_token))).toEqual(png);
  expect(imageMessages(f)).toHaveLength(0);

  const resumed = await f.operations.execute(f.actor, "quota", { prompt: "fixture" }, work);
  expect(provider).toHaveBeenCalledOnce();
  expect(resumed.artifact).toMatchObject({ id: receipt!.id, artifactId: expect.any(String) });
  expect(imageMessages(f)).toHaveLength(1);
  expect(imageReferences(f.store, f.actor.threadId, [resumed.artifact.referenceId])[0]!.bytes).toEqual(png);
  expect(describeArtifact(database(), join(DATA_DIR, "artifact-files"), resumed.artifact.artifactId, imageAccess(f))).toMatchObject({ kind: "image", producer: "image-operation", sha256: sha(png), threadId: f.bot.threadId });
  expect(imageReceipts()).toEqual([expect.objectContaining({ id: receipt!.id, stage: "registered", artifact_id: resumed.artifact.artifactId, message_id: imageMessages(f)[0]!.id })]);
  expect(await f.operations.execute(f.actor, "quota", { prompt: "fixture" }, work)).toEqual(resumed);
  expect(provider).toHaveBeenCalledOnce();
  expect(f.store.messagesFor(f.actor.threadId).filter(message => message.card?.tool === "generate_image")).toHaveLength(1);
});

it("resumes after a transcript append failure without duplicating the image message", async () => {
  const f = fixture(), provider = vi.fn(), work = operationWork(provider), append = f.store.appendMessage.bind(f.store);
  let failures = 1;
  vi.spyOn(f.store, "appendMessage").mockImplementation((threadId, message) => {
    if (message.attachments?.length && failures-- > 0) throw new Error("database is locked");
    return append(threadId, message);
  });
  const job = f.operations.execute(f.actor, "transcript", { prompt: "fixture" }, work);
  const refusal = expect(job).rejects.toThrow("(transcript)");
  await approveNext(f); await refusal;
  expect(imageReceipts()).toEqual([expect.objectContaining({ stage: "failed", error_category: "transcript" })]);
  expect(imageMessages(f)).toHaveLength(0);
  const resumed = await f.operations.execute(f.actor, "transcript", { prompt: "fixture" }, work);
  expect(provider).toHaveBeenCalledOnce();
  expect(imageMessages(f)).toHaveLength(1);
  expect(imageReceipts()).toEqual([expect.objectContaining({ id: resumed.artifact.id, stage: "registered", message_id: imageMessages(f)[0]!.id })]);
});

it("completes a retained image after a restart without provider work and keeps the request idempotent", async () => {
  const f = fixture(), provider = vi.fn(), work = operationWork(provider);
  faults.saveImage = 1;
  const job = f.operations.execute(f.actor, "restart", { prompt: "fixture" }, work);
  const refusal = expect(job).rejects.toThrow("kept locally");
  await approveNext(f); await refusal;
  closeDatabase();
  const restarted = new ImageOperations({ store: f.store, waiting: () => {} });
  expect(restarted.resumePendingPublications()).toBe(1);
  expect(restarted.resumePendingPublications()).toBe(0);
  expect(provider).toHaveBeenCalledOnce();
  expect(imageMessages(f)).toHaveLength(1);
  const again = await restarted.execute(f.actor, "restart", { prompt: "fixture" }, work);
  expect(again.artifact).toMatchObject({ id: imageReceipts()[0]!.id, artifactId: expect.any(String) });
  expect(provider).toHaveBeenCalledOnce();
  expect(imageMessages(f)).toHaveLength(1);
});

it("does not resume a retained image for a revoked actor", async () => {
  const f = fixture(), provider = vi.fn(), work = operationWork(provider);
  faults.saveImage = 1;
  const job = f.operations.execute(f.actor, "revoked", { prompt: "fixture" }, work);
  const refusal = expect(job).rejects.toThrow("kept locally");
  await approveNext(f); await refusal;
  f.revoke();
  expect(() => f.operations.execute(f.actor, "revoked", { prompt: "fixture" }, work)).toThrow("revoked");
  expect(imageMessages(f)).toHaveLength(0);
  expect(imageReceipts()).toEqual([expect.objectContaining({ stage: "failed", artifact_id: null })]);
  expect(provider).toHaveBeenCalledOnce();
});

it("keeps a generated image in the conversation when its Files copy fails and finishes registration on repeat without provider work", async () => {
  const f = fixture(), provider = vi.fn(), work = operationWork(provider);
  writeFileSync(join(DATA_DIR, "artifact-files"), "not a directory");
  const job = f.operations.execute(f.actor, "files", { prompt: "fixture" }, work);
  await approveNext(f);
  const first = await job;
  expect(first.artifact.artifactId).toBeUndefined();
  expect(first.artifact.filesError).toBe("verification");
  expect(imageMessages(f)).toHaveLength(1);
  rmSync(join(DATA_DIR, "artifact-files"));
  const repeated = await f.operations.execute(f.actor, "files", { prompt: "fixture" }, work);
  expect(repeated.artifact).toMatchObject({ id: first.artifact.id, artifactId: expect.any(String) });
  expect(provider).toHaveBeenCalledOnce();
  expect(imageMessages(f)).toHaveLength(1);
  expect(imageReceipts()).toEqual([expect.objectContaining({ stage: "registered", artifact_id: repeated.artifact.artifactId })]);
});

// B16: Flux reference-edit state, recovery, admission and route limits through ImageOperations.
const fluxEdit = { connectionId: "flux", prompt: "fixture", operation: "edit" };
const pngReference = (): ImageReference[] => [{ bytes: png, mime: "image/png" }];
const operationState = (generation: string) => (database().prepare("SELECT state FROM image_operations WHERE generation=?").get(generation) as { state: string } | undefined)?.state;
const approvalCards = (f: ReturnType<typeof fixture>) => f.store.messagesFor(f.actor.threadId).filter(message => message.card?.tool === "generate_image");

it("B16 saves the Flux edit attempt state for each provider outcome and publishes no image", async () => {
  for (const [mode, state] of [[400, "failed"], [503, "uncertain"], ["throw", "uncertain"], ["invalid-json", "uncertain"], ["deny", "not-dispatched"]] as const) {
    const f = generationFixture();
    if (mode !== "deny") f.fetcher.mockImplementationOnce(async () => {
      if (mode === "throw") throw Error("lost response");
      return typeof mode === "number" ? new Response("provider refused", { status: mode }) : new Response("not json");
    });
    const job = f.run("outcome", fluxEdit, pngReference()), refused = expect(job).rejects.toThrow();
    const card = await f.card();
    expect(f.operations.resolve(f.actor.threadId, card.card!.requestId!, mode === "deny" ? "deny" : "allow")).toBe(mode === "deny" ? "rejected" : "allowed-once");
    await refused;
    expect(operationState(f.actor.generation)).toBe(state);
    expect(f.fetcher).toHaveBeenCalledTimes(mode === "deny" ? 0 : 1);
    expect(imageMessages(f)).toHaveLength(0);
    expect(approvalCards(f)).toHaveLength(1);
  }
});

it("B16 keeps a received Flux edit locally when publication fails and finishes it on the same request_id with one fetch and one approval", async () => {
  const f = generationFixture();
  faults.saveImage = 1;
  const job = f.run("kept", fluxEdit, pngReference()), refusal = expect(job).rejects.toThrow("kept locally");
  await approveNext(f); await refusal;
  expect(operationState(f.actor.generation)).toBe("publish-pending");
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(imageMessages(f)).toHaveLength(0);
  const resumed = await f.run("kept", fluxEdit, pngReference());
  expect(operationState(f.actor.generation)).toBe("published");
  expect(resumed.artifact).toMatchObject({ artifactId: expect.any(String) });
  expect(readFileSync(resumed.artifact.path)).toEqual(png);
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(imageMessages(f)).toHaveLength(1);
  expect(approvalCards(f)).toHaveLength(1);
  expect(f.waiting.mock.calls.filter(call => call[1])).toHaveLength(1);
});

it("B16 releases an ungranted Flux alias edit before approval, while a refused OpenRouter edit keeps the turn's one attempt", async () => {
  const f = generationFixture();
  await expect(f.run("alias", { ...fluxEdit, model: "flux-image-gpt2-high" }, pngReference())).rejects.toMatchObject({ code: "unsupported-model", correctablePreflight: true });
  expect(f.waiting).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(approvalCards(f)).toHaveLength(0);
  expect(operationState(f.actor.generation)).toBeUndefined();
  const job = f.run("corrected", fluxEdit, pngReference());
  await approveNext(f); await job;
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(approvalCards(f)).toHaveLength(1);
  expect(f.waiting.mock.calls.filter(call => call[1])).toHaveLength(1);
  expect(operationState(f.actor.generation)).toBe("published");

  const o = fixture();
  const fetcher = vi.fn<typeof fetch>(async input => {
    if (String(input) === "https://openrouter.ai/api/v1/images/models") return new Response(JSON.stringify({ data: [{ id: "vendor/model", architecture: { output_modalities: ["image"] }, supported_parameters: { output_format: { values: ["png"] } } }] }));
    throw Error(`unexpected fetch ${String(input)}`);
  });
  const service = new ImageGenerationService({ resolveConnection: () => ({ id: "openrouter", provider: "openrouter", apiKey: "FAKE_B16", revision: "1" }), connectionIds: () => ["openrouter"], fetch: fetcher });
  const openRouterEdit = { connectionId: "openrouter", model: "vendor/model", prompt: "fixture", operation: "edit" };
  const run = (id: string) => o.operations.execute(o.actor, id, openRouterEdit, (reserve, publish) => service.generate(openRouterEdit, { reserve, publish, assertActive: o.actor.assertActive, signal: o.actor.signal }, pngReference()));
  await expect(run("refused")).rejects.toMatchObject({ code: "unsupported-edit", correctablePreflight: false });
  expect(operationState(o.actor.generation)).toBe("not-dispatched");
  expect(o.waiting).not.toHaveBeenCalled();
  expect(approvalCards(o)).toHaveLength(0);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  expect(() => run("new-id")).toThrow("One image attempt");
  expect(fetcher).toHaveBeenCalledOnce();
});

it("B16 resolves two exactly 10 MiB conversation PNG attachments as 20 MiB of references and refuses one more reference", () => {
  const f = fixture(), MiB = 1024 * 1024, name = (path: string) => path.split(/[\\/]/).at(-1)!;
  const exact = [1, 2].map(fill => { const bytes = Buffer.alloc(10 * MiB, fill); png.copy(bytes, 0, 0, 8); return saveImage(bytes, "image/png"); });
  const extra = saveImage(png, "image/png");
  f.store.appendMessage(f.actor.threadId, { role: "user", kind: "text", text: "references", attachments: [...exact, extra].map(item => ({ kind: "image", path: item.path, mime: item.mime })) });
  const refs = imageReferences(f.store, f.actor.threadId, exact.map(item => name(item.path)));
  expect(refs).toHaveLength(2);
  expect(refs.reduce((sum, item) => sum + item.bytes.length, 0)).toBe(20 * MiB);
  for (const [index, item] of refs.entries()) { expect(item.mime).toBe("image/png"); expect(item.bytes.length).toBe(10 * MiB); expect(item.bytes.equals(readFileSync(exact[index]!.path))).toBe(true); }
  expect(() => imageReferences(f.store, f.actor.threadId, [...exact, extra].map(item => name(item.path)))).toThrow("total at most 20 MB");
});
// 0.1.54: an image approval is an approval like any other. It used to deny
// itself after 60 s, so an owner who was not staring at the screen found a
// "Denied" card and never got the chance to answer.
it("image approval waits like any other approval and settles as not answered on abort", async () => {
  vi.useFakeTimers();
  try {
    const f = generationFixture();
    const job = f.run("patient", f.request), refused = expect(job).rejects.toThrow("not approved");
    const card = await f.card(), requestId = card.card!.requestId!;
    expect(f.waiting).toHaveBeenLastCalledWith(f.bot.threadId, true, requestId, card.id, f.bot.id);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(IMAGE_APPROVAL_TIMEOUT_MS - 60_000 - 5_000); // vi.waitFor already advanced the clock a little
    const stillOpen = f.store.messagesFor(f.bot.threadId).find(m => m.id === card.id)!.card!;
    expect(stillOpen.answered).toBeUndefined(); expect(stillOpen.dismissed).toBeFalsy();
    expect(f.waiting.mock.calls.filter(call => call[1] === false)).toHaveLength(0);
    f.controller.abort(); await refused;
    const settled = f.store.messagesFor(f.bot.threadId).find(m => m.id === card.id)!.card!;
    expect(settled.answered).toBe("unavailable"); expect(settled.dismissed).toBe(true);
    expect(f.waiting).toHaveBeenLastCalledWith(f.bot.threadId, false, requestId, undefined, f.bot.id);
    expect(f.fetcher).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
it("image approval times out on the shared permission bound as not answered, never as the owner's denial", async () => {
  vi.useFakeTimers();
  try {
    expect(IMAGE_APPROVAL_TIMEOUT_MS).toBe(15 * 60_000);
    const f = generationFixture();
    const job = f.run("late", f.request), refused = expect(job).rejects.toThrow("not approved");
    const card = await f.card();
    await vi.advanceTimersByTimeAsync(IMAGE_APPROVAL_TIMEOUT_MS);
    await refused;
    const settled = f.store.messagesFor(f.bot.threadId).find(m => m.id === card.id)!.card!;
    expect(settled.answered).toBe("unavailable"); expect(settled.dismissed).toBe(true);
    expect(f.operations.resolve(f.bot.threadId, card.card!.requestId!, "allow")).toBe("unavailable");
    expect(f.fetcher).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
it("the owner's own deny stays a denial and their allow dispatches exactly once", async () => {
  const f = generationFixture();
  const job = f.run("owner", f.request), refused = expect(job).rejects.toThrow("not approved");
  const card = await f.card();
  expect(f.operations.resolve(f.bot.threadId, card.card!.requestId!, "deny")).toBe("rejected"); await refused;
  const settled = f.store.messagesFor(f.bot.threadId).find(m => m.id === card.id)!.card!;
  expect(settled.answered).toBe("deny"); expect(settled.dismissed).toBe(false);
});
it("names the asking bot to the waiting hook and stamps a channel card with its sender",async()=>{
 const store=new Store(()=>({instanceId:"fixture",model:"fixture"}));const bot=store.createBot();
 const controller=new AbortController();
 const actor={botId:bot.id,threadId:"channel-thread",generation:randomUUID(),signal:controller.signal,assertActive:()=>{}};
 const waiting=vi.fn(),from={botId:bot.id,name:"Sable",color:"#fff"};
 const speaker=vi.fn(()=>from);
 const operations=new ImageOperations({store,waiting,speaker});
 const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({data:[{b64_json:png.toString("base64")}]})));
 const service=new ImageGenerationService({resolveConnection:()=>({id:"flux",provider:"flux",apiKey:"FAKE_B15",revision:"1"}),connectionIds:()=>["flux"],fetch:fetcher});
 const request={connectionId:"flux",prompt:"fixture"};
 const job=operations.execute(actor,"channel",request,(reserve,publish)=>service.generate(request,{reserve,publish,assertActive:actor.assertActive,signal:actor.signal},[])).catch(()=>undefined);
 await vi.waitFor(()=>expect(store.messagesFor("channel-thread").some(m=>m.card?.tool==="generate_image")).toBe(true));
 const card=store.messagesFor("channel-thread").find(m=>m.card?.tool==="generate_image")!;
 expect(speaker).toHaveBeenCalledWith("channel-thread",bot.id);
 expect(card.from).toEqual(from);
 expect(waiting).toHaveBeenCalledWith("channel-thread",true,card.card!.requestId,card.id,bot.id);
 operations.resolve("channel-thread",card.card!.requestId!,"deny");await job;
 expect(waiting).toHaveBeenLastCalledWith("channel-thread",false,card.card!.requestId,undefined,bot.id);
});
// 0.1.60: in a scheduled or manual routine run the paid-image card is held
// open like a permission card. It never closes for waiting; if the tool call
// gives up first (its turn ends), the card stays answerable, the run waits on
// the owner, and an allow then covers the next image in that conversation
// once, when the run carries on.
it("a routine run holds its image card open past the bound and past its turn", async () => {
  vi.useFakeTimers();
  try {
    const events: string[] = [];
    let resumed = false;
    const f = generationFixture();
    const held = new ImageOperations({ store: f.store, waiting: f.waiting, routineCard: {
      opened: (_threadId, _requestId, summary) => { events.push(`opened:${summary}`); return true; },
      closed: (_threadId, _requestId, answer) => { events.push(`closed:${answer}`); return resumed; },
    } });
    const service = new ImageGenerationService({ resolveConnection: () => ({ id: "flux", provider: "flux", apiKey: "FAKE_B15", revision: "1" }), connectionIds: () => ["flux"], fetch: f.fetcher });
    const run = (id: string, actor = f.actor) => held.execute(actor, id, f.request, (reserve, publish) => service.generate(f.request, { reserve, publish, assertActive: actor.assertActive, signal: actor.signal }, []));
    const job = run("held"), refused = expect(job).rejects.toThrow("not approved");
    const card = await f.card();
    await vi.advanceTimersByTimeAsync(IMAGE_APPROVAL_TIMEOUT_MS + 60 * 60_000);
    expect(f.store.messagesFor(f.bot.threadId).find(m => m.id === card.id)!.card!.answered).toBeUndefined();
    // the tool call gives up (its turn ended): the card stays answerable
    f.controller.abort(); f.revoke(); await refused;
    expect(f.store.messagesFor(f.bot.threadId).find(m => m.id === card.id)!.card!.answered).toBeUndefined();
    resumed = true;
    expect(held.resolve(f.bot.threadId, card.card!.requestId!, "allow")).toBe("allowed-once");
    expect(f.store.messagesFor(f.bot.threadId).find(m => m.id === card.id)!.card!.answered).toBe("allow");
    expect(events).toEqual(["opened:Approve image generation", "closed:allow"]);
    // the run carries on in a new turn: that image is already approved
    const next = { ...f.actor, generation: randomUUID(), signal: new AbortController().signal, assertActive: () => {} };
    await run("carried-on", next);
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.store.messagesFor(f.bot.threadId).filter(m => m.card?.tool === "generate_image")).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});
