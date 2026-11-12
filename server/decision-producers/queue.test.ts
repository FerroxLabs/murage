import {it,expect,vi,beforeEach,afterEach} from 'vitest';
vi.hoisted(()=>vi.resetModules());
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const core=vi.hoisted(()=>({openRequest:vi.fn(),decide:vi.fn(),executeService:vi.fn(),attachQueue:vi.fn(),presentApproval:vi.fn(),readApproval:vi.fn(),answerApproval:vi.fn(),settle:vi.fn()}));
vi.mock('../decision/index.ts',()=>core);
import {ProducerApprovalQueue} from '../narrow-denials.ts';
let dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'s2-queue-'));vi.clearAllMocks();});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
const make=(kind:any='peer')=>new ProducerApprovalQueue(kind,join(dir,`${kind}.json`));
const ref={approvalId:'approval-1'} as any;
const spec=()=>({authority:{claim:{} as any,proof:{origin:'server-reference'}},ref:'request-1',epoch:'epoch-1',tool:'ask_bot',input:{target:'bot',message:'rm -rf ~'},action:{requestId:'request-1',tool:'ask_bot',options:['Allow','Deny']},view:{title:'Contact bot',subtitle:'rm -rf ~'},base:{approve:null,source:'no-grant'} as any});
it('A1/A2/A4a: freezes the exact call, writes queue before attach/present, and enumerates after restart',async()=>{
 const queue=make();core.decide.mockReturnValue({kind:'card',ref});
 const input=spec();const pending=queue.open(input);input.action.options.push('substituted');
 const accept=vi.fn();
 core.attachQueue.mockImplementation(()=>expect(make().pendingApprovals()[0].approvalId).toBe(ref.approvalId));
 await queue.present(pending,ref,accept);
 expect(core.openRequest.mock.calls[0][0].call.input.message).toBe('rm -rf ~');
 expect(core.presentApproval).toHaveBeenCalledWith(ref,{title:'Contact bot',subtitle:'rm -rf ~'});
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
 queue.registerDelivery('ask_bot',async()=>{});await queue.cancel(replacement,'cancelled');expect(make().pendingApprovals()).toHaveLength(0);
});

it('pending/accepted answers survive restart; exact retry is deduplicated',async()=>{
 const queue=make();core.decide.mockReturnValue({kind:'card',ref});const open=queue.open(spec());
 const accept=vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(undefined);
 await queue.present(open,ref,accept);const item=queue.pendingApprovals()[0];
 expect(await queue.respond(item,{behavior:'allow'},{answerId:'stable'})).toEqual({state:'failed'});
 const restarted=make();restarted.registerDelivery('ask_bot',accept);
 expect(await restarted.respond(item,{behavior:'allow'},{answerId:'stable'})).toEqual({state:'accepted'});
 expect(await make().respond(item,{behavior:'allow'},{answerId:'stable'})).toEqual({state:'already'});
 expect(accept).toHaveBeenCalledTimes(2);
});
it('cancellation cannot race a pending action or renew a settled action',async()=>{
 const queue=make();core.decide.mockReturnValue({kind:'card',ref});
 let finish!:()=>void;const accept=vi.fn(()=>new Promise<void>(r=>{finish=r;}));await queue.present(queue.open(spec()),ref,accept);
 const item=queue.pendingApprovals()[0], flight=queue.respond(item,{behavior:'allow'},{answerId:'stable'});
 await expect(queue.cancel(item,'cancelled')).rejects.toThrow();expect(accept).toHaveBeenCalledTimes(1);
 finish();await flight;
 await expect(queue.renew(item,{approvalId:'new',epoch:'new'})).rejects.toThrow();
});
it('renew retry checks the original call instead of accepting a substituted item',async()=>{
 const queue=make();core.decide.mockReturnValue({kind:'card',ref});await queue.present(queue.open(spec()),ref,()=>{});
 const item=queue.pendingApprovals()[0];await queue.renew(item,{approvalId:'new',epoch:'new'});
 await expect(queue.renew({...item,call:{...item.call,input:{changed:true}}},{approvalId:'new',epoch:'new'})).rejects.toThrow();
});
