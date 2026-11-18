import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {safeWipeSync} from '../../server/testing/safe-wipe.mjs';
import {scanWindowsTree,scanSource} from './scan-native.mjs';

test('p11d: crev4 exact parenthesized multiline CIM input is rejected',()=>{
 const root=mkdtempSync(join(tmpdir(),'winscen-crev4-'));
 try {
  mkdirSync(join(root,'nested'));
  writeFileSync(join(root,'nested','test.ps1'),`$process = Get-CimInstance Win32_Process -Filter 'ProcessId=123'
Invoke-CimMethod -InputObject $process -MethodName (
  'Terminate'
)
`);
  const hits=scanWindowsTree(root);
  assert(hits.some(hit=>hit.file==='nested/test.ps1'&&!hit.rule.startsWith('parse failure:')),'crev4 exact input escaped scanner');
  assert.equal(hits.filter(hit=>hit.rule.startsWith('parse failure:')).length,0,'valid reviewer input must parse');
 }finally{safeWipeSync(root);}
});

test('p11d: valid hostile fixtures are detected without masking parser failures',()=>{
 const fixtures=JSON.parse(readFileSync(new URL('native-scanner-fixtures.json',import.meta.url),'utf8'));
 const root=mkdtempSync(join(tmpdir(),'winscen-p11d-'));
 try {
  mkdirSync(join(root,'nested'));
  for(const [index,fixture] of fixtures.entries())writeFileSync(join(root,'nested',`${index}-test-check-mutate${fixture.ext.toUpperCase()}`),fixture.code);
  const hits=scanWindowsTree(root),parseFailures=hits.filter(hit=>hit.rule.startsWith('parse failure:'));
  assert.deepEqual(parseFailures,[]);
  const flagged=new Set(hits.map(hit=>hit.file));
  assert.equal(flagged.size,fixtures.length,JSON.stringify(hits));
  console.log(`P11D SCANNER FIXTURE HIT RATE ${flagged.size}/${fixtures.length} (100%); PARSE-FAILURE COUNT ${parseFailures.length}`);
 }finally{safeWipeSync(root);}
});

test('p11d: malformed PowerShell, JavaScript, C# and batch source fails closed',()=>{
 for(const [file,source] of [['broken.ps1','function X {'],['broken.psm1','@(1,'],['broken.mjs','export function ('],['broken.js','const x = ;'],['broken.cjs','require('],['broken.cs','class X {'],['broken.cmd','echo "unterminated'],['broken.bat','echo ^']]) {
  assert(scanSource(source,file).some(hit=>hit.rule.startsWith('parse failure:')),file);
 }
});

test('p11d: harmless syntax and command-looking data do not produce violations',()=>{
 for(const [file,source] of [['clean.ps1',"# Stop-Process -Id 123\n$text = 'Invoke-CimMethod -MethodName Terminate'\nWrite-Output $text"],['clean.mjs',"export const text = 'process.kill(123)'; const pattern=/spawn\\(/;"],['clean.cs','class Clean { string text = "Kill"; }'],['clean.cmd','@rem taskkill /PID 123\necho safe'],['clean.bat',':: tskill 123\necho safe']]) {
  assert.deepEqual(scanSource(source,file),[],file);
 }
});

test('p11d: a missing PowerShell parser fails closed',()=>{
 const previous=process.env.WINSCEN_PWSH;
 try {
  process.env.WINSCEN_PWSH='/missing-winscen-parser';
  assert(scanSource('Write-Output 384292','missing-parser.ps1').some(hit=>hit.rule.startsWith('parse failure:')));
 }finally{if(previous===undefined)delete process.env.WINSCEN_PWSH;else process.env.WINSCEN_PWSH=previous;}
});

test('p11d: JavaScript bindings respect lexical scopes',()=>{
 const code="function harmless(fn) { fn(); } function other(assert, name) { const fn=assert[name]; return fn; }";
 assert.deepEqual(scanSource(code,'scopes.mjs'),[]);
 const hits=scanSource("import {kill as stop} from 'node:process'; function safe(stop) { stop(); } stop(123);",'bindings.mjs');
 assert.equal(hits.filter(hit=>hit.rule==='unowned native call').length,1);
});
