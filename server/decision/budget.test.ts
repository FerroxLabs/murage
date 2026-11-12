import {expect,it} from 'vitest';
import {performance} from 'node:perf_hooks';
import {fixture,d,baseCard} from './fixture.ts';
import {boundedProjection,hash} from './bounds.ts';
import {pruneRecords,recordStats} from './records.ts';
it('A12a M64 50MB content hashes stably without an unbounded clone; depth/key bounds',()=>{
 const content='x'.repeat(50*1024*1024);const start=performance.now();const a=boundedProjection({content});expect(a.content.head.length).toBe(65536);expect(hash(a)).toBe(hash(boundedProjection({content})));expect(performance.now()-start).toBeLessThan(5000);
 let deep:any={command:'echo x'};for(let i=0;i<100;i++)deep={next:deep};expect(JSON.stringify(boundedProjection(deep)).length).toBeLessThan(2000);
});
it('R18 bounded registrations: 33rd same-thread request refuses and prior wipe survives',()=>{
 const f=fixture('full');const h=f.open('wipe',{command:'rm -rf ~'+' '.repeat(900000)});expect(d.decide(h,baseCard).kind).toBe('card');for(let i=0;i<31;i++)d.decide(f.open('request'+i),baseCard);expect(d.decide(f.open('overflow'),baseCard).kind).toBe('refuse');expect(recordStats(f.db).cache).toBeLessThanOrEqual(1536);
});
it('A12a prune walks settled index in batches of 500',()=>{
 const f=fixture();const plan=f.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM approval_records INDEXED BY approval_records_settled WHERE state <> 'open' AND settled_at < ? ORDER BY settled_at LIMIT 500").all(Date.now());expect(JSON.stringify(plan)).toContain('approval_records_settled');expect(pruneRecords(f.db)).toBe(0);
});
it('M64 projection never calls structuredClone before enforcing bounds',async()=>{
 const {vi}=await import('vitest');const spy=vi.spyOn(globalThis,'structuredClone').mockImplementation(()=>{throw new Error('unbounded clone');});try{expect(()=>boundedProjection({command:'echo x'})).not.toThrow();expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
});
it('M36 one cumulative reader budget covers outer scripts and all nested executables',async()=>{
 const {readExecutable}=await import('../no-limits-code.ts');const {ReaderBudget}=await import('../no-limits-budget.ts');const script="sh -c 'rm -rf ~'";const budget=new ReaderBudget();budget.left=script.length+7;expect(readExecutable('sh',script,budget).classes).toHaveLength(0);expect(budget.left).toBeLessThan(0);
});
it('A12a UTF-8 byte bounds apply to content heads, values and oversized keys',()=>{
 const body='😀'.repeat(100000);expect(Buffer.byteLength(boundedProjection({body}).body.head)).toBeLessThanOrEqual(65536);
 expect(Buffer.byteLength(boundedProjection({command:'😀'.repeat(1000000)}).command)).toBeLessThanOrEqual(1000000);expect(Object.keys(boundedProjection({['x'.repeat(2000000)]:'value'}))).toHaveLength(0);
});
it('A12a content heads share the same one MB registration budget',()=>{
 const source=Object.fromEntries(Array.from({length:24},(_,i)=>['body'+i,{content:'x'.repeat(70000)}]));
 const projection=boundedProjection(source);const heads=Object.values(projection).reduce((n:number,v:any)=>n+Buffer.byteLength(v.content?.head??''),0);
 expect(heads).toBeLessThanOrEqual(1_000_000);
});

it('R18 600 concurrent registrations enforce the process cap without evicting a live wipe',()=>{
 const f=fixture();
 d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>undefined,live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level:'unlimited'})});
 const issue=d.installClaimVerifier(proof=>typeof proof==='string'?{threadId:proof,botId:'b',generation:'g'}:undefined);
 const verdicts=[];
 const start=performance.now();
 for(let i=0;i<600;i++){
  const threadId='capacity-'+i,call=f.serviceCall({command:i===0?'rm -rf ~':'echo fixture'},String(i));
  verdicts.push(d.decide(d.openRequest({kind:'service',service:'email',claim:issue(threadId)!,call}),()=>({approve:'BASE',source:'auto-mode'})));
 }
 expect(verdicts.filter(o=>o.kind==='refuse')).toHaveLength(88);
 expect(verdicts[0].kind).toBe('card');expect(performance.now()-start).toBeLessThan(10000);
});
it('R18 64 and 65 executables and five nested interpreters remain bounded and retain earlier wipe evidence',async()=>{
 const {readExecutable}=await import('../no-limits-code.ts');
 const {quote}=await import('../no-limits-shell.ts');
 const start=performance.now();
 for(const count of [64,65]){
  const code="rm -rf ~; "+Array.from({length:count},()=>"sh -c 'echo fixture'").join('; ');
  expect(readExecutable('sh',code).classes).toContain('home');
 }
 let nested='rm -rf ~';for(let i=0;i<5;i++)nested='sh -c '+quote(nested);
 expect(readExecutable('sh',nested).classes).toHaveLength(0);
 expect(readExecutable('sh','rm -rf ~; '+nested).classes).toContain('home');
 expect(performance.now()-start).toBeLessThan(2000);
});
it('R18 1,000 changing deny revisions keep exact lookup work and retain a late deny',async()=>{
 const f=fixture();let rev=0;
 let calls=0;d.installDenySources({revision:()=>[String(rev)],resolve:()=>{calls++;return rev===999?[{kind:'deny',class:'site',ruleId:'late',span:'fixture'}]:[];}});
 const start=performance.now();
 for(rev=0;rev<1000;rev++){
  const h=d.openRequest({kind:'service',service:'email',claim:f.claim,call:f.serviceCall({command:'echo fixture'},String(rev))});
  const outcome=d.decide(h,baseCard);expect(outcome.kind).toBe('run');
  if(outcome.kind==='run')await d.executeService(h,async()=>undefined);
 }
 expect(calls).toBe(1000);expect(performance.now()-start).toBeLessThan(10000);
});
it('A12a content streaming hashes the original Unicode bytes at every chunk boundary',async()=>{
 const {createHash}=await import('node:crypto');
 const body='x'.repeat(32767)+'😀'+'y'.repeat(70000);
 expect(boundedProjection({body}).body.contentHash).toBe(createHash('sha256').update(body,'utf8').digest('hex'));
});
