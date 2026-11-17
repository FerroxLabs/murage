// SPDX-License-Identifier: AGPL-3.0-or-later
import {afterAll,beforeAll,expect,it} from 'vitest';
import {launchVerificationServer,type VerificationServer} from '../scripts/control-murage.ts';
import {raiseLevel} from './testing/raise-level.ts';
let fixture:VerificationServer,headers:Record<string,string>;
const instrumentation=`const{registerHooks}=await import('node:module');registerHooks({load(url,context,next){if(url.endsWith('/server/browser-owner-session.ts'))return{format:'module',shortCircuit:true,source:"export async function browserOwnerSessionRequest(){throw new Error('switched-off browser reached dispatch');}"};return next(url,context);}});`;
async function api(method:string,path:string,body?:unknown){const res=await fetch(fixture.info.url+path,{method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:res.status,body:await res.json() as any};}
beforeAll(async()=>{fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:instrumentation});const secret=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};headers={'x-murage-surface':'desktop','x-murage-surface-secret':secret.secret};},120000);
afterAll(async()=>{await fixture?.close();});
it.each(['ask','unlimited'] as const)('08:05 browser feature off never dispatches or cards and names Settings at %s',async level=>{
 const instances=(await api('GET','/api/instances')).body.instances;const instance=instances.find((x:any)=>x.instanceId==='verification');
 const made=await api('POST','/api/bots',{name:'Disabled browser '+level,modelSelection:{instanceId:'verification',model:instance.models.options[0].id}});expect(made.status).toBe(201);const bot=made.body.bot;
 expect((await api('PATCH',`/api/bots/${bot.id}`,{browser:false,computer:'off',composio:false,settingsScope:'defaults',autoApprove:false,fullAccess:false,noLimits:false})).status).toBe(200);
 if(level==='unlimited')expect((await raiseLevel(api,bot.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
 const before=(await api('GET',`/api/threads/${bot.threadId}/messages?limit=100`)).body.messages;
 const beforeCards=before.filter((m:any)=>m.card);expect(beforeCards.filter((m:any)=>m.card.approvalId||m.card.requestId)).toHaveLength(0);
 const result=await api('POST',`/api/bots/${bot.id}/browser`,{method:'tools/call',params:{name:'browser_navigate',arguments:{url:'https://example.invalid/'}}});
 expect(result.status,JSON.stringify(result.body)).toBe(403);expect(result.body.error).toMatch(/browser.*off.*Settings/i);expect(result.body.error.split('\n')).toHaveLength(1);
 expect((await api('GET',`/api/bots/${bot.id}`)).body.bot.browser).toBe(false);
 const messages=(await api('GET',`/api/threads/${bot.threadId}/messages?limit=100`)).body.messages;expect(messages.filter((m:any)=>m.card)).toEqual(beforeCards);
},60000);
