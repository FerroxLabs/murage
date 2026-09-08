import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { Store } from "./store.ts";
import { saveImage } from "./attachments.ts";
import { ImageOperations, imageReferences, publishImage } from "./image-operations.ts";
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
it.skipIf(process.platform==="win32")("refuses symlinked image workspaces without writing outside the bot",()=>{
 const f=fixture(),parent=join(DATA_DIR,"workspaces"),target=join(DATA_DIR,"other-private-workspace");mkdirSync(parent,{recursive:true});mkdirSync(target);symlinkSync(target,join(parent,f.bot.id));
 expect(()=>publishImage(f.store,f.actor,{bytes:png,mime:"image/png"},detail)).toThrow("private directory");expect(existsSync(join(target,"generated-images"))).toBe(false);
});
it("refuses publication after authority is revoked",()=>{
 const f=fixture();f.revoke();expect(()=>publishImage(f.store,f.actor,{bytes:png,mime:"image/png"},detail)).toThrow("revoked");expect(existsSync(join(DATA_DIR,"workspaces",f.bot.id,"generated-images"))).toBe(false);
});
