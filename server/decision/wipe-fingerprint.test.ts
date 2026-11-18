// SPDX-License-Identifier: AGPL-3.0-or-later
// Inert source only; filesystem changes stay in this suite's temporary root.
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, renameSync, symlinkSync, unlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractInspectedOperation } from '../no-limits-operation.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { approvedEvidenceCovers, inspectReleaseWipes, installReleaseContextReader, releaseGuard } from './release-guard.ts';
import type { ApprovalRef } from './types.ts';
import {registeredWipeProjects} from '../wipe/registry.ts';
import { baseRun, d, fixture } from './fixture.ts';

const roots: string[] = [];
let dispose = () => {};
afterEach(async () => { dispose(); for (const root of roots.splice(0)) {registeredWipeProjects.drop(root);await removeTempDir(root);} });
function scratch() {
  const cwd = mkdtempSync(join(tmpdir(), 'nested-fingerprint-')); roots.push(cwd);
  for(const name of ['A','B'])mkdirSync(join(cwd,name));
  registeredWipeProjects.replace(cwd,[join(cwd,'A'),join(cwd,'B')]);
  symlinkSync(join(cwd,'A'), join(cwd, 'link'),process.platform==='win32'?'junction':'dir');
  return cwd;
}
const py = "import shutil; shutil.rmtree('link/')";
const js = "require('fs').rmSync('link/', {recursive:true})";
const cases = [
  ['shell disk child', 'python', 'subprocess.run(["sh","-c","mkfs.ext4 link"])'],
  ['python child', 'python', `subprocess.run(["python3", "-c", ${JSON.stringify(py)}])`],
  ['node child', 'python', `subprocess.run(["node", "-e", ${JSON.stringify(js)}])`],
  ['node to python', 'node', `require('child_process').spawn('python3', ['-c', ${JSON.stringify(py)}])`],
  ['shell to python', 'python', `os.system(${JSON.stringify(`python3 -c "${py}"`)})`],
  ['two interpreter children', 'python', `subprocess.run(["python3", "-c", ${JSON.stringify(`subprocess.run(["python3", "-c", ${JSON.stringify(py)}])`)}])`],
] as const;

it.each(cases)('nested fingerprint binds a retargeted %s', (_name, tool, code) => {
  const cwd = scratch(), extracted = extractInspectedOperation({ tool, input: { code, cwd } });
  if (extracted.kind === 'incomplete') throw Error('issued code operation required');
  const initial = { decisions: [], wipes: inspectReleaseWipes(extracted.exactOperation) };
  expect(initial.wipes).toHaveLength(1);
  // MAIN RULING 1115-WFP-EXACT-APPROVAL adds the disk repro; interpreter expectations unchanged.
  expect(initial.wipes[0].hit.rule).toBe(_name==='shell disk child'?'disk-erase':'delete-system-folder');
  // MAIN RULING 1115-WFP-EXACT-APPROVAL adopts portable A/B fixtures; canonical identity assertion retained.
  expect(initial.wipes[0].resolvedTargets).toContain(realpathSync(join(cwd,'A')));
  const ref = {} as ApprovalRef;
  dispose = installReleaseContextReader(() => ({ posture: 'owner-no-limits', operationHash: extracted.operationHash,
    inspect: () => ({ decisions: [] }), approved: () => ({ operationHash: extracted.operationHash, inspection: initial }) }));
  const request = { ...extracted, requestKey: 'nested:g:r', threadId: 't', generation: 'g', releaseKind: 'exec' as const, approvedEvidence: ref };
  expect(approvedEvidenceCovers({ decisions: [], wipes: inspectReleaseWipes(extracted.exactOperation) }, initial)).toBe(true);
  expect(releaseGuard(request).kind).toBe('release');
  unlinkSync(join(cwd, 'link')); symlinkSync(join(cwd,'B'), join(cwd, 'link'),process.platform==='win32'?'junction':'dir');
  const fresh = { decisions: [], wipes: inspectReleaseWipes(extracted.exactOperation) };
  // MAIN RULING 1115-WFP-EXACT-APPROVAL adds the disk repro; interpreter expectations unchanged.
  expect(fresh.wipes[0].hit.rule).toBe(_name==='shell disk child'?'disk-erase':'delete-system-folder');
  // MAIN RULING 1115-WFP-EXACT-APPROVAL adopts portable A/B fixtures; canonical identity assertion retained.
  expect(fresh.wipes[0].resolvedTargets).toContain(realpathSync(join(cwd,'B')));
  expect(approvedEvidenceCovers(fresh, initial)).toBe(false);
  expect(releaseGuard(request).kind).toBe('hold');
});

it('nested fingerprint binds child target inode even when its path and wipe class stay the same', () => {
  const cwd = scratch(); mkdirSync(join(cwd, 'ordinary'));
  const code = `subprocess.run(["python3", "-c", "import shutil; shutil.rmtree('link/'); shutil.rmtree('ordinary/')"])`;
  const extracted = extractInspectedOperation({ tool: 'python', input: { code, cwd } });
  if (extracted.kind === 'incomplete') throw Error('issued code operation required');
  const initial = { decisions: [], wipes: inspectReleaseWipes(extracted.exactOperation) };
  expect(initial.wipes[0].resolvedTargets).toContain(join(cwd, 'ordinary'));
  renameSync(join(cwd, 'ordinary'), join(cwd, 'old')); mkdirSync(join(cwd, 'ordinary'));
  const fresh = { decisions: [], wipes: inspectReleaseWipes(extracted.exactOperation) };
  expect(fresh.wipes[0].resolvedTargets).toEqual(initial.wipes[0].resolvedTargets);
  expect(approvedEvidenceCovers(fresh, initial)).toBe(false);
});

it.each([cases[1],cases[0]])('nested fingerprint refreshes the product card before releasing the new target: %s', async (_name,_tool,code) => {
  const cwd = scratch(), input = { code, cwd }, f = fixture();
  try {
    const h = f.open('nested-retarget', input, { tool: 'python', toolCall: { name: 'python', input } });
    const outcome = d.decide(h, baseRun); expect(outcome.kind).toBe('card');
    if (outcome.kind !== 'card') throw Error('wipe card required');
    await d.presentApproval(outcome.ref, { title: 'Wipe', subtitle: 'Inert fixture' });
    unlinkSync(join(cwd, 'link')); symlinkSync(join(cwd,'B'), join(cwd, 'link'),process.platform==='win32'?'junction':'dir');
    await d.answerApproval(outcome.ref, { behavior: 'allow' });
    expect(f.respond).not.toHaveBeenCalled();
    const pending = d.openApprovals('t'); expect(pending).toHaveLength(1);
    expect(pending[0].why).toBe('wipe'); expect(pending[0].ref).not.toBe(outcome.ref);
    await expect(d.answerApproval(outcome.ref, { behavior: 'allow' })).rejects.toThrow('unissued-approval-ref');
    await d.answerApproval(pending[0].ref, { behavior: 'allow' });
    expect(f.respond).toHaveBeenCalledOnce(); expect(d.openApprovals('t')).toHaveLength(0);
  } finally { f.dispose(); }
});
