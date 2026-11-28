// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.24 q1024-sweep1 (Astra 7472 High on fix/1023-livebrowser 2cee5f4629, server/browser-control.ts:418,457; owner: q1024-sweep1). A refusal saved before its
// reason was kept (closeRefused unset) is retried unattended by a server shutdown or a profile forget. A retry that fails again must not save that guess as
// deliberate: the owner's next Restart, with the session files gone, clears it (W3 of browser-close-bound-1023). Each row enters through the production
// UnifiedBrowserController on a state file written by the previous version, then a second controller reads the file the first one saved.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { UnifiedBrowserController } from './browser-control.ts';

const legacyState = (stateFile: string, socketDir: string) => writeFileSync(stateFile, JSON.stringify([['key', { generation: 1, held: false, owner: null, protectedDocument: false, protectedReason: null,
  closeFailed: true, closeTarget: { botId: 'bot', command: '/fixture/no-engine', socketDir, session: 'session' } }]]));
const saved = (stateFile: string) => (JSON.parse(readFileSync(stateFile, 'utf8')) as Array<[string, { closeRefused?: boolean; closeFailed?: boolean }]>)[0]![1];
const restartOutcome = (controller: UnifiedBrowserController) => controller.restart('key', 'owner').then(() => 'restarted', (error: { code?: string }) => error.code ?? 'error');

it('W12 forgetting a profile that fails again keeps a legacy refusal legacy: the saved file has no deliberate mark and the owner Restart clears it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-refusal-')), stateFile = join(dir, 'control.json'); legacyState(stateFile, dir);
  const first = new UnifiedBrowserController({ stateFile });
  expect(await first.forgetEntry('key').then(() => 'forgotten', (error: { code?: string }) => error.code ?? 'error')).toBe('browser_close_failed');
  expect(saved(stateFile).closeFailed).toBe(true);
  expect(saved(stateFile).closeRefused, 'the forget retry did not write a guess down as deliberate').not.toBe(true);
  const second = new UnifiedBrowserController({ stateFile });
  expect(await restartOutcome(second), 'the owner Restart clears it').toBe('restarted');
}, 30_000);

it('W13 shutting the server down on a legacy refusal keeps it legacy: the saved file has no deliberate mark and the owner Restart clears it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-refusal-')), stateFile = join(dir, 'control.json'); legacyState(stateFile, dir);
  const first = new UnifiedBrowserController({ stateFile });
  await first.close();
  expect(saved(stateFile).closeFailed).toBe(true);
  expect(saved(stateFile).closeRefused, 'the shutdown retry did not write a guess down as deliberate').not.toBe(true);
  const second = new UnifiedBrowserController({ stateFile });
  expect(await restartOutcome(second), 'the owner Restart clears it').toBe('restarted');
}, 30_000);

it('W14 a refusal that was deliberate stays deliberate through a forget retry (the owner Restart still fails closed)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-refusal-')), stateFile = join(dir, 'control.json'); legacyState(stateFile, dir);
  const raw = JSON.parse(readFileSync(stateFile, 'utf8')); raw[0][1].closeRefused = true; writeFileSync(stateFile, JSON.stringify(raw));
  const first = new UnifiedBrowserController({ stateFile });
  expect(await first.forgetEntry('key').then(() => 'forgotten', (error: { code?: string }) => error.code ?? 'error')).toBe('browser_close_failed');
  expect(saved(stateFile).closeRefused).toBe(true);
  const second = new UnifiedBrowserController({ stateFile });
  expect(await restartOutcome(second), 'the owner Restart still fails closed on a deliberate refusal').not.toBe('restarted');
}, 30_000);
