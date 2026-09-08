import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TelegramService } from "./telegram-service.ts";
import * as atomic from "./atomic.ts";
import type { TelegramTransport } from "./telegram-transport.ts";

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
 const make=(isCurrentTarget?: (id:string)=>boolean)=>{const service=new TelegramService({dataDir:root,transport:()=>transport as unknown as TelegramTransport,enqueue,revokeRuns,runResult:()=>({status:"completed",output:"Done"}),isCurrentTarget});services.push(service);return service;};
 const update=(id:number,text:string)=>({update_id:id,message:{message_id:id,date:1,from:{id:7,is_bot:false},chat:{id:7,type:"private"},text}});
 const pair=async()=>{const service=make();const result=await service.pair("FAKE_TOKEN_NOT_REAL","chief");updates=[update(1,"/pair "+result.code)];await vi.advanceTimersByTimeAsync(1500);expect(service.status().paired).toBe(true);updates=[];return service;};
 return{root,transport,enqueue,revokeRuns,make,pair,update,setUpdates:(value:any[])=>{updates=value;}};
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
it("keeps pairing for a transient identity-check failure and reconnects on explicit retry",async()=>{
 const f=restartFixture(),original=await f.pair();original.stop();f.transport.getMe.mockRejectedValueOnce(new Error("offline fixture"));
 const restarted=f.make();expect(await restarted.resume("fake","chief")).toBe(false);expect(restarted.status()).toMatchObject({resumeState:"retry",requiresRevoke:true,paired:false});
 expect(await restarted.resume("fake","chief")).toBe(true);expect(restarted.status().paired).toBe(true);
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
 const restarted=f.make();expect(await restarted.resume("fake","chief")).toBe(true);await vi.advanceTimersByTimeAsync(1500);expect(restarted.status().uncertain).toBe(1);expect(f.transport.sendMessage).toHaveBeenCalledTimes(1);expect(f.enqueue).toHaveBeenCalledTimes(1);
});
it("fences revoke even if selector writing fails and the durable channel revoke prevents restart",async()=>{
 const f=restartFixture(),original=await f.pair();vi.spyOn(atomic,"writeFileAtomic").mockImplementationOnce(()=>{throw new Error("fixture selector write failure");});
 await expect(original.revoke()).rejects.toThrow("could not be fully revoked");expect(original.status().paired).toBe(false);
 expect(await f.make().resume("fake","chief")).toBe(false);
});
