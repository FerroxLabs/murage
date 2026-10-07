// SPDX-License-Identifier: AGPL-3.0-or-later
// Real Murage HTTP/approval flow with a declared fake browser broker, not native proof.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
const instrumentation = `
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
    if(method.startsWith('Input.'))throw Error('fixture_forbidden_input_was_dispatched');
    result={result:r,...tab};
   }
   return{version:1,type:'response',id:command.id,bindingId:command.bindingId,generation:command.generation,result};
  }};
 }
 \`};
}});
`;
let fixture: VerificationServer;
let owner: Record<string, string> = {};
let client: Record<string, string> = {};
let clientId: string, botId: string, threadId: string;
async function request(path: string, body?: unknown, headers = owner) {
  const res = await fetch(fixture.info.url + path, { method: body === undefined ? "GET" : "POST", headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}
async function pendingCard() {
  let card: any;
  await expect.poll(async () => {
    const response = await request("/api/bots");
    card = response.body.bots.find((bot: any) => bot.id === botId)?.messages?.findLast((message: any) => message.card?.tool === "browser_extension_action" && !message.card.answered)?.card;
    return !!card;
  }, { timeout: 10000 }).toBe(true);
  return card;
}
beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation });
  const secret = await request("/api/desktop-secret"); owner = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret.body.secret };
  const config = await fetch(fixture.info.url + "/api/config", { method: "PATCH", headers: { ...owner, "content-type": "application/json" }, body: JSON.stringify({ features: { browser: true } }) }); expect(config.status).toBe(200);
  const existing = (await request("/api/bots")).body.bots[0];
  expect((await request(`/api/bots/${existing.id}/browser-extension`, { action: "connect" })).status).toBe(200);
  await request("/api/browser-extension/clients", { action: "enabled", enabled: true });
  const paired = await request("/api/browser-extension/clients", { action: "pair", label: "External fixture", profileId: "fixture_profile" });
  expect(paired.status).toBe(201); expect(paired.body.token).toBeUndefined();
  ({ clientId, botId, threadId } = paired.body);
  const saved = JSON.parse(readFileSync(paired.body.config.mcpServers["murage-browser"].env.MURAGE_BROWSER_MCP_CONFIG, "utf8"));
  client = { authorization: `Bearer ${saved.token}`, "x-murage-browser-client": saved.clientId };
}, 60000);
afterAll(async () => { await fixture?.close(); });
it("lists the restricted tools without site or action authority", async () => {
  const value = await request("/api/browser-extension/mcp", { method: "tools/list" }, client);
  expect(value.status).toBe(200); expect(value.body.tools.some((tool: any) => tool.name === "agent_browser_open")).toBe(true);
  expect(value.body.tools.some((tool: any) => /eval|cookies|approve/.test(tool.name))).toBe(false);
  expect((await request("/api/browser-extension/mcp", { method: "tools/list", botId: "other" }, client)).status).toBe(400);
});
it("asks the owner for a site then refuses a denied consequential action", async () => {
  const navigating = request("/api/browser-extension/mcp", { method: "tools/call", params: { name: "agent_browser_open", arguments: { url: "https://fixture.test/" } } }, client);
  const site = await pendingCard();
  expect((await request(`/api/threads/${threadId}/respond`, { requestId: site.requestId, behavior: "allow" }, client)).status).toBe(403);
  expect((await request(`/api/threads/${threadId}/respond`, { requestId: site.requestId, behavior: "allow" })).status).toBe(200);
  expect((await navigating).status).toBe(200);
  const pressing = request("/api/browser-extension/mcp", { method: "tools/call", params: { name: "agent_browser_press", arguments: { key: "Enter" } } }, client);
  const action = await pendingCard(); expect(action.held).toContain("once");
  expect((await request(`/api/threads/${threadId}/respond`, { requestId: action.requestId, behavior: "deny" })).status).toBe(200);
  const denied = await pressing;
  expect(denied.status).toBe(409); expect(denied.body.error).toContain("not approved");
});
it("revokes an external client while it is waiting for approval", async () => {
  const pressing = request("/api/browser-extension/mcp", { method: "tools/call", params: { name: "agent_browser_press", arguments: { key: "Enter" } } }, client);
  await pendingCard();
  expect((await request("/api/browser-extension/clients", { action: "revoke", clientId })).status).toBe(200);
  expect((await pressing).status).toBeGreaterThanOrEqual(400);
  expect((await request("/api/browser-extension/mcp", { method: "tools/list" }, client)).status).toBe(403);
});

it("disabling a browser cancels an external action already awaiting approval", async () => {
  const paired = await request("/api/browser-extension/clients", { action: "pair", label: "Disable fixture", profileId: "fixture_profile" });
  expect(paired.status).toBe(201); ({ clientId, botId, threadId } = paired.body);
  const saved = JSON.parse(readFileSync(paired.body.config.mcpServers["murage-browser"].env.MURAGE_BROWSER_MCP_CONFIG, "utf8"));
  client = { authorization: `Bearer ${saved.token}`, "x-murage-browser-client": saved.clientId };
  const navigating = request("/api/browser-extension/mcp", { method: "tools/call", params: { name: "agent_browser_open", arguments: { url: "https://fixture.test/" } } }, client);
  const site = await pendingCard(); await request(`/api/threads/${threadId}/respond`, { requestId: site.requestId, behavior: "allow" });
  expect((await navigating).status).toBe(200);
  const pressing = request("/api/browser-extension/mcp", { method: "tools/call", params: { name: "agent_browser_press", arguments: { key: "Enter" } } }, client);
  const action = await pendingCard();
  const disabled = await fetch(fixture.info.url + `/api/bots/${botId}`, { method: "PATCH", headers: { ...owner, "content-type": "application/json" }, body: JSON.stringify({ browser: false }) });
  expect(disabled.status).toBe(200);
  expect((await pressing).status).toBeGreaterThanOrEqual(400);
  await request(`/api/threads/${threadId}/respond`, { requestId: action.requestId, behavior: "allow" });
  expect((await request("/api/browser-extension/mcp", { method: "tools/list" }, client)).status).toBe(403);
});
