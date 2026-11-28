import { evidencePath, assertExternalEvidencePath } from '../scripts/evidence-path.mjs';
// Real owner replies in the routine's persisted conversation, with an inert engine.
import {afterAll,beforeAll,expect,it} from 'vitest';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {launchVerificationServer,runControlMurage,type VerificationServer} from '../scripts/control-murage.ts';
import {raiseLevel} from './testing/raise-level.ts';
let fixture:VerificationServer,desktop:Record<string,string>;
const evidence:unknown[]=[];
const out=assertExternalEvidencePath(process.env.GNL_OWNER_POLICY_EVIDENCE ?? evidencePath('evidence/gnl-prod-r5/owner-policy'));
const instrumentation=`
process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
process.env.FAKE_CLAUDE_TEXT_ONLY='1';
const fs=await import('node:fs'),path=await import('node:path'),{registerHooks}=await import('node:module');
registerHooks({load(url,context,next){
 if(!url.endsWith('/server/index.ts'))return next(url,context);
 let source=fs.readFileSync(new URL(url),'utf8');
 const anchor='  if (policy) return policy.permission;';
 if(source.split(anchor).length!==2)throw Error('owner policy fixture anchor moved');
 source=source.replace(anchor,\`  if(policy){
   fixturePolicyWrite(threadId,generation,policy);
   return policy.permission;
  }\`);
 source=\`import {appendFileSync as fixturePolicyAppend} from 'node:fs';
 const fixturePolicyWrite=(threadId,generation,policy)=>fixturePolicyAppend(process.env.MURAGE_DATA_DIR+'/owner-policy.jsonl',JSON.stringify({threadId,generation,...policy})+String.fromCharCode(10));
 \`+source;
 return {format:'module-typescript',shortCircuit:true,source};
}});
`;
async function api(method:string,path:string,body?:unknown,headers=desktop){
 const response=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const result={status:response.status,body:await response.json() as any};
 if(!path.includes('secret'))evidence.push({method,path,...result});return result;
}
beforeAll(async()=>{
 fixture=await launchVerificationServer(process.env,undefined,{dumpLog:true,instrumentationSource:instrumentation});
 desktop={'x-murage-surface':'desktop','x-murage-surface-secret':(await api('GET','/api/desktop-secret',undefined,{})).body.secret};
 expect(await runControlMurage(['doctor','--url',fixture.info.url])).toMatchObject({ok:true});
 expect((await api('POST','/api/memory/action',{action:'configure',mode:'off'})).status).toBe(200);
},120000);
afterAll(async()=>{
 if(!fixture)return;mkdirSync(out,{recursive:true});
 writeFileSync(join(out,'workflow.json'),JSON.stringify({fixture:fixture.info,evidence},null,2));
 writeFileSync(join(out,'server.log'),readFileSync(fixture.info.logPath));
 try{writeFileSync(join(out,'policy.jsonl'),readFileSync(join(fixture.info.dataDir,'owner-policy.jsonl')));}finally{await fixture.close();}
});
it.each(['ask','auto','full','inherit'] as const)('H2 owner reply in %s routine conversation keeps native live policy at its ceiling',async mode=>{
 const instance=(await api('GET','/api/instances')).body.instances.find((row:any)=>row.instanceId==='verification');
 const b=(await api('POST','/api/bots',{name:'Owner policy '+mode,modelSelection:{instanceId:'verification',model:instance.models.options[0].id}})).body.bot;
 expect((await api('PATCH',`/api/bots/${b.id}`,{computer:'off',browser:false,composio:false,autoReview:'off'})).status).toBe(200);
 expect((await raiseLevel(api,b.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
 const made=await api('POST','/api/routines',{botId:b.id,name:'Owner policy '+mode,prompt:'Say fixture complete.',enabled:false,...(mode==='inherit'?{}:{permissionMode:mode}),schedule:{type:'interval',everyMinutes:60,anchorAt:Date.now()}});
 expect(made.status).toBe(201);
 const started=await api('POST',`/api/routines/${made.body.routine.id}/run`,{});expect(started.status).toBe(201);
 await expect.poll(async()=> (await api('GET','/api/routines')).body.runs.find((r:any)=>r.id===started.body.run.id)?.status,{timeout:30000}).toBe('completed');
 const routine=(await api('GET','/api/routines')).body.routines.find((r:any)=>r.id===made.body.routine.id);
 const threadId=routine.threadId;expect(threadId).toBeTruthy();
 // Keep the persisted routine conversation, but confirm teardown of its
 // completed native turn before submitting the owner's next generation.
 expect((await api('POST',`/api/bots/${b.id}/interrupt`,{threadId})).status).toBe(200);
 await expect.poll(async()=>Boolean((await api('GET',`/api/bots/${b.id}`)).body.bot.tasks.find((t:any)=>t.threadId===threadId)?.busy),{timeout:30000}).toBe(false);
 const prior=readFileSync(join(fixture.info.dataDir,'owner-policy.jsonl'),'utf8').trim().split('\n').length;
 expect((await api('POST',`/api/bots/${b.id}/messages`,{threadId,text:'__fixture_hold_authority__ owner routine reply '+mode})).status).toBe(202);
 try{
  let rows:any[]=[];
  await expect.poll(()=>{try{rows=readFileSync(join(fixture.info.dataDir,'owner-policy.jsonl'),'utf8').trim().split('\n').slice(prior).map(row=>JSON.parse(row)).filter(row=>row.threadId===threadId);return rows.length;}catch{return 0;}},{timeout:30000}).toBeGreaterThan(0);
  evidence.push({mode,threadId,rows});
  const level=mode==='inherit'?'unlimited':mode;
  for(const row of rows){
   expect.soft(row.level).toBe(level);
   expect.soft(row.permission).toEqual(mode==='ask'?{routeAsks:true,askLevel:true}:mode==='auto'?{routeAsks:true}:mode==='full'?{stopLine:true}:{stopLine:true,noLimits:true});
  }
 }finally{await api('POST',`/api/bots/${b.id}/interrupt`,{threadId});}
},60000);
