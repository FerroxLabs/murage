import { createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTempDirSync } from '../server/testing/cleanup.ts';
import { trustReleaseGate } from './fuigo-trust-release.mjs';
import { trustReleaseFixture } from './fuigo-trust-evidence-v3.fixture.mjs';
import { TRUST_V3_CASES } from './fuigo-trust-evidence-v3.mjs';
import { assembleTrust, checkTrustBound, trustCaptureStatus, trustInstallers } from './fuigo-trust-capture.mjs';

const TARGETS = ['darwin-arm64', 'linux-x64', 'win32-x64'];
// The installers carry the release version the packets were captured for (the fixture release).
const VERSION = trustReleaseFixture(TARGETS).expected.packageVersion;
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
const digest = text => createHash('sha256').update(text).digest('hex');
const sumsFor = (names = trustInstallers(VERSION)) =>
  `${[...names, 'SHA256SUMS-ubuntu-x64.txt', `Murage-${VERSION}-x64.dmg`].map(name => `${digest(name)}  ${name}`).join('\n')}\n`;

/** One raw capture host output per target (<target>.json + <target>/), as the capture driver leaves it. */
const stage = (f = trustReleaseFixture(TARGETS), sums = sumsFor()) => {
  const dir = mkdtempSync(join(tmpdir(), 'trust-capture-')); dirs.push(dir);
  const raw = join(dir, 'raw'); mkdirSync(raw);
  for (const { name, row, folder } of f.files) {
    writeFileSync(join(raw, name), JSON.stringify(row));
    const osDir = join(raw, name.slice(0, -5)); mkdirSync(osDir);
    for (const [file, bytes] of folder) writeFileSync(join(osDir, file), bytes);
  }
  const expectedFile = join(dir, 'expected.json'), sumsFile = join(dir, 'SHA256SUMS');
  writeFileSync(expectedFile, JSON.stringify(f.expected)); writeFileSync(sumsFile, sums);
  return { f, raw, expectedFile, sumsFile, outDir: join(dir, 'stage', 'trust'), version: VERSION,
    binding: { ...f.receipt, schema: 2, real_turns: 'owed' }, args: { rawDir: raw, expectedFile, sumsFile, version: VERSION, outDir: join(dir, 'stage', 'trust'), binding: { ...f.receipt, schema: 2, real_turns: 'owed' } } };
};
const editRow = (s, target, change) => {
  const file = join(s.raw, `${target}.json`), row = JSON.parse(readFileSync(file, 'utf8'));
  change(row); writeFileSync(file, JSON.stringify(row));
};

describe('W-CAP1 capture runner stages a packet the release gate and the stage kit accept', () => {
  it('assembles every selected target x 29 cases into expected/receipt/captures/BOUND', () => {
    const s = stage();
    const result = assembleTrust(s.args);
    expect(['expected.json', 'receipt.json', 'BOUND', 'captures'].filter(name => !existsSync(join(s.outDir, name))), 'staged files').toEqual([]);
    expect(result.targets.sort()).toEqual(TARGETS);
    expect(result.cases).toBe(29);
    const receipt = JSON.parse(readFileSync(join(s.outDir, 'receipt.json'), 'utf8'));
    expect(receipt.real_turns, 'receipt is rebuilt from the captures, not copied').toEqual(s.f.receipt.real_turns);
    expect(() => trustReleaseGate({ expectedFile: join(s.outDir, 'expected.json'), receiptFile: join(s.outDir, 'receipt.json'),
      capturesDir: join(s.outDir, 'captures'), expectedSha: s.f.expected.murageSha })).not.toThrow();
    expect(checkTrustBound(readFileSync(join(s.outDir, 'BOUND')), readFileSync(s.sumsFile), VERSION), 'stage kit check_trust_bound').toBe(true);
  });
  it('the CLI stages through the same path and status reports READY', () => {
    const s = stage(), cli = fileURLToPath(new URL('./fuigo-trust-capture.mjs', import.meta.url));
    const bindingFile = join(s.raw, '..', 'binding.json'); writeFileSync(bindingFile, JSON.stringify(s.binding));
    const status = spawnSync(process.execPath, [cli, 'status', '--raw', s.raw, '--expected', s.expectedFile], { encoding: 'utf8' });
    expect(status.status, status.stdout + status.stderr).toBe(0);
    expect(status.stdout.trim().split('\n').map(line => line.split('\t').slice(0, 4).join(' '))).toEqual(TARGETS.map(target => `${target} ${{ darwin: 'macos', linux: 'linux', win32: 'windows' }[target.split('-')[0]]} READY 29/29`));
    const run = spawnSync(process.execPath, [cli, 'assemble', '--raw', s.raw, '--expected', s.expectedFile, '--sums', s.sumsFile,
      '--version', VERSION, '--binding', bindingFile, '--out', s.outDir], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(join(s.outDir, 'BOUND'))).toBe(true);
  });
});

describe('W-CAP2 partial or unbound evidence stages nothing', () => {
  const nothing = s => { expect(existsSync(s.outDir), 'no staged trust dir').toBe(false); expect(existsSync(join(s.outDir, '..')) ? readdirSync(join(s.outDir, '..')).filter(name => name.startsWith('trust.capture-')) : [], 'no temp left').toEqual([]); };
  it('a target missing one TRUST_V3 case is refused and named', () => {
    const s = stage(); editRow(s, 'linux-x64', row => { delete row.trustV3.cases.stop; });
    expect(() => assembleTrust(s.args)).toThrow(/linux-x64: owed=stop stop: trust-v3/);
    nothing(s);
  });
  it('a selected target with no raw packet is refused', () => {
    const f = trustReleaseFixture(TARGETS), s = stage(f);
    removeTempDirSync(join(s.raw, 'win32-x64')); removeTempDirSync(join(s.raw, 'win32-x64.json'));
    expect(() => assembleTrust(s.args)).toThrow(/no whole raw packet for win32-x64/);
    nothing(s);
  });
  it('staged SHA256SUMS without a designated installer is refused', () => {
    const s = stage(undefined, sumsFor(trustInstallers(VERSION).filter(name => !name.endsWith('setup.exe'))));
    expect(() => assembleTrust(s.args)).toThrow(/setup\.exe, found 0/);
    nothing(s);
  });
  it('an existing staged trust dir is never overwritten', () => {
    const s = stage(); mkdirSync(s.outDir, { recursive: true }); writeFileSync(join(s.outDir, 'keep'), 'x');
    expect(() => assembleTrust(s.args)).toThrow(/already exists/);
    expect(readFileSync(join(s.outDir, 'keep'), 'utf8')).toBe('x');
  });
  it('installers named for another release than the packets are refused before anything is written', () => {
    const other = '1.0.24', s = stage(undefined, sumsFor(trustInstallers(other)));
    expect(s.f.expected.packageVersion, 'fixture packets are for another release').not.toBe(other);
    expect(() => assembleTrust({ ...s.args, version: other }), 'packets and installer bindings name one release').toThrow(/installers are for 1\.0\.24 but the packets are for 1\.0\.20/);
    nothing(s);
  });
  it('a receipt binding for another release is refused before anything is written', () => {
    const s = stage();
    expect(() => assembleTrust({ ...s.args, binding: { ...s.binding, murageSha: '3'.repeat(40) } })).toThrow(/not this Murage sha/);
    nothing(s);
  });
});

describe('W-CAP3 BOUND mirrors the stage kit', () => {
  it('refuses SHA256SUMS changed after binding, a swapped installer and a short list', () => {
    const s = stage(); assembleTrust(s.args);
    const bound = readFileSync(join(s.outDir, 'BOUND')), sums = readFileSync(s.sumsFile);
    expect(checkTrustBound(bound, Buffer.concat([sums, Buffer.from('x\n')]), VERSION)).toBe(false);
    const lines = bound.toString().trim().split('\n');
    expect(checkTrustBound(Buffer.from(`${lines.slice(0, 4).join('\n')}\n`), sums, VERSION)).toBe(false);
    expect(checkTrustBound(Buffer.from(`${[...lines.slice(0, 4), `${digest(`Murage-${VERSION}-x64.dmg`)}  Murage-${VERSION}-x64.dmg`].join('\n')}\n`), sums, VERSION)).toBe(false);
    expect(checkTrustBound(bound, sums, '1.0.25')).toBe(false);
    expect(checkTrustBound(Buffer.from(`${[lines[0], '', ...lines.slice(1)].join('\n')}\n`), sums, VERSION), 'a blank line is an empty kit field').toBe(false);
    expect(checkTrustBound(Buffer.from(`${[lines[0], ...lines.slice(1, 4), `${lines[4]} extra`].join('\n')}\n`), sums, VERSION), 'the kit name is the rest of the line').toBe(false);
  });
});

describe('W-CAP4 status lists exactly what each target still owes', () => {
  it('owed cases per target, and a missing target is owed whole', () => {
    const s = stage();
    editRow(s, 'darwin-arm64', row => { for (const id of ['managed-desk', 'old-version']) delete row.trustV3.cases[id]; });
    removeTempDirSync(join(s.raw, 'win32-x64')); removeTempDirSync(join(s.raw, 'win32-x64.json'));
    const rows = Object.fromEntries(trustCaptureStatus(s.raw, s.f.expected).map(row => [row.target, row]));
    expect(rows['linux-x64']).toMatchObject({ ready: true, captured: 29, owed: [], fault: null });
    expect(rows['darwin-arm64']).toMatchObject({ ready: false, captured: 27, owed: ['old-version', 'managed-desk'] });
    expect(rows['win32-x64']).toMatchObject({ ready: false, captured: 0, fault: 'no raw packet' });
    expect(rows['win32-x64'].owed).toEqual([...TRUST_V3_CASES]);
  });
});

describe('W-CAP5 staging never removes what it does not own', () => {
  it('a pre-existing sibling at the old predictable temp path survives, and two stagings use distinct temp dirs', () => {
    const s = stage(), sibling = `${s.outDir}.capture-tmp`;
    mkdirSync(sibling, { recursive: true }); writeFileSync(join(sibling, 'other-run'), 'keep');
    assembleTrust(s.args);
    assembleTrust({ ...s.args, outDir: `${s.outDir}-second` });
    expect([existsSync(join(sibling, 'other-run')) ? readFileSync(join(sibling, 'other-run'), 'utf8') : 'deleted', existsSync(join(s.outDir, 'BOUND')), existsSync(join(`${s.outDir}-second`, 'BOUND'))], 'sibling kept, both staged').toEqual(['keep', true, true]);
  });
});

describe('W-CAP6 two concurrent stagings of the same output', () => {
  it('exactly one publishes a whole dir the gate accepts; the other refuses and leaves no temp', async () => {
    const s = stage(), cli = fileURLToPath(new URL('./fuigo-trust-capture.mjs', import.meta.url));
    const bindingFile = join(s.raw, '..', 'binding.json'); writeFileSync(bindingFile, JSON.stringify(s.binding));
    const run = () => new Promise(done => {
      const child = spawn(process.execPath, [cli, 'assemble', '--raw', s.raw, '--expected', s.expectedFile, '--sums', s.sumsFile, '--version', VERSION, '--binding', bindingFile, '--out', s.outDir]);
      child.on('close', code => done(code));
    });
    const codes = await Promise.all([run(), run()]);
    const temps = readdirSync(join(s.outDir, '..')).filter(name => name.startsWith('trust.capture-'));
    expect([codes.sort(), temps], 'one publishes, one refuses, no temp left').toEqual([[0, 1], []]);
    expect(() => trustReleaseGate({ expectedFile: join(s.outDir, 'expected.json'), receiptFile: join(s.outDir, 'receipt.json'),
      capturesDir: join(s.outDir, 'captures'), expectedSha: s.f.expected.murageSha })).not.toThrow();
    expect(checkTrustBound(readFileSync(join(s.outDir, 'BOUND')), readFileSync(s.sumsFile), VERSION)).toBe(true);
  }, 30000);
});

describe('W-CAP7 a staging that loses the publish rename removes its own temp', () => {
  it('another run publishing the output between the guard and the rename: refused, the winner kept, no temp left', () => {
    const s = stage(), rename = fs.renameSync;
    fs.renameSync = (from, to) => { mkdirSync(to, { recursive: true }); writeFileSync(join(to, 'winner'), 'w'); return rename(from, to); };
    syncBuiltinESMExports();
    try { expect(() => assembleTrust(s.args)).toThrow(/ENOTEMPTY|EEXIST|EPERM/); } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    const temps = readdirSync(join(s.outDir, '..')).filter(name => name.startsWith('trust.capture-'));
    expect([readdirSync(s.outDir), temps], 'winner untouched, loser temp removed').toEqual([['winner'], []]);
  });
});
