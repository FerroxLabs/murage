// SPDX-License-Identifier: AGPL-3.0-or-later
// secret-scan: fixture
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { RuntimeEvent, RuntimeEventListener, SendTurnInput } from '../contracts.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { askExecWipe, ownerNoLimitsWipeTurn, wipeGuardRealTools, wipeGuardRootPaths, wipeGuardTurnEnvironment, type GuardStartOptions } from './murage-exec-wipe.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
const turn = (threadId = 'fixture-thread'): SendTurnInput => ({
  threadId, text: 'fixture', cwd: '/fixture/project', noLimits: true,
  warmIdentity: { botId: 'fixture-bot', audience: 'owner', decidedOwner: true },
});
function fixture() {
  const listeners = new Set<RuntimeEventListener>();
  const stop = new AbortController(), end = vi.fn(async () => {});
  let options!: GuardStartOptions;
  const start = vi.fn(async (o: GuardStartOptions) => { options = o; return { file: '/fixture/turn-guard', end }; });
  const env = { PATH: '/fixture/tools:/usr/bin:/bin', KEEP: 'same', MURAGE_WIPE_GUARD: 'ambient' };
  const input = { turn: turn(), turnId: 'fixture-turn', env, signal: stop.signal, isLive: () => true,
    subscribe: (fn: RuntimeEventListener) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    start, installShim: () => '/fixture/shim', posixShell: true };
  return { listeners, stop, end, start, input, options: () => options };
}

it.each(['Claude', 'Codex', 'ACP', 'Antigravity', 'Muse'])('%s turn env contract: only current owner No limits gets a guard', async () => {
  const f = fixture();
  const env = await wipeGuardTurnEnvironment(f.input);
  expect(env).toEqual({ PATH: ['/fixture/shim', f.input.env.PATH].join(process.platform === 'win32' ? ';' : ':'), KEEP: 'same', MURAGE_WIPE_GUARD: '/fixture/turn-guard' });
  expect(f.start).toHaveBeenCalledOnce();
  // MAIN RULING 1114-WIPE-FIXTURE-DIRECTION item 5: the callback reads the actual engine env.
  expect(f.options().context().env).toEqual(env);
  expect(f.options().roots).toContain('/fixture/project');
  // MAIN RULING SEAN 1114-WIPE-HYBRID: Git Bash uses absolute Windows paths with forward slashes.
  expect(f.options().client[0]).toBe(process.platform === 'win32' ? process.execPath.replaceAll('\\', '/') : process.execPath);
  expect(f.options().signal.aborted).toBe(false);
  f.stop.abort();
  expect(f.options().signal.aborted).toBe(true);
  expect(f.options().isLive()).toBe(false);
  await Promise.resolve();
  expect(f.end).toHaveBeenCalledOnce();
  expect(f.listeners.size).toBe(0);
});

it.each(['Ask', 'Auto', 'Full access', 'non-owner', 'unproved owner', 'prewarm', 'draft'])("%s preserves PATH and removes an ambient turn guard", async kind => {
  const f = fixture();
  const t = f.input.turn;
  if (['Ask', 'Auto', 'Full access'].includes(kind)) { delete t.noLimits; t.askLevel = kind === 'Ask' ? true : undefined; }
  if (kind === 'non-owner') t.warmIdentity!.audience = 'non-owner';
  if (kind === 'unproved owner') delete t.warmIdentity;
  if (kind === 'prewarm') t.prewarm = true;
  if (kind === 'draft') t.draftOnly = true;
  expect(ownerNoLimitsWipeTurn(t)).toBe(false);
  expect(await wipeGuardTurnEnvironment(f.input)).toEqual({ PATH: f.input.env.PATH, KEEP: 'same' });
  expect(f.start).not.toHaveBeenCalled();
});

it('live level overrides initial No limits and an exact terminal revokes only its own turn', async () => {
  const f = fixture(); let noLimits = true;
  f.input.turn.permissionNow = () => noLimits ? { noLimits: true } : { stopLine: true };
  await wipeGuardTurnEnvironment(f.input);
  // MAIN RULING NL-WIPE-ONLY-FIXTURES: lower levels keep their existing policy; turn identity remains live.
  noLimits = false; expect(f.options().isLive()).toBe(true); expect(f.options().isEnabled?.()).toBe(false);
  const emit = (event: RuntimeEvent) => { for (const fn of [...f.listeners]) fn(event); };
  emit({ eventId: 'fixture-terminal', provider: 'claude' as const, createdAt: new Date().toISOString(), type: 'turn.completed', threadId: 'other', turnId: 'fixture-turn', ok: true });
  expect(f.end).not.toHaveBeenCalled();
  emit({ eventId: 'fixture-terminal', provider: 'claude' as const, createdAt: new Date().toISOString(), type: 'turn.completed', threadId: 'fixture-thread', turnId: 'older-turn', ok: true });
  expect(f.end).not.toHaveBeenCalled();
  emit({ eventId: 'fixture-terminal', provider: 'claude' as const, createdAt: new Date().toISOString(), type: 'turn.completed', threadId: 'fixture-thread', turnId: 'fixture-turn', ok: true });
  await Promise.resolve(); expect(f.end).toHaveBeenCalledOnce(); expect(f.listeners.size).toBe(0);
});

it('Stop while callback starts retires the late guard and publishes no guard env', async () => {
  const f = fixture(); let release!: () => void;
  f.input.start = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return { file: '/fixture/late', end: f.end }; });
  const waiting = wipeGuardTurnEnvironment(f.input);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  f.stop.abort(); release();
  expect(await waiting).toEqual({ PATH: f.input.env.PATH, KEEP: 'same' });
  expect(f.end).toHaveBeenCalledOnce(); expect(f.listeners.size).toBe(0);
});

it('original tools resolve past shim paths, and include an unusual mkfs variant', () => {
  const root = mkdtempSync(join(tmpdir(), 'wipe-tools-')); dirs.push(root);
  const shim = join(root, 'shim'), tools = join(root, 'tools'); mkdirSync(shim); mkdirSync(tools);
  for (const name of ['rm', 'mkfs.fixturefs']) writeFileSync(join(tools, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(shim, 'rm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const originals = wipeGuardRealTools([shim, tools].join(process.platform === 'win32' ? ';' : ':'), process.platform, shim);
  // MAIN RULING SEAN 1114-WIPE-HYBRID: original tool paths must execute through Git Bash on Windows.
  const native = (p: string) => process.platform === 'win32' ? p.replaceAll('\\', '/') : p;
  expect(originals).toEqual({ rm: native(join(tools, 'rm')), 'mkfs.fixturefs': native(join(tools, 'mkfs.fixturefs')) });
});

it('exec matches enter the existing request/card path and await a bound release receipt', async () => {
  const events: RuntimeEvent[] = [], stop = new AbortController(); let finish!: (behavior: string) => Promise<boolean>;
  const canAllow = vi.fn(() => false), confirm = vi.fn(), remove = vi.fn();
  const answer = askExecWipe({ provider: 'fixture', emit: e => { events.push(e); }, register: (_id, fn) => { finish = fn; }, remove, confirm, canAllow },
    'fixture-thread', 'fixture-turn', () => true, { command: "'rm' '-rf' '/fixture/project'", cardCommand: "'rm' '-rf' '/fixture/project'", cwd: '/fixture', targets: ['/fixture/project'] }, stop.signal);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'request.opened', requestType: 'permission', toolCall: { name: 'Bash', input: { command: "'rm' '-rf' '/fixture/project'", cwd: '/fixture' } } });
  expect(await finish('allow')).toBe(false); expect(confirm).not.toHaveBeenCalled();
  canAllow.mockReturnValue(true); expect(await finish('allow')).toBe(true);
  expect(await answer).toBe('allow'); expect(confirm).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce();
  expect(await finish('allow')).toBe(false);
});

it('Stop withdraws an unanswered exec card and refuses late allow', async () => {
  const stop = new AbortController(); let finish!: (behavior: string) => Promise<boolean>;
  const events: RuntimeEvent[] = [];
  const answer = askExecWipe({ provider: 'fixture', emit: e => { events.push(e); }, register: (_id, fn) => { finish = fn; }, remove: () => {}, confirm: () => {}, canAllow: () => true },
    'fixture-thread', 'fixture-turn', () => true, { command: 'fixture', cardCommand: 'fixture', cwd: '/fixture', targets: [] }, stop.signal);
  stop.abort(); expect(await answer).toBe('deny'); expect(await finish('allow')).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: 'request.resolved', behavior: 'deny', source: 'system' });
});

it.each([
  ['claude.ts', /handed\.env = await stopGate\.step\(e, wipeGuardTurnEnvironment\(/, /writeExecEnvFile\(threadId, childEnv, cwd, execShell, spawnProven\.proven\)/],
  ['codex.ts', /handed\.env = await gate\.step\(entry, wipeGuardTurnEnvironment\(/, /Object\.assign\(env, handed\.env\)/],
  ['acp/core.ts', /handed\.env = await fenced\(\(\) => wipeGuardTurnEnvironment\(/, /Object\.assign\(env, handed\.env\)/],
  ['antigravity.ts', /const turnEnv: NodeJS\.ProcessEnv = await gate\.step\(entry, wipeGuardTurnEnvironment\(/, /env: turnEnv/],
  ['muse-code.ts', /const turnEnv = await gate\.step\(e, wipeGuardTurnEnvironment\(/, /env: turnEnv \?\? childEnv\(\)/],
] as const)('%s final spawn env consumes the shared turn contract', async (file, hand, spawn) => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  expect(source).toMatch(hand); expect(source).toMatch(spawn);
  const afterHand = source.slice(source.search(hand));
  expect(afterHand).toContain('signal:'); expect(afterHand).toContain('isLive:'); expect(afterHand).toContain('subscribe:');
  if (file === 'claude.ts') expect(afterHand).toContain('setEnvName(handed.env, EXEC_NONCE, execNonce, process.platform)');
});


it('Git Bash guard roots retain native drive, home, system and project spellings', () => {
  const roots = wipeGuardRootPaths({ home: 'D:/Users/fixture', project: 'D:/project', dataDir: 'D:/app-data', env: { SystemRoot: 'E:/Windows' } }, [], 'win32');
  expect(roots).toEqual(expect.arrayContaining(['C:/', 'D:/', 'Z:/', 'E:/Windows', 'D:/Users/fixture', 'D:/project', 'D:/app-data']));
  expect(roots).not.toContain('/usr');
});

it('a retry of the same turn retires its previous file/token before issuing a replacement', async () => {
  const first = fixture(), second = fixture();
  await wipeGuardTurnEnvironment(first.input);
  second.input.start = vi.fn(async () => {
    expect(first.end).toHaveBeenCalledOnce();
    expect(first.options().isLive()).toBe(false);
    return { file: '/fixture/replacement-guard', end: second.end };
  });
  const env = await wipeGuardTurnEnvironment(second.input);
  expect(env.MURAGE_WIPE_GUARD).toBe('/fixture/replacement-guard');
  expect(first.listeners.size).toBe(0);
  second.stop.abort(); await Promise.resolve(); expect(second.end).toHaveBeenCalledOnce();
});

it('M cleanup: terminal delivery waits for teardown and exposes a cleanup failure', async () => {
  const { deliverWipeGuardTerminal } = await import('./murage-exec-wipe.ts');
  const f = fixture();
  let fail!: (error: Error) => void;
  f.end.mockImplementation(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  await wipeGuardTurnEnvironment(f.input);
  const delivered = vi.fn();
  const event = { eventId: 'fixture-terminal', provider: 'claude' as const, createdAt: new Date().toISOString(), type: 'turn.completed' as const, threadId: 'fixture-thread', turnId: 'fixture-turn', ok: true };
  expect(deliverWipeGuardTerminal(event, delivered)).toBe(true);
  expect(delivered).not.toHaveBeenCalled();
  fail(Error('fixture cleanup failure'));
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce());
  expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ type: 'turn.completed', ok: false, stopReason: 'wipe-guard-cleanup-failed' }));
});

it('M credit: exact live-turn owner approval forwards to G2 once, never to another turn or after Stop', async () => {
  const { approveExecWipeOnce } = await import('./murage-exec-wipe.ts');
  const f = fixture(), approveOnce = vi.fn(() => true);
  f.input.start = vi.fn(async () => ({ file: '/fixture/turn-guard', end: f.end, approveOnce }));
  await wipeGuardTurnEnvironment(f.input);
  const operation = { tool: 'rm', argv: ['-rf', '/fixture/project'], cwd: '/fixture', targets: ['/fixture/project'] };
  expect(approveExecWipeOnce('fixture-thread', 'other-turn', operation)).toBe(false);
  expect(approveExecWipeOnce('fixture-thread', 'fixture-turn', operation)).toBe(true);
  expect(approveOnce).toHaveBeenCalledExactlyOnceWith(operation);
  f.stop.abort();
  expect(approveExecWipeOnce('fixture-thread', 'fixture-turn', operation)).toBe(false);
});

// 1.0.20 Windows gate box: an empty optical drive D:\ answers every stat/realpath with UNKNOWN; every owner turn on
// every engine ended "error: wipe-path-probe-failed" before the engine started.
it('a root the real probe worker cannot read (a link loop) keeps its lexical form and never throws', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-probe-')); dirs.push(root);
  const loop = join(root, 'loop');
  symlinkSync(loop, loop);
  const { systemPathPort } = await import('../wipe/roots.ts');
  expect(() => systemPathPort.realpath(loop)).toThrow('wipe-path-probe-failed');
  const roots = wipeGuardRootPaths({ project: '/fixture/project' }, [loop]);
  expect(roots).toContain(loop);
  expect(roots).toContain('/');
});

it('Windows: a not-ready drive (UNKNOWN) stays a protected lexical root beside the readable drives', () => {
  const pathPort = { isBlockDevice: () => null, realpath: (p: string) => {
    if (/^d:/i.test(p)) throw Object.assign(new Error('wipe-path-probe-failed'), { code: 'UNKNOWN' });
    return /^[c]:/i.test(p) ? p : null;
  } };
  const roots = wipeGuardRootPaths({ home: 'C:/Users/fixture', project: 'C:/project', pathPort }, ['D:/'], 'win32');
  expect(roots).toEqual(expect.arrayContaining(['C:/', 'D:/', 'Z:/', 'C:/Users/fixture', 'C:/project']));
});

it('an owner No limits turn starts its guard with an unreadable root instead of failing setup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-probe-')); dirs.push(root);
  const loop = join(root, 'loop');
  symlinkSync(loop, loop);
  const f = fixture();
  const env = await wipeGuardTurnEnvironment({ ...f.input, turn: { ...turn(), addDirs: [loop] } });
  expect(env.MURAGE_WIPE_GUARD).toBe('/fixture/turn-guard');
  expect(f.options().roots).toContain(loop);
  f.stop.abort();
});

it('a guard that cannot start refuses the turn with a plain line, never a raw probe code', async () => {
  const f = fixture();
  f.start.mockImplementationOnce(async () => { throw Object.assign(new Error('wipe-path-probe-failed'), { code: 'UNKNOWN' }); });
  const failure = await wipeGuardTurnEnvironment(f.input).then(() => undefined, (error: Error) => error);
  expect(failure?.message).toBe('Could not start this reply. Send it again.');
  expect(failure?.message).not.toMatch(/wipe-/);
});
