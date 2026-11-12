// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Blocked, Harness, root, verdict, type Turn } from './harness.ts';
import { hostDenyRequest, assertHostDenyRequest } from './controls.ts';
import { BehavioralRed, Surface, type Call } from './surface.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';

it('B4: unrelated exceptions, missing mounts, 500s and timeouts receive no S1 exemption',()=>{
 for(const error of [new TypeError('bad harness field'),new SyntaxError('bad journal'),new Error('NotBuilt: unrelated fixture'),new Blocked('missing mounted memory MCP server'),new Blocked('HTTP 500: unrelated server crash'),new Blocked('timeout: engine mounted turn')])expect(verdict(error),error.message).toBe('ERROR');
 expect(verdict(new BehavioralRed('effect missing',{}))).toBe('RED');
 expect(verdict(new Blocked('real server exited: Error: NotBuilt: decision.installProducerBindings'))).toBe('BLOCKED-BY-S1');
 expect(verdict(new Blocked('memory/memory_save: {"error":"NotBuilt"}'))).toBe('BLOCKED-BY-S1');
});
it('B4: missing mutation targets are harness errors, never S1 blockers or kills',()=>{
 const home=mkdtempSync(join(tmpdir(),'murage-field-mutant-check-'));
 try{
  const scratch=join(home,'bld-s2m-r4','scratch');mkdirSync(scratch,{recursive:true});
  const output=join(home,'evidence');mkdirSync(output);
  const sha='synthetic-missing-target-tree';
  writeFileSync(join(output,'field-replay.jsonl'),JSON.stringify({tree:'TW',sha,id:'R1',outcome:'GREEN'})+'\n');
  const run=spawnSync(process.execPath,[join(root,'server/memory/field-replay/mutants.mjs')],{cwd:scratch,encoding:'utf8',env:{...process.env,FIELD_REPLAY_SCRATCH:'1',FIELD_REPLAY_SHA:sha,FIELD_REPLAY_EVIDENCE:output}});
  expect(run.status,run.stderr).toBe(1);
  const rows=readFileSync(join(output,'mutants.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  expect(rows.filter(row=>row.id!=='MS')).toHaveLength(8);
  for(const row of rows.filter(row=>row.id!=='MS'))expect(row.outcome,JSON.stringify(row)).toBe('ERROR');
 }finally{removeTempDirSync(home);}
});

it('B2: the configured denial is exercised by a host tool, never schedule prose',()=>{
 const request=hostDenyRequest();
 expect(()=>assertHostDenyRequest(request)).not.toThrow();
 expect(()=>assertHostDenyRequest({...request,tool_name:'schedule_routine',input:{x:1,y:1}})).toThrow(BehavioralRed);
});

// An isolated HTTP/SSE/journal fixture for the R8 harness contract. This does
// not stand in for the real-server policy replay when S1 prevents startup.
async function r8Fixture(run:(fixture:{turn:Turn;h:Harness;showCard:(why:string)=>void;settle:()=>void})=>Promise<void>){
 const home=mkdtempSync(join(tmpdir(),'murage-r8-phases-'));
 const threadId='synthetic-r8-thread';
 const cards:any[]=[];let stream:ServerResponse|undefined;let surface:Surface|undefined;
 const server=createServer((request,response)=>{
  if(request.url==='/api/events'){
   stream=response;response.writeHead(200,{'content-type':'text/event-stream'});response.write(': connected\n\n');return;
  }
  response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({messages:cards}));
 });
 try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('fixture address missing');
  const base=`http://127.0.0.1:${address.port}`;
  const call:Call=async(method,path,body)=>{
   const response=await fetch(`${base}${path}`,{method,...(body?{body:JSON.stringify(body)}:{})});
   return {status:response.status,body:await response.json()};
  };
  surface=await Surface.open(base,{},call,home);
  const h=new Harness();h.surfaces.push(surface);
  const turn:Turn={bot:{id:'synthetic-r8-bot',threadId},threadId,dump:{},startedAt:0,surface};
  const emit=(kind:string,message:any)=>stream!.write(`data: ${JSON.stringify({kind,threadId,message})}\n\n`);
  const showCard=(why:string)=>{
   const id=`synthetic-card-${cards.length}`;
   const message={id,kind:'options',card:{requestId:id,why,answered:false}};
   cards.push(message);emit('message',message);
   appendFileSync(join(home,'decisions.ndjson'),JSON.stringify({threadId,decision:'card-shown',why})+'\n');
  };
  appendFileSync(join(home,'decisions.ndjson'),JSON.stringify({threadId,decision:'auto-approved',source:'no-limits'})+'\n');
  await run({turn,h,showCard,settle:()=>{
   for(const message of cards){message.card.answered=true;emit('message.patch',message);}
  }});
 }finally{
  surface?.close();server.closeAllConnections();
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  removeTempDirSync(home);
 }
}
const appliedProposal={result:{text:'Applied automatically',isError:false},routine:{id:'synthetic-routine',permissionMode:'unlimited'},name:'Synthetic routine'};
it('R8 harness: zero-card applied phase then exactly one deny card survives settlement',()=>r8Fixture(async({turn,h,showCard,settle})=>{
 // Mutation anchor: a stray applied-phase card must fail before nextPhase.
 const applied=await h.applied(turn,appliedProposal);
 expect([applied.sse,applied.transcript,applied.decision]).toEqual([0,0,0]);
 await turn.surface.nextPhase();
 showCard('deny');
 const denied=await turn.surface.assert([turn.threadId],1,'deny');
 expect([denied.sse,denied.transcript,denied.decision]).toEqual([1,1,1]);
 settle();
 // Match replay(): stop the subscription, then verify after settlement.
 turn.surface.close();for(const surface of h.surfaces)await surface.recheck();
}));
it('R8 harness: nextPhase rechecks the applied phase before admitting the deny action',()=>r8Fixture(async({turn,h,showCard})=>{
 await h.applied(turn,appliedProposal);
 showCard('stray');
 await expect(turn.surface.nextPhase()).rejects.toThrow('expected 0 permission cards');
}));
it('R8 harness: settlement still rejects an additional card in the deny phase',()=>r8Fixture(async({turn,h,showCard,settle})=>{
 await h.applied(turn,appliedProposal);await turn.surface.nextPhase();
 showCard('deny');await turn.surface.assert([turn.threadId],1,'deny');
 showCard('stray');settle();await turn.surface.counts([turn.threadId]);turn.surface.close();
 await expect(turn.surface.recheck()).rejects.toThrow('expected 1 permission cards');
}));
