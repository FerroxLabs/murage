// SPDX-License-Identifier: AGPL-3.0-or-later
// Each row starts the actual driver with the repository's inert engine peer.
import { chmodSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderInstance, RuntimeEvent } from '../contracts.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { bindFixtureAdapter } from '../testing/mcp-admission-fixture.ts';
import { withClaudeFixtureCwd } from '../testing/claude-s2-wire-receipt.ts';
import { useOutsideStoreFixture } from '../testing/outside-store-fixture.ts';
import * as procs from '../procs.ts';
import * as wiring from './murage-exec-wipe.ts';
import { ClaudeDriver } from './claude.ts';
import { CodexDriver } from './codex.ts';
import { AntigravityDriver } from './antigravity.ts';
import { createAcpDriver } from './acp/core.ts';

useOutsideStoreFixture();
let instance: ProviderInstance | undefined;
afterEach(async () => { await instance?.dispose(); instance = undefined; vi.restoreAllMocks(); });
const AcpDriver = createAcpDriver({ driverKind: 'guardFixture', displayName: 'Guard fixture', defaultCli: 'fixture', nativeSource: 'fixture.acp',
  fluxReach: () => 'elsewhere', models: { default: 'm-one', options: [{ id: 'm-one', label: 'One' }] },
  loginNote: 'Fixture', spawnArgs: () => [], pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true });
const rows = [
  ['Claude', ClaudeDriver, 'fake-claude-cli.ts', { permissionMode: 'acceptEdits' }],
  ['Codex', CodexDriver, 'fake-codex-app-server.ts', { fullAuto: false }],
  ['ACP', AcpDriver, 'fake-acp-cli.ts', { fullAuto: false }],
  ['Antigravity', AntigravityDriver, 'fake-agy-cli.ts', { fullAuto: true }],
] as const;
it.each(rows)('%s hands its actual spawned peer the per-turn guard env', async (_name, driver, peer, config) => {
  const actual = wiring.wipeGuardTurnEnvironment;
  const starts = vi.fn(async () => ({ file: '/fixture/guard', end: async () => {} }));
  const hand = vi.spyOn(wiring, 'wipeGuardTurnEnvironment').mockImplementation(o => actual({ ...o,
    installShim: () => '/fixture/shim', start: starts, posixShell: true }));
  const spawn = vi.spyOn(procs, 'spawnCli');
  const cli = fileURLToPath(new URL('../testing/'+peer, import.meta.url));
  chmodSync(cli, 0o755);
  // decodeConfig keeps each driver's real schema; no stand-in driver is used.
  instance = await driver.create({ instanceId: 'env-fixture', enabled: true, displayName: 'Fixture', environment: {},
    config: driver.decodeConfig({ cli, ...config }) } as never);
  if (_name === 'Claude') { bindFixtureAdapter(instance.adapter); withClaudeFixtureCwd(instance.adapter); }
  const events: RuntimeEvent[] = []; instance.adapter.onEvent(e => events.push(e));
  await instance.adapter.sendTurn({ threadId: 'env-fixture', cwd: fixtureBotFolder(), text: 'fixture', noLimits: true,
    warmIdentity: { botId: 'fixture-bot', audience: 'owner', decidedOwner: true } });
  await vi.waitFor(() => expect(spawn.mock.calls.some(c => c[2]?.env?.MURAGE_WIPE_GUARD === '/fixture/guard')).toBe(true), { timeout: 15_000 });
  expect(hand).toHaveBeenCalled(); expect(starts).toHaveBeenCalledOnce();
  const env = spawn.mock.calls.find(c => c[2]?.env?.MURAGE_WIPE_GUARD === '/fixture/guard')![2]!.env!;
  expect(env.PATH?.split(process.platform === 'win32' ? ';' : ':')[0]).toBe('/fixture/shim');
  if (_name === 'Claude') {
    expect(readFileSync(env.MURAGE_EXEC_ENV_FILE!, 'utf8')).toContain('MURAGE_WIPE_GUARD=/fixture/guard\0');
    expect(readFileSync(env.MURAGE_EXEC_ENV_FILE!, 'utf8')).toContain('PATH=/fixture/shim:');
  }
});
