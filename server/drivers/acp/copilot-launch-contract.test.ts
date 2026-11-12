import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { CopilotAgentDriver, copilotSupport } from './copilot.ts';
import { recordEvents } from '../../testing/events.ts';
import { removeTempDir } from '../../testing/cleanup.ts';
it('omits client MCP servers on new and load in unpooled Copilot launches', async () => {
  const home = mkdtempSync(join(tmpdir(), 'copilot-launch-contract-'));
  const receipt = join(home, 'receipt.jsonl');
  const instance = await CopilotAgentDriver.create({ instanceId: 'copilot-fixture', displayName: 'Copilot fixture', enabled: true,
    environment: { HOME: home, USERPROFILE: home, COPILOT_HOME: home, COPILOT_FIXTURE_RECEIPT: receipt },
    config: { cli: `${JSON.stringify(process.execPath)} ${JSON.stringify(resolve('server/testing/fake-copilot-launcher.mjs'))}`, fullAuto: false } });
  const events = recordEvents(instance.adapter);
  try {
    for (const revision of ['first', 'refreshed']) {
      const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: 'same-thread', resumeCursor: revision === 'first' ? undefined : 'fixture-session', text: 'synthetic', model: 'auto',
        integrations: { agents: { command: 'node', args: ['unused-fixture-proxy'], env: { FIXTURE_REVISION: revision } } } });
      const ended = await events.until(e => e.type === 'turn.completed' && e.turnId === turnId);
      const errors = events.events.filter(e => e.type === 'runtime.error' && e.turnId === turnId);
      expect(ended, JSON.stringify(errors)).toMatchObject({ ok: true });
    }
    const rows = readFileSync(receipt, 'utf8').trim().split('\n').map(s => JSON.parse(s));
    expect(rows.map(r => r.names)).toEqual([['agents'], ['agents']]);
    expect(rows.map(r => r.sessionMethod)).toEqual(['session/new', 'session/load']);
    expect(rows.map(r => r.sessionId)).toEqual(['fixture-session', 'fixture-session']);
    expect(rows.map(r => r.marker)).toEqual(['first', 'refreshed']);
    expect(rows[0].pid).not.toBe(rows[1].pid);
  } finally { events.stop(); await instance.dispose(); await removeTempDir(home); }
});

it('fingerprints scoped launch credentials independently of unpooled Copilot processes', async () => {
  const { acpMcpSpawnFingerprint } = await import('./core.ts');
  expect(copilotSupport.pooledSessions).not.toBe(true);
  const servers = (value: string) => [{ name: 'computer', command: 'node', args: ['proxy'], env: [{ name: 'TOKEN', value }] }];
  const first = acpMcpSpawnFingerprint(copilotSupport, servers('first'));
  expect(first).toHaveLength(1);
  expect(first).toEqual(acpMcpSpawnFingerprint(copilotSupport, servers('first')));
  expect(first).not.toEqual(acpMcpSpawnFingerprint(copilotSupport, servers('refreshed')));
  expect(first.join('')).not.toContain('first');
});
