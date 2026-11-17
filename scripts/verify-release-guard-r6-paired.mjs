// SPDX-License-Identifier: AGPL-3.0-or-later
// Container only. Every shard gets its own source snapshot and fixture state.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join, relative } from 'node:path';
const root = resolve('.'), out = resolve(process.argv[2]), candidateOnly = process.argv[3] === 'candidate';
const scratch = mkdtempSync(join(tmpdir(), 'release-r6-paired-'));
const hash = value => createHash('sha256').update(value).digest('hex');
const baseline = JSON.parse(readFileSync(join(out, 'baseline-source-bytes.json'), 'utf8'));
const selected = JSON.parse(readFileSync(join(out, 'selected-files.json'), 'utf8'));
const baseSelected = JSON.parse(readFileSync(join(out, 'baseline-selected-files.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(out, '../final-source-sha256.json'), 'utf8'));
const receipt = { baseline: baseline.commit, selected, baseSelected, candidateHashes: {}, baselineHashes: {}, runs: [] };
try {
  cpSync(root, scratch, { recursive: true, filter: path => !['node_modules', '.git', 'lane-evidence', 'dist', 'dist-server'].includes(relative(root, path).split('/')[0]) });
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'));
  for (const [path, expected] of Object.entries(manifest)) {
    receipt.candidateHashes[path] = hash(readFileSync(join(scratch, path)));
    assert.equal(receipt.candidateHashes[path], expected, 'final bytes: ' + path);
  }
  const originals = Object.fromEntries(Object.keys(baseline.sources).map(path => [path, readFileSync(join(scratch, path))]));
  const run = (mode, files) => {
    const args = ['node_modules/vitest/vitest.mjs', 'run', ...files, '--maxWorkers=2', '--reporter=json', '--outputFile=' + join(out, mode + '.json')];
    const result = spawnSync(process.execPath, args, { cwd: scratch, encoding: 'utf8', timeout: 900000, maxBuffer: 32 * 1024 * 1024 });
    writeFileSync(join(out, mode + '.log'), result.stdout + result.stderr);
    receipt.runs.push({ mode, args, exitCode: result.status, signal: result.signal, error: result.error?.message });
    assert.equal(result.signal, null, mode + ' finished'); if (result.error) throw result.error;
    assert.ok([0, 1].includes(result.status));
  };
  if (!candidateOnly) try {
    for (const [path, text] of Object.entries(baseline.sources)) {
      writeFileSync(join(scratch, path), text); receipt.baselineHashes[path] = hash(text);
    }
    run('baseline', baseSelected);
  } finally {
    for (const [path, text] of Object.entries(originals)) writeFileSync(join(scratch, path), text);
    receipt.restored = Object.entries(originals).every(([path, text]) => hash(readFileSync(join(scratch, path))) === hash(text));
    assert.equal(receipt.restored, true);
  }
  run('candidate', selected);
} finally {
  writeFileSync(join(out, candidateOnly ? 'candidate-receipt.json' : 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(receipt.runs));
