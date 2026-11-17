// SPDX-License-Identifier: AGPL-3.0-or-later
// Physical SDK streams, inert MSP peer; no vendor process or delete command.
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderInstance, RuntimeEvent } from '../contracts.ts';
import * as procs from '../procs.ts';
import * as power from '../host-power.ts';
import * as wiring from './murage-exec-wipe.ts';
import { installNativeReleaseReader } from '../decision/provider-release.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { MuseCodeDriver, MUSE_DEFAULT_MODEL } from './muse-code.ts';

let instance: ProviderInstance | undefined;
afterEach(async () => { await instance?.dispose(); instance = undefined; vi.restoreAllMocks(); installNativeReleaseReader(() => false); });
async function fixture(retry = false) {
  const events: RuntimeEvent[] = [], children: any[] = [], envs: NodeJS.ProcessEnv[] = [];
  let options!: wiring.TurnGuardEnvOptions;
  const actual = wiring.wipeGuardTurnEnvironment;
  vi.spyOn(wiring, 'wipeGuardTurnEnvironment').mockImplementation(async o => {
    options = o;
    return actual({ ...o, installShim: () => '/fixture/shim', start: async () => ({ file: '/fixture/guard', end: async () => {} }) });
  });
  vi.spyOn(procs, 'resolveEngineExecutable').mockReturnValue({ command: '/fixture/muse', args: [] });
  vi.spyOn(power, 'hostPowerPlatform').mockReturnValue('darwin');
  vi.spyOn(procs, 'hostPowerRefused').mockImplementation(child => Boolean((child as any).refused));
  let refused = false;
  vi.spyOn(procs, 'spawnCli').mockImplementation((_cli, args, opts) => {
    const session = args[0] === 'serve' && !args.includes('--no-session-log');
    if (session) envs.push({ ...opts?.env });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: undefined as any,
      pid: 20000 + children.length, exitCode: null as number | null, signalCode: null, refused: false,
      frames: [] as any[],
      send(frame: object) { this.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n'); },
      end(this: EventEmitter & { exitCode: number | null; stdout: PassThrough; stderr: PassThrough }) { if (this.exitCode !== null) return; this.exitCode = 0; this.emit('exit', 0, null); this.stdout.end(); this.stderr.end(); this.emit('close', 0, null); },
    });
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const frame = JSON.parse(String(chunk)); child.frames.push(frame); callback();
      if (frame.id === undefined) return;
      if (retry && session && !refused && frame.method === 'initialize') {
        refused = true; child.refused = true; queueMicrotask(() => child.end()); return;
      }
      const result = frame.method === 'initialize' ? { grantedCapabilities: ['sessionMcp'] }
        : frame.method === 'model/list' ? { models: [{ modelId: MUSE_DEFAULT_MODEL }] }
        : frame.method === 'session/start' ? { session: { sessionId: 'fixture-session', modelId: frame.params.modelId } } : {};
      child.send({ id: frame.id, result: { commandId: frame.params?.commandId, ...result } });
    } });
    children.push(child);
    if (args[0] === '--version') queueMicrotask(() => { child.stdout.write('muse 1.4.14\n'); child.end(); });
    return child as unknown as ReturnType<typeof procs.spawnCli>;
  });
  vi.spyOn(procs, 'awaitCliTreeStopped').mockImplementation(async child => { (child as any).end(); return true; });
  instance = await MuseCodeDriver.create({ instanceId: 'guard-fixture', displayName: 'Fixture', enabled: true,
    environment: {}, config: MuseCodeDriver.decodeConfig({ cli: '/fixture/muse' }) });
  instance.adapter.onEvent(e => events.push(e));
  await vi.waitFor(() => expect(instance!.models.source).toBe('live'));
  await instance.adapter.sendTurn({ threadId: 'guard-fixture', text: 'fixture', cwd: fixtureBotFolder(), noLimits: true,
    warmIdentity: { botId: 'fixture-bot', audience: 'owner', decidedOwner: true } });
  await vi.waitFor(() => expect(children.some(c => c.frames.some((f: any) => f.method === 'turn/start'))).toBe(true));
  return { events, envs, options: () => options };
}
it.each(['allow', 'deny'] as const)('H3: Muse exec %s enters its real request delivery adapter', async behavior => {
  const f = await fixture();
  expect(f.options().askWipe).toBeTypeOf('function');
  const abort = new AbortController();
  const answer = f.options().askWipe!({ command: 'rm -rf fixture', cardCommand: 'rm -rf /fixture/project', cwd: fixtureBotFolder(), targets: ['/fixture/project'] }, abort.signal);
  const event = f.events.find(e => e.type === 'request.opened')!;
  expect(event).toMatchObject({ type: 'request.opened', requestType: 'permission', toolCall: { name: 'Bash', input: { command: 'rm -rf /fixture/project' } } });
  installNativeReleaseReader(() => false);
  if (behavior === 'allow') expect(await instance!.adapter.respondToRequest(event.threadId, event.requestId!, { behavior })).toBe('unavailable');
  installNativeReleaseReader(identity => identity.threadId === event.threadId && identity.turnId === event.turnId && identity.requestId === event.requestId);
  expect(await instance!.adapter.respondToRequest(event.threadId, event.requestId!, { behavior })).toBe(behavior === 'allow' ? 'allowed-once' : 'rejected');
  expect(await answer).toBe(behavior);
  expect(f.events.filter(e => e.type === 'request.resolved')).toHaveLength(1);
  expect(await instance!.adapter.respondToRequest(event.threadId, event.requestId!, { behavior })).toBe('unavailable');
});
it('H4: macOS power-refusal recovery preserves the exact per-turn spawn env', async () => {
  const f = await fixture(true);
  expect(f.envs).toHaveLength(2);
  expect(f.envs[0].MURAGE_WIPE_GUARD).toBe('/fixture/guard');
  expect(f.envs[0].PATH?.split(':')[0]).toBe('/fixture/shim');
  expect(f.envs[1]).toEqual(f.envs[0]);
});
