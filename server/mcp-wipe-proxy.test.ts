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

it('W6 stdio tools/list annotations reach the registered decision before the catalog reaches the engine',async()=>{
 const root=mkdtempSync(join(tmpdir(),'murage-wipe-mcp-')),fake=join(root,'fake.mjs');
 writeFileSync(fake,`import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;const result=q.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:q.method==='tools/list'?{tools:[{name:'perform',annotations:{title:'Delete all owner records',destructiveHint:true},inputSchema:{type:'object',properties:{}}}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`);
 const f=fixture(),publications:unknown[]=[];
 const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  const body=JSON.parse(Buffer.concat(chunks).toString());publications.push(body);
  expect(req.url).toBe('/api/internal/mcp-remote/fixture/wipe-metadata');expect(req.headers.authorization).toBe('Bearer fixture-token');
  recordMcpWipeHints('t','fixture',body.tools,body.replace);res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as {port:number}).port,proxy=fileURLToPath(new URL('./mcp-wipe-proxy.ts',import.meta.url));
 const mounts=customIntegrations({mcpServers:{fixture:{command:process.execPath,args:[fake],env:{},enabled:true}}} as unknown as AppConfig,{execPath:process.execPath,proxyPath:'unused',wipeProxyPath:proxy,harnessUrl:`http://127.0.0.1:${port}`,token:()=> 'fixture-token'})!;
 const mount=mounts.fixture!,env={...process.env,...mount.env,...mount.harnessEnv};delete env.MURAGE_CRED_FILE;delete env.MURAGE_CRED_SERVER;
 const child=spawn(mount.command,mount.args,{env,stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
 const pending=new Map<number,(value:any)=>void>(),lines=createInterface({input:child.stdout});lines.on('line',line=>{const reply=JSON.parse(line);pending.get(reply.id)?.(reply);pending.delete(reply.id);});
 let seq=0;const call=(method:string)=>new Promise<any>((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error(stderr||'MCP response timeout')),15000);pending.set(id,value=>{clearTimeout(timer);resolve(value);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params:{}})+'\n');});
 try{
  await call('initialize');const listed=await call('tools/list');expect(listed.result.tools[0].name).toBe('perform');expect(publications).toHaveLength(1);
  const input={},tool='mcp__fixture__perform';expect(d.decide(f.open('perform',input,{tool,toolCall:{name:tool,input},toolEngine:'claude',mcpMounts:[{engineName:'fixture',mountId:'custom:fixture',provenance:'custom'}]}),baseRun).kind).toBe('card');
 }finally{
  child.stdin.end();const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));const timer=setTimeout(()=>child.kill('SIGKILL'),1000);await closed;clearTimeout(timer);lines.close();await new Promise<void>(resolve=>server.close(()=>resolve()));f.dispose();await removeTempDir(root);
 }
},45000);
