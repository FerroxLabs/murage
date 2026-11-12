import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createAcpDriver } from './core.ts';
import { CustomAcpDriver } from './custom.ts';
import { recordEvents } from '../../testing/events.ts';
import { removeTempDir } from '../../testing/cleanup.ts';
it('pins each bots native model and thinking before prompting an isolated CLI', async () => {
  const home = mkdtempSync(join(tmpdir(), 'murage-custom-selection-'));
  const instance = await CustomAcpDriver.create({ instanceId: 'custom-fixture', displayName: 'Fixture', enabled: true,
    environment: { HOME: home, USERPROFILE: home, FAKE_CUSTOM_ACP_DIRECTORY: home },
    config: { cli: `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(resolve('server/testing/fake-custom-acp-models.ts'))}`, fullAuto: false } });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.refreshModels?.();
    expect(instance.models.options.find(m => m.id === 'glm-5.3-flash')?.variants?.map(v => v.id)).toEqual(['medium', 'high']);
    for (const [threadId, model, variant] of [['one', 'glm-5.3', 'max'], ['two', 'glm-5.3-flash', 'high']]) {
      const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text: 'ACP_PICKER_CHECK', model, variant });
      await recorder.until(e => e.type === 'turn.completed' && e.turnId === turnId);
    }
    const prompts = readFileSync(join(home, 'receipts.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s)).filter(r => r.method === 'session/prompt');
    expect(prompts.map(r => [r.model, r.variant])).toEqual([['glm-5.3', 'max'], ['glm-5.3-flash', 'high']]);
    expect(recorder.events.filter(e => e.type === 'runtime.error')).toEqual([]);
  } finally { recorder.stop(); await instance.dispose(); removeTempDir(home); }
});

it('processes a load response and thinking update in one stdout write', async () => {
  const home = mkdtempSync(join(tmpdir(), 'murage-custom-load-'));
  const instance = await CustomAcpDriver.create({ instanceId: 'load-fixture', displayName: 'Fixture', enabled: true,
    environment: { HOME: home, USERPROFILE: home, FAKE_CUSTOM_ACP_DIRECTORY: home, FAKE_CUSTOM_LOAD_UPDATE: '1' },
    config: { cli: `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(resolve('server/testing/fake-custom-acp-models.ts'))}`, fullAuto: false } });
  const recorder = recordEvents(instance.adapter);
  try {
    const first = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: 'load-thread', text: 'ACP_PICKER_FIRST', model: 'glm-5.3', variant: 'low' });
    expect(await recorder.until(e => e.type === 'turn.completed' && e.turnId === first.turnId), JSON.stringify(recorder.events.filter(e => e.type === 'runtime.error'))).toMatchObject({ ok: true });
    const rows = () => readFileSync(join(home, 'receipts.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
    const cursor = rows().find(r => r.method === 'session/prompt').sessionId;
    const second = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: 'load-thread', resumeCursor: cursor, text: 'ACP_PICKER_SECOND', model: 'glm-5.3', variant: 'low' });
    expect(await recorder.until(e => e.type === 'turn.completed' && e.turnId === second.turnId)).toMatchObject({ ok: true });
    expect(rows().filter(r => r.method === 'session/load')).toHaveLength(1);
    expect(rows().filter(r => r.method === 'session/prompt').map(r => r.variant)).toEqual(['low', 'low']);
    expect(rows().some(r => r.method === 'session/set_config_option' && r.configId === 'thinking' && r.value === 'low')).toBe(true);
  } finally { recorder.stop(); await instance.dispose(); await removeTempDir(home); }
});

it.each([false, true])('restores engine-default thinking on a resumed conversation, including restart (unknown default: %s)', async unknown => {
  const home = mkdtempSync(join(tmpdir(), 'murage-custom-default-'));
  const create = () => CustomAcpDriver.create({ instanceId: 'default-fixture', displayName: 'Fixture', enabled: true,
    environment: { HOME: home, USERPROFILE: home, FAKE_CUSTOM_ACP_DIRECTORY: home, ...(unknown ? { FAKE_CUSTOM_NO_DEFAULT: '1' } : {}) },
    config: { cli: `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(resolve('server/testing/fake-custom-acp-models.ts'))}`, fullAuto: false } });
  let instance = await create();
  let recorder = recordEvents(instance.adapter);
  let cursor: string | undefined;
  const rows = () => readFileSync(join(home, 'receipts.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
  const send = async (variant?: string) => {
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: 'default-thread', resumeCursor: cursor, text: 'ACP_PICKER_DEFAULT', model: 'glm-5.3', variant });
    expect(await recorder.until(e => e.type === 'turn.completed' && e.turnId === turnId)).toMatchObject({ ok: true });
    cursor = rows().filter(r => r.method === 'session/prompt').at(-1).sessionId;
  };
  try {
    await send('max');
    await send();
    await send('max');
    recorder.stop(); await instance.dispose();
    instance = await create(); recorder = recordEvents(instance.adapter);
    await send();
    expect(rows().filter(r => r.method === 'session/prompt').map(r => r.variant)).toEqual(['max', 'low', 'max', 'low']);
    expect(rows().filter(r => r.method === 'session/load')).toHaveLength(3);
    const ids = rows().filter(r => r.method === 'session/prompt').map(r => r.sessionId);
    expect(new Set(ids).size).toBe(unknown ? 3 : 1);
  } finally { recorder.stop(); await instance.dispose(); await removeTempDir(home); }
});

it('binds the fallback owner before a notification in the same stdout write', async () => {
  const home = mkdtempSync(join(tmpdir(), 'murage-custom-fallback-owner-'));
  const instance = await CustomAcpDriver.create({ instanceId: 'fallback-owner-fixture', displayName: 'Fixture', enabled: true,
    environment: { HOME: home, USERPROFILE: home, FAKE_CUSTOM_ACP_DIRECTORY: home, FAKE_CUSTOM_NO_DEFAULT: '1', FAKE_CUSTOM_NEW_UPDATE: '1' },
    config: { cli: JSON.stringify(process.execPath) + ' --experimental-strip-types ' + JSON.stringify(resolve('server/testing/fake-custom-acp-models.ts')), fullAuto: false } });
  const recorder = recordEvents(instance.adapter);
  try {
    const first = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: 'fallback-owner-thread', text: 'ACP_PICKER_FIRST', model: 'glm-5.3', variant: 'max' });
    expect(await recorder.until(e => e.type === 'turn.completed' && e.turnId === first.turnId), JSON.stringify(recorder.events.filter(e => e.type === 'runtime.error'))).toMatchObject({ ok: true });
    const rows = () => readFileSync(join(home, 'receipts.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
    const cursor = rows().find(r => r.method === 'session/prompt').sessionId;
    const second = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: 'fallback-owner-thread', resumeCursor: cursor, text: 'ACP_PICKER_SECOND', model: 'glm-5.3' });
    expect(await recorder.until(e => e.type === 'turn.completed' && e.turnId === second.turnId)).toMatchObject({ ok: true });
    expect(rows().filter(r => r.method === 'session/new')).toHaveLength(2);
    expect(JSON.stringify(recorder.events.filter(e => 'turnId' in e && e.turnId === second.turnId))).toContain('ACP_FALLBACK_ONE_WRITE');
  } finally { recorder.stop(); await instance.dispose(); await removeTempDir(home); }
});


it('checks late thinking updates before releasing the submission boundary', async () => {
  const home = mkdtempSync(join(tmpdir(), 'murage-custom-submit-'));
  const beforeSubmit = vi.fn();
  const driver = createAcpDriver({
    driverKind: 'customAcp', displayName: 'Boundary fixture', nativeSource: 'fixture.acp',
    defaultCli: '', models: { default: 'glm-5.3', options: [{ id: 'glm-5.3', label: 'Fixture' }] },
    modelVariants: true, selectModel: { configId: 'model' }, spawnArgs: () => [],
    isAuthenticated: () => true, pickAuthMethod: () => null, authFailure: 'continue', loginNote: 'Fixture',
    configureSession: async ({ request, sessionId }) => {
      await request('fixture/change_thinking', { sessionId, value: 'max' });
    },
  });
  const instance = await driver.create({ instanceId: 'submit-fixture', displayName: 'Fixture', enabled: true,
    environment: { HOME: home, USERPROFILE: home, FAKE_CUSTOM_ACP_DIRECTORY: home },
    config: { cli: `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(resolve('server/testing/fake-custom-acp-models.ts'))}`, fullAuto: false } });
  const events = recordEvents(instance.adapter);
  try {
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: 'submit-boundary',
      text: 'ACP_PICKER_SUBMIT', model: 'glm-5.3', variant: 'low', beforeSubmit });
    const ended = await events.until(e => e.type === 'turn.completed' && e.turnId === turnId);
    expect(beforeSubmit).not.toHaveBeenCalled();
    expect(ended).toMatchObject({ ok: false });
    const rows = readFileSync(join(home, 'receipts.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
    expect(rows.filter(r => r.method === 'session/prompt')).toEqual([]);
  } finally { events.stop(); await instance.dispose(); await removeTempDir(home); }
});
