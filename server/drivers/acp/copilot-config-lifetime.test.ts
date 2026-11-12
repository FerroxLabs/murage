import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { CopilotAgentDriver } from './copilot.ts';
import { recordEvents } from '../../testing/events.ts';
import { removeTempDir } from '../../testing/cleanup.ts';

it.each(['complete', 'stop', 'delete', 'dispose'] as const)('removes the launch file after confirmed %s teardown', async how => {
  const home = mkdtempSync(join(tmpdir(), 'copilot-lifetime-'));
  const receipt = join(home, 'receipt.jsonl');
  const instance = await CopilotAgentDriver.create({ instanceId: 'lifetime', displayName: 'Fixture', enabled: true,
    environment: { HOME: home, USERPROFILE: home, COPILOT_HOME: home, COPILOT_FIXTURE_RECEIPT: receipt, COPILOT_FIXTURE_HOLD: how === 'complete' ? '0' : '1' },
    config: { cli: `${JSON.stringify(process.execPath)} ${JSON.stringify(resolve('server/testing/fake-copilot-launcher.mjs'))}`, fullAuto: false } });
  const events = recordEvents(instance.adapter);
  try {
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: 'lifetime', text: 'fixture', model: 'auto' });
    await vi.waitFor(() => expect(existsSync(receipt)).toBe(true));
    const path = JSON.parse(readFileSync(receipt, 'utf8').trim()).configPath;
    if (how === 'complete') await events.until(e => e.type === 'turn.completed' && e.turnId === turnId);
    else if (how === 'dispose') await instance.dispose();
    else await instance.adapter.interruptTurn('lifetime', how === 'stop' ? turnId : undefined);
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));
  } finally { events.stop(); await instance.dispose(); await removeTempDir(home); }
});

it('cleans the launch config after a failed executable launch', async () => {
  const before = new Set(readdirSync(tmpdir()));
  const instance = await CopilotAgentDriver.create({ instanceId: 'failed-launch', displayName: 'Fixture', enabled: true, environment: {},
    config: { cli: join(tmpdir(), 'missing-copilot-executable'), fullAuto: false } });
  const events = recordEvents(instance.adapter);
  try {
    try {
      const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: 'failed', text: 'fixture', model: 'auto' });
      await events.until(e => e.type === 'turn.completed' && e.turnId === turnId);
    } catch { /* A synchronous spawn refusal is also a failed launch. */ }
    const directories = readdirSync(tmpdir()).filter(name => name.startsWith('murage-copilot-mcp-') && !before.has(name));
    expect(directories).toHaveLength(1);
    await vi.waitFor(() => expect(readdirSync(join(tmpdir(), directories[0]))).toEqual(['owner.json']));
  } finally { events.stop(); await instance.dispose(); }
});
