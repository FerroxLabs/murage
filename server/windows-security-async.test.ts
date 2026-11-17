// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'vitest';
import { defaultAsyncSecurityRunner } from './channels/signal/windows-security-runner.ts';

test('M3 a hung native child times out while the server event loop keeps running', async () => {
  let heartbeats = 0;
  const timer = setInterval(() => { heartbeats++; }, 5);
  try {
    await expect(defaultAsyncSecurityRunner(process.execPath, ['-e','setInterval(() => {}, 1000)'], {env:process.env,timeout:200})).rejects.toThrow();
    expect(heartbeats).toBeGreaterThan(0);
  } finally { clearInterval(timer); }
});
test('async native work delivers stdin and a successful result', async () => {
  const output = await defaultAsyncSecurityRunner(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {env:process.env,input:'fixture',timeout:5_000});
  expect(output).toBe('fixture');
});
