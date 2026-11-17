// SPDX-License-Identifier: AGPL-3.0-or-later
// All commands are inert. Only links and files in isolated scratch roots change.
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractInspectedOperation } from '../no-limits-operation.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { approvedEvidenceCovers, inspectReleaseWipes } from './release-guard.ts';
import { fixture, d, baseCard } from './fixture.ts';
import { guardEngineRelease } from './provider-release.ts';
import { noLimitsWipe } from '../no-limits-wipe.ts';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });
function scratch(device = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'release-r5-')); roots.push(cwd);
  for (const name of ['a', 'b']) writeFileSync(join(cwd, name), 'inert fixture');
  mkdirSync(join(cwd, 'dev'));
  for (const name of ['sda', 'sdb']) writeFileSync(join(cwd, 'dev', name), 'inert image');
  symlinkSync(device ? join(cwd, 'dev/sda') : 'a', join(cwd, 'disk')); return cwd;
}
function inspect(command: string, cwd: string) {
  const exact = extractInspectedOperation({ tool: 'Bash', input: { command, cwd } });
  if (exact.kind === 'incomplete') throw Error('operation required');
  return { decisions: [], wipes: inspectReleaseWipes(exact.exactOperation) };
}
it.each(['dd if=/dev/zero of=disk', 'mkfs.ext4 --arbitrary=disk', 'mkfs.ext4 opaque=disk'])('R5 embedded path identity cannot retarget an approval: %s', command => {
  const device = command.startsWith('dd '), cwd = scratch(device), initial = inspect(command, cwd);
  // MAIN RULING 2026-11-13 narrow-wipe (Sean): dd writes to these ordinary image files run.
  expect(initial.wipes).toHaveLength(device?0:1); expect(approvedEvidenceCovers(initial, initial)).toBe(true);
  unlinkSync(join(cwd, 'disk')); symlinkSync(device ? join(cwd, 'dev/sdb') : 'b', join(cwd, 'disk'));
  expect(approvedEvidenceCovers(inspect(command, cwd), initial)).toBe(device);
});
it('R5 product dd embedded destination retarget renews its card', async () => {
  const cwd = scratch(true), input = { command: 'dd if=/dev/zero of=disk', cwd }, f = fixture();
  try {
    const h = f.open('dd-embedded', input, { tool: 'Bash', toolCall: { name: 'Bash', input } });
    // MAIN RULING 2026-11-13 narrow-wipe (Sean): both aliases point to ordinary image files, not devices.
    const outcome = d.decide(h, baseCard); expect(outcome.kind).toBe('run');
    await d.deliverRequest(h);expect(f.respond).toHaveBeenCalledOnce();
    unlinkSync(join(cwd, 'disk')); symlinkSync(join(cwd, 'dev/sdb'), join(cwd, 'disk'));
    const next=f.open('dd-retargeted',input,{tool:'Bash',toolCall:{name:'Bash',input}});
    expect(d.decide(next,baseCard).kind).toBe('run');await d.deliverRequest(next);
    expect(f.respond).toHaveBeenCalledTimes(2);expect(d.openApprovals('t')).toHaveLength(0);
  } finally { f.dispose(); }
});
it('R5 owner No limits dd to an ordinary file runs without a wipe card', () => {
  const cwd = scratch(), input = { command: 'dd if=/dev/zero of=disk', cwd }, f = fixture();
  try {
    expect(inspect(input.command, cwd).wipes).toHaveLength(0);
    const h = f.open('dd-ordinary', input, { tool: 'Bash', toolCall: { name: 'Bash', input } });
    expect(d.decide(h, baseCard).kind).toBe('run');
  } finally { f.dispose(); }
});
it.each(['powershell', 'pwsh'])('R5 %s literal backslashes bind the actual token', tool => {
  const cwd = scratch(), path = 'out\\disk'; symlinkSync('a', join(cwd, path));
  const operation = extractInspectedOperation({ tool, input: { command: 'mkfs.fat -F 32 ' + path, cwd } });
  if (operation.kind === 'incomplete') throw Error('operation required');
  const initial = { decisions: [], wipes: inspectReleaseWipes(operation.exactOperation) };
  expect(initial.wipes).toHaveLength(1); expect(initial.wipes[0].resolvedTargets).toContain(join(cwd, 'a'));
  expect(approvedEvidenceCovers(initial, initial)).toBe(true);
  unlinkSync(join(cwd, path)); symlinkSync('b', join(cwd, path));
  expect(approvedEvidenceCovers({ decisions: [], wipes: inspectReleaseWipes(operation.exactOperation) }, initial)).toBe(false);
});
it.each([
  ['python', "import subprocess; subprocess.run(['mkfs.ext4','out/branch/../disk'])"],
  ['node', "require('child_process').execFileSync('mkfs.ext4', ['out/branch/../disk'])"],
])('R5 %s semantic argv resolves symlinks before dot-dot', (tool, code) => {
  const cwd = scratch(); mkdirSync(join(cwd, 'out'));
  for (const name of ['one', 'two']) { mkdirSync(join(cwd, name, 'inner'), { recursive: true }); writeFileSync(join(cwd, name, 'disk'), 'inert image'); }
  symlinkSync('../one/inner', join(cwd, 'out/branch'));
  const operation = extractInspectedOperation({ tool, input: { code, cwd } });
  if (operation.kind === 'incomplete') throw Error('operation required');
  const initial = { decisions: [], wipes: inspectReleaseWipes(operation.exactOperation) };
  // MAIN RULING WIPE-GATE-BAR / 1114-WIPE-FIXTURE-DIRECTION: the literal Python mkfs argv is a disk-tool catastrophe.
  // The unresolved JavaScript executable-argv control retains its existing zero-wipe coverage.
  expect(initial.wipes).toHaveLength(tool === 'python' ? 1 : 0);
  if (tool === 'python') {
    expect(initial.wipes[0].hit.rule).toBe('disk-erase');
    expect(initial.wipes[0].resolvedTargets).toEqual([join(cwd, 'one/disk')]);
  }
  expect(approvedEvidenceCovers(initial, initial)).toBe(true);
  unlinkSync(join(cwd, 'out/branch')); symlinkSync('../two/inner', join(cwd, 'out/branch'));
  // MAIN RULING WIPE-GATE-BAR: a changed physical formatter target requires fresh approval.
  expect(approvedEvidenceCovers({ decisions: [], wipes: inspectReleaseWipes(operation.exactOperation) }, initial)).toBe(tool !== 'python');
});
it.each(['updatedInput', 'replay'] as const)('R5 explicit %s final writer retains a cleared wipe decision', async mode => {
  const cwd = scratch(); symlinkSync('/etc', join(cwd, 'system')); mkdirSync(join(cwd, 'ordinary'));
  const input = { command: 'rm -rf system/', cwd }, f = fixture(); let released: boolean | undefined;
  try {
    const h = f.open('explicit-cleared', input, { tool: 'Bash', toolCall: { name: 'Bash', input } });
    const outcome = d.decide(h, baseCard); expect(outcome.kind).toBe('card');
    if (outcome.kind !== 'card') throw Error('wipe card required');
    await d.presentApproval(outcome.ref, { title: 'Wipe', subtitle: 'Inert fixture' });
    f.respond.mockImplementation(async target => {
      unlinkSync(join(cwd, 'system')); symlinkSync('ordinary', join(cwd, 'system'));
      released = mode === 'updatedInput' ? guardEngineRelease(target, input) : guardEngineRelease(target, undefined, { tool: 'Bash', input });
      return { state: 'failed' };
    });
    await d.answerApproval(outcome.ref, { behavior: 'allow' });
    // MAIN RULING 2026-11-13 narrow-wipe (Sean): a fresh ordinary target does not retain a catastrophe hold.
    expect(released).toBe(true); expect(f.respond).toHaveBeenCalled();
    expect(f.respond.mock.calls.every(([,answer])=>answer.behavior==='allow')).toBe(true);
    expect(d.openApprovals('t')).toHaveLength(0);
  } finally { f.dispose(); }
});
it.each(['dd if=/dev/zero of=disk', 'shred -n 1 disk'])('R5 dangling device destination still detects a wipe: %s', command => {
  const cwd = scratch(); unlinkSync(join(cwd, 'disk')); symlinkSync('/dev/sda', join(cwd, 'disk'));
  // MAIN RULING 2026-11-13 narrow-wipe (Sean): a dangling alias has no resolved raw disk.
  expect(noLimitsWipe(command, { cwd })).toBeNull();
  expect(inspect(command, cwd).wipes).toEqual([]);
});
it('R5 owner No limits unlinks a final device symlink without a wipe card', () => {
  const cwd = scratch(true), input = { command: 'rm disk', cwd }, f = fixture();
  try {
    expect(noLimitsWipe(input.command, { cwd })).toBeNull();
    const h = f.open('unlink-device-link', input, { tool: 'Bash', toolCall: { name: 'Bash', input } });
    expect(d.decide(h, baseCard).kind).toBe('run');
  } finally { f.dispose(); }
});
