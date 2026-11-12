import { mkdirSync, readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
vi.hoisted(()=>vi.resetModules());
import { useOutsideStoreFixture } from '../testing/outside-store-fixture.ts';
const gate = vi.hoisted(() => ({
  mode: 'run', changed: false, calls: new Map<object, any>(), base: 0,
  presented: [] as any[], execute: vi.fn(), attached: [] as any[],
}));
vi.mock('../decision/index.ts', () => ({
  openRequest: (source: any) => { const handle = {}; gate.calls.set(handle, structuredClone(source)); return handle; },
  decide: (handle: object, base: any) => {
    if (gate.mode === 'base') { gate.base++; return base({source: gate.calls.get(handle)}).approve ? {kind:'run'} : {kind:'card',ref:{approvalId:'approval'}}; }
    return gate.mode === 'run' ? {kind:'run'} : {kind:'card',ref:{approvalId:'approval'}};
  },
  executeServiceSync: (handle: object, operation: any) => {
    gate.execute(handle);
    if (gate.changed) return {kind:'card',ref:{approvalId:'late-deny'}};
    const source = gate.calls.get(handle);
    if (!source) throw new Error('unknown handle');
    return {kind:'executed',value:operation(source.call)};
  },
  attachQueue: (ref: any, item: any) => gate.attached.push({ref,item}),
  presentApprovalSync: (ref: any, view: any) => gate.presented.push({ref,view}),
}));
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { appendMessage } from '../message-db.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { memoryAccess, reconcileMemoryRoster } from './policy.ts';
import { setMemoryMode } from './repository.ts';
import { claimMemoryJob, publishMemoryWork } from './jobs.ts';
import { captureWork } from './chunks.ts';
import { memoryAgentRoute } from './routes.ts';
import { applyRequestedMemory, correctMemory, ownerMemoryTicket, memoryApprovalQueue, openMemoryRequest, saveMemoryCandidate } from './authority.ts';
import { markTurnOutside } from '../email/external-marks.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR,{recursive:true});
  gate.mode='run'; gate.changed=false; gate.calls.clear(); gate.base=0; gate.presented=[]; gate.attached=[]; gate.execute.mockClear();
});
function fixture() {
  const roster={bots:[{id:'bot',threadId:'thread'}],groups:[]};
  reconcileMemoryRoster(roster); setMemoryMode('capture');
  appendMessage('thread',{id:'m',at:1,role:'user',origin:'desktop',kind:'text',text:'Original owner note'});
  const work=claimMemoryJob('fixture')!; publishMemoryWork(work,'fixture',captureWork(work));
  setMemoryMode('active');
  const target=String(database().prepare('SELECT id FROM memory_records').get()!.id);
  const registry=new InternalCapabilities(); registry.begin('bot','thread','generation');
  const token=registry.mint({botId:'bot',threadId:'thread',generation:'generation',depth:99,kind:'memory',skillAuthoring:false});
  const access=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
  const evidence=[{sourceId:work.sourceId,revision:1,startByte:0,endByte:Buffer.byteLength(work.text)}];
  const authority={claim:{fixture:true},proof:{reference:'fake-source'},identity:{threadId:'thread',generation:'generation'}};
  const call=(operation:'save'|'correction', key='request') => memoryAgentRoute(
    operation==='save'?'/api/internal/memory/save':'/api/internal/memory/propose-correction',
    operation==='save'?{text:'Quoted rm -rf ~ is data',evidence,idempotencyKey:key}:{id:target,version:1,replacement:'Quoted rm -rf ~ is data',evidence,idempotencyKey:key},
    access,{search:async()=>({hits:[],vectorRows:0})},undefined,null,{authority} as any,
  ) as Promise<any>;
  const row=(id:string)=>database().prepare('SELECT text,state,owner_pinned FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1').get(id);
  return {call,row,target,access,evidence,registry,authority};
}
for (const operation of ['save','correction'] as const) {
  it(`C producer ${operation==='save'?'33':'34'}: owner RUN activates actual ${operation} after outside reads, zero cards`, async()=>{
    const f=fixture(); markTurnOutside('thread','earlier turn');
    if(operation==='correction') database().prepare('UPDATE memory_records SET owner_pinned=1 WHERE id=?').run(f.target);
    const result=await f.call(operation);
    expect(result).toMatchObject({state:'active',pendingReview:false});
    expect(gate.presented).toHaveLength(0); expect(gate.base).toBe(0); expect(gate.execute).toHaveBeenCalledOnce();
    expect(f.row(result.candidateId)?.state).toBe('active');
    if(operation==='correction') { expect(f.row(f.target)?.state).toBe('superseded'); expect(f.row(result.candidateId)?.owner_pinned).toBe(1); }
    expect([...gate.calls.values()][0]).toMatchObject({kind:'service',service:'memory',claim:{fixture:true},call:{tool:operation==='save'?'memory_save':'memory_correction'}});
  });
  it(`C ${operation}: deny remains one CARD and never activates`, async()=>{
    const f=fixture(); gate.mode='deny'; const result=await f.call(operation);
    expect(result.state).toBe('candidate'); expect(gate.presented).toHaveLength(1); expect(gate.attached).toHaveLength(1);
    expect(gate.execute).not.toHaveBeenCalled(); expect(f.row(f.target)?.state).toBe('active');
  });
  it(`C ${operation}: guest BASE retains candidate and target`, async()=>{
    const f=fixture(); gate.mode='base'; const result=await f.call(operation);
    expect(result.state).toBe('candidate'); expect(gate.base).toBe(1); expect(gate.execute).not.toHaveBeenCalled();
    expect(f.row(f.target)?.state).toBe('active');
  });
  it(`C ${operation}: changed deny at execution cannot activate`, async()=>{
    const f=fixture(); gate.changed=true; const result=await f.call(operation);
    expect(result.state).toBe('candidate'); expect(gate.presented[0]?.ref.approvalId).toBe('late-deny');
  });
}
it('A1/R16: a handle for candidate A cannot activate candidate B',()=>{
  const f=fixture();
  const a=saveMemoryCandidate('first',f.evidence,'a',f.access), b=saveMemoryCandidate('second',f.evidence,'b',f.access);
  const request=openMemoryRequest({claim:{} as any,proof:'fixture'},f.access,a,1);
  expect(()=>applyRequestedMemory(request.handle,f.access,b,1)).toThrow('MEMORY_REQUEST_MISMATCH');
  expect(f.row(a)?.state).toBe('candidate'); expect(f.row(b)?.state).toBe('candidate');
});
it.each(['tool','text','evidence','generation','scope'])('R16: changed registered %s cannot activate',field=>{
  const f=fixture(),id=saveMemoryCandidate('first',f.evidence,'a',f.access);
  const request=openMemoryRequest({claim:{} as any,proof:'fixture'},f.access,id,1);
  const call=gate.calls.get(request.handle).call;
  if(field==='tool')call.tool='memory_correction';
  else if(field==='text')call.input.text='substituted';
  else if(field==='evidence')call.input.evidence[0].end_byte=1;
  else if(field==='scope')call.input.scopeId='other';
  else call.input.generation='other';
  expect(()=>applyRequestedMemory(request.handle,f.access,id,1)).toThrow('MEMORY_REQUEST_MISMATCH');
  expect(f.row(id)?.state).toBe('candidate');
});
it('C/A4a: durable queue precedes attachment, and exact frozen call is retained',async()=>{
  const f=fixture(); gate.mode='deny'; const result=await f.call('save');
  const item=memoryApprovalQueue().pendingApprovals()[0];
  expect(item.approvalId).toBe('approval'); expect(item.call.input).toMatchObject({candidateId:result.candidateId});
  expect(item.call).toEqual(gate.attached[0].item.call);
  expect(Object.isFrozen(item.call)).toBe(true);
  expect(JSON.stringify(item)).not.toContain('fixture":true');
});
it('C: service and routine paths never mint a desktop owner ticket or re-decide',()=>{
  const authority=readFileSync(new URL('./authority.ts',import.meta.url),'utf8');
  expect(authority.match(/\bownerMemoryTicket\s*\(/g)).toHaveLength(1); // declaration only
  for(const file of ['authority.ts','routes.ts','automatic-learning.ts']){
    const source=readFileSync(new URL(file,import.meta.url),'utf8');
    expect(source).not.toMatch(/approval-decision|\bfinalDecision\s*\(/);
  }
});
it('C: a stale memory capability cannot activate after registered RUN',()=>{
  const f=fixture(),id=saveMemoryCandidate('first',f.evidence,'a',f.access);
  const request=openMemoryRequest(f.authority as any,f.access,id,1);
  f.registry.revokeThread('thread');
  expect(()=>applyRequestedMemory(request.handle,f.access,id,1)).toThrow('MEMORY_UNAUTHORIZED');
  expect(f.row(id)?.state).toBe('candidate');
});
it('C: evidence revision changes after registration prevent activation',()=>{
  const f=fixture(),id=saveMemoryCandidate('first',f.evidence,'a',f.access);
  const request=openMemoryRequest(f.authority as any,f.access,id,1);
  database().prepare('UPDATE memory_sources SET revision=revision+1 WHERE id=?').run(f.evidence[0].sourceId);
  expect(()=>applyRequestedMemory(request.handle,f.access,id,1)).toThrow('MEMORY_EVIDENCE_UNAVAILABLE');
  expect(f.row(id)?.state).toBe('candidate');
});
it('C: current correction revision is checked again inside the activation transaction',async()=>{
  const f=fixture(); gate.mode='deny'; const result=await f.call('correction');
  const request=openMemoryRequest(f.authority as any,f.access,result.candidateId,1,'correction');
  correctMemory(ownerMemoryTicket(),f.target,1,'Owner edited target');
  expect(()=>applyRequestedMemory(request.handle,f.access,result.candidateId,1)).toThrow();
  expect(f.row(result.candidateId)?.state).toBe('candidate');
  expect(f.row(f.target)?.text).toBe('Owner edited target');
});
for(const operation of ['save','correction'] as const)for(const source of ['web page','earlier turn','cloned folder'] as const)it(`Field 7: owner-routine ${operation} after ${source} runs with zero cards`,async()=>{
  const f=fixture(); (f.authority.claim as any).actor='owner-routine';
  markTurnOutside('thread',source); const result=await f.call(operation);
  expect(result).toMatchObject({state:'active',pendingReview:false}); expect(gate.presented).toHaveLength(0);
});
useOutsideStoreFixture();

it('R16: executor delivery with null-prototype objects preserves exact request values',()=>{
  const f=fixture(),id=saveMemoryCandidate('first',f.evidence,'a',f.access);
  const request=openMemoryRequest(f.authority as any,f.access,id,1);
  const call=gate.calls.get(request.handle).call;
  call.input=JSON.parse(JSON.stringify(call.input),(_key,value)=>{
    if(value&&typeof value==='object'&&!Array.isArray(value))Object.setPrototypeOf(value,null);
    return value;
  });
  let failure:string|undefined;
  try{applyRequestedMemory(request.handle,f.access,id,1);}catch(error){failure=String(error);}
  expect({failure,state:f.row(id)?.state}).toEqual({failure:undefined,state:'active'});
});

for(const operation of ['save','correction'] as const)it(`integration audit: executed ${operation} records the No limits decision after activation`,async()=>{
  const f=fixture();const {onDecisionAppended}=await import('../decision-log.ts');const rows:any[]=[];const states:unknown[]=[];
  const remove=onDecisionAppended((_dir,row)=>{rows.push(row);states.push(f.row(String(row.requestId).replace(/^memory-/, '').replace(/-1$/, ''))?.state);});
  try{
    const result=await f.call(operation);
    expect(rows).toHaveLength(1);expect(states).toEqual(['active']);expect(rows[0]).toMatchObject({threadId:'thread',botId:'bot',requestId:`memory-${result.candidateId}-1`,tool:operation==='save'?'memory_save':'memory_correction',decision:'auto-approved',source:'no-limits'});
    expect(rows[0].summary).not.toContain('Quoted');
  }finally{remove();}
});
for(const mode of ['deny','base','late-deny'] as const)it(`integration audit: ${mode} never records an executed memory approval`,async()=>{
  const f=fixture();gate.mode=mode==='late-deny'?'run':mode;gate.changed=mode==='late-deny';
  const {onDecisionAppended}=await import('../decision-log.ts');const rows:any[]=[];const remove=onDecisionAppended((_dir,row)=>rows.push(row));
  try{await f.call('save');expect(rows).toHaveLength(0);}finally{remove();}
});
