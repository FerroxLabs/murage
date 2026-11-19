// Blocking Node runner for the same fake-only mutation qualifiers used by self-test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
// These are independent CLI children, not Node test-runner IPC workers.
const cliEnv={...process.env};delete cliEnv.NODE_TEST_CONTEXT;
for (const script of ['qualify-mutants.mjs', 'qualify-product-mutant.mjs', 'self-test.mjs', 'qualify-native-mutant.mjs', 'qualify-bindings-mutants.mjs', 'qualify-ci-mutants.mjs']) {
  test(`gate qualifier ${script} kills every activated mutant`, { timeout: 180000 }, () => {
    const preserve=Boolean(process.env.GNL_QUALIFICATION_OUT);
    const out = preserve ? resolve(process.env.GNL_QUALIFICATION_OUT,script.replace('.mjs','')) : mkdtempSync(join(tmpdir(), 'gnl-ci-qualification-'));
    mkdirSync(out,{recursive:true});
    try {
      const result = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL(script, import.meta.url)), out], {
        encoding: 'utf8', timeout: 175000, env:cliEnv,
      });
      if(result.status!==0){
        try{const r=JSON.parse(readFileSync(join(out,'verdict.json')));console.log(JSON.stringify(r));
          for(const b of r.baselines??[])if(b.verdict!=='PASS')console.log(readFileSync(join(out,`control-${b.test.replaceAll('/','-')}.log`),'utf8'));
        }catch{};
      }
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const report = JSON.parse(readFileSync(join(out, 'verdict.json')));
      assert.equal(report.verdict, 'PASS'); assert.equal(report.releaseGate, false);
    } finally { if(!preserve)rmSync(out, { recursive: true, force: true }); }
  });
}
test('a red control suite cannot be counted as killing gate mutants', { timeout: 180000 }, () => {
  const out = mkdtempSync(join(tmpdir(), 'gnl-red-control-'));
  try {
    const control = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-name-pattern=live runner retains', fileURLToPath(new URL('ruling.node-test.mjs', import.meta.url))], { encoding: 'utf8', timeout: 30000, env:cliEnv });
    if (control.status !== 0) console.log('CORRELATION-CONTROL exit=' + control.status + '\n' + control.stdout + control.stderr);
    const preload = join(out, 'red-control.mjs');
    const target = new URL('./ruling.node-test.mjs', import.meta.url).href;
    const injected="\ntest('injected red control',()=>assert.fail('control must block qualification'));\n";
    const source = `import {registerHooks} from 'node:module';registerHooks({load(url,ctx,next){const r=next(url,ctx);if(url===${JSON.stringify(target)}){const s=typeof r.source==='string'?r.source:Buffer.from(r.source).toString();return {...r,source:s+${JSON.stringify(injected)}};}return r;}});`;
    // The qualifier must run the normal control before installing any mutant.
    // Its temporary mutant loaders intentionally replace this NODE_OPTIONS.
    writeFileSync(preload, source);
    const result = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('qualify-mutants.mjs', import.meta.url)), join(out, 'report')], {
      encoding: 'utf8', timeout: 175000, env: { ...cliEnv, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(readFileSync(join(out, 'report/verdict.json')));
    assert.equal(report.verdict, 'FAIL');
    assert.ok(report.baselines.some(b => b.verdict === 'FAIL'));
    assert.ok(report.mutants.every(m => !m.killed));
    assert.equal(control.status, 0, control.stdout + control.stderr);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
