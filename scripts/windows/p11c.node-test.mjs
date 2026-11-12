import {scanWindowsTree,nativeOwnerPaths} from './scan-native.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {safeWipeSync} from '../../server/testing/safe-wipe.mjs';
const source=n=>readFileSync(new URL(n,import.meta.url),'utf8');
test('p11c 1: cleanup removes the fixed wrapper before any bounded snapshot diff',()=>{
 const outer=source('run-interactive.ps1');
 assert.match(outer,/wrapperTask=/);
 assert(outer.indexOf('Set-FixtureEnvironment')<outer.indexOf('Initialize-OwnedProcess'));
 assert(outer.indexOf('Set-FixtureEnvironment')<outer.indexOf('Invoke-OwnershipDeadline -Operation TaskSnapshot'));
 assert.match(outer,/Invoke-LauncherCleanup/);
 const s=source('ownership.ps1'),body=s.slice(s.indexOf('function Invoke-LauncherCleanup'));
 assert(body.indexOf('Remove-WrapperTask')>=0);
 assert(body.indexOf('Remove-WrapperTask')<body.indexOf('Invoke-OwnershipDeadline'));
 assert.match(body,/-Deadline/);
 assert.match(body,/finally/);
 assert.match(body,/removalCommand/);
});
test('p11c 2: reviewer snapshot helper >300s has one job owner for every Node native',()=>{
 const s=source('packaged-scenario.mjs');
 assert.doesNotMatch(s,/node:child_process|\.kill\s*\(/i);
 assert.match(s,/createNativeLauncher/);
 assert.match(source('scenario-common.ps1'),/Invoke-NativeBrokerRequest/);
 assert.doesNotMatch(source('echo-mcp.mjs'),/node:child_process/);
});
test('p11c 3: scanner flags every reviewer form recursively, including test/check/mutate',async()=>{
 const module=new URL('scan-native.mjs',import.meta.url);
 assert(existsSync(module),'recursive native scanner missing');

 const fixtures=JSON.parse(source('native-scanner-fixtures.json'));
 const root=mkdtempSync(join(tmpdir(),'winscen-scanner-'));
 try {
  for(const [i,f] of fixtures.entries()) {const file=join(root,'nested',`${i}-test-check-mutate${f.ext}`);mkdirSync(join(root,'nested'),{recursive:true});writeFileSync(file,f.code);}
  const hits=scanWindowsTree(root),flagged=new Set(hits.map(h=>h.file));
  assert.equal(flagged.size,fixtures.length,JSON.stringify(hits));
  console.log(`SCANNER FIXTURE HIT RATE ${flagged.size}/${fixtures.length} (100%)`);
 } finally {safeWipeSync(root);}
});
test('p11c 3: complete Windows tree passes exact-path ownership scanner',async()=>{
 const module=new URL('scan-native.mjs',import.meta.url);assert(existsSync(module),'recursive native scanner missing');

 assert.deepEqual(scanWindowsTree(new URL('.',import.meta.url)),[]);
});
test('p11c 4: four additional real source mutants exist',()=>{
 const file=new URL('mutate-p11c.mjs',import.meta.url);assert(existsSync(file),'new source mutants missing');
 const s=readFileSync(file,'utf8');
 for(const name of ['enumeration-before-removal','cleanup-without-deadline','node-native-kill','taskkill-in-test'])assert(s.includes(name),name);
});
test('p11c 3: owner basenames elsewhere are never allowlisted',async()=>{

 assert.equal(nativeOwnerPaths.length,2);
 const fixtures=JSON.parse(source('native-scanner-fixtures.json'));
 const root=mkdtempSync(join(tmpdir(),'winscen-allowlist-'));
 try {
  writeFileSync(join(root,'native-launcher.mjs'),fixtures.find(f=>f.ext==='.mjs').code);
  writeFileSync(join(root,'owned-process.ps1'),fixtures.find(f=>f.ext==='.ps1').code);
  assert.equal(new Set(scanWindowsTree(root).map(h=>h.file)).size,2);
 }finally{safeWipeSync(root);}
});
