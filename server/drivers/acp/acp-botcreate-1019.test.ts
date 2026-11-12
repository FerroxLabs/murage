import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createAcpDriver, setAcpOutsideHooks, type AcpConfig } from './core.ts';
import type { ProviderDriver, ProviderInstance } from '../../contracts.ts';
import { recordEvents } from '../../testing/events.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import { beginOutsideTurn, forgetOutsideState, observeOutsideMarks, turnOutsideRead, wireOutsideStore } from '../../email/external-marks.ts';
import { fileOutsideStore } from '../../outside-store.ts';
import { acpOutsideHooks } from '../../outside-wire.ts';
import { Store } from '../../store.ts';
import { BotOutsideWrites } from '../../bot-outside-writes.ts';
const cli = fileURLToPath(new URL('../../testing/fake-acp-cli.ts', import.meta.url));
const Driver = createAcpDriver({ driverKind: 'botCreateFixture', displayName: 'Fixture', models: { default: 'm', options: [{ id: 'm', label: 'M' }] }, defaultCli: cli, nativeSource: 'fixture.acp', loginNote: 'unused', spawnArgs: () => [], pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true }) as unknown as ProviderDriver<AcpConfig>;
let instance: ProviderInstance | undefined; let home = ''; let off: (() => void) | undefined;
afterEach(async () => { off?.(); off = undefined; await instance?.dispose(); instance = undefined; setAcpOutsideHooks(null); forgetOutsideState(); if (home) removeTempDirSync(home); });
const update = (at: number, update: Record<string, unknown>) => ({ at, rail: '_fuigo/session_notification', update });
for (const kind of ['complete', 'row-outside-read', 'torn-row', 'plus-other-mark', 'read-event'] as const) it(`r331 actual ACP ${kind}`, async () => {
  home = mkdtempSync(join(tmpdir(), 'murage-botcreate-acp-'));
  expect(wireOutsideStore(fileOutsideStore(join(home, 'outside.jsonl')))).toBe(true);
  setAcpOutsideHooks(acpOutsideHooks(() => home));
  beginOutsideTurn('T', 'fixture', undefined, false);
  const store = new Store(() => ({ instanceId: 'fixture', model: 'm' }));
  const writes = new BotOutsideWrites(store, turnOutsideRead);
  writes.ledger.open('G', 'T', 'fuigo', 'own');
  off = observeOutsideMarks((thread, source, lifecycle) => writes.ledger.mark(thread, source, lifecycle));
  const bot = store.createBot({ name: `Susan ${kind}` }, { staged: writes.staging('G', 'T', 'chief', 'turn-open', { autoApprove: true, fullAccess: false, noLimits: false, lead: false }), seedMessages: false }); writes.record(bot.id);
  const script: Record<string, unknown>[] = [
    { at: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'on it' } } },
    update(10, { sessionUpdate: 'subagent_spawned', subagent_id: 'S', description: 'helper' }),
    { at: 30, result: { stopReason: 'end_turn' } },
  ];
  if (kind === 'row-outside-read') script.push(update(50, { sessionUpdate: 'subagent_progress', subagent_id: 'S', tool_call_count: 1 }));
  if (kind === 'torn-row') script.push(update(50, { sessionUpdate: 'subagent_progress', subagent_id: 'S', tool_call_count: 'torn' }));
  if (kind === 'plus-other-mark') script.push({ at: 50, notify: { method: '_vendor/read', params: {} } });
  if (kind === 'read-event') script.push(update(50, { sessionUpdate: 'tool_call', toolCallId: 'helper-read', kind: 'read', rawInput: { url: 'https://example.test' } }));
  script.push(update(80, { sessionUpdate: 'subagent_finished', subagent_id: 'S', status: 'completed' }));
  instance = await Driver.create({ instanceId: 'fixture', displayName: 'Fixture', enabled: true, config: Driver.decodeConfig({ cli, fullAuto: true }), environment: { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: 'fuigo-script', FAKE_ACP_SCRIPT: JSON.stringify(script), FAKE_ACP_MCP_READY: '1' } });
  const recorder = recordEvents(instance.adapter);
  const { turnId } = await instance.adapter.sendTurn({ threadId: 'T', text: 'create Susan', cwd: home });
  const done = await recorder.until(e => e.type === 'turn.completed' && e.turnId === turnId, 15_000);
  if (done.type !== 'turn.completed') throw new Error('missing terminal');
  expect(done).toMatchObject({ ok: true, readsComplete: true, helperRow: { name: 'acp-helpers', site: 'settle_held', recorded: true } });
  expect(turnOutsideRead('T')).not.toBeNull();
  writes.settle('G', done);
  expect(bot.staged?.reason ?? 'ACTIVE').toBe(kind === 'complete' ? 'ACTIVE' : 'outside');
  expect(turnOutsideRead('T')).not.toBeNull();
  recorder.stop();
}, 20_000);
