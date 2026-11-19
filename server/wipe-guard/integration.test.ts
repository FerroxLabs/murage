// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: wg-int owns integration; wg-callback owns callback; wg-wiring owns driver adapter.
// Only fake temp objects and socket requests; no destructive process is run.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixture, d, baseRun } from '../decision/fixture.ts';
import { wipeGuardTurnEnvironment, deliverWipeGuardTerminal, wipeGuardRealTools } from '../drivers/murage-exec-wipe.ts';
import { installWipeContextReader } from '../wipe/context.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import type { GuardStartOptions } from '../drivers/murage-exec-wipe.ts';

async function integrated(askWipe?: GuardStartOptions['askWipe']) {
  const f = fixture(), parent = mkdtempSync(join(tmpdir(), 'wg-int-')), project = join(parent, 'project'); mkdirSync(project);
  const restore = installWipeContextReader(() => ({ cwd: parent, project, home: join(parent, 'home'), dataDir: join(parent, 'data') }));
  const stop = new AbortController(); let noLimits = true, live = true, cards = 0;
  const turn = { threadId: 't', text: 'fixture', cwd: parent, noLimits: true as const,
    warmIdentity: { botId: 'b', audience: 'owner' as 'owner' | 'non-owner', decidedOwner: true }, permissionNow: () => noLimits ? {noLimits:true as const} : {} };
  const env = await wipeGuardTurnEnvironment({ turn, turnId: 'turn', env: { PATH: process.env.PATH }, signal: stop.signal,
    isLive: () => live, subscribe: () => () => {}, roots: [project], posixShell: true,
    askWipe: askWipe ?? (async () => { cards++; return 'deny'; }) });
  const data = JSON.parse(readFileSync(env.MURAGE_WIPE_GUARD!, 'utf8'));
  const argv = ['-rf', '--', project];
  const request = (patch = {}) => new Promise<{ decision: string }>((resolve, reject) => {
    const socket = connect(data.socket); let text = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify({ v: 1, kind: 'wipe-exec', id: randomUUID(), token: data.token,
      threadId: 't', tool: 'rm', argv, cwd: parent, targets: [project], ...patch }) + '\n'));
    socket.on('data', chunk => { text += chunk; if (text.includes('\n')) { socket.destroy(); resolve(JSON.parse(text.split('\n')[0]!)); } });
  });
  return { f, parent, project, argv, request, cards: () => cards, setEnabled: (value: boolean) => { noLimits = value; }, setLive: (value: boolean) => { live = value; }, setOwner: (value: boolean) => { turn.warmIdentity.audience = value ? 'owner' : 'non-owner'; },
    async close() {
      stop.abort();
      await new Promise<void>(resolve => { if (!deliverWipeGuardTerminal({ eventId: 'fixture-terminal', provider: 'claude' as const, createdAt: new Date().toISOString(), type: 'turn.completed', threadId: 't', turnId: 'turn', ok: true }, () => resolve())) resolve(); });
      restore(); f.dispose(); removeTempDirSync(parent);
    } };
}

it('trusted S1 owner answer credits the first concrete exec before native release, once', async () => {
  const x = await integrated();
  try {
    let beforeRelease: string | undefined;
    x.f.respond.mockImplementationOnce(async () => { beforeRelease = (await x.request()).decision; return { state: 'accepted' }; });
    const result = d.decide(x.f.open('text', { command: `rm -rf -- '${x.project}'`, cwd: x.parent }, { executionCwd: x.parent }), baseRun);
    expect(result.kind).toBe('card'); if (result.kind !== 'card') throw Error('card-required');
    await d.presentApproval(result.ref, { title: 'Wipe', subtitle: 'Fixture' });
    await d.answerApproval(result.ref, { behavior: 'allow' });
    expect(beforeRelease).toBe('allow'); expect(x.cards()).toBe(0);
    expect((await x.request()).decision).toBe('deny'); expect(x.cards()).toBe(1);
  } finally { await x.close(); }
});

it('a lower level disables the guard, but neither wrong credentials nor a dead turn can allow', async () => {
  const x = await integrated();
  try {
    x.setEnabled(false);
    expect((await x.request()).decision).toBe('allow'); expect(x.cards()).toBe(0);
    expect((await x.request({ token: 'wrong' })).decision).toBe('deny');
    x.setOwner(false); expect((await x.request()).decision).toBe('deny');
    x.setOwner(true); x.setLive(false); expect((await x.request()).decision).toBe('deny'); expect(x.cards()).toBe(0);
  } finally { await x.close(); }
});

it('an exec-card owner answer cannot mint another text credit for the projected command', async () => {
  let x: Awaited<ReturnType<typeof integrated>>, cards = 0;
  x = await integrated(async request => {
    cards++;
    if (cards > 1) return 'deny';
    const result = d.decide(x.f.open('exec-card', { command: request.cardCommand, cwd: request.cwd }, { executionCwd: request.cwd }), baseRun);
    expect(result.kind).toBe('card'); if (result.kind !== 'card') return 'deny';
    await d.presentApproval(result.ref, { title: 'Wipe', subtitle: 'Fixture' });
    await d.answerApproval(result.ref, { behavior: 'allow' });
    return 'allow';
  });
  try {
    expect((await x.request()).decision).toBe('allow'); expect(cards).toBe(1);
    expect((await x.request()).decision).toBe('deny'); expect(cards).toBe(2);
  } finally { await x.close(); }
});

it('original-tool discovery skips a retained private shim copy on retry', () => {
  const parent=mkdtempSync(join(tmpdir(),'wg-int-tools-')), shim=join(parent,'private-shim'), real=join(parent,'real');
  try {
    mkdirSync(shim); mkdirSync(real);
    for(const name of ['guard.sh','guard-lib.sh','rm']) writeFileSync(join(shim,name),'#!/bin/sh\nexit 0\n',{mode:0o755});
    writeFileSync(join(real,'rm'),'#!/bin/sh\nexit 0\n',{mode:0o755});
    expect(wipeGuardRealTools([shim,real].join(delimiter),process.platform,join(parent,'resources')).rm)
      .toBe(process.platform==='win32'?join(real,'rm').replaceAll('\\','/'):join(real,'rm'));
  } finally { removeTempDirSync(parent); }
});
