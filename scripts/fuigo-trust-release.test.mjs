import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { removeTempDirSync } from '../server/testing/cleanup.ts';
import { trustReleaseGate } from './fuigo-trust-release.mjs';
import { trustReleaseFixture } from './fuigo-trust-evidence-v3.fixture.mjs';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureRuns, toFiles, WANT } from './fuigo-bump-fixture.mjs';
import { buildTrustReceipt, checkRealTurns, mergeCheck } from './fuigo-bump.mjs';

const historical = () => {
  const files = toFiles(fixtureRuns());
  return { files, receipt: { ...WANT, schema: 2, fuigoVersion: WANT.version, real_turns: checkRealTurns(files, WANT) } };
};
describe('W-T16 current release evidence binding', () => {
  it('merge-check-rejects-other-release', () => {
    const { files, receipt, expected } = trustReleaseFixture();
    expect(() => mergeCheck(receipt, files, { ...expected, murageSha: '3'.repeat(40) })).toThrow(/clause:release-identity/);
  });
  it('merge-check-does-not-trust-the-receipt-sha', () => {
    const { files, receipt, expected } = trustReleaseFixture();
    expect(() => mergeCheck({ ...receipt, murageSha: '3'.repeat(40) }, files, expected)).toThrow(/clause:release-identity/);
    expect(() => mergeCheck({ ...receipt, packageVersion: '9.9.9' }, files, expected)).toThrow(/clause:release-identity/);
  });
  it('schema2-not-ready', () => {
    const { files, receipt } = historical();
    expect(() => mergeCheck(receipt, files, WANT)).toThrow(/clause:schema/);
    expect(checkRealTurns(files, WANT), 'historical evidence stays readable').toHaveLength(3);
  });
  it('owed-never-passes', () => {
    const { files, receipt, expected } = trustReleaseFixture();
    expect(() => mergeCheck({ ...receipt, real_turns: 'owed' }, files, expected)).toThrow(/clause:owed/);
  });
});

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
const writePacket = f => {
  const dir = mkdtempSync(join(tmpdir(), 'trust-release-')); dirs.push(dir);
  const capturesDir = join(dir, 'captures'); mkdirSync(capturesDir);
  for (const { name, row, folder } of f.files) {
    writeFileSync(join(capturesDir, name), JSON.stringify(row));
    const osDir = join(capturesDir, name.slice(0, -5)); mkdirSync(osDir);
    for (const [file, bytes] of folder) writeFileSync(join(osDir, file), bytes);
  }
  const expectedFile = join(dir, 'expected.json'), receiptFile = join(dir, 'receipt.json');
  writeFileSync(expectedFile, JSON.stringify(f.expected)); writeFileSync(receiptFile, JSON.stringify(f.receipt));
  return { expectedFile, receiptFile, capturesDir, expectedSha: f.expected.murageSha };
};
describe('complete schema 3 release controls', () => {
  it('accepts every complete OS packet only against its independently selected release', () => {
    const f = trustReleaseFixture();
    expect(() => mergeCheck(f.receipt, f.files, f.expected)).not.toThrow();
    const binding = { ...f.receipt, schema: 2, real_turns: 'owed' };
    const built = buildTrustReceipt(binding, f.files, f.expected);
    expect(built.schema).toBe(3); expect(built.real_turns).toEqual(f.receipt.real_turns);
    expect(buildTrustReceipt(binding).real_turns).toBe('owed');
  });
  it('source-review and all selected OS packets are prerequisites for READY', () => {
    const f = trustReleaseFixture();
    expect(() => mergeCheck(f.receipt, f.files.slice(1), f.expected)).toThrow(/clause:release-identity/);
    f.files[0].folder.delete('artifact-source-review');
    expect(() => mergeCheck(f.receipt, f.files, f.expected)).toThrow(/clause:artifact/);
  });
  it('rechecks complete captures rather than accepting three passing OS summaries', () => {
    const f = trustReleaseFixture();
    f.files[0].folder.set(f.files[0].row.files.transcripts[0], Buffer.from('altered capture'));
    expect(() => mergeCheck(f.receipt, f.files, f.expected)).toThrow(/sha256|tap record|JSON/);
  });
  it('reads real files and binds the expected manifest to the gate SHA', () => {
    const packet = writePacket(trustReleaseFixture());
    expect(() => trustReleaseGate(packet)).not.toThrow();
    expect(() => trustReleaseGate({ ...packet, expectedSha: 'd'.repeat(40) })).toThrow(/clause:release-identity/);
    expect(() => trustReleaseGate({ ...packet, receiptFile: undefined })).toThrow(/required/);
  });
  it('the merge-check CLI consumes the independent identity in either option order', () => {
    const packet = writePacket(trustReleaseFixture());
    const cli = fileURLToPath(new URL('./fuigo-bump.mjs', import.meta.url));
    for (const options of [
      ['--real-turns', packet.capturesDir, '--expected-release', packet.expectedFile],
      ['--expected-release', packet.expectedFile, '--real-turns', packet.capturesDir],
    ]) {
      const result = spawnSync(process.execPath, [cli, '--merge-check', packet.receiptFile, ...options], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    }
    writeFileSync(packet.expectedFile, JSON.stringify({ ...trustReleaseFixture().expected, murageSha: 'd'.repeat(40) }));
    const wrong = spawnSync(process.execPath, [cli, '--merge-check', packet.receiptFile,
      '--real-turns', packet.capturesDir, '--expected-release', packet.expectedFile], { encoding: 'utf8' });
    expect(wrong.status).toBe(1); expect(wrong.stderr).toContain('clause:release-identity');
  });
});


describe('architecture packet coverage', () => {
  it('requires every independently selected packaged x64/arm64 target on each OS', () => {
    const f = trustReleaseFixture(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64']);
    expect(() => mergeCheck(f.receipt, f.files, f.expected)).not.toThrow();
    expect(() => mergeCheck(f.receipt, f.files.slice(1), f.expected)).toThrow(/clause:release-identity/);
  });
  it('governed Ask cannot inherit the policy-free cat-never-cards proof', () => {
    const f = trustReleaseFixture(), file = f.files[0], name = file.row.steps.g2.processes[0];
    const records = file.folder.get(name).toString().trim().split('\n').map(JSON.parse);
    const updated = records.filter(record => record.msg.id !== 99).map((record, index) => JSON.stringify({ ...record, seq: index + 1 })).join('\n') + '\n';
    const bytes = Buffer.from(updated); file.folder.set(name, bytes);
    file.row.sha256[name] = createHash('sha256').update(bytes).digest('hex');
    expect(() => mergeCheck(f.receipt, f.files, f.expected)).toThrow(/step g2.*permission request/);
  });
});
