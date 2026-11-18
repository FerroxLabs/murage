// SPDX-License-Identifier: AGPL-3.0-or-later
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { DurableDelivery } from './durable-delivery.ts';
import { fault, writeV1 } from './delivery-ledger-test-support.ts';

// W-WIN: the ledger no longer needs the Windows directory-flush addon at all. The addon is made to FAIL here: every commit, resend, drain and the v1 retirement must still work.
const win = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), platform: () => 'win32' }));
vi.mock('../engine-exclusion.ts', async original => ({ ...await original<typeof import('../engine-exclusion.ts')>(), requireWindowsAddon: () => { win.calls++; throw new Error('windows addon unavailable'); } }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) removeTempDirSync(root); });

it.each(['none', 'commit-fault'] as const)('Windows receipt commits need no directory-flush addon and survive a failed commit (%s)', async failure => {
  const root = fs.mkdtempSync(join(tmpdir(), 'murage-receipt-crash-')); roots.push(root);
  const file = join(root, 'ledger.json');
  const sent: string[] = [];
  const options = { file, bindingKey: 'binding', recipient: 'owner', maxResponse: 20000, isCurrent: () => true,
    runs: { enqueue: () => ({ id: 'run' }), result: () => ({ status: 'completed', output: 'answer' }) },
    send: async (input: { text: string }) => { sent.push(input.text); return { recipient: 'owner', messageId: 'message' }; }, now: () => 1000 };
  writeV1(file, { version: 1, bindingKey: 'binding', recipient: 'owner', tombstones: [], records:
    Array.from({ length: 110 }, (_, i) => ({ deliveryId: `old-${i}`, prompt: 'fixture', occurredAt: 1000, state: 'uncertain' as const, attempts: 1, response: 'x'.repeat(20000) })) });
  DurableDelivery.consolidate(options, [], id => id, 1000);
  const ledger = new DurableDelivery(options);
  const undo = failure === 'commit-fault' ? fault(file, 'UPDATE', 'published flush failed') : () => {};
  if (failure === 'none') expect(ledger.resend('old-0')).toBe('resent');
  else expect(() => ledger.resend('old-0')).toThrow('published flush failed');
  undo();
  const recovered = new DurableDelivery(options);
  expect(recovered.resend('old-0')).toBe(failure === 'none' ? 'already' : 'resent');
  await recovered.drain();
  expect(sent).toEqual(['x'.repeat(20000)]);
  expect((await recovered.sweepPages()).failed).toBe(0);
  expect(win.calls).toBe(0);
  recovered.stop(); ledger.stop();
});

it('the Windows native directory handle requests write access, backup semantics and refuses reparse points', () => {
  const source=fs.readFileSync(new URL('../../native/engine-exclusion/exclusion.c',import.meta.url),'utf8');
  const open=source.slice(source.indexOf('static napi_value open_file('),source.indexOf('static napi_value handle_read('));
  expect(open).toContain('kind < 0 || kind > 4');
  expect(open).toContain('GENERIC_READ | GENERIC_WRITE');
  expect(open).toContain('kind == 4 ? (FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)');
  expect(open).toMatch(/kind == 4[\s\S]*GetFileInformationByHandle[\s\S]*FILE_ATTRIBUTE_DIRECTORY[\s\S]*FILE_ATTRIBUTE_REPARSE_POINT[\s\S]*CloseHandle\(handle\)/);
});
