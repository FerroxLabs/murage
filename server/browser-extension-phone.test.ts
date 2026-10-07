// Real companion cookie pairing and owner approval against isolated Murage.
// Browser transport is explicitly fake; no physical phone/native browser claim.
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
const launchProof = randomBytes(32).toString("hex");
const instrumentation = `
process.env.MURAGE_COMPANION_TOKEN=${JSON.stringify(launchProof)};
globalThis.__murageFixtureBrowserEngine=options=>({
 async call(name,args){
  const doc=await options.transport.selected();
  if(name==='agent_browser_open'){await options.beforeDestination(args.url,doc);await options.transport.send('Page.navigate',{url:args.url},doc);return {content:[{type:'text',text:'Fixture navigation complete'}]};}
  if(name==='agent_browser_press'){const params={type:'keyDown',key:args.key};await options.beforeCommand(doc,'Input.dispatchKeyEvent',params);await options.transport.send('Input.dispatchKeyEvent',params,doc);return {content:[{type:'text',text:'Fixture key dispatched'}]};}
  throw Error('Unsupported declared fixture engine operation');
 },
 async resolveTarget(){return {backendNodeId:1,document:await options.transport.selected()};},
 async resolveTab(){return options.transport.selected();},event(){},async close(){}
});
const {registerHooks}=await import('node:module');
registerHooks({load(url,context,next){
 if(url.endsWith('/server/index.ts')){const result=next(url,context);const source=String(result.source),needle='new BrowserExtensionIntegration({';if(source.split(needle).length!==2)throw Error('Fixture integration anchor changed');return {...result,source:source.replace('checkerInstances: () => registry.instances()','checkerInstances: () => []').replace(needle,needle+'createEngine:globalThis.__murageFixtureBrowserEngine,collectFacts:async(_i,_t,operation)=>({operation,visibility:{box:{x:1,y:1,width:50,height:20},inViewport:true,opacity:1,visibility:"visible",ariaHidden:false,coveredBy:null}}),')};}
 if(url.endsWith('/browser-extension-registration.mjs'))return {format:'module',shortCircuit:true,source:"export async function connectOwnerBrowser(input){if(!input.ownerConfirmed)throw Error('consent');return {status:'installed',connected:false}};export async function removeOwnerBrowser(){return {status:'removed'}}"};
 if(!url.endsWith('/browser-extension-broker.ts'))return next(url,context);
 return {format:'module',shortCircuit:true,source:\`
 import {appendFileSync} from 'node:fs';
 export async function startBrowserExtensionBroker(){
  const bindings=new Map();
  return {configPath:'/fixture-only/no-native-registration',profiles:()=>[{version:1,type:'hello',profileId:'fixture_profile',browser:'chromium',extensionVersion:'1',capabilities:['scoped_cdp','durable_stop','explicit_share','manual_pause','unexpected_input_pause','engine_cdp_v1','ordered_requests_v1']}],close:async()=>{},request:async(profile,command)=>{
   let b=bindings.get(command.bindingId);
   if(command.operation==='bind'&&!b){b={generation:1,state:'active',tabs:[{tabId:bindings.size+1,navigationEpoch:1,origin:'null',url:'about:blank'}]};bindings.set(command.bindingId,b)}
   let result=b;
   if(command.operation==='stop'||command.operation==='pause'){b.generation++;b.state=command.operation==='stop'?'stopped':'paused'}
   if(command.operation==='cdp'){
    const {method,params}=command.params;let r={};const tab=b.tabs[0];
    if(method==='Page.navigate'){tab.url=params.url;tab.origin=new URL(params.url).origin;tab.navigationEpoch++}
    if(method==='Page.getFrameTree')r={frameTree:{frame:{id:'frame',loaderId:'L'}}};
    if(method==='Page.createIsolatedWorld')r={executionContextId:7};
    if(method==='DOM.getDocument')r={root:{nodeId:1}};
    if(method==='DOM.describeNode')r={node:{backendNodeId:1}};
    if(method==='DOM.resolveNode')r={object:{objectId:'fixture-target'}};
    if(method==='Runtime.callFunctionOn')r={result:{type:params.functionDeclaration.includes('elementFromPoint')?'boolean':'string',value:params.functionDeclaration.includes('elementFromPoint')?true:'fixture target'}};
    if(method==='Runtime.evaluate')r={result:{type:'boolean',value:params.expression.includes('__murageGuard()')?false:'fixture target'}};
    if(method==='Runtime.evaluate'&&params.expression==='document.activeElement||document.body')r={result:{type:'object',subtype:'node',objectId:'fixture-active'}};
    if(method==='Accessibility.getFullAXTree')r={nodes:[]};
    if(method.startsWith('Input.'))appendFileSync(process.env.MURAGE_DATA_DIR+'/phone-input.jsonl',JSON.stringify({method,params})+String.fromCharCode(10));
    result={result:r,...tab};
   }
   return{version:1,type:'response',id:command.id,bindingId:command.bindingId,generation:command.generation,result};
  }};
 }
 \`};
}});
`;

let fixture: VerificationServer, door: Server, doorUrl: string;
let registry: import("../companion/src/devices.ts").DeviceRegistry;
let owner: Record<string,string> = {}, client: Record<string,string> = {}, cookie = "";
let threadId: string, clientId: string, registryRoot: string, pairedDeviceId: string;
async function request(path: string, body?: unknown, headers = owner, base?: string) {
  const res = await fetch((base ?? fixture.info.url) + path, {method: body === undefined ? "GET" : "POST", headers: {...headers,"content-type":"application/json"}, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status:res.status,body:await res.json() as any,headers:res.headers};
}
function phone(path:string,body?:unknown,authenticated=true) {
 return request(path,body,{origin:doorUrl,"sec-fetch-site":"same-origin",...(authenticated?{cookie}:{})},doorUrl);
}
async function pendingCard() {
 let card:any;
 await expect.poll(async()=>{
  const r=await phone(`/api/threads/${threadId}/messages`);
  expect(r.status).toBe(200);
  const messages=r.body.messages;
  card=messages.findLast((m:any)=>m.card?.tool==="browser_extension_action"&&!m.card.answered)?.card;
  return !!card;
 },{timeout:10000}).toBe(true);
 return card;
}
function inputCount(){const path=join(fixture.info.dataDir,"phone-input.jsonl");return existsSync(path)?readFileSync(path,"utf8").trim().split("\n").filter(Boolean).length:0;}
function press(){return request("/api/browser-extension/mcp",{method:"tools/call",params:{name:"agent_browser_press",arguments:{key:"Enter"}}},client);}
beforeAll(async()=>{
 registryRoot=mkdtempSync(join(tmpdir(),"phone-registry-"));
 process.env.MURAGE_COMPANION_DIR=registryRoot;
 const {DATA_DIR}=await import("../companion/src/state.ts");
 expect(DATA_DIR).toBe(registryRoot);
 const {createBrowserHandler}=await import("../companion/src/browser.ts");
 const {DeviceRegistry}=await import("../companion/src/devices.ts");
 registry=new DeviceRegistry();
 fixture=await launchVerificationServer({},undefined,{instrumentationSource:instrumentation});
 const secret=await request("/api/desktop-secret");owner={"x-murage-surface":"desktop","x-murage-surface-secret":secret.body.secret};
 expect((await fetch(fixture.info.url+"/api/config",{method:"PATCH",headers:{...owner,"content-type":"application/json"},body:JSON.stringify({features:{browser:true}})})).status).toBe(200);
 const existing=(await request("/api/bots")).body.bots[0];
 expect((await request(`/api/bots/${existing.id}/browser-extension`,{action:"connect"})).status).toBe(200);
 await request("/api/browser-extension/clients",{action:"enabled",enabled:true});
 const paired=await request("/api/browser-extension/clients",{action:"pair",label:"Phone approval fixture",profileId:"fixture_profile"});
 expect(paired.status).toBe(201);({threadId,clientId}=paired.body);
 const saved=JSON.parse(readFileSync(paired.body.config.mcpServers["murage-browser"].env.MURAGE_BROWSER_MCP_CONFIG,"utf8"));
 client={authorization:`Bearer ${saved.token}`,"x-murage-browser-client":saved.clientId};
 door=createServer(createBrowserHandler({harnessPort:Number(new URL(fixture.info.url).port),companionToken:launchProof,identity:()=>({scheme:"http",hosts:new Set(["127.0.0.1"])}),devices:registry,serverName:()=>"Isolated phone qualification"}));
 await new Promise<void>(resolve=>door.listen(0,"127.0.0.1",resolve));
 doorUrl=`http://127.0.0.1:${(door.address() as import("node:net").AddressInfo).port}`;
 expect((await phone("/api/bots",undefined,false)).status).toBe(401);
 const session=await phone("/session",{credential:registry.openPairing().code},false);
 expect(session.status).toBe(201);
 cookie=session.headers.get("set-cookie")!.split(";")[0];
 expect(registry.list()).toHaveLength(1);
 pairedDeviceId=registry.resolveSession(cookie.slice(cookie.indexOf("=")+1))!.device.id;
},60000);
afterAll(async()=>{
 if(door){door.closeAllConnections();await new Promise<void>(resolve=>door.close(()=>resolve()));}
 await fixture?.close();
 if(registryRoot)rmSync(registryRoot,{recursive:true,force:true});
});
it("a paired phone cannot register or remove the browser helper on the computer",async()=>{
 const botId=(await request("/api/bots")).body.bots[0].id;
 // The phone door does not forward the owner browser routes at all.
 for(const body of [undefined,{action:"connect"},{action:"remove"}]) expect((await phone(`/api/bots/${botId}/browser-extension`,body)).status).toBe(404);
 // Behind the door, a companion-forwarded request may read status and stop
 // work, but writing or deleting native registration needs the desktop.
 const companion={"x-murage-companion-token":launchProof};
 expect((await request(`/api/bots/${botId}/browser-extension`,undefined,companion)).status).toBe(200);
 for(const action of ["connect","remove"]){
  const refused=await request(`/api/bots/${botId}/browser-extension`,{action},companion);
  expect(refused.status).toBe(403);
  expect(refused.body.error).toBe("This needs the Murage app on your computer.");
 }
 expect((await request(`/api/bots/${botId}/browser-extension`,{action:"stop",bindingId:"not-this-bot"},companion)).status).toBe(404);
});
it("a paired browser sees the real card but cannot allow the site or the action; the computer can",async()=>{
 // SEC-006: extension cards are unrated, so a phone or browser Allow is high-risk. Through the door a browser
 // pairing is refused with approve_on_computer, because the door forwards the device class from its registry.
 const refusal=/^approve_on_computer$/;
 const navigating=request("/api/browser-extension/mcp",{method:"tools/call",params:{name:"agent_browser_open",arguments:{url:"https://fixture.test/"}}},client);
 const site=await pendingCard();
 expect((await phone(`/api/threads/${threadId}/respond`,{requestId:site.requestId,behavior:"allow"},false)).status).toBe(401);
 const refused=await phone(`/api/threads/${threadId}/respond`,{requestId:site.requestId,behavior:"allow"});
 expect(refused.status).toBe(403);expect(refused.body.code).toMatch(refusal);
 expect((await request(`/api/threads/${threadId}/respond`,{requestId:site.requestId,behavior:"allow"})).status).toBe(200);
 expect((await navigating).status).toBe(200);
 const before=inputCount(), running=press(), action=await pendingCard();
 expect(action.held).toContain("once");
 expect((await phone(`/api/threads/${threadId}/respond`,{requestId:action.requestId,behavior:"allow"})).body.code).toMatch(refusal);
 expect((await request(`/api/threads/${threadId}/respond`,{requestId:action.requestId,behavior:"allow"})).status).toBe(200);
 const result=await running;expect(result.status,JSON.stringify(result.body)).toBe(200);
 expect(inputCount()).toBeGreaterThan(before);
});
it("Deny from paired browser causes no input dispatch",async()=>{
 const before=inputCount(),running=press(),action=await pendingCard();
 expect((await phone(`/api/threads/${threadId}/respond`,{requestId:action.requestId,behavior:"deny"})).status).toBe(200);
 expect((await running).status).toBe(409);expect(inputCount()).toBe(before);
});
it("revoked paired browser cannot approve a pending action",async()=>{
 const before=inputCount(),running=press(),action=await pendingCard();
 expect(registry.revoke(pairedDeviceId)).toBe(true);
 expect((await phone(`/api/threads/${threadId}/respond`,{requestId:action.requestId,behavior:"allow"})).status).toBe(401);
 expect(inputCount()).toBe(before);
 // Desktop owner cancels the blocked pending action; revoking the phone does not imply cancelling the browser client.
 expect((await request("/api/browser-extension/clients",{action:"revoke",clientId})).status).toBe(200);
 expect((await running).status).toBeGreaterThanOrEqual(400);expect(inputCount()).toBe(before);
});
