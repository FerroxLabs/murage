import { expect, it, vi } from 'vitest';
import { closeKnownDaemon } from './browser-daemon-close.ts';
it('T25 judges identity before every POSIX signal and never signals a reused or unknown pid', async () => {
  for (const verdict of ['gone', 'unknown'] as const) {
    const signal = vi.fn(); const close = vi.fn(async () => { throw new Error('timeout'); });
    const operation = closeKnownDaemon({ close, judge: async () => verdict, signal, wait: async () => {} });
    if (verdict === 'gone') await operation; else await expect(operation).rejects.toThrow('timeout');
    expect(signal).not.toHaveBeenCalled();
  }
});
it('T25 a kill path succeeds only after verified disappearance', async () => {
  const order: string[] = []; let verdict: 'alive' | 'gone' = 'alive';
  await closeKnownDaemon({ close: async () => { throw new Error('timeout'); }, judge: async () => { order.push('judge'); return verdict; }, signal: signal => { order.push(signal); verdict = 'gone'; }, wait: async () => {} });
  expect(order.indexOf('judge')).toBeLessThan(order.indexOf('SIGTERM'));
  await expect(closeKnownDaemon({ close: async () => { throw new Error('timeout'); }, judge: async () => 'alive', signal: () => {}, wait: async () => {}, rounds: 1 })).rejects.toThrow('still running');
});
it('T23 a socket acknowledgement needs no process signal; unknown socket timeout stays refused', async () => {
  const signal = vi.fn();
  await closeKnownDaemon({ close: async () => {}, judge: async () => 'unknown', signal, wait: async () => {} });
  expect(signal).not.toHaveBeenCalled();
  await expect(closeKnownDaemon({ close: async () => { throw new Error('timeout'); }, judge: async () => 'unknown', signal, wait: async () => {} })).rejects.toThrow('timeout');
});
