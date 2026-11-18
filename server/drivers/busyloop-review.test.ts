import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenAIChatRuntime } from './openai-chat.ts';
import { OpenAICompatDriver } from './openai-compat.ts';
import { FuigoAgentDriver } from './acp/fuigo.ts';
import { httpTextOnlyTurn } from './http-text-only.ts';
import { fixedPrompt } from '../memory/fixed-prompt.ts';
import { openLearningGate } from '../testing/open-learning-gate.ts';
import { useOutsideStoreFixture } from '../testing/outside-store-fixture.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { recordEvents } from '../testing/events.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { resetKeyRejectionsForTests } from '../key-rejections.ts';
import type { ProviderInstance } from '../contracts.ts';
useOutsideStoreFixture();
const root = new URL('../__fixtures__/flux-refusals/review-a22/', import.meta.url);
const rows = readFileSync(new URL('expected.tsv', root), 'utf8').trim().split('\n').slice(1).map(l => l.split('\t'));
let instance: ProviderInstance | undefined;
const paths: string[] = [];
beforeEach(() => { resetKeyRejectionsForTests(); vi.stubEnv('FLUX_API_KEY', 'sk-flux-test-review-fixture'); });
afterEach(async () => { await instance?.dispose(); instance = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const p of paths.splice(0)) await removeTempDir(p); });
for (const {row, customRoute} of rows.flatMap(row=>[{row,customRoute:false},...(row[0]==='P1-acp-result'?[{row,customRoute:true}]:[])])) it(row[0]+(customRoute?' custom Flux URL':''), async () => {
  const [id, , reason, action, wait] = row;
  const v = JSON.parse(readFileSync(new URL(id + '.json', root), 'utf8'));
  let posts = 0;
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response('{"data":[]}');
    posts++;
    return new Response(v.transport === 'sse' ? `data: ${JSON.stringify(v.body)}\n\n` : JSON.stringify(v.body), {status:v.status, headers:v.headers});
  });
  const expected = {reason, action, wait: /^\d+$/.test(wait) ? Number(wait) : wait};
  if (v.transport === 'text') {
    const result = await httpTextOnlyTurn({system:fixedPrompt('test'),text:'test',model:'flux-auto',outputSchema:{type:'object'},signal:new AbortController().signal,maxOutputTokens:10,maxOutputBytes:100,context:{botId:'b',runId:'r',family:'lived',attempt:1},transport:{gate:openLearningGate()}}, {baseUrl:'https://api.fluxrouter.ai/v1',apiKey:'fixture',buildBody:(model,messages)=>({model,messages})});
    expect((result as any).fluxDecision).toEqual(expected);
    expect(result.verdict).not.toMatchObject({reason:'transient'});
    expect(posts).toBe(1);
    return;
  }
  if (v.transport === 'acp') {
    const home = mkdtempSync(join(tmpdir(),'review-acp-')); paths.push(home);
    const initial = readFileSync(new URL('./acp/__fixtures__/fuigo-1.0.41-free-cap-S1-1.jsonl',import.meta.url),'utf8').trim().split('\n').map(l=>JSON.parse(l)).find(r=>r.direction==='stdout' && JSON.parse(r.line).id===1);
    const frames = [initial, {direction:'stdin',line:JSON.stringify({id:3,method:'session/prompt',params:{sessionId:'review'}})}, {direction:'stdout',line:JSON.stringify({jsonrpc:'2.0',id:3,result:{stopReason:'refusal',message:'Refused',upstream:v.upstream}})}];
    const file = join(home,'frames.jsonl'); writeFileSync(file,frames.map(f=>JSON.stringify(f)).join('\n'));
    const cli = fileURLToPath(new URL('../testing/fuigo-captured-cli.mjs',import.meta.url));
    instance = await FuigoAgentDriver.create({instanceId:'review',displayName:'Flux',enabled:true,environment:{HOME:home},config:{fullAuto:false,cli:`"${process.execPath}" "${cli}" "${file}"`}});
  } else if (v.transport === 'compat') {
    instance = await OpenAICompatDriver.create({instanceId:'review',displayName:'Flux',enabled:true,environment:{},config:OpenAICompatDriver.decodeConfig({url:'https://api.fluxrouter.ai/v1',key:'fixture',model:'flux-auto'})});
  } else {
    instance = createOpenAIChatRuntime({input:{instanceId:'review',displayName:'Flux',enabled:true,environment:{},config:{}},driverKind:'review',apiKey:'fixture',apiUrl:'https://api.fluxrouter.ai/v1',models:()=>({default:'flux-auto',options:[{id:'flux-auto',label:'Auto'}]}),requestBody:(model,messages,stream)=>({model,messages,stream}),httpErrorLabel:'Flux',missingKeyError:'',unavailableReason:'',retryScale:0,nativeLog:{source:'review',outgoing:()=>({}),incoming:()=>({})}});
  }
  const rec = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({cwd:fixtureBotFolder(),threadId:'review',model:'flux-auto',text:'hi',...(customRoute?{providerRoute:{connectionId:'custom-flux',revision:'1',preset:'openai' as const,protocol:'openai' as const,baseUrl:'https://api.fluxrouter.ai/v1',apiKey:'fixture',model:'flux-auto'}}:{})});
    await rec.until(e=>e.type==='turn.completed');
    expect((rec.events.find(e=>e.type==='runtime.error') as any)?.fluxDecision).toEqual(expected);
    if (v.transport !== 'acp') expect(posts).toBe(action==='STOP' ? 1 : action==='RETRY_ONCE' ? 2 : 3);
    if (id.startsWith('budget-') && process.env.BUSYLOOP_EVIDENCE_DIR) {
      const folder=join(process.env.BUSYLOOP_EVIDENCE_DIR,'flux-402');mkdirSync(folder,{recursive:true});
      writeFileSync(join(folder,id+'.json'),JSON.stringify({fixture:id,requestUrl:'https://api.fluxrouter.ai/v1/chat/completions',status:v.status,headers:v.headers,body:v.body,decision:(rec.events.find(e=>e.type==='runtime.error') as any)?.fluxDecision,posts,events:rec.events},null,2));
    }
    if (id === 'P2-tool') expect(rec.events.filter(e=>e.type==='turn.retrying').map((e:any)=>e.delayMs)).toEqual([60000,60000]);
  } finally {rec.stop();}
}, 15000);

for (const preset of ['openai','flux'] as const) for(const fluxHost of [false,true]) it(`R1 bare 429 follows request URL, preset=${preset}, Flux host=${fluxHost}`, async () => {
  const baseUrl=fluxHost?'https://api.fluxrouter.ai/v1':'https://api.openai.com/v1';
  let posts=0;
  vi.stubGlobal('fetch',async()=>{posts++;return new Response('{}',{status:429});});
  instance=createOpenAIChatRuntime({input:{instanceId:'scope',displayName:'Scope',enabled:true,environment:{},config:{}},driverKind:'openai-compat',apiKey:'fixture',apiUrl:baseUrl,models:()=>({default:'fixture',options:[{id:'fixture',label:'Fixture'}]}),requestBody:(model,messages,stream)=>({model,messages,stream}),httpErrorLabel:'Scope',missingKeyError:'',unavailableReason:'',retryScale:0,nativeLog:{source:'scope',outgoing:()=>({}),incoming:()=>({})}});
  const rec=recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({cwd:fixtureBotFolder(),threadId:'scope',model:'fixture',text:'hi',providerRoute:{connectionId:'scope',revision:'1',preset,protocol:'openai',baseUrl,apiKey:'fixture',model:'fixture'}});
    await rec.until(e=>e.type==='turn.completed');
    const decision=(rec.events.find(e=>e.type==='runtime.error') as any)?.fluxDecision;
    if(fluxHost)expect(decision).toEqual({reason:'unknownLimit',action:'PAUSE',wait:'-'});
    else expect(decision).toBeUndefined();
    expect(posts).toBe(fluxHost?1:3);
    expect(rec.events.filter(e=>e.type==='turn.retrying')).toHaveLength(fluxHost?0:2);
  } finally {rec.stop();}
});
