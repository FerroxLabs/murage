// SPDX-License-Identifier: AGPL-3.0-or-later
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {launchVerificationServer,runControlMurage,type VerificationServer} from '../scripts/control-murage.ts';
import {raiseLevel} from './testing/raise-level.ts';
let fixture:VerificationServer;
let headers:Record<string,string>={};
const commands:unknown[]=[];
async function api(method:string,path:string,body?:unknown){
 const response=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const result={status:response.status,body:await response.json() as any};
 if(!path.includes('secret'))commands.push({method,path,input:body,...result});return result;
}
beforeAll(async()=>{
 fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
  const {registerHooks}=await import('node:module');const fs=await import('node:fs');
  registerHooks({load(url,context,next){if(!url.endsWith('/email/external-marks.ts'))return next(url,context);
   const source=fs.readFileSync(new URL(url),'utf8');
   const anchor='export function beginGuardedOutsideTurn(threadId: string, instanceId: string, turnId: string | undefined, resumed: boolean): boolean {';
   if(!source.includes(anchor))throw Error('outside admission fixture anchor moved');
   return {format:'module-typescript',shortCircuit:true,source:source.replace(anchor,anchor+'noteStoreFailure();')};
  }});
 `});
 headers={'x-murage-surface':'desktop','x-murage-surface-secret':(await api('GET','/api/desktop-secret')).body.secret};
},120000);
afterAll(async()=>{
 mkdirSync('evidence/nolim-merge/outside-store',{recursive:true});
 if(fixture){writeFileSync('evidence/nolim-merge/outside-store/commands.json',JSON.stringify({fixture:fixture.info,commands},null,2));writeFileSync('evidence/nolim-merge/outside-store/server.log',readFileSync(fixture.info.logPath));}
 await fixture?.close();
});
it('M1 an outside-store write failure does not refuse a No limits owner turn',async()=>{
 const doctor=await runControlMurage(['doctor','--url',fixture.info.url],{env:{MURAGE_DATA_DIR:fixture.info.dataDir}});expect(doctor).toMatchObject({ok:true});
 const instance=(await api('GET','/api/instances')).body.instances.find((row:any)=>row.instanceId==='verification');
 const made=await api('POST','/api/bots',{name:'Outside failure fixture',modelSelection:{instanceId:'verification',model:instance.models.options[0].id}});expect(made.status).toBe(201);
 const bot=made.body.bot;expect((await raiseLevel(api,bot.id,{noLimits:true,acknowledgeNoLimits:true,computer:'off',browser:false,composio:false,autoReview:'off'})).status).toBe(200);
 const sent=await api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:'Outside store fixture hello'});expect(sent.status,JSON.stringify(sent.body)).toBe(202);
 const wait=await runControlMurage(['wait','--url',fixture.info.url,'--bot',bot.id,'--timeout','30'],{env:{MURAGE_DATA_DIR:fixture.info.dataDir}});commands.push({wait});expect((wait as {status:string}).status).not.toBe("failed");
 const messages=await api('GET',`/api/threads/${bot.threadId}/messages?limit=100`);
 expect(messages.body.messages.filter((message:any)=>message.role==='bot'&&String(message.text).includes('this turn did not run'))).toHaveLength(0);
 expect(messages.body.messages.some((message:any)=>message.role==='bot'&&message.kind==='text'&&String(message.text).includes('hello from fake claude'))).toBe(true);
 expect(messages.body.messages.filter((message:any)=>message.card?.requestId)).toHaveLength(0);
},60000);
