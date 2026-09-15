import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TelegramService, TelegramTokenRefusal } from "./telegram-service.ts";
import * as atomic from "./atomic.ts";
import type { TelegramTransport } from "./telegram-transport.ts";
import { TelegramTransportError } from "./telegram-transport.ts";

it("verifies identity before polling and stops admissions on revoke", async () => {
  vi.useFakeTimers();
  const dataDir = mkdtempSync(join(tmpdir(), "murage-telegram-service-"));
  let updates: any[] = [];
  const transport = { getMe: vi.fn(async () => ({ id: "123", username: "fixture_bot" })),
    getUpdates: vi.fn(async () => updates), sendMessage: vi.fn(async () => ({ chatId: "7", messageId: 9 })) };
  const enqueue = vi.fn(() => ({ id: "run" })), revokeRuns = vi.fn(async () => {});
  const service = new TelegramService({ dataDir, transport: () => transport as unknown as TelegramTransport,
    enqueue, revokeRuns, runResult: () => ({ status: "completed", output: "Done" }) });
  const update = (id: number, text: string) => ({ update_id: id, message: { message_id: id, date: 1,
    from: { id: 7, is_bot: false }, chat: { id: 7, type: "private" }, text } });
  try {
    expect(transport.getUpdates).not.toHaveBeenCalled();
    const paired = await service.pair("fake", "chief");
    expect(transport.getMe).toHaveBeenCalledOnce();
    updates = [update(1, "/pair " + paired.code)];
    await vi.advanceTimersByTimeAsync(1500);
    expect(service.status().paired).toBe(true);
    updates = [update(2, "help")];
    await vi.advanceTimersByTimeAsync(1500);
    expect(enqueue).toHaveBeenCalledWith("123", "chief", expect.objectContaining({ deliveryId: "telegram:123:2" }));
    expect(transport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: "7", text: "Done" }));
    await service.revoke();
    expect(revokeRuns).toHaveBeenCalledWith("123");
    updates = [update(3, "do not run")];
    await vi.advanceTimersByTimeAsync(3000);
    expect(enqueue).toHaveBeenCalledTimes(1);
  } finally { service.stop(); vi.useRealTimers(); rmSync(dataDir, { recursive: true, force: true }); }
});

const restartFixtures: Array<{ root: string; services: TelegramService[] }> = [];
afterEach(() => { for (const fixture of restartFixtures.splice(0)) { fixture.services.forEach(service => service.stop()); rmSync(fixture.root, { recursive: true, force: true }); } vi.restoreAllMocks(); vi.useRealTimers(); });
function restartFixture() {
 vi.useFakeTimers();
 const root=mkdtempSync(join(tmpdir(),"telegram-resume-")),services:TelegramService[]=[]; restartFixtures.push({root,services});
 let updates:any[]=[];
 const transport={getMe:vi.fn(async(_signal?:AbortSignal)=>({id:"123",username:"fixture_bot"})),getUpdates:vi.fn(async()=>updates),sendMessage:vi.fn(async()=>({chatId:"7",messageId:1}))};
 const enqueue=vi.fn(()=>({id:"run"})),revokeRuns=vi.fn(async()=>{});
 // Per-token transports (B17 token replacement): unknown tokens use the default fixture bot.
 const tokens:Record<string,unknown>={};
 const botTransport=(id:string)=>({getMe:vi.fn(async(_signal?:AbortSignal)=>({id,username:"fixture_bot"})),getUpdates:vi.fn(async()=>updates),sendMessage:vi.fn(async()=>({chatId:"7",messageId:1}))});
 const useToken=<T,>(token:string,value:T)=>{tokens[token]=value;return value;};
 const make=(isCurrentTarget?: (id:string)=>boolean)=>{const service=new TelegramService({dataDir:root,transport:token=>(tokens[token]??transport) as unknown as TelegramTransport,enqueue,revokeRuns,runResult:()=>({status:"completed",output:"Done"}),isCurrentTarget});services.push(service);return service;};
 const update=(id:number,text:string)=>({update_id:id,message:{message_id:id,date:1,from:{id:7,is_bot:false},chat:{id:7,type:"private"},text}});
 const pair=async(isCurrentTarget?: (id:string)=>boolean)=>{const service=make(isCurrentTarget);const result=await service.pair("FAKE_TOKEN_NOT_REAL","chief");updates=[update(1,"/pair "+result.code)];await vi.advanceTimersByTimeAsync(1500);expect(service.status().paired).toBe(true);updates=[];return service;};
 return{root,transport,enqueue,revokeRuns,make,pair,update,botTransport,useToken,setUpdates:(value:any[])=>{updates=value;}};
}
it("restores the exact paired Telegram identity and Murage target after restart without a new code",async()=>{
 const f=restartFixture(),original=await f.pair();original.stop();
 const connection=JSON.parse(readFileSync(join(f.root,"telegram","connection.json"),"utf8"));
 expect(connection).toEqual({version:1,botIdentityId:"123",targetBotId:"chief",enabled:true});
 expect(JSON.parse(readFileSync(join(f.root,"telegram","123.json"),"utf8")).targetBotId).toBe("chief");
 if(process.platform!=="win32")expect(statSync(join(f.root,"telegram","connection.json")).mode&0o777).toBe(0o600);
 const restarted=f.make();expect(await restarted.resume("FAKE_TOKEN_NOT_REAL","chief")).toBe(true);
 expect(restarted.status()).toMatchObject({enabled:true,paired:true,resumeState:"active"});
 expect(f.transport.getMe).toHaveBeenCalledTimes(2);
 f.setUpdates([f.update(2,"after restart")]);await vi.advanceTimersByTimeAsync(1500);
 expect(f.enqueue).toHaveBeenCalledExactlyOnceWith("123","chief",expect.objectContaining({deliveryId:"telegram:123:2"}));
 expect(readFileSync(join(f.root,"telegram","connection.json"),"utf8")).not.toContain("FAKE_TOKEN");
});
it("does not resume a revoked connection, a pending-only challenge, or a changed target",async()=>{
 const f=restartFixture(),pending=f.make();await pending.pair("fake","chief");pending.stop();
 const pendingRestart=f.make();expect(await pendingRestart.resume("fake","chief")).toBe(false);expect(pendingRestart.status().resumeState).toBe("pair-required");
 await vi.advanceTimersByTimeAsync(3000);expect(f.transport.getUpdates).not.toHaveBeenCalled();
 const changed=f.make();const before=f.transport.getMe.mock.calls.length;expect(await changed.resume("fake","other-chief")).toBe(false);expect(f.transport.getMe).toHaveBeenCalledTimes(before);
 await pending.revoke();const revoked=f.make();expect(await revoked.resume("fake","chief")).toBe(false);expect(f.transport.getMe).toHaveBeenCalledTimes(before);
 expect(revoked.status()).toMatchObject({enabled:false,paired:false});
});
it("rejects a different Telegram bot identity before polling the saved channel",async()=>{
 const f=restartFixture(),original=await f.pair();original.stop();const before=f.transport.getUpdates.mock.calls.length;
 f.transport.getMe.mockResolvedValueOnce({id:"456",username:"other_bot"});
 const restarted=f.make();expect(await restarted.resume("fake","chief")).toBe(false);expect(restarted.status()).toMatchObject({resumeState:"blocked",paired:false});
 await vi.advanceTimersByTimeAsync(3000);expect(f.transport.getUpdates).toHaveBeenCalledTimes(before);
});
it("requires one-time pairing for legacy state without target provenance or a selector",async()=>{
 const f=restartFixture(),original=await f.pair();original.stop();
 const file=join(f.root,"telegram","123.json"),state=JSON.parse(readFileSync(file,"utf8"));delete state.targetBotId;writeFileSync(file,JSON.stringify(state));
 const restarted=f.make();expect(await restarted.resume("fake","chief")).toBe(false);expect(restarted.status().resumeMessage).toContain("one-time");
 rmSync(join(f.root,"telegram","connection.json"));const noSelector=f.make();expect(await noSelector.resume("fake","chief")).toBe(false);expect(noSelector.status().resumeState).toBe("pair-required");
});
it("preserves corrupt selector and channel bytes and never starts polling them",async()=>{
 const f=restartFixture(),original=await f.pair();original.stop();const before=f.transport.getUpdates.mock.calls.length;
 const channelFile=join(f.root,"telegram","123.json");writeFileSync(channelFile,"CORRUPT_CHANNEL_CANARY");
 const restarted=f.make();expect(await restarted.resume("fake","chief")).toBe(false);expect(restarted.status().resumeState).toBe("blocked");expect(readFileSync(channelFile,"utf8")).toBe("CORRUPT_CHANNEL_CANARY");
 const selector=join(f.root,"telegram","connection.json");writeFileSync(selector,"CORRUPT_SELECTOR_CANARY");
 const corruptSelector=f.make();expect(await corruptSelector.resume("fake","chief")).toBe(false);expect(readFileSync(selector,"utf8")).toBe("CORRUPT_SELECTOR_CANARY");await vi.advanceTimersByTimeAsync(3000);expect(f.transport.getUpdates).toHaveBeenCalledTimes(before);
});
it("keeps pairing for a transient identity-check failure and reconnects automatically without UI retry",async()=>{
 const f=restartFixture(),original=await f.pair();original.stop();f.transport.getMe.mockRejectedValueOnce(new Error("offline fixture"));
 const restarted=f.make();expect(await restarted.resume("fake","chief")).toBe(false);expect(restarted.status()).toMatchObject({resumeState:"retry",requiresRevoke:true,paired:false});
 expect(restarted.status().nextRetryAt).toBeGreaterThan(Date.now());await vi.advanceTimersByTimeAsync(1499);expect(f.transport.getMe).toHaveBeenCalledTimes(2);
 await vi.advanceTimersByTimeAsync(1);expect(restarted.status()).toMatchObject({resumeState:"active",paired:true});
 f.setUpdates([f.update(2,"after automatic reconnect")]);await vi.advanceTimersByTimeAsync(1500);expect(f.enqueue).toHaveBeenCalledExactlyOnceWith("123","chief",expect.objectContaining({deliveryId:"telegram:123:2"}));
});
it("honours an initial provider retry_after longer than the local backoff cap",async()=>{
 const f=restartFixture(),original=await f.pair();original.stop();f.transport.getMe.mockRejectedValueOnce(new TelegramTransportError("rate-limit",{retryAfterSeconds:120}));
 const restarted=f.make();expect(await restarted.resume("fake","chief")).toBe(false);expect(restarted.status().nextRetryAt).toBe(Date.now()+120000);
 await vi.advanceTimersByTimeAsync(119999);expect(f.transport.getMe).toHaveBeenCalledTimes(2);await vi.advanceTimersByTimeAsync(1);expect(restarted.status()).toMatchObject({resumeState:"active",paired:true});
});
it("honours polling retry_after and pauses terminal receiver conflicts without clearing the saved pairing",async()=>{
 const f=restartFixture(),service=await f.pair();f.transport.getUpdates.mockRejectedValueOnce(new TelegramTransportError("rate-limit",{retryAfterSeconds:12}));
 await vi.advanceTimersByTimeAsync(1500);expect(service.status()).toMatchObject({resumeState:"active",error:"rate-limit",deliveryError:null,nextRetryAt:Date.now()+12000});const calls=f.transport.getUpdates.mock.calls.length;
 await vi.advanceTimersByTimeAsync(11999);expect(f.transport.getUpdates).toHaveBeenCalledTimes(calls);await vi.advanceTimersByTimeAsync(1);expect(f.transport.getUpdates).toHaveBeenCalledTimes(calls+1);
 f.transport.getUpdates.mockRejectedValueOnce(new TelegramTransportError("conflict"));await vi.advanceTimersByTimeAsync(1500);expect(service.status()).toMatchObject({resumeState:"blocked",error:"conflict",paired:false,requiresRevoke:true});
 const terminalCalls=f.transport.getUpdates.mock.calls.length;await vi.advanceTimersByTimeAsync(30000);expect(f.transport.getUpdates).toHaveBeenCalledTimes(terminalCalls);
 expect(JSON.parse(readFileSync(join(f.root,"telegram","connection.json"),"utf8")).enabled).toBe(true);
 const bindingBefore=readFileSync(join(f.root,"telegram","123.json"),"utf8");
 expect(service.status().canResume).toBe(true);expect(service.status().resumeMessage).toContain("Retry now");
 expect(await service.resume("fake","chief")).toBe(true);expect(service.status()).toMatchObject({resumeState:"active",paired:true,error:null,canResume:false});
 expect(readFileSync(join(f.root,"telegram","123.json"),"utf8")).toBe(bindingBefore);
 expect(await service.resume("fake","chief")).toBe(false);
});
it.each(["auth","forbidden"] as const)("does not offer conflict Retry for %s",async(code)=>{
 const f=restartFixture(),service=await f.pair();f.transport.getUpdates.mockRejectedValueOnce(new TelegramTransportError(code));
 await vi.advanceTimersByTimeAsync(1500);expect(service.status()).toMatchObject({resumeState:"blocked",canResume:false});
});
it("clears conflict Retry when fresh identity verification rejects a different bot",async()=>{
 const f=restartFixture(),service=await f.pair();f.transport.getUpdates.mockRejectedValueOnce(new TelegramTransportError("conflict"));await vi.advanceTimersByTimeAsync(1500);
 f.transport.getMe.mockResolvedValueOnce({id:"456",username:"other_bot"});expect(await service.resume("fake","chief")).toBe(false);
 expect(service.status()).toMatchObject({resumeState:"blocked",canResume:false});const polls=f.transport.getUpdates.mock.calls.length;
 await vi.advanceTimersByTimeAsync(3000);expect(f.transport.getUpdates).toHaveBeenCalledTimes(polls);
});
for(const action of ["stop","revoke"] as const)it(`${action} fences a late identity-check response during restart`,async()=>{
 const f=restartFixture(),original=await f.pair();original.stop();let resolve!:(value:{id:string;username:string})=>void;
 f.transport.getMe.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));const before=f.transport.getUpdates.mock.calls.length;
 const restarted=f.make(),resuming=restarted.resume("fake","chief");expect(restarted.status().connecting).toBe(true);
 await restarted[action]();resolve({id:"123",username:"fixture_bot"});expect(await resuming).toBe(false);
 await vi.advanceTimersByTimeAsync(3000);expect(f.transport.getUpdates).toHaveBeenCalledTimes(before);expect(restarted.status().paired).toBe(false);
 if(action==="revoke")expect(await f.make().resume("fake","chief")).toBe(false);
});
it("rechecks the exact target after asynchronous identity verification",async()=>{
 const f=restartFixture(),original=await f.pair();original.stop();let valid=true;let resolve!:(value:{id:string;username:string})=>void;
 f.transport.getMe.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));const restarted=f.make(()=>valid),resuming=restarted.resume("fake","chief");valid=false;resolve({id:"123",username:"fixture_bot"});expect(await resuming).toBe(false);expect(restarted.status().resumeState).toBe("blocked");
});
it("does not replay uncertain sends when the pairing resumes",async()=>{
 const f=restartFixture(),original=await f.pair();f.transport.sendMessage.mockRejectedValueOnce(new Error("uncertain fixture"));f.setUpdates([f.update(2,"work")]);await vi.advanceTimersByTimeAsync(1500);expect(original.status().uncertain).toBe(1);original.stop();
 const restarted=f.make();expect(await restarted.resume("fake","chief")).toBe(true);await vi.advanceTimersByTimeAsync(1500);expect(restarted.status().uncertain).toBe(1);expect(f.transport.sendMessage).toHaveBeenCalledTimes(2);expect(f.enqueue).toHaveBeenCalledTimes(1); // pairing confirmation + uncertain reply
});
it("fences revoke even if selector writing fails and the durable channel revoke prevents restart",async()=>{
 const f=restartFixture(),original=await f.pair();vi.spyOn(atomic,"writeFileAtomic").mockImplementationOnce(()=>{throw new Error("fixture selector write failure");});
 await expect(original.revoke()).rejects.toThrow("could not be fully revoked");expect(original.status().paired).toBe(false);
 expect(await f.make().resume("fake","chief")).toBe(false);
});

// B17 T1: a token Telegram rejected (401) is replaced only by a token getMe proves belongs to the SAME bot.
const connectionBytes=(root:string)=>readFileSync(join(root,"telegram","connection.json"),"utf8");
const channelState=(root:string)=>JSON.parse(readFileSync(join(root,"telegram","123.json"),"utf8"));
async function rejectedToken(f:ReturnType<typeof restartFixture>,isCurrentTarget?:(id:string)=>boolean){
 const service=await f.pair(isCurrentTarget);f.transport.getUpdates.mockRejectedValueOnce(new TelegramTransportError("auth"));await vi.advanceTimersByTimeAsync(1500);return service;
}
it("replaces a rejected token with a same-bot token and resumes the saved pairing without revoking (T1.same-bot-resume)",async()=>{
 const f=restartFixture(),service=await rejectedToken(f);
 expect(service.status()).toMatchObject({resumeState:"blocked",error:"auth",canResume:false,canReplaceToken:true,requiresRevoke:true,paired:false});
 expect(service.status().resumeMessage).toContain("Paste a new token for this same bot");
 const selector=connectionBytes(f.root),before=channelState(f.root),oldPolls=f.transport.getUpdates.mock.calls.length;
 const fresh=f.useToken("NEW_TOKEN_NOT_REAL",f.botTransport("123")),commit=vi.fn();
 expect(await service.replaceToken("NEW_TOKEN_NOT_REAL","chief",commit)).toBe(true);
 expect(commit).toHaveBeenCalledOnce();expect(fresh.getMe.mock.invocationCallOrder[0]).toBeLessThan(commit.mock.invocationCallOrder[0]);expect(fresh.getMe).toHaveBeenCalledTimes(2);
 expect(service.status()).toMatchObject({resumeState:"active",paired:true,error:null,canResume:false,canReplaceToken:false});
 const after=channelState(f.root);expect(connectionBytes(f.root)).toBe(selector);expect(after.binding).toEqual(before.binding);expect(after.offset).toBe(before.offset);expect(after.targetBotId).toBe("chief");
 expect(f.revokeRuns).not.toHaveBeenCalled();
 f.setUpdates([f.update(2,"after token replacement")]);await vi.advanceTimersByTimeAsync(1500);
 expect(f.enqueue).toHaveBeenCalledExactlyOnceWith("123","chief",expect.objectContaining({deliveryId:"telegram:123:2"}));
 expect(fresh.getUpdates).toHaveBeenCalled();expect(f.transport.getUpdates).toHaveBeenCalledTimes(oldPolls);
});
it("refuses a token for a different bot before commit and keeps the connection replaceable (T1.wrong-bot-refused)",async()=>{
 const f=restartFixture(),service=await rejectedToken(f),selector=connectionBytes(f.root),channelBytes=readFileSync(join(f.root,"telegram","123.json"),"utf8"),polls=f.transport.getUpdates.mock.calls.length;
 const other=f.useToken("OTHER_BOT_TOKEN_NOT_REAL",f.botTransport("456")),commit=vi.fn();
 const error=await service.replaceToken("OTHER_BOT_TOKEN_NOT_REAL","chief",commit).catch((value:unknown)=>value);
 expect(error).toBeInstanceOf(TelegramTokenRefusal);expect((error as TelegramTokenRefusal).status).toBe(409);expect((error as Error).message).toContain("different Telegram bot");
 expect(commit).not.toHaveBeenCalled();expect(other.getMe).toHaveBeenCalledOnce();
 expect(service.status()).toMatchObject({resumeState:"blocked",connecting:false,canReplaceToken:true,canResume:false,paired:false});expect(service.status().resumeMessage).toContain("different Telegram bot");
 await vi.advanceTimersByTimeAsync(3000);expect(other.getUpdates).not.toHaveBeenCalled();expect(f.transport.getUpdates).toHaveBeenCalledTimes(polls);
 expect(connectionBytes(f.root)).toBe(selector);expect(readFileSync(join(f.root,"telegram","123.json"),"utf8")).toBe(channelBytes);expect(f.revokeRuns).not.toHaveBeenCalled();
});
it.each([["auth",new TelegramTransportError("auth"),"rejected the new token too"],["offline",new Error("offline fixture"),"Could not check the new token"],["invalid-config",new TelegramTransportError("invalid-config"),"not a Telegram bot token"]] as const)("refuses a replacement whose verification fails (%s) without saving, then accepts a verified retry (T1.replacement-failures)",async(_code,failure,message)=>{
 const f=restartFixture(),service=await rejectedToken(f),fresh=f.useToken("NEW_TOKEN_NOT_REAL",f.botTransport("123")),commit=vi.fn();
 fresh.getMe.mockRejectedValueOnce(failure);
 const error=await service.replaceToken("NEW_TOKEN_NOT_REAL","chief",commit).catch((value:unknown)=>value);
 expect(error).toBeInstanceOf(TelegramTokenRefusal);expect((error as Error).message).toContain(message);expect(commit).not.toHaveBeenCalled();
 expect(service.status()).toMatchObject({resumeState:"blocked",connecting:false,canReplaceToken:true,canResume:false});expect(service.status().resumeMessage).toContain(message);
 await vi.advanceTimersByTimeAsync(3000);expect(fresh.getUpdates).not.toHaveBeenCalled();
 expect(await service.replaceToken("NEW_TOKEN_NOT_REAL","chief",commit)).toBe(true);expect(commit).toHaveBeenCalledOnce();expect(service.status()).toMatchObject({resumeState:"active",paired:true});
});
it.each(["forbidden","conflict"] as const)("does not offer token replacement for %s (T1.not-for-forbidden-or-conflict)",async(code)=>{
 const f=restartFixture(),service=await f.pair();f.transport.getUpdates.mockRejectedValueOnce(new TelegramTransportError(code));await vi.advanceTimersByTimeAsync(1500);
 expect(service.status()).toMatchObject({resumeState:"blocked",error:code,canReplaceToken:false,canResume:code==="conflict"});
 const fresh=f.useToken("NEW_TOKEN_NOT_REAL",f.botTransport("123")),commit=vi.fn();
 await expect(service.replaceToken("NEW_TOKEN_NOT_REAL","chief",commit)).rejects.toThrow("Revoke Telegram before changing its token or target.");
 expect(fresh.getMe).not.toHaveBeenCalled();expect(commit).not.toHaveBeenCalled();expect(service.status()).toMatchObject({resumeState:"blocked",canReplaceToken:false});
});
it("makes a saved token rejected at startup replaceable and resumes the same pairing (T1.boot-401-replaceable)",async()=>{
 const f=restartFixture(),original=await f.pair();original.stop();const polls=f.transport.getUpdates.mock.calls.length,selector=connectionBytes(f.root),binding=channelState(f.root).binding;
 f.transport.getMe.mockRejectedValueOnce(new TelegramTransportError("auth"));
 const restarted=f.make();expect(await restarted.resume("FAKE_TOKEN_NOT_REAL","chief")).toBe(false);
 expect(restarted.status()).toMatchObject({resumeState:"blocked",canReplaceToken:true,canResume:false,requiresRevoke:true,paired:false});expect(restarted.status().resumeMessage).toContain("Paste a new token");
 await vi.advanceTimersByTimeAsync(3000);expect(f.transport.getUpdates).toHaveBeenCalledTimes(polls);
 const fresh=f.useToken("NEW_TOKEN_NOT_REAL",f.botTransport("123")),commit=vi.fn();
 expect(await restarted.replaceToken("NEW_TOKEN_NOT_REAL","chief",commit)).toBe(true);expect(commit).toHaveBeenCalledOnce();expect(fresh.getMe).toHaveBeenCalledTimes(2);
 expect(restarted.status()).toMatchObject({resumeState:"active",paired:true,canReplaceToken:false});expect(connectionBytes(f.root)).toBe(selector);expect(channelState(f.root).binding).toEqual(binding);expect(f.revokeRuns).not.toHaveBeenCalled();
});
it.each([true,false])("refuses replacement without contacting Telegram once the paired Chief changed (revalidated first: %s) (T1.chief-fence before verify)",async(revalidated)=>{
 let valid=true;const f=restartFixture(),service=await rejectedToken(f,()=>valid);expect(service.status().canReplaceToken).toBe(true);
 valid=false;if(revalidated){await service.revalidateTarget();expect(service.status()).toMatchObject({resumeState:"blocked",canReplaceToken:false});}
 const fresh=f.useToken("NEW_TOKEN_NOT_REAL",f.botTransport("123")),commit=vi.fn();
 const error=await service.replaceToken("NEW_TOKEN_NOT_REAL","chief",commit).catch((value:unknown)=>value);
 expect(error).toBeInstanceOf(TelegramTokenRefusal);expect((error as Error).message).toContain(revalidated?"Revoke Telegram before changing":"Chief changed");
 expect(fresh.getMe).not.toHaveBeenCalled();expect(commit).not.toHaveBeenCalled();
 expect(JSON.parse(connectionBytes(f.root)).paused).toBe(true);expect(service.status()).toMatchObject({resumeState:"blocked",canReplaceToken:false,canResume:false});
});
it("fences a Chief change during replacement verification (T1.chief-fence during verify)",async()=>{
 let valid=true;const f=restartFixture(),service=await rejectedToken(f,()=>valid);let resolve!:(value:{id:string;username:string})=>void;
 const fresh=f.useToken("NEW_TOKEN_NOT_REAL",f.botTransport("123")),commit=vi.fn();fresh.getMe.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
 const replacing=service.replaceToken("NEW_TOKEN_NOT_REAL","chief",commit).catch((value:unknown)=>value);
 expect(service.status()).toMatchObject({connecting:true,resumeState:"verifying",canReplaceToken:false});
 valid=false;await service.revalidateTarget();resolve({id:"123",username:"fixture_bot"});
 const error=await replacing;expect(error).toBeInstanceOf(TelegramTokenRefusal);expect((error as Error).message).toContain("changed while the new token was being checked");
 expect(commit).not.toHaveBeenCalled();expect(JSON.parse(connectionBytes(f.root)).paused).toBe(true);expect(service.status()).toMatchObject({resumeState:"blocked",canReplaceToken:false});
 await vi.advanceTimersByTimeAsync(3000);expect(fresh.getUpdates).not.toHaveBeenCalled();
});
it("fences revoke during replacement verification (T1.revoke-during-verify)",async()=>{
 const f=restartFixture(),service=await rejectedToken(f);let resolve!:(value:{id:string;username:string})=>void;
 const fresh=f.useToken("NEW_TOKEN_NOT_REAL",f.botTransport("123")),commit=vi.fn();fresh.getMe.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
 const replacing=service.replaceToken("NEW_TOKEN_NOT_REAL","chief",commit).catch((value:unknown)=>value);
 await service.revoke();resolve({id:"123",username:"fixture_bot"});
 const error=await replacing;expect(error).toBeInstanceOf(TelegramTokenRefusal);expect((error as Error).message).toContain("changed while the new token was being checked");
 expect(commit).not.toHaveBeenCalled();expect(service.status()).toMatchObject({resumeState:"idle",canReplaceToken:false,paired:false});
 await vi.advanceTimersByTimeAsync(3000);expect(fresh.getUpdates).not.toHaveBeenCalled();expect(await f.make().resume("NEW_TOKEN_NOT_REAL","chief")).toBe(false);
});
it("keeps the rejected connection replaceable when saving the verified token fails (T1.commit-failure)",async()=>{
 const f=restartFixture(),service=await rejectedToken(f),fresh=f.useToken("NEW_TOKEN_NOT_REAL",f.botTransport("123"));
 const commit=vi.fn(()=>{throw new Error("fixture config write failure");});
 await expect(service.replaceToken("NEW_TOKEN_NOT_REAL","chief",commit)).rejects.toThrow("fixture config write failure");
 expect(service.status()).toMatchObject({resumeState:"blocked",connecting:false,canReplaceToken:true,canResume:false});
 await vi.advanceTimersByTimeAsync(3000);expect(fresh.getMe).toHaveBeenCalledOnce();expect(fresh.getUpdates).not.toHaveBeenCalled();expect(f.revokeRuns).not.toHaveBeenCalled();
});
