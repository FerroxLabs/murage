// Isolated workflow proof: raw ACP prompt results, with no retry notice.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
let fixture: VerificationServer;
let headers: Record<string,string>;
const out = process.env.BUSYLOOP_EVIDENCE_DIR ? join(process.env.BUSYLOOP_EVIDENCE_DIR, 'room-goal') : undefined;
function evidence(name:string, data:unknown) { if(out) {mkdirSync(out,{recursive:true});writeFileSync(join(out,name),typeof data==='string'?data:JSON.stringify(data,null,2));} }
async function api(method:string,path:string,body?:unknown) {
  const res = await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  expect(res.ok,`${method} ${path}: ${res.status}`).toBe(true);
  const result = await res.json();
  if (method !== 'GET') evidence(`${method}-${path.replaceAll('/','_')}.json`,{request:body,response:result});
  return result as any;
}
beforeAll(async()=>{
 fixture = await launchVerificationServer({},undefined,{instrumentationSource:`
 import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
 const dir=process.env.MURAGE_DATA_DIR;
 process.env.FLUX_API_KEY='sk-flux-Ffffffffffffffffffffffffffffffffffffffffff';
 const file=join(dir,'config.json'),cfg=JSON.parse(readFileSync(file,'utf8'));
 const source=readFileSync(join(${JSON.stringify(process.cwd())},'server/drivers/acp/__fixtures__/fuigo-1.0.41-free-cap-S1-1.jsonl'),'utf8').trim().split('\\n').map(JSON.parse);
 const initial=source.find(r=>r.direction==='stdout'&&JSON.parse(r.line).id===1);
 for (const stopReason of ['refusal','end_turn']) {
 const frames=join(dir,stopReason+'.jsonl');
 writeFileSync(frames,[initial,{direction:'stdin',line:JSON.stringify({id:3,method:'session/prompt',params:{sessionId:stopReason}})},{direction:'stdout',line:JSON.stringify({jsonrpc:'2.0',id:3,result:{stopReason,message:'Refused',upstream:{http_status:429,state:'key_revoked'}}})}].map(JSON.stringify).join('\\n'));
 const cli=[process.execPath,join(${JSON.stringify(process.cwd())},'server/testing/fuigo-captured-cli.mjs'),frames].map(JSON.stringify).join(' ');
 cfg.instances[stopReason]={driver:'fuigoAgent',displayName:'Flux fixture',environment:{FUIGO_REPLAY_REQUESTS:join(dir,stopReason+'-requests.jsonl')},config:{cli}};
 }
 writeFileSync(file,JSON.stringify(cfg));
 `});
 evidence('launch.json',fixture.info);
 const proof=await fetch(fixture.info.url+'/api/desktop-secret').then(r=>r.json()) as {secret:string};
 headers={'x-murage-surface':'desktop','x-murage-surface-secret':proof.secret};
},120000);
afterAll(async()=>{if(fixture)evidence('server.log',readFileSync(fixture.info.logPath,'utf8'));await fixture?.close();});
for (const scenario of ['refusal','end_turn']) it(`STOP from ACP ${scenario} permits exactly one room-goal dispatch`,async()=>{
 const bot=(await api('POST','/api/bots',{name:'Review '+scenario,modelSelection:{instanceId:scenario,model:'flux-auto'}})).bot;
 await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false});
 const room=(await api('POST','/api/groups',{name:'Review goal',memberIds:[bot.id],setup:{bulletin:'',defaultResponder:{kind:'member',botId:bot.id}}})).group;
 await api('POST',`/api/groups/${room.id}/messages`,{text:'Run fixture goal',mode:'goal'});
 let finalRun: any;
 await expect.poll(async()=>{
   const state=await api('GET','/api/bots?messages=30');
   const current=state.groups.find((g:any)=>g.id===room.id);
   evidence(scenario+'-messages.json',current);
   finalRun=current?.messages.find((m:any)=>m.kind==='goal.run')?.goalRun;
   return !!finalRun && finalRun.status !== 'working';
 },{timeout:60000}).toBe(true);
 expect(finalRun).toMatchObject({status:'failed',turnCount:1});
 const requests=readFileSync(join(fixture.info.dataDir,scenario+'-requests.jsonl'),'utf8');
 evidence(scenario+'-requests.jsonl',requests);
 expect(requests.trim().split('\n').filter(l=>JSON.parse(l).method==='session/prompt')).toHaveLength(1);
},90000);
