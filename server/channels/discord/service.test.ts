import { mkdtempSync, readFileSync, readdirSync, renameSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { safeWipeSync } from "../../testing/safe-wipe.mjs";
import { DiscordService } from "./service.ts";
import type { DiscordTransport } from "./transport.ts";
import { ChannelSendError } from "../durable-delivery.ts";
const roots:string[]=[],services:DiscordService[]=[];
afterEach(async()=>{for(const s of services.splice(0))await s.stop();for(const root of roots.splice(0))safeWipeSync(root);vi.useRealTimers();});
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),"murage-discord-service-"));roots.push(dir);let chief=true,now=1000000000,sequence=100;
  const callbacks:Array<(raw:unknown)=>void>=[],health:Array<(state:"connected"|"disconnected"|"error"|"blocked")=>void>=[];
  const runs=new Map<string,{id:string}>();
  const enqueue=vi.fn(({deliveryId}:{deliveryId:string;prompt:string})=>{const r=runs.get(deliveryId)??{id:"run-"+deliveryId};runs.set(deliveryId,r);return r;});
  const result=vi.fn(()=>({status:"completed",output:"answer"}));
  const sendText=vi.fn(async({dmId}:{dmId:string;text:string;signal:AbortSignal})=>({channel:dmId,messageId:"99"}));
  const verifyBot=vi.fn(async()=>({applicationId:"11",botUserId:"12"})),stop=vi.fn(async()=>{}),revokeRuns=vi.fn(async()=>{});
  const transport=vi.fn(():DiscordTransport=>({verifyBot,sendText,stop,start:async(cb,h)=>{callbacks.push(cb);health.push(h);h("connected");}}));
  const options={dataDir:dir,chosen:{applicationId:"11",ownerUserId:"13",chiefBotId:"chief"},transport,isCurrentChief:()=>chief,runs:()=>({enqueue,result}),revokeRuns,now:()=>now};
  const service=new DiscordService(options);services.push(service);
  const raw=(content:string,id=String(++sequence))=>({applicationId:"11",botUserId:"12",id,dmId:"14",channelType:1,authorId:"13",authorBot:false,guildId:null,webhookId:null,type:0,content,occurredAt:now,attachments:0,components:0,forwarded:false});
  const emit=async(e:unknown)=>{callbacks.at(-1)!(e);await flush();};
  const pair=async()=>{const p=await service.pair();await emit(raw("/pair "+p.code));sendText.mockClear();return p;};
  return {dir,options,service,callbacks,health,enqueue,sendText,verifyBot,stop,revokeRuns,transport,raw,emit,pair,invalidate:()=>{chief=false;},advance:(ms:number)=>{now+=ms;}};
}
it("binds only chosen owner challenge and persists receipt before model enqueue",async()=>{
  const f=fixture(),p=await f.service.pair();await f.emit({...f.raw("/pair "+p.code),authorId:"88"});expect(f.service.status().paired).toBe(false);
  await f.emit(f.raw("/pair wrong"));expect(f.service.status().paired).toBe(false);
  await f.emit(f.raw("/pair "+p.code));expect(f.service.status().paired).toBe(true);f.sendText.mockClear();
  f.callbacks.at(-1)!(f.raw("hello","777"));
  const receipt=readdirSync(join(f.dir,"channels/discord")).find(file=>file!=="connection.json")!;
  expect(readFileSync(join(f.dir,"channels/discord",receipt),"utf8")).toContain("discord:11:14:777");expect(f.enqueue).not.toHaveBeenCalled();
  await flush();expect(f.enqueue).toHaveBeenCalledTimes(1);expect(f.sendText.mock.calls[0][0]).toMatchObject({dmId:"14",text:"answer"});
});
it("expired challenge cannot pair and simultaneous pair cannot create another receiver",async()=>{
  const f=fixture(),p=await f.service.pair();await expect(f.service.pair()).rejects.toThrow("Revoke");f.advance(600001);await f.emit(f.raw("/pair "+p.code));expect(f.service.status().paired).toBe(false);expect(f.transport).toHaveBeenCalledTimes(1);
});
it("failed Gateway startup stops its exact transport before returning blocked",async()=>{
  const f=fixture();f.transport.mockReturnValueOnce({verifyBot:f.verifyBot,sendText:f.sendText,stop:f.stop,start:async()=>{throw new ChannelSendError("unavailable",false);}});
  await expect(f.service.pair()).rejects.toThrow("could not complete");expect(f.stop).toHaveBeenCalledTimes(1);expect(f.service.status()).toMatchObject({enabled:false,state:"blocked"});
});
it("stop during identity verification prevents late pairing and Gateway login",async()=>{
  const f=fixture();let release!:(value:{applicationId:string;botUserId:string})=>void;
  f.verifyBot.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));const pairing=f.service.pair();await f.service.stop();release({applicationId:"11",botUserId:"12"});
  await expect(pairing).rejects.toThrow("could not complete");expect(f.callbacks).toHaveLength(0);expect(f.service.status().enabled).toBe(false);
});
it("dedupes resume events; SDK owns reconnect without a second login",async()=>{
  const f=fixture();await f.pair();const e=f.raw("hello","777");await f.emit(e);await f.emit(e);expect(f.enqueue).toHaveBeenCalledTimes(1);expect(f.sendText).toHaveBeenCalledTimes(1);
  f.health.at(-1)!("disconnected");await f.service.tick();expect(f.service.status()).toMatchObject({state:"retry",enabled:false});expect(f.transport).toHaveBeenCalledTimes(1);
  f.health.at(-1)!("connected");await f.emit(e);expect(f.enqueue).toHaveBeenCalledTimes(1);expect(f.transport).toHaveBeenCalledTimes(1);
});
it("wrong DM and approval-like messages never enqueue model work; revoke fences callbacks",async()=>{
  const f=fixture();await f.pair();await f.emit({...f.raw("hello"),dmId:"88"});await f.emit(f.raw("yes"));expect(f.enqueue).not.toHaveBeenCalled();expect(f.sendText.mock.calls[0][0].text).toContain("Review approvals");
  await f.service.revoke();const count=f.sendText.mock.calls.length;await f.emit(f.raw("after revoke"));expect(f.sendText).toHaveBeenCalledTimes(count);expect(f.revokeRuns).toHaveBeenCalledTimes(1);
});
it("restarts exact binding and pauses on Chief change",async()=>{
  const f=fixture();await f.pair();await f.service.stop();const restarted=new DiscordService(f.options);services.push(restarted);await restarted.resume();expect(restarted.status()).toMatchObject({paired:true,enabled:true});
  f.invalidate();await restarted.tick();expect(restarted.status()).toMatchObject({state:"blocked",enabled:false,error:"chief-changed"});expect(f.revokeRuns).toHaveBeenCalledTimes(1);
});
it("persisted owner mismatch blocks without overwriting",async()=>{
  const f=fixture();await f.pair();await f.service.stop();const path=join(f.dir,"channels/discord/connection.json"),saved=JSON.parse(readFileSync(path,"utf8"));saved.binding.ownerUserId="99";writeFileSync(path,JSON.stringify(saved));
  const restarted=new DiscordService(f.options);services.push(restarted);await restarted.resume();expect(restarted.status()).toMatchObject({state:"blocked",enabled:false});expect(f.sendText).not.toHaveBeenCalled();
});
it("send timeout after dispatch remains uncertain and never reruns",async()=>{
  const f=fixture();await f.pair();f.sendText.mockRejectedValue(new ChannelSendError("unavailable",true));await f.emit(f.raw("hello"));expect(f.service.status().uncertain).toBe(1);await f.service.tick();expect(f.enqueue).toHaveBeenCalledTimes(1);expect(f.sendText).toHaveBeenCalledTimes(1);
});
it("receipt failure stops intake; revoke still cancels runs if saving fails",async()=>{
  const f=fixture();await f.pair();const folder=join(f.dir,"channels/discord"),receipt=readdirSync(folder).find(file=>file!=="connection.json")!;renameSync(join(folder,receipt),join(folder,receipt+".original"));mkdirSync(join(folder,receipt));
  await f.emit(f.raw("must not enqueue"));expect(f.service.status()).toMatchObject({state:"blocked",enabled:false,error:"intake-failed"});expect(f.enqueue).not.toHaveBeenCalled();
  const connection=join(folder,"connection.json");renameSync(connection,connection+".original");mkdirSync(connection);await expect(f.service.revoke()).rejects.toThrow("needs recovery");expect(f.revokeRuns).toHaveBeenCalledTimes(1);
});
