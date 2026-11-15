// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { removeTempDir } from '../../server/testing/cleanup.ts';
let sourceFixture;
beforeAll(async () => {
  sourceFixture=mkdtempSync(join(tmpdir(),'smooth-native-source-'));
  mkdirSync(join(sourceFixture,'native/engine-exclusion'),{recursive:true});mkdirSync(join(sourceFixture,'server'));
  for(const name of ['exclusion.c',...(process.platform==='win32'?['exclusion-lsa.c','exclusion-lsa.h','anchored-win.c','anchored-win.h']:[])])writeFileSync(join(sourceFixture,'native/engine-exclusion',name),readFileSync(resolve('native/engine-exclusion',name)));
  writeFileSync(join(sourceFixture,'server/engine-exclusion.ts'),readFileSync(resolve('server/engine-exclusion.ts')));
  const {prepareSourceNative}=await api();
  await prepareSourceNative({work:sourceFixture,env,from:process.platform==='linux'?undefined:resolve('dist-native/engine-exclusion')});
},120000);
afterAll(async()=>{if(sourceFixture)await removeTempDir(sourceFixture);});
const owned=[];
afterEach(async()=>{for(const dir of owned.splice(0))await removeTempDir(dir);});
const api=()=>import('./native-preflight.mjs');
const env={...process.env};for(const key of ['MURAGE_RESOURCES_PATH','OMB_RESOURCES_PATH','MURAGE_ENGINE_EXCLUSION_PATH'])delete env[key];
it('preflight refuses an absent helper before a source leg starts',async()=>{
  const {preflightSourceNative}=await api();
  const work=mkdtempSync(join(tmpdir(),'smooth-native-'));owned.push(work);
  await expect(preflightSourceNative({work,env})).rejects.toThrow();
});
it('a receipt cannot bless a changed binary or a helper from another source',async()=>{
  const {preflightSourceNative}=await api();
  const work=mkdtempSync(join(tmpdir(),'smooth-native-'));owned.push(work);
  mkdirSync(join(work,'native/engine-exclusion'),{recursive:true});writeFileSync(join(work,'native/engine-exclusion/exclusion.c'),'fixture');
  const dir=join(work,'dist-native/engine-exclusion',`${process.platform}-${process.arch}`);mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'engine-exclusion.node'),'changed');
  writeFileSync(join(dir,'build.json'),JSON.stringify({version:1,target:`${process.platform}-${process.arch}`,napiVersion:9,sourceSha256:'0'.repeat(64),sha256:'0'.repeat(64)}));
  await expect(preflightSourceNative({work,env})).rejects.toThrow(/SOURCE|HASH/);
});
it('all three packaging paths build and ship the platform helper',()=>{
  const pkg=JSON.parse(readFileSync(resolve('package.json'),'utf8'));
  for(const name of ['package:linux','package:mac','package:win'])expect(pkg.scripts[name]).toContain('build:engine-exclusion');
  const build=readFileSync(resolve('scripts/build-engine-exclusion.mjs'),'utf8');
  for(const platform of ['linux','darwin','win32'])expect(build).toContain(`platform==="${platform}"`);
  expect(readFileSync(resolve('server/engine-exclusion.ts'),'utf8')).toContain('`${process.platform}-${process.arch}`');
  expect(readFileSync(resolve('scripts/after-pack.mjs'),'utf8')).toContain('validateEngineExclusionResource');
  const packaging=readFileSync(resolve('electron-builder.yml'),'utf8');
  for(const location of ['darwin-${arch}','win32-${arch}','linux-x64'])expect(packaging).toContain(`dist-native/engine-exclusion/${location}/engine-exclusion.node`);
});
it('the real fixture helper preflights through the product loader',async()=>{
  const {preflightSourceNative}=await api();
  const proof=await preflightSourceNative({work:sourceFixture,env});
  expect(proof).toMatchObject({loaded:true,noReplace:true,target:`${process.platform}-${process.arch}`});
  await expect(preflightSourceNative({work:sourceFixture,env,expectedSha256:'0'.repeat(64)})).rejects.toThrow('SMOOTH_NATIVE_HASH');
  await expect(preflightSourceNative({work:sourceFixture,env:{...env,MURAGE_ENGINE_EXCLUSION_PATH:'/different'}})).rejects.toThrow('SMOOTH_NATIVE_OVERRIDE');
});
for(const defect of ['source','binary'])it(`preflight rejects a matching-target helper with a changed ${defect}`,async()=>{
  const {preflightSourceNative}=await api();
  const work=mkdtempSync(join(tmpdir(),'smooth-native-'));owned.push(work);
  const sourceDir=join(work,'native/engine-exclusion'),dir=join(work,'dist-native/engine-exclusion',`${process.platform}-${process.arch}`);
  mkdirSync(sourceDir,{recursive:true});mkdirSync(dir,{recursive:true});
  for(const name of ['exclusion.c',...(process.platform==='win32'?['exclusion-lsa.c','exclusion-lsa.h','anchored-win.c','anchored-win.h']:[])])writeFileSync(join(sourceDir,name),readFileSync(resolve('native/engine-exclusion',name)));
  const original=join(sourceFixture,'dist-native/engine-exclusion',`${process.platform}-${process.arch}`);
  const receipt=JSON.parse(readFileSync(join(original,'build.json'),'utf8'));
  const bytes=readFileSync(join(original,'engine-exclusion.node'));
  if(defect==='source')receipt.sourceSha256='0'.repeat(64);
  writeFileSync(join(dir,'engine-exclusion.node'),defect==='binary'?Buffer.concat([bytes,Buffer.from('changed')]):bytes);
  writeFileSync(join(dir,'build.json'),JSON.stringify(receipt));
  await expect(preflightSourceNative({work,env})).rejects.toThrow(defect==='source'?'SMOOTH_NATIVE_SOURCE':'SMOOTH_NATIVE_HASH');
});
for(const mode of ['supplied',...(process.platform==='linux'?['build']:[])])it(`provisions and loads a ${mode} helper in an empty source fixture`,async()=>{
  const {prepareSourceNative}=await api();
  const work=mkdtempSync(join(tmpdir(),'smooth-native-'));owned.push(work);
  mkdirSync(join(work,'native/engine-exclusion'),{recursive:true});mkdirSync(join(work,'server'));
  for(const name of ['exclusion.c',...(process.platform==='win32'?['exclusion-lsa.c','exclusion-lsa.h','anchored-win.c','anchored-win.h']:[])])writeFileSync(join(work,'native/engine-exclusion',name),readFileSync(resolve('native/engine-exclusion',name)));
  writeFileSync(join(work,'server/engine-exclusion.ts'),readFileSync(resolve('server/engine-exclusion.ts')));
  const proof=await prepareSourceNative({work,env,from:mode==='supplied'?join(sourceFixture,'dist-native/engine-exclusion'):undefined});
  expect(proof).toMatchObject({loaded:true,noReplace:true,target:`${process.platform}-${process.arch}`});
  const receipt=JSON.parse(readFileSync(join(work,'dist-native/engine-exclusion',`${process.platform}-${process.arch}`,'build.json'),'utf8'));
  expect(receipt.sha256).toBe(proof.sha256);
  if(mode==='build')expect(receipt).toMatchObject({fixtureOnly:true,compiler:expect.stringContaining('gcc')});
},30000);

it('source rig refuses missing supplied native inputs and supersedes a stale PASS',()=>{
  const root=mkdtempSync(join(tmpdir(),'smooth-native-startup-'));owned.push(root);
  const data=join(root,'smooth-data'),out=join(root,'out');mkdirSync(data);mkdirSync(out);
  const file=join(out,'results-native-check.json');writeFileSync(file,JSON.stringify({status:'PASS'}));
  const run=spawnSync(process.execPath,[resolve('scripts/smoothness/smooth.mjs')],{env:{...env,MURAGE_DATA_DIR:data,SMOOTH_WORK:resolve('.'),SMOOTH_OUT:out,SMOOTH_LABEL:'native-check',SMOOTH_NATIVE_FROM:join(root,'missing'),SMOOTH_SCENARIOS:''},encoding:'utf8',timeout:30000});
  expect(run.status,run.stderr).toBe(2);
  expect(JSON.parse(readFileSync(file,'utf8'))).toMatchObject({status:'INVALID',preflight:{ok:false}});
},35000);
