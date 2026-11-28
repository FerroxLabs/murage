// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// DESIGN-JOURNEY-1024 section 8 / W1, mixed mount sets (contract 2397 side B, owner q1024-journey; OPUS/FABLE 4094ddd1c5 H1/H2,
// Astra p2 H2, board :4808). The production shape: Murage's required mount (agents) beside an optional browser that is still
// starting. The required mount proves itself BY NAME (its own listed marker); the engine's per-server list stays silent. Before,
// that named proof was compared with EVERY mount, so the browser made it `own_ready` and the list gate refused (acp.direct.7352).
// Now each gate mount is proven by its own name (core.ts optionalRouteMount / gateNames / gateListed): every gate mount proven = ready.
// Guards: an unnamed non-browser mount beside them still refuses (it has no named proof), and an unproven required mount still
// refuses. Real ACP core, real relay, fake ACP engine that really connects to each handed server (FAKE_ACP_MCP_CONNECT).
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
  vi.stubEnv('MURAGE_ACP_MCP_OWN_READY_MS', '1500');
  vi.stubEnv('MURAGE_ACP_MCP_READY_MS', '1500');
  vi.stubEnv('MURAGE_MCP_RECOVERY_MS', '1500');
});
afterEach(async () => { vi.unstubAllEnvs(); for (const s of stops.splice(0)) s(); await instance?.dispose().catch(() => {}); instance = undefined; });

const base = (kind: string) => ({ driverKind: kind, displayName: 'Journey', models: { default: '', options: [] }, defaultCli: FAKE_CLI,
  nativeSource: 'test.acp', loginNote: 'unused', spawnArgs: () => [], pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true,
  fluxReach: () => 'elsewhere' as const, ownTools: false });
/** The engine shapes that reach a named-proof comparison (SITES.md W1m rows). */
const ENGINES = {
  // Fuigo/Grok shape: readiness notification + per-server list (the list is silent here) -> awaitMcpReady listedOutcome (core.ts optionalRouteMount site 1).
  notifyList: (kind: string) => ({ ...base(kind), mcpReadyNotification: '_fuigo/mcp_initialized', mcpListMethod: '_fuigo/mcp/list' }) as AcpSupport,
  // Listed-marker engines (gemini/qwen/kimi/droid/opencode shape) with a per-server list -> the mcp.listed.wait outcome (site 2).
  listedList: (kind: string) => ({ ...base(kind), mcpListedWait: true, mcpListMethod: '_fuigo/mcp/list' }) as AcpSupport,
  // No per-server list: the named proof decides at the ready wait; PIN (already delivered on base: own_ready never refuses here).
  notifyOnly: (kind: string) => ({ ...base(kind), mcpReadyNotification: '_fuigo/mcp_initialized' }) as AcpSupport,
};
/** A required mount that answers tools/list and so writes its own named marker. */
const up = (tools: string[]) => ({ command: process.execPath, args: [FAKE_MCP], env: { FIXTURE_TOOLS: JSON.stringify(tools) } });
/** A mount still starting: its process never answers initialize. */
const starting = () => ({ command: process.execPath, args: ['-e', 'process.stdin.resume()'], env: {} });
const refusals = (threadId: string): FencedRefusal[] => fencedRefusals().filter((x): x is FencedRefusal => x.threadId === threadId && /^acp\.direct\./.test((x as FencedRefusal).site ?? ''));

async function turn(support: AcpSupport, threadId: string, integrations: Record<string, unknown>) {
  const Driver = createAcpDriver(support);
  instance = await Driver.create({ instanceId: threadId, displayName: 'Journey', enabled: true, config: Driver.decodeConfig({ cli: FAKE_CLI, fullAuto: false }),
    environment: { FAKE_ACP_MODE: 'no-auth', FAKE_ACP_MCP_CONNECT: '1', FAKE_ACP_MCP_LIST_UNANSWERED: '1+' } });
  bindFixtureAdapter(instance.adapter);
  const recorder = recordEvents(instance.adapter); stops.push(() => recorder.stop());
  const sent = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text: 'go', integrations } as never);
  const done = await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId, 40_000) as unknown as { ok: boolean; stopReason: string | null };
  return { done, refused: refusals(threadId).map(r => r.site) };
}

// ASTRA d961956a02: a user mount named "murage-browser" is not optional (ACP has no such built-in); it is witnessed as a gate in W1c below.
const OPTIONAL = [
  { name: 'browser', mount: { browser: starting() } },
] as const;

// RED on base (b99bdb6a0e and 4094ddd1c5): ['acp.direct.7352'] at the "not refused" assertion (named proof compared with every mount).
// Mutants: M-W1m (listedOutcome and the outcomeNow gateListed term back to base) RED on the notifyList rows; M-W1m2 (listed-wait
// outcome back) RED on the listedList rows; NOOP (optionalRouteMount always false), DROP (gateListed never true) and REVERT
// (core.ts at base) RED on all four.
for (const engine of ['notifyList', 'listedList'] as const) {
  for (const row of OPTIONAL) {
    it(`W1m ${engine} ${row.name}: the required mount proven by name beside a still-starting ${row.name} -> reply delivered, no refusal`, async () => {
      const { done, refused } = await turn(ENGINES[engine](`jw1m${engine}${row.name.replace(/-/g, '')}`), `jw1m-${engine}-${row.name}`, { agents: up(['send']), ...row.mount });
      expect(refused, `W1m ${engine} ${row.name} not refused`).toEqual([]);
      expect(done, `W1m ${engine} ${row.name} delivered`).toMatchObject({ ok: true });
    }, 60_000);
  }
}

// PIN (green on base by design): no per-server list, the same mixed set is delivered on base too (own_ready never refuses there).
it('W1m PIN notifyOnly: required mount proven by name beside a still-starting browser, no per-server list -> delivered', async () => {
  const { done, refused } = await turn(ENGINES.notifyOnly('jw1mpin'), 'jw1m-pin', { agents: up(['send']), browser: starting() });
  expect(refused, 'W1m PIN not refused').toEqual([]);
  expect(done).toMatchObject({ ok: true });
}, 60_000);

// W1u (FABLE 4094ddd1c5 H1): no per-server list, a NON-browser mount (phoneJobs, Murage's own proxy shape: it writes its own marker) is up
// beside a still-starting browser. Before: no required mount, so no named proof was read; the anonymous count stayed short of every
// mount and the wait ran out -> acp.direct.7292. Now the gate mount is proven by its own marker -> delivered.
// RED on base at "W1u not refused". Mutants: M-W1u (outcomeNow without gateListed) RED at the same line.
it('W1u notifyOnly: a non-browser mount proven by its own marker beside a still-starting browser -> reply delivered, no refusal', async () => {
  const { done, refused } = await turn(ENGINES.notifyOnly('jw1u'), 'jw1u', { phoneJobs: up(['two']), browser: starting() });
  expect(refused, 'W1u not refused').toEqual([]);
  expect(done, 'W1u delivered').toMatchObject({ ok: true });
}, 60_000);

// Guard W1n (GREEN on base, fail closed): a non-browser mount with no named proof (phoneJobs, still starting) beside them still refuses.
// Mutant M-W1n (gateListed judges the required mounts only): delivered, RED at "W1n refused".
it('W1n: an unnamed non-browser mount still starting beside a proven required mount and a starting browser still refuses', async () => {
  const { done, refused } = await turn(ENGINES.notifyList('jw1n'), 'jw1n', { agents: up(['send']), phoneJobs: starting(), browser: starting() });
  expect(refused, 'W1n refused').toEqual(['acp.direct.7352']);
  expect(done).toMatchObject({ ok: false, stopReason: 'memory-refused' });
}, 60_000);

// Control W1r (design section 9 control row, GREEN on base): the required mount itself still starting (no marker) beside a starting browser
// still refuses. Mutant M-W1r (listedOutcome always ready, ownListed ignored) cannot reach it: the wait never ends listed. Kept as a pin.
it('W1r: a required mount still starting beside a starting browser still refuses', async () => {
  const { done, refused } = await turn(ENGINES.notifyList('jw1r'), 'jw1r', { agents: starting(), browser: starting() });
  expect(refused.length, 'W1r refused').toBe(1);
  expect(done).toMatchObject({ ok: false, stopReason: 'memory-refused' });
}, 60_000);

// W1x (ASTRA f1617a84a8 High, core.ts timeout refusal): the ready wait runs out with a gate mount in it, and by the timeout check the relay
// has let that mount go (its process exited), so only the still-starting browser is left. The browser is optional, so the 7292 timeout
// refusal (no per-server list) must not fire on it. The optional-only rows never reach this check (their wait is ready at once).
// RED on base at "W1x not refused" (['acp.direct.7292']). Mutant M-W1x (the timeout check counts optional mounts again) RED at the same line.
/** A droppable mount that never answers initialize and then exits: the relay retires it mid-wait. */
const leaving = () => ({ command: process.execPath, args: ['-e', 'setTimeout(() => process.exit(1), 400); process.stdin.resume()'], env: {} });
it('W1x notifyOnly: the wait runs out, the relay let the gate mount go, only a still-starting browser is left -> reply delivered, no refusal', async () => {
  const { done, refused } = await turn(ENGINES.notifyOnly('jw1x'), 'jw1x', { custom: { extra: leaving() }, browser: starting() });
  expect(refused, 'W1x not refused').toEqual([]);
  expect(done, 'W1x delivered').toMatchObject({ ok: true });
}, 60_000);

// W1c (ASTRA d961956a02 late High, core.ts OPTIONAL_ROUTE_MOUNTS): a USER mount named "murage-browser" (admitted: not a reserved name) is
// still starting beside a proven required mount. It is the owner's own server, not Murage's browser, so it gates like any other mount.
// RED on base d961956a02 at "W1c <engine> refused" (delivered: the name alone exempted it). Mutant M-W1c ("murage-browser" back in the
// set) RED at the same line; REVERT = base.
for (const engine of ['notifyList', 'listedList'] as const) {
  it(`W1c ${engine}: a still-starting user mount named murage-browser beside a proven required mount still refuses`, async () => {
    const { done, refused } = await turn(ENGINES[engine](`jw1c${engine}`), `jw1c-${engine}`, { agents: up(['send']), custom: { 'murage-browser': starting() } });
    expect(refused.length, `W1c ${engine} refused`).toBe(1);
    expect(done).toMatchObject({ ok: false });
  }, 60_000);
}
