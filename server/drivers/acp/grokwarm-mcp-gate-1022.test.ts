// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// design-1022-grokwarm r2 section C (Side M, GROKWARM-1022 builder). C3: the bound-mounted refusal fires only when a REQUIRED
// active mount (agents, memory, connected apps) is not ready; a slow non-required server never refuses the turn (both rows: the
// Grok row and the Fuigo row share the gate). C4: a required mount that is not ready keeps today's refusal.
// Real ACP core, real relay, fake ACP CLI answering the per-server list (FAKE_ACP_MCP_LIST).
// Cells: WM-C3 (+ MC-3), WM-C3t (+ MC-3t), WM-C4 / WM-C4t / WM-C4n (guards, + MC-4 / MC-4t / MC-4n).
import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureDirs } from '../../config.ts';
import { createAcpDriver, type AcpSupport } from './core.ts';
import { fencedRefusals, type FencedRefusal } from '../engine-input.ts';
import { fixtureBotFolder } from '../../testing/bot-folder-fixture.ts';
import { recordEvents } from '../../testing/events.ts';
import { bindFixtureAdapter } from '../../testing/mcp-admission-fixture.ts';
import type { ProviderInstance } from '../../contracts.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(HERE, '..', '..', 'testing', 'fake-acp-cli.ts');
const FAKE_MCP = join(HERE, '..', '..', 'testing', 'fake-c11-mcp.mjs');
let instance: ProviderInstance | undefined;
const stops: Array<() => void> = [];
beforeEach(() => { ensureDirs(); chmodSync(FAKE_CLI, 0o755); });
afterEach(async () => { vi.unstubAllEnvs(); for (const s of stops.splice(0)) s(); await instance?.dispose().catch(() => {}); instance = undefined; });

/** The two rows: Fuigo's names and Grok Build's names for the same readiness notification and per-server list. */
const ROWS = [
  { row: 'fuigo', ns: '_fuigo' },
  { row: 'grok', ns: '_x.ai' },
] as const;
const support = (row: string, ns: string): AcpSupport => ({ driverKind: `gwC${row}`, displayName: 'Gate', models: { default: '', options: [] }, defaultCli: FAKE_CLI,
  nativeSource: 'test.acp', loginNote: 'unused', spawnArgs: () => [], pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true,
  fluxReach: () => 'elsewhere' as const, ownTools: false, mcpReadyNotification: `${ns}/mcp_initialized`, mcpListMethod: `${ns}/mcp/list` } as AcpSupport);
const peer = (tools: string[]) => ({ command: process.execPath, args: [FAKE_MCP], env: { FIXTURE_TOOLS: JSON.stringify(tools) } });
const refusals = (threadId: string): FencedRefusal[] => fencedRefusals().filter((x): x is FencedRefusal => x.threadId === threadId && /^acp\.direct\./.test((x as FencedRefusal).site ?? ''));

/** One bound mounted turn: `agents` is required, `phoneJobs` is not. `list` is the engine's per-server answer. */
async function mountedTurn(row: string, ns: string, threadId: string, env: Record<string, string>) {
  const Driver = createAcpDriver(support(row, ns));
  instance = await Driver.create({ instanceId: threadId, displayName: 'Gate', enabled: true, config: Driver.decodeConfig({ cli: FAKE_CLI, fullAuto: false }), environment: { FAKE_ACP_MODE: 'no-auth', ...env } });
  bindFixtureAdapter(instance.adapter);
  const recorder = recordEvents(instance.adapter); stops.push(() => recorder.stop());
  const sent = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text: 'go', integrations: { agents: peer(['one']), phoneJobs: peer(['two']) } } as never);
  const done = await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId) as unknown as { ok: boolean; stopReason: string | null };
  return { done, refused: refusals(threadId) };
}

for (const { row, ns } of ROWS) {
  // WM-C3: the readiness notification arrives, the list shows the required server ready and a non-required one still starting.
  // RED on base: the bound-mounted list check counted every active mount and refused (acp.direct.7352).
  // Mutant MC-3 (refusal checks all active mounts again): refused, RED at the "not refused" assertion.
  it(`WM-C3 ${row}: a slow non-required server never refuses a bound mounted turn (notification path)`, async () => {
    const { done, refused } = await mountedTurn(row, ns, `gw-c3-${row}`, { FAKE_ACP_MCP_READY: '1', FAKE_ACP_MCP_LIST: JSON.stringify({ agents: 'ready', phoneJobs: 'initializing' }) });
    expect(refused.map(r => r.site), 'WM-C3 not refused').toEqual([]);
    expect(done).toMatchObject({ ok: true });
  });

  // WM-C3t: no readiness notification, so the wait runs to its bound (timeout) while the list names the required server ready.
  // RED on base: a bound mounted turn whose wait timed out was refused whenever any mount was active (acp.direct.7292).
  // Mutant MC-3t (the timeout refusal ignores the per-server list): refused, RED at the "not refused" assertion.
  it(`WM-C3t ${row}: a wait that ran out on a non-required server does not refuse when the list shows the required ones ready`, async () => {
    vi.stubEnv('MURAGE_ACP_MCP_OWN_READY_MS', '600');
    vi.stubEnv('MURAGE_ACP_MCP_READY_MS', '600');
    const { done, refused } = await mountedTurn(row, ns, `gw-c3t-${row}`, { FAKE_ACP_MCP_LIST: JSON.stringify({ agents: 'ready', phoneJobs: 'initializing' }) });
    expect(refused.map(r => r.site), 'WM-C3t not refused').toEqual([]);
    expect(done).toMatchObject({ ok: true });
  });

  // WM-C4 (guard, GREEN on base): the REQUIRED server is the one still starting: today's refusal, no prompt.
  // Mutant MC-4 (required set empty): the turn runs, RED at the "refused" assertion.
  it(`WM-C4 ${row}: a required server not ready still refuses the bound mounted turn`, async () => {
    // rel/1023: the turn's own window is pinned to the pre-winfu 15 s / 20 s (an explicit window is never extended, mcpBoundStartingWaitMs), so this guard still ends in the refusal it asserts.
    vi.stubEnv('MURAGE_MCP_RECONNECT_WAIT_MS', '15000');
    vi.stubEnv('MURAGE_MCP_RECOVERY_MS', '20000');
    const { done, refused } = await mountedTurn(row, ns, `gw-c4-${row}`, { FAKE_ACP_MCP_READY: '1', FAKE_ACP_MCP_LIST: JSON.stringify({ agents: 'initializing', phoneJobs: 'ready' }) });
    expect(refused.length, 'WM-C4 refused').toBe(1);
    expect(done).toMatchObject({ ok: false, stopReason: 'memory-refused' });
  });

  // WM-C4t (guard): the wait runs out AND the list shows the REQUIRED server still starting: the deferred check refuses.
  // Mutant MC-4t (the deferred list check ignores what the list says): the turn runs, RED at the "refused" assertion.
  it(`WM-C4t ${row}: a wait that ran out with the required server still starting refuses (deferred list check)`, async () => {
    // rel/1023: the turn's own window is pinned to the pre-winfu 15 s / 20 s (an explicit window is never extended, mcpBoundStartingWaitMs), so this guard still ends in the refusal it asserts.
    vi.stubEnv('MURAGE_MCP_RECONNECT_WAIT_MS', '15000');
    vi.stubEnv('MURAGE_MCP_RECOVERY_MS', '20000');
    vi.stubEnv('MURAGE_ACP_MCP_OWN_READY_MS', '600');
    vi.stubEnv('MURAGE_ACP_MCP_READY_MS', '600');
    const { done, refused } = await mountedTurn(row, ns, `gw-c4t-${row}`, { FAKE_ACP_MCP_LIST: JSON.stringify({ agents: 'initializing', phoneJobs: 'ready' }) });
    expect(refused.length, 'WM-C4t refused').toBe(1);
    expect(done).toMatchObject({ ok: false, stopReason: 'memory-refused' });
  });

  // WM-C4n (guard): the wait runs out and the engine gives no list answer at all: unknown is not ready, the turn is refused.
  // Mutant MC-4n (no list answer counts as ready): the turn runs, RED at the "refused" assertion.
  it(`WM-C4n ${row}: a wait that ran out with no per-server answer still refuses`, async () => {
    vi.stubEnv('MURAGE_ACP_MCP_OWN_READY_MS', '600');
    vi.stubEnv('MURAGE_ACP_MCP_READY_MS', '600');
    const { done, refused } = await mountedTurn(row, ns, `gw-c4n-${row}`, {});
    expect(refused.length, 'WM-C4n refused').toBe(1);
    expect(done).toMatchObject({ ok: false, stopReason: 'memory-refused' });
  });
}
