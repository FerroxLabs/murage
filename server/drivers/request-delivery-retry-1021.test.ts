// SPDX-License-Identifier: AGPL-3.0-or-later
// 1021 Retry (RETRY-DESIGN-r2 D3, step 5): the driver's open map is the proof the engine still holds the ask. canRedeliver is
// true only for an open, unresolved, undelivered ask in the live generation; rearmRetry closes the failed answer slot (which
// refuses any new answerId) and opens a fresh one, so the retried answer reaches the native adapter exactly once.
import { expect, it } from 'vitest';
import type { ProviderInstance, RuntimeEvent } from '../contracts.ts';
import * as delivery from './request-delivery.ts';
import { RequestTransport } from './request-transport.ts';

function fixture() {
 const listeners = new Set<(e: RuntimeEvent) => void>(), transport = new RequestTransport();
 const calls: string[] = [];
 let accept = false;
 const instance = delivery.withRequestDelivery({ instanceId: 'retry', driverKind: 'fake', adapter: {
  onEvent: (f: any) => { listeners.add(f); return () => listeners.delete(f); },
  respondToRequest: async (t: string, r: string) => { calls.push(r); transport.confirm(t, r, Promise.resolve(accept)); return accept ? 'allowed-once' : 'unavailable'; },
  interruptTurn: async () => {},
 }, dispose: async () => {} } as unknown as ProviderInstance, transport);
 const emit = (type: string, fields: Record<string, unknown>) => { for (const f of listeners) f({ type, threadId: 't', ...fields } as RuntimeEvent); };
 return { instance, emit, calls, setAccept: (v: boolean) => { accept = v; }, strict: () => instance.decisionAdapter! };
}

it('a failed delivery on a still-open ask can be re-armed once; the fresh answerId reaches the engine and is accepted', async () => {
 const f = fixture(); f.emit('turn.started', { turnId: 'g' }); f.emit('request.opened', { turnId: 'g', requestId: 'r' });
 expect(await f.strict().respondToRequest('t', 'r', { behavior: 'allow' }, { answerId: 'first' })).toEqual({ state: 'failed' });
 await Promise.resolve();
 expect(f.calls).toEqual(['r']);
 // without a re-arm the old slot refuses the new identity and the engine is never written
 expect(await f.strict().respondToRequest('t', 'r', { behavior: 'allow' }, { answerId: 'second' })).toEqual({ state: 'failed' });
 expect(f.calls).toEqual(['r']);
 expect(f.strict().canRedeliver!('t', 'r')).toBe(true);
 expect(f.strict().rearmRetry!('t', 'r')).toBe(true);
 f.setAccept(true);
 expect(await f.strict().respondToRequest('t', 'r', { behavior: 'allow' }, { answerId: 'second' })).toEqual({ state: 'accepted' });
 expect(f.calls).toEqual(['r', 'r']);
 // accepted: nothing left to redeliver
 expect(f.strict().canRedeliver!('t', 'r')).toBe(false);
 expect(f.strict().rearmRetry!('t', 'r')).toBe(false);
 await f.instance.dispose();
});

it('a new provider turn, a resolved ask or a closed ask is never redeliverable', async () => {
 const f = fixture(); f.emit('turn.started', { turnId: 'g' }); f.emit('request.opened', { turnId: 'g', requestId: 'r' });
 await f.strict().respondToRequest('t', 'r', { behavior: 'allow' }, { answerId: 'first' });
 await Promise.resolve();
 expect(f.strict().canRedeliver!('t', 'r')).toBe(true);
 // the generation moved on while the old entry is still in the map: the ask belongs to a turn that is gone
 f.emit('turn.started', { turnId: 'g2' });
 expect(f.strict().canRedeliver!('t', 'r')).toBe(false);
 expect(f.strict().rearmRetry!('t', 'r')).toBe(false);
 f.emit('request.opened', { turnId: 'g2', requestId: 'q' });
 expect(f.strict().canRedeliver!('t', 'q')).toBe(true);
 f.emit('request.resolved', { turnId: 'g2', requestId: 'q' });
 expect(f.strict().canRedeliver!('t', 'q')).toBe(false);
 expect(f.strict().canRedeliver!('t', 'never')).toBe(false);
 await f.instance.dispose();
});

it('the generation compare refuses an ask opened under a turn id that is not the thread\'s live generation', async () => {
 const f = fixture(); f.emit('turn.started', { turnId: 'g' });
 // an ask carried with an older provider turn id stays in the map, but the thread's live generation is another turn
 f.emit('request.opened', { turnId: 'stale', requestId: 'r' });
 await f.strict().respondToRequest('t', 'r', { behavior: 'allow' }, { answerId: 'first' });
 await Promise.resolve();
 expect(f.strict().canRedeliver!('t', 'r')).toBe(false);
 expect(f.strict().rearmRetry!('t', 'r')).toBe(false);
 await f.instance.dispose();
});
