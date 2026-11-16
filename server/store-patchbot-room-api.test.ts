// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { countControlSource, sendCountCommand } from "./testing/bounded-reads.ts";

// Instrument the real store used by index.ts. Proxies count indexed reads (including
// iterator steps) and object enumerations, rather than elapsed time or array length.
// Count the entire turn, including activity, subscribers and the deferred-save flush.
const instrumentation = `
  const fs=await import('node:fs'),path=await import('node:path');
  const {Store}=await import(${JSON.stringify(fileURLToPath(new URL("./store.ts", import.meta.url)))});
  const views=await import(${JSON.stringify(fileURLToPath(new URL("./memory/recall-view.ts", import.meta.url)))});
  const {flushCoalesced}=await import(${JSON.stringify(fileURLToPath(new URL("./atomic.ts", import.meta.url)))});
  const dir=process.env.MURAGE_DATA_DIR;let store,armed=null,active=null,phase='turn',sameTasks=false,sawCompletion=false,held;
  const count=(kind)=>{if(active){active[phase][kind]++;if(kind==='indices'){const stack=String(new Error().stack).split('\\n').slice(2,6).join(' | ');active.stacks[stack]=(active.stacks[stack]??0)+1;}}};
  const wrap=(tasks)=>new Proxy(tasks.map(task=>new Proxy(task,{
    ownKeys(target){count('objects');return Reflect.ownKeys(target);}
  })),{get(target,key,receiver){if(typeof key==='string'&&/^(0|[1-9][0-9]*)$/.test(key))count('indices');return Reflect.get(target,key,receiver);},
    ownKeys(target){count('arrays');return Reflect.ownKeys(target);}});
  for(const [name,label] of [['saveBots','persistence'],['emit','subscribers']]){
    const original=Store.prototype[name];Store.prototype[name]=function(...args){const before=phase;phase=label;try{return original.apply(this,args);}finally{phase=before;}};
  }
  const patch=Store.prototype.patchBot;
  Store.prototype.patchBot=function(id,change,...args){store=this;
    if(id!==armed||change.unread!==true||Object.keys(change).length!==1||!String(new Error().stack).includes('foldRuntimeEvent'))return patch.call(this,id,change,...args);
    const bot=this.bot(id),tasks=bot.tasks;
    const before=phase;phase='patch';let result;
    try{result=patch.call(this,id,change,...args);}finally{phase=before;sameTasks=bot.tasks===tasks;sawCompletion=true;fs.writeFileSync(path.join(dir,'patch-settled.json'),'true');}
    return result;
  };
  ${countControlSource(`(c)=>{
    if(c.recallPrepare){for(let pass=0;pass<2;pass++){for(const b of store.bots)for(const flag of [false,true])views.prepareRecallContextSync(b.id,b.threadId,store,flag);for(const g of store.groups)for(const id of g.memberIds)for(const flag of [false,true])views.prepareRecallContextSync(id,g.threadId,store,flag);}fs.writeFileSync(path.join(dir,'recall-prepared.json'),'true');}
    if(c.prepare){for(const bot of store.bots){bot.tasks=wrap(bot.tasks);store.taskActivityCounts?.(bot);store.threadIdsForBot?.(bot.id);store.threadHolder?.(bot.threadId);}store.finishSharingBoot();for(const b of store.bots)for(const flag of [false,true])views.prepareRecallContextSync(b.id,b.threadId,store,flag);for(const g of store.groups)for(const id of g.memberIds)for(const flag of [false,true])views.prepareRecallContextSync(id,g.threadId,store,flag);fs.writeFileSync(path.join(dir,'patch-prepared.json'),'true');}
    if(c.arm){const bot=store.bot(c.arm);armed=c.arm;held=bot.tasks;sawCompletion=false;active={turn:{indices:0,objects:0,arrays:0},patch:{indices:0,objects:0,arrays:0},persistence:{indices:0,objects:0,arrays:0},subscribers:{indices:0,objects:0,arrays:0},stacks:{}};fs.writeFileSync(path.join(dir,'patch-armed.json'),JSON.stringify({tasks:bot.tasks.length}));}
    if(c.finish){flushCoalesced();const bot=store.bot(armed),counts=active;active=null;armed=null;fs.writeFileSync(path.join(dir,'patch-counts.json'),JSON.stringify({...counts,sameTasks:sameTasks&&bot.tasks===held,sawCompletion,unread:bot.unread,busy:!!bot.busy}));}
  }`)}
`;

let fixture: VerificationServer;
let headers: Record<string, string> = {};
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const file = (name: string) => join(fixture.info.dataDir, name);
type Room = { botId: string; groupId: string; threadId: string };
const rooms: Room[] = [];
beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation });
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret };
  const model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
  for (const count of [50, 5_000]) {
    const created = await api("POST", "/api/bots", { name: `Fixture ${count}`, modelSelection: { instanceId: "verification", model } });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const createdRoom = await api("POST", "/api/groups", { name: `Room ${count}`, memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    expect(createdRoom.status).toBe(201);
    rooms.push({ botId: bot.id, groupId: createdRoom.body.group.id, threadId: createdRoom.body.group.threadId });
  }
  await fixture.stop();
  const bots = JSON.parse(readFileSync(file("bots.json"), "utf8"));
  for (const [i, room] of rooms.entries()) {
    const bot = bots.find((bot: any) => bot.id === room.botId), template = bot.tasks[0];
    bot.tasks = Array.from({ length: [50, 5_000][i] }, (_, n) => ({ ...template, threadId: n === 0 ? bot.threadId : `fixture-${i}-${n}`, title: `Task ${n}`, createdAt: 1_700_000_000_000 + n }));
  }
  writeFileSync(file("bots.json"), JSON.stringify(bots));
  await fixture.restart();
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret };
  // Let instrumentation discover this process's Store without altering the fixture's tasks.
  expect((await api("PATCH", `/api/bots/${rooms[0].botId}`, { description: "Fixture" })).status).toBe(200);
  // Complete structural maintenance before the existing one-second instrumentation handshake is measured.
  sendCountCommand(fixture.info.dataDir,{recallPrepare:true});
  await vi.waitFor(()=>expect(existsSync(file("recall-prepared.json"))).toBe(true),{timeout:20_000});
}, 120_000);
afterAll(async () => { await fixture?.close(); });

it("the complete room turn does equal task work at 50 and 5,000 tasks", async () => {
  sendCountCommand(fixture.info.dataDir, { prepare: true });
  await expect.poll(() => existsSync(file("patch-prepared.json"))).toBe(true);
  // Warm lookup and presentation indexes, as boot does, before measuring a turn.
  expect((await api("GET", "/api/bots?messages=0")).status).toBe(200);
  const counts: any[] = [];
  for (const [i, room] of rooms.entries()) {
    sendCountCommand(fixture.info.dataDir, { arm: room.botId });
    await expect.poll(() => existsSync(file("patch-armed.json")) && JSON.parse(readFileSync(file("patch-armed.json"), "utf8")).tasks, { timeout: 10_000 }).toBe([50, 5_000][i]);
    expect((await api("POST", `/api/groups/${room.groupId}/messages`, { text: "hello" })).status).toBe(202);
    await expect.poll(() => existsSync(file("patch-settled.json")) && readFileSync(file("patch-settled.json"), "utf8") === "true", { timeout: 60_000 }).toBe(true);
    sendCountCommand(fixture.info.dataDir, { finish: true });
    await expect.poll(() => existsSync(file("patch-counts.json")) ? JSON.parse(readFileSync(file("patch-counts.json"), "utf8")) : null, { timeout: 60_000 }).toMatchObject({ unread: true, busy: false, sawCompletion: true });
    const result = JSON.parse(readFileSync(file("patch-counts.json"), "utf8"));
    counts.push(result);
    // A second sample must come from the next real completion, not the first result.
    writeFileSync(file("patch-counts.json"), "null");
    writeFileSync(file("patch-settled.json"), "");
    console.log(`patchBot room completion T=${[50, 5_000][i]}`, JSON.stringify(result));
    const messages = await api("GET", `/api/threads/${room.threadId}/messages?limit=20`);
    expect(messages.status).toBe(200);
    expect(messages.body.messages.some((message: any) => message.role === "bot" && message.kind === "text")).toBe(true);
  }
  for (const phase of ["turn", "patch", "persistence", "subscribers"]) expect(counts[1][phase], phase).toEqual(counts[0][phase]);
  expect(counts[1].turn.indices + counts[1].persistence.indices + counts[1].subscribers.indices).toBeLessThan(500);
  expect(counts[1].patch).toEqual(counts[0].patch);
  expect(counts.map(count => count.patch)).toEqual([{ indices: 0, objects: 0, arrays: 0 }, { indices: 0, objects: 0, arrays: 0 }]);
  expect(counts.map(count => count.sameTasks)).toEqual([true, true]);
}, 180_000);

it("A1: a one-task room speaker does zero neighbour task work at 50 and 5,000 tasks", async () => {
  const { redesignRoomSample } = await import("./testing/patchbot-redesign-room.ts");
  const samples = [];
  for (const count of [50, 5_000]) samples.push(await redesignRoomSample(count, false));
  for (const key of ["indices", "objects", "arrays"]) expect(samples.map(sample => sample[key]), key).toEqual([0, 0]);
}, 300_000);

it("A5: active-memory steady-state room turns derive no history at 50 and 5,000 own threads", async () => {
  const { redesignRoomSample } = await import("./testing/patchbot-redesign-room.ts");
  const samples = [];
  for (const count of [50, 5_000]) samples.push(await redesignRoomSample(count, true));
  for (const key of ["cacheComputes", "threads", "owners", "answers", "stringifies"]) expect(samples.map(sample => sample[key]), key).toEqual([0, 0]);
}, 300_000);

it.each(['direct','room'] as const)('RED-1 active %s turns with a nonempty recall do equal work at 50 and 5,000 owned threads',async venue=>{
  const {recallViewTurnSample}=await import('./testing/recall-view-turn.ts');
  const small=await recallViewTurnSample(50,venue),large=await recallViewTurnSample(5000,venue);
  expect(small.hits).toContain('fixture-recall-expected');expect(large.hits).toContain('fixture-recall-expected');
  expect(large).toEqual(small);
  expect(large.scopeReads).toBe(0);
},300_000);
