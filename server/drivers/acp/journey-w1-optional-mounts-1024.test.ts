// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// DESIGN-JOURNEY-1024 section 8 / W1 (contract 2397 side B, owner q1024-journey): an optional browser/computer mount that is
// still starting when the bound ready wait runs out never refuses a reply on the ACP path. The refusal branch is the
// bound-mounted timeout check in core.ts (acp.direct.7292) for an engine WITHOUT a per-server list method; the three MAIN R1
// names `browser`, `murage-browser` and `computer` leave that check and the waited set. Control rows: a non-browser mount in
// the same state still refuses, and a browser mount beside it does not change that.
// Real ACP core, real relay, fake ACP CLI that never announces readiness (so the wait runs to its bound).
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
beforeEach(() => {
  ensureDirs(); chmodSync(FAKE_CLI, 0o755);
  vi.stubEnv('MURAGE_ACP_MCP_OWN_READY_MS', '600');
  vi.stubEnv('MURAGE_ACP_MCP_READY_MS', '600');
});
afterEach(async () => { vi.unstubAllEnvs(); for (const s of stops.splice(0)) s(); await instance?.dispose().catch(() => {}); instance = undefined; });

/** An engine with a readiness notification and a connect-count notification but NO per-server list method (the branch W1 names). */
const support = (kind: string): AcpSupport => ({ driverKind: kind, displayName: 'Journey', models: { default: '', options: [] }, defaultCli: FAKE_CLI,
  nativeSource: 'test.acp', loginNote: 'unused', spawnArgs: () => [], pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true,
  fluxReach: () => 'elsewhere' as const, ownTools: false, mcpReadyNotification: '_fuigo/mcp_initialized', mcpProgressNotification: '_fuigo/mcp_progress' } as AcpSupport);
const peer = (tools: string[]) => ({ command: process.execPath, args: [FAKE_MCP], env: { FIXTURE_TOOLS: JSON.stringify(tools) } });
const refusals = (threadId: string): FencedRefusal[] => fencedRefusals().filter((x): x is FencedRefusal => x.threadId === threadId && /^acp\.direct\./.test((x as FencedRefusal).site ?? ''));

async function boundTurn(kind: string, threadId: string, integrations: Record<string, unknown>, env: Record<string, string> = {}) {
  const Driver = createAcpDriver(support(kind));
  instance = await Driver.create({ instanceId: threadId, displayName: 'Journey', enabled: true, config: Driver.decodeConfig({ cli: FAKE_CLI, fullAuto: false }), environment: { FAKE_ACP_MODE: 'no-auth', ...env } });
  bindFixtureAdapter(instance.adapter);
  const recorder = recordEvents(instance.adapter); stops.push(() => recorder.stop());
  const sent = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text: 'go', integrations } as never);
  const done = await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId) as unknown as { ok: boolean; stopReason: string | null };
  return { done, refused: refusals(threadId) };
}

/** One row per optional browser/computer name (MAIN R1). The `murage-browser` row is removed: that name left the optional set at
 *  core.ts OPTIONAL_ROUTE_MOUNTS (ASTRA d961956a02 H3, r6), so a user mount of that name now gates the reply like any other; the inverted
 *  assertion is W1c in journey-w1m-mixed-mounts-1024.test.ts (both engines). Only reserved names stay optional. */
const OPTIONAL = [
  { name: 'browser', integrations: { browser: peer(['navigate']) } },
  { name: 'computer', integrations: { computer: { kind: 'box', boxId: 'box-fixture', token: 'fixture-token' } } },
] as const;

for (const row of OPTIONAL) {
  // RED on base: the timeout refusal counted every active mount, so a still-starting `${row.name}` refused the turn (acp.direct.7292).
  // Mutant M-W1 (put the three names back in the refusal's active set): refused, RED at the "not refused" assertion.
  it(`W1 ${row.name}: a still-starting optional ${row.name} mount never refuses the reply (no per-server list method)`, async () => {
    const { done, refused } = await boundTurn(`jw1${row.name.replace(/-/g, '')}`, `jw1-${row.name}`, row.integrations);
    expect(refused.map(r => r.site), `W1 ${row.name} not refused`).toEqual([]);
    expect(done, `W1 ${row.name} reply delivered`).toMatchObject({ ok: true });
  });
}

// Control (guard, GREEN on base): a non-browser mount in the same state still refuses (today's 7292).
// Mutant M-W1c (drop every mount from the refusal): the turn runs, RED at the "refused" assertion.
it('W1c: a still-starting non-browser mount still refuses, with or without a browser mount beside it', async () => {
  const alone = await boundTurn('jw1ca', 'jw1-control', { phoneJobs: peer(['two']) });
  expect(alone.refused.length, 'W1c alone refused').toBe(1);
  expect(alone.done).toMatchObject({ ok: false, stopReason: 'memory-refused' });
  await instance?.dispose().catch(() => {}); instance = undefined;
  const beside = await boundTurn('jw1cb', 'jw1-control-b', { phoneJobs: peer(['two']), browser: peer(['navigate']) });
  expect(beside.refused.length, 'W1c beside refused').toBe(1);
  expect(beside.done).toMatchObject({ ok: false, stopReason: 'memory-refused' });
});

// W1g (guard, Astra pass 2 H1; GREEN on base by design): the engine's connect count names no server, so "1 of 2 connected" with a
// browser beside a non-browser mount is not proof the non-browser mount is up: the turn is still refused (fail closed).
// Mutant M-W1g (compare the count with the non-optional mounts only, the pass-1 attempt at 2d8cb59e0e): runs, RED at "refused".
it('W1g: an anonymous connect count that may be the browser alone never stands in for a non-browser mount', async () => {
  const { done, refused } = await boundTurn('jw1g', 'jw1-progress', { phoneJobs: peer(['two']), browser: peer(['navigate']) }, { FAKE_ACP_MCP_PROGRESS: '1' });
  expect(refused.length, 'W1g refused').toBe(1);
  expect(done).toMatchObject({ ok: false, stopReason: 'memory-refused' });
});
