// SPDX-License-Identifier: AGPL-3.0-or-later
import {copyFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {beforeAll, afterAll, expect, it} from 'vitest';
import {launchVerificationServer, type VerificationServer} from '../scripts/control-murage.ts';
import {FAKE_FLUX_BROKER_INSTRUMENTATION} from './testing/fake-flux-broker.ts';
import {withTurnSecrets} from './testing/fixture-dump.ts';
import {raiseLevel} from './testing/raise-level.ts';
let fixture: VerificationServer;
let desktop: Record<string,string> = {};
const evidence: unknown[] = [];
const services = {gmail:{connected:true,status:'ACTIVE',accounts:[{id:'A',alias:'work',status:'EXPIRED'},{id:'B',alias:'home',status:'ACTIVE'},{id:'C',alias:'old',status:'EXPIRED'}]}};
const instrumentation = FAKE_FLUX_BROKER_INSTRUMENTATION
 .replace("if (req.url?.endsWith('/v1/mcp')) return send", `if (req.url?.endsWith('/v1/mcp') && body.method === 'tools/call') {
   const fs = awaitImportFs;
   fs.appendFileSync(process.env.MURAGE_DATA_DIR+'/broker-dispatch.jsonl',JSON.stringify(body)+'\\n');
   return send(200,{jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:JSON.stringify({dispatched:body.params.arguments,data:{results:[{index:0,tool_slug:'GMAIL_SEND_EMAIL',response:{successful:true,data:{index:0,message:'healthy-account-ran'}}}]}})}]}});
 }\nif (req.url?.endsWith('/v1/mcp')) return send`)
 .replaceAll('{ services: {} }', JSON.stringify({services}))
 + `\nprocess.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';`;
async function api(method:string,path:string,body?:unknown,token?:string) {
 const res=await fetch(fixture.info.url+path,{method,headers:{...desktop,...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const result={status:res.status,body:await res.json() as any};
 if(!path.includes('secret'))evidence.push({method,path,...result});
 return result;
}
beforeAll(async()=>{
 fixture=await launchVerificationServer(process.env,undefined,{dumpLog:true,instrumentationSource:"const awaitImportFs=await import('node:fs');\n"+instrumentation});
 desktop={'x-murage-surface':'desktop','x-murage-surface-secret':(await api('GET','/api/desktop-secret')).body.secret};
},90000);
afterAll(async()=>{
 mkdirSync('evidence/gnl-apps-r2',{recursive:true});
 writeFileSync('evidence/gnl-apps-r2/preflight.json',JSON.stringify({fixture:fixture?.info,evidence},null,2));
 if(fixture)copyFileSync(fixture.info.logPath,'evidence/gnl-apps-r2/preflight-server.log');
 await fixture?.close();
});
it.each(['direct','wrapped'] as const)('H1 preflight %s dispatches connected B while reporting disconnected A and C once without cards',async shape=>{
 const instances=(await api('GET','/api/instances')).body.instances;
 const model=instances.find((x:any)=>x.instanceId==='verification').models.options[0].id;
 const made=await api('POST','/api/bots',{name:'Mixed preflight '+shape,modelSelection:{instanceId:'verification',model}});
 expect(made.status).toBe(201);const b=made.body.bot;
 expect((await api('PATCH',`/api/bots/${b.id}`,{computer:'off',browser:false,composio:true,autoReview:'off'})).status).toBe(200);
 expect((await raiseLevel(api,b.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
 expect((await api('GET','/api/connectors/connected')).status).toBe(200);
 const existing=new Set((await api('GET',`/api/threads/${b.threadId}/messages?limit=200`)).body.messages.map((m:any)=>m.id));
 expect((await api('POST',`/api/bots/${b.id}/messages`,{threadId:b.threadId,text:'__fixture_hold_authority__ preflight-'+b.id})).status).toBe(202);
 try {
  let env:any;
  await expect.poll(()=>{try{const line=readFileSync(fixture.fixtureDumpLogPath,'utf8').split('\n').find(l=>l.includes('preflight-'+b.id));if(!line)return false;env=withTurnSecrets(JSON.parse(line)).mcpConfig.mcpServers.murage_connectors.env;return Boolean(env.MURAGE_CONNECTORS_TOKEN);}catch{return false;}},{timeout:30000}).toBe(true);
  const tools=['work','home','A','old'].map(account=>({tool_slug:'GMAIL_SEND_EMAIL',account,arguments:{to:'fixture@example.invalid'}}));
  const body={tools,sync_response_to_workbench:false};
  const params=shape==='direct'?{name:'COMPOSIO_MULTI_EXECUTE_TOOL',arguments:body}:{name:'use_tool',arguments:{tool_name:'COMPOSIO_MULTI_EXECUTE_TOOL',tool_input:body}};
  const result=await api('POST','/api/internal/connectors/mcp',{jsonrpc:'2.0',id:81,method:'tools/call',params},env.MURAGE_CONNECTORS_TOKEN);
  expect(result.status).toBe(200);
  expect(result.body.result.isError).not.toBe(true);
  const text=result.body.result.content.map((c:any)=>c.text).join('\n');
  expect(text).toContain('"account":"home"');
  const healthy=JSON.parse(result.body.result.content[1].text);
  expect(healthy.data.results).toEqual([{index:1,tool_slug:'GMAIL_SEND_EMAIL',response:{successful:true,data:{index:0,message:'healthy-account-ran'}}}]);
  expect(text.match(/Reconnect Gmail \(work\)/g)).toHaveLength(1);
  expect(text.match(/Reconnect Gmail \(old\)/g)).toHaveLength(1);
  const sent=readFileSync(join(fixture.info.dataDir,'broker-dispatch.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(call=>call.id===81).at(-1);
  const sentBody=shape==='direct'?sent.params.arguments:sent.params.arguments.tool_input;
  expect(sentBody).toEqual({...body,tools:[tools[1]]});
  // An entirely disconnected request reports each account once and sends nothing.
  const dispatches=readFileSync(join(fixture.info.dataDir,'broker-dispatch.jsonl'),'utf8');
  const off=await api('POST','/api/internal/connectors/mcp',{jsonrpc:'2.0',id:82,method:'tools/call',params:{name:'COMPOSIO_MULTI_EXECUTE_TOOL',arguments:{tools:[tools[0],tools[2],tools[3]]}}},env.MURAGE_CONNECTORS_TOKEN);
  expect(off.status).toBe(200);
  expect(off.body.result).toEqual({content:[{type:'text',text:'Reconnect Gmail (work) in App Settings → Connections → Connected apps.\nReconnect Gmail (old) in App Settings → Connections → Connected apps.'}]});
  expect(readFileSync(join(fixture.info.dataDir,'broker-dispatch.jsonl'),'utf8')).toBe(dispatches);
  const messages=(await api('GET',`/api/threads/${b.threadId}/messages?limit=200`)).body.messages;
  expect(messages.filter((m:any)=>!existing.has(m.id)&&(m.card||m.connector||m.secret))).toHaveLength(0);
 } finally {await api('POST',`/api/bots/${b.id}/interrupt`,{threadId:b.threadId});}
});
