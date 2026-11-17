// Boundary/fixture owner: gnl-harness-r11. Native mount producer: MAIN.
// MAIN RULING 1114-GNL-HARNESS-BOUNDARY replaces the former call-pattern tests.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as boundary from './mounted-tools.mjs';
import {mountStructure} from './mount-structure-r10.mjs';
const root=fileURLToPath(new URL('./fakes/',import.meta.url));
test('mount structure enumerates every fake and every import with no forbidden dependencies',()=>{
 const audit=mountStructure();assert.equal(audit.catalogue.length,24);assert.ok(audit.imports.length>0);
 assert.deepEqual(audit.errors,[]);
 const enumerate=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?enumerate(join(dir,e.name)):[join(dir,e.name).slice(root.length)]).sort();
 assert.deepEqual(audit.files,enumerate(root));
 assert.deepEqual(Object.keys(boundary).sort(),['acpLaunchMounts','codexMounts','createMountedTools','environmentMounts']);
 console.log('GNL_IMPORT_BOUNDARY '+JSON.stringify(audit));
});
test('mount structure: an omitted decision and an undefined decision cannot reach the inert service',async()=>{
 const {appFixture}=await import('./saved-app-r10-fixture.mjs');
 const f=appFixture();try{
  for(const decision of [undefined,async()=>undefined,async()=>false]){
   await assert.rejects(boundary.createMountedTools({'gnl-app':f.mount},decision).call('GMAIL_SEND_EMAIL',{}),/native (permission decision|approval)/);
   assert.equal(f.deliveries().length,0);
  }
 }finally{f.close();}
});
for(const [style,addition] of [
 ['static',"import {spawn} from 'node:child_process';"],
 ['dynamic',"const transport=import('../mounted-tools.mjs');"],
 ['require',"const transport=require('child_process');"],
 ['re-export',"export * from '../mounted-tools.mjs';"],
])test(`mount structure rejects forbidden ${style} import`,()=>{
 const file=join(root,'common.mjs');
 const audit=mountStructure({overrides:new Map([[file,readFileSync(file,'utf8')+'\n'+addition]])});
 assert.ok(audit.errors.some(e=>e.includes('forbidden '+style)),JSON.stringify(audit.errors));
});
for(const addition of ["import('../'+process.env.FIXTURE_MODULE)","require('./unresolved')","export * from '../fixture-actions.mjs'","import {Worker} from 'node:worker_threads'","import {createRequire} from 'node:module'"])
 test(`mount structure fails closed on unresolved or executable dependency: ${addition}`,()=>{
 const file=join(root,'nested','unreferenced.mjs');
 const audit=mountStructure({overrides:new Map([[file,addition]])});
 assert.ok(audit.files.includes('nested/unreferenced.mjs'));
 assert.ok(audit.errors.some(e=>/nonliteral|forbidden/.test(e)));
 });
test('mount structure audits allowlisted helper dependencies too',()=>{
 const file=join(root,'../baseline-f-plan.mjs');
 const audit=mountStructure({overrides:new Map([[file,readFileSync(file,'utf8')+"\nexport * from 'node:child_process';"]])});
 assert.ok(audit.errors.some(e=>e.includes('../baseline-f-plan.mjs')&&e.includes('forbidden re-export')));
});
test('mount structure raw mount parameter cannot enter a fake',async()=>{
 const {nativePlay}=await import('./fakes/native-play.mjs');
 const {appFixture,appPrompt}=await import('./saved-app-r10-fixture.mjs');
 const {nativePlay:runWithGatedHandle}=await import('./native-play.mjs');
 const f=appFixture();try{
  const options={mounts:{'gnl-app':f.mount},beforeMounted:async()=>true,started:()=>{},completed:()=>{}};
  await assert.rejects(nativePlay(appPrompt,{...options,gatedHandle:f.mount}),/gated fixture handle/);
  assert.equal(f.deliveries().length,0);
  const previous=process.env.NOLIM_RELEASE_FAKE;process.env.NOLIM_RELEASE_FAKE='1';
  try{await runWithGatedHandle(appPrompt,options);assert.equal(f.deliveries().length,1);}
  finally{if(previous===undefined)delete process.env.NOLIM_RELEASE_FAKE;else process.env.NOLIM_RELEASE_FAKE=previous;}
 }finally{f.close();}
});
