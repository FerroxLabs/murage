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
import { ImageOperations, imageReferences, publishImage } from "./image-operations.ts";
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
