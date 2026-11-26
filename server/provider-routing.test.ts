import { fixtureSubmittedInput, fixtureMountTurn } from "./testing/mcp-admission-fixture.ts";
import { buildMcpServers } from "./drivers/mcp-mounts.ts";
import { codexMountConfiguration } from "./testing/codex-mount-configuration.ts";
import { useOutsideStoreFixture } from "./testing/outside-store-fixture.ts";
import { fixtureBotFolder } from "./testing/bot-folder-fixture.ts";
import { createServer } from "node:http";
import { GrokDriver } from "./drivers/grok.ts";
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProviderRoute, routeEndpoint, type ProviderTurnRoute } from "./provider-routing.ts";
import { providerEngineProtocol } from "../shared/provider-engine.ts";
import { recordAdmittedEvents as recordEvents } from "./testing/admitted-events.ts";
import { fixtureCredentialFingerprint } from "./testing/fixture-dump.ts";
import { QwenAgentDriver } from "./drivers/acp/qwen.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { CodexDriver } from "./drivers/codex.ts";
import { HermesAgentDriver } from "./drivers/acp/hermes.ts";
import { FuigoAgentDriver } from "./drivers/acp/fuigo.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const route:ProviderTurnRoute={connectionId:'provider-a',preset:'openai',protocol:'openai',baseUrl:'http://127.0.0.1:49999/v1',apiKey:'fixture-provider-key',model:'fixture-model',revision:'r1'};
describe('bound provider routes',()=>{
 it('preallows only registered memory tools in an owned routed Fuigo home',()=>{
  const env:NodeJS.ProcessEnv={FUIGO_HOME:'/nonexistent-preserved-native-home'};
  const bound=applyProviderRoute('fuigoAgent',env,route,{threadId:'thread',memoryTools:true});
  try{
   const config=readFileSync(join(env.FUIGO_HOME!,'config.toml'),'utf8');
   const rules=config.slice(config.indexOf('[permission]'));
   for(const name of ['memory_search','memory_get','memory_save','memory_propose_correction'])expect(rules).toContain(`pattern = "murage-memory__${name}"`);
   expect(rules).not.toContain('*');expect(rules).not.toContain('shell');expect(config).not.toContain(route.apiKey);
  }finally{bound.cleanup();}
  const without:NodeJS.ProcessEnv={};const plain=applyProviderRoute('fuigoAgent',without,route,{threadId:'thread'});
  try{expect(readFileSync(join(without.FUIGO_HOME!,'config.toml'),'utf8')).not.toContain('[permission]');}finally{plain.cleanup();}
 });
 it('uses one exact selected endpoint/key without exposing credentials in arguments',()=>{
  for(const driver of ['claudeAgent','codex','qwenAgent','hermesAgent','fuigoAgent']){
   const env:NodeJS.ProcessEnv={OPENAI_API_KEY:'wrong',ANTHROPIC_AUTH_TOKEN:'wrong',FUIGO_API_KEY:'wrong'};
   const chosen={...route,...(driver==='claudeAgent'?{preset:'anthropic' as const,protocol:'anthropic' as const}:{})};const result=applyProviderRoute(driver,env,chosen);
   expect(JSON.stringify(result.args)).not.toContain(route.apiKey);
   expect(Object.values(env)).not.toContain('wrong');
   if(driver==='hermesAgent')expect(readFileSync(join(env.HERMES_HOME!,'config.yaml'),'utf8')).toContain(route.baseUrl);
   if(driver==='fuigoAgent'){const config=readFileSync(join(env.FUIGO_HOME!,'config.toml'),'utf8');expect(config).toContain('model_provider = "murage_');expect(config).toContain('env_key = "MURAGE_PROVIDER_API_KEY"');expect(config).not.toContain(route.apiKey);}
   result.cleanup();
  }
 });
 it('a Flux connection on Hermes says capture off in its own home (explicit-only capture); another host gets no memory header',()=>{
  const flux={...route,preset:'flux' as const,baseUrl:'https://api.fluxrouter.ai/v1'};
  const env:NodeJS.ProcessEnv={};const result=applyProviderRoute('hermesAgent',env,flux);
  try{const text=readFileSync(join(env.HERMES_HOME!,'config.yaml'),'utf8');expect(text).toContain('  extra_headers:\n    x-flux-memory-app: "murage"\n    x-flux-memory-capture: "off"\n');}finally{result.cleanup();}
  const other:NodeJS.ProcessEnv={};const plain=applyProviderRoute('hermesAgent',other,route);
  try{expect(readFileSync(join(other.HERMES_HOME!,'config.yaml'),'utf8')).not.toContain('x-flux-memory');}finally{plain.cleanup();}
 });
 it('rejects catalog model IDs that could be interpreted as CLI switches',()=>{expect(()=>applyProviderRoute('qwenAgent',{}, {...route,model:'--dangerously-skip-permissions'})).toThrow();});
 it('keeps incompatible protocols and unproved CLI routes unavailable',()=>{
  expect(providerEngineProtocol('claudeAgent','deepseek','openai')).toBeNull();expect(providerEngineProtocol('grokAgent','flux','openai')).toBe('openai');expect(providerEngineProtocol('grokAgent','openai','responses')).toBeNull();expect(providerEngineProtocol('grok','flux','openai')).toBe('openai');expect(providerEngineProtocol('codex','openai','openai')).toBe('responses');
 });
 for(const [name,driver,fake]of [['qwen',QwenAgentDriver,'fake-acp-cli.ts'],['hermes',HermesAgentDriver,'fake-acp-cli.ts'],['fuigo',FuigoAgentDriver,'fake-acp-cli.ts']]as const){
  it(`dispatches ${name} through the real adapter with a scoped provider connection`,async()=>{
   const home=mkdtempSync(join(tmpdir(),`murage-provider-${name}-`)),dump=join(home,'dump.json');const instance=await driver.create({instanceId:`fixture-${name}`,displayName:name,enabled:true,environment:{HOME:home,USERPROFILE:home,FAKE_ACP_DUMP:dump,FAKE_ACP_MCP_READY:'1'},config:driver.decodeConfig({cli:join(import.meta.dirname,'testing',fake),fullAuto:false})});const events=recordEvents(instance.adapter);
   try{await instance.adapter.sendTurn({ cwd: fixtureBotFolder(),threadId:'provider-turn',text:'fixture only',model:route.model,providerRoute:route,integrations:{agents:{command:'node',args:[join(import.meta.dirname,'testing/fake-idle-mcp.mjs'),'fixture-tools'],env:{}}}});const finished=await events.until(e=>e.type==='turn.completed');expect(finished.type).toBe('turn.completed');expect(existsSync(dump)).toBe(true);const child=JSON.parse(readFileSync(dump,'utf8'));if(name==='qwen'){expect(child.env.OPENAI_API_KEY).toBe(fixtureCredentialFingerprint(route.apiKey));expect(child.env.OPENAI_BASE_URL).toBe(route.baseUrl);}expect(JSON.stringify(child.argv)).not.toContain(route.apiKey);}
   finally{events.stop();await instance.dispose();removeTempDirSync(home);}
  });
 }
 for(const [name,driver,fake,dumpVariable]of [['claude',ClaudeDriver,'fake-claude-cli.ts','FAKE_CLAUDE_DUMP'],['codex',CodexDriver,'fake-codex-app-server.ts','FAKE_CODEX_DUMP']]as const){
  it(`binds ${name} at actual CLI spawn and preserves tool configuration`,async()=>{
   const home=mkdtempSync(join(tmpdir(),`murage-provider-${name}-`)),dump=join(home,'dump.json');const chosen={...route,...(name==='claude'?{preset:'anthropic' as const,protocol:'anthropic' as const}:{})};
   const instance=await driver.create({instanceId:`fixture-${name}`,displayName:name,enabled:true,environment:{HOME:home,USERPROFILE:home,[dumpVariable]:dump},config:driver.decodeConfig({cli:join(import.meta.dirname,'testing',fake)}) as any});const events=recordEvents(instance.adapter);
   try{await instance.adapter.sendTurn({ cwd: fixtureBotFolder(),threadId:'provider-turn',text:'fixture only',model:chosen.model,providerRoute:chosen,integrations:{agents:{command:'node',args:[join(import.meta.dirname,'testing/fake-idle-mcp.mjs'),'fixture-tools'],env:{}}}});await events.until(e=>e.type==='turn.completed');const child=JSON.parse(readFileSync(dump,'utf8'));expect(JSON.stringify(child.argv)).not.toContain(route.apiKey);if(name==='claude'){expect(child.env.ANTHROPIC_API_KEY).toBe(fixtureCredentialFingerprint(route.apiKey));expect(child.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:49999');/* MAIN RULING INT-CONFLICT-DEFAULT eb01447e7d: native shims hide server-side configuration. */expect(JSON.stringify(child.mcpConfig)).toContain('cli-mount-shim');expect(JSON.stringify(buildMcpServers(fixtureMountTurn(fixtureSubmittedInput(instance.adapter))))).toContain('fixture-tools');}else{expect(child.env.MURAGE_PROVIDER_API_KEY).toBe(fixtureCredentialFingerprint(route.apiKey));expect(child.calls.find((c:any)=>c.method==='thread/start').params.modelProvider).toMatch(/^murage_/);/* MAIN RULING INT-CONFLICT-DEFAULT eb01447e7d: assert the native shim and the independent server configuration. */expect(child.argv.join(' ')).toContain('cli-mount-shim');expect(JSON.stringify(codexMountConfiguration(fixtureSubmittedInput(instance.adapter)))).toContain('fixture-tools');}}
   finally{events.stop();await instance.dispose();removeTempDirSync(home);}
  });
 }
 describe('Codex retry cap on a saved Flux connection',()=>{
  const flux={...route,connectionId:'legacy-flux',preset:'flux' as const,baseUrl:'https://api.fluxrouter.ai/v1',model:'flux-pinned-fixture-chat'};
  const capsFor=(args:string[],id:string)=>args.filter(a=>/_max_retries=/.test(a)).sort().map(a=>a.replace(id,'<id>'));
  const want=['model_providers.<id>.request_max_retries=2','model_providers.<id>.stream_max_retries=2'];
  it('caps request and stream retries at 2 on the generated provider id',()=>{
   const result=applyProviderRoute('codex',{},flux);
   expect(capsFor(result.args??[],result.modelProvider!)).toEqual(want);
  });
  it('caps a custom connection whose endpoint is the Flux host',()=>{
   for(const baseUrl of ['https://api.fluxrouter.ai/v1','https://API.FluxRouter.ai/v1/']){
    const result=applyProviderRoute('codex',{},{...route,connectionId:'custom-flux-host',baseUrl});
    expect(capsFor(result.args??[],result.modelProvider!)).toEqual(want);
   }
  });
  it('does not cap a look-alike host',()=>{
   const result=applyProviderRoute('codex',{},{...route,baseUrl:'https://notfluxrouter.ai/v1'});
   expect((result.args??[]).some(a=>/_max_retries=/.test(a))).toBe(false);
  });
  it('leaves a non-Flux selected provider on codex defaults',()=>{
   const result=applyProviderRoute('codex',{},route);
   expect((result.args??[]).some(a=>/_max_retries=/.test(a))).toBe(false);
  });
  it('reaches the real codex spawn argv',async()=>{
   const home=mkdtempSync(join(tmpdir(),'murage-provider-flux-')),dump=join(home,'dump.json');
   const instance=await CodexDriver.create({instanceId:'fixture-flux-codex',displayName:'codex',enabled:true,environment:{HOME:home,USERPROFILE:home,FAKE_CODEX_DUMP:dump},config:CodexDriver.decodeConfig({cli:join(import.meta.dirname,'testing','fake-codex-app-server.ts')}) as any});const events=recordEvents(instance.adapter);
   try{await instance.adapter.sendTurn({ cwd: fixtureBotFolder(),threadId:'flux-saved',text:'fixture only',model:flux.model,providerRoute:flux});await events.until(e=>e.type==='turn.completed');const child=JSON.parse(readFileSync(dump,'utf8'));const id=child.calls.find((c:any)=>c.method==='thread/start').params.modelProvider;
    expect(capsFor(child.argv,id)).toEqual(want);}
   finally{events.stop();await instance.dispose();removeTempDirSync(home);}
  });
  it('a Cloud home refuses a Flux route for codex, so a saved connection cannot reach Flux there',()=>{
   const before=process.env.MURAGE_CLOUD_ROLE;process.env.MURAGE_CLOUD_ROLE='home';
   try{expect(()=>applyProviderRoute('codex',{},flux)).toThrow();}
   finally{if(before===undefined)delete process.env.MURAGE_CLOUD_ROLE;else process.env.MURAGE_CLOUD_ROLE=before;}
  });
 });
 // MAIN RULING: 2ffd134722 extends the chat-tools MCP set with the built-in browser; exact provider routing remains required.
 it('routes Grok API to the exact selected provider; its MCP set is the chat-tools set (OPENAI-TOOLS-109: agents yes, browser no)',async()=>{
  let received:any;const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received={url:req.url,auth:req.headers.authorization,body:JSON.parse(body)};res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta:{content:'fixture answer'}}]})+'\n\ndata: [DONE]\n\n');});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const chosen={...route,baseUrl:`http://127.0.0.1:${(server.address()as{port:number}).port}/v1`};const instance=await GrokDriver.create({instanceId:'fixture-grok',displayName:'Grok API',enabled:true,environment:{},config:GrokDriver.decodeConfig({})});const events=recordEvents(instance.adapter);
  try{await instance.adapter.sendTurn({ cwd: fixtureBotFolder(),threadId:'grok-selected',text:'fake only',model:chosen.model,providerRoute:chosen});await events.until(e=>e.type==='turn.completed');expect(received).toMatchObject({url:'/v1/chat/completions',auth:'Bearer '+route.apiKey,body:{model:route.model}});expect(instance.adapter.capabilities.agentsMcp).toBe(true);expect(instance.adapter.capabilities.browserMcp).toBe(true);}
  finally{events.stop();await instance.dispose();await new Promise<void>(done=>server.close(()=>done()));}
 });

 it('retains approval and cancellation boundaries on a selected-provider ACP turn',async()=>{
  for(const mode of ['permission','hang']){
   const home=mkdtempSync(join(tmpdir(),'murage-route-authority-'));const instance=await QwenAgentDriver.create({instanceId:'fixture-qwen',displayName:'Qwen',enabled:true,environment:{HOME:home,FAKE_ACP_MODE:mode},config:QwenAgentDriver.decodeConfig({cli:join(import.meta.dirname,'testing/fake-acp-cli.ts'),fullAuto:false})});const events=recordEvents(instance.adapter);
   try{await instance.adapter.sendTurn({ cwd: fixtureBotFolder(),threadId:'authority',text:'fixture only',model:route.model,providerRoute:route});if(mode==='permission'){const ask=await events.until(e=>e.type==='request.opened');if(ask.type!=='request.opened'||typeof ask.requestId!=='string')throw Error('No approval request identity');expect(await instance.adapter.respondToRequest('authority',ask.requestId,{behavior:'deny'})).toBe('rejected');}else await instance.adapter.interruptTurn('authority');await events.until(e=>e.type==='turn.completed');}
   finally{events.stop();await instance.dispose();removeTempDirSync(home);}
  }
 });

});

describe("Flux Anthropic base", () => {
  it("points the Claude engine at /anthropic so the engine's own /v1/messages append lands on /anthropic/v1/messages, never a bare /messages", () => {
    const route = { preset: "flux", baseUrl: "https://api.fluxrouter.ai/v1/" } as ProviderTurnRoute;
    const base = routeEndpoint("claudeAgent", route);
    expect(base).toBe("https://api.fluxrouter.ai/anthropic");
    expect(`${base}/v1/messages`).toBe("https://api.fluxrouter.ai/anthropic/v1/messages");
    expect(new URL(`${base}/v1/messages`).pathname).not.toBe("/messages");
  });
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
