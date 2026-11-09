import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {resolveApp} from '../scripts/macwd/kill-support.mjs';
test('kill driver accepts a packaged app or a built tree and refuses absent builds',()=>{
 const app=path.resolve('fixture/release/mac-arm64/Murage.app');
 const exists=p=>p===app||p===path.join(app,'Contents/MacOS/Murage');
 assert.equal(resolveApp('fixture',exists),app);
 assert.equal(resolveApp(app,exists),app);
 assert.throws(()=>resolveApp('missing',exists),/Build the dev tree/);
 assert.throws(()=>resolveApp('missing.app',exists),/Build the dev tree/);
});

import {processTree,parseProcesses} from '../scripts/macwd/kill-support.mjs';
import {waitForKilledProcesses} from '../scripts/macwd/kill-support.mjs';

test('kill wait retries a busy lease until the third read',async()=>{
 let reads=0,now=0;
 await waitForKilledProcesses({pids:[22],processes:()=>[],
  inspectLease:()=>({code:++reads<3?'LEASE_CHILD_BUSY':'LEASE_STALE'}),
  now:()=>now,sleep:async ms=>{now+=ms;},timeoutMs:15000,pollMs:100});
 assert.equal(reads,3);
 assert.equal(now,200);
});

test('kill wait requires zombie and every killed pid to disappear even with a free lease',async()=>{
 let reads=0,now=0;
 const snapshots=[[{pid:22,stat:'Z'},{pid:33,stat:'S'}],[{pid:22,stat:'Z'}],[]];
 await waitForKilledProcesses({pids:[22,33],processes:()=>snapshots[reads++],
  inspectLease:()=>({code:'LEASE_STALE'}),now:()=>now,
  sleep:async ms=>{now+=ms;},timeoutMs:15000,pollMs:100});
 assert.equal(reads,3);
 assert.equal(now,200);
});

test('kill wait timeout names watched pids, remaining zombies and lease state',async()=>{
 let now=0;
 await assert.rejects(waitForKilledProcesses({pids:[22,33],
  processes:()=>[{pid:22,stat:'Z'}],inspectLease:()=>({code:'LEASE_CHILD_BUSY'}),
  now:()=>now,sleep:async ms=>{now+=ms;},timeoutMs:250,pollMs:100}),
  /Timed out after 250ms.*22,33.*22:Z.*LEASE_CHILD_BUSY/);
 assert.equal(now,250);
});

test('kill wait timeout diagnoses a busy lease after all watched pids disappear',async()=>{
 let now=0;
 await assert.rejects(waitForKilledProcesses({pids:[22],processes:()=>[],
  inspectLease:()=>({code:'LEASE_CHILD_BUSY'}),now:()=>now,
  sleep:async ms=>{now+=ms;},timeoutMs:100,pollMs:100}),
  /Timed out after 100ms.*22.*remaining: none.*LEASE_CHILD_BUSY/);
});
test('kill tree includes server and descendants regardless of row order, excludes unrelated apps',()=>{
 const rows=parseProcesses(' 44 33 S\n 90 1 S\n 33 22 S\n 22 10 S\n 10 1 T\n 91 90 S\n');
 assert.deepEqual(processTree(10,rows).sort((a,b)=>a-b),[10,22,33,44]);
 assert.deepEqual(processTree(90,rows),[90,91]);
 assert.throws(()=>processTree(1,rows),/owned root/);
 assert.throws(()=>parseProcesses('oops'),/invalid ps/);
});

import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {safeWipeSync} from '../server/testing/safe-wipe.mjs';
import {compareDestination} from '../scripts/macwd/kill-support.mjs';
test('destination comparison rejects deletion and changed bytes even with an intact case copy',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'macwd-destination-'));
 try{
  const destination=path.join(root,'backups');mkdirSync(destination);
  const bytes=Buffer.from('verified archive'),archives=[['prior.age',bytes]];
  writeFileSync(path.join(root,'prior.age'),bytes);
  const actual=path.join(destination,'prior.age');writeFileSync(actual,bytes);
  compareDestination(destination,archives,readFileSync);
  unlinkSync(actual);
  assert.throws(()=>compareDestination(destination,archives,readFileSync),/ENOENT/);
  writeFileSync(actual,'changed');
  assert.throws(()=>compareDestination(destination,archives,readFileSync),/archive changed/);
 }finally{safeWipeSync(root);}
});

import {classifyWindow} from '../scripts/macwd/kill-support.mjs';
test('recovery URL and diagnostic dataset classify pause-only and failed startup windows',()=>{
 assert.equal(classifyWindow('file:///Murage.app/Contents/Resources/app.asar/electron/recovery/index.html'),'recovery');
 assert.equal(classifyWindow('file:///app/recovery/index.html?skin=dark#pause',''),'recovery');
 assert.equal(classifyWindow('file:///app/splash.html','STARTUP_FAILED'),'recovery');
 assert.equal(classifyWindow('http://localhost:3000','LEASE_CHILD_BUSY'),'recovery');
 assert.equal(classifyWindow('file:///app/dist/index.html'),'workspace');
 assert.equal(classifyWindow('http://localhost:3000'),'workspace');
 assert.equal(classifyWindow('file:///app/splash.html'),'other');
 assert.equal(classifyWindow('about:blank'),'other');
});
