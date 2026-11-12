import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { countControlSource, sendCountCommand } from './testing/bounded-reads.ts';

const server = fileURLToPath(new URL('.', import.meta.url));
let fixture: VerificationServer;
let headers: Record<string,string> = {};
const api = async (method:string,path:string,body?:unknown) => {
  const r=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,body:await r.json() as any};
};
// 2fe571bb91 widened the cited-scope query to include notebook ids and kinds.
// Count that query with the same visit oracle; the SQL bounds below are unchanged.
const instrumentation = `
const fs=await import('node:fs'), path=await import('node:path');
const {registerHooks}=await import('node:module');
let nextPass=0,currentPass; // Cleared at the next microtask, so an await cannot share this diagnostic pass.
let seededThrough=0;
let counts={calls:[],queries:0,pairs:0,scopes:0,plans:[]};
const {Session}=await import('node:inspector');const profiler=new Session();profiler.connect();profiler.post('Profiler.enable');
globalThis.__eldCheck=(stamp,session)=>{if(currentPass===undefined){currentPass=++nextPass;queueMicrotask(()=>{currentPass=undefined;});}counts.calls.push({stamp,session,pass:currentPass,queries:0});};
registerHooks({load(url,context,next){const result=next(url,context);if(url.endsWith('/server/memory/disclosures.ts')){
 let source=String(result.source).replace('function continuationMemoryRevokedWork(', 'function continuationMemoryRevokedWorkUncounted(');
 source+='\\nfunction continuationMemoryRevokedWork(...args: Parameters<typeof continuationMemoryRevokedWorkUncounted>) { (globalThis as any).__eldCheck(authorityParts()?.stamp,JSON.stringify(args.slice(1,4))); return continuationMemoryRevokedWorkUncounted(...args); }';
 return {...result,source};}return result;}});
const sqlite=await import('node:sqlite');const prepare=sqlite.DatabaseSync.prototype.prepare;const installed=new WeakSet();
sqlite.DatabaseSync.prototype.prepare=function(sql,...rest){
 if(sql.startsWith('SELECT DISTINCT s.id,s.kind,s.owner_key')){
  if(!installed.has(this)){this.function('eld_scope',(_id)=>{counts.scopes++;return 1;});installed.add(this);}
  const measured=sql+' WHERE eld_scope(s.id)';const db=this;
  const stmt=prepare.call(db,measured,...rest);const all=stmt.all.bind(stmt);
  stmt.all=(...args)=>{counts.queries++;counts.pairs+=JSON.parse(args[0]).length;if(counts.calls.length)counts.calls.at(-1).queries++;const plan=q=>prepare.call(db,'EXPLAIN QUERY PLAN '+q).all(...args).map(r=>r.detail);
    const original=plan(sql);if(JSON.stringify(original)!==JSON.stringify(plan(measured)))throw Error('measurement changed query plan');
    counts.plans.push(original);return all(...args);};return stmt;
 }return prepare.call(this,sql,...rest);
};
const {pathToFileURL}=await import('node:url');
const {database}=await import(pathToFileURL(path.join(${JSON.stringify(server)},'database.ts')).href);
const configFile=path.join(process.env.MURAGE_DATA_DIR,'config.json');const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
config.instances.verification.environment={...config.instances.verification.environment,FAKE_CLAUDE_DUMP_EACH_TURN:'1'};
config.instances.verification2={...config.instances.verification,displayName:'Second fake engine'};fs.writeFileSync(configFile,JSON.stringify(config));
${countControlSource(`command=>{
 if(command.seed){const db=database();
 if(command.seed<=seededThrough || command.seed-seededThrough>500)throw Error('invalid seed chunk');
 db.exec('BEGIN');
 try {const first=seededThrough;
 const scope=db.prepare("INSERT INTO memory_scopes VALUES(?,'conversation',?,'[]',0)");
 const record=db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','fixture','fixture','active',0,0,NULL,NULL,?)");
 const message=db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,1,'user','text','fixture',?)");
 for(let i=first;i<command.seed;i++){scope.run('eld-s'+i,'eld-t'+i);for(let j=0;j<25;j++){const id='eld-r'+i+'-'+j;record.run(id,'eld-s'+i,1700000000000+i*64+j);message.run('eld-t'+i,id,JSON.stringify({id,at:1,role:'user',kind:'text',text:'fixture'}));}}
 db.exec('COMMIT');seededThrough=command.seed;}catch(e){db.exec('ROLLBACK');throw e;}
 }
 if(command.start){
 const rows=database().prepare("SELECT count(*) AS n FROM messages WHERE thread_id GLOB 'eld-t[0-9]*'").get().n;
 if(rows!==seededThrough*25)throw Error('seed row count mismatch');
 counts={calls:[],queries:0,pairs:0,scopes:0,plans:[]};profiler.post('Profiler.start');}
 if(command.dump){profiler.post('Profiler.stop',(error,result)=>{
  if(error)throw error;const p=result.profile,nodes=new Map(p.nodes.map(n=>[n.id,n])),parents=new Map();for(const n of p.nodes)for(const c of n.children??[])parents.set(c,n.id);
  const samples={total:p.samples.length,learningSourceBot:0,threadIsBotsOwn:0};
  for(const id of p.samples){const names=new Set();for(let n=id;n;n=parents.get(n))names.add(nodes.get(n).callFrame.functionName);for(const name of ['learningSourceBot','threadIsBotsOwn'])if(names.has(name))samples[name]++;}
  counts.profile=samples;fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR,'eld-result.json'),JSON.stringify({seq:command.seq,counts:{...counts,seededMessages:seededThrough*25}}));
 });return;}
 fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR,'eld-result.json'),JSON.stringify({seq:command.seq,counts:{...counts,seededMessages:seededThrough*25}}));
}`)}
`;
async function command(c:object) {
  const path=join(fixture.info.dataDir,'eld-result.json');
  const old=existsSync(path)?readFileSync(path,'utf8'):'';
  sendCountCommand(fixture.info.dataDir,c);
  await expect.poll(()=>existsSync(path)?readFileSync(path,'utf8'):'',{timeout:60000}).not.toBe(old);
  return JSON.parse(readFileSync(path,'utf8')).counts as {calls:Array<{stamp:string;session:string;pass:number;queries:number}>;queries:number;pairs:number;scopes:number;plans:string[][];seededMessages:number;profile?:{total:number;learningSourceBot:number;threadIsBotsOwn:number}};
}
beforeAll(async()=>{
 fixture=await launchVerificationServer({},undefined,{instrumentationSource:instrumentation,dumpLog:true});
 headers={'x-murage-surface':'desktop','x-murage-surface-secret':(await api('GET','/api/desktop-secret')).body.secret};
 console.log('isolated fixture',fixture.info);
},60000);
afterAll(async()=>{await fixture?.close();});

it('engine switches and stopped turns resolve dependencies by cited rows at 50,000 and 500,000 messages', {timeout:240000},async()=>{
 const instances=(await api('GET','/api/instances')).body.instances;
 const model=instances.find((i:any)=>i.instanceId==='verification').models.options[0].id;
 const bot=(await api('POST','/api/bots',{name:'History probe',modelSelection:{instanceId:'verification',model}})).body.bot;
 await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false});
 const replies=async()=>((await api('GET',`/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[]).filter(m=>m.role==='bot'&&m.kind==='text'&&m.text).length;
 const idle=async()=>{await expect.poll(async()=> (await api('GET',`/api/bots/${bot.id}`)).body.bot?.activity,{timeout:30000}).toBe('idle');};
 const turn=async(text:string)=>{const n=await replies();expect((await api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text})).status).toBe(202);await expect.poll(replies,{timeout:30000}).toBe(n+1);await idle();};
 await turn('Remember the history probe colour is blue.');await turn('Repeat the colour.');
 const results=[];
 let seededThrough=0;
 for(const threads of [2000,20000]){
  // Seeding is setup, outside the measured profile. Acknowledge bounded chunks
  // so one 450,000-row synchronous insert cannot consume the command deadline.
  while(seededThrough<threads){
   seededThrough=Math.min(threads,seededThrough+500);
   expect((await command({seed:seededThrough})).seededMessages).toBe(seededThrough*25);
  }
  await command({start:true});
  await api('PATCH',`/api/bots/${bot.id}`,{modelSelection:{instanceId:'verification2',model}});
  await turn('Use the other engine.');await turn('Continue on the other engine.');
  await api('PATCH',`/api/bots/${bot.id}`,{modelSelection:{instanceId:'verification',model}});
  await turn('Return to the first engine.');await turn('Continue on the first engine.');
  const engineSwitch=await command({dump:true});
  await command({start:true});
  const dumps=()=>existsSync(fixture.fixtureDumpLogPath)?readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n').length:0;
  const n=dumps();
  expect((await api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:'__fixture_hold_authority__'})).status).toBe(202);
  await expect.poll(dumps,{timeout:30000}).toBeGreaterThan(n);
  expect((await api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId})).status).toBeLessThan(300);
  await idle();await turn('__fixture_finish_turn__ Continue after stop.');
  const stop=await command({dump:true});
  for(const count of [engineSwitch,stop]){
   expect(count.seededMessages).toBe(threads*25);
   expect(count.profile?.total, 'the profiler sampled this measurement').toBeGreaterThan(0);
  }
  results.push({threads,engineSwitch,stop});console.log('history counts',JSON.stringify(results.at(-1)));
 }
 // Optional evidence destination supplied by the local regression runner. No application data is exported.
 if(process.env.L14_EVIDENCE_FILE)writeFileSync(process.env.L14_EVIDENCE_FILE,JSON.stringify({fixture:fixture.info,results},null,2));
 for(const scenario of ['engineSwitch','stop'] as const){
  const [small,large]=results.map(r=>r[scenario]);
  expect.soft(small.queries).toBeGreaterThan(0);expect.soft(large.queries).toBeGreaterThan(0);
  expect.soft(small.scopes,`${scenario}: small history visits at most one scope per cited pair`).toBeLessThanOrEqual(small.pairs);
  expect.soft(large.scopes,`${scenario}: tenfold history visits at most one scope per cited pair`).toBeLessThanOrEqual(large.pairs);
  // Per-query rows, independent of scheduler-dependent numbers of dispatch checks.
  expect.soft(small.scopes/small.queries,`${scenario}: small scopes per dependency query`).toBeLessThanOrEqual(32);
  expect.soft(large.scopes/large.queries,`${scenario}: large scopes per dependency query`).toBeLessThanOrEqual(32);
  expect.soft(large.scopes).toBeLessThanOrEqual(small.scopes+32);
  for(const count of [small,large]){const groups=new Map<string,number>();for(const c of count.calls){const key=JSON.stringify([c.stamp,c.session,c.pass]);groups.set(key,(groups.get(key)??0)+c.queries);}for(const n of groups.values())expect.soft(n).toBeLessThanOrEqual(1);}
  for(const plan of large.plans)expect.soft(plan.some(p=>/SEARCH s .*\(id=\?\)/.test(p))).toBe(true);
 }
});
