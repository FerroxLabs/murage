import { evidencePath, assertExternalEvidencePath } from '../scripts/evidence-path.mjs';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {launchVerificationServer,type VerificationServer,runControlMurage} from '../scripts/control-murage.ts';
import {raiseLevel} from './testing/raise-level.ts';
let fixture:VerificationServer,headers:Record<string,string>;
const evidence:unknown[]=[];
async function api(method:string,path:string,body?:unknown){
 const res=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const result={status:res.status,body:await res.json() as any};evidence.push({method,path,...result});return result;
}
beforeAll(async()=>{
 // Keep this permission-wire fixture inert and free of learning work.
 fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:"process.env.FAKE_CLAUDE_TEXT_ONLY='1';"});
 const secret=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};headers={'x-murage-surface':'desktop','x-murage-surface-secret':secret.secret};
 expect(await runControlMurage(['doctor','--url',fixture.info.url])).toMatchObject({ok:true});
 expect((await api('POST','/api/memory/action',{action:'configure',mode:'off'})).status).toBe(200);
},120000);
afterAll(async()=>{
 if(fixture){const out=assertExternalEvidencePath(process.env.GNL_PRODUCT_WIRE_EVIDENCE ?? evidencePath('evidence/gnl-prod/wire'));mkdirSync(out,{recursive:true});writeFileSync(join(out,'workflow.json'),JSON.stringify({fixture:fixture.info,evidence},null,2));writeFileSync(join(out,'server.log'),readFileSync(fixture.info.logPath));await fixture.close();}
});
it('P3 bot and first-task wires inherit live No limits and retain explicit lower choices and stored fallback',async()=>{
 const instances=(await api('GET','/api/instances')).body.instances,instance=instances.find((x:any)=>x.instanceId==='verification');
 const modelSelection={instanceId:'verification',model:instance.models.options[0].id};
 const chief=(await api('POST','/api/bots',{name:'P3 owner',modelSelection})).body.bot;
 expect((await api('PATCH',`/api/bots/${chief.id}`,{chiefOfStaff:true,chiefScope:'workspace'})).status).toBe(200);
 expect((await api('PATCH',`/api/bots/${chief.id}`,{computer:'off'})).status).toBe(200);
 expect((await raiseLevel(api,chief.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
 const made=await api('POST','/api/bots',{name:'P3 inherited child',modelSelection});expect(made.status).toBe(201);const child=made.body.bot;
 const inherited={autoApprove:true,fullAccess:true,noLimits:true};
 const check=(b:any)=>{expect(b).toMatchObject(inherited);expect(b.tasks.find((t:any)=>t.threadId===b.threadId)).toMatchObject(inherited);};
 check(child);check((await api('GET',`/api/bots/${child.id}`)).body.bot);
 check((await api('GET','/api/bots?messages=0')).body.bots.find((b:any)=>b.id===child.id));
 const saved=JSON.parse(readFileSync(join(fixture.info.dataDir,'bots.json'),'utf8'));const rows=Array.isArray(saved)?saved:saved.bots;
 expect(rows.find((b:any)=>b.id===child.id)).toMatchObject({autoApprove:false,fullAccess:false,noLimits:false,permissionExplicit:false});
 const routine=(await api('POST','/api/routines',{botId:child.id,name:'P3 explicit Ask',prompt:'Say fixture complete.',permissionMode:'ask',enabled:false,schedule:{type:'interval',everyMinutes:60,anchorAt:Date.now()}}));
 expect(routine.status).toBe(201);
 const started=await api('POST',`/api/routines/${routine.body.routine.id}/run`,{});expect(started.status).toBe(201);
 let routineThread:string|undefined;
 await expect.poll(async()=>{routineThread=(await api('GET','/api/routines')).body.runs.find((r:any)=>r.id===started.body.run.id)?.threadId;return !!routineThread;},{timeout:30000}).toBe(true);
 const during=(await api('GET',`/api/bots/${child.id}`)).body.bot;
 expect(during).toMatchObject(inherited);
 expect(during.tasks.find((t:any)=>t.threadId===routineThread)).toMatchObject({autoApprove:false,fullAccess:false,noLimits:false});
 // A completed routine can still own a native session. Retire it through
 // the real API before the fixture changes settings; completion is not proof
 // of native teardown, and clearing a busy flag here would bypass that check.
 await expect.poll(async()=> (await api('GET','/api/routines')).body.runs.find((r:any)=>r.id===started.body.run.id)?.status,{timeout:30000}).toBe('completed');
 expect((await api('POST',`/api/bots/${child.id}/interrupt`,{threadId:routineThread})).status).toBe(200);
 await expect.poll(async()=>Boolean((await api('GET',`/api/bots/${child.id}`)).body.bot.tasks.find((t:any)=>t.threadId===routineThread)?.busy),{timeout:30000}).toBe(false);
 expect((await api('PATCH',`/api/bots/${child.id}`,{settingsScope:'defaults',autoApprove:false,fullAccess:false,noLimits:false})).status).toBe(200);
 const lower=(await api('GET',`/api/bots/${child.id}`)).body.bot;
 expect(lower).toMatchObject({autoApprove:false,fullAccess:false,noLimits:false,permissionExplicit:true});
 expect(lower.tasks.find((t:any)=>t.threadId===child.threadId)).toMatchObject({autoApprove:false,fullAccess:false,noLimits:false});
},60000);
