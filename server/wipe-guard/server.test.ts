// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated callback fixtures only: fake root trees and a fresh socket per test.
// Run through it-remote.sh's network-none throwaway container. No delete tool is executed.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { GUARD_LIMITS, GuardProbes, startWipeGuardTurn, type GuardCardRequest, type GuardRequest, type GuardTurn, type GuardTurnOptions } from './server.ts';
import { wipeBreaker } from '../wipe-breaker.ts';
import type { GuardFile } from './guard-file.ts';

// Stall only main-thread filesystem imports. Worker probes use Node's real fs.
// A delayed Stop is observable on the starting commit without risking a host mount.
const stalled = vi.hoisted(() => ({ enumeration: false, identity: false }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  const delay = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900);
  const physical = Object.assign((...args: Parameters<typeof fs.realpathSync>) => fs.realpathSync(...args), {
    native: (...args: Parameters<typeof fs.realpathSync.native>) => { if (stalled.identity) delay(); return fs.realpathSync.native(...args); },
  });
  return { ...fs, realpathSync: physical, opendirSync: (...args: Parameters<typeof fs.opendirSync>) => {
    if (stalled.enumeration) delay(); return fs.opendirSync(...args);
  } };
});

const client = fileURLToPath(new URL('./client.mjs', import.meta.url));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(overrides: Partial<GuardTurnOptions> = {}, rootName = 'project') {
  const parent = mkdtempSync(join(tmpdir(), 'wg-cb-'));
  cleanups.push(() => removeTempDirSync(parent));
  const root = join(parent, rootName); mkdirSync(root);
  const stopped = new AbortController();
  const ask = vi.fn<GuardTurnOptions['askWipe']>(async () => 'deny');
  const options: GuardTurnOptions = { directory: parent, threadId: 't', roots: [root],
    client: [process.execPath, client], realTools: { rm: process.execPath },
    context: { project: root, cwd: parent, home: join(parent, 'home'), dataDir: join(parent, 'data') },
    isLive: () => true, signal: stopped.signal, askWipe: ask, ...overrides };
  const guard = await startWipeGuardTurn(options);
  cleanups.push(() => guard.end());
  const data = JSON.parse(readFileSync(guard.file, 'utf8')) as GuardFile;
  const request = (patch: Partial<GuardRequest> = {}): GuardRequest => ({ v: 1, kind: 'wipe-exec', id: randomUUID(),
    token: data.token, threadId: 't', tool: 'rm', argv: ['-rf', '--', root], cwd: parent, targets: [root], ...patch });
  return { parent, root, ask, guard, data, request, stopped, options };
}
function raw(socketPath: string, line: string): Promise<{ id: string; decision: string }> {
  return new Promise((done, fail) => {
    const socket = connect(socketPath); let buffer = '';
    socket.once('error', fail);
    socket.once('connect', () => socket.write(line));
    socket.setEncoding('utf8');
    socket.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { socket.destroy(); done(JSON.parse(buffer.slice(0, buffer.indexOf('\n')))); } });
  });
}
const send = (f: Awaited<ReturnType<typeof fixture>>, request = f.request()) => raw(f.data.socket, JSON.stringify(request) + '\n');
function runClient(guard: GuardTurn | string, request: GuardRequest | Record<string, unknown>) {
  const { token: _notOnArgv, ...wire } = request;
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn(process.execPath, [client, 'wipe-exec', JSON.stringify(wire)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MURAGE_WIPE_GUARD: typeof guard === 'string' ? guard : guard.file },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', fail); child.once('exit', code => done({ code, stdout, stderr }));
  });
}

describe('live turn exec callback', () => {
  it('waits for the owner through the wipe-card adapter, then returns client exit 0', async () => {
    const f = await fixture(), ready = deferred<GuardCardRequest>(), answer = deferred<'allow' | 'deny'>();
    f.ask.mockImplementation(async (card, signal) => { expect(signal.aborted).toBe(false); ready.resolve(card); return answer.promise; });
    let finished = false;
    const result = runClient(f.guard, f.request()).then(value => { finished = true; return value; });
    const card = await ready.promise;
    expect(finished).toBe(false); expect(card).not.toHaveProperty('token');
    expect(card.verdict).toMatchObject({ k: 'card', rule: 'delete-system-folder', root: 'project-root' });
    expect(card.argv).toEqual(['-rf', '--', f.root]); expect(card.command).toContain(f.root);
    answer.resolve('allow'); expect(await result).toEqual({ code: 0, stdout: '', stderr: '' });
  });
  it('returns client exit 10 on owner deny', async () => {
    const f = await fixture(); expect(await runClient(f.guard, f.request())).toEqual({ code: 10, stdout: '', stderr: '' }); expect(f.ask).toHaveBeenCalledTimes(1);
  });
  it('returns other exit code when app is down, retaining a stale guard file', async () => {
    const f = await fixture(), stale = join(f.parent, 'stale.json'); writeFileSync(stale, JSON.stringify(f.data), { mode: 0o600 });
    await f.guard.end(); const result = await runClient(stale, f.request()); expect(result.code).not.toBe(0); expect(result.code).not.toBe(10); expect(f.ask).not.toHaveBeenCalled();
  });
  it('consumes an owner-approved text target fingerprint once, avoiding a second card', async () => {
    const f = await fixture(), r = f.request(); expect(f.guard.approveOnce(r)).toBe(true);
    expect((await runClient(f.guard, r)).code).toBe(0); expect(f.ask).not.toHaveBeenCalled();
    expect((await runClient(f.guard, f.request())).code).toBe(10); expect(f.ask).toHaveBeenCalledTimes(1);
    expect((await send(f, r)).decision).toBe('deny'); expect(f.ask).toHaveBeenCalledTimes(1);
  });
  it('rejects a wrong token before asking the owner', async () => {
    const f = await fixture(); expect((await send(f, f.request({ token: randomUUID() }))).decision).toBe('deny'); expect(f.ask).not.toHaveBeenCalled();
  });
  it('rejects another thread both at the server and in the standalone client', async () => {
    const f = await fixture(), r = f.request({ threadId: 'other-thread' }); expect((await send(f, r)).decision).toBe('deny'); expect((await runClient(f.guard, r)).code).toBe(10); expect(f.ask).not.toHaveBeenCalled();
  });
  it('bounds an oversized JSON frame, including fragmented requests without a newline', async () => {
    const f = await fixture(); expect((await raw(f.data.socket, JSON.stringify(f.request()) + ' '.repeat(GUARD_LIMITS.requestBytes))).decision).toBe('deny'); expect(f.ask).not.toHaveBeenCalled();
  });
  it('Stop denies a pending card and aborts its existing-card adapter before any late allow', async () => {
    const f = await fixture(), ready = deferred<AbortSignal>(), answer = deferred<'allow' | 'deny'>();
    f.ask.mockImplementation(async (_card, signal) => { ready.resolve(signal); return answer.promise; });
    const result = runClient(f.guard, f.request()); const signal = await ready.promise;
    f.stopped.abort(); expect(signal.aborted).toBe(true); expect((await result).code).toBe(10);
    answer.resolve('allow'); await f.guard.end(); expect(existsSync(f.guard.file)).toBe(false); expect(f.guard.approveOnce(f.request())).toBe(false);
  });
  it('turn end denies a pending card even when the adapter ignores cancellation', async () => {
    const f = await fixture(), ready = deferred<void>();
    f.ask.mockImplementation(async () => { ready.resolve(); return new Promise(() => {}); });
    const result = runClient(f.guard, f.request()); await ready.promise; await f.guard.end(); expect((await result).code).toBe(10);
  });
  it('a restarted turn has a new socket and token; stale guard files cannot authorize it', async () => {
    const f = await fixture(), stale = join(f.parent, 'stale.json'); writeFileSync(stale, JSON.stringify(f.data), { mode: 0o600 });
    await f.guard.end(); const next = await startWipeGuardTurn(f.options); cleanups.push(() => next.end());
    const current = JSON.parse(readFileSync(next.file, 'utf8')) as GuardFile;
    expect(current.token).not.toBe(f.data.token); expect(current.socket).not.toBe(f.data.socket);
    const result = await runClient(stale, f.request()); expect(result.code).not.toBe(0); expect(result.code).not.toBe(10);
    expect((await raw(current.socket, JSON.stringify(f.request()) + '\n')).decision).toBe('deny');
    writeFileSync(stale, JSON.stringify({ ...f.data, socket: current.socket }));
    expect((await runClient(stale, f.request())).code).toBe(10); expect(f.ask).not.toHaveBeenCalled();
  });
  it('denies replay of an id even after a successful owner answer', async () => {
    const f = await fixture(), r = f.request(); f.ask.mockResolvedValue('allow');
    expect((await send(f, r)).decision).toBe('allow'); expect((await send(f, r)).decision).toBe('deny'); expect(f.ask).toHaveBeenCalledTimes(1);
  });
  it('bounds concurrent pending cards per turn', async () => {
    const f = await fixture(), ready = deferred<void>();
    f.ask.mockImplementation(async () => { if (f.ask.mock.calls.length === GUARD_LIMITS.concurrent) ready.resolve(); return new Promise(() => {}); });
    const pending = Array.from({ length: GUARD_LIMITS.concurrent }, () => send(f)); await ready.promise;
    expect((await send(f)).decision).toBe('deny'); expect(f.ask).toHaveBeenCalledTimes(GUARD_LIMITS.concurrent);
    await f.guard.end(); expect((await Promise.all(pending)).every(reply => reply.decision === 'deny')).toBe(true);
  });
  it('denies replay while the original id is still pending', async () => {
    const f = await fixture(), r = f.request(), ready = deferred<void>();
    f.ask.mockImplementation(async () => { ready.resolve(); return new Promise(() => {}); });
    const pending = send(f, r); await ready.promise; expect((await send(f, r)).decision).toBe('deny');
    expect(f.ask).toHaveBeenCalledTimes(1); await f.guard.end(); expect((await pending).decision).toBe('deny');
  });
  it('bounds completed requests and cannot evict replay protection within the turn', async () => {
    const f = await fixture();
    for (let i = 0; i < GUARD_LIMITS.requests; i++) expect((await send(f, f.request({ argv: ['-f', 'ordinary-file'], targets: [] }))).decision).toBe('allow');
    expect((await send(f)).decision).toBe('deny'); expect(f.ask).not.toHaveBeenCalled();
  });
  it('checks exact real argv and treats shell-looking operand strings literally', async () => {
    const f = await fixture();
    expect((await send(f, f.request({ argv: ['-rf', '$HOME'], targets: [f.root] }))).decision).toBe('allow');
    expect((await send(f, f.request({ argv: ['-f', '--', f.root] }))).decision).toBe('allow'); expect(f.ask).not.toHaveBeenCalled();
  });
  it('re-proves nearly-all direct children from argv and emits the same-root card projection', async () => {
    const f = await fixture();
    const children = Array.from({ length: 10 }, (_, i) => join(f.root, 'child-' + i)); children.forEach(path => mkdirSync(path));
    const nine = children.slice(0, 9);
    expect((await send(f, f.request({ argv: ['-rf', '--', ...children.slice(0, 8)], targets: [f.root] }))).decision).toBe('allow');
    expect((await send(f, f.request({ argv: ['-rf', '--', ...nine], targets: [] }))).decision).toBe('deny');
    expect(f.ask).toHaveBeenCalledTimes(1); expect(f.ask.mock.calls[0]![0].verdict).toMatchObject({ root: 'project-root' });
    expect(f.ask.mock.calls[0]![0].cardCommand).toContain(f.root);
  });
  it('counts a single child only if it is the entire nonempty protected root', async () => {
    const f = await fixture(), child = join(f.root, 'only'); mkdirSync(child);
    expect((await send(f, f.request({ argv: ['-rf', child], targets: [child] }))).decision).toBe('deny'); expect(f.ask).toHaveBeenCalledTimes(1);
  });
  it('re-proves child coverage through a symlink in the parent path', async () => {
    const f = await fixture(), child = join(f.root, 'only'), alias = join(f.parent, 'project-link'); mkdirSync(child);
    symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const operand = join(alias, 'only');
    expect((await send(f, f.request({ argv: ['-rf', operand], targets: [operand] }))).decision).toBe('deny');
    expect(f.ask).toHaveBeenCalledTimes(1); expect(f.ask.mock.calls[0]![0].cardCommand).toContain('/.');
  });
  it('classifies additional trusted guard roots even without a current project context', async () => {
    const f = await fixture({ context: {} });
    expect((await send(f)).decision).toBe('deny'); expect(f.ask.mock.calls[0]![0].verdict).toMatchObject({ root: 'project-root' });
  });
  it('re-decides device erasure and POSIX rmdir through the existing decision table', async () => {
    const f = await fixture();
    expect((await send(f, f.request({ tool: 'dd', argv: ['if=/dev/zero', 'of=/dev/sda'], targets: ['/dev/sda'] }))).decision).toBe('deny');
    expect(f.ask.mock.calls[0]![0].verdict.rule).toBe('disk-erase');
    expect((await send(f, f.request({ tool: 'rmdir', argv: [f.root] }))).decision).toBe('deny'); expect(f.ask).toHaveBeenCalledTimes(2);
  });
  it('does not treat the mv destination as a removed target', async () => {
    const f = await fixture(), source = join(f.parent, 'ordinary'); mkdirSync(source);
    expect((await send(f, f.request({ tool: 'mv', argv: [source, f.root], targets: [f.root] }))).decision).toBe('allow'); expect(f.ask).not.toHaveBeenCalled();
  });
  it('honors rmdir -- for a protected operand whose literal name starts with a dash', async () => {
    const f = await fixture({}, '-project');
    expect((await send(f, f.request({ tool: 'rmdir', argv: ['--', '-project'] }))).decision).toBe('deny');
    expect(f.ask).toHaveBeenCalledTimes(1);
  });
  it('rejects an approval fingerprint after the target object is replaced', async () => {
    const f = await fixture(), r = f.request(); expect(f.guard.approveOnce(r)).toBe(true);
    renameSync(f.root, join(f.parent, 'old-project')); mkdirSync(f.root);
    expect((await send(f, r)).decision).toBe('deny'); expect(f.ask).toHaveBeenCalledTimes(1);
  });
  it('rechecks the target object after waiting for the owner', async () => {
    const f = await fixture(), ready = deferred<void>(), answer = deferred<'allow' | 'deny'>();
    f.ask.mockImplementation(async () => { ready.resolve(); return answer.promise; });
    const pending = send(f); await ready.promise;
    renameSync(f.root, join(f.parent, 'old-project')); mkdirSync(f.root); answer.resolve('allow');
    expect((await pending).decision).toBe('deny');
  });
  it('refuses late answers when live-turn eligibility disappears', async () => {
    let live = true; const f = await fixture({ isLive: () => live }), ready = deferred<void>(), answer = deferred<'allow' | 'deny'>();
    f.ask.mockImplementation(async () => { ready.resolve(); return answer.promise; });
    const pending = send(f); await ready.promise; live = false; answer.resolve('allow'); expect((await pending).decision).toBe('deny');
  });
  it('does not auto-allow a failed existing-card adapter', async () => {
    const f = await fixture(); f.ask.mockRejectedValue(Error('fixture-card-unavailable')); expect((await send(f)).decision).toBe('deny');
  });
  it('rejects malformed JSON, missing fields, unsupported tools and excessive operand counts', async () => {
    const f = await fixture();
    for (const line of ['{\n', '{}\n', JSON.stringify(f.request({ tool: 'unknown-tool' })) + '\n', JSON.stringify(f.request({ argv: Array(257).fill('x') })) + '\n']) expect((await raw(f.data.socket, line)).decision).toBe('deny');
    expect(f.ask).not.toHaveBeenCalled();
  });
  it('protects guard file/socket permissions and removes only its own turn directory', async () => {
    const f = await fixture();
    if (process.platform !== 'win32') { expect(statSync(f.guard.file).mode & 0o777).toBe(0o600); expect(statSync(f.data.socket).mode & 0o777).toBe(0o600); expect(statSync(dirname(f.guard.file)).mode & 0o777).toBe(0o700); }
    await f.guard.end(); await f.guard.end(); expect(existsSync(f.guard.file)).toBe(false); expect(existsSync(dirname(f.guard.file))).toBe(false); expect(existsSync(f.root)).toBe(true);
  });
  it('standalone client refuses a POSIX guard file readable by other users', async () => {
    const f = await fixture();
    if (process.platform !== 'win32') { chmodSync(f.guard.file, 0o644); expect((await runClient(f.guard, f.request())).code).not.toBe(0); expect(f.ask).not.toHaveBeenCalled(); }
    else expect((await runClient(f.guard, f.request())).code).toBe(10);
  });
});


describe('review regressions', () => {
  for (const phase of ['enumeration', 'identity'] as const) it('H1 bounds main-thread ' + phase + ' probes so Stop can reply', async () => {
    const f = await fixture(), child = join(f.root, 'child'); mkdirSync(child);
    const r = phase === 'enumeration' ? f.request({ argv: ['-rf', child], targets: [child] }) : f.request();
    let stopAt = 0;
    stalled[phase] = true;
    const start = performance.now();
    const stop = setTimeout(() => { stopAt = performance.now() - start; f.stopped.abort(); }, 100);
    try {
      await send(f, r);
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(stopAt).toBeGreaterThan(0);
      expect(stopAt).toBeLessThan(650);
    } finally { clearTimeout(stop); stalled[phase] = false; }
  });
  for (const flag of ['-p', '--parents', '-vp']) it('H2 cards protected ancestors removed by rmdir ' + flag, async () => {
    const f = await fixture(), child = join(f.root, 'child', 'grandchild'); mkdirSync(child, { recursive: true });
    expect((await send(f, f.request({ tool: 'rmdir', argv: [flag, child], targets: [f.root] }))).decision).toBe('deny');
    expect(f.ask).toHaveBeenCalledTimes(1);
    expect(f.ask.mock.calls[0][0].verdict).toMatchObject({ k: 'card', root: 'project-root' });
  });
  it('keeps a disconnected owner card and spends its approval on exactly one retry', async () => {
    const f = await fixture(), ready = deferred<AbortSignal>(), answer = deferred<'allow' | 'deny'>(), answered = deferred<void>();
    f.ask.mockImplementation(async (_card, signal) => { ready.resolve(signal); const value = await answer.promise; answered.resolve(); return value; });
    const peer = connect(f.data.socket);
    peer.once('connect', () => peer.write(JSON.stringify(f.request()) + '\n'));
    const signal = await ready.promise;
    await new Promise<void>(resolve => { peer.once('close', resolve); peer.destroy(); });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(signal.aborted).toBe(false);
    answer.resolve('allow'); await answered.promise;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect((await send(f)).decision).toBe('allow'); expect(f.ask).toHaveBeenCalledTimes(1);
    f.ask.mockResolvedValue('deny');
    expect((await send(f)).decision).toBe('deny'); expect(f.ask).toHaveBeenCalledTimes(2);
  });
  it('expires unused text approvals after ten minutes', async () => {
    const f = await fixture(), r = f.request(), now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(f.guard.approveOnce(r)).toBe(true); clock.mockReturnValue(now + 600_001);
      expect((await send(f, r)).decision).toBe('deny'); expect(f.ask).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });
  it('reports failed guard cleanup while still closing its endpoint', async () => {
    const f = await fixture(); writeFileSync(f.guard.file, 'invalid-fixture-json');
    await expect(f.guard.end()).rejects.toThrow();
    expect(existsSync(f.data.socket)).toBe(false);
    // Same terminal cleanup result remains observable to the owner on a second end.
    await expect(f.guard.end()).rejects.toThrow();
    cleanups[cleanups.length - 1] = () => f.guard.end().catch(() => {});
  });
  for (const tool of ['Remove-Item', 'Move-Item', 'Format-Volume', 'Clear-Disk', 'Initialize-Disk', 'Remove-Partition', 'format', 'diskpart'])
    it('admits refined Windows tool ' + tool + ' to an owner card', async () => {
      const f = await fixture();
      const argv = tool === 'Remove-Item' ? ['-LiteralPath', f.root, '-Recurse'] : tool === 'Move-Item' ? ['-LiteralPath', f.root, '-Destination', join(f.parent, 'dest')] : tool === 'format' ? ['Q:'] : ['-Number', '99'];
      f.ask.mockResolvedValue('allow');
      expect((await send(f, f.request({ tool, argv }))).decision).toBe('allow'); expect(f.ask).toHaveBeenCalledTimes(1);
      expect(wipeBreaker(f.ask.mock.calls[0][0].cardCommand, { ...f.options.context, cwd: f.parent })).not.toBeNull();
    });
  it('client retries a refused connection until a late app socket appears', async () => {
    const f = await fixture(), late = join(dirname(f.guard.file), 'late.sock');
    writeFileSync(f.guard.file, JSON.stringify({ ...f.data, socket: late }));
    const listener = createServer(peer => { peer.once('data', bytes => { const r = JSON.parse(bytes.toString()); peer.end(JSON.stringify({ id: r.id, decision: 'allow' }) + '\n'); }); });
    const result = runClient(f.guard, f.request());
    const timer = setTimeout(() => listener.listen(late), 200);
    try { expect((await result).code).toBe(0); }
    finally { clearTimeout(timer); await new Promise<void>(resolve => listener.close(() => resolve())); }
  });
});

for (const method of ['entries', 'identities'] as const) it('H1 quarantines a stalled worker ' + method + ' syscall within a bounded deadline', async () => {
  const probe = new GuardProbes(`const {workerData}=require('node:worker_threads');workerData.port.on('message',()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000));`);
  try {
    probe.begin(); const start = performance.now();
    expect(() => method === 'entries' ? probe.entries('/fixture', 1) : probe.identities(['/fixture'])).toThrow('timeout');
    expect(performance.now() - start).toBeLessThan(650);
    probe.begin(); const retry = performance.now();
    expect(() => probe.entries('/fixture', 1)).toThrow('unavailable');
    expect(performance.now() - retry).toBeLessThan(100);
  } finally { await probe.close(); }
});
it('H2 leaves ordinary rmdir parents alone when a nonempty ancestor prevents root removal', async () => {
  const f = await fixture(), child = join(f.root, 'child'); mkdirSync(child); writeFileSync(join(f.root, 'keep'), 'fixture');
  expect((await send(f, f.request({ tool: 'rmdir', argv: ['-p', child], targets: [f.root] }))).decision).toBe('allow');
  expect(f.ask).not.toHaveBeenCalled();
});

it('Stop cancels an owner card retained after its client disconnects', async () => {
  const f = await fixture(), ready = deferred<AbortSignal>();
  f.ask.mockImplementation(async (_card, signal) => { ready.resolve(signal); return new Promise(() => {}); });
  const peer = connect(f.data.socket); peer.once('connect', () => peer.write(JSON.stringify(f.request()) + '\n'));
  const signal = await ready.promise;
  await new Promise<void>(resolve => { peer.once('close', resolve); peer.destroy(); });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(signal.aborted).toBe(false); f.stopped.abort(); expect(signal.aborted).toBe(true);
  await f.guard.end(); expect(existsSync(f.guard.file)).toBe(false);
});
