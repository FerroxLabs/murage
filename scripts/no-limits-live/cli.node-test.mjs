import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { engineSpecs, scenarios } from './scenarios.mjs';
import { safeWipeSync } from '../../server/testing/safe-wipe.mjs';
test('release CLI fails missing engines and replay, emits one complete summary and verdict', () => {
  const root = mkdtempSync(join(tmpdir(), 'gnl-cli-'));
  try {
    const engines = join(root, 'engines.json'); writeFileSync(engines, '{}');
    // MAIN RULING: candidate-binding lane 5fa20b839164 admits only verified trees.
    // This missing-engine fixture isolates that unrelated prerequisite; real
    // candidate identity and content are asserted in afix-build/afix-cli-binding.
    const preload = join(root, 'candidate-fixture.mjs');
    writeFileSync(preload, `import {registerHooks,syncBuiltinESMExports} from 'node:module';
import cp from 'node:child_process';const spawn=cp.spawnSync;
cp.spawnSync=(file,...args)=>{if(file==='claude')throw Error('unexpected PATH engine launch');return spawn(file,...args);};syncBuiltinESMExports();
registerHooks({load(url,ctx,next){if(url===${JSON.stringify(new URL('./candidate-proof.mjs',import.meta.url).href)})return {format:'module',source:'export function verifyCandidate(){return {candidateSha:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",verified:true,qualificationOnly:true};}',shortCircuit:true};return next(url,ctx);}});`);
    const result = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./run.mjs', import.meta.url)),
      '--live', '--release', '--platform', process.platform, '--candidate', 'a'.repeat(40), '--engines-file', engines, '--out', join(root, 'out')], { encoding: 'utf8', timeout: 20000, env: {...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' ')} });
    assert.equal(result.status, 1, result.stderr);
    const lines = result.stdout.split('\n').filter(s => s.startsWith('GNL-RESULT ')); assert.equal(lines.length, 1, result.stderr);
    assert.match(lines[0], new RegExp(`^GNL-RESULT rows=${engineSpecs.length * scenarios.length} pass=0 nonwipe_cards=0 refusals=0 skipped=0$`));
    const report = JSON.parse(readFileSync(join(root, 'out/verdict.json')));
    assert.equal(report.verdict, 'FAIL'); assert.ok(report.engines.every(e => e.status === 'FAIL'));
    assert.equal(report.replay.verdict, 'FAIL'); assert.equal(report.replay.status, 'UNPROVEN');
    assert.equal(report.mandatory.verdict, 'FAIL');
    assert.equal(report.candidate.qualificationOnly, true);
    assert.deepEqual(report.errors, ['No requested engines installed; all engine rows UNPROVEN']);
  } finally { safeWipeSync(root); }
});
test('invalid CLI still emits one failing machine summary', () => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./run.mjs', import.meta.url)), '--bad-option'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 1); assert.equal(r.stdout.split('\n').filter(s => s.startsWith('GNL-RESULT ')).length, 1);
});
