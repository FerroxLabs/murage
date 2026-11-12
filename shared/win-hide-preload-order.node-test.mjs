import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from '../server/testing/cleanup.ts';

test('guard precedes competing require/import preloads in Worker, fork and spawned node', async () => {
 const dir=mkdtempSync(join(tmpdir(),'hide preload space '));
 const importProbe='data:text/javascript,'+encodeURIComponent("import assert from 'node:assert/strict';assert.ok(process[Symbol.for('murage.windowsHide.installed')]);globalThis.importObserved=true;");
 try {
  // Platform/boundary simulation belongs to the harness, never production.
  writeFileSync(join(dir,'platform.cjs'),`
   Object.defineProperty(process,'platform',{value:'win32'});
   const cp=require('node:child_process'),original=cp.ChildProcess.prototype.spawn;
   cp.ChildProcess.prototype.spawn=function(options){require('node:assert/strict').equal(options.windowsHide,true);return Reflect.apply(original,this,[options]);};
  `);
  const candidate = new URL('./win-hide-child-process.cjs',import.meta.url);
  // The old ESM installer is deliberately exercised for the RED baseline.
  let installer;
  try { installer=readFileSync(candidate,'utf8'); } catch { installer=null; }
  if(installer) writeFileSync(join(dir,'guard.cjs'), `require('./platform.cjs');\n${installer}`);
  else writeFileSync(join(dir,'guard.mjs'), `import './platform.cjs';\n${readFileSync(new URL('./win-hide-child-process.mjs',import.meta.url),'utf8')}`);
  writeFileSync(join(dir,'competitor.cjs'),`
   const assert=require('node:assert/strict'),cp=require('node:child_process');
   assert.ok(process[Symbol.for('murage.windowsHide.installed')],'guard must precede competing --require');
   const captured=cp.spawnSync;
   const native=process.binding('spawn_sync'),old=native.spawn;
   native.spawn=o=>{assert.equal(o.windowsHide,true);throw Error('observed')};
   try {assert.throws(()=>captured(process.execPath),/observed/)} finally {native.spawn=old;}
   // Exercise an actual child launch from preload load-time as well.
   const child=cp.spawn(process.execPath,['-e',''],{env:{...process.env,NODE_OPTIONS:''}});
   child.on('error',e=>{throw e});
   global.preloadObserved=true;
  `);
  writeFileSync(join(dir,'child.cjs'),`require('node:assert/strict').ok(global.preloadObserved && global.importObserved);const {parentPort}=require('node:worker_threads');if(parentPort)parentPort.postMessage('ok');else if(process.send)process.send('ok');else console.log('ok');`);
  writeFileSync(join(dir,'parent.cjs'),`
   const cp=require('node:child_process'),assert=require('node:assert/strict');
   (async()=>{
    const m=await import(${JSON.stringify(installer ? './guard.cjs':'./guard.mjs')});
    const {withHideInherit}=m;
    const competitor=${JSON.stringify(join(dir,'competitor.cjs'))};
    const platform=${JSON.stringify(join(dir,'platform.cjs'))};
    const child=${JSON.stringify(join(dir,'child.cjs'))};
    const guard=${JSON.stringify(join(dir,'guard.cjs'))};
    const importProbe=${JSON.stringify(importProbe)};
    const runtime=Object.fromEntries(['ELECTRON_RUN_AS_NODE','LD_LIBRARY_PATH'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
    const options=withHideInherit({execArgv:['--import='+importProbe,'--require='+platform,'--require='+competitor,'--require='+guard],env:{...runtime,NODE_OPTIONS:'--import='+importProbe+' --require='+JSON.stringify(platform)+' --require='+JSON.stringify(competitor)+' --require='+JSON.stringify(guard)}});
    assert.equal(options.execArgv[0],'--require='+guard,'guard require must be first even if already present later');
    assert.ok(options.env.NODE_OPTIONS.startsWith('--require='+JSON.stringify(guard)+' '),'guard require must lead NODE_OPTIONS');
    const {Worker}=require('node:worker_threads');
    for(const make of [()=>new Worker(child,options),()=>cp.fork(child,[],options)]) {
     const c=make();
     assert.equal(await new Promise((r,j)=>{c.once('message',r);c.once('error',j);c.once('exit',code=>{if(code)j(Error('exit '+code))})}),'ok');
     if(c.terminate)await c.terminate();
    }
    assert.equal(cp.execFileSync(process.execPath,[child],options).toString().trim(),'ok');
    const c=cp.spawn(process.execPath,[child],options);let out='';c.stdout.on('data',s=>out+=s);assert.equal(await new Promise(r=>c.on('exit',r)),0);assert.equal(out.trim(),'ok');
    console.log('4 competing preload descendants passed');
   })().catch(e=>{console.error(e);process.exitCode=1});
  `);
  const r=cp.spawnSync(process.execPath,[join(dir,'parent.cjs')],{encoding:'utf8',timeout:30000});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/4 competing preload descendants passed/);
 } finally {await removeTempDir(dir);}
});
