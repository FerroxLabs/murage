import { createServer } from "node:http";
import { GrokDriver } from "./drivers/grok.ts";
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProviderRoute, type ProviderTurnRoute } from "./provider-routing.ts";
import { providerEngineProtocol } from "../shared/provider-engine.ts";
import { recordEvents } from "./testing/events.ts";
import { QwenAgentDriver } from "./drivers/acp/qwen.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { CodexDriver } from "./drivers/codex.ts";
import { HermesAgentDriver } from "./drivers/acp/hermes.ts";
import { FuigoAgentDriver } from "./drivers/acp/fuigo.ts";
const route:ProviderTurnRoute={connectionId:'provider-a',preset:'openai',protocol:'openai',baseUrl:'http://127.0.0.1:49999/v1',apiKey:'fixture-provider-key',model:'fixture-model',revision:'r1'};
describe('bound provider routes',()=>{
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
 it('rejects catalog model IDs that could be interpreted as CLI switches',()=>{expect(()=>applyProviderRoute('qwenAgent',{}, {...route,model:'--dangerously-skip-permissions'})).toThrow();});
 it('keeps incompatible protocols and unproved CLI routes unavailable',()=>{
  expect(providerEngineProtocol('claudeAgent','deepseek','openai')).toBeNull();expect(providerEngineProtocol('grokAgent','flux','openai')).toBeNull();expect(providerEngineProtocol('grok','flux','openai')).toBe('openai');expect(providerEngineProtocol('codex','openai','openai')).toBe('responses');
 });
 for(const [name,driver,fake]of [['qwen',QwenAgentDriver,'fake-acp-cli.ts'],['hermes',HermesAgentDriver,'fake-acp-cli.ts'],['fuigo',FuigoAgentDriver,'fake-acp-cli.ts']]as const){
  it(`dispatches ${name} through the real adapter with a scoped provider connection`,async()=>{
   const home=mkdtempSync(join(tmpdir(),`murage-provider-${name}-`)),dump=join(home,'dump.json');const instance=await driver.create({instanceId:`fixture-${name}`,displayName:name,enabled:true,environment:{HOME:home,USERPROFILE:home,FAKE_ACP_DUMP:dump},config:driver.decodeConfig({cli:join(import.meta.dirname,'testing',fake),fullAuto:false})});const events=recordEvents(instance.adapter);
   try{await instance.adapter.sendTurn({threadId:'provider-turn',text:'fixture only',model:route.model,providerRoute:route,integrations:{agents:{command:'node',args:['fixture-tools'],env:{}}}});const finished=await events.until(e=>e.type==='turn.completed');expect(finished.type).toBe('turn.completed');expect(existsSync(dump)).toBe(true);const child=JSON.parse(readFileSync(dump,'utf8'));if(name==='qwen'){expect(child.env.OPENAI_API_KEY).toBe(route.apiKey);expect(child.env.OPENAI_BASE_URL).toBe(route.baseUrl);}expect(JSON.stringify(child.argv)).not.toContain(route.apiKey);}
   finally{events.stop();await instance.dispose();rmSync(home,{recursive:true,force:true});}
  });
 }
 for(const [name,driver,fake,dumpVariable]of [['claude',ClaudeDriver,'fake-claude-cli.ts','FAKE_CLAUDE_DUMP'],['codex',CodexDriver,'fake-codex-app-server.ts','FAKE_CODEX_DUMP']]as const){
  it(`binds ${name} at actual CLI spawn and preserves tool configuration`,async()=>{
   const home=mkdtempSync(join(tmpdir(),`murage-provider-${name}-`)),dump=join(home,'dump.json');const chosen={...route,...(name==='claude'?{preset:'anthropic' as const,protocol:'anthropic' as const}:{})};
   const instance=await driver.create({instanceId:`fixture-${name}`,displayName:name,enabled:true,environment:{HOME:home,USERPROFILE:home,[dumpVariable]:dump},config:driver.decodeConfig({cli:join(import.meta.dirname,'testing',fake)}) as any});const events=recordEvents(instance.adapter);
   try{await instance.adapter.sendTurn({threadId:'provider-turn',text:'fixture only',model:chosen.model,providerRoute:chosen,integrations:{agents:{command:'node',args:['fixture-tools'],env:{}}}});await events.until(e=>e.type==='turn.completed');const child=JSON.parse(readFileSync(dump,'utf8'));expect(JSON.stringify(child.argv)).not.toContain(route.apiKey);if(name==='claude'){expect(child.env.ANTHROPIC_API_KEY).toBe(route.apiKey);expect(child.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:49999');expect(JSON.stringify(child.mcpConfig)).toContain('fixture-tools');}else{expect(child.env.MURAGE_PROVIDER_API_KEY).toBe(route.apiKey);expect(child.calls.find((c:any)=>c.method==='thread/start').params.modelProvider).toMatch(/^murage_/);expect(child.argv.join(' ')).toContain('fixture-tools');}}
   finally{events.stop();await instance.dispose();rmSync(home,{recursive:true,force:true});}
  });
 }
 it('routes Grok API to the exact selected provider with chat-only capabilities',async()=>{
  let received:any;const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received={url:req.url,auth:req.headers.authorization,body:JSON.parse(body)};res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta:{content:'fixture answer'}}]})+'\n\ndata: [DONE]\n\n');});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const chosen={...route,baseUrl:`http://127.0.0.1:${(server.address()as{port:number}).port}/v1`};const instance=await GrokDriver.create({instanceId:'fixture-grok',displayName:'Grok API',enabled:true,environment:{},config:GrokDriver.decodeConfig({})});const events=recordEvents(instance.adapter);
  try{await instance.adapter.sendTurn({threadId:'grok-selected',text:'fake only',model:chosen.model,providerRoute:chosen});await events.until(e=>e.type==='turn.completed');expect(received).toMatchObject({url:'/v1/chat/completions',auth:'Bearer '+route.apiKey,body:{model:route.model}});expect(instance.adapter.capabilities.agentsMcp).not.toBe(true);expect(instance.adapter.capabilities.browserMcp).not.toBe(true);}
  finally{events.stop();await instance.dispose();await new Promise<void>(done=>server.close(()=>done()));}
 });

 it('retains approval and cancellation boundaries on a selected-provider ACP turn',async()=>{
  for(const mode of ['permission','hang']){
   const home=mkdtempSync(join(tmpdir(),'murage-route-authority-'));const instance=await QwenAgentDriver.create({instanceId:'fixture-qwen',displayName:'Qwen',enabled:true,environment:{HOME:home,FAKE_ACP_MODE:mode},config:QwenAgentDriver.decodeConfig({cli:join(import.meta.dirname,'testing/fake-acp-cli.ts'),fullAuto:false})});const events=recordEvents(instance.adapter);
   try{await instance.adapter.sendTurn({threadId:'authority',text:'fixture only',model:route.model,providerRoute:route});if(mode==='permission'){const ask=await events.until(e=>e.type==='request.opened');if(ask.type!=='request.opened'||typeof ask.requestId!=='string')throw Error('No approval request identity');expect(await instance.adapter.respondToRequest('authority',ask.requestId,{behavior:'deny'})).toBe('rejected');}else await instance.adapter.interruptTurn('authority');await events.until(e=>e.type==='turn.completed');}
   finally{events.stop();await instance.dispose();rmSync(home,{recursive:true,force:true});}
  }
 });

});
