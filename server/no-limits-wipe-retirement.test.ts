import { noLimitsEvidence } from './testing/no-limits-evidence.ts';
const captureDir=noLimitsEvidence('wipe-retirement');
// SPDX-License-Identifier: AGPL-3.0-or-later
import {it,expect} from 'vitest';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {launchVerificationServer} from '../scripts/control-murage.ts';

it('fold M1 production thread and server retirement dispose catalogs without touching live peers',async()=>{
 const moduleUrl=new URL('./no-limits-wipe-mcp.ts',import.meta.url).href;
 const fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
  import {readFileSync,writeFileSync} from 'node:fs';
  import {join} from 'node:path';
  import {recordMcpWipeHints,mcpWipeHint} from ${JSON.stringify(moduleUrl)};
  process.env.MURAGE_MCP_COMMIT_TOKEN='fixture-wipe-retirement';
  let last=0;
  setInterval(()=>{try{
   const q=JSON.parse(readFileSync(join(process.env.MURAGE_DATA_DIR,'wipe-query.json'),'utf8'));
   if(q.id===last)return;last=q.id;
   if(q.seed)for(const thread of q.threads)for(const server of ['removed','kept'])recordMcpWipeHints(thread,server,[{tool:'perform',destructive:true,bulk:true}],true);
   const states=Object.fromEntries(q.threads.map(thread=>[thread,Object.fromEntries(['removed','kept'].map(server=>[server,!!mcpWipeHint(thread,server,'perform')]))]));
   writeFileSync(join(process.env.MURAGE_DATA_DIR,'wipe-answer.json'),JSON.stringify({id:q.id,states}));
  }catch{}},10).unref();
 `});
 const evidence:{fixture:typeof fixture.info;steps:unknown[]}={fixture:fixture.info,steps:[]};
 try{
  const secret=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
  const headers={'x-murage-surface':'desktop','x-murage-surface-secret':secret.secret,'content-type':'application/json',authorization:'Bearer fixture-wipe-retirement'};
  const api=async(method:string,path:string,body?:unknown)=>{
   const res=await fetch(fixture.info.url+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
   const value: any=await res.json();evidence.steps.push({method,path,status:res.status,body:value});return {status:res.status,body:value};
  };
  const bot=(await api('POST','/api/bots',{name:'Wipe retirement fixture'})).body.bot;
  const threads=[bot.threadId,'live-peer'];let id=0;
  const query=async(seed=false)=>{
   writeFileSync(join(fixture.info.dataDir,'wipe-query.json'),JSON.stringify({id:++id,threads,seed}));
   const deadline=Date.now()+5000;
   while(Date.now()<deadline){
    try{const answer=JSON.parse(readFileSync(join(fixture.info.dataDir,'wipe-answer.json'),'utf8'));if(answer.id===id){evidence.steps.push(answer);return answer.states;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,20));
   }
   throw Error('fixture observation timed out');
  };
  expect((await api('POST','/api/mcp/servers',{name:'removed',command:process.execPath,args:['--version']})).status).toBe(201);
  expect((await query(true))[bot.threadId]).toEqual({removed:true,kept:true});
  expect((await api('DELETE',`/api/bots/${bot.id}`)).status).toBe(200);
  const retired=await query();expect(retired[bot.threadId]).toEqual({removed:false,kept:false});
  expect(retired['live-peer']).toEqual({removed:true,kept:true});
  expect((await api('DELETE','/api/mcp/servers/removed')).status).toBe(200);
  expect((await query())['live-peer']).toEqual({removed:false,kept:true});
 }finally{
  if(existsSync(captureDir)){
   writeFileSync(new URL('retirement-fixture.json',captureDir),JSON.stringify(evidence,null,2));
   writeFileSync(new URL('retirement-server.log',captureDir),readFileSync(fixture.info.logPath));
  }
  await fixture.close();
 }
},180000);
