// SPDX-License-Identifier: AGPL-3.0-or-later
// Real decision/card/owner-answer path in the existing isolated decision host.
// Transport only returns a receipt; no delete command or real engine is run.
import { connect } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { d, fixture, baseRun } from '../decision/fixture.ts';
import { installWipeContextReader } from '../wipe/context.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { startWipeGuardTurn } from './server.ts';
import type { ApprovalRef } from '../decision/index.ts';

for (const ownerAnswer of ['allow', 'deny', 'stop'] as const) it('uses the existing wipe card and owner ' + ownerAnswer + ' receipt', async () => {
  const f = fixture(), parent = mkdtempSync(join(tmpdir(), 'wg-card-')), project = join(parent, 'project'); mkdirSync(project);
  const context = { cwd: parent, project, home: join(parent, 'home'), dataDir: join(parent, 'data') };
  const restore = installWipeContextReader(() => context);
  const stop = new AbortController();
  let shown!: (ref: ApprovalRef) => void;
  const cardShown = new Promise<ApprovalRef>(resolve => { shown = resolve; });
  let ownerReceipt!: (answer: 'allow' | 'deny') => void;
  f.respond.mockImplementation(async (_target, answer) => { ownerReceipt(answer.behavior === 'allow' ? 'allow' : 'deny'); return { state: 'accepted' }; });
  const guard = await startWipeGuardTurn({ directory: parent, threadId: 't', roots: [project], client: [process.execPath, fileURLToPath(new URL('./client.mjs', import.meta.url))],
    realTools: { rm: process.execPath }, context, isLive: () => true, signal: stop.signal,
    askWipe: async (card, signal) => {
      const outcome = d.decide(f.open(card.id, { command: card.cardCommand, cwd: card.cwd }), baseRun);
      expect(outcome.kind).toBe('card');
      if (outcome.kind !== 'card') return 'deny';
      await d.presentApproval(outcome.ref, { title: 'Wipe', subtitle: 'Fixture' });
      expect(d.readApproval(outcome.ref.approvalId)).toMatchObject({ why: 'wipe', state: 'open' });
      const receipt = new Promise<'allow' | 'deny'>(resolve => { ownerReceipt = resolve; });
      signal.addEventListener('abort', () => {
        // Withdraw an unanswered existing card on Stop; an answered receipt
        // is already terminal and does not need a second cancellation.
        if (d.readApproval(outcome.ref.approvalId)?.state === 'open')
          void d.cancelRequests({ kind: 'thread', threadId: 't' }, 'cancelled').then(() => ownerReceipt('deny'));
      }, { once: true });
      shown(outcome.ref); return receipt;
    } });
  try {
    const data = JSON.parse(readFileSync(guard.file, 'utf8'));
    const pending = new Promise<{ decision: string }>((resolve, reject) => {
      const socket = connect(data.socket); let buffer = ''; socket.once('error', reject);
      socket.once('connect', () => socket.write(JSON.stringify({ v: 1, kind: 'wipe-exec', id: 'fixture-request', token: data.token, threadId: 't', tool: 'rm', argv: ['-rf', '--', project], cwd: parent, targets: [project] }) + '\n'));
      socket.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { socket.destroy(); resolve(JSON.parse(buffer)); } });
    });
    const ref = await cardShown;
    expect(f.respond).not.toHaveBeenCalled();
    if (ownerAnswer === 'stop') stop.abort();
    else await d.answerApproval(ref, { behavior: ownerAnswer });
    expect((await pending).decision).toBe(ownerAnswer === 'allow' ? 'allow' : 'deny');
    if (ownerAnswer === 'stop') {
      await d.cancelRequests({ kind: 'thread', threadId: 't' }, 'cancelled');
      expect(d.readApproval(ref.approvalId)).toMatchObject({ why: 'wipe', state: 'cancelled' });
    } else {
      expect(f.respond).toHaveBeenCalledTimes(1);
      expect(d.readApproval(ref.approvalId)).toMatchObject({ why: 'wipe', state: 'answered' });
    }
  } finally { await guard.end(); restore(); f.dispose(); removeTempDirSync(parent); }
});

it('spends the target fingerprint from an actual owner-approved text card without another card', async () => {
  const f = fixture(), parent = mkdtempSync(join(tmpdir(), 'wg-card-')), project = join(parent, 'project'); mkdirSync(project);
  const context = { cwd: parent, project, home: join(parent, 'home'), dataDir: join(parent, 'data') };
  const restore = installWipeContextReader(() => context);
  let execCards = 0;
  const guard = await startWipeGuardTurn({ directory: parent, threadId: 't', roots: [project], client: [process.execPath, fileURLToPath(new URL('./client.mjs', import.meta.url))],
    realTools: { rm: process.execPath }, context, isLive: () => true, askWipe: async () => { execCards++; return 'deny'; } });
  try {
    const argv = ['-rf', '--', project];
    const outcome = d.decide(f.open('fixture-text', { argv: ['rm', ...argv], cwd: parent }), baseRun);
    expect(outcome.kind).toBe('card'); if (outcome.kind !== 'card') throw Error('fixture-text-card-required');
    await d.presentApproval(outcome.ref, { title: 'Wipe', subtitle: 'Fixture' });
    await d.answerApproval(outcome.ref, { behavior: 'allow' });
    expect(d.readApproval(outcome.ref.approvalId)).toMatchObject({ why: 'wipe', state: 'answered' });
    expect(f.respond).toHaveBeenCalledTimes(1);
    expect(guard.approveOnce({ tool: 'rm', argv, cwd: parent, targets: [project] })).toBe(true);
    const data = JSON.parse(readFileSync(guard.file, 'utf8'));
    const reply = await new Promise<{ decision: string }>((resolve, reject) => {
      const socket = connect(data.socket); let buffer = ''; socket.once('error', reject);
      socket.once('connect', () => socket.write(JSON.stringify({ v: 1, kind: 'wipe-exec', id: 'fixture-exec', token: data.token, threadId: 't', tool: 'rm', argv, cwd: parent, targets: [project] }) + '\n'));
      socket.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { socket.destroy(); resolve(JSON.parse(buffer)); } });
    });
    expect(reply.decision).toBe('allow'); expect(execCards).toBe(0); expect(d.openApprovals('t')).toHaveLength(0);
  } finally { await guard.end(); restore(); f.dispose(); removeTempDirSync(parent); }
});
