import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {toolingFiles,stageHostdeps,verifyHostdeps} from './hostdeps.mjs';
import {processSummary} from './resources.mjs';

test('minimal lock retains exact existing integrity and dependency snapshots only',()=>{
 const lock=toolingFiles()['pnpm-lock.yaml'];assert.equal((lock.match(/integrity: sha512-/g)||[]).length,4);assert(!lock.includes('electron-builder'));assert(!lock.includes('transformers'));assert(lock.includes('fsevents: 2.3.2'));
 const original=readFileSync(new URL('../../pnpm-lock.yaml',import.meta.url),'utf8');assert.throws(()=>toolingFiles(original.replace("  '@playwright/test@1.57.0':","  '@playwright/test@1.58.0':")));assert.throws(()=>toolingFiles(original.replace('      playwright-core: 1.57.0','      playwright-core: 1.58.0')));
});
test('actual isolated offline frozen install resolves Electron API without native launch; drift and fallback refused',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'q12-hostdeps-')));try{
  const host=stageHostdeps(root);assert.throws(()=>verifyHostdeps(host));
  execFileSync('pnpm',['--dir',host,'install','--offline','--frozen-lockfile','--ignore-scripts'],{env:{...process.env,PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1'},timeout:120000,stdio:'pipe'});
  const {receipt,require}=verifyHostdeps(host);assert.equal(receipt.packages.length,3);assert.equal(typeof require('@playwright/test')._electron.launch,'function');
  const lock=readFileSync(join(host,'pnpm-lock.yaml'),'utf8');writeFileSync(join(host,'pnpm-lock.yaml'),lock+'# drift\n');assert.throws(()=>verifyHostdeps(host),/Tooling lock changed/);writeFileSync(join(host,'pnpm-lock.yaml'),lock);
  renameSync(join(host,'node_modules'),join(host,'parked-modules'));assert.throws(()=>verifyHostdeps(host));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('RSS receipt has bounded sorted PID/PPID/name only, no executable paths or arguments',()=>{
 const text=Array.from({length:40},(_,i)=>`${i+1} 1 ${i+10} /task/path/Helper`).join('\n');const rows=processSummary(text);assert.equal(rows.length,30);assert.equal(rows[0].rssBytes,49*1024);assert.equal(rows[0].name,'Helper');assert.deepEqual(Object.keys(rows[0]),['pid','ppid','rssBytes','name']);assert.throws(()=>processSummary('unknown format'));
});
test('only Q12 mode installs minimal dependencies and captures ordered resource phases',()=>{
 const workflow=readFileSync(new URL('../../.github/workflows/package-mac-qualification.yml',import.meta.url),'utf8'),q=workflow.slice(workflow.indexOf('\n  q12:'));assert(!q.includes('run: pnpm install'));assert(q.includes('install --frozen-lockfile --ignore-scripts'));assert(q.includes('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'));let last=-1;for(const label of ['before-setup','hostdeps.mjs stage','after-hostdeps','after-artifact-download','ci.mjs prepare']){const i=q.indexOf(label);assert(i>last);last=i;}
});
