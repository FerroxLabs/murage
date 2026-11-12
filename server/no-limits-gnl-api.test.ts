// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { launchVerificationServer,type VerificationServer } from '../scripts/control-murage.ts';
import { withTurnSecrets } from './testing/fixture-dump.ts';
import { raiseLevel } from './testing/raise-level.ts';
let fixture:VerificationServer,desktop:Record<string,string>={};
const evidence:unknown[]=[];
const instrumentation=`
process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';process.env.FAKE_CLAUDE_MODE='hang';
const fs=await import('node:fs'),path=await import('node:path');
const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
cfg.newBots={...cfg.newBots,permissionLevel:'no-limits'};fs.writeFileSync(file,JSON.stringify(cfg));
const {registerHooks}=await import('node:module');
registerHooks({load(url,context,next){
 if(!url.endsWith('/server/index.ts'))return next(url,context);
 let source=fs.readFileSync(new URL(url),'utf8');
 const anchor='function makeDecisionProvenance(botId: string, threadId: string, generation: string, initiator: Initiator, ownerAudience: boolean): TurnProvenance {';
 if(!source.includes(anchor))throw Error('GNL fixture anchor moved');
 source=source.replace(anchor,anchor+"const stored=store.bot(botId);if(stored?.name==='GNL legacy'){stored.autoApprove=true;stored.fullAccess=true;stored.noLimits=true;delete stored.permissionExplicit;stored.permissionRev=0;}");
 return {format:'module-typescript',shortCircuit:true,source};
}});
`;
async function api(method:string,path:string,body?:unknown,headers=desktop){
 const res=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const result={status:res.status,body:await res.json() as any};
 if(!path.includes('secret')&&!result.body?.credential)evidence.push({method,path,...result});
 return result;
}
beforeAll(async()=>{
 fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:instrumentation,dumpLog:true});
 desktop={'x-murage-surface':'desktop','x-murage-surface-secret':(await api('GET','/api/desktop-secret',undefined,{})).body.secret};
},120000);
afterAll(async()=>{
 mkdirSync('evidence/gnl',{recursive:true});writeFileSync('evidence/gnl/f3-workflow.json',JSON.stringify({fixture:fixture?.info,evidence},null,2));await fixture?.close();
});
it.each(['explicit','inherited','legacy'] as const)('F3 real webhook %s uses the stored bot provenance',async state=>{
 const model=(await api('GET','/api/instances')).body.instances.find((x:any)=>x.instanceId==='verification').models.options[0].id;
 const bot=(await api('POST','/api/bots',{name:`GNL ${state}`,modelSelection:{instanceId:'verification',model}})).body.bot;
 await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false,autoReview:'off'});
 if(state==='explicit')expect((await raiseLevel(api,bot.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
 const name=`GNL ${state} webhook`;
 const hook=await api('POST','/api/webhooks',{name,prompt:'__fixture_hold_authority__ '+name,botId:bot.id,runOn:'ember'});expect(hook.status).toBe(201);
 const response=await fetch(hook.body.credential.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fixture:'ping'})});expect(response.status).toBe(202);
 const runId=(await response.json() as any).runId;let dump:any;
 await expect.poll(()=>{try{const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').trim().split('\n').find(x=>x.includes(name));if(!line)return false;dump=withTurnSecrets(JSON.parse(line));return Boolean(dump.mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN);}catch{return false;}},{timeout:30000}).toBe(true);
 const run=(await api('GET','/api/routines')).body.runs.find((r:any)=>r.id===runId);
 try{
  const result=await api('POST','/api/internal/routine-requests',{fromBotId:bot.id,fromThreadId:run.threadId,action:'create',routine:{name:'GNL child '+state,instructions:'Fixture witness',schedule:{type:'interval',everyMinutes:60}}},{authorization:'Bearer '+dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN});
  expect(result.status,JSON.stringify(result.body)).toBe(state==='legacy'?403:201);
  if(state==='legacy')expect(result.body.error).toContain("only be set up in the owner's own conversation");
  else expect(result.body.autoApproved).toBe(true);
  const messages=(await api('GET',`/api/threads/${run.threadId}/messages?limit=100`)).body.messages;
  expect(messages.filter((m:any)=>m.card?.routineRequest)).toHaveLength(0);
  expect((await api('GET','/api/routines')).body.routines.some((r:any)=>r.name==='GNL child '+state)).toBe(state!=='legacy');
 }finally{await api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:run.threadId});}
},90000);
