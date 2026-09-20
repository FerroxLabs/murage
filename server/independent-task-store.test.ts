import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { Store } from "./store.ts";
import type { ModelSelection } from "./contracts.ts";

beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});});
const fresh=()=>new Store(()=>({instanceId:"engine-one",model:"one",effort:"medium",connectionId:"account-one"}));
it("keeps thread model/account/approval snapshots and cursors independent across selection and restart",()=>{
  const store=fresh(),bot=store.createBot(),first=bot.threadId;
  store.appendMessage(first,{role:"user",kind:"text",text:"original history"});
  store.setResumeCursor(bot.id,"engine-one","first-session",first);
  const second=store.createTask(bot.id,"second")!;
  store.patchTask(bot.id,second.threadId,{modelSelection:{instanceId:"engine-two",model:"two",effort:"high",connectionId:"account-two"},autoApprove:true});
  store.setResumeCursor(bot.id,"engine-two","second-session",second.threadId);
  store.switchTask(bot.id,first);
  expect(store.projectBotForTask(bot.id,second.threadId)).toMatchObject({threadId:second.threadId,modelSelection:{model:"two",connectionId:"account-two"},autoApprove:true});
  expect(store.projectBotForTask(bot.id,first)).toMatchObject({modelSelection:{model:"one",connectionId:"account-one"},autoApprove:false,resumeCursors:{"engine-one":"first-session"}});
  const restored=fresh();
  expect(restored.tasks(bot.id).map(task=>task.threadId)).toEqual([second.threadId,first]);
  expect(restored.messagesFor(first).some(message=>message.text==="original history")).toBe(true);
  expect(restored.projectBotForTask(bot.id,second.threadId)?.resumeCursors).toEqual({"engine-two":"second-session"});
});
it("aggregates sibling and group activity without persisting runtime busy state",()=>{
  const store=fresh(),bot=store.createBot(),first=bot.threadId,second=store.createTask(bot.id)!;
  store.setTaskActivity(bot.id,first,"working");store.setTaskActivity(bot.id,second.threadId,"working");
  store.setTaskActivity(bot.id,first,"idle");expect(bot.busy).toBe(true);
  store.setActivity(bot.id,"working");store.setTaskActivity(bot.id,second.threadId,"idle");expect(bot.busy).toBe(true);
  store.setActivity(bot.id,"idle");expect(bot.busy).toBe(false);
  store.setTaskActivity(bot.id,first,"working");store.patchTask(bot.id,first,{unread:true});
  store.patchTask(bot.id,second.threadId,{unread:false});expect(bot.unread).toBe(true);
  const disk=JSON.parse(readFileSync(join(DATA_DIR,"bots.json"),"utf8"))[0];
  expect(disk.busy).toBeUndefined();expect(disk.tasks.every((task:any)=>task.busy===undefined&&task.activity===undefined)).toBe(true);
  const restored=fresh();expect(restored.bot(bot.id)?.busy).toBe(false);expect(restored.taskByThread(bot.id,first)?.unread).toBe(true);
});
it("stamps a task's turn start on its idle-to-busy transition and never persists it",async()=>{
  const store=fresh(),bot=store.createBot(),first=bot.threadId,second=store.createTask(bot.id)!;
  const startOf=(threadId:string)=>store.taskByThread(bot.id,threadId)?.turnStartedAt;
  expect(startOf(first)).toBeUndefined();
  store.setTaskActivity(bot.id,first,"working");
  const started=startOf(first)!;
  expect(started).toBeGreaterThan(0);
  // An approval parked on waiting-on-you is the same turn; the anchor holds.
  await new Promise(done=>setTimeout(done,3));
  store.setTaskActivity(bot.id,first,"waiting-on-you");
  store.setTaskActivity(bot.id,first,"working");
  expect(startOf(first)).toBe(started);
  // A sibling thread's turn does not move this one's anchor.
  store.setTaskActivity(bot.id,second.threadId,"working");
  expect(startOf(first)).toBe(started);
  expect(startOf(second.threadId)).toBeGreaterThan(0);
  // The anchor rides the wire copy of the task.
  expect(store.tasks(bot.id).find(task=>task.threadId===first)?.turnStartedAt).toBe(started);
  store.patchTask(bot.id,first,{unread:true});
  const disk=JSON.parse(readFileSync(join(DATA_DIR,"bots.json"),"utf8"))[0];
  expect(disk.tasks.every((task:any)=>task.turnStartedAt===undefined)).toBe(true);
  store.setTaskActivity(bot.id,first,"idle");
  expect(startOf(first)).toBeUndefined();
  // A stamp that reached disk some other way (an older build, an import)
  // never survives a load.
  disk.tasks[0].turnStartedAt=1;
  writeFileSync(join(DATA_DIR,"bots.json"),JSON.stringify([disk]));
  const restored=fresh();
  expect(restored.tasks(bot.id).every(task=>task.turnStartedAt===undefined)).toBe(true);
});
it("stamps a room's speaker turn start without persisting it",async()=>{
  const store=fresh(),lead=store.createBot(),other=store.createBot();
  const group=store.createGroup("Timer room",[lead.id,other.id]);
  expect(group.turnStartedAt).toBeUndefined();
  store.patchGroup(group.id,{unread:true});
  expect(group.turnStartedAt).toBeUndefined();
  store.patchGroup(group.id,{busyBotId:lead.id});
  const started=group.turnStartedAt!;
  expect(started).toBeGreaterThan(0);
  // An unrelated patch mid-turn, or the same member claiming again, is the same turn.
  await new Promise(done=>setTimeout(done,3));
  store.patchGroup(group.id,{bulletin:"changed"});
  store.patchGroup(group.id,{busyBotId:lead.id});
  expect(group.turnStartedAt).toBe(started);
  const saved=JSON.parse(readFileSync(join(DATA_DIR,"groups.json"),"utf8")).find((row:any)=>row.id===group.id);
  expect(saved).not.toHaveProperty("turnStartedAt");
  // A package addition mid-turn rewrites groups.json from memory too.
  const packaged=JSON.parse(store.preparePackageAddition([],[]).files.get("groups.json")!.toString("utf8"));
  expect(packaged.find((row:any)=>row.id===group.id)).not.toHaveProperty("turnStartedAt");
  // A different speaker is a new turn.
  await new Promise(done=>setTimeout(done,3));
  store.patchGroup(group.id,{busyBotId:other.id});
  expect(group.turnStartedAt!).toBeGreaterThan(started);
  store.patchGroup(group.id,{busyBotId:null});
  expect(group.turnStartedAt).toBeUndefined();
  const rows=JSON.parse(readFileSync(join(DATA_DIR,"groups.json"),"utf8"));
  for(const row of rows)row.turnStartedAt=1;
  writeFileSync(join(DATA_DIR,"groups.json"),JSON.stringify(rows));
  expect(fresh().group(group.id)?.turnStartedAt).toBeUndefined();
});
it("preserves an old active transcript omitted from a stale tasks array",()=>{
  const store=fresh(),bot=store.createBot(),thread=bot.threadId;
  store.appendMessage(thread,{role:"user",kind:"text",text:"retained old active history"});
  const second=store.createTask(bot.id)!;
  const old={...store.bot(bot.id)!,threadId:thread,tasks:[second]};
  writeFileSync(join(DATA_DIR,"bots.json"),JSON.stringify([old]));
  const restored=fresh();
  expect(restored.taskByThread(bot.id,thread)).toBeTruthy();expect(restored.messagesFor(thread).some(message=>message.text==="retained old active history")).toBe(true);
});
it("does not publish a rejected settings write and can save again after recovery",()=>{
  const store=fresh(),bot=store.createBot(),threadId=bot.threadId;
  // Fail the persistence boundary before it writes; no real disk failure or
  // unrelated profile is needed to exercise the staged-publish contract.
  const failure=vi.spyOn(store as any,"saveBots").mockImplementationOnce(()=>{throw new Error("fixture write refused");});
  expect(()=>store.patchTask(bot.id,threadId,{autoApprove:true,unread:true})).toThrow("fixture write refused");
  expect(store.projectBotForTask(bot.id,threadId)).toMatchObject({autoApprove:false,unread:false});
  failure.mockRestore();
  store.patchTask(bot.id,threadId,{autoApprove:true});
  expect(fresh().projectBotForTask(bot.id,threadId)?.autoApprove).toBe(true);
});
it("keeps existing task settings and cursors when the owner changes new-thread defaults",()=>{
  const store=fresh(),bot=store.createBot(),first=bot.threadId;
  store.setResumeCursor(bot.id,"engine-one","keep-session",first);
  store.patchBot(bot.id,{modelSelection:{instanceId:"engine-two",model:"two",connectionId:"account-two"},autoApprove:true},{preserveTaskSettings:true});
  expect(store.projectBotForTask(bot.id,first)).toMatchObject({modelSelection:{instanceId:"engine-one",connectionId:"account-one"},autoApprove:false,resumeCursors:{"engine-one":"keep-session"}});
  // Active creation preserves the currently visible model; detached routine
  // work uses the owner's updated defaults. Both retain existing task cursors.
  const next=store.createTask(bot.id)!;expect(next).toMatchObject({modelSelection:{instanceId:"engine-one",connectionId:"account-one"},autoApprove:true});
  const detached=store.createTask(bot.id,"Detached defaults",false)!;
  expect(detached).toMatchObject({modelSelection:{instanceId:"engine-two",connectionId:"account-two"},autoApprove:true});
  expect(store.projectBotForTask(bot.id,first)?.resumeCursors).toEqual({"engine-one":"keep-session"});
});

it("adopts the first task pick as the bot's own model, and leaves a bot that already chose one alone",()=>{
  // A workspace with no engine yet hands new bots the honest-empty selection.
  let defaults:ModelSelection={instanceId:"",model:""};
  const store=new Store(()=>structuredClone(defaults));
  const starter=store.createBot(),starterFirst=starter.threadId;
  const starterSecond=store.createTask(starter.id,"Second")!;
  expect(store.bot(starter.id)?.modelSelection).toEqual({instanceId:"",model:""});
  // Then a key arrives and the owner picks a model in the chat header, which
  // only ever writes the open task.
  const picked={instanceId:"engine-one",model:"one",connectionId:"account-one"};
  store.patchTask(starter.id,starterFirst,{modelSelection:picked});
  // The BOT now has it too — this is what channels and the team-lead list read.
  expect(store.bot(starter.id)?.modelSelection).toEqual(picked);
  const disk=()=>JSON.parse(readFileSync(join(DATA_DIR,"bots.json"),"utf8"));
  expect(disk().find((row:any)=>row.id===starter.id).modelSelection).toEqual(picked);
  // Its other task is not dragged along.
  expect(store.taskByThread(starter.id,starterSecond.threadId)?.modelSelection).toEqual({instanceId:"",model:""});
  // A bot that already has a bot-level model keeps it: a pick on one of its
  // tasks stays a deliberate per-task override.
  defaults={instanceId:"engine-one",model:"one",effort:"medium",connectionId:"account-one"};
  const settled=store.createBot(),other=store.createTask(settled.id,"Other")!;
  const override={instanceId:"engine-two",model:"two",connectionId:"account-two"};
  store.patchTask(settled.id,other.threadId,{modelSelection:override});
  expect(store.bot(settled.id)?.modelSelection).toMatchObject({instanceId:"engine-one",model:"one"});
  expect(disk().find((row:any)=>row.id===settled.id).modelSelection).toMatchObject({instanceId:"engine-one",model:"one"});
  expect(store.projectBotForTask(settled.id,other.threadId)?.modelSelection).toEqual(override);
});

it("persists write-once procedure pins per direct task and room responder",()=>{
  const store=fresh(),first=store.createBot(),second=store.createBot(),firstThread=first.threadId;
  const pin={schema:1 as const,bundleId:"a".repeat(64)},other={schema:1 as const,bundleId:"b".repeat(64)};
  store.pinTaskProcedures(first.id,firstThread,pin);
  expect(store.pinTaskProcedures(first.id,firstThread,other)).toEqual(pin);
  const next=store.createTask(first.id)!;expect(next.procedurePin).toBeUndefined();
  const room=store.createGroup("Procedure room",[first.id,second.id]);
  store.pinGroupProcedures(room.id,room.threadId,first.id,pin);
  store.pinGroupProcedures(room.id,room.threadId,second.id,other);
  const restored=fresh();
  expect(restored.taskByThread(first.id,firstThread)?.procedurePin).toEqual(pin);
  expect(restored.groupTaskByThread(room.id,room.threadId)?.procedurePins).toEqual({[first.id]:pin,[second.id]:other});
});
