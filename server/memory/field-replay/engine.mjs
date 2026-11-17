#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal ACP fake: hosted fetch, then hold. No HTTP/tool/policy substitutions.
import "../../../shared/win-hide-child-process.mjs";
import {nativeSession} from '../testing/field-native-session.ts';
import {serveToolMailbox} from '../testing/field-tool-mailbox.ts';
import {createInterface} from 'node:readline';
import {appendFileSync,existsSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
if(process.argv.includes('--version')){process.stdout.write('grok 1.0.100\n');process.exit(0);}
const out=message=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
let servers=[],sessionId=randomUUID();
const sessions=new Map();
serveToolMailbox(process.env.FIELD_REPLAY_MAILBOX,async(server,name,args)=>{
 const session=sessions.get(server);if(!session)throw new Error('Missing native MCP session');
 return session.call(name,args);
});
const result=(id,result)=>out({id,result});
createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')return result(m.id,{protocolVersion:1,agentInfo:{name:'field-replay',version:'1'},agentCapabilities:{loadSession:true,promptCapabilities:{image:false,embeddedContext:true}},authMethods:[{id:'cached_token'}]});
 if(['session/new','session/load'].includes(m.method)){
  servers=m.params.mcpServers??[];sessionId=m.params.sessionId??sessionId;
  for(const s of servers){const env=Array.isArray(s.env)?Object.fromEntries(s.env.map(e=>[e.name,e.value])):s.env??{};sessions.set(s.name,nativeSession({...s,env}));}
  await Promise.all([...sessions.values()].map(s=>s.ready));
  result(m.id,{sessionId,modes:{currentModeId:'default',availableModes:[{id:'default',name:'Default'}]}});
  out({method:'_x.ai/mcp_initialized',params:{sessionId}});return;
 }
 if(m.method==='_x.ai/mcp/list')return result(m.id,{servers:servers.map(s=>({name:s.name,session:{enabled:true,status:'ready'}}))});
 if(m.method==='session/prompt'){
  const mcpServers=Object.fromEntries(servers.map(s=>[s.name,{command:s.command,args:s.args??[],env:Array.isArray(s.env)?Object.fromEntries(s.env.map(e=>[e.name,e.value])):s.env??{}}]));
  const cred=Object.values(mcpServers).map(s=>s.env.MURAGE_CRED_FILE).find(Boolean);
  const socket=Object.values(mcpServers).map(s=>s.env.MURAGE_RELAY_SOCKET).find(Boolean);
  // ACP mounts use the relay bootstrap directly; the fixture observer writes
  // their admitted mounts beside that socket instead of a credential file.
  let content={},fixtureMounts;try{if(cred)content=JSON.parse(readFileSync(cred,'utf8'));}catch{}
  try{fixtureMounts=JSON.parse(readFileSync((cred??socket)+'.fixture-mounts.json','utf8'));}catch{}
  appendFileSync(process.env.FIELD_REPLAY_DUMP,JSON.stringify({pid:process.pid,prompt:m.params.prompt,mcpConfig:{mcpServers},fixtureMounts,credFile:{path:cred,content},cwd:process.cwd()})+'\n');
  const update=u=>out({method:'session/update',params:{sessionId,update:u,_meta:{backend:true,streamStartMs:Date.now()}}});
  update({sessionUpdate:'tool_call',toolCallId:'field-fetch',title:'web_fetch',kind:'fetch',status:'in_progress'});
  update({sessionUpdate:'tool_call_update',toolCallId:'field-fetch',status:'completed',rawOutput:'Synthetic web page: field replay note.'});
  const timer=setInterval(()=>{if(!existsSync(process.env.FIELD_REPLAY_GATE))return;clearInterval(timer);update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Synthetic fetch complete.'}});result(m.id,{stopReason:'end_turn'});},20);
  return;
 }
 if(m.method==='session/cancel')return;
 if(m.id!==undefined)result(m.id,{});
});
