import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,expect,it,vi } from "vitest";
import { RoutineManager } from "./routines.ts";

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),"murage-pause-"));roots.push(root);
  let now=Date.UTC(2026,8,9),paused=false,sequence=0;const busy=new Set<string>();
  const started:string[]=[],interrupt=vi.fn(async()=>{});
  const manager=new RoutineManager({file:join(root,"routines.json"),now:()=>now,automaticPaused:()=>paused,
    botState:id=>busy.has(id)?"busy":"ready",createTask:()=>({threadId:`thread-${++sequence}`}),channelThread:id=>({threadId:`channel-${id}`}),
    startTurn:async(botId,_thread,_prompt,_runOn,trigger)=>{started.push(trigger);busy.add(botId);},interruptTurn:interrupt});
  return {manager,started,interrupt,busy,pause:(value:boolean)=>{paused=value;},advance:(ms:number)=>{now+=ms;},now:()=>now};
}
it("pauses schedule admission and coalesces intervals to one useful occurrence on resume",async()=>{
  const f=fixture();const routine=f.manager.create({botId:"a",name:"Check",prompt:"Check",schedule:{type:"interval",everyMinutes:5,anchorAt:f.now()+60000}});
  f.pause(true);f.advance(4*60*60000);await f.manager.tick();expect(f.manager.listRuns()).toHaveLength(0);
  expect(f.manager.listRoutines()[0].enabled).toBe(true);
  f.pause(false);await f.manager.tick();expect(f.started).toEqual(["schedule"]);expect(f.manager.listRuns()).toHaveLength(1);
  expect(f.manager.listRuns()[0].routineId).toBe(routine.id);await f.manager.tick();expect(f.manager.listRuns()).toHaveLength(1);
});
it("rejects new webhook work but keeps accepted receipts and channel owner requests",async()=>{
  const f=fixture();f.busy.add("a");
  const input={webhookId:"hook",webhookName:"Hook",prompt:"Accepted original",botId:"a",runOn:"ember" as const,deliveryId:"delivery",receivedAt:f.now()};
  const accepted=f.manager.enqueueWebhook(input);f.pause(true);await f.manager.tick();
  expect(f.manager.findWebhookDelivery("hook","delivery")).toMatchObject({id:accepted.id,status:"queued",prompt:"Accepted original"});
  expect(f.manager.enqueueWebhook({...input,prompt:"Retry cannot rewrite receipt"})).toMatchObject({id:accepted.id,prompt:"Accepted original"});
  expect(()=>f.manager.enqueueWebhook({...input,deliveryId:"new"})).toThrow("Automatic work is paused");expect(f.manager.listRuns()).toHaveLength(1);
  f.manager.enqueueWebhook({...input,botId:"channel-bot",deliveryId:"owner-message",telegramConnectionId:"paired-owner"});await f.manager.tick();
  await vi.waitFor(()=>expect(f.started).toEqual(["channel"]));expect(f.interrupt).not.toHaveBeenCalled();
});
it("manual work remains available and existing active time limits continue while paused",async()=>{
  const f=fixture();const routine=f.manager.create({botId:"a",name:"Manual",prompt:"Work",timeoutMinutes:5,schedule:{type:"once",at:f.now()+3600000}});
  f.pause(true);f.manager.runNow(routine.id);await f.manager.tick();await vi.waitFor(()=>expect(f.started).toEqual(["manual"]));
  expect(f.interrupt).not.toHaveBeenCalled();f.advance(6*60000);await f.manager.tick();expect(f.interrupt).toHaveBeenCalledTimes(1);
});
