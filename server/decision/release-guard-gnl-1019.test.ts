// SPDX-License-Identifier: AGPL-3.0-or-later
// Commands are inert data. All filesystem changes stay in the throwaway home.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractInspectedOperation } from '../no-limits-operation.ts';
import { inspectNativeEffects } from '../no-limits-fs.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { installReleaseContextReader, releaseGuard, type ReleaseInspection, type ReleaseRequest } from './release-guard.ts';
import { fixture, d, baseCard } from './fixture.ts';

let dispose = () => {};
const roots: string[] = [];
afterEach(async () => { dispose(); for (const root of roots.splice(0)) await removeTempDir(root); });
function root() { const path = mkdtempSync(join(tmpdir(), 'gnl-final-')); roots.push(path); return path; }
function request(tool: string, input: unknown, cwd: string): ReleaseRequest {
  const operation = extractInspectedOperation({ tool, input }, { cwd });
  if (operation.kind === 'incomplete') throw Error('operation not extracted');
  return { requestKey: 'owner:g:release', threadId: 't', generation: 'g', ...operation, releaseKind: 'native' };
}
function bind(r: ReleaseRequest, inspect: (operation: ReleaseRequest['exactOperation']) => ReleaseInspection) {
  dispose = installReleaseContextReader(identity => identity.threadId === r.threadId && identity.generation === r.generation && identity.requestKey === r.requestKey
    ? { posture: 'owner-no-limits', operationHash: r.operationHash, inspect, approved: () => undefined } : undefined);
}

it('authenticated owner No limits releases a fresh protected-only destination', () => {
  const home = root(), work = join(home, 'work');
  mkdirSync(work); mkdirSync(join(home, '.ssh')); writeFileSync(join(home, '.ssh/config'), 'fixture');
  const r = request('write_file', { path: 'notes', content: 'fixture' }, work);
  const inspect = vi.fn((operation: ReleaseRequest['exactOperation']) => {
    if (operation.kind !== 'native') throw Error('native required');
    return inspectNativeEffects(operation.effects, { cwd: work, home });
  });
  bind(r, inspect);
  expect(releaseGuard(r).kind).toBe('release');
  symlinkSync(join(home, '.ssh/config'), join(work, 'notes'));
  expect(inspect(r.exactOperation).decisions).toContainEqual(expect.objectContaining({ ruleId: 'ssh' }));
  expect(releaseGuard(r).kind).toBe('release');
});

it('authenticated owner No limits holds fresh wipe evidence after a symlink changes', () => {
  const work = root(), safe = join(work, 'safe'), target = join(work, 'target');
  mkdirSync(safe); symlinkSync(safe, target);
  const r = request('Bash', { command: 'rm -rf target/', cwd: work }, work);
  // Protected-path diagnostics cannot substitute for the fresh wipe scan.
  bind(r, () => ({ decisions: [] }));
  expect(releaseGuard(r).kind).toBe('release');
  unlinkSync(target); symlinkSync('/', target);
  expect(releaseGuard(r).kind).toBe('hold');
});

it.each([
  ['Bash', { command: 'rm -rf /' }],
  ['python', { code: "import shutil; shutil.rmtree('/')" }],
  ['node', { code: "require('fs').rmSync('/', {recursive:true})" }],
  ['delete_file', { path: '/' }],
] as const)('authenticated owner No limits holds a named wipe from %s', (tool, input) => {
  const r = request(tool, input, root()); bind(r, () => ({ decisions: [] }));
  // MAIN RULING WIPE-GATE-BAR / 1114-WIPE-FIXTURE-DIRECTION: literal native filesystem-root wipes retain their hold.
  expect(releaseGuard(r).kind).toBe('hold');
});

it.each(['owner', 'webhook', 'routine'] as const)('%s No limits protected-only delivery runs', async origin => {
  const f = fixture('unlimited', origin === 'webhook' ? { k: 'webhook' } : origin === 'routine'
    ? { k: 'routine-run', form: 'run', sourceRunId: 'run', sourceBotId: 'b', recipientGeneration: 'g', trigger: 'schedule' }
    : { k: 'owner-typed' });
  if (origin === 'routine') d.installProvenanceReader({
    turnGenerationFor: () => 'g', provenance: () => ({ generation: 'g', threadId: 't', botId: 'b', principal: 'owner', roomOwnerOnly: true, at: 1,
      initiator: { k: 'routine-run', form: 'run', sourceRunId: 'run', sourceBotId: 'b', recipientGeneration: 'g', trigger: 'schedule' } }),
    live: () => ({ botId: 'b', turnId: 'turn', providerInstanceId: 'p', principal: 'owner', owner: true, level: 'unlimited',
      routine: { sourceRunId: 'run', sourceBotId: 'b', recipientGeneration: 'g', owner: true } }),
  });
  try {
    const h = f.open('protected', { command: 'printf fixture > ~/.ssh/config' });
    expect(d.decide(h, baseCard).kind).toBe('run'); await d.deliverRequest(h);
    expect(f.respond).toHaveBeenCalledOnce(); expect(f.respond.mock.calls[0][1].behavior).toBe('allow');
    expect(d.openApprovals('t')).toEqual([]);
  } finally { f.dispose(); }
});

it.each(['guest', 'other-human', 'ask', 'auto', 'full'] as const)('%s retains its existing approval card', async actor => {
  const f = fixture(actor === 'ask' || actor === 'auto' || actor === 'full' ? actor : 'unlimited',
    actor === 'guest' ? { k: 'guest' } : actor === 'other-human' ? { k: 'other-human' } : { k: 'owner-typed' });
  if (actor === 'guest' || actor === 'other-human') f.setOwner(false);
  try {
    const h = f.open('protected', { command: 'printf fixture > ~/.ssh/config' }), outcome = d.decide(h, baseCard);
    expect(outcome.kind).toBe('card');
    if (outcome.kind !== 'card') throw Error('expected existing Ask behavior');
    await d.presentApproval(outcome.ref, { title: 'Fixture', subtitle: 'Protected write' }); await d.deliverRequest(h);
    expect(d.openApprovals('t')).toHaveLength(1); expect(f.respond).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});

it('production durable owner recovery releases non-wipes with no live record and retains wipe cards', async () => {
  const f = fixture();
  d.installProvenanceReader({ turnGenerationFor: () => 'g',
    provenance: () => ({ generation: 'g', threadId: 't', botId: 'b', principal: 'owner', roomOwnerOnly: true, at: 1, initiator: { k: 'owner-typed' } }),
    live: () => undefined,
    ownerThread: () => ({ botId: 'b', principal: 'owner', level: 'unlimited', origin: 'owner' }) });
  try {
    const h = f.open('lost-live', { command: 'printf fixture > ~/.ssh/config' });
    expect(d.decide(h, baseCard).kind).toBe('run'); await d.deliverRequest(h);
    expect(f.respond).toHaveBeenCalledOnce(); expect(f.respond.mock.calls[0][1].behavior).toBe('allow');
    const wipe = d.decide(f.open('lost-live-wipe', { command: 'rm -rf /' }), baseCard);
    expect(wipe.kind).toBe('card');
    if (wipe.kind !== 'card') throw Error('expected wipe card');
    await d.presentApproval(wipe.ref, { title: 'Wipe', subtitle: 'Inert fixture data' });
    expect(d.readApproval(wipe.ref.approvalId)).toMatchObject({ why: 'wipe' });
    expect(f.respond).toHaveBeenCalledOnce();
  } finally { f.dispose(); }
});

it.each([
  { level: 'ask', origin: 'owner' },
  { level: 'unlimited', origin: 'other-human' },
] as const)('missing live authority cannot elevate $origin at $level', async ({ level, origin }) => {
  const f = fixture();
  d.installProvenanceReader({ turnGenerationFor: () => 'g', provenance: () => undefined, live: () => undefined,
    ownerThread: () => origin === 'other-human' ? undefined : ({ botId: 'b', principal: 'owner', level, origin }) });
  try {
    const h = f.open('lost-live-ineligible', { command: 'printf fixture > ~/.ssh/config' });
    expect(d.decide(h, baseCard).kind).toBe('refuse'); await d.deliverRequest(h);
    expect(f.respond).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});
