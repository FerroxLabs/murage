// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createFixtureAcpDriver as createAcpDriver } from '../../testing/acp-support-fixture.ts';
import { ensureDirs } from '../../config.ts';
import { fixtureBotFolder } from '../../testing/bot-folder-fixture.ts';
import { recordEvents } from '../../testing/events.ts';

it('one stdout write keeps text before a tool, drops the failed retry text, and retains the tool row', async () => {
  ensureDirs();
  const cli = fileURLToPath(new URL('../../testing/fake-acp-cli.ts', import.meta.url));
  chmodSync(cli, 0o755);
  const driver = createAcpDriver({ driverKind: 'retryOrderTest', fluxReach: () => 'elsewhere' as const, displayName: 'Retry order fixture', nativeSource: 'fuigo.acp',
    models: { default: 'm-one', options: [{ id: 'm-one', label: 'One' }] }, defaultCli: cli, loginNote: 'Fixture only',
    spawnArgs: () => [], pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true });
  const instance = await driver.create({ instanceId: 'retry-order', enabled: true, displayName: 'Fixture',
    config: { cli, fullAuto: false }, environment: { FAKE_ACP_MODE: 'fuigo-retry:tool-batch' } });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: 'retry-order-thread', text: 'Fixture only', cwd: fixtureBotFolder() });
    expect(await recorder.until(event => event.type === 'turn.completed')).toMatchObject({ ok: true });
    const text = recorder.events.flatMap(event => event.type === 'item.completed' && event.itemType === 'assistant_text' ? [event.text] : []).join('');
    expect(text).toBe('Before. Final answer.');
    expect(text).not.toContain('After one.');
    expect(recorder.events.filter(event => event.type === 'item.completed' && event.itemType === 'tool')).toHaveLength(1);
  } finally {
    if (process.env.SC_MAIL_ORDER_EVIDENCE) {
      mkdirSync(process.env.SC_MAIL_ORDER_EVIDENCE, { recursive: true });
      writeFileSync(process.env.SC_MAIL_ORDER_EVIDENCE + '/events.json', JSON.stringify(recorder.events, null, 2));
    }
    recorder.stop(); await instance.dispose();
  }
});
