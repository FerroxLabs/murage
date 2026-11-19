import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {safeWipeSync} from '../../server/testing/safe-wipe.mjs';
import {scanWindowsTree,scanSource} from './scan-native.mjs';

test('p11e: crev5 exact parenthesized imported alias is rejected',()=>{
 const root=mkdtempSync(join(tmpdir(),'winscen-crev5-'));
 try {
  mkdirSync(join(root,'nested'));
  writeFileSync(join(root,'nested','test.mjs'),"import {kill as stop} from 'node:process';\n(stop)(123);\n");
  const hits=scanWindowsTree(root);
  assert(hits.some(hit=>hit.file==='nested/test.mjs'&&!hit.rule.startsWith('parse failure:')),'crev5 exact input escaped scanner');
  assert.equal(hits.filter(hit=>hit.rule.startsWith('parse failure:')).length,0,'valid reviewer input must parse');
 }finally{safeWipeSync(root);}
});

test('p11e: every valid hostile allowlist fixture fails recursively',()=>{
 const fixtures=JSON.parse(readFileSync(new URL('p11e-scanner-fixtures.json',import.meta.url),'utf8'));
 const root=mkdtempSync(join(tmpdir(),'winscen-p11e-'));
 try {
  mkdirSync(join(root,'nested'));
  for(const [i,f] of fixtures.entries())writeFileSync(join(root,'nested',`${i}-test-check-mutate${f.ext.toUpperCase()}`),f.code);
  const hits=scanWindowsTree(root),failures=hits.filter(h=>h.rule.startsWith('parse failure:'));
  assert.deepEqual(failures,[],'hostile inputs must be valid syntax');
  const flagged=new Set(hits.map(h=>h.file));
  for(const [i,f] of fixtures.entries())assert(flagged.has(`nested/${i}-test-check-mutate${f.ext.toUpperCase()}`),f.name);
  console.log(`P11E SCANNER FIXTURE HIT RATE ${flagged.size}/${fixtures.length} (100%); PARSE-FAILURE COUNT ${failures.length}`);
 }finally{safeWipeSync(root);}
});

test('p11e: each allowed process form and harmless data remain accepted',()=>{
 const cases=[
  'const env=process.env; env.TEST; process.env.TEST="ok"; delete process.env.TEST;',
  'process.argv[1]; process.argv.slice(2);',
  'process.platform === "linux";',
  'const cwd=process.cwd();',
  'process.exitCode=1; const status=process.exitCode;',
  'process.exit(0);',
  'process.stdout.write("ok"); process.stderr.write("error");',
  ...['exit','SIGINT','SIGTERM'].map(event=>`process.on('${event}',()=>{});`),
  'process.hrtime(); process.hrtime.bigint();',
  'const text="import( process.kill eval Function vm node:process"; const re=/process/;',
  'const data={process:"label",eval:"text"}; data.process;',
  "import {readFileSync} from 'node:fs'; const path=require('node:path');",
  'function harmless(fn){fn();} function other(assert,name){const fn=assert[name]; return fn;}',
 ];
 for(const code of cases)for(const ext of ['js','mjs','cjs'])assert.deepEqual(scanSource(code,`allowed.${ext}`),[],code);
 console.log(`P11E ALLOWED FIXTURES ${cases.length*3}/${cases.length*3}`);
});
