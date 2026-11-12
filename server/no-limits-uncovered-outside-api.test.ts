// SPDX-License-Identifier: AGPL-3.0-or-later
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {launchVerificationServer,runControlMurage} from '../scripts/control-murage.ts';
import {raiseLevel} from './testing/raise-level.ts';
it('outside-store failure: No limits owner turn starts and finishes; Ask still reports the store failure',async()=>{
 const instrumentation=`const fs=await import('node:fs');const {registerHooks}=await import('node:module');registerHooks({load(url,context,next){if(!url.endsWith('/email/external-marks.ts'))return next(url,context);const source=fs.readFileSync(new URL(url),'utf8');const anchor='if (sealed || shuttingDown || flushBoundary || storeFailed) return false;';if(!source.includes(anchor))throw Error('outside fixture anchor changed');return {format:'module-typescript',shortCircuit:true,source:source.replaceAll(anchor,'if (true) return false;')};}});`;
 const fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:instrumentation});
 const evidence:any={fixture:fixture.info,calls:[]};let headers:Record<string,string>={};
 const api=async(method:string,path:string,body?:unknown)=>{const res=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result={status:res.status,body:await res.json() as any};evidence.calls.push({method,path,status:res.status,body:result.body?.secret?'[fixture secret omitted]':result.body});return result;};
 try{
  const secret=await api('GET','/api/desktop-secret');headers={'x-murage-surface':'desktop','x-murage-surface-secret':secret.body.secret};
  const instances=(await api('GET','/api/instances')).body.instances,engine=instances.find((x:any)=>x.instanceId==='verification');
  const bot=(await api('POST','/api/bots',{name:'Outside failure fixture',modelSelection:{instanceId:'verification',model:engine.models.options[0].id}})).body.bot;
  const lower=await api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:'fixture'});expect(lower.status).toBe(202);
  const lowerWait=await runControlMurage(['wait','--bot',bot.id,'--timeout','15','--url',fixture.info.url],{env:{MURAGE_DATA_DIR:fixture.info.dataDir}});evidence.lowerWait=lowerWait;
  expect(lowerWait).not.toMatchObject({status:'timed-out'});
  await expect.poll(async()=>{
   const lowerMessages=(await api('GET',`/api/threads/${bot.threadId}/messages?limit=20`)).body.messages;evidence.lowerMessages=lowerMessages;
   return lowerMessages.some((m:any)=>[m.text,m.tool?.name].some(text=>String(text).includes('this turn did not run')));
  },{timeout:15000}).toBe(true);
  expect((await raiseLevel(api,bot.id,{noLimits:true,acknowledgeNoLimits:true,computer:'off',browser:false,composio:false,autoReview:'off'})).status).toBe(200);
  const start=await api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:'Hello fixture'});expect(start.status,JSON.stringify(start.body)).toBe(202);
  const waited=await runControlMurage(['wait','--bot',bot.id,'--timeout','15','--url',fixture.info.url],{env:{MURAGE_DATA_DIR:fixture.info.dataDir}});evidence.waited=waited;
  expect(waited).toMatchObject({status:'settled'});
  await expect.poll(async()=>{
   const rows=(await api('GET',`/api/threads/${bot.threadId}/messages?limit=40`)).body.messages;
   return rows.some((m:any)=>m.role==='bot'&&String(m.text).includes('hello from fake claude'));
  },{timeout:15000}).toBe(true);
  const messages=(await api('GET',`/api/threads/${bot.threadId}/messages?limit=20`)).body.messages;evidence.messages=messages;
  expect(messages.filter((m:any)=>m.card?.requestId)).toHaveLength(0);
  expect(readFileSync(fixture.info.logPath,'utf8')).toContain('outside-content record unavailable; continuing with the wipe check');
 }finally{mkdirSync('evidence/nolim-rows',{recursive:true});writeFileSync('evidence/nolim-rows/outside-store-workflow.json',JSON.stringify(evidence,null,2));await fixture.close();}
},90000);
