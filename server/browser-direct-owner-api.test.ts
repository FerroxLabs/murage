import {afterAll,beforeAll,expect,it} from 'vitest';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {launchVerificationServer,type VerificationServer} from '../scripts/control-murage.ts';
const instrumentation=`
import {registerHooks} from 'node:module';import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const dir=process.env.MURAGE_DATA_DIR,binary=join(dir,'fixture-engine');writeFileSync(binary,'#!/bin/sh\\nexit 0\\n',{mode:0o755});process.env.MURAGE_AGENT_BROWSER_PATH=binary;
const cfg=JSON.parse(readFileSync(join(dir,'config.json'),'utf8'));cfg.features={browser:true};writeFileSync(join(dir,'config.json'),JSON.stringify(cfg));
writeFileSync(join(dir,'bots.json'),JSON.stringify([{id:'direct',name:'Ava',threadId:'thread-direct',tasks:[],useMyChrome:true,modelSelection:{instanceId:'verification',model:'fake-model'}}]));writeFileSync(join(dir,'endpoint'),'one');
registerHooks({load(url,context,next){
 if(url.endsWith('/browser-direct-readiness.ts'))return{format:'module',shortCircuit:true,source:'import {readFileSync} from \"node:fs\";export function directConnectionState(proxy,endpoint){return proxy?.chromeEndpoint===endpoint?proxy.state:\"absent\";}export async function observeDirectReadiness(){return readFileSync(process.env.MURAGE_DATA_DIR+\"/readiness\",\"utf8\");}'};
 if(url.endsWith('/user-chrome.ts')){let source=readFileSync(new URL(url),'utf8');source=source.replace('export async function userChromeListening(dataDir: string = userChromeDataDir(), timeoutMs = 1000): Promise<\"listening\" | \"off\"> {','export async function userChromeListening(dataDir: string = userChromeDataDir(), timeoutMs = 1000): Promise<\"listening\" | \"off\"> { return \"listening\";');source=source.replace('export function readUserChromeEndpoint(dataDir: string = userChromeDataDir()): string | null {','export function readUserChromeEndpoint(dataDir: string = userChromeDataDir()): string | null { return "ws://127.0.0.1:9222/devtools/browser/"+readFileSync(process.env.MURAGE_DATA_DIR+"/endpoint","utf8");');return{format:'module-typescript',shortCircuit:true,source:'import {readFileSync} from "node:fs";\\n'+source};}
 if(url.endsWith('/user-chrome-proxy.ts'))return{format:'module',shortCircuit:true,source:'export class UserChromeProxy {static async start(endpoint){return {chromeEndpoint:endpoint,state:endpoint.endsWith("new-waiting")?"idle":"allowed",engineUrl:endpoint,guardUrl:endpoint,botScope:()=>new Set(),async close(){this.state="closed";}};}}'};
 if(url.endsWith('/browser-native-relay.ts'))return{format:'module',shortCircuit:true,source:'export function createNativeBrowser(){return {protected:async()=>false,request:async()=>({tools:[]}),command:async()=>({}),connect:async()=>"stream",input(){},resetStream(){},close:async()=>{}};}'};
 if(url.endsWith('/browser-engine.ts')){const source=readFileSync(new URL(url),'utf8').replace('if (browserHostRequiresSandboxBypass({','if (false && browserHostRequiresSandboxBypass({'),a=source.indexOf('export async function verifyAgentBrowserBinary('),b=source.indexOf('export async function ensureChrome(',a);return{format:'module-typescript',shortCircuit:true,source:source.slice(0,a)+'export async function verifyAgentBrowserBinary() {}\\n'+source.slice(b)};}
 if(url.endsWith('/server/index.ts')){let source=readFileSync(new URL(url),'utf8');source=source.replace('try { await unifiedBrowser.forgetEntry(key); }','try { const fixtureRace=readFileSync(process.env.MURAGE_DATA_DIR+"/endpoint","utf8");if(fixtureRace.startsWith("race-")){await unifiedBrowser.take(key,fixtureOwner);if(["race-proxy","race-both"].includes(fixtureRace))userChromeProxies.set(botId,{...withdrawn.proxy,chromeEndpoint:"successor-"+fixtureRace});if(["race-binding","race-both"].includes(fixtureRace))for(const [memo,binding] of withdrawn.bindings)unifiedBrowserBindings.set(memo,{...binding,fixtureSuccessor:true});} await unifiedBrowser.forgetEntry(key); }');source=source.replace('const rebindAfterHold = new Set<string>();','let fixtureOwner=""; const rebindAfterHold = new Set<string>();');source=source.replace('    if (path === \"/api/browser-extension/clients\") {','    if(path === \"/api/fixture/capture-owner\") {fixtureOwner=unifiedBrowser.status(currentSessionKey(\"direct\")).owner;return json(res,200,{captured:!!fixtureOwner});}\\n    if (path === \"/api/browser-extension/clients\") {');const anchor='    if (path === "/api/browser-extension/clients") {';source=source.replace(anchor,'    if(path === "/api/fixture/admission") {const threadId=store.bot("direct").threadId;beginInternalTurn("direct",threadId,"fixture-admission-owner",0,false);const result=await browserIntegration("direct",undefined,threadId,()=>true,"fixture-admission-owner");const snapshot=turnBrowsers.get(threadId)?.snapshot;await releaseBrowserCapabilityForThread(threadId);return json(res,200,{result,snapshot});}\\n'+anchor);source=source.replace(anchor,'    if(path === "/api/fixture/direct-state") return json(res,200,{endpoint:userChromeProxies.get("direct")?.chromeEndpoint,published:!!unifiedBrowserBindings.size,state:userChromeProxies.get("direct")?.state,successorBinding:[...unifiedBrowserBindings.values()].some(value=>value.fixtureSuccessor)});\\n    if(path === "/api/fixture/direct-bind") { const binding=await unifiedBrowserBinding("direct",undefined); return json(res,200,{key:binding.key,endpoint:userChromeProxies.get("direct")?.chromeEndpoint,published:!!unifiedBrowserBindings.size,state:userChromeProxies.get("direct")?.state,successorBinding:[...unifiedBrowserBindings.values()].some(value=>value.fixtureSuccessor)}); }\\n'+anchor);return{format:'module-typescript',shortCircuit:true,source};}
 return next(url,context);
}});
`;
let fixture:VerificationServer,headers:Record<string,string>;
const call=async(path:string,body?:unknown)=>{const response=await fetch(fixture.info.url+path,{headers:{...headers,'content-type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});return{status:response.status,body:await response.json() as any};};
beforeAll(async()=>{fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:instrumentation});const proof=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};headers={'x-murage-surface':'desktop','x-murage-surface-secret':proof.secret};console.log('S3 direct HTTP fixture',JSON.stringify(fixture.info));},60000);
afterAll(async()=>{await fixture?.close();});
it('T21/M57s/M60s real HTTP Hand back retains held direct publications and drains endpoint rebind',async()=>{
 const first=await call('/api/fixture/direct-bind');expect(first.status).toBe(200);
 const held=await call('/api/bots/direct/browser',{action:'take',expectedKey:first.body.key,expectedRevision:0});expect(held.status).toBe(200);
 writeFileSync(join(fixture.info.dataDir,'endpoint'),'two');
 expect(await call('/api/fixture/direct-bind')).toMatchObject({status:409,body:{error:'Paused for you · Hand back first'}});
 expect(await call('/api/bots/direct/browser')).toMatchObject({status:200,body:{held:true,sessionKey:first.body.key}});
 expect(await call('/api/bots/direct/browser',{action:'release',expectedKey:first.body.key,expectedRevision:0,control:held.body.control})).toMatchObject({status:200,body:{held:false}});
 await expect.poll(async()=>(await call('/api/fixture/direct-state')).body.endpoint,{timeout:2000}).toBe('ws://127.0.0.1:9222/devtools/browser/two');
 const next=await call('/api/fixture/direct-bind');expect(next).toMatchObject({status:200,body:{endpoint:'ws://127.0.0.1:9222/devtools/browser/two',published:true}});
},15000);

it.each(['empty','proxy','binding','both'])('T21 HTTP take during withdrawn teardown preserves %s slots',async slots=>{
 const first=await call('/api/fixture/direct-bind');const held=await call('/api/bots/direct/browser',{action:'take',expectedKey:first.body.key,expectedRevision:0});
 expect((await call('/api/fixture/capture-owner')).body.captured).toBe(true);
 expect((await call('/api/bots/direct/browser',{action:'release',expectedKey:first.body.key,expectedRevision:0,control:held.body.control})).status).toBe(200);
 writeFileSync(join(fixture.info.dataDir,'endpoint'),'race-'+slots);
 expect(await call('/api/fixture/direct-bind')).toMatchObject({status:409,body:{error:'Paused for you · Hand back first'}});
 expect(await call('/api/fixture/direct-state')).toMatchObject({status:200,body:{published:true,state:'allowed',successorBinding:['binding','both'].includes(slots),endpoint:['proxy','both'].includes(slots)?'successor-race-'+slots:first.body.endpoint}});
 const status=await call('/api/bots/direct/browser');expect(status).toMatchObject({status:200,body:{held:true,owned:true}});
 writeFileSync(join(fixture.info.dataDir,'endpoint'),'after-race-'+slots);
 expect((await call('/api/bots/direct/browser',{action:'release',expectedKey:first.body.key,expectedRevision:0,control:status.body.control})).status).toBe(200);
 await expect.poll(async()=>(await call('/api/fixture/direct-state')).body.endpoint,{timeout:2000}).toBe('ws://127.0.0.1:9222/devtools/browser/after-race-'+slots);
},15000);

it.each(['chrome_closed','debugging_off','allow_not_given','chrome_status_unknown'])('direct admission names %s before a browser call',async cause=>{
 writeFileSync(join(fixture.info.dataDir,'readiness'),cause);
 const result=await call('/api/fixture/admission');
 expect(result,JSON.stringify(result)).toMatchObject({status:200,body:{result:{unavailable:expect.stringContaining(`browser-cause:${cause}:0|`)},snapshot:{readiness:{kind:cause==='allow_not_given'?'waiting':'unavailable'}}}});
 console.log('S3 direct readiness',JSON.stringify({cause,...result}));
});

it('direct admission rechecks Allow after a restarted Chrome is bound',async()=>{
 writeFileSync(join(fixture.info.dataDir,'readiness'),'ready');
 writeFileSync(join(fixture.info.dataDir,'endpoint'),'new-waiting');
 const result=await call('/api/fixture/admission');
 expect(result,JSON.stringify(result)).toMatchObject({status:200,body:{result:{unavailable:expect.stringContaining('browser-cause:allow_not_given:0|')}}});
 expect(result.body.result.integration).toBeUndefined();
});

it('EP12 explicit direct always probes Chrome',async()=>{expect(await call('/api/bots/direct/browser-choice/preview?mode=your-chrome&route=chrome-direct')).toMatchObject({status:200,body:{listening:'listening'}});});
it('T21 a restored held direct entry registers without losing the owner’s Hand back',async()=>{
 await fixture.close();
 const seed=`const key='murage-uc-'+createHash('sha256').update(JSON.stringify(['original-installation',['user-chrome','direct']])).digest('hex').slice(0,32);writeFileSync(join(dir,'browser-control.json'),JSON.stringify([[key,{held:true,owner:createHash('sha256').update('original-installation:desktop').digest('hex').slice(0,32),generation:4}]]));`;
 fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:"import {createHash} from 'node:crypto';\n"+instrumentation.replace('registerHooks({load',seed+'\nregisterHooks({load')});
 const proof=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};headers={'x-murage-surface':'desktop','x-murage-surface-secret':proof.secret};console.log('S3 restored direct fixture',JSON.stringify(fixture.info));
 const held=await call('/api/bots/direct/browser');expect(held).toMatchObject({status:200,body:{held:true,owned:true}});
 writeFileSync(join(fixture.info.dataDir,'endpoint'),'two');expect((await call('/api/fixture/direct-bind')).status).toBe(409);
 expect(await call('/api/bots/direct/browser',{action:'release',expectedKey:held.body.sessionKey,expectedRevision:0,control:held.body.control})).toMatchObject({status:200,body:{held:false}});
 await expect.poll(async()=>(await call('/api/fixture/direct-state')).body.endpoint,{timeout:2000}).toBe('ws://127.0.0.1:9222/devtools/browser/two');
},60000);
it('builtin locked-page recovery and restart execute through owner HTTP with the current revision',async()=>{
 const preview=await call('/api/bots/direct/browser-choice/preview?mode=builtin');
 const switched=await fetch(fixture.info.url+'/api/bots/direct',{method:'PATCH',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({browserChoice:{mode:'builtin',baseRevision:preview.body.baseRevision,disclosureKey:preview.body.disclosure.disclosureKey}})});
 expect(switched.status).toBe(200);
 let status=(await call('/api/bots/direct/browser')).body;
 const act=async(action:string,extra:Record<string,unknown>={})=>call('/api/bots/direct/browser',{action,expectedKey:status.sessionKey,expectedRevision:status.selectionRevision,generation:status.generation,control:status.control,...extra});
 status=(await act('take')).body;
 expect((await act('input',{event:{type:'input_keyboard',eventType:'char',text:'fixture'}})).status).toBe(200);
 const admission=await call('/api/fixture/admission');expect(admission.body.result.unavailable).toContain('browser-cause:builtin_page_locked:0|');
 const reopened=await act('reopen');expect(reopened).toMatchObject({status:200,body:{protectedDocument:false}});status=reopened.body;
 const released=await act('release');expect(released.status).toBe(200);status=released.body;
 expect(await act('restart')).toMatchObject({status:200,body:{protectedDocument:false}});
 const ready=await call('/api/fixture/admission');expect(ready.body.result.integration,JSON.stringify(ready.body)).toBeTruthy();
 console.log('S3 builtin recovery HTTP',JSON.stringify({locked:admission.body.result,reopened:reopened.status,released:released.status,restarted:true}));
},15000);
