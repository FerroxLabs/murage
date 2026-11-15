// SPDX-License-Identifier: AGPL-3.0-or-later
// No destructive commands execute. Only isolated inert files and aliases change.
import { afterEach, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from '../testing/cleanup.ts';
import { physicalWipePath } from '../wipe-path.ts';
import { noLimitsWipe } from '../no-limits-wipe.ts';
import { extractInspectedOperation } from '../no-limits-operation.ts';
import { approvedEvidenceCovers, inspectReleaseWipes } from './release-guard.ts';
import { fixture, d, baseCard } from './fixture.ts';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });
function scratch() {
  const cwd = mkdtempSync(join(tmpdir(), 'release-r6-')); roots.push(cwd);
  mkdirSync(join(cwd, 'out')); mkdirSync(join(cwd, 'nested/inner'), { recursive: true });
  writeFileSync(join(cwd, 'out/disk'), 'ordinary decoy');
  writeFileSync(join(cwd, 'a'), 'inert a'); writeFileSync(join(cwd, 'b'), 'inert b');
  symlinkSync('../nested/inner', join(cwd, 'out/branch'));
  return cwd;
}
function inspect(command: string, cwd: string) {
  const operation = extractInspectedOperation({ tool: 'Bash', input: { command, cwd } });
  if (operation.kind === 'incomplete') throw Error('operation required');
  return { decisions: [], wipes: inspectReleaseWipes(operation.exactOperation) };
}
it('R6 H1 review dd follows branch symlink before parent and cards', () => {
  const cwd = scratch(), command = 'dd if=/dev/zero of=out/branch/../disk', f = fixture();
  symlinkSync('/dev/sda', join(cwd, 'nested/disk'));
  try {
    expect(noLimitsWipe(command, { cwd })).toBeNull(); // MAIN RULING: REDESIGN-WIPE-NARROW §0 (Sean, 2026-11-13).
    const input = { command, cwd };
    const h = f.open('physical-dd', input, { tool: 'Bash', toolCall: { name: 'Bash', input } });
    expect(d.decide(h, baseCard).kind).toBe('run'); // MAIN RULING: REDESIGN-WIPE-NARROW §0 (Sean, 2026-11-13).
  } finally { f.dispose(); }
});
it('R6 H1 physical dd identity releases unchanged and holds retarget', () => {
  const cwd = scratch(), command = 'dd if=/dev/zero of=out/branch/../disk';
  mkdirSync(join(cwd, 'dev')); writeFileSync(join(cwd, 'dev/sda'), 'inert image'); writeFileSync(join(cwd, 'dev/sdb'), 'inert image');
  symlinkSync('../dev/sda', join(cwd, 'nested/disk'));
  const initial = inspect(command, cwd);
  // MAIN RULING: REDESIGN-WIPE-NARROW §0 (Sean, 2026-11-13).: both destinations are ordinary image files.
  expect(initial.wipes).toHaveLength(0);
  expect(approvedEvidenceCovers(initial, initial)).toBe(true);
  unlinkSync(join(cwd, 'nested/disk')); symlinkSync('../dev/sdb', join(cwd, 'nested/disk'));
  expect(approvedEvidenceCovers(inspect(command, cwd), initial)).toBe(true);
});
it.each(['missing', 'loop', 'file'])('R6 H1 unresolved %s prefix cannot hide behind parent', name => {
  const cwd = scratch();
  if (name === 'loop') symlinkSync('loop', join(cwd, name));
  if (name === 'file') writeFileSync(join(cwd, name), 'not a directory');
  const command = `dd if=/dev/zero of=${name}/../out/disk`, f = fixture();
  try {
    // MAIN RULING: REDESIGN-WIPE-NARROW §7 F5: ELOOP is a checker fault; missing/non-directory paths stay values.
    if(name==='loop')expect(noLimitsWipe(command,{cwd})?.rule).toBe('wipe-check-fault');else expect(noLimitsWipe(command,{cwd})).toBeNull();
    const input = { command, cwd };
    const h = f.open('unknown-' + name, input, { tool: 'Bash', toolCall: { name: 'Bash', input } });
    // MAIN RULING: REDESIGN-WIPE-NARROW §7 F5: the fault must also hold registered delivery.
    expect(d.decide(h,baseCard).kind).toBe(name==='loop'?'card':'run');
    expect(() => physicalWipePath(`${name}/../out/disk`, cwd)).toThrow();
  } finally { f.dispose(); }
});
it('R6 M1 moving same alias from whole token to equals suffix renews approval', () => {
  const cwd = scratch(), command = 'mkfs.ext4 opaque=disk';
  symlinkSync('a', join(cwd, 'opaque=disk'));
  const initial = inspect(command, cwd);
  expect(approvedEvidenceCovers(initial, initial)).toBe(true);
  const probes = JSON.parse(initial.wipes[0].fingerprint!).commands[0].objects.filter((probe: { index: number }) => probe.index === 1);
  expect(probes).toEqual([expect.objectContaining({ probe: 'whole', state: 'present' }), { index: 1, probe: 'equals-suffix', state: 'absent' }]);
  unlinkSync(join(cwd, 'opaque=disk')); symlinkSync('a', join(cwd, 'disk'));
  const moved = inspect(command, cwd);
  expect(moved.wipes[0].resolvedTargets).toEqual(initial.wipes[0].resolvedTargets);
  expect(approvedEvidenceCovers(moved, initial)).toBe(false);
});

it('R6 H1 permission failure is UNKNOWN and requires a card', () => {
  const cwd = scratch(), blocked = join(cwd, 'blocked'), command = 'dd if=/dev/zero of=blocked/../out/disk', f = fixture();
  mkdirSync(blocked); chmodSync(blocked, 0);
  try {
    expect(() => physicalWipePath('blocked/../out/disk', cwd)).toThrow();
    // MAIN RULING: REDESIGN-WIPE-NARROW §7 F5: filesystem-check failures card.
    expect(noLimitsWipe(command,{cwd})?.rule).toBe('wipe-check-fault');
    const input = { command, cwd };
    const h = f.open('permission-prefix', input, { tool: 'Bash', toolCall: { name: 'Bash', input } });
    // MAIN RULING: REDESIGN-WIPE-NARROW §7 F5: no registered allow may bypass the fault.
    expect(d.decide(h,baseCard).kind).toBe('card');
    // MAIN RULING: REDESIGN-WIPE-NARROW §7 F5: release cannot manufacture clean evidence from failed IO.
    expect(()=>inspect(command,cwd)).toThrow(/EACCES|permission|wipe-path/i);
  } finally { chmodSync(blocked, 0o700); f.dispose(); }
});
it('R6 H1 delete traversal follows branch before parent', () => {
  const cwd = scratch(); mkdirSync(join(cwd, 'out/system')); symlinkSync('/etc', join(cwd, 'nested/system'));
  expect(noLimitsWipe('rm -rf out/branch/../system/', { cwd })?.rule).toBe('delete-system-folder');
});

it('R6 M1 empty equals suffix has its own probe state', () => {
  const cwd = scratch(), initial = inspect('mkfs.ext4 opaque=', cwd);
  const probes = JSON.parse(initial.wipes[0].fingerprint!).commands[0].objects.filter((probe: { index: number }) => probe.index === 1);
  expect(probes).toEqual([{ index: 1, probe: 'whole', state: 'absent' }, { index: 1, probe: 'equals-suffix', state: 'empty' }]);
});
it('R6 H1 absent fingerprint probe never cancels a missing prefix with parent', () => {
  const cwd = scratch(), command = 'mkfs.ext4 missing/../out/disk', initial = inspect(command, cwd);
  expect(initial.wipes[0].resolvedTargets).not.toContain(join(cwd, 'out/disk'));
  mkdirSync(join(cwd, 'missing'));
  expect(approvedEvidenceCovers(inspect(command, cwd), initial)).toBe(false);
});
it('R6 H1 denied component inside symlink contents cannot be cancelled by parent', () => {
  const cwd = scratch(), blocked = join(cwd, 'blocked'), command = 'dd if=/dev/zero of=hidden', f = fixture();
  mkdirSync(blocked); chmodSync(blocked, 0); symlinkSync('blocked/../out/disk', join(cwd, 'hidden'));
  try {
    expect(() => physicalWipePath('hidden', cwd)).toThrow();
    // MAIN RULING: REDESIGN-WIPE-NARROW §7 F5: filesystem-check failures card.
    expect(noLimitsWipe(command,{cwd})?.rule).toBe('wipe-check-fault');
    const input = { command, cwd };
    const h = f.open('hidden-permission-prefix', input, { tool: 'Bash', toolCall: { name: 'Bash', input } });
    // MAIN RULING: REDESIGN-WIPE-NARROW §7 F5: no registered allow may bypass the fault.
    expect(d.decide(h,baseCard).kind).toBe('card');
    // MAIN RULING: REDESIGN-WIPE-NARROW §7 F5: release cannot manufacture clean evidence from failed IO.
    expect(()=>inspect(command,cwd)).toThrow(/EACCES|permission|wipe-path/i);
  } finally { chmodSync(blocked, 0o700); f.dispose(); }
});
it('R6 H1 missing component inside symlink contents is UNKNOWN', () => {
  const cwd = scratch(), command = 'dd if=/dev/zero of=hidden';
  symlinkSync('missing/../out/disk', join(cwd, 'hidden'));
  expect(() => physicalWipePath('hidden', cwd)).toThrow();
  expect(noLimitsWipe(command, { cwd })).toBeNull(); // MAIN RULING: REDESIGN-WIPE-NARROW §0 (Sean, 2026-11-13).
  expect(inspect(command, cwd).wipes).toEqual([]); // MAIN RULING: REDESIGN-WIPE-NARROW §0 (Sean, 2026-11-13).
});

it('R6 H1 missing selected project root still requires a card', () => {
  const cwd = join(scratch(), 'missing-project');
  expect(noLimitsWipe('rm -rf .', { cwd, workFolder: cwd })?.rule).toBe('delete-system-folder');
});

const deleteCommands = [
  ['Bash', 'rm -rf TARGET'], ['Bash', 'rm -r TARGET'], ['Bash', 'rmdir TARGET'],
  ['Bash', 'find TARGET -delete'], ['powershell', 'Remove-Item -Recurse TARGET'],
  ['Bash', 'rd /s TARGET'], ['python', "import shutil; shutil.rmtree('TARGET')"],
  ['node', "fs.rmSync('TARGET', {recursive:true})"],
] as const;
function deleteDecision(tool: string, command: string, cwd: string, expected: 'card' | 'run') {
  const f = fixture();
  if(tool==='node')command="const fs=require('fs'); "+command;
  const input = tool === 'python' || tool === 'node' ? { code: command, cwd } : { command, cwd };
  try {
    const h = f.open('r7-delete', input, { tool, toolCall: { name: tool, input } });
    expect(d.decide(h, baseCard).kind).toBe(expected);
  } finally { f.dispose(); }
}
it.each(deleteCommands)('R7 H1 %s %s unresolved prefix before parent cards', (tool, template) => {
  const cwd = scratch();
  deleteDecision(tool, template.replace('TARGET', 'missing/../out/disk'), cwd, 'run'); // MAIN RULING: REDESIGN-WIPE-NARROW §0 (Sean, 2026-11-13).
});
it.each(deleteCommands)('R7 H1 %s %s loop prefix without parent cards', (tool, template) => {
  const cwd = scratch(); symlinkSync('loop', join(cwd, 'loop'));
  // MAIN RULING: REDESIGN-WIPE-NARROW §7 F5 cards checker IO faults; code and empty-dir rmdir remain outside the effect table.
  const checked=tool!=='python'&&tool!=='node'&&!template.startsWith('rmdir ');
  deleteDecision(tool,template.replace('TARGET','loop/child'),cwd,checked?'card':'run');
});
it.each(deleteCommands)('R7 H1 %s %s denied prefix without parent cards', (tool, template) => {
  const cwd = scratch(), blocked = join(cwd, 'blocked'); mkdirSync(blocked); chmodSync(blocked, 0);
  try {
    // MAIN RULING: REDESIGN-WIPE-NARROW §7 F5 cards checker IO faults for the listed wipe effects.
    const checked=tool!=='python'&&tool!=='node'&&!template.startsWith('rmdir ');
    deleteDecision(tool,template.replace('TARGET','blocked/child'),cwd,checked?'card':'run');
  }
  finally { chmodSync(blocked, 0o700); }
});
it.each(['build', 'build/', 'node_modules/.cache', 'missing/deeper/child'])('R7 H1 absent cleanup %s runs without a card', path => {
  const cwd = scratch();
  expect(noLimitsWipe('rm -rf ' + path, { cwd })).toBeNull();
  deleteDecision('Bash', 'rm -rf ' + path, cwd, 'run');
});
it('R7 H1 missing component inside followed symlink before parent cards', () => {
  const cwd = scratch(); symlinkSync('missing/../out', join(cwd, 'hidden'));
  deleteDecision('Bash', 'rm -rf hidden/disk', cwd, 'run'); // MAIN RULING: REDESIGN-WIPE-NARROW §0 (Sean, 2026-11-13).
});
it('R7 H1 final symlink loop is unlinked but a trailing slash traverses and cards', () => {
  const cwd = scratch(); symlinkSync('loop', join(cwd, 'loop'));
  // MAIN RULING: REDESIGN-WIPE-NARROW §5 physical classification and §7 F5 hold an ELOOP fault in either spelling.
  deleteDecision('Bash','rm -rf loop',cwd,'card');
  deleteDecision('Bash','rm -rf loop/',cwd,'card');
});
