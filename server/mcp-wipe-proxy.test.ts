// SPDX-License-Identifier: AGPL-3.0-or-later
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {expect,it} from 'vitest';
import {removeTempDir} from './testing/cleanup.ts';
import {recordMcpWipeHints} from './no-limits-wipe-mcp.ts';
import {d,fixture,baseRun} from './decision/fixture.ts';
import {customIntegrations} from './custom-mcp-mounts.ts';
import type {AppConfig} from './config.ts';
import {consumingFixture} from './testing/consuming-fixture.ts';
import {fixtureBotFolder} from './testing/bot-folder-fixture.ts';
import {InternalCapabilities} from './internal-capabilities.ts';
import {createProxyReleaseAuthority} from './consuming-turn-ingress.ts';
import {createMcpMountAdmission} from './drivers/mcp-mounts.ts';
import {CliMountRelay} from './drivers/cli-mount-relay.ts';
import {createTurnCredentialStore} from './drivers/turn-credentials.ts';

it('W6 stdio tools/list annotations reach the registered decision before the catalog reaches the engine',async()=>{
 const root=mkdtempSync(join(tmpdir(),'murage-wipe-mcp-')),fake=join(root,'fake.mjs');
 writeFileSync(fake,`import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;const result=q.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:q.method==='tools/list'?{tools:[{name:'perform',annotations:{title:'Delete all owner records',destructiveHint:true},inputSchema:{type:'object',properties:{}}},{name:'run_command',inputSchema:{type:'object',properties:{command:{type:'string'}}}}]}:q.method==='tools/call'?{content:[{type:'text',text:JSON.stringify(q.params)}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`);
 const f=fixture(),publications:unknown[]=[];
 const ledger=consumingFixture(),caps=new InternalCapabilities(),credentials=createTurnCredentialStore();
 caps.begin(ledger.binding.identity.botId,ledger.turn.threadId,ledger.binding.identity.dispatchGeneration);
 const authority=createProxyReleaseAuthority(caps);
 const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  const body=JSON.parse(Buffer.concat(chunks).toString());
  if(req.url==='/api/internal/turn-release/v1/verdict'){
   const claim=caps.resolve(req.headers.authorization)!;
   if(body.operation==='upstream'){authority.reserveUpstream(claim,body);res.end('{}');}
   else if(body.operation==='seal'){authority.seal(claim);res.end('{}');}
   else res.end(JSON.stringify(authority.verdict(claim,body)));
   return;
  }
  publications.push(body);
  expect(req.url).toBe('/api/internal/mcp-remote/fixture/wipe-metadata');expect(req.headers.authorization).toBe('Bearer fixture-token');
  recordMcpWipeHints('t','fixture',body.tools,body.replace);res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as {port:number}).port,proxy=fileURLToPath(new URL('./mcp-wipe-proxy.ts',import.meta.url));
 const mounts=customIntegrations({mcpServers:{fixture:{command:process.execPath,args:[fake],env:{},enabled:true}}} as unknown as AppConfig,{execPath:process.execPath,proxyPath:'unused',wipeProxyPath:proxy,harnessUrl:`http://127.0.0.1:${port}`,token:()=> 'fixture-token'})!;
 // Exercise the wrapper at the same server-owned final acceptance as a real
 // desktop turn, retaining the original annotation and permission assertions.
 const mount=mounts.fixture!,url=`http://127.0.0.1:${port}`;
 const admission=createMcpMountAdmission(ledger.binding,authority,url);
 const relay=await CliMountRelay.create({threadId:ledger.turn.threadId,text:'Fixture',cwd:fixtureBotFolder(),
  warmIdentity:{botId:ledger.binding.identity.botId,audience:'owner'},releaseBinding:ledger.binding,mountAdmission:admission},
  {fixture:{...mount,env:{...mount.env,...mount.harnessEnv}}},{},credentials);
 const stanza=relay.servers.fixture as {command:string;args:string[];env:Record<string,string>};
 const child=spawn(stanza.command,stanza.args,{env:{...process.env,...stanza.env},stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
 const pending=new Map<number,(value:any)=>void>(),lines=createInterface({input:child.stdout});lines.on('line',line=>{const reply=JSON.parse(line);pending.get(reply.id)?.(reply);pending.delete(reply.id);});
 let seq=0;const call=(method:string,params:object={})=>new Promise<any>((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error(stderr||'MCP response timeout')),15000);pending.set(id,value=>{clearTimeout(timer);resolve(value);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 try{
  await call('initialize');const listed=await call('tools/list');expect(listed.result.tools[0].name).toBe('perform');expect(publications).toHaveLength(1);
  expect(publications).toEqual([{tools:[{tool:'perform',destructive:true,bulk:true}],replace:true}]);
  // MAIN RULING 1114-W6-MCP-HINT-RUNS
  const input={},tool='mcp__fixture__perform';expect(d.decide(f.open('perform',input,{tool,toolCall:{name:tool,input},toolEngine:'claude',mcpMounts:[{engineName:'fixture',mountId:'custom:fixture',provenance:'custom'}]}),baseRun).kind).toBe('run');
  // Inert server echoes readable arguments through the same admitted wipe proxy.
  // A literal root wipe still requires a card; no destructive command executes.
  const wipeInput={command:'rm -rf /'},wipeTool='mcp__fixture__run_command';
  const echoed=await call('tools/call',{name:'run_command',arguments:wipeInput});
  expect(JSON.parse(echoed.result.content[0].text)).toEqual({name:'run_command',arguments:wipeInput});
  expect(d.decide(f.open('literal-wipe',wipeInput,{tool:wipeTool,toolCall:{name:wipeTool,input:wipeInput},toolEngine:'claude',mcpMounts:[{engineName:'fixture',mountId:'custom:fixture',provenance:'custom'}]}),baseRun).kind).toBe('card');
 }finally{
  child.stdin.end();const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));const timer=setTimeout(()=>child.kill('SIGKILL'),1000);await closed;clearTimeout(timer);lines.close();await relay.finish();admission.dispose();credentials.dispose();ledger.close();await new Promise<void>(resolve=>server.close(()=>resolve()));f.dispose();await removeTempDir(root);
 }
},45000);

// 1.0.21 cause6: a failed record of the effect hints sealed the owner's whole command server for the turn (transport-lost).
it('cause6 stdio: hints that cannot be recorded fail that tools/list alone, with no tool listed; the mount stays and the next list succeeds',async()=>{
 const root=mkdtempSync(join(tmpdir(),'murage-wipe-mcp-')),fake=join(root,'fake.mjs');
 writeFileSync(fake,`import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;const result=q.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:q.method==='tools/list'?{tools:[{name:'delete_all_records',inputSchema:{type:'object',properties:{}}}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`);
 const publications:unknown[]=[];let refuse=2; // both attempts of the first list
 const ledger=consumingFixture(),caps=new InternalCapabilities(),credentials=createTurnCredentialStore();
 caps.begin(ledger.binding.identity.botId,ledger.turn.threadId,ledger.binding.identity.dispatchGeneration);
 const authority=createProxyReleaseAuthority(caps);
 const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  const body=JSON.parse(Buffer.concat(chunks).toString());
  if(req.url==='/api/internal/turn-release/v1/verdict'){
   const claim=caps.resolve(req.headers.authorization)!;
   if(body.operation==='upstream'){authority.reserveUpstream(claim,body);res.end('{}');}
   else if(body.operation==='seal'){authority.seal(claim);res.end('{}');}
   else res.end(JSON.stringify(authority.verdict(claim,body)));
   return;
  }
  publications.push(body);
  if(refuse>0){refuse--;res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}
  res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as {port:number}).port,proxy=fileURLToPath(new URL('./mcp-wipe-proxy.ts',import.meta.url));
 const mounts=customIntegrations({mcpServers:{fixture:{command:process.execPath,args:[fake],env:{},enabled:true}}} as unknown as AppConfig,{execPath:process.execPath,proxyPath:'unused',wipeProxyPath:proxy,harnessUrl:`http://127.0.0.1:${port}`,token:()=> 'fixture-token'})!;
 const mount=mounts.fixture!,url=`http://127.0.0.1:${port}`;
 const admission=createMcpMountAdmission(ledger.binding,authority,url);
 const relay=await CliMountRelay.create({threadId:ledger.turn.threadId,text:'Fixture',cwd:fixtureBotFolder(),
  warmIdentity:{botId:ledger.binding.identity.botId,audience:'owner'},releaseBinding:ledger.binding,mountAdmission:admission,
  integrations:{custom:{fixture:mount}}},
  {fixture:{...mount,env:{...mount.env,...mount.harnessEnv}}},{},credentials);
 const stanza=relay.servers.fixture as {command:string;args:string[];env:Record<string,string>};
 const child=spawn(stanza.command,stanza.args,{env:{...process.env,...stanza.env},stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
 const pending=new Map<number,(value:any)=>void>(),lines=createInterface({input:child.stdout});lines.on('line',line=>{const reply=JSON.parse(line);pending.get(reply.id)?.(reply);pending.delete(reply.id);});
 let seq=0;const call=(method:string,params:object={})=>new Promise<any>((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error(stderr||'MCP response timeout')),15000);pending.set(id,value=>{clearTimeout(timer);resolve(value);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 try{
  await call('initialize');
  const refused=await call('tools/list');
  expect(refused).toEqual({jsonrpc:'2.0',id:2,error:{code:-32000,message:"Murage could not record this server's tools. Try again in a moment."}});
  expect(JSON.stringify(refused)).not.toContain('delete_all_records');
  expect(publications).toHaveLength(2);
  // the mount was not dropped for the turn: the same child answers the next list, with its hints recorded first
  expect(relay.mountUnavailable('fixture')).toBe(false);
  const listed=await call('tools/list');
  expect(listed.result.tools.map((tool:{name:string})=>tool.name)).toEqual(['delete_all_records']);
  expect(publications).toHaveLength(3);
  expect(publications[2]).toEqual({tools:[{tool:'delete_all_records',destructive:true,bulk:true}],replace:true});
  expect(relay.mountUnavailable('fixture')).toBe(false);
 }finally{
  child.stdin.end();const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));const timer=setTimeout(()=>child.kill('SIGKILL'),1000);await closed;clearTimeout(timer);lines.close();await relay.finish();admission.dispose();credentials.dispose();ledger.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await removeTempDir(root);
 }
},45000);
