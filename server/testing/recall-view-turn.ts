// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-scope (view/query hooks). Consumer owner: recall-scope (isolated HTTP acceptance fixture).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { launchVerificationServer } from '../../scripts/control-murage.ts';
import { countControlSource, sendCountCommand } from './bounded-reads.ts';
const source=(name:string)=>JSON.stringify(fileURLToPath(new URL(`../${name}`,import.meta.url)));
/** A complete fake-engine turn on an isolated fixture, with a real nonempty recall. */
export async function recallViewTurnSample(count:number,venue:'direct'|'room') {
  const instrumentation=`
    const fs=await import('node:fs'),path=await import('node:path');let store,active=false,finished=false;
    let work={scopeReads:0,ipcBytes:0,ipcMessages:0,hits:[],probes:0,candidates:0};
    globalThis.__recallViewProbe={scope:()=>{if(active)work.scopeReads++;},send:m=>{if(active){work.ipcMessages++;work.ipcBytes+=Buffer.byteLength(JSON.stringify(m));}},result:h=>{if(active)work.hits.push(...h.map(r=>r.id));},failure:e=>{console.error('isolated-send-failure',String(e?.stack??e));return fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR,'recall-admission-failure.txt'),String(e?.stack??e));}};
    const {registerHooks}=await import('node:module');registerHooks({load(u,c,next){const r=next(u,c);if(typeof r.source!=='string'&&!Buffer.isBuffer(r.source))return r;let s=String(r.source);
      if(u.endsWith('/memory/scope-set.ts'))s=s.replace('if (input.view)',"const originalSend=send;send=m=>{globalThis.__recallViewProbe.send(m);originalSend(m);};if (input.view)");
      if(u.endsWith('/server/index.ts'))s=s.replaceAll('throw sendNoticeError("notRecorded", 503);','globalThis.__recallViewProbe.failure(typeof error==="undefined"?new Error("isolated notice origin"):error);throw sendNoticeError("notRecorded", 503);');
      if(u.endsWith('/memory/search.ts'))s=s.replace('return {hits:selected,','globalThis.__recallViewProbe.result(selected);return {hits:selected,');
      return {...r,source:s};}});
    const {Store}=await import(${source('store.ts')});const {database}=await import(${source('database.ts')});
    const views=await import(${source('memory/recall-view.ts')});const {ensureScope}=await import(${source('memory/policy.ts')});
    const {setMemoryMode}=await import(${source('memory/repository.ts')});setMemoryMode('active');
    const {SendStore}=await import(${source('send-store.ts')});const accept=SendStore.prototype.accept;SendStore.prototype.accept=function(...a){try{return accept.apply(this,a);}catch(error){fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR,'recall-admission-failure.txt'),String(error?.stack??error));throw error;}};
    const finish=Store.prototype.finishSharingBoot;Store.prototype.finishSharingBoot=function(...a){store=this;return finish.apply(this,a);};
    const patch=Store.prototype.patchBot;Store.prototype.patchBot=function(id,p,...a){const r=patch.call(this,id,p,...a);if(p.unread===true&&Object.keys(p).length===1&&String(new Error().stack).includes('foldRuntimeEvent'))finished=true;return r;};
    const patchTask=Store.prototype.patchTask;Store.prototype.patchTask=function(id,thread,p,...a){const result=patchTask.call(this,id,thread,p,...a);if(p.unread===true&&Object.keys(p).length===1&&String(new Error().stack).includes('foldRuntimeEvent'))finished=true;return result;};
    ${countControlSource(`c=>{
      const dir=process.env.MURAGE_DATA_DIR;
      if(c.prepare){const bot=store.bot(c.bot);const db=database();const scope=ensureScope('conversation',bot.tasks[0].threadId);
        db.prepare("INSERT OR REPLACE INTO memory_records VALUES('fixture-recall-expected',1,?,'constraint','zephyr fixture reference','owner-statement','active',1,1,NULL,NULL,1)").run(scope);
        views.prepareRosterRecallViews(store);for(let pass=0;pass<2;pass++){for(const b of store.bots)for(const flag of [false,true])views.prepareRecallContextSync(b.id,b.threadId,store,flag);for(const g of store.groups)for(const id of g.memberIds)for(const flag of [false,true])views.prepareRecallContextSync(id,g.threadId,store,flag);}for(const row of db.prepare("SELECT v.view_id,v.generation,v.digest FROM memory_recall_contexts c JOIN memory_recall_views v ON v.view_id=c.view_id AND v.generation=c.generation WHERE v.state='ready' AND v.authority_epoch=(SELECT epoch FROM memory_recall_epoch WHERE id=1)").all()){while(!views.maintainRecallViewSlice({viewId:row.view_id,generation:row.generation,digest:row.digest})){};}
        for(const bot0 of store.bots){bot0.tasks=new Proxy(bot0.tasks,{get(t,k,r){if(active&&typeof k==='string'&&/^[0-9]+$/.test(k)){work.scopeReads++;if(work.scopeReads<=20)console.error('isolated task read',String(new Error().stack).split('\\n').slice(2,7).join(' | '));}return Reflect.get(t,k,r);}});store.taskActivityCounts(bot0);store.threadIdsForBot(bot0.id);store.threadHolder(bot0.threadId);store.taskByThread(bot0.id,bot0.threadId);}
        views.stopRecallViewMaintenance();fs.writeFileSync(path.join(dir,'recall-ready.json'),'true');}
      if(c.arm){finished=false;work={scopeReads:0,ipcBytes:0,ipcMessages:0,hits:[],probes:0,candidates:0};globalThis.__recallBefore=views.recallViewCounters();active=true;fs.writeFileSync(path.join(dir,'recall-armed.json'),'true');}
      if(c.finish){active=false;const n=views.recallViewCounters(),b=globalThis.__recallBefore;work.probes=n.membershipProbes-b.membershipProbes;work.candidates=n.candidateVisits-b.candidateVisits;fs.writeFileSync(path.join(dir,'recall-counts.json'),JSON.stringify(work));}
      if(c.poll)fs.writeFileSync(path.join(dir,'recall-finished.json'),JSON.stringify(finished));
    }`)}
  `;
  const fixture=await launchVerificationServer({},undefined,{instrumentationSource:instrumentation});let headers:Record<string,string>={};
  const api=async(method:string,path:string,body?:unknown)=>{const response=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};};
  const file=(name:string)=>join(fixture.info.dataDir,name);
  const control=async(command:object,name:string)=>{writeFileSync(file(name),'null');sendCountCommand(fixture.info.dataDir,command);try{await expect.poll(()=>JSON.parse(readFileSync(file(name),'utf8')),{timeout:20_000}).not.toBeNull();}catch(error){console.error('isolated control diagnostics',readFileSync(fixture.info.logPath,'utf8').slice(-5000));throw error;}};
  try {
    headers={'x-murage-surface':'desktop','x-murage-surface-secret':(await api('GET','/api/desktop-secret')).body.secret};
    const model=(await api('GET','/api/instances')).body.instances.find((i:any)=>i.instanceId==='verification').models.options[0].id;
    const bot=(await api('POST','/api/bots',{name:'Reader',modelSelection:{instanceId:'verification',model}})).body.bot;
    const room=(await api('POST','/api/groups',{name:'Room',memberIds:[bot.id],setup:{bulletin:'',defaultResponder:{kind:'member',botId:bot.id}}})).body.group;
    await fixture.stop();const bots=JSON.parse(readFileSync(file('bots.json'),'utf8')),target=bots.find((b:any)=>b.id===bot.id),template=target.tasks[0];
    target.tasks=Array.from({length:count},(_,n)=>({...template,threadId:n?`fixture-owned-${n}`:bot.threadId}));writeFileSync(file('bots.json'),JSON.stringify(bots));
    await fixture.restart();headers={'x-murage-surface':'desktop','x-murage-surface-secret':(await api('GET','/api/desktop-secret')).body.secret};
    await control({prepare:true,bot:bot.id,room:room.threadId},'recall-ready.json');
    const turn=async()=>{writeFileSync(file('recall-finished.json'),'false');await control({arm:true},'recall-armed.json');
      const sent=await api('POST',venue==='room'?`/api/groups/${room.id}/messages`:`/api/bots/${bot.id}/messages`,{text:'zephyr',...venue==='direct'?{threadId:bot.threadId}:{}});
      if(sent.status!==202)console.error('isolated admission diagnostics',readFileSync(fixture.info.logPath,'utf8').slice(-10000));
      expect(sent.status,JSON.stringify(sent.body)+(existsSync(file('recall-admission-failure.txt'))?readFileSync(file('recall-admission-failure.txt'),'utf8'):'')).toBe(202);
      await expect.poll(async()=>{sendCountCommand(fixture.info.dataDir,{poll:true});await new Promise(r=>setTimeout(r,100));return existsSync(file('recall-finished.json'))&&JSON.parse(readFileSync(file('recall-finished.json'),'utf8'));},{timeout:90_000}).toBe(true);
      await control({finish:true},'recall-counts.json');return JSON.parse(readFileSync(file('recall-counts.json'),'utf8'));
    };
    await turn();const result=await turn();expect(result.hits).toContain('fixture-recall-expected');return result;
  } finally {await fixture.close();}
}
