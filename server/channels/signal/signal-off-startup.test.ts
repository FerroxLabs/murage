import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { bootSignalRuntime } from './boot.ts';
import type { RuntimePin } from './types.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';

vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: vi.fn(() => { throw new Error('Signal-off startup must not spawn a child'); }),
}));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); roots.splice(0).forEach(root => removeTempDirSync(root)); });
it('null G0 with no runtime boots silently, stays disabled, and schedules no retry or child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'signal-off-startup-')); roots.push(root);
  vi.useFakeTimers();
  vi.mocked(spawn).mockClear();
  const logs = (['log', 'warn', 'error'] as const).map(level => vi.spyOn(console, level));
  const before = vi.getTimerCount();
  const boot = bootSignalRuntime({ pin: { g0: null } as unknown as RuntimePin,
    moduleUrl: import.meta.url, resourcesPath: root });
  expect(boot.adapters.verified).toBe(false);
  expect(boot.adapters.linkProtocol).toBeUndefined();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(vi.getTimerCount()).toBe(before);
  expect(spawn).not.toHaveBeenCalled();
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});
