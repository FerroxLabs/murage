// SPDX-License-Identifier: AGPL-3.0-or-later
// Payloads are inert; only links in the isolated scratch directory change.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractInspectedOperation } from '../no-limits-operation.ts';
import { inspectOwnerOperation } from '../no-limits-inspection.ts';
import * as wipe from '../wipe-breaker.ts';
import * as fingerprintReader from './wipe-fingerprint.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { installReleaseContextReader, inspectReleaseWipes, releaseGuard, type ReleaseRequest } from './release-guard.ts';
import type { ApprovalRef } from './types.ts';
import { guardEngineRelease } from './provider-release.ts';
import { fixture, d, baseCard } from './fixture.ts';
let dispose = () => {};
const roots: string[] = [];
afterEach(async () => { dispose(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await removeTempDir(root); });
function request(tool: string, input: unknown, cwd: string): ReleaseRequest {
  const result = extractInspectedOperation({ tool, input }, { cwd });
  if (result.kind === 'incomplete') throw Error('operation required');
  return { requestKey: 'r2:g:r', threadId: 't', generation: 'g', ...result, releaseKind: 'native' };
}
it.each(['delete_file', 'Bash', 'python'] as const)('H1 %s approval cannot follow the same-class /etc to /usr retarget', tool => {
  const cwd = mkdtempSync(join(tmpdir(), 'release-r2-')); roots.push(cwd);
  mkdirSync(join(cwd, 'out')); const link = join(cwd, 'out/notes'); symlinkSync('/etc', link);
  const input = tool === 'delete_file' ? { path: 'out/notes/' } : tool === 'Bash'
    ? { command: 'rm -rf out/notes/' } : { code: "import shutil; shutil.rmtree('out/notes/')" };
  const r = request(tool, input, cwd), ref = {} as ApprovalRef;
  const initial = { decisions: [], wipes: inspectReleaseWipes(r.exactOperation) };
  dispose = installReleaseContextReader(() => ({ posture: 'owner-no-limits', operationHash: r.operationHash,
    inspect: () => ({ decisions: [] }), approved: candidate => candidate === ref ? { operationHash: r.operationHash, inspection: initial } : undefined }));
  // MAIN RULING: REDESIGN-WIPE-NARROW §0 (Sean, 2026-11-13).: native Python is outside scope; shell/native deletes stay guarded.
  // MAIN RULING WIPE-GATE-BAR / WIPE-V3 S6: native literal Python root deletion uses the same release guard.
  const scoped=true;
  expect(initial.wipes).toHaveLength(scoped?1:0);
  if(scoped){expect(initial.wipes[0].hit.rule).toBe('delete-system-folder');expect(initial.wipes[0].resolvedTargets).toEqual(['/etc']);}
  expect(releaseGuard(r).kind).toBe(scoped?'hold':'release');
  expect(releaseGuard({ ...r, approvedEvidence: ref }).kind).toBe('release');
  unlinkSync(link); symlinkSync('/usr', link);
  if(scoped){expect(inspectReleaseWipes(r.exactOperation)[0].hit.rule).toBe('delete-system-folder');expect(inspectReleaseWipes(r.exactOperation)[0].resolvedTargets).toEqual(['/usr']);}
  expect(releaseGuard({ ...r, approvedEvidence: ref }).kind).toBe(scoped?'hold':'release');
});
const code = '('.repeat(201) + '0' + ')'.repeat(201);
it('H2 the exact non-wipe Python cut releases after logging its diagnostic exception', () => {
  const r = request('python', { code }, '/tmp');
  expect(() => inspectOwnerOperation(r.exactOperation)).toThrow();
  const scan = vi.spyOn(wipe, 'wipeBreaker');
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const inspect = vi.fn(() => { expect(scan).toHaveBeenCalled(); return inspectOwnerOperation(r.exactOperation); });
  dispose = installReleaseContextReader(() => ({ posture: 'owner-no-limits', operationHash: r.operationHash, inspect, approved: () => undefined }));
  expect(releaseGuard(r)).toEqual({ kind: 'release' });
  expect(inspect).toHaveBeenCalledOnce(); expect(log).toHaveBeenCalled();
});
it.each(['unlimited', 'ask'] as const)('H2 exact Python cut at %s retains the correct delivery behavior', async level => {
  const f = fixture(level);
  try {
    const h = f.open('python-cut', { code }, { tool: 'python', toolCall: { name: 'python', input: { code } } });
    const outcome = d.decide(h, baseCard);
    expect(outcome.kind).toBe(level === 'unlimited' ? 'run' : 'card');
    await d.deliverRequest(h);
    if (level === 'unlimited') { expect(f.respond).toHaveBeenCalledOnce(); expect(f.respond.mock.calls[0][1]).toMatchObject({ behavior: 'allow' }); }
    else { expect(f.respond).not.toHaveBeenCalled(); expect(d.openApprovals('t')).toHaveLength(1); }
  } finally { f.dispose(); }
});
it('H2 a wipe scan exception fails closed before protected diagnostics', () => {
  const r = request('Bash', { command: 'printf fixture' }, '/tmp');
  vi.spyOn(wipe, 'wipeBreaker').mockImplementation(() => { throw Error('wipe scan failed'); });
  const inspect = vi.fn(() => ({ decisions: [] }));
  dispose = installReleaseContextReader(() => ({ posture: 'owner-no-limits', operationHash: r.operationHash, inspect, approved: () => undefined }));
  expect(releaseGuard(r)).toEqual({ kind: 'hold', inspection: { decisions: [] } });
  expect(inspect).not.toHaveBeenCalled();
});

it.each(['delete_file', 'Bash'] as const)('H1 product %s delivery recards /etc to /usr before consuming approval', async tool => {
  const cwd = mkdtempSync(join(tmpdir(), 'release-r2-product-')); roots.push(cwd);
  mkdirSync(join(cwd, 'out')); const link = join(cwd, 'out/notes'); symlinkSync('/etc', link);
  const input = tool === 'delete_file' ? { path: 'out/notes/', cwd } : { command: 'rm -rf out/notes/', cwd };
  const f = fixture();
  try {
    const h = f.open('retarget', input, { tool, toolCall: { name: tool, input } });
    const outcome = d.decide(h, baseCard); expect(outcome.kind).toBe('card');
    if (outcome.kind !== 'card') throw Error('wipe card required');
    await d.presentApproval(outcome.ref, { title: 'Wipe', subtitle: 'Inert fixture' });
    unlinkSync(link); symlinkSync('/usr', link);
    await d.answerApproval(outcome.ref, { behavior: 'allow' });
    expect(f.respond).not.toHaveBeenCalled();
    const pending = d.openApprovals('t'); expect(pending).toHaveLength(1);
    expect(pending[0].why).toBe('wipe');
  } finally { f.dispose(); }
});

it.each(['delete_file', 'Bash'] as const)('H1 unchanged %s product wipe approval still delivers', async tool => {
  const f = fixture();
  // MAIN RULING 2026-11-12 release-guard fingerprint: argv tokens require an authenticated turn cwd, even when the wipe operand is absolute.
  const input = tool === 'delete_file' ? { path: '/etc/' } : { command: 'rm -rf /etc/', cwd: '/tmp' };
  try {
    const h = f.open('unchanged-wipe', input, { tool, toolCall: { name: tool, input } });
    const outcome = d.decide(h, baseCard); expect(outcome.kind).toBe('card');
    if (outcome.kind !== 'card') throw Error('wipe card required');
    await d.presentApproval(outcome.ref, { title: 'Wipe', subtitle: 'Inert fixture' });
    await d.answerApproval(outcome.ref, { behavior: 'allow' });
    expect(f.respond).toHaveBeenCalledOnce(); expect(f.respond.mock.calls[0][1]).toMatchObject({ behavior: 'allow' });
  } finally { f.dispose(); }
});
it('H1 a shell wipe binds every resolved target in its canonical set', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'release-r2-set-')); roots.push(cwd);
  symlinkSync('/etc', join(cwd, 'a')); symlinkSync('/usr', join(cwd, 'b'));
  const r = request('Bash', { command: 'rm -rf b/ a/ a/' }, cwd);
  expect(inspectReleaseWipes(r.exactOperation)[0].resolvedTargets).toEqual(['/etc', '/usr']);
});
it('H2 a failing wipe scan produces a product card and no allow reply', async () => {
  vi.spyOn(wipe, 'wipeBreaker').mockImplementation(() => { throw Error('wipe scan failed'); });
  const f = fixture();
  try {
    const h = f.open('wipe-scan-failed', { command: 'printf fixture' });
    // MAIN RULING: REDESIGN-WIPE-NARROW §7 F5: a breaker exception cards and cannot deliver allow.
    const outcome = d.decide(h, baseCard); expect(outcome.kind).toBe('card');
    await d.deliverRequest(h);
    expect(d.openApprovals('t')).toHaveLength(1);
    expect(f.respond).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});

it('H2 protected-only targets never change coverage of an approved wipe', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'release-r2-diagnostic-')); roots.push(cwd);
  const r = request('Bash', { command: 'rm -rf /; printf fixture > notes' }, cwd), ref = {} as ApprovalRef;
  const initial = { decisions: [], wipes: inspectReleaseWipes(r.exactOperation) };
  expect(initial.wipes[0].resolvedTargets).toEqual(['/']);
  dispose = installReleaseContextReader(() => ({ posture: 'owner-no-limits', operationHash: r.operationHash,
    inspect: () => inspectOwnerOperation(r.exactOperation), approved: candidate => candidate === ref ? { operationHash: r.operationHash, inspection: initial } : undefined }));
  // MAIN RULING 2026-11-12 release-guard fingerprint: a newly resolving argv/redirect token changes the approved fingerprint.
  symlinkSync('/etc/hosts', join(cwd, 'notes'));
  expect(releaseGuard({ ...r, approvedEvidence: ref }).kind).toBe('hold');
});

it('H1 the native writer rechecks resolved targets after the approval delivery check', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'release-r2-writer-')); roots.push(cwd);
  const link = join(cwd, 'notes'); symlinkSync('/etc', link);
  const input = { path: 'notes/', cwd }, f = fixture(); let released: boolean | undefined;
  try {
    const h = f.open('writer-retarget', input, { tool: 'delete_file', toolCall: { name: 'delete_file', input } });
    const outcome = d.decide(h, baseCard); expect(outcome.kind).toBe('card');
    if (outcome.kind !== 'card') throw Error('wipe card required');
    await d.presentApproval(outcome.ref, { title: 'Wipe', subtitle: 'Inert fixture' });
    f.respond.mockImplementation(async target => {
      unlinkSync(link); symlinkSync('/usr', link);
      released = guardEngineRelease(target);
      return { state: 'failed' };
    });
    await d.answerApproval(outcome.ref, { behavior: 'allow' });
    expect(released).toBe(false); expect(f.respond).toHaveBeenCalledOnce();
    expect(d.openApprovals('t')).toHaveLength(1); expect(d.openApprovals('t')[0].why).toBe('wipe');
  } finally { f.dispose(); }
});

it('H1 an incomplete target scan cannot reuse an earlier wipe approval', () => {
  const r = request('Bash', { command: 'rm -rf /' }, '/tmp'), ref = {} as ApprovalRef;
  const initial = { decisions: [], wipes: inspectReleaseWipes(r.exactOperation) };
  const inspect = vi.fn(() => ({ decisions: [] }));
  dispose = installReleaseContextReader(() => ({ posture: 'owner-no-limits', operationHash: r.operationHash,
    inspect, approved: candidate => candidate === ref ? { operationHash: r.operationHash, inspection: initial } : undefined }));
  // MAIN RULING 2026-11-12 release-guard fingerprint: inject failure at the authoritative fingerprint scanner, replacing the retired operand scanner.
  vi.spyOn(fingerprintReader, 'wipeFingerprint').mockImplementation(() => { throw Error('incomplete fingerprint'); });
  expect(releaseGuard({ ...r, approvedEvidence: ref }).kind).toBe('hold');
  expect(inspect).not.toHaveBeenCalled();
});
