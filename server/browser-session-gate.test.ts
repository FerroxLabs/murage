import { describe, expect, it } from 'vitest';
import { SessionGate, assertGateToken } from './browser-session-gate.ts';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
describe('S134 session gate', () => {
  it('T8/M40s orders opposite key sets and removes idle mutexes', async () => {
    const gate = new SessionGate();
    for (let i = 0; i < 100; i++) {
      let active = 0;
      await Promise.all([['b', 'a'], ['a', 'b']].map(keys => gate.run(keys, async token => {
        assertGateToken(token, 'a'); assertGateToken(token, 'b');
        expect(++active).toBe(1); await Promise.resolve(); active--;
      })));
    }
    expect(gate.size).toBe(0);
  });
  it('T9/M47s refuses reentry, foreign keys and expired or forged tokens', async () => {
    const gate = new SessionGate(); let saved: unknown;
    await gate.run(['a'], async token => {
      saved = token; assertGateToken(token, 'a');
      expect(() => assertGateToken(token, 'b')).toThrow('gate_token');
      await expect(gate.run(['a'], async () => {})).rejects.toThrow('gate_reentry');
    });
    expect(() => assertGateToken(saved, 'a')).toThrow('gate_token');
    expect(() => assertGateToken({ keys: ['a'], live: true }, 'a')).toThrow('gate_token');
  });
  it('T6 serializes a hold and a selection write without keeping unrelated keys waiting', async () => {
    const gate = new SessionGate(), wait = deferred(), entered = deferred(); const order: string[] = [];
    const hold = gate.run(['a'], async () => { order.push('hold'); entered.resolve(); await wait.promise; });
    await entered.promise;
    const commit = gate.run(['a'], async () => { order.push('commit'); });
    await gate.run(['b'], async () => { order.push('other'); });
    expect(order).toEqual(['hold', 'other']); wait.resolve(); await Promise.all([hold, commit]);
    expect(order).toEqual(['hold', 'other', 'commit']);
  });
});
it('callbacks created by a finished gate may acquire that key again', async () => {
  const gate = new SessionGate(), wake = deferred(); let continuation!: Promise<void>;
  await gate.run(['a'], async () => {
    continuation = wake.promise.then(() => gate.run(['a'], async () => {}));
  });
  wake.resolve(); await expect(continuation).resolves.toBeUndefined();
});
