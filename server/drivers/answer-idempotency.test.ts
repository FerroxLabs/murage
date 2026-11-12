import { expect, it, vi } from 'vitest';
import { AnswerDelivery } from './answer-delivery.ts';

it('A10a/M62 joins a pending answer; a ten-second retry cannot claim acceptance', async () => {
 vi.useFakeTimers();
 try {
  const ledger = new AnswerDelivery(); let accept!: (v: boolean) => void;
  const transport = vi.fn(() => new Promise<boolean>(resolve => { accept = resolve; }));
  const first = ledger.deliver('g', 'r', 'a', { behavior: 'allow' }, transport);
  await vi.advanceTimersByTimeAsync(10_000);
  let reported = false;
  const retry = ledger.deliver('g', 'r', 'a', { behavior: 'allow' }, transport).then(result => { reported = true; return result; });
  await vi.advanceTimersByTimeAsync(1);
  expect(reported).toBe(false); expect(transport).toHaveBeenCalledTimes(1);
  accept(true); expect(await first).toEqual({ state: 'accepted' }); expect(await retry).toEqual({ state: 'accepted' });
  expect(await ledger.deliver('g', 'r', 'a', { behavior: 'allow' }, transport)).toEqual({ state: 'already' });
  expect(await ledger.deliver('g', 'r', 'different', { behavior: 'deny' }, transport)).toEqual({ state: 'failed' });
  expect(await ledger.deliver('g', 'r', 'a', { behavior: 'deny' }, transport)).toEqual({ state: 'failed' });
  expect(transport).toHaveBeenCalledTimes(1);
 } finally { vi.useRealTimers(); }
});
it('M32 cannot replace an answer or answerId and never replaces identity during retries', async () => {
 const ledger = new AnswerDelivery(); const transport = vi.fn(async () => false);
 expect(await ledger.deliver('g', 'r', 'a', { behavior: 'allow' }, transport)).toEqual({ state: 'failed' });
 expect(await ledger.deliver('g', 'r', 'b', { behavior: 'deny' }, transport)).toEqual({ state: 'failed' });
 expect(await ledger.deliver('g', 'r', 'a', { behavior: 'deny' }, transport)).toEqual({ state: 'failed' });
 await ledger.deliver('g', 'r', 'a', { behavior: 'allow' }, transport);
 await ledger.deliver('g', 'r', 'a', { behavior: 'allow' }, transport);
 expect(transport).toHaveBeenCalledTimes(3);
 expect(await ledger.deliver('new-generation', 'r', 'b', { behavior: 'deny' }, async () => true)).toEqual({ state: 'accepted' });
});
it('retains pending entries and active request tombstones until generation retirement', async () => {
 const ledger = new AnswerDelivery(); let accept!: (v: boolean) => void;
 const transport = vi.fn(() => new Promise<boolean>(resolve => { accept = resolve; }));
 const pending = ledger.deliver('held', 'r', 'a', {}, transport);
 for (let i = 0; i < 1100; i++) { await ledger.deliver(String(i), 'r', 'a', {}, async () => true); ledger.retire(String(i)); }
 const retry = ledger.deliver('held', 'r', 'a', {}, transport);
 expect(transport).toHaveBeenCalledTimes(1); expect(ledger.size).toBeLessThanOrEqual(1025);
 accept(true); await Promise.all([pending, retry]);
});

it('T3f BLOCK5 retired hung transports settle failed and retain bounded state', async () => {
 const ledger = new AnswerDelivery();
 const results: Promise<unknown>[] = [];
 for (let i = 0; i < 2200; i++) {
  results.push(ledger.deliver(String(i), 'r', 'a', {}, () => new Promise(() => {})));
  ledger.retire(String(i));
 }
 expect(ledger.size).toBeLessThanOrEqual(1024);
 expect(await Promise.all(results)).toEqual(Array.from({ length: 2200 }, () => ({ state: 'failed' })));
});

it('T3a delivers 2000 sequential answers in one generation', async()=>{
 const ledger=new AnswerDelivery();
 for(let i=0;i<2000;i++) {
  expect(await ledger.deliver('g',String(i),'a',{},async()=>true),`answer ${i}`).toEqual({state:'accepted'});
  (ledger as unknown as {close?:(g:string,r:string)=>void}).close?.('g',String(i));
 }
 expect(ledger.size).toBeLessThanOrEqual(1024);
 for(let i=0;i<600;i++) expect(await ledger.deliver('open',String(i),'a',{},async()=>true)).toEqual({state:'accepted'});
});
it('T3c open accepted X survives 5000 other closures; terminal retention is bounded',async()=>{
 const ledger=new AnswerDelivery(), send=vi.fn(async()=>true);
 await ledger.deliver('g','X','a',{},send);
 for(let i=0;i<5000;i++) {expect(await ledger.deliver('g',String(i),'a',{},async()=>true)).toEqual({state:'accepted'});(ledger as unknown as {close?:(g:string,r:string)=>void}).close?.('g',String(i));}
 expect(await ledger.deliver('g','X','a',{},send)).toEqual({state:'already'});
 expect(send).toHaveBeenCalledTimes(1);expect(ledger.size).toBeLessThanOrEqual(1025);
});
it('T3d failed open delivery can retry beyond two attempts',async()=>{
 const ledger=new AnswerDelivery();let attempts=0;const send=vi.fn(async()=>++attempts>=3);
 expect(await ledger.deliver('g','r','a',{},send)).toEqual({state:'failed'});
 expect(await ledger.deliver('g','r','a',{},send)).toEqual({state:'failed'});
 expect(await ledger.deliver('g','r','a',{},send)).toEqual({state:'accepted'});
 expect(send).toHaveBeenCalledTimes(3);
});
