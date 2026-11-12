import {expect,it,vi} from 'vitest';
import {fixture,d,baseCard} from './fixture.ts';
import {boundedProjection} from './bounds.ts';
import {openRecords} from './records.ts';
import {shellExecutables} from '../no-limits-shell.ts';

it.each(['cancelled','expired','superseded'] as const)('B4 %s prevents engine and service RUN after decision',async state=>{
 const f=fixture(),engine=f.open(),service=d.openRequest({kind:'service',service:'email',claim:f.claim,call:{tool:'email_send',input:{text:'exact'}}});
 expect(d.decide(engine,baseCard).kind).toBe('run');expect(d.decide(service,baseCard).kind).toBe('run');
 await d.cancelRequests({kind:'generation',threadId:'t',generation:'g'},state);
 const execute=vi.fn();expect((await d.executeService(service,execute)).kind).toBe('refuse');expect(execute).not.toHaveBeenCalled();
 await d.deliverRequest(engine);expect(f.respond.mock.calls.every(c=>c[1].behavior==='deny')).toBe(true);
 expect(d.decide(engine,baseCard).kind).toBe('refuse');
});
it('B4 cancellation fences a scheduled asynchronous callback',async()=>{
 const f=fixture(),h=d.openRequest({kind:'service',service:'email',claim:f.claim,call:{tool:'email_send',input:{text:'x'}}});d.decide(h,baseCard);
 const execute=vi.fn();const work=d.executeService(h,execute);await d.cancelRequests({kind:'thread',threadId:'t'},'cancelled');
 expect((await work).kind).toBe('refuse');expect(execute).not.toHaveBeenCalled();
});
it.each(["'EOF'",'EOF','"EOF"'])('B5 heredoc %s retains the header redirect and protected target',delimiter=>{
 const command=`cat <<${delimiter} > /etc/cron.d/x\nfixture body\nEOF`;
 expect(shellExecutables(command,0,[])).toContain('> /etc/cron.d/x');
 const f=fixture(),h=f.open('h',{command});expect(d.decide(h,baseCard).kind).toBe('run');
});
it('B6 ordinary command strings cannot be silently clipped for execution',async()=>{
 const f=fixture(),command='echo '+ 'x'.repeat(1_000_100)+'; echo tail';const execute=vi.fn();
 expect(()=>d.openRequest({kind:'service',service:'email',claim:f.claim,call:{tool:'Bash',input:{command}}})).toThrow('service-input-too-large');
 expect(execute).not.toHaveBeenCalled();
});
it('B6 key and depth limits reject incomplete service delivery',()=>{
 const f=fixture();for(const input of [Object.fromEntries(Array.from({length:10005},(_,i)=>['k'+i,i])),Array.from({length:33}).reduce(x=>({nested:x}),{} as any)])
 expect(()=>d.openRequest({kind:'service',service:'email',claim:f.claim,call:{tool:'email_send',input}})).toThrow('service-input-too-large');
});
it('B2 synchronous executor runs exact captured input once across both APIs',async()=>{
 const f=fixture(),input={text:'exact body'},h=d.openRequest({kind:'service',service:'email',claim:f.claim,call:{tool:'email_send',input}});d.decide(h,baseCard);input.text='changed';
 const execute=vi.fn(call=>call.input);expect(d.executeServiceSync(h,execute)).toEqual({kind:'executed',value:{text:'exact body'}});
 expect(d.executeServiceSync(h,execute)).toEqual({kind:'executed',value:{text:'exact body'}});expect(await d.executeService(h,execute)).toEqual({kind:'executed',value:{text:'exact body'}});expect(execute).toHaveBeenCalledTimes(1);
});
it('B2 synchronous executor rechecks denies and rejects async collisions',async()=>{
 const f=fixture(),h=d.openRequest({kind:'service',service:'email',claim:f.claim,call:f.serviceCall({command:'echo fixture'})});d.decide(h,baseCard);f.deny([{kind:'deny',span:'fixture',ruleId:'fixture',class:'system'}]);
 const execute=vi.fn();expect(d.executeServiceSync(h,execute).kind).toBe('executed');expect(execute).toHaveBeenCalledOnce();
 f.deny([]);const next=d.openRequest({kind:'service',service:'email',claim:f.claim,call:f.serviceCall({command:'echo next'},'pending')});d.decide(next,baseCard);const work=d.executeService(next,async()=>42);expect(()=>d.executeServiceSync(next,execute)).toThrow('service-execution-pending');await work;
});
it('B7 open lookups use bounded open-state indexes with and without a thread',()=>{
 const f=fixture();for(const thread of [undefined,'t']){
 const query=`SELECT * FROM approval_records WHERE state='open'${thread?' AND thread_id=?':''} ORDER BY created_at,rowid`;
 const plan=f.db.prepare('EXPLAIN QUERY PLAN '+query).all(...(thread?[thread]:[])).map(r=>r.detail).join(' ');
 expect(plan).toContain(thread?'approval_open_thread':'approval_open_created');expect(plan).not.toContain('USE TEMP');expect(openRecords(f.db,thread)).toEqual([]);
 }
});
it('B2 consumed synchronous failures cannot repeat side effects through either API',async()=>{
 const f=fixture(),h=d.openRequest({kind:'service',service:'email',claim:f.claim,call:{tool:'email_send',input:{text:'fixture'}}});d.decide(h,baseCard);
 const execute=vi.fn(()=>{throw new Error('fixture-error');});expect(()=>d.executeServiceSync(h,execute)).toThrow('fixture-error');
 expect(()=>d.executeServiceSync(h,execute)).toThrow('service-execution-pending');expect(()=>d.executeService(h,execute)).toThrow('service-execution-consumed');expect(execute).toHaveBeenCalledTimes(1);
 expect(()=>d.executeServiceSync(f.open(),execute)).toThrow('service-request-required');
});
it('B2 synchronous executor rejects thenables and never retries them',async()=>{
 const f=fixture(),h=d.openRequest({kind:'service',service:'email',claim:f.claim,call:{tool:'email_send',input:{text:'fixture'}}});d.decide(h,baseCard);
 const execute=vi.fn(()=>Promise.resolve('not synchronous'));expect(()=>d.executeServiceSync(h,execute)).toThrow('synchronous-service-required');
 expect(()=>d.executeService(h,execute)).toThrow('service-execution-consumed');expect(execute).toHaveBeenCalledTimes(1);
});
it('B6 large content delivers the exact immutable string while policy stays bounded',async()=>{
 const f=fixture(),body='🟦'.repeat(400000),call={tool:'email_send',input:{body}},h=d.openRequest({kind:'service',service:'email',claim:f.claim,call});d.decide(h,baseCard);call.input.body='mutated';
 const result=await d.executeService(h,async registered=>registered.input);expect(result).toEqual({kind:'executed',value:{body}});
});

it('B6 duplicate bounded hashes cannot hide an oversized ordinary input',()=>{
 const f=fixture(),oversized={tool:'Bash',input:{command:'x'.repeat(1_000_100)}};
 const exact=boundedProjection(oversized);d.openRequest({kind:'service',service:'email',claim:f.claim,call:exact});
 expect(()=>d.openRequest({kind:'service',service:'email',claim:f.claim,call:oversized})).toThrow('service-input-too-large');
});
