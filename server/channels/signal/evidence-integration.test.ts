// Synthetic contract tests only; no account or live captures.
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
// @ts-expect-error Shared ESM contract is also consumed by release scripts.
import { makeSyntheticEvidence } from '../../../scripts/fixtures/signal-test-evidence.mjs';
// @ts-expect-error Shared ESM contract is also consumed by release scripts.
import { verifySignalEvidence } from './evidence.mjs';
import { loadSignalAdapters } from './adapters.ts';
import { gitFixture } from "../../testing/git-fixture.mjs";
let repository: ReturnType<typeof gitFixture>;
beforeAll(() => { repository = gitFixture(); }, 120_000);
afterAll(() => repository?.dispose());
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => removeTempDirSync(root)));
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'signal-synthetic-')); roots.push(dir); return { dir, ...makeSyntheticEvidence(dir) }; }
test('T-EVIDENCE-ONE-SCHEMA: the verifier and loader accept one manifest with unlink', () => {
  const f = fixture(); expect(() => verifySignalEvidence(f.pin, f.dir)).not.toThrow();
  const adapters = loadSignalAdapters(f.pin, f.dir); expect(adapters.verified).toBe(true); expect(adapters.linkProtocol?.unlink).toBeDefined();
});
test.each([
  ['own note mutated', (m: any) => { m.fixtures.find((f: any) => f.id === 'own-note').origin = 'mutated'; }],
  ['mutation without parent', (m: any) => { delete m.fixtures.find((f: any) => f.id === 'pni-sync').from; }],
  ['devices collide', (m: any) => { m.captureDevices.P = m.captureDevices.M; }],
  ['primary device', (m: any) => { m.captureDevices.Q = 1; }],
  ['unknown device', (m: any) => { m.fixtures[0].capturedOn = 'R'; }],
  ['wrong response device', (m: any) => { m.fixtures.find((f: any) => f.id === 'unlink-response').capturedOn = 'M'; }],
  ['wrong proof device', (m: any) => { m.unlinkProof.deviceId = m.captureDevices.M; }],
  ['survivor before response', (m: any) => { m.fixtures.find((f: any) => f.id === 'unlink-survivor').captureSequence = 1; }],
  ['no phone confirmation', (m: any) => { delete m.unlinkProof.phoneConfirmedPeerRemoved; }],
  ['proof without success', (m: any) => { m.results['S7-UNLINK'] = false; }],
  ['no echo path', (m: any) => { m.results['S1-TS'] = false; m.results['S1-ECHO'] = false; }],
])('T-MUTATED-ORIGIN/T-CAPTURE-DEVICES/T-UNLINK-BINDING/T-ACTIVATION-ECHO: rejects %s', (_, mutate) => {
  const f = fixture(); mutate(f.manifest); f.save(); expect(() => verifySignalEvidence(f.pin, f.dir)).toThrow();
  expect(loadSignalAdapters(f.pin, f.dir).verified).toBe(false);
});
// @ts-expect-error Shared ESM artifact binding.
import { artifactBinding, SIGNAL_CLI_COMMIT } from './evidence.mjs';
import { readFileSync, writeFileSync, linkSync, symlinkSync, renameSync } from 'node:fs';
test.each(['S1-TS', 'S1-ECHO'])('T-ACTIVATION-ECHO: %s alone enables adapters', key => {
 const f = fixture(); f.manifest.results['S1-TS'] = key === 'S1-TS'; f.manifest.results['S1-ECHO'] = key === 'S1-ECHO'; f.save();
 expect(loadSignalAdapters(f.pin, f.dir).verified).toBe(true);
});
test('T-BINDING-SCOPE: hosting/signing policy changes keep evidence valid; runtime bytes do not', () => {
 const f = fixture(); const target = f.pin.targets['linux-x64']; target.integrity = { executables: {}, resigned: null };
 f.manifest.artifactSha256 = artifactBinding(f.pin); f.save(); f.pin.g0.artifactSha256 = artifactBinding(f.pin);
 const before = artifactBinding(f.pin);
 f.pin.releaseInputs['linux-x64'].url = 'https://another.example.test/runtime';
 target.integrity.resigned = { paths: ['native/libsignal_jni.so'], identity: { teamId: 'SYNTHETIC' } };
 expect(artifactBinding(f.pin)).toBe(before); expect(loadSignalAdapters(f.pin, f.dir).verified).toBe(true);
 for (const change of ['archive', 'jar', 'http', 'layout']) {
  const pin = structuredClone(f.pin);
  if (change === 'archive') pin.releaseInputs['linux-x64'].sha256 = '0'.repeat(64);
  if (change === 'jar') pin.targets['linux-x64'].jars[0].sha256 = '0'.repeat(64);
  if (change === 'http') pin.releaseInputs['linux-x64'].url = 'http://example.test/runtime';
  if (change === 'layout') delete pin.releaseInputs['linux-x64'].layout;
  expect(() => verifySignalEvidence(pin, f.dir)).toThrow();
 }
});
test.each(['unlink-response', 'unlink-survivor'])('T-UNLINK-BINDING: success requires %s', id => {
 const f = fixture(); f.manifest.fixtures = f.manifest.fixtures.filter((row: any) => row.id !== id);
 rmSync(join(f.dir, `${id}.json`)); f.save(); expect(() => verifySignalEvidence(f.pin, f.dir)).toThrow();
});
test('T-UNLINK-BINDING: a proven echo may activate without unlink, but cannot authorize it', () => {
 const f = fixture(); f.manifest.results['S7-UNLINK'] = false; delete f.manifest.unlinkProof;
 f.manifest.fixtures = f.manifest.fixtures.filter((row: any) => !row.id.startsWith('unlink-'));
 for (const id of ['unlink-response', 'unlink-survivor']) rmSync(join(f.dir, `${id}.json`)); f.save();
 expect(loadSignalAdapters(f.pin, f.dir)).toMatchObject({ verified: true });
 expect(loadSignalAdapters(f.pin, f.dir).linkProtocol?.unlink).toBeUndefined();
});
test.each(['hardlink', 'symlink', 'parent-symlink', 'extra', 'oversized'])('T-EVIDENCE-FILE-CUSTODY: rejects %s', kind => {
 const f = fixture(), path = join(f.dir, 'own-note.json'); let dir = f.dir;
 if (kind === 'extra') writeFileSync(join(f.dir, 'extra.json'), '{}');
 if (kind === 'oversized') writeFileSync(path, Buffer.alloc(1024 * 1024 + 1));
 if (kind === 'hardlink') linkSync(path, join(f.dir, 'extra.json'));
 if (kind === 'symlink') { rmSync(path); symlinkSync(join(f.dir, 'edit.json'), path); }
 if (kind === 'parent-symlink') { renameSync(f.dir, f.dir + '-real'); roots.push(f.dir + '-real'); symlinkSync(f.dir + '-real', f.dir); }
 expect(() => verifySignalEvidence(f.pin, dir)).toThrow();
});
test('T-EVIDENCE-SINGLE-OWNER: production consumers declare no parallel evidence schema or commit', () => {
 for (const name of ['adapters.ts', 'unlink.ts']) {
  const source = readFileSync(new URL(name, import.meta.url), 'utf8');
  expect(source).not.toMatch(/(?:manifestSchema|REQUIRED_\w*FIXTURES|defaultFixtureDirectory|readEvidence)/);
  expect(source).not.toContain(SIGNAL_CLI_COMMIT); expect(source).not.toContain('source' + 'Commit');
 }
});

// Exact I1 scope (MAIN ruling): the S/Signal tree, plus repository files
// named by r1.1 (including its inherited r1 paths). Upstream Java/Kotlin files
// and the external live-session harness are not files in this repository.
const SIGNAL_I1_GLOBS = [
 'server/channels/signal/**', 'scripts/signal-*', 'src/components/Signal*',
 'server/signal-*', 'server/index.ts',
 'scripts/{build,normalize,merge,publish,stage}-signal-*.{sh,mjs}',
 'scripts/fixtures/signal-*', 'scripts/release-workflows.test.mjs',
 '.github/workflows/{release,prepare-release,signal-runtime-inputs,signal-runtime-input-check}.yml',
 'electron-builder.yml', 'electron/vendor/electron-updater.cjs',
 'docs/verification/evidence/signal-sync/{SYNC-CITATIONS.md,sync-proof.json}',
 // Historical/proposed names are included even when not present in S.
 '**/jre-inputs.json',
];
test('T-EVIDENCE-SINGLE-OWNER: r1.1 I1 forbids the legacy commit token in the Signal tree', () => {
 const listing = repository.git("ls-files", "-z");
 const forbidden = Buffer.from('source' + 'Commit');
 const files = listing.split('\0').filter(file => file && SIGNAL_I1_GLOBS.some(glob => matchesGlob(file, glob)));
 for (const required of ['server/channels/signal/evidence.mjs', 'server/index.ts',
  'scripts/build-signal-runtime-inputs.sh', 'scripts/stage-signal-runtime.mjs',
  '.github/workflows/release.yml', 'electron-builder.yml', 'src/components/SignalSettings.tsx']) {
  expect(files).toContain(required);
 }
 expect(files).not.toContain('scripts/fuigo-bump.mjs');
 const offenders = files.filter(file => readFileSync(join(repository.root, file)).includes(forbidden));
 expect(offenders, 'r1.1 §7 I1: Signal tree and named integration files only').toEqual([]);
});

test('T-EVIDENCE-SINGLE-OWNER: Signal input builders import the commit and use the unified key', () => {
 for (const name of ['build-signal-runtime-inputs.sh', 'normalize-signal-runtime.mjs', 'merge-signal-runtime-inputs.mjs']) {
  const source = readFileSync(`scripts/${name}`, 'utf8');
  expect(source).not.toContain(SIGNAL_CLI_COMMIT); expect(source).not.toContain('source' + 'Commit');
 }
});
