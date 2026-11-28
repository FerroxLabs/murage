// SPDX-License-Identifier: AGPL-3.0-or-later
// 1024 hygiene (TRAIN-1024 S09, N9). A failed engine card that offers "Send again" is bounded: when the offer is never taken it
// closes on its own (read-only card, one text row, attention settled) instead of staying open for ever. Real decision layer and
// records; only the engine transport is faked. Also: the PATH check logs only when it found something missing.
import {afterEach,expect,it,vi} from 'vitest';
import {fixture,d,baseCard,card} from './fixture.ts';
import {pathMissingLine} from '../drivers/murage-exec.ts';
import {PERMISSION_UNDELIVERED_STOP_REASON} from './host-stop-interrupt.ts';

const FAILED='The tool permission could not be delivered. Nothing was confirmed.';
const OFFER_BOUND_MS=10*60_000;
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

type Fixture=ReturnType<typeof fixture>;
const cardOf=(f:Fixture,ref:d.ApprovalRef)=>f.store.messageById('t',d.readApproval(ref.approvalId)!.chatMessageId)!.card!;
const failedRows=(f:Fixture)=>f.store.messagesFor('t').filter(m=>m.kind==='text'&&m.text===FAILED);
const stopFailed=()=>Object.assign(new Error('stop-failed'),{stopFailed:true});

async function offeredCard(){
 vi.useFakeTimers();
 const f=fixture('ask');
 d.installDecisionTransport({respond:f.respond,interrupt:f.interrupt,canRedeliver:()=>true,rearmRetry:()=>true});
 const ref=card(d.decide(f.open('asked',undefined,undefined),baseCard));
 await d.presentApproval(ref,{title:'Action',subtitle:'Fixture'});
 f.respond.mockResolvedValueOnce({state:'failed'});
 f.interrupt.mockRejectedValueOnce(stopFailed());
 await d.answerApproval(ref,{behavior:'allow'}).catch(()=>{});
 return {f,ref};
}

it('H1 a Send again offer nobody takes closes after the bound: read-only card, one failure row, never offered again',async()=>{
 const {f,ref}=await offeredCard();
 expect(cardOf(f,ref).deliveryRetry).toBe('offered');
 const interruptsBefore=f.interrupt.mock.calls.length;
 await vi.advanceTimersByTimeAsync(OFFER_BOUND_MS-1000);
 expect(cardOf(f,ref).deliveryRetry).toBe('offered');
 expect(f.interrupt).toHaveBeenCalledTimes(interruptsBefore);
 expect(failedRows(f)).toEqual([]);
 await vi.advanceTimersByTimeAsync(2000);
 expect(cardOf(f,ref).deliveryRetry).toBeUndefined();
 expect(failedRows(f)).toHaveLength(1);
 // the ask was still live: closing the offer stops it, so the turn never waits on a card nobody can answer
 expect(f.interrupt).toHaveBeenCalledTimes(interruptsBefore+1);
 expect(await d.retryDelivery(ref)).toBe('delivery_failed_terminal');
 expect(f.respond).toHaveBeenCalledTimes(1);
 f.dispose();
});

it('H4 a retry that fails and is offered again gets its own full bound; the first timer does not close it early',async()=>{
 const {f,ref}=await offeredCard();
 await vi.advanceTimersByTimeAsync(OFFER_BOUND_MS-60_000);
 f.respond.mockResolvedValueOnce({state:'failed'});f.interrupt.mockRejectedValueOnce(stopFailed());
 expect(await d.retryDelivery(ref)).toBe('delivery_retry');
 await vi.advanceTimersByTimeAsync(120_000);
 expect(cardOf(f,ref).deliveryRetry).toBe('offered');
 expect(failedRows(f)).toEqual([]);
 await vi.advanceTimersByTimeAsync(OFFER_BOUND_MS);
 expect(cardOf(f,ref).deliveryRetry).toBeUndefined();
 expect(failedRows(f)).toHaveLength(1);
 f.dispose();
});

it('H5 a refused card write at the bound still stops the live ask',async()=>{
 const {f,ref}=await offeredCard();
 const before=f.interrupt.mock.calls.length;
 vi.spyOn(f.store,'patchMessagePoint').mockImplementation(()=>{throw new Error('write refused');});
 await vi.advanceTimersByTimeAsync(OFFER_BOUND_MS+1000);
 expect(f.interrupt).toHaveBeenCalledTimes(before+1);
 // q1024-weakfix: the stop is aimed at THIS ask (its thread, turn and request) with the host's own reason, not just "an interrupt happened"
 const [target,reason]=f.interrupt.mock.calls[before]! as unknown as [Record<string,string>,string];
 expect(target).toMatchObject({providerInstanceId:'p',threadId:'t',generation:'g',turnId:'turn',requestId:'asked'});
 expect(reason).toBe(PERMISSION_UNDELIVERED_STOP_REASON);
 // the refused write left the offer standing, and nothing stops it twice: the ask is stopped once, at the bound
 expect(cardOf(f,ref).deliveryRetry).toBe('offered');
 await vi.advanceTimersByTimeAsync(OFFER_BOUND_MS);
 expect(f.interrupt).toHaveBeenCalledTimes(before+1);
 f.dispose();
});

it('H2 a retry taken inside the bound is not closed by the bound',async()=>{
 const {f,ref}=await offeredCard();
 f.respond.mockResolvedValueOnce({state:'accepted'});
 expect(await d.retryDelivery(ref)).toBe('accepted');
 await vi.advanceTimersByTimeAsync(OFFER_BOUND_MS*2);
 expect(cardOf(f,ref).answered).toBe('Allowed');
 expect(failedRows(f)).toEqual([]);
 f.dispose();
});

it('H3a the PATH check says nothing when no entry is missing, and one value-free line when some are',()=>{
 expect(pathMissingLine('thread-1',0)).toBeNull();
 expect(pathMissingLine('thread-1',null)).toBeNull();
 expect(pathMissingLine('thread-1',2)).toBe('claude exec path-missing thread=thread-1 entries=2');
});
