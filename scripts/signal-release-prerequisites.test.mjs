import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { gitFixture } from '../server/testing/git-fixture.mjs';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, afterEach, expect, it } from 'vitest';
import { auditReleaseMutations } from './release-mutation-audit.mjs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { BROWSER_ASSEMBLY_WORKFLOW, DRAFT_ASSEMBLY_REASON } from './release-assembly-inventory.mjs';

const root = new URL('../', import.meta.url);
let repository;
beforeAll(() => { repository = gitFixture(); }, 120_000);
afterAll(() => repository?.dispose());
const read = file => readFileSync(new URL(file, root), 'utf8');
const temporary = [];
afterEach(() => temporary.splice(0).forEach(dir => removeTempDirSync(dir)));

function checkSites(overrides = new Map()) {
  const report = auditReleaseMutations(repository.root, overrides);
  expect(report.errors, JSON.stringify(report.errors)).toEqual([]);
  return report;
}

it('all tracked files have one publication owner, gated at entry, and reviewed draft assembly', () => {
  const report = checkSites();
  expect(report.files).toBeGreaterThan(15000);
  // MAIN 2026-11-11 11:15Z classifies the three vendor sites as assembly.
  expect(report.hits.map(hit => hit.owner).sort()).toEqual(['browserVendorDraftAssembly', 'browserVendorDraftAssembly', 'browserVendorDraftAssembly', 'generateReleaseNotes', 'probeReleaseToken', 'probeReleaseToken', 'publishDraft', 'setReleaseBody', 'setReleaseBody', 'uploadDraft', 'uploadDraft']);
  const assembly = report.hits.filter(hit => hit.classification === 'assembly');
  expect(assembly).toHaveLength(3);
  expect(assembly.every(hit => hit.file === BROWSER_ASSEMBLY_WORKFLOW && hit.reason === DRAFT_ASSEMBLY_REASON)).toBe(true);
  console.log('RELEASE_AUDIT', JSON.stringify(report));
}, 60_000);

it('vendor upload without its isDraft refusal loses assembly classification', () => {
  const original = read(BROWSER_ASSEMBLY_WORKFLOW);
  const mutant = original.replace(/^.*--json isDraft.*\n/m, '');
  expect(mutant).not.toBe(original);
  const report = auditReleaseMutations(repository.root, new Map([[BROWSER_ASSEMBLY_WORKFLOW, mutant]]), [BROWSER_ASSEMBLY_WORKFLOW]);
  expect(report.hits).toHaveLength(3);
  expect(report.errors).toHaveLength(3);
  expect(report.hits.every(hit => !hit.classification)).toBe(true);
});

it('reads saved command output as data while auditing executable shell forms', () => {
  const command = 'gh release create v1';
  for (const file of ['evidence/fixture.log', 'evidence/fixture.diff', 'evidence/fixture.patch']) {
    const overrides = new Map([[file, command]]);
    expect(auditReleaseMutations(repository.root, overrides, [file]).errors, file).toEqual([]);
  }
  for (const file of ['scripts/fixture.sh', 'scripts/fixture.ps1', 'scripts/fixture.cmd', 'scripts/fixture.bat', 'scripts/fixture.zsh']) {
    expect(auditReleaseMutations(repository.root, new Map([[file, command]]), [file]).errors, file).toHaveLength(1);
  }
  const file = 'scripts/fixture';
  expect(auditReleaseMutations(repository.root, new Map([[file, `#!/usr/bin/env bash\n${command}`]]), [file]).errors).toHaveLength(1);
  expect(auditReleaseMutations(repository.root, new Map([['script.log', `#!/bin/sh\n${command}`]]), ['script.log']).errors).toHaveLength(1);
  writeFileSync(join(repository.root, 'executable.log'), command);
  chmodSync(join(repository.root, 'executable.log'), 0o755);
  expect(auditReleaseMutations(repository.root, new Map(), ['executable.log']).errors).toHaveLength(1);
});

it.each(['log', 'diff', 'patch', ''])('interpreter-invoked files stay in the mutation inventory: %s', extension => {
  const fixture = gitFixture(['package.json']);
  try {
    const file = `scripts/release${extension ? `.${extension}` : ''}`;
    mkdirSync(join(fixture.root, 'scripts'));
    writeFileSync(join(fixture.root, file), 'gh release create v1\n');
    chmodSync(join(fixture.root, file), 0o644);
    writeFileSync(join(fixture.root, 'package.json'), JSON.stringify({scripts: {release: `bash ${file}`}}));
    fixture.git('add', '--force', '--all');
    expect(fixture.git('ls-files', '--stage', '--', file)).toMatch(/^100644 /);
    const report = auditReleaseMutations(fixture.root);
    expect(report.errors).toEqual([expect.objectContaining({file, form: 'gh release mutation'})]);
  } finally { fixture.dispose(); }
});

// MAIN 2026-11-11 12:11Z: passive data must have no invocation reaching it.
it.each(['bash -e', 'bash -o pipefail', 'sh --', 'bash -x -u --norc --', 'zsh -e', 'pwsh -NoProfile -File'])('interpreter options reach mode-0644 evidence in the mutation inventory: %s', interpreter => {
  for (const entry of ['package', 'workflow', 'script', 'javascript']) {
    const fixture = gitFixture(['package.json']);
    try {
      const target = 'evidence/release.log';
      mkdirSync(join(fixture.root, 'evidence'));
      writeFileSync(join(fixture.root, target), 'gh release create v1\n');
      chmodSync(join(fixture.root, target), 0o644);
      writeFileSync(join(fixture.root, 'package.json'), JSON.stringify({scripts: entry === 'package' ? {fixture: `${interpreter} ${target}`} : {}}));
      if (entry === 'workflow') {
        mkdirSync(join(fixture.root, '.github/workflows'), {recursive: true});
        writeFileSync(join(fixture.root, '.github/workflows/fixture.yml'), `jobs:\n  fixture:\n    steps:\n      - run: ${interpreter} ${target}\n`);
      }
      if (entry === 'script') writeFileSync(join(fixture.root, 'entry.sh'), `${interpreter} ${target}\n`);
      if (entry === 'javascript') {
        const [command, ...args] = interpreter.split(' ');
        writeFileSync(join(fixture.root, 'entry.mjs'), `execFileSync(${JSON.stringify(command)}, ${JSON.stringify([...args, target])});`);
      }
      fixture.git('add', '--force', '--all');
      expect(fixture.git('ls-files', '--stage', '--', target)).toMatch(/^100644 /);
      expect(auditReleaseMutations(fixture.root).errors, entry).toEqual([expect.objectContaining({file: target, form: 'gh release mutation'})]);
    } finally { fixture.dispose(); }
  }
});
it('interpreter options inspect inline code and follow nested evidence in the mutation inventory', () => {
  const files = new Map([
    ['package.json', JSON.stringify({scripts: {fixture: `bash -c 'bash -e evidence/entry.log'`}})],
    ['evidence/entry.log', 'sh -- evidence/release.log'],
    ['evidence/release.log', 'gh release create v1\n'],
  ]);
  expect(auditReleaseMutations(repository.root, files, [...files.keys()]).errors).toEqual([expect.objectContaining({file: 'evidence/release.log', form: 'gh release mutation'})]);
});
it.each([
  ['node --no-warnings', 'require("node:child_process").execFileSync("gh", ["release", "create", "v1"]);'],
  ['python3 -u -W ignore', 'import os\nos.system("gh release create v1")'],
  ['if bash -e', 'gh release create v1'],
  ['FIXTURE=1 bash -e', 'gh release create v1'],
  ['.', 'gh release create v1'],
])('interpreter options select code syntax and shell command prefixes in the inventory: %s', (command, source) => {
  const files = new Map([
    ['package.json', JSON.stringify({scripts: {fixture: `${command} evidence/release.log${command.startsWith('if ') ? '; then :; fi' : ''}`}})],
    ['evidence/release.log', source],
  ]);
  expect(auditReleaseMutations(repository.root, files, [...files.keys()]).errors).toEqual([expect.objectContaining({file: 'evidence/release.log', form: 'gh release mutation'})]);
});
it('interpreter options leave uninvoked evidence passive in the mutation inventory', () => {
  const files = new Map([['package.json', '{"scripts":{}}'], ['evidence/release.log', 'gh release create v1\n']]);
  expect(auditReleaseMutations(repository.root, files, [...files.keys()]).errors).toEqual([]);
});
it.each([
  ['file', 'execFileSync("bash", ["-e", "evidence/release.log", process.env.VERSION]);'],
  ['option value', 'execFileSync("bash", ["-o", "pipefail", "evidence/release.log", process.env.VERSION]);'],
  ['inline', 'execFileSync("bash", ["-c", "bash -e evidence/release.log", process.env.VERSION]);'],
])('literal interpreter target with dynamic later arguments reaches the mutation inventory: %s', (_name, source) => {
  const fixture = gitFixture(['package.json']);
  try {
    const target = 'evidence/release.log';
    mkdirSync(join(fixture.root, 'evidence'));
    writeFileSync(join(fixture.root, target), 'gh release create v1\n');
    chmodSync(join(fixture.root, target), 0o644);
    writeFileSync(join(fixture.root, 'entry.mjs'), source);
    fixture.git('add', '--force', '--all');
    expect(fixture.git('ls-files', '--stage', '--', target)).toMatch(/^100644 /);
    expect(auditReleaseMutations(fixture.root).errors).toEqual([expect.objectContaining({file: target, form: 'gh release mutation'})]);
  } finally { fixture.dispose(); }
});

it.each([
  ['scripts/release-bypass.sh', `url=https://api.github.com/repos/FerroxLabs/murage-releases/releases
curl -X POST "$url" -H "Authorization: Bearer $GH_TOKEN" -H 'Content-Type: application/json' --data '{"tag_name":"v1.0.19","draft":true}'`],
  ['.github/workflows/release.yml', 'jobs:\n  bypass:\n    steps:\n      - run: gh api --method POST repos/o/r/releases -f tag_name=v1\n'],
  ['electron-builder.yml', 'publish:\n  - provider: github\n    owner: o\n    repo: r\n'],
  ['scripts/new-release.mjs', 'octokit.rest.repos.createRelease({draft:true});'],
  ['package.json', JSON.stringify({scripts:{bad:'gh release delete v1'}})],
  ['scripts/fixture.sh', 'gh api repos/o/r/releases/1 -X PATCH -f draft=false'],
  ['scripts/fixture.ps1', 'Invoke-RestMethod -Method PUT https://api.github.com/repos/o/r/releases/1'],
  ['scripts/new-release.ts', 'const url = "https://api.github.com/repos/o/r/releases"; fetch(url, {method:"POST"});'],
  ['scripts/new-release.mjs', 'octokit.request("DELETE /repos/o/r/releases/1");'],
  ['scripts/new-release.mjs', 'execFileSync("gh", ["api", "-X", "DELETE", "repos/o/r/releases/1"]);'],
  ['package.json', JSON.stringify({scripts:{bad:'electron-builder --publish onTagOrDraft'}})],
  ['scripts/new-builder.cjs', 'module.exports = {win: {publish: [{provider: "github"}]}};'],
])('structural mutant goes RED: %s (%s)', (file, source) => {
  const result = auditReleaseMutations(repository.root, new Map([[file, source]]), [file]);
  expect(result.errors.length, JSON.stringify(result)).toBeGreaterThan(0);
  expect(result.errors.every(hit => hit.file === file)).toBe(true);
});

it('workflow POST inserted before its existing gate goes RED', () => {
  const file = '.github/workflows/release.yml';
  const original = read(file);
  const mutant = original.replace('    steps:', '    steps:\n      - run: gh api --method POST repos/o/r/releases -f tag_name=v1');
  expect(mutant).not.toBe(original);
  const report = auditReleaseMutations(repository.root, new Map([[file, mutant]]), [file]);
  expect(report.errors.some(hit => hit.form === 'gh api mutation')).toBe(true);
});

it.each(['create', 'upload', 'edit', 'delete'])('rejects gh release %s', operation => {
  const file='scripts/mutant.sh';
  const report=auditReleaseMutations(repository.root,new Map([[file,`gh release ${operation} v1`]]),[file]);
  expect(report.errors).toHaveLength(1);
});
it.each(['POST', 'PATCH', 'PUT', 'DELETE'])('rejects API and REST %s in both method orders and JS', method => {
  const variants = [
    ['scripts/mutant.sh', `gh api --method ${method} repos/o/r/releases/1`],
    ['scripts/mutant.sh', `gh api repos/o/r/releases/1 -X${method}`],
    ['scripts/mutant.sh', `curl https://api.github.com/repos/o/r/releases/1 --request=${method}`],
    ['scripts/mutant.ts', `const options={method:"${method}"}; fetch("https://api.github.com/repos/o/r/releases/1",options);`],
  ];
  for (const [file,source] of variants) expect(auditReleaseMutations(repository.root,new Map([[file,source]]),[file]).errors.length).toBeGreaterThan(0);
});
it.each(['createRelease','updateRelease','uploadReleaseAsset','deleteRelease'])('rejects octokit %s', method => {
  const file='scripts/mutant.ts';
  expect(auditReleaseMutations(repository.root,new Map([[file,`octokit.rest.repos.${method}({});`]]),[file]).errors).toHaveLength(1);
});
it.each(['always','onTag','onTagOrDraft'])('rejects builder publish policy %s', policy => {
  const file='package.json';
  expect(auditReleaseMutations(repository.root,new Map([[file,JSON.stringify({scripts:{bypass:`electron-builder --publish ${policy}`}})]]),[file]).errors).toHaveLength(1);
});
it('rejects another owner even if it copies the prerequisite check', () => {
  const file='scripts/mutant.mjs';
  const source=`import { assertSignalReleaseReady } from './signal-release-prerequisites.mjs';
    export function bypass() {assertSignalReleaseReady(); octokit.repos.createRelease({});}`;
  expect(auditReleaseMutations(repository.root,new Map([[file,source]]),[file]).errors).toHaveLength(1);
});

it('structural mutant: removing the upload entry check goes RED', () => {
  const file = 'scripts/release-guard.mjs';
  const original = read(file);
  const mutant = original.replace(/(export function uploadDraft[^\n]+\n)\s*assertSignalReleaseReady\(\);\n/, '$1');
  expect(mutant).not.toBe(original);
  const result = auditReleaseMutations(repository.root, new Map([[file, mutant]]), [file]);
  expect(result.errors.some(hit => hit.owner === 'uploadDraft')).toBe(true);
});

// Keep null-G0 fixtures isolated so landing real G0 evidence cannot make
// these refusal regressions contact GitHub or require live Signal accounts.
function nullPinFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'signal-release-refusal-')); temporary.push(dir);
  mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'ci'));
  for (const file of ['release-guard.mjs', 'signal-release-prerequisites.mjs', 'signal-gate-report.mjs']) {
    copyFileSync(new URL(`scripts/${file}`, root), join(dir, 'scripts', file));
  }
  mkdirSync(join(dir, 'server/testing'), { recursive: true });
  const safeWipe = new URL('server/testing/safe-wipe.mjs', root).href;
  writeFileSync(join(dir, 'server/testing/safe-wipe.mjs'), `export { safeWipeSync } from ${JSON.stringify(safeWipe)};\n`);
  copyFileSync(new URL('ci/gate-post-g0.txt', root), join(dir, 'ci/gate-post-g0.txt'));
  const inventory = new URL('scripts/signal-inventory.mjs', root).href;
  writeFileSync(join(dir, 'scripts/signal-inventory.mjs'), `
    export { assertReleasePin } from ${JSON.stringify(inventory)};
    export const json = () => ({ g0: null });
    export const PIN_PATH = 'isolated-null-pin';
    export const ROOT = ${JSON.stringify(dir)};
  `);
  return dir;
}

it.each(['upload', 'publish', 'body', 'probe', 'notes'])('direct %s command refuses null G0 before any external command', async command => {
  const dir = nullPinFixture();
  const { uploadDraft, publishDraft, setReleaseBody, probeReleaseToken, generateReleaseNotes } = await import(pathToFileURL(join(dir, 'scripts/release-guard.mjs')));
  writeFileSync(join(dir, 'asset.zip'), 'fixture');
  const calls = [];
  const run = (...args) => { calls.push(args); throw new Error('external command reached'); };
  const action = command === 'probe' ? () => probeReleaseToken('release-preflight-1-1', run) :
    command === 'notes' ? () => generateReleaseNotes('1.2.3', 'o/r', 'a'.repeat(40), run) :
    command === 'upload' ? () => uploadDraft('1.2.3', dir, join(dir, 'asset.zip'), run) :
    command === 'publish' ? () => publishDraft('1.2.3', 7, dir, run) :
      () => setReleaseBody('1.2.3', 7, join(dir, 'asset.zip'), 'main', run);
  expect(action).toThrow(/G0_REQUIRED/);
  expect(calls).toEqual([]);
});

it.each(['upload', 'publish', 'body', 'probe', 'probe-prepared', 'notes', 'notes-file', 'upload-prepared', 'verify-digests', 'publish-prepared'])('CLI %s refuses null G0 even with release opt-outs in the environment', command => {
  const result = spawnSync(process.execPath, ['scripts/release-guard.mjs', command, '1.2.3', '7', 'absent', 'main'], {
    cwd: nullPinFixture(), encoding: 'utf8', env: { PATH: '', RELEASE: '0', CI: '1', SKIP_SIGNAL_G0: '1', RUNNER_TEMP: tmpdir(), VERSION: '1.2.3' },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/G0_REQUIRED/);
});

it('both workflows require the shared CLI; the release guard bootstraps dependencies', () => {
  for (const file of ['prepare-release.yml', 'release.yml']) {
    const jobs = parse(read(`.github/workflows/${file}`)).jobs;
    const steps = jobs.prepare.steps;
    const check = steps.findIndex(step => step.run === 'node scripts/signal-release-check.mjs');
    expect(check, file).toBeGreaterThan(-1);
    expect(steps[check].if).toBeUndefined();
    expect(steps[check]['continue-on-error']).toBeUndefined();
    expect(jobs.prepare['continue-on-error']).toBeUndefined();
    const firstMutation = steps.findIndex(step => /git commit|git push/.test(step.run ?? ''));
    if (firstMutation >= 0) expect(check).toBeLessThan(firstMutation);
    if (jobs.assemble) {
      expect(jobs.assemble.needs).toContain('prepare');
      const assemble = jobs.assemble.steps;
      const install = assemble.findIndex(step => step.run === 'node scripts/release-guard.mjs bootstrap');
      expect(install).toBeGreaterThan(-1);
      for (const command of ['upload-prepared', 'publish-prepared']) {
        const at = assemble.findIndex(step => step.run?.includes(`node scripts/release-guard.mjs ${command}`));
        expect(at).toBeGreaterThan(install);
      }
    }
  }
  expect(read('scripts/signal-release-check.mjs')).toMatch(/assertSignalReleaseReady\(\)/);
});

// MAIN 2026-11-11 13:25Z: every literal file operand is executable audit input,
// including option values and arguments after the primary target or a spread.
it.each([
  ['node warnings', 'node', ['--redirect-warnings', 'warnings.log', 'evidence/release.log'], 'execFileSync("gh", ["release", "create", "v1"]);'],
  ['python warnings', 'python3', ['-W', 'ignore', 'file.py', 'evidence/release.log'], 'gh release create v1\n'],
  ['ruby include', 'ruby', ['-I', 'dir', 'file.rb', 'evidence/release.log'], 'gh release create v1\n'],
  ['shell option value', 'bash', ['-o', 'evidence/release.log', 'entry.sh'], 'gh release create v1\n'],
  ['node option value', 'node', ['--require', 'evidence/release.log', 'entry.mjs'], 'execFileSync("gh", ["release", "create", "v1"]);'],
  ['python option value', 'python3', ['-W', 'evidence/release.log', 'file.py'], 'gh release create v1\n'],
  ['ruby option value', 'ruby', ['-I', 'evidence/release.log', 'file.rb'], 'gh release create v1\n'],
])('fail-closed interpreter file candidates reach the mutation inventory: %s', (_name, command, args, code) => {
  for (const entry of ['package', 'workflow', 'script', 'wrapper', 'dynamic wrapper', 'spread wrapper']) {
    const fixture = gitFixture(['package.json']);
    try {
      const target = 'evidence/release.log';
      mkdirSync(join(fixture.root, 'evidence'));
      writeFileSync(join(fixture.root, target), code);
      chmodSync(join(fixture.root, target), 0o644);
      for (const name of ['warnings.log', 'ignore', 'file.py', 'dir', 'file.rb', 'entry.sh', 'entry.mjs']) writeFileSync(join(fixture.root, name), '');
      const invocation = `${command} ${args.join(' ')}`;
      writeFileSync(join(fixture.root, 'package.json'), JSON.stringify({scripts: entry === 'package' ? {fixture: invocation} : {}}));
      if (entry === 'script') writeFileSync(join(fixture.root, 'caller.sh'), invocation);
      if (entry.endsWith('wrapper')) {
        const prefix = entry === 'dynamic wrapper' ? 'process.env.UNKNOWN, ' : entry === 'spread wrapper' ? '...options, ' : '';
        writeFileSync(join(fixture.root, 'caller.mjs'), `execFileSync(${JSON.stringify(command)}, [${prefix}${args.map(arg => JSON.stringify(arg)).join(', ')}, process.env.VERSION]);`);
      }
      if (entry === 'workflow') {
        mkdirSync(join(fixture.root, '.github/workflows'), {recursive: true});
        writeFileSync(join(fixture.root, '.github/workflows/fixture.yml'), `jobs:\n  fixture:\n    steps:\n      - run: ${invocation}\n`);
      }
      fixture.git('add', '--force', '--all');
      expect(fixture.git('ls-files', '--stage', '--', target)).toMatch(/^100644 /);
      const report = auditReleaseMutations(fixture.root);
      expect(report.errors, entry).toEqual([expect.objectContaining({file: target, form: 'gh release mutation'})]);
      expect(report.executables, entry).toContainEqual({file: target, javascript: command === 'node'});
    } finally { fixture.dispose(); }
  }
});

it('fail-closed interpreter file candidates include absolute and untracked repository paths', () => {
  for (const tracked of [true, false]) {
    const fixture = gitFixture(['package.json']);
    try {
      const target = 'evidence/release.log';
      mkdirSync(join(fixture.root, 'evidence'));
      writeFileSync(join(fixture.root, target), 'gh release create v1\n');
      chmodSync(join(fixture.root, target), 0o644);
      writeFileSync(join(fixture.root, 'caller.mjs'), `execFileSync("bash", [process.env.UNKNOWN, "", ${JSON.stringify(join(fixture.root, target))}]);`);
      fixture.git('add', '--force', '--all');
      if (!tracked) fixture.git('rm', '--cached', '--', target);
      expect(fixture.git('ls-files', '--', target).trim()).toBe(tracked ? target : '');
      expect(auditReleaseMutations(fixture.root).errors).toEqual([expect.objectContaining({file: target, form: 'gh release mutation'})]);
    } finally { fixture.dispose(); }
  }
});
