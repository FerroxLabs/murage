import {it,expect,vi,beforeEach,afterEach} from 'vitest';
vi.hoisted(()=>vi.resetModules());
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {removeTempDirSync} from '../testing/cleanup.ts';
import {join} from 'node:path';
const core=vi.hoisted(()=>({openRequest:vi.fn(),decide:vi.fn(),executeService:vi.fn(),attachQueue:vi.fn(),presentApproval:vi.fn(),readApproval:vi.fn(),answerApproval:vi.fn(),settle:vi.fn(),executeServiceSync:vi.fn(),presentApprovalSync:vi.fn(),answerApprovalSync:vi.fn()}));
vi.mock('../decision/index.ts',()=>core);
import {MemoryApprovalQueue} from './service-approval.ts';
let dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'s2-queue-'));vi.clearAllMocks();});
afterEach(()=>removeTempDirSync(dir));
const make=(kind:any='memory')=>new MemoryApprovalQueue(kind,join(dir,`${kind}.json`));
const ref={approvalId:'approval-1'} as any;
const spec=()=>({authority:{claim:{} as any,proof:{origin:'server-reference'}},ref:'request-1',epoch:'epoch-1',tool:'memory_save',input:{target:'bot',message:'rm -rf ~'},action:{requestId:'request-1',tool:'memory_save',options:['Allow','Deny']},view:{title:'Review memory',subtitle:'rm -rf ~'},base:{approve:null,source:'no-grant'} as any});
it('A1/A2/A4a: freezes the exact call, writes queue before attach/present, and enumerates after restart',async()=>{
 const queue=make();core.decide.mockReturnValue({kind:'card',ref});
 const input=spec();const pending=queue.open(input);input.action.options.push('substituted');
 const accept=vi.fn();
 core.attachQueue.mockImplementation(()=>{const saved=make().pendingApprovals();expect(saved).toHaveLength(1);expect(saved[0].approvalId).toBe(ref.approvalId);});
 await queue.present(pending,ref,accept);
 expect(core.openRequest.mock.calls[0][0].call.input.message).toBe('rm -rf ~');
 expect(core.presentApproval).toHaveBeenCalledWith(ref,{title:'Review memory',subtitle:'rm -rf ~'});
 const saved=make().pendingApprovals();expect(saved).toHaveLength(1);expect(saved[0].call.approval.action.options).toEqual(['Allow','Deny']);expect(JSON.stringify(saved)).not.toContain('claim');
});
it('RUN uses executeService; a changed deny queues before any side effect',async()=>{
 const queue=make();core.decide.mockReturnValue({kind:'run'});core.executeService.mockResolvedValue({kind:'card',ref});
 const run=vi.fn();const result=await queue.execute(queue.open(spec()),run);
 expect(result).toEqual({kind:'card',ref});expect(run).not.toHaveBeenCalled();expect(core.executeService).toHaveBeenCalled();
});
it('same answerId joins pending acceptance, retries failure, and never acknowledges a hang',async()=>{
 const queue=make();core.decide.mockReturnValue({kind:'card',ref});const open=queue.open(spec());
 let finish!:()=>void;const accept=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));await queue.present(open,ref,accept);
 const item=queue.pendingApprovals()[0];const first=queue.respond(item,{behavior:'allow'},{answerId:'answer-1'});const again=queue.respond(item,{behavior:'allow'},{answerId:'answer-1'});
 let done=false;void again.then(()=>{done=true;});await Promise.resolve();expect(done).toBe(false);expect(accept).toHaveBeenCalledTimes(1);
 finish();expect(await first).toEqual({state:'accepted'});expect(await again).toEqual({state:'accepted'});expect(await queue.respond(item,{behavior:'allow'},{answerId:'answer-1'})).toEqual({state:'already'});
 expect(await queue.respond(item,{behavior:'deny'},{answerId:'other'})).toEqual({state:'failed'});
});
it('recovery renewal replaces the epoch atomically and refuses changed call identities',async()=>{
 const queue=make();core.decide.mockReturnValue({kind:'card',ref});await queue.present(queue.open(spec()),ref,async()=>{});
 const item=queue.pendingApprovals()[0];const replacement=await queue.renew(item,{approvalId:'approval-2',epoch:'epoch-2'});
 expect(make().pendingApprovals()).toEqual([replacement]);expect(replacement.call.approval.epoch).toBe('epoch-2');
 expect(await queue.renew(item,{approvalId:'approval-2',epoch:'epoch-2'})).toEqual(replacement);
 await expect(queue.cancel({...replacement,call:{...replacement.call,input:{substituted:true}}},'conflict')).rejects.toThrow();
 await queue.cancel(replacement,'cancelled');expect(make().pendingApprovals()).toHaveLength(0);
});

it('C: synchronous queue delivery persists pending before activation and rejects a conflicting answer',()=>{
 const queue=make();core.decide.mockReturnValue({kind:'card',ref});
 const accept=vi.fn(()=>expect(JSON.parse(readFileSync(join(dir,'memory.json'),'utf8')).entries[0]).toMatchObject({state:'pending',answerId:'answer-1'}));
 core.attachQueue.mockImplementation(()=>expect(make().pendingApprovals()).toHaveLength(1));
 queue.presentNow(queue.open(spec()),ref,accept);
 const item=queue.pendingApprovals()[0];
 expect(queue.respondNow(item,{behavior:'allow'},{answerId:'answer-1'})).toEqual({state:'accepted'});
 expect(queue.respondNow(item,{behavior:'allow'},{answerId:'answer-1'})).toEqual({state:'already'});
 expect(queue.respondNow(item,{behavior:'deny'},{answerId:'answer-2'})).toEqual({state:'failed'});
 expect(accept).toHaveBeenCalledOnce();
});
it('A4a: a retry uses the same durable queue identity and rejects changed action/input',()=>{
 const queue=make();core.decide.mockReturnValue({kind:'card',ref});
 const input=spec();delete (input as any).epoch;
 queue.presentNow(queue.open(input),ref,()=>{});
 const item=queue.pendingApprovals()[0];
 expect(queue.open(input).item.epoch).toBe(item.epoch);
 expect(()=>queue.open({...input,input:{changed:true}})).toThrow('approval-queue-conflict');
});
it('A4a: failed delivery survives restart and requires freshly installed recovery access',async()=>{
 const queue=make();core.decide.mockReturnValue({kind:'card',ref});
 queue.presentNow(queue.open(spec()),ref,()=>{throw new Error('stale access');});
 const item=queue.pendingApprovals()[0];
 expect(queue.respondNow(item,{behavior:'allow'},{answerId:'answer-1'})).toEqual({state:'failed'});
 expect(await make().respond(item,{behavior:'allow'},{answerId:'answer-1'})).toEqual({state:'failed'});
 expect(make().pendingApprovals()).toEqual([item]);
 const accept=vi.fn();const recovered=new MemoryApprovalQueue('memory',join(dir,'memory.json'),accept,accept);
 expect(recovered.respondNow(item,{behavior:'allow'},{answerId:'answer-1'})).toEqual({state:'accepted'});
 expect(accept).toHaveBeenCalledOnce();
});

it('A4a: a persisted pending answer retries after a crash with the same answer id',()=>{
 const queue=make();core.decide.mockReturnValue({kind:'card',ref});queue.presentNow(queue.open(spec()),ref,()=>{});
 const item=queue.pendingApprovals()[0],file=join(dir,'memory.json'),saved=JSON.parse(readFileSync(file,'utf8'));
 Object.assign(saved.entries[0],{state:'pending',answerId:'answer-1',answer:{behavior:'allow'}});writeFileSync(file,JSON.stringify(saved));
 const accept=vi.fn(),restarted=new MemoryApprovalQueue('memory',file,accept,accept);
 expect(restarted.respondNow(item,{behavior:'allow'},{answerId:'answer-1'})).toEqual({state:'accepted'});
 expect(accept).toHaveBeenCalledOnce();
});
