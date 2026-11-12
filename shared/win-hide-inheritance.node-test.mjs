import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { removeTempDir } from '../server/testing/cleanup.ts';

// Real fresh realms: the child never imports the installer itself. A separate
// first preload simulates win32 on Linux before the inherited installer runs.
// Windows runs this same fixture without a platform override.
test('preload survives Worker, fork, spawned node and explicit overrides', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'murage-hide-inherit-'));
 const installer = pathToFileURL(join(dir,'win-hide-child-process.cjs')).href;
 const original = new URL(process.env.WINHIDE_INSTALLER_URL ?? new URL('./win-hide-child-process.cjs', import.meta.url));
 writeFileSync(new URL(installer), "Object.defineProperty(process,'platform',{value:'win32'});\n" + readFileSync(original,'utf8'));
 const fake = 'data:text/javascript,' + encodeURIComponent("Object.defineProperty(process,'platform',{value:'win32'});");
 const platformFile = join(dir,'platform.cjs');
 writeFileSync(platformFile,"Object.defineProperty(process,'platform',{value:'win32'});");
 const report = `const cp = require('node:child_process');
 const installed = !!process[Symbol.for('murage.windowsHide.installed')];
 const result = { installed, argv: process.execArgv.some(a=>a.includes('win-hide-child-process.cjs')), env: !!process.env.NODE_OPTIONS?.includes('win-hide-child-process.cjs') };
 const {parentPort}=require('node:worker_threads'); if(parentPort)parentPort.postMessage(result); else if(process.send)process.send(result); else console.log(JSON.stringify(result));`;
 writeFileSync(join(dir,'child.cjs'),report);
 writeFileSync(join(dir,'parent.mjs'), `
 import assert from 'node:assert/strict';
 import {Worker} from 'node:worker_threads';
 import cp from 'node:child_process';
 await import(${JSON.stringify(fake)});
 const {withHideInherit} = await import(${JSON.stringify(installer)});
 const fake = ${JSON.stringify('--require=' + platformFile)};
 process.execArgv.unshift(fake);
 process.env.NODE_OPTIONS = fake + ' ' + process.env.NODE_OPTIONS;
 const inheritedRuntime = Object.fromEntries(['ELECTRON_RUN_AS_NODE','LD_LIBRARY_PATH'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
 const expected = {installed:true,argv:true,env:true};
 const child = ${JSON.stringify(join(dir,'child.cjs'))};
 async function message(c){return new Promise((resolve,reject)=>{c.once('message',resolve);c.once('error',reject);c.once('exit',code=>{if(code)reject(Error('exit '+code))});});}
 for(const options of [undefined,withHideInherit({execArgv:[fake],env:{...inheritedRuntime,NODE_OPTIONS:fake}})]) {
  const worker = new Worker(child,options); assert.deepEqual(await message(worker),expected); await worker.terminate();
  const fork = cp.fork(child,[],options); assert.deepEqual(await message(fork),expected); await new Promise(r=>fork.once('exit',r));
 }
 for(const options of [undefined,withHideInherit({env:{...inheritedRuntime,NODE_OPTIONS:fake}})]) {
  const output=cp.execFileSync(process.execPath,[child],options); assert.deepEqual(JSON.parse(output),expected);
  const spawned=cp.spawn(process.execPath,[child],options);let text='';spawned.stdout.on('data',chunk=>text+=chunk);
  assert.equal(await new Promise((resolve,reject)=>{spawned.once('exit',resolve);spawned.once('error',reject);}),0);
  assert.deepEqual(JSON.parse(text),expected);
 }
 console.log('8 descendant launches passed');
 `);
 try {
  const result = cp.spawnSync(process.execPath,[join(dir,'parent.mjs')],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr); assert.match(result.stdout,/8 descendant launches passed/);
 } finally { await removeTempDir(dir); }
});
