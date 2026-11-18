// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-scope-c (task publication). Consumer owners: recall-scope-c (persistence and recall admission), nl-backup-b (shutdown checkpoint).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotTurnState, readBotRecords, foldBotTurnStateForDowngrade } from './bot-turn-state.ts';
import { DATA_DIR } from './config.ts';
import { closeDatabase } from './database.ts';
import { Store } from './store.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import { prepareRecallContextSync } from './memory/recall-view.ts';
import { memoryAccess } from './memory/policy.ts';
import { InternalCapabilities } from './internal-capabilities.ts';
import { requireDirectThreadTarget } from './independent-thread-runs.ts';
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
afterEach(()=>{vi.restoreAllMocks();closeDatabase();});
function world(count=3) {
  const store=new Store(()=>({instanceId:'fixture',model:'model'}));
  const bot=store.createBot({name:'Reader'},{seedMessages:false}),template=bot.tasks![0];
  store.patchBot(bot.id,{tasks:Array.from({length:count},(_,n)=>({...template,threadId:n?`task-${n}`:bot.threadId}))});
  return {store,bot};
}
it('cosmetic task publication preserves ready recall, task identity and sibling unread across restart',()=>{
  const {store,bot}=world(5000),task=store.taskByThread(bot.id,bot.threadId)!,sibling=store.taskByThread(bot.id,'task-1')!;
  prepareRecallContextSync(bot.id,bot.threadId,store);
  const registry=new InternalCapabilities(),generation=registry.begin(bot.id,bot.threadId);
  const token=registry.mint({botId:bot.id,threadId:bot.threadId,generation,depth:0,kind:'memory',skillAuthoring:false});
  const issue=()=>memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>store);
  const view=issue().view,before=readFileSync(join(DATA_DIR,'bots.json'),'utf8'),revision=store.memoryRosterRevision;
  store.patchTask(bot.id,'task-1',{unread:true});store.patchTask(bot.id,bot.threadId,{unread:false,title:'Selected'});
  expect(issue().view).toEqual(view);expect(store.memoryRosterRevision).toBe(revision);
  expect(store.taskByThread(bot.id,bot.threadId)).toBe(task);expect(sibling.unread).toBe(true);expect(bot.unread).toBe(true);
  expect(readFileSync(join(DATA_DIR,'bots.json'),'utf8')).toBe(before);
  const loaded=readBotRecords(DATA_DIR).find(item=>item.id===bot.id)!;
  expect(loaded.tasks![0].title).toBe('Selected');expect(loaded.tasks![1].unread).toBe(true);expect(loaded.unread).toBe(true);
});
it('a failed task-state write publishes no task value, event or revision',()=>{
  const {store,bot}=world(),task=store.taskByThread(bot.id,bot.threadId)!,before=structuredClone(task),revision=store.revision,events:unknown[]=[];
  store.onChange(event=>events.push(event));vi.spyOn(BotTurnState.prototype,'writeTask').mockImplementationOnce(()=>{throw new Error('fixture write failure');});
  expect(()=>store.patchTask(bot.id,bot.threadId,{unread:true})).toThrow('fixture write failure');
  expect(task).toEqual(before);expect(store.revision).toBe(revision);expect(events).toEqual([]);
});
it('task files cannot supply permission fields, survive generation changes, or defeat a newer sole-task badge',()=>{
  const {store,bot}=world(1);store.patchTask(bot.id,bot.threadId,{unread:true});store.patchBot(bot.id,{unread:false});
  expect(readBotRecords(DATA_DIR)[0].tasks![0].unread).toBe(false);
  const path=join(DATA_DIR,'bot-task-state',readdirSync(join(DATA_DIR,'bot-task-state'))[0]),bytes=readFileSync(path,'utf8');
  const delta=JSON.parse(bytes);delta.state.noLimits=true;writeFileSync(path,JSON.stringify(delta));
  expect(()=>readBotRecords(DATA_DIR)).toThrow(expect.objectContaining({reason:'invalid-shape'}));
  writeFileSync(path,bytes);store.patchBot(bot.id,{description:'Checkpoint'});writeFileSync(path,bytes);
  expect(readBotRecords(DATA_DIR)[0].tasks![0].unread).toBe(false);
});
it('downgrade folds task files with no bot badge sidecar and preserves cursor state',()=>{
  const {store,bot}=world();store.patchTask(bot.id,bot.threadId,{unread:true});store.markTaskDispatched(bot.id,bot.threadId,'fixture');
  foldBotTurnStateForDowngrade(DATA_DIR);
  const records=JSON.parse(readFileSync(join(DATA_DIR,'bots.json'),'utf8'));
  expect(records[0].tasks[0].unread).toBe(true);expect(records[0].tasks[0].lastInstanceId).toBe('fixture');
  expect(records[0].turnStateBase).toBeUndefined();foldBotTurnStateForDowngrade(DATA_DIR);
});
it('indexed direct targets retain malformed, wrong-bot and omitted-target refusals',()=>{
  const {store,bot}=world();const targets=store.directTaskTargets(bot.id);
  expect(requireDirectThreadTarget(targets,'task-1')).toBe('task-1');
  expect(()=>requireDirectThreadTarget(targets,undefined)).toThrow(expect.objectContaining({status:409}));
  expect(()=>requireDirectThreadTarget(targets,'missing')).toThrow(expect.objectContaining({status:404}));
  expect(()=>requireDirectThreadTarget(targets,{})).toThrow(expect.objectContaining({status:400}));
  const single=world(1);expect(requireDirectThreadTarget(single.store.directTaskTargets(single.bot.id),undefined)).toBe(single.bot.threadId);
});
it('task usage, its idempotency key and month buckets survive a crash before any coalesced flush',()=>{
  const {store,bot}=world();
  store.addTaskUsage(bot.id,bot.threadId,{input:7,output:3,costUsd:0.25},'fixture-usage');
  // Read only durable files, before the coalesced writer or any orderly Store shutdown.
  const loaded=readBotRecords(DATA_DIR).find(item=>item.id===bot.id)!;
  expect(loaded.tasks![0].usage).toMatchObject({input:7,output:3,turns:1,costUsd:0.25});
  expect(loaded.tasks![0].usageTurnKeys).toContain('fixture-usage');
  expect(Object.values(loaded.usageMonths!).reduce((sum,month)=>sum+month.input,0)).toBe(7);
  const again=new Store(()=>({instanceId:'fixture',model:'model'}));
  again.addTaskUsage(bot.id,bot.threadId,{input:7,output:3,costUsd:0.25},'fixture-usage');
  expect(again.taskByThread(bot.id,bot.threadId)!.usage!.turns).toBe(1);
  expect(Object.values(again.bot(bot.id)!.usageMonths!).reduce((sum,month)=>sum+month.input,0)).toBe(7);
});

it('an orderly shutdown checkpoint folds task cursors and effort into the legacy roster without changing turn writes',()=>{
  const {store,bot}=world(2);
  store.patchTask(bot.id,bot.threadId,{effortSent:{instanceId:'fixture',effort:'high'}});
  store.setResumeCursor(bot.id,'fixture','fixture-session',bot.threadId);
  store.markTaskDispatched(bot.id,bot.threadId,'fixture');
  const before=JSON.parse(readFileSync(join(DATA_DIR,'bots.json'),'utf8'));
  expect(before.find((row:any)=>row.id===bot.id).tasks[0].resumeCursors.fixture).toBeUndefined();
  store.checkpointTurnState();
  const saved=JSON.parse(readFileSync(join(DATA_DIR,'bots.json'),'utf8')).find((row:any)=>row.id===bot.id);
  expect(saved.tasks[0].resumeCursors.fixture).toBe('fixture-session');
  expect(saved.tasks[0].effortSent).toEqual({instanceId:'fixture',effort:'high'});
  expect(saved.tasks[0].lastInstanceId).toBe('fixture');
  expect(readBotRecords(DATA_DIR).find(row=>row.id===bot.id)!.tasks![0].resumeCursors.fixture).toBe('fixture-session');
  expect(readdirSync(join(DATA_DIR,'bot-task-state'))).toEqual([]);
});
