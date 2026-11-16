import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import afterSign, { writeWindowsHideManifest } from './windows-hide-package-manifest.mjs';
import { buildCommitPlugin } from './build-commit-plugin.mjs';
import { removeTempDir } from '../server/testing/cleanup.ts';
test('build stamp and signed package manifest cover all bundled JavaScript and bind the embedded commit',async()=>{
 const root=mkdtempSync(join(tmpdir(),'hide-package-')),commit='a'.repeat(40);
 try {
  const paths=['Murage.exe','resources/app.asar','resources/server/index.js','resources/server/nested/worker.js','resources/shared/win-hide-child-process.cjs','resources/browser/host.mjs','resources/ui/build-commit.json'];
  for(const path of paths){mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),'fixture:'+path);}
  const plugin=buildCommitPlugin(commit);let asset;plugin.generateBundle.call({emitFile:f=>asset=f});
  assert.equal(asset.fileName,'build-commit.json');writeFileSync(join(root,'resources/ui',asset.fileName),asset.source);
  const manifest=writeWindowsHideManifest(root,commit);
  assert.equal(manifest.commit,commit);assert.deepEqual(manifest.files.map(f=>f.path),paths.sort());
  for(const file of manifest.files)assert.equal(file.sha256,createHash('sha256').update(readFileSync(join(root,file.path))).digest('hex'));
  assert.throws(()=>writeWindowsHideManifest(root,'b'.repeat(40)),/mismatch/);
  assert.throws(()=>writeWindowsHideManifest(root,null),/mismatch/);
  await afterSign({electronPlatformName:'linux',appOutDir:join(root,'missing')});
 } finally {await removeTempDir(root);}
});
