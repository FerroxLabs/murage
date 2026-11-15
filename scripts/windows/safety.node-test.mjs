import {assertPhysicalPath,appManifest,verifyStagedPackage} from './package-identity.mjs';
import {validateObservation} from './observation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {safeWipeSync} from '../../server/testing/safe-wipe.mjs';
const source=name=>readFileSync(new URL(name,import.meta.url),'utf8');
test('P1-1 launcher wires write-ahead task intent and outer cleanup',()=>{
 const s=source('run-interactive.ps1');assert.match(s,/finally\s*\{\s*try\s*\{\s*Invoke-LauncherCleanup/);
 assert.match(s,/Add-RunLedger[^\n]+\n[^\n]*\$create =/);
});
test('P1-2 physical containment checks existing ancestors before writes',async()=>{

 const root=mkdtempSync(join(tmpdir(),'winscen-physical-')),outside=mkdtempSync(join(tmpdir(),'winscen-outside-'));
 try {mkdirSync(join(root,'runs'));symlinkSync(outside,join(root,'runs','junction'),'dir');
  assert.throws(()=>assertPhysicalPath(join(root,'runs','junction','new'),root),/reparse|link/);
  assert.equal(assertPhysicalPath(join(root,'runs','new'),root),join(root,'runs','new'));
  assert.throws(()=>assertPhysicalPath(outside,root),/outside/);
 } finally {safeWipeSync(root);safeWipeSync(outside);}
});
test('P1-3 full staged tree and embedded provenance are verified',async()=>{

 const root=mkdtempSync(join(tmpdir(),'winscen-identity-'));
 try {mkdirSync(join(root,'resources'));writeFileSync(join(root,'Murage.exe'),'exe');writeFileSync(join(root,'resources/app.asar'),'asar');
  writeFileSync(join(root,'resources/build-provenance.json'),JSON.stringify({commit:'a'.repeat(40)}));
  const stage={packageSha256:'b'.repeat(64),commit:'a'.repeat(40),appManifest:appManifest(root)};
  assert.equal(verifyStagedPackage(root,stage).commit,stage.commit);
  writeFileSync(join(root,'resources/app.asar'),'different asar, same exe');assert.throws(()=>verifyStagedPackage(root,stage));
  stage.appManifest=appManifest(root);stage.commit='c'.repeat(40);assert.throws(()=>verifyStagedPackage(root,stage));
 }finally{safeWipeSync(root);}
});
test('P2-1 observation needs group controls, a final gap, and full coverage',async()=>{

 const o={samples:9,maxGapMs:250,finalGapMs:250,startedAt:100,stoppedAt:900,visible:[],enumerationErrors:[],controls:[{group:'mcp',edge:'start',at:200,detected:true},{group:'mcp',edge:'end',at:800,detected:true}]};
 assert.doesNotThrow(()=>validateObservation(o,[{name:'mcp',startedAt:300,endedAt:700}]));
 for(const change of [x=>x.controls.pop(),x=>x.controls[0].detected=false,x=>x.stoppedAt=600,x=>x.finalGapMs=1001]){const x=structuredClone(o);change(x);assert.throws(()=>validateObservation(x,[{name:'mcp',startedAt:300,endedAt:700}]));}
});
test('P2-2 fixture environment is set before either helper compiles',()=>{
 for(const name of ['desktop-task.ps1','scenario-common.ps1']){
  const s=source(name);const at=s.indexOf('Set-FixtureEnvironment');assert(at>=0,name);
  assert(at<s.indexOf('Initialize-OwnedProcess'),name);
  if(s.includes("'console-observer.ps1'"))assert(at<s.indexOf("'console-observer.ps1'"));
 }
});
test('P2-3 every tested scheduler completion requires a fresh publication',()=>{
 const s=source('sentinel-scenario.ps1');assert.match(s,/function Await-Publication/);assert.match(s,/lastCheckedAt -le \$After/);
 assert.equal((s.match(/Await-Publication \$viewFile/g)||[]).length,3);
});
test('P2-4 includes Claude Node cmd and all OS shell rows',()=>{
 const s=source('packaged-scenario.mjs');for(const row of ['fake-claude-cli.ts','claude-chain','refused.bat','javascript:','file:','https://'])assert(s.includes(row),row);
});
test('Windows entry points require the owned launcher context',()=>{
 for(const name of ['run-interactive.ps1','desktop-task.ps1','scenario-common.ps1'])assert.match(source(name),/Assert-GateAdmission/);
 assert.match(source('gate-admission.ps1'),/function Assert-GateAdmission/);
 assert.match(source('packaged-scenario.mjs'),/MURAGE_GATE_RUN_PREFIX/);
});
test('Windows package hook stamps provenance exactly once',()=>{
 const hook=readFileSync(new URL('../after-pack.mjs',import.meta.url),'utf8');
 assert.equal((hook.match(/writePackageBuildProvenance\(context\.packager\.projectDir, resources\)/g)||[]).length,1);
});
test('ZIP extraction validates destination after deriving it and never references copy-loop source',()=>{
 const s=source('stage.ps1'),extraction=s.slice(s.indexOf('foreach ($entry'),s.indexOf('  $candidates ='));
 assert(!extraction.includes('$source'));
 assert(extraction.indexOf('$destination =')<extraction.indexOf('Assert-GatePath $destination'));
});
