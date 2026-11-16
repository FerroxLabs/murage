// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { launchVerificationServer } from "../../scripts/control-murage.ts";
import { countControlSource, sendCountCommand } from "./bounded-reads.ts";
const url = (name: string) => JSON.stringify(fileURLToPath(new URL(`../${name}`, import.meta.url)));

/** Isolated real HTTP turns, with admission and checkpoint work counted separately
 * from recall consumers (MAIN ruling 02:25Z R1). Hooks only observe the fixture. */
export async function redesignRoomSample(count: number, memory: boolean) {
  const instrumentation = `
    const fs=await import('node:fs'),path=await import('node:path');
    let store,active=false,complete=false,reads={indices:0,objects:0,arrays:0,threads:0,owners:0,answers:0,stringifies:0,computes:0},counters;
    const wrap=(array,kind)=>new Proxy(array,{get(t,k,r){if(active&&typeof k==='string'&&/^[0-9]+$/.test(k)&&(kind!=='answers'||/memory\\/(audience-cache|eligibility-pass)[.]ts/.test(String(new Error().stack))))reads[kind]++;return Reflect.get(t,k,r);}});
    globalThis.__patchbotProbe={owners:a=>wrap(a,'owners'),compute:()=>{if(active)reads.computes++;},freeze:a=>Object.freeze(wrap(a,'answers'))};
    const {registerHooks}=await import('node:module');
    registerHooks({load(u,c,next){const r=next(u,c);if(typeof r.source!=='string'&&!Buffer.isBuffer(r.source))return r;
      let s=String(r.source);
      if(u.endsWith('/memory/scope-id.ts'))s=s.replace('const h = heldFor(db), found =',"owners=globalThis.__patchbotProbe.owners(owners); const h = heldFor(db), found =");
      if(u.endsWith('/memory/policy.ts'))s=s.replace('const bot = roster.bots.find(b => b.id === botId);',"globalThis.__patchbotProbe.compute(); const bot = roster.bots.find(b => b.id === botId);");
      if(u.endsWith('/memory/audience-cache.ts'))s=s.replace('const fresh = Object.freeze(compute());','const fresh = globalThis.__patchbotProbe.freeze(compute());');
      return {...r,source:s};}});
    // Scope-array serialization in the search key is identified by the scope-id
    // array in its composite key; native recall readers remain outside this count.
    const stringify=JSON.stringify;
    JSON.stringify=function(v,...args){if(active&&Array.isArray(v)&&typeof v[0]==='string'&&typeof v[1]==='number'&&Array.isArray(v[2]))reads.stringifies++;return stringify(v,...args);};
    const {Store}=await import(${url("store.ts")});
    const views=await import(${url("memory/recall-view.ts")});
    const {flushCoalesced}=await import(${url("atomic.ts")});
    const {setMemoryMode}=await import(${url("memory/repository.ts")});
    try{counters=(await import(${url("memory/audience-cache.ts")})).audienceCacheCounters;}catch{}
    if(${memory})setMemoryMode('active');
    const finish=Store.prototype.finishSharingBoot;
    Store.prototype.finishSharingBoot=function(...a){store=this;return finish.apply(this,a);};
    const patch=Store.prototype.patchBot;
    Store.prototype.patchBot=function(id,p,...a){store=this;const result=patch.call(this,id,p,...a);if(p.unread===true&&Object.keys(p).length===1&&String(new Error().stack).includes('foldRuntimeEvent'))complete=true;return result;};
    const ids=Store.prototype.threadIdsForBot;
    const wrapped=new WeakMap();Store.prototype.threadIdsForBot=function(...a){const ids0=ids.apply(this,a);let v=wrapped.get(ids0);if(!v){v=wrap(ids0,'threads');wrapped.set(ids0,v);}return v;};
    ${countControlSource(`c=>{
      const dir=process.env.MURAGE_DATA_DIR;
      if(c.prepare){for(const bot of store.bots){if(bot.name==='History'){bot.tasks=new Proxy(bot.tasks.map(task=>new Proxy(task,{ownKeys(t){if(active)reads.objects++;return Reflect.ownKeys(t);}})),{get(t,k,r){if(active&&typeof k==='string'&&/^[0-9]+$/.test(k))reads.indices++;return Reflect.get(t,k,r);},ownKeys(t){if(active)reads.arrays++;return Reflect.ownKeys(t);}});}store.taskActivityCounts(bot);store.threadIdsForBot(bot.id);store.threadHolder(bot.threadId);}store.finishSharingBoot();for(const b of store.bots)for(const flag of [false,true])views.prepareRecallContextSync(b.id,b.threadId,store,flag);for(const g of store.groups)for(const id of g.memberIds)for(const flag of [false,true])views.prepareRecallContextSync(id,g.threadId,store,flag);void views.waitForRecallConstructionIdleForTest(store).then(()=>fs.writeFileSync(path.join(dir,'redesign-prepared.json'),'true'));}
      if(c.arm){complete=false;for(const key of Object.keys(reads))reads[key]=0;globalThis.__patchbotBefore=counters?.().computes;active=true;fs.writeFileSync(path.join(dir,'redesign-armed.json'),'true');}
      if(c.finish){flushCoalesced();active=false;fs.writeFileSync(path.join(dir,'redesign-counts.json'),JSON.stringify({...reads,complete,cacheComputes:counters?counters().computes-globalThis.__patchbotBefore:reads.computes}));}
      if(c.poll)fs.writeFileSync(path.join(dir,'redesign-complete.json'),JSON.stringify(complete));
    }`)}
  `;
  const fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation });
  let headers: Record<string, string> = {};
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const file = (name: string) => join(fixture.info.dataDir, name);
  const control = async (command: object, name: string) => {
    writeFileSync(file(name), "null"); sendCountCommand(fixture.info.dataDir, command);
    await expect.poll(() => JSON.parse(readFileSync(file(name), "utf8")), { timeout: 20_000 }).not.toBeNull();
  };
  try {
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret };
    const model = (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "verification").models.options[0].id;
    const bot = (await api("POST", "/api/bots", { name: "Speaker", modelSelection: { instanceId: "verification", model } })).body.bot;
    const other = memory ? null : (await api("POST", "/api/bots", { name: "History", modelSelection: { instanceId: "verification", model } })).body.bot;
    const roomResponse = await api("POST", "/api/groups", { name: "Room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    expect(roomResponse.status).toBe(201); const room = roomResponse.body.group;
    await fixture.stop();
    const bots = JSON.parse(readFileSync(file("bots.json"), "utf8")), history = bots.find((b: any) => b.id === (other ?? bot).id), template = history.tasks[0];
    history.tasks = Array.from({ length: count }, (_, n) => ({ ...template, threadId: n ? `fixture-history-${n}` : history.threadId }));
    writeFileSync(file("bots.json"), JSON.stringify(bots));
    await fixture.restart();
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret };
    await control({ prepare: true }, "redesign-prepared.json");
    expect((await api("GET", "/api/bots?messages=0")).status).toBe(200);
    const turn = async () => {
      writeFileSync(file("redesign-complete.json"), "false");
      await control({ arm: true }, "redesign-armed.json");
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "hello" })).status).toBe(202);
      await expect.poll(async () => { sendCountCommand(fixture.info.dataDir, { poll: true }); await new Promise(r => setTimeout(r, 100)); return existsSync(file("redesign-complete.json")) && JSON.parse(readFileSync(file("redesign-complete.json"), "utf8")); }, { timeout: 90_000 }).toBe(true);
      await control({ finish: true }, "redesign-counts.json");
      return JSON.parse(readFileSync(file("redesign-counts.json"), "utf8"));
    };
    if (memory) await turn();
    const before = readFileSync(file("bots.json"), "utf8"), result = await turn();
    expect(readFileSync(file("bots.json"), "utf8")).toBe(before);
    console.log(`redesign room memory=${memory} tasks=${count}`, JSON.stringify(result));
    return result;
  } finally { await fixture.close(); }
}
