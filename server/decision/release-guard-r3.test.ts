// SPDX-License-Identifier: AGPL-3.0-or-later
// Commands are inert strings. Only scratch-directory symlinks are mutated.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractInspectedOperation } from '../no-limits-operation.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { approvedEvidenceCovers, installReleaseContextReader, inspectReleaseWipes, releaseGuard, type ReleaseRequest } from './release-guard.ts';
import type { ApprovalRef } from './types.ts';
import { fixture, d, baseCard } from './fixture.ts';
let dispose = () => {};
const roots: string[] = [];
afterEach(async () => { dispose(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await removeTempDir(root); });
function scratch() {
  const cwd = mkdtempSync(join(tmpdir(), 'release-r3-')); roots.push(cwd);
  // MAIN RULING 2026-11-12 release-guard fingerprint: canonical object identities require existing targets; dangling /dev/sda cannot be approved.
  mkdirSync(join(cwd, 'out')); mkdirSync(join(cwd, 'dev'));
  for (const name of ['sda', 'sdb']) writeFileSync(join(cwd, 'dev', name), 'inert image');
  symlinkSync(join(cwd, 'dev/sda'), join(cwd, 'out/disk'));
  return cwd;
}
function request(command: string, cwd: string): ReleaseRequest {
  const result = extractInspectedOperation({ tool: 'Bash', input: { command, cwd } });
  if (result.kind === 'incomplete') throw Error('operation required');
  return { requestKey: 'r3:g:r', threadId: 't', generation: 'g', ...result, releaseKind: 'exec' };
}
const commands = [
  'mkfs.ext4 out/disk', 'mkfs -t ext4 out/disk', 'mke2fs -t ext4 out/disk',
  'wipefs --all out/disk', 'wipefs -a --types ext4 out/disk', 'dd if=/dev/zero of=out/disk',
  'diskutil eraseDisk APFS Blank out/disk', 'diskutil partitionDisk out/disk GPT APFS Blank 100%',
  'sgdisk -Z out/disk', 'blkdiscard out/disk', 'shred -n 1 out/disk',
  'sudo mkfs.ext4 -F -L fixture out/disk', 'sh -c "mkfs.ext4 out/disk"',
  'cd out && mkfs.ext4 disk',
];
it.each(commands)('H1 disk operand is a write target and approval follows its canonical destination: %s', command => {
  const cwd = scratch(), r = request(command, cwd), ref = {} as ApprovalRef;
  // MAIN RULING 2026-11-12 release-guard fingerprint: approval binds every resolving token, replacing operand read/write roles and target-only diagnostics.
  const initial = { decisions: [], wipes: inspectReleaseWipes(r.exactOperation) };
  // MAIN RULING: REDESIGN-WIPE-NARROW §0 (Sean, 2026-11-13).: inert images and unlisted tools are not raw-disk wipes.
  // MAIN RULING: REDESIGN-WIPE-NARROW §4.5 names mke2fs as an unconditional disk tool.
  const scoped=!['dd','sgdisk','blkdiscard','shred'].includes(command.split(' ')[0]!);
  expect(initial.wipes).toHaveLength(scoped?1:0);
  if(scoped){expect(initial.wipes[0].hit.rule).toBe('disk-erase');expect(initial.wipes[0].resolvedTargets).toContain(join(cwd, 'dev/sda'));}
  dispose = installReleaseContextReader(() => ({ posture: 'owner-no-limits', operationHash: r.operationHash,
    inspect: () => ({ decisions: [] }), approved: candidate => candidate === ref ? { operationHash: r.operationHash, inspection: initial } : undefined }));
  expect(releaseGuard({ ...r, approvedEvidence: ref }).kind).toBe('release');
  unlinkSync(join(cwd, 'out/disk')); symlinkSync(join(cwd, 'dev/sdb'), join(cwd, 'out/disk'));
  if(scoped)expect(inspectReleaseWipes(r.exactOperation)[0].resolvedTargets).toContain(join(cwd, 'dev/sdb'));
  expect(releaseGuard({ ...r, approvedEvidence: ref }).kind).toBe(scoped?'hold':'release');
});
it.each(['format C:', 'Clear-Disk -Number 1', 'Format-Volume -DriveLetter D', 'diskpart clean'])('H1 unresolved platform wipe cannot reuse an empty approval: %s', command => {
  const r = request(command, scratch()), ref = {} as ApprovalRef;
  const initial = { decisions: [], wipes: inspectReleaseWipes(r.exactOperation) };
  expect(initial.wipes).toHaveLength(1);
  // MAIN RULING 2026-11-12 release-guard fingerprint: absent selector tokens have a reusable exact fingerprint; diagnostic target lists do not authorize release.
  const empty = { decisions: [], wipes: initial.wipes.map(wipe => ({ ...wipe, resolvedTargets: [] })) };
  expect(approvedEvidenceCovers(empty, empty)).toBe(true);
  dispose = installReleaseContextReader(() => ({ posture: 'owner-no-limits', operationHash: r.operationHash,
    inspect: () => ({ decisions: [] }), approved: () => ({ operationHash: r.operationHash, inspection: empty }) }));
  expect(releaseGuard({ ...r, approvedEvidence: ref }).kind).toBe('release');
  const changed = request(command + ' changed-token', r.exactOperation.cwd!);
  expect(approvedEvidenceCovers({ decisions: [], wipes: inspectReleaseWipes(changed.exactOperation) }, empty)).toBe(false);
});
it('H1 coverage requires exact nonempty canonical target sets and wipe classes', () => {
  const hit = { rule: 'disk-erase', what: 'fixture' } as const;
  const evidence = (targets: string[], rule = hit.rule as string) => ({ decisions: [], wipes: [{ hit: { ...hit, rule }, resolvedTargets: targets }] }) as Parameters<typeof approvedEvidenceCovers>[0];
  // MAIN RULING 2026-11-12 release-guard fingerprint: legacy synthetic target sets lack an issued fingerprint and never cover an approval.
  expect(approvedEvidenceCovers(evidence(['/dev/sdb', '/dev/sda', '/dev/sda']), evidence(['/dev/sda', '/dev/sdb']))).toBe(false);
  const r = request('mkfs.ext4 out/disk', scratch());
  const actual = { decisions: [], wipes: inspectReleaseWipes(r.exactOperation) };
  expect(approvedEvidenceCovers(actual, actual)).toBe(true);
  expect(approvedEvidenceCovers(actual, { ...actual, wipes: actual.wipes.map(wipe => ({ ...wipe, hit: { ...wipe.hit, rule: 'delete-root' } })) })).toBe(false);
  expect(approvedEvidenceCovers(evidence(['/dev/sda']), evidence(['/dev/sda', '/dev/sdb']))).toBe(false);
  expect(approvedEvidenceCovers(evidence(['/dev/sda', '/dev/sdb']), evidence(['/dev/sda']))).toBe(false);
  expect(approvedEvidenceCovers(evidence(['/dev/sda']), evidence(['/dev/sda'], 'delete-root'))).toBe(false);
  expect(approvedEvidenceCovers(evidence([]), evidence([]))).toBe(false);
});
it.each([false, true])('H1 product mkfs approval retarget=%s never delivers stale targets', async changed => {
  // MAIN RULING 2026-11-12 release-guard fingerprint: unchanged approval reuse is tested against an existing object, never a dangling device link.
  const cwd = scratch(), input = { command: 'mkfs.ext4 out/disk', cwd }, f = fixture();
  try {
    const h = f.open('disk-retarget', input, { tool: 'Bash', toolCall: { name: 'Bash', input } });
    const outcome = d.decide(h, baseCard); expect(outcome.kind).toBe('card');
    if (outcome.kind !== 'card') throw Error('wipe card required');
    await d.presentApproval(outcome.ref, { title: 'Wipe', subtitle: 'Inert fixture' });
    if (changed) { unlinkSync(join(cwd, 'out/disk')); symlinkSync(join(cwd, 'dev/sdb'), join(cwd, 'out/disk')); }
    await d.answerApproval(outcome.ref, { behavior: 'allow' });
    if (changed) { expect(f.respond).not.toHaveBeenCalled(); expect(d.openApprovals('t')).toHaveLength(1); }
    else { expect(f.respond).toHaveBeenCalledOnce(); expect(f.respond.mock.calls[0][1]).toMatchObject({ behavior: 'allow' }); }
  } finally { f.dispose(); }
});
it('H1 repeated Allow cannot bypass an empty disk target set', async () => {
  const input = { command: 'diskpart clean', cwd: scratch() }, f = fixture();
  try {
    const h = f.open('disk-empty', input, { tool: 'Bash', toolCall: { name: 'Bash', input } });
    const outcome = d.decide(h, baseCard); expect(outcome.kind).toBe('card');
    if (outcome.kind !== 'card') throw Error('wipe card required');
    await d.presentApproval(outcome.ref, { title: 'Wipe', subtitle: 'Inert fixture' });
    // MAIN RULING 2026-11-12 release-guard fingerprint: absent platform selector objects do not block an unchanged approved argv; an answer is consumed once.
    await d.answerApproval(outcome.ref, { behavior: 'allow' });
    expect(f.respond).toHaveBeenCalledOnce(); expect(d.openApprovals('t')).toHaveLength(0);
    for (let attempt = 0; attempt < 3; attempt++) {
      await d.answerApproval(outcome.ref, { behavior: 'allow' });
      expect(f.respond).toHaveBeenCalledOnce();
    }
  } finally { f.dispose(); }
});

it('H1 disk target sets retain every operand and no option values', () => {
  // MAIN RULING 2026-11-12 release-guard fingerprint: every resolving token participates, including option values and duplicates.
  const cwd = scratch(); symlinkSync(join(cwd, 'dev/sdb'), join(cwd, 'out/other'));
  symlinkSync('/dev/null', join(cwd, 'ext4'));
  const r = request('wipefs --types ext4 --all out/other out/disk out/disk', cwd);
  const wipe = inspectReleaseWipes(r.exactOperation)[0];
  expect(wipe.resolvedTargets).toEqual(['/dev/null', join(cwd, 'dev/sda'), join(cwd, 'dev/sdb')].sort());
  const fingerprint = JSON.parse(wipe.fingerprint!);
  expect(fingerprint.commands[0].objects.filter((object: {target: string}) => object.target === join(cwd, 'dev/sda'))).toHaveLength(2);
});
it.each(['mkfs.ext4 $unresolved; mkfs.ext4 out/disk', 'mkfs.ext4 --unrecognized-option value out/disk', 'diskutil partitionDisk -force out/disk GPT APFS Blank 100%', 'diskutil eraseDisk APFS Blank out/disk -force'])('H1 incomplete destination evidence fails closed: %s', command => {
  const r = request(command, scratch()), ref = {} as ApprovalRef;
  // MAIN RULING 2026-11-12 release-guard fingerprint: unknown argv is a resolution error; unknown option grammar is irrelevant for fully known argv.
  if (command.includes('$unresolved')) {
    expect(() => inspectReleaseWipes(r.exactOperation)).toThrow('wipe-fingerprint-unknown-argv');
    dispose = installReleaseContextReader(() => ({ posture: 'owner-no-limits', operationHash: r.operationHash, inspect: () => ({ decisions: [] }), approved: () => undefined }));
    expect(releaseGuard({ ...r, approvedEvidence: ref }).kind).toBe('hold');
    return;
  }
  const initial = { decisions: [], wipes: inspectReleaseWipes(r.exactOperation) };
  expect(initial.wipes).toHaveLength(1); expect(initial.wipes[0].resolvedTargets).toContain(join(r.exactOperation.cwd!, 'dev/sda'));
  dispose = installReleaseContextReader(() => ({ posture: 'owner-no-limits', operationHash: r.operationHash,
    inspect: () => ({ decisions: [] }), approved: () => ({ operationHash: r.operationHash, inspection: initial }) }));
  expect(releaseGuard({ ...r, approvedEvidence: ref }).kind).toBe('release');
  unlinkSync(join(r.exactOperation.cwd!, 'out/disk')); symlinkSync(join(r.exactOperation.cwd!, 'dev/sdb'), join(r.exactOperation.cwd!, 'out/disk'));
  expect(releaseGuard({ ...r, approvedEvidence: ref }).kind).toBe('hold');
});

it('H1 an ordinary dd input does not add a wipe destination to an approved mkfs', () => {
  // MAIN RULING 2026-11-12 release-guard fingerprint: an absent dd input is a stable token, while the existing mkfs object binds the approval.
  const cwd = scratch(), r = request('mkfs.ext4 out/disk; dd if=notes', cwd), ref = {} as ApprovalRef;
  const initial = { decisions: [], wipes: inspectReleaseWipes(r.exactOperation) };
  expect(initial.wipes[0].resolvedTargets).toContain(join(cwd, 'dev/sda'));
  dispose = installReleaseContextReader(() => ({ posture: 'owner-no-limits', operationHash: r.operationHash,
    inspect: () => ({ decisions: [] }), approved: () => ({ operationHash: r.operationHash, inspection: initial }) }));
  expect(releaseGuard({ ...r, approvedEvidence: ref }).kind).toBe('release');
});
