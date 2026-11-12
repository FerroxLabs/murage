import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineSpecs, scenarios } from './scenarios.mjs';
test('release CLI fails missing engines and replay, emits one complete summary and verdict', () => {
  const root = mkdtempSync(join(tmpdir(), 'gnl-cli-'));
  try {
    const engines = join(root, 'engines.json'); writeFileSync(engines, '{}');
    const result = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./run.mjs', import.meta.url)),
      '--live', '--release', '--platform', process.platform, '--candidate', 'a'.repeat(40), '--engines-file', engines, '--out', join(root, 'out')], { encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 1, result.stderr);
    const lines = result.stdout.split('\n').filter(s => s.startsWith('GNL-RESULT ')); assert.equal(lines.length, 1, result.stderr);
    assert.match(lines[0], new RegExp(`^GNL-RESULT rows=${engineSpecs.length * scenarios.length} pass=0 nonwipe_cards=0 refusals=0 skipped=0$`));
    const report = JSON.parse(readFileSync(join(root, 'out/verdict.json')));
    assert.equal(report.verdict, 'FAIL'); assert.ok(report.engines.every(e => e.status === 'FAIL'));
    assert.equal(report.replay.verdict, 'FAIL'); assert.equal(report.replay.status, 'UNPROVEN');
    assert.equal(report.mandatory.verdict, 'FAIL');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('invalid CLI still emits one failing machine summary', () => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./run.mjs', import.meta.url)), '--bad-option'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 1); assert.equal(r.stdout.split('\n').filter(s => s.startsWith('GNL-RESULT ')).length, 1);
});
