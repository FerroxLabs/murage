// SPDX-License-Identifier: AGPL-3.0-or-later
// Commands are inert. Filesystem mutations stay inside this suite's scratch home.
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractInspectedOperation } from '../no-limits-operation.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { approvedEvidenceCovers, inspectReleaseWipes, installReleaseContextReader, releaseGuard, type ReleaseRequest } from './release-guard.ts';
import type { ApprovalRef } from './types.ts';
import { fixture, d, baseCard } from './fixture.ts';
import { guardEngineRelease } from './provider-release.ts';
const roots: string[] = [];
let dispose = () => {};
afterEach(async () => { dispose(); for (const root of roots.splice(0)) await removeTempDir(root); });
function scratch() {
  const cwd = mkdtempSync(join(tmpdir(), 'release-r4-')); roots.push(cwd);
  mkdirSync(join(cwd, 'out'));
  for (const name of ['a', 'b']) writeFileSync(join(cwd, name), 'inert fixture');
  for (const name of ['disk', 'first', 'second']) symlinkSync('../a', join(cwd, 'out', name));
  return cwd;
}
function retarget(cwd: string, path: string, target = '../b') {
  unlinkSync(join(cwd, path)); symlinkSync(target, join(cwd, path));
}
function request(command: string, cwd: string): ReleaseRequest {
  const result = extractInspectedOperation({ tool: 'Bash', input: { command, cwd } });
  if (result.kind === 'incomplete') throw Error('operation required');
  return { requestKey: 'r4:g:r', threadId: 't', generation: 'g', ...result, releaseKind: 'exec' };
}
const repros = [
  ['fat-option-value', 'mkfs.fat -F 32 out/disk', 'out/disk'],
  ['btrfs-second-device', 'mkfs.btrfs out/first out/second', 'out/second'],
  ['delete-system-retarget', 'rm -rf out/system/', 'out/system'],
] as const;
it.each(repros)('R4 guard %s reuses unchanged approval and holds a retarget', (_id, command, path) => {
  const cwd = scratch(); symlinkSync('/etc', join(cwd, 'out/system'));
  const r = request(command, cwd), ref = {} as ApprovalRef;
  const initial = { decisions: [], wipes: inspectReleaseWipes(r.exactOperation) };
  expect(initial.wipes).toHaveLength(1);
  dispose = installReleaseContextReader(() => ({ posture: 'owner-no-limits', operationHash: r.operationHash,
    inspect: () => ({ decisions: [] }), approved: () => ({ operationHash: r.operationHash, inspection: initial }) }));
  expect(releaseGuard({ ...r, approvedEvidence: ref }).kind).toBe('release');
  retarget(cwd, path, path === 'out/system' ? '/usr' : '../b');
  expect(approvedEvidenceCovers({ decisions: [], wipes: inspectReleaseWipes(r.exactOperation) }, initial)).toBe(false);
  expect(releaseGuard({ ...r, approvedEvidence: ref }).kind).toBe('hold');
});
it.each(repros)('R4 product %s refreshes the card and then releases only the new approval', async (_id, command, path) => {
  const cwd = scratch(); symlinkSync('/etc', join(cwd, 'out/system'));
  const input = { command, cwd }, f = fixture();
  try {
    const h = f.open('r4-retarget', input, { tool: 'Bash', toolCall: { name: 'Bash', input } });
    const outcome = d.decide(h, baseCard); expect(outcome.kind).toBe('card');
    if (outcome.kind !== 'card') throw Error('wipe card required');
    await d.presentApproval(outcome.ref, { title: 'Wipe', subtitle: 'Inert fixture' });
    retarget(cwd, path, path === 'out/system' ? '/usr' : '../b');
    await d.answerApproval(outcome.ref, { behavior: 'allow' });
    expect(f.respond).not.toHaveBeenCalled();
    const pending = d.openApprovals('t'); expect(pending).toHaveLength(1);
    expect(pending[0].why).toBe('wipe'); expect(pending[0].ref).not.toBe(outcome.ref);
    await expect(d.answerApproval(outcome.ref, { behavior: 'allow' })).rejects.toThrow('unissued-approval-ref');
    expect(f.respond).not.toHaveBeenCalled();
    await d.answerApproval(pending[0].ref, { behavior: 'allow' });
    expect(f.respond).toHaveBeenCalledOnce(); expect(f.respond.mock.calls[0][1]).toMatchObject({ behavior: 'allow' });
  } finally { f.dispose(); }
});
it.each(repros)('R4 product %s unchanged command reuse releases', async (_id, command) => {
  const cwd = scratch(); symlinkSync('/etc', join(cwd, 'out/system'));
  const input = { command, cwd }, f = fixture();
  try {
    const h = f.open('r4-unchanged', input, { tool: 'Bash', toolCall: { name: 'Bash', input } });
    const outcome = d.decide(h, baseCard); expect(outcome.kind).toBe('card');
    if (outcome.kind !== 'card') throw Error('wipe card required');
    await d.presentApproval(outcome.ref, { title: 'Wipe', subtitle: 'Inert fixture' });
    await d.answerApproval(outcome.ref, { behavior: 'allow' });
    expect(f.respond).toHaveBeenCalledOnce(); expect(d.openApprovals('t')).toHaveLength(0);
  } finally { f.dispose(); }
});
it.each([
  'mkfs.fat -F 16 out/disk', 'mkfs.fat 32 -F out/disk',
  'mkfs.fat -F 32 out/disk out/disk', 'mkfs.fat -F 32 out/first',
])('R4 exact ordered argv rejects changed tokens: %s', changed => {
  const cwd = scratch();
  const inspect = (command: string) => ({ decisions: [], wipes: inspectReleaseWipes(request(command, cwd).exactOperation) });
  expect(approvedEvidenceCovers(inspect(changed), inspect('mkfs.fat -F 32 out/disk'))).toBe(false);
});
it.each(['create', 'remove', 'inode', 'option-value', 'flag', 'directory', 'program', 'symlink-chain', 'device'] as const)('R4 every existing token binds canonical target and device/inode: %s', change => {
  const cwd = scratch();
  if (change === 'remove') writeFileSync(join(cwd, '32'), 'fixture');
  if (change === 'option-value') symlinkSync('a', join(cwd, '32'));
  if (change === 'flag') symlinkSync('a', join(cwd, '-F'));
  if (change === 'directory') {
    for (const name of ['dir-a', 'dir-b']) mkdirSync(join(cwd, name));
    symlinkSync('dir-a', join(cwd, '32'));
  }
  if (change === 'program') symlinkSync('a', join(cwd, 'mkfs.fat'));
  if (change === 'symlink-chain') { retarget(cwd, 'out/disk', '../chain'); symlinkSync('a', join(cwd, 'chain')); }
  if (change === 'device') retarget(cwd, 'out/disk', '/dev/zero');
  const r = request('mkfs.fat -F 32 out/disk', cwd);
  const initial = { decisions: [], wipes: inspectReleaseWipes(r.exactOperation) };
  if (change === 'create') writeFileSync(join(cwd, '32'), 'fixture');
  if (change === 'remove') unlinkSync(join(cwd, '32'));
  if (change === 'inode') { writeFileSync(join(cwd, 'replacement'), 'new object'); renameSync(join(cwd, 'replacement'), join(cwd, 'a')); }
  if (change === 'option-value') retarget(cwd, '32', 'b');
  if (change === 'flag') retarget(cwd, '-F', 'b');
  if (change === 'directory') retarget(cwd, '32', 'dir-b');
  if (change === 'program') retarget(cwd, 'mkfs.fat', 'b');
  if (change === 'symlink-chain') retarget(cwd, 'chain', 'b');
  if (change === 'device') retarget(cwd, 'out/disk', '/dev/null');
  expect(approvedEvidenceCovers({ decisions: [], wipes: inspectReleaseWipes(r.exactOperation) }, initial)).toBe(false);
});
it('R4 resolution errors never reuse the old approval', () => {
  const cwd = scratch(), r = request('mkfs.fat -F 32 out/disk', cwd), ref = {} as ApprovalRef;
  const initial = { decisions: [], wipes: inspectReleaseWipes(r.exactOperation) };
  dispose = installReleaseContextReader(() => ({ posture: 'owner-no-limits', operationHash: r.operationHash,
    inspect: () => ({ decisions: [] }), approved: () => ({ operationHash: r.operationHash, inspection: initial }) }));
  retarget(cwd, 'out/disk', 'disk');
  expect(releaseGuard({ ...r, approvedEvidence: ref }).kind).toBe('hold');
});
it('R4 losing the wipe classification still requires a new decision', async () => {
  const cwd = scratch(); mkdirSync(join(cwd, 'ordinary')); symlinkSync('/etc', join(cwd, 'out/system'));
  const input = { command: 'rm -rf out/system/', cwd }, f = fixture();
  try {
    const h = f.open('r4-class-change', input, { tool: 'Bash', toolCall: { name: 'Bash', input } });
    const outcome = d.decide(h, baseCard); expect(outcome.kind).toBe('card');
    if (outcome.kind !== 'card') throw Error('wipe card required');
    await d.presentApproval(outcome.ref, { title: 'Wipe', subtitle: 'Inert fixture' });
    retarget(cwd, 'out/system', '../ordinary');
    await d.answerApproval(outcome.ref, { behavior: 'allow' });
    // MAIN RULING 2026-11-13 narrow-wipe (Sean): the fresh target is ordinary, so the breaker no longer cards.
    expect(f.respond).toHaveBeenCalledOnce();
    expect(d.openApprovals('t')).toHaveLength(0);
  } finally { f.dispose(); }
});
it.each(['out/disk', 'out/disk/', 'out/disk/child'])('R4 dangling link resolution is an error, including trailing slash: %s', path => {
  const cwd = scratch(); retarget(cwd, 'out/disk', '../missing');
  expect(() => inspectReleaseWipes(request('mkfs.fat -F 32 ' + path, cwd).exactOperation)).toThrow();
});
it.each(repros)('R4 final writer %s rechecks after approval delivery begins', async (_id, command, path) => {
  const cwd = scratch(); symlinkSync('/etc', join(cwd, 'out/system'));
  const input = { command, cwd }, f = fixture(); let released: boolean | undefined;
  try {
    const h = f.open('r4-final-writer', input, { tool: 'Bash', toolCall: { name: 'Bash', input } });
    const outcome = d.decide(h, baseCard); expect(outcome.kind).toBe('card');
    if (outcome.kind !== 'card') throw Error('wipe card required');
    await d.presentApproval(outcome.ref, { title: 'Wipe', subtitle: 'Inert fixture' });
    f.respond.mockImplementation(async target => {
      retarget(cwd, path, path === 'out/system' ? '/usr' : '../b');
      released = guardEngineRelease(target);
      return { state: 'failed' };
    });
    await d.answerApproval(outcome.ref, { behavior: 'allow' });
    expect(released).toBe(false); expect(f.respond).toHaveBeenCalledOnce();
    expect(d.openApprovals('t')).toHaveLength(1); expect(d.openApprovals('t')[0].why).toBe('wipe');
  } finally { f.dispose(); }
});
it('R4 realpath resolves symlink components before dot-dot', () => {
  const cwd = scratch();
  for (const dir of ['one', 'two']) mkdirSync(join(cwd, dir, 'inner'), { recursive: true });
  symlinkSync('../one/inner', join(cwd, 'out/branch'));
  const r = request('mkfs.fat -F 32 out/branch/..', cwd);
  const initial = { decisions: [], wipes: inspectReleaseWipes(r.exactOperation) };
  retarget(cwd, 'out/branch', '../two/inner');
  expect(approvedEvidenceCovers({ decisions: [], wipes: inspectReleaseWipes(r.exactOperation) }, initial)).toBe(false);
});
it('R4 a different link chain to the same canonical object preserves the fingerprint', () => {
  const cwd = scratch(), r = request('mkfs.fat -F 32 out/disk', cwd);
  const initial = { decisions: [], wipes: inspectReleaseWipes(r.exactOperation) };
  symlinkSync('a', join(cwd, 'chain')); retarget(cwd, 'out/disk', '../chain');
  expect(approvedEvidenceCovers({ decisions: [], wipes: inspectReleaseWipes(r.exactOperation) }, initial)).toBe(true);
});
it('R4 cmd normalization preserves literal backslashes in argv', () => {
  const cwd = scratch(), path = 'out\\cmd-disk';
  symlinkSync(join(cwd, 'a'), join(cwd, path));
  const operation = extractInspectedOperation({ tool: 'cmd', input: { command: 'mkfs.fat -F 32 ' + path, cwd } });
  if (operation.kind === 'incomplete') throw Error('operation required');
  const initial = { decisions: [], wipes: inspectReleaseWipes(operation.exactOperation) };
  expect(initial.wipes).toHaveLength(1);
  retarget(cwd, path, join(cwd, 'b'));
  expect(approvedEvidenceCovers({ decisions: [], wipes: inspectReleaseWipes(operation.exactOperation) }, initial)).toBe(false);
});
it('R4 repeated Allow never bypasses a filesystem resolution error', async () => {
  const cwd = scratch(); retarget(cwd, 'out/disk', '../missing');
  const input = { command: 'mkfs.fat -F 32 out/disk/', cwd }, f = fixture();
  try {
    const h = f.open('r4-error-repeat', input, { tool: 'Bash', toolCall: { name: 'Bash', input } });
    const outcome = d.decide(h, baseCard); expect(outcome.kind).toBe('card');
    if (outcome.kind !== 'card') throw Error('wipe card required');
    await d.presentApproval(outcome.ref, { title: 'Wipe', subtitle: 'Inert fixture' });
    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = d.openApprovals('t'); expect(pending).toHaveLength(1);
      await d.answerApproval(pending[0].ref, { behavior: 'allow' });
      expect(f.respond).not.toHaveBeenCalled(); expect(d.openApprovals('t')).toHaveLength(1);
    }
  } finally { f.dispose(); }
});
it('R4 an unchanged command with absent ordinary tokens has a reusable fingerprint', async () => {
  const cwd = scratch(), input = { command: 'mkfs.fat -F 32 absent', cwd }, f = fixture();
  try {
    const h = f.open('r4-absent-unchanged', input, { tool: 'Bash', toolCall: { name: 'Bash', input } });
    const outcome = d.decide(h, baseCard); expect(outcome.kind).toBe('card');
    if (outcome.kind !== 'card') throw Error('wipe card required');
    await d.presentApproval(outcome.ref, { title: 'Wipe', subtitle: 'Inert fixture' });
    await d.answerApproval(outcome.ref, { behavior: 'allow' });
    expect(f.respond).toHaveBeenCalledOnce(); expect(d.openApprovals('t')).toHaveLength(0);
  } finally { f.dispose(); }
});
