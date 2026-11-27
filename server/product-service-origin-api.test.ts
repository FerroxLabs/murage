import { evidencePath, assertExternalEvidencePath } from '../scripts/evidence-path.mjs';
// SPDX-License-Identifier: AGPL-3.0-or-later
// Exercise real dispatch and service routes with server-owned queue/rebuild/card
// options. The fixture never replaces either authority classifier or a service gate.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../scripts/control-murage.ts';
import { withTurnSecrets } from './testing/fixture-dump.ts';
import { raiseLevel } from './testing/raise-level.ts';
let fixture: VerificationServer, desktop: Record<string, string>;
const evidence: unknown[] = [];
const out = assertExternalEvidencePath(process.env.GNL_SERVICE_ORIGIN_EVIDENCE ?? evidencePath('evidence/gnl-prod-r4/workflow'));
const instrumentation = `
process.env.FAKE_CLAUDE_MODE='hang';process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
const fs=await import('node:fs'),path=await import('node:path'),{registerHooks}=await import('node:module');
const configFile=path.join(process.env.MURAGE_DATA_DIR,'config.json'),config=JSON.parse(fs.readFileSync(configFile,'utf8'));config.features={...config.features,phoneTools:true};fs.writeFileSync(configFile,JSON.stringify(config));
registerHooks({load(url,context,next){
 if(!url.endsWith('/server/index.ts'))return next(url,context);
 let source=fs.readFileSync(new URL(url),'utf8');
 const admission='  if (opts?.sharedWorkRun) {';
 const observe='  internalTurnOwners.get(threadId)!.triggerMessageId = userMessage.id;';
 if(source.split(admission).length!==2||!source.includes(observe))throw Error('FABLE fixture dispatch anchor moved');
 source=source.replace(admission,\`
  const fixturePath = text.match(/FABLE:([a-z-]+)/)?.[1];
  if(fixturePath && fixturePath !== 'owner') {
    opts={...opts,origin:undefined,phoneTicket:undefined,hlTicket:undefined,userMessage:undefined};
    if(fixturePath.startsWith('queue'))opts={...opts,queuedDrain:true,queuedOwnerProof:fixturePath==='queue-proven'};
    if(fixturePath==='card')opts={...opts,cardContinuation:true};
    if(fixturePath.startsWith('memory'))opts={...opts,memoryRedispatch:1,...(fixturePath==='memory-proven'?{origin:'desktop'}:{})};
  }
\`+admission);
 source=source.replace(observe,\`
  if(text.includes('FABLE:')) {
    const gate={key:'/fixture/rejected',folder:'/fixture/rejected',sources:['AGENTS.md'],decision:'reject',fromRecord:true,rejects:[{key:'/fixture/rejected',folder:'/fixture/rejected'}]};
    const trust=servicePermissions.serviceFolderTrust(run.generation,threadId,bot.id,gate);
    (await import('node:fs')).appendFileSync((await import('node:path')).join(DATA_DIR,'fable-observer.jsonl'),JSON.stringify({botId:bot.id,threadId,generation:run.generation,initiator:dispatchProvenance.initiator.k,origin:decisionNoLimitsOrigin(dispatchProvenance),level:readTurnPolicy({threadId,generation:run.generation})?.level,service:serviceNoLimits(run.generation,threadId,bot.id),folderDecision:trust.decision,folderRejects:trust.rejects.length,phoneOffered:phonesOfferedNow(),phoneOrigin:phoneAuthorities.live(run.generation)?.origin??null})+String.fromCharCode(10));
  }
\`+observe);
 return {format:'module-typescript',shortCircuit:true,source};
}});
`;
async function api(method: string, path: string, body?: unknown, headers = desktop) {
 const response = await fetch(fixture.info.url + path, {method, headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const result = {status:response.status,body:await response.json() as any};
 if(!path.includes('secret'))evidence.push({method,path,...result});
 return result;
}
beforeAll(async()=>{
 try{fixture=await launchVerificationServer(process.env,undefined,{dumpLog:true,instrumentationSource:instrumentation,env:{MURAGE_COMPANION_TOKEN:'ab'.repeat(32)}});}catch(error){mkdirSync(out,{recursive:true});const log=String(error).match(/see (.*\.log)/)?.[1];if(log)writeFileSync(join(out,'startup-error.log'),readFileSync(log));throw error;}
 desktop={'x-murage-surface':'desktop','x-murage-surface-secret':(await api('GET','/api/desktop-secret',undefined,{})).body.secret};
 expect(await runControlMurage(['doctor','--url',fixture.info.url])).toMatchObject({ok:true});
},120000);
afterAll(async()=>{
 if(!fixture)return;
 mkdirSync(out,{recursive:true});
 writeFileSync(join(out,'workflow.json'),JSON.stringify({fixture:fixture.info,evidence},null,2));
 writeFileSync(join(out,'server.log'),readFileSync(fixture.info.logPath));
 try{writeFileSync(join(out,'observer.jsonl'),readFileSync(join(fixture.info.dataDir,'fable-observer.jsonl')));}finally{await fixture.close();}
});
for(const path of ['queue','card','memory','owner','queue-proven','memory-proven'] as const) {
 const proven=path==='owner'||path.endsWith('-proven');
 it(`FABLE ${path} shares authenticated turn authority across decision and service gates`,async()=>{
  const instance=(await api('GET','/api/instances')).body.instances.find((row:any)=>row.instanceId==='verification');
  const made=await api('POST','/api/bots',{name:'FABLE '+path,modelSelection:{instanceId:'verification',model:instance.models.options[0].id}});
  expect(made.status).toBe(201);const bot=made.body.bot;
  expect((await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false,autoReview:'off'})).status).toBe(200);
  expect((await raiseLevel(api,bot.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
  const prompt='__fixture_hold_authority__ FABLE:'+path;
  expect((await api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:prompt})).status).toBe(202);
  try {
   let observation:any,auth:Record<string,string>|undefined;
   await expect.poll(()=>{try{observation=readFileSync(join(fixture.info.dataDir,'fable-observer.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)).find(row=>row.botId===bot.id);return !!observation;}catch{return false;}},{timeout:30000}).toBe(true);
   evidence.push({path,observation});
   expect.soft(observation.initiator).toBe(proven?'owner-typed':'other-human');
   expect.soft(observation.level).toBe(proven?'unlimited':'ask');
   expect.soft(observation.origin).toBe(proven?'owner':'other-human');
   expect.soft(observation.service).toBe(proven);
   expect.soft(observation.folderDecision).toBe('reject');
   expect.soft(observation.folderRejects).toBe(1);
   expect.soft(observation.phoneOffered).toBe(true);
   expect.soft(observation.phoneOrigin).toBe(proven?'no-limits':null);
   await expect.poll(()=>{try{const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n').find(line=>line.includes(prompt));if(!line)return false;const dump=withTurnSecrets(JSON.parse(line));const token=dump.mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN;if(!token)return false;auth={authorization:'Bearer '+token};return true;}catch{return false;}},{timeout:30000}).toBe(true);
   for(const kind of ['routine','webhook'] as const){
    const name='FABLE proposal '+path+' '+kind;
    const result=await api('POST','/api/internal/routine-requests',{fromBotId:bot.id,fromThreadId:bot.threadId,action:'create',...(kind==='routine'?{routine:{name,instructions:'Inert fixture work',schedule:{type:'interval',everyMinutes:60}}}:{kind:'webhook',webhook:{name,instructions:'Inert fixture work'}})},auth);
    expect.soft(result.status,JSON.stringify(result.body)).toBe(201);
    expect.soft(result.body.autoApproved===true).toBe(proven);
    const saved=(await api('GET',kind==='routine'?'/api/routines':'/api/webhooks')).body;
    expect.soft((kind==='routine'?saved.routines:saved.webhooks).some((row:any)=>row.name===name)).toBe(proven);
   }
  } finally {await api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});}
 },60000);
}
