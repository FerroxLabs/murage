import { evidencePath, assertExternalEvidencePath } from '../scripts/evidence-path.mjs';
// Real owner replies in the routine's persisted conversation, with an inert engine.
import {afterAll,beforeAll,expect,it} from 'vitest';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {launchVerificationServer,runControlMurage,type VerificationServer} from '../scripts/control-murage.ts';
import {raiseLevel} from './testing/raise-level.ts';
let fixture:VerificationServer,desktop:Record<string,string>;
const evidence:unknown[]=[];
const out=assertExternalEvidencePath(process.env.GNL_OWNER_POLICY_EVIDENCE ?? evidencePath('evidence/afix-gnl-prod-r5/project-policy'));
const instrumentation=`
process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
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
},120000);
afterAll(async()=>{
 if(!fixture)return;mkdirSync(out,{recursive:true});
 writeFileSync(join(out,'workflow.json'),JSON.stringify({fixture:fixture.info,evidence},null,2));
 writeFileSync(join(out,'server.log'),readFileSync(fixture.info.logPath));
 try{writeFileSync(join(out,'policy.jsonl'),readFileSync(join(fixture.info.dataDir,'owner-policy.jsonl')));}finally{await fixture.close();}
});
it.each(['ask','auto','full','inherit'] as const)('H-workflow project routine %s reaches the native driver with its authenticated routine ceiling',async mode=>{
 const instance=(await api('GET','/api/instances')).body.instances.find((row:any)=>row.instanceId==='verification');
 const b=(await api('POST','/api/bots',{name:'Project routine '+mode,modelSelection:{instanceId:'verification',model:instance.models.options[0].id}})).body.bot;
 expect((await api('PATCH',`/api/bots/${b.id}`,{computer:'off',browser:false,composio:false,autoReview:'off'})).status).toBe(200);
 expect((await raiseLevel(api,b.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
 const project=await api('POST','/api/projects',{clientId:'review-project-'+mode,purpose:'Project routine authority',mode:'bots',members:[b.id],leadBotId:b.id});
 expect(project.status).toBe(200);const group=project.body.group;
 const made=await api('POST','/api/routines',{botId:b.id,name:'Project policy '+mode,prompt:'Say fixture complete.',target:'room-goal',groupId:group.id,enabled:false,...(mode==='inherit'?{}:{permissionMode:mode}),schedule:{type:'interval',everyMinutes:60,anchorAt:Date.now()}});
 expect(made.status).toBe(201);
 const started=await api('POST',`/api/routines/${made.body.routine.id}/run`,{});expect(started.status).toBe(201);
 let rows:any[]=[];
 try{
  await expect.poll(()=>{try{rows=readFileSync(join(fixture.info.dataDir,'owner-policy.jsonl'),'utf8').trim().split('\n').map(row=>JSON.parse(row)).filter(row=>row.threadId===group.threadId);return rows.length;}catch{return 0;}},{timeout:30000}).toBeGreaterThan(0);
  evidence.push({mode,group,rows});
  for(const row of rows){
   expect.soft(row.level).toBe(mode==='inherit'?'unlimited':mode);
   expect.soft(row.permission).toEqual(mode==='ask'?{routeAsks:true,askLevel:true}:mode==='auto'?{routeAsks:true}:mode==='full'?{stopLine:true}:{stopLine:true,noLimits:true});
  }
 }finally{await api('POST',`/api/groups/${group.id}/interrupt`,{});}
},60000);
