// SPDX-License-Identifier: AGPL-3.0-or-later
// OVERREACH #5 (1.0.24 q1024-power), the three drivers the first witness file left source-pinned. Entry point: each driver's real
// sendTurn. (1) The chat-completions MCP spawn (openai-chat.ts -> chat-mcp-client.ts defaultSpawn) is wrapped on every OS: the
// sandbox-exec stand-in refuses every launch and logs it, so an owner turn must log nothing and start its server, a guest turn must
// log a launch and lose its server. (2) Claude and Codex are wrapped on Windows only: the real driver turn runs with the engine
// job functions evaluated as win32 (the Windows launcher itself cannot run here), and the job the turn hands to the spawn is read.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureDirs } from '../config.ts';
import type { ProviderInstance } from '../contracts.ts';
import { hostPowerDeps, hostPowerProbeDeps, HOST_POWER_TEST_UNWRAPPED, resetSeatbeltSelectionsForTests } from '../host-power.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { recordEvents } from '../testing/events.ts';
import { bindOpenAIFixture } from '../testing/bound-openai-fixture.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { fixtureMountTurn, admittedFixtureInstance } from '../testing/mcp-admission-fixture.ts';
import { useOutsideStoreFixture } from '../testing/outside-store-fixture.ts';
import { resetShutdownDropForTests } from '../procs.ts';
import { OpenAICompatDriver } from './openai-compat.ts';
import { ClaudeDriver } from './claude.ts';
import { CodexDriver } from './codex.ts';
import { AntigravityDriver } from './antigravity.ts';

// The spawn jobs the drivers hand over, and the engine job functions evaluated as win32 (the owner decision inside them is the real one).
const seen = vi.hoisted(() => ({ jobs: [] as Array<{ job: { name?: string; hostPower?: boolean } | undefined; threadId: unknown }> }));
vi.mock('../procs.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../procs.ts')>();
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const win32 = <T>(run: () => T): T => {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
    try { return run(); } finally { Object.defineProperty(process, 'platform', descriptor); }
  };
  return {
    ...real,
    engineJob: (options?: Parameters<typeof real.engineJob>[0]) => (globalThis as Record<symbol, unknown>)[Symbol.for('power.win32')] === true ? win32(() => real.engineJob(options)) : real.engineJob(options),
    hostPowerKeyField: (options?: Parameters<typeof real.hostPowerKeyField>[0]) => (globalThis as Record<symbol, unknown>)[Symbol.for('power.win32')] === true ? win32(() => real.hostPowerKeyField(options)) : real.hostPowerKeyField(options),
    spawnCli: ((command: string, args: string[], options: object, job?: { name?: string; hostPower?: boolean }, ...rest: unknown[]) => {
      if ((globalThis as Record<symbol, unknown>)[Symbol.for('power.win32')] === true) { seen.jobs.push({ job, threadId: rest[1] }); return (real.spawnCli as (...a: unknown[]) => unknown)(command, args, options, undefined, ...rest); }
      return (real.spawnCli as (...a: unknown[]) => unknown)(command, args, options, job, ...rest);
    }) as typeof real.spawnCli,
  };
});

useOutsideStoreFixture();
const original = { ...hostPowerDeps }, probes = { ...hostPowerProbeDeps };
const WIN32 = Symbol.for('power.win32');
let previousFetch: typeof globalThis.fetch;
const instances: ProviderInstance[] = [];
beforeEach(() => { ensureDirs(); previousFetch = globalThis.fetch; seen.jobs.length = 0; });
afterEach(async () => {
  globalThis.fetch = previousFetch; (globalThis as Record<symbol, unknown>)[WIN32] = undefined;
  for (const instance of instances.splice(0)) await instance.dispose().catch(() => {});
  resetShutdownDropForTests(); Object.assign(hostPowerDeps, original); Object.assign(hostPowerProbeDeps, probes); resetSeatbeltSelectionsForTests();
  (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = undefined; vi.restoreAllMocks();
});

const MCP_SERVER = `
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_BOOT, 'booted\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line); if (m.id === undefined) continue;
    const result = m.method === 'initialize' ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } : m.method === 'tools/list' ? { tools: [{ name: 'noop', description: 'does nothing', inputSchema: { type: 'object', properties: {} } }] } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  }
});
process.stdin.on('end', () => process.exit(0));
`;

for (const audience of ['owner', 'guest'] as const) it.skipIf(process.platform === 'win32')(`W-OWNER chat-completions MCP spawn: the ${audience}'s turn ${audience === 'owner' ? 'starts its server unwrapped' : 'is wrapped and loses its server when the wrap fails'}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'power-owner-chat-'));
  const launches = join(root, 'launches'), boots = join(root, 'boots'), wrapper = join(root, 'sandbox'), server = join(root, 'server.cjs');
  writeFileSync(wrapper, `#!/bin/sh\necho launched >> '${launches}'\necho "sandbox-exec: sandbox_apply: Operation not permitted (fixture launch)" >&2\nexit 71\n`); chmodSync(wrapper, 0o755);
  writeFileSync(server, MCP_SERVER);
  Object.assign(hostPowerDeps, { platform: () => 'darwin', sandboxExec: wrapper });
  vi.spyOn(hostPowerProbeDeps, 'runSync').mockReturnValue({ code: 0, stderr: '' });
  (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = false;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // The provider stub answers one plain chat completion; anything else is a 404 and never reaches the network.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
    return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  }) as typeof fetch;
  const instance = await OpenAICompatDriver.create({ instanceId: `chat-${audience}`, displayName: 'Chat', environment: {}, enabled: true, config: OpenAICompatDriver.decodeConfig({ url: 'https://compat.invalid/v1', key: 'fixture-only-key', model: 'test-model' }) });
  bindOpenAIFixture(instance); instances.push(instance);
  const recorder = recordEvents(instance.adapter);
  try {
    const sent = await instance.adapter.sendTurn(fixtureMountTurn({ cwd: fixtureBotFolder(), threadId: `chat-${audience}`, text: 'fixture only',
      integrations: { custom: { fake: { command: process.execPath, args: [server], env: { FAKE_BOOT: boots } } } },
      ...(audience === 'owner' ? { hostPowerOwnerTurn: true as const } : {}) } as never));
    const done = await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId, 20000);
    const launched = existsSync(launches) ? readFileSync(launches, 'utf8').split('\n').filter(Boolean).length : 0;
    const booted = existsSync(boots) ? readFileSync(boots, 'utf8').split('\n').filter(Boolean).length : 0;
    const notices = JSON.stringify(recorder.events.filter(e => e.type === 'runtime.error'));
    if (audience === 'owner') {
      expect(launched, 'the owner turn MCP server was handed to the power wrapper').toBe(0);
      expect(booted, 'the owner turn MCP server never started: ' + notices).toBe(1);
      expect(done).toMatchObject({ ok: true });
    } else {
      expect(launched, 'the guest turn MCP server was not wrapped').toBeGreaterThan(0);
      expect(booted, 'a refused wrap must not leave a running server').toBe(0);
    }
  } finally { recorder.stop(); await removeTempDir(root); }
}, 60000);

for (const [name, make, fake, env] of [
  ['Claude', (cli: string) => admittedFixtureInstance(ClaudeDriver.create({ instanceId: 'pw-claude', displayName: 'Claude', environment: {}, enabled: true, config: { cli, permissionMode: 'acceptEdits' } as never })), 'fake-claude-cli.ts', {}],
  ['Codex', (cli: string) => CodexDriver.create({ instanceId: 'pw-codex', displayName: 'Codex', environment: {}, enabled: true, config: { cli, fullAuto: false } as never }), 'fake-codex-app-server.ts', {}],
] as const) for (const audience of ['owner', 'guest'] as const) it.skipIf(process.platform === 'win32')(`W-OWNER ${name} on Windows: the ${audience}'s turn is ${audience === 'owner' ? 'launched without the privilege removal' : 'launched under the power block'}`, async () => {
  void env;
  const cli = join(process.cwd(), 'server/testing', fake); chmodSync(cli, 0o755);
  (globalThis as Record<symbol, unknown>)[WIN32] = true;
  const instance = await make(cli); instances.push(instance);
  const recorder = recordEvents(instance.adapter);
  try {
    const sent = await instance.adapter.sendTurn({ threadId: `pw-${name}-${audience}`, text: 'fixture only', cwd: fixtureBotFolder(), ...(audience === 'owner' ? { hostPowerOwnerTurn: true as const } : {}) } as never);
    await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId, 30000);
    // Only the spawn bound to this turn's thread: the helper spawns (version probes, catalog reads) are not turn-bound and stay wrapped.
    const turnJobs = seen.jobs.filter(entry => entry.threadId === `pw-${name}-${audience}`);
    expect(turnJobs.length, 'the turn never reached the engine spawn: ' + JSON.stringify(seen.jobs)).toBeGreaterThan(0);
    for (const { job } of turnJobs) {
      expect(job?.name, 'a Windows engine turn always keeps its containment job').toBeTruthy();
      if (audience === 'owner') expect(job?.hostPower, 'the owner turn was launched with the privilege removal').toBeUndefined();
      else expect(job?.hostPower, 'the guest turn lost the power block').toBe(true);
    }
  } finally { recorder.stop(); }
}, 60000);

// (3) The server-owned relay that carries a custom MCP mount for the CLI engines (cli-mount-relay.ts spawnMount) is wrapped on Mac and
// Linux for every engine, Claude and Codex included. Entry: the real driver sendTurn with a custom mount; the stand-in logs each launch
// it is asked for, and the engine itself is unwrapped on Claude, so every logged launch is the relay's mount child.
for (const [name, make, fake] of [
  ['Antigravity', (cli: string) => AntigravityDriver.create({ instanceId: 'rl-agy', displayName: 'Agy', environment: {}, enabled: true, config: AntigravityDriver.decodeConfig({ cli }) }), 'fake-agy-cli.ts'],
  ['Claude', (cli: string) => admittedFixtureInstance(ClaudeDriver.create({ instanceId: 'rl-claude', displayName: 'Claude', environment: {}, enabled: true, config: { cli, permissionMode: 'acceptEdits' } as never })), 'fake-claude-cli.ts'],
] as const) for (const audience of ['owner', 'guest'] as const) it.skipIf(process.platform === 'win32')(`W-OWNER ${name} custom MCP relay mount: the ${audience}'s mount child is ${audience === 'owner' ? 'started unwrapped' : 'wrapped'}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'power-owner-relay-'));
  const launches = join(root, 'launches'), boots = join(root, 'boots'), wrapper = join(root, 'sandbox'), server = join(root, 'server.cjs');
  writeFileSync(wrapper, `#!/bin/sh\necho launched >> '${launches}'\necho "sandbox-exec: sandbox_apply: Operation not permitted (fixture launch)" >&2\nexit 71\n`); chmodSync(wrapper, 0o755);
  writeFileSync(server, MCP_SERVER);
  const cli = join(process.cwd(), 'server/testing', fake); chmodSync(cli, 0o755);
  Object.assign(hostPowerDeps, { platform: () => 'darwin', sandboxExec: wrapper });
  vi.spyOn(hostPowerProbeDeps, 'runSync').mockReturnValue({ code: 0, stderr: '' });
  (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = false;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const instance = await make(cli); instances.push(instance);
  const recorder = recordEvents(instance.adapter);
  try {
    const sent = await instance.adapter.sendTurn(fixtureMountTurn({ cwd: fixtureBotFolder(), threadId: `rl-${name}-${audience}`, text: 'fixture only',
      integrations: { custom: { fake: { command: process.execPath, args: [server], env: { FAKE_BOOT: boots } } } },
      ...(audience === 'owner' ? { hostPowerOwnerTurn: true as const } : {}) } as never));
    await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId, 30000);
    const launched = existsSync(launches) ? readFileSync(launches, 'utf8').split('\n').filter(Boolean).length : 0;
    const booted = existsSync(boots) ? readFileSync(boots, 'utf8').split('\n').filter(Boolean).length : 0;
    if (audience === 'owner') {
      expect(launched, 'the owner turn mount child was handed to the power wrapper').toBe(0);
      expect(booted, 'the owner turn mount child never started').toBeGreaterThan(0);
    } else expect(launched, 'the guest turn mount child was not wrapped').toBeGreaterThan(0);
  } finally { recorder.stop(); await removeTempDir(root); }
}, 60000);
