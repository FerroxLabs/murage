// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { removeTempDirSync } from "../../server/testing/cleanup.ts";
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitFixture } from "../../server/testing/git-fixture.mjs";
import { sharedDirectory } from './check.mjs';

const cli = fileURLToPath(new URL('./check.mjs', import.meta.url));
const dirs = [];
const env = { ...process.env };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commit(dir) {
  git(dir, ['add', '.']);
  git(dir, ['-c', 'user.name=ci', '-c', 'user.email=ci@example.test', 'commit', '-qm', 'fixture']);
  return git(dir, ['rev-parse', 'HEAD']);
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'murage-shared-guard-')); dirs.push(dir);
  git(dir, ['init', '-q']);
  writeFileSync(join(dir, 'fixture.txt'), 'neutral\n');
  return { dir, base: commit(dir) };
}
function run(dir, base, extra = [], overrides = {}) {
  return spawnSync(process.execPath, [cli, '--root', dir, '--base', base, ...extra], { encoding: 'utf8', env: { ...env, ...overrides } });
}
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

// Positive fixture values are assembled only at runtime, never stored whole.
const samples = [
  ["do-", "nyc3"].join(''),
  ["registry.dig", "italocean.com"].join(''),
  ["flux-rout", "er-shadow"].join(''),
  ["flux-s", "taging"].join(''),
  ["deploy", "/fable1"].join(''),
  ["/root/fl", "ux-builds"].join(''),
  ["mislab", "el-402"].join(''),
  ["stagi", "ng pod"].join(''),
  ["FLUX_FIXTU", "RE_ENABLED"].join(''),
  ["FLUX_PAID_P", "AUSE_AT_ZERO"].join(''),
  ["FLUX_SOUR", "CE_COMMIT"].join(''),
  ["9eaa", "161b"].join(''),
  ["1e1481", "114301"].join(''),
  ["be60a1", "e9100a"].join(''),
  ["src/forg", "e_hook.py"].join(''),
  ["forge_", "hook.py"].join(''),
  ["src/rate_", "limiter.py"].join(''),
  ["src/anthrop", "ic_messages/"].join(''),
  ["src/response", "s/endpoint.py"].join(''),
  ["key_mont", "hly_fence"].join(''),
  ["free_tier_c", "ogs_breaker"].join(''),
  ["The ", "Forge"].join(''),
  ["flux-p", "roxy-a"].join(''),
  ["localho", "st:4000"].join(''),
  ["src/flux_cre", "dit_state.py"].join(''),
  ["src/key_mont", "hly_fence.py"].join(''),
  ["src/paid", "_pause.py"].join(''),
  ["\"file", "_line\""].join(''),
  ["AMEND-b", "usyloop"].join(''),
  ["busyloo", "p-ruling"].join(''),
  ["Fable 5.2 mo", "del additions"].join(''),
  ["tail0", "a48a4"].join(''),
];

describe('shared guard fixtures', () => {
  it('accepts a clean committed tree and its added lines', () => {
    const { dir, base } = fixture();
    const result = run(dir, base);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('shared leak-guard: whole-tree 0 hit(s); added-lines 0 hit(s); exit 0\n');
    expect(result.stderr).toBe('');
  });

  it('delegates every shared pattern to the shared script without disclosing fixture contents', () => {
    const patterns = readFileSync(join(sharedDirectory, 'public-leak-patterns.txt'), 'utf8').split(/\r?\n/).filter(s => s.trim() && !s.trim().startsWith('#'));
    expect(samples.length).toBe(patterns.length);
    for (const [i, sample] of samples.entries()) {
      const probe = spawnSync('grep', ['-Eq', patterns[i]], { input: sample, encoding: 'utf8' });
      expect(probe.status, `sample for shared rule ${i + 1}`).toBe(0);
      const { dir, base } = fixture();
      writeFileSync(join(dir, 'fixture.txt'), `neutral\nprivate-fixture-sentinel ${sample}\n`);
      commit(dir);
      const result = run(dir, base);
      expect(result.status, `shared rule ${i + 1}`).toBe(1);
      expect(result.stdout).toBe('shared leak-guard: whole-tree 1 hit(s); added-lines 1 hit(s); exit 1\n');
      expect(result.stderr).toBe('');
      expect(result.stdout + result.stderr).not.toContain('private-fixture-sentinel');
    }
  }, 120_000);

  it('counts existing hits in HEAD even when no matching line is added', () => {
    const { dir } = fixture();
    writeFileSync(join(dir, 'fixture.txt'), samples[0] + '\n');
    const base = commit(dir);
    const result = run(dir, base);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('whole-tree 1 hit(s); added-lines 0 hit(s)');
  });

  it('reports an added forbidden line after a NUL in a text-diffed file', () => {
    const { dir, base } = fixture();
    writeFileSync(join(dir, '.gitattributes'), 'fixture.txt diff\n');
    writeFileSync(join(dir, 'fixture.txt'), `neutral\n\0encoding fixture\n${samples[0]}\n`);
    commit(dir);
    const result = run(dir, base);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('added-lines 1 hit(s); exit 1');
    expect(result.stderr).toBe('');
  });

  it('does not count deleted matching lines as additions', () => {
    const { dir } = fixture();
    writeFileSync(join(dir, 'fixture.txt'), samples[0] + '\n');
    const base = commit(dir);
    writeFileSync(join(dir, 'fixture.txt'), 'neutral\n');
    commit(dir);
    expect(run(dir, base).status).toBe(0);
  });

  it('uses committed HEAD, not uncommitted or staged content', () => {
    const { dir, base } = fixture();
    writeFileSync(join(dir, 'fixture.txt'), samples[0] + '\n');
    git(dir, ['add', '.']);
    expect(run(dir, base).status).toBe(0);
    commit(dir);
    expect(run(dir, base).status).toBe(1);
  });

  it('rejects missing shared files, invalid refs and obsolete options without echoing inputs', () => {
    const { dir, base } = fixture();
    for (const result of [
      run(dir, 'missing-private-fixture-sentinel'),
      run(dir, base, ['--patterns', 'private-fixture-sentinel']),
      run(dir, base, ['--diff', 'private-fixture-sentinel']),
      run(dir, base, [], { PUBLIC_LEAK_GUARD_SHARED_DIR: dir }),
    ]) {
      expect(result.status).toBe(2);
      expect(result.stdout + result.stderr).not.toContain('private-fixture-sentinel');
    }
  });
});

describe('shared repository release gate', () => {
  it('requires both the committed repository and release additions to be clean', () => {
    const repository = gitFixture();
    try {
      // An empty committed baseline makes every source byte an addition. This
      // checks the whole exported tree and additions without runner Git metadata.
      repository.git('read-tree', '--empty');
      const save = () => repository.git('-c', 'user.name=ci', '-c', 'user.email=ci@example.test', 'commit', '--allow-empty', '-qm', 'isolated source snapshot');
      save();
      const base = repository.git('rev-parse', 'HEAD').trim();
      repository.git('add', '--force', '--all'); save();
      const result = spawnSync(process.execPath, [cli, '--root', repository.root, '--base', base], { encoding: 'utf8', env: repository.env });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally { repository.dispose(); }
  }, 120_000);
});
