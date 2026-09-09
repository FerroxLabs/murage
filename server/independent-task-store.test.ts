import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { Store } from "./store.ts";

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
  const next=store.createTask(bot.id)!;expect(next).toMatchObject({modelSelection:{instanceId:"engine-two",connectionId:"account-two"},autoApprove:true});
});
