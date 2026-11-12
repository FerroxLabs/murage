import assert from 'node:assert/strict';
import test from 'node:test';
import cp from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import { installWindowsHide } from './win-hide-child-process.mjs';

test('callbacks and unmodified custom promisifiers preserve output and Promise.child', async () => {
 const platform=Object.getOwnPropertyDescriptor(process,'platform');
 const native=cp.ChildProcess.prototype.spawn, argv=[...process.execArgv], env=process.env.NODE_OPTIONS;
 const received=[];
 cp.ChildProcess.prototype.spawn=function(options){received.push(options);this.stdout=new PassThrough();this.stderr=new PassThrough();queueMicrotask(()=>{this.stdout.end('out');this.stderr.end('err');this.emit('close',0,null);});return 0;};
 const facade={...cp};
 Object.defineProperty(process,'platform',{value:'win32'});
 try {
  installWindowsHide(facade,()=>{});
  for(const name of ['exec','execFile']) {
   assert.equal(facade[name],cp[name],'no per-function async decorators');
   await new Promise((resolve,reject)=>facade[name]('fixture',(error,stdout,stderr)=>{try{assert.equal(error,null);assert.equal(stdout,'out');assert.equal(stderr,'err');resolve();}catch(e){reject(e);}}));
   const promise=promisify(facade[name])('fixture');assert.ok(promise.child instanceof cp.ChildProcess);
   assert.deepEqual(await promise,{stdout:'out',stderr:'err'});
  }
  assert.equal(received.length,4);assert.ok(received.every(o=>o.windowsHide===true));
 } finally {
  delete process[Symbol.for('murage.windowsHide.installed')];cp.ChildProcess.prototype.spawn=native;
  process.execArgv.splice(0,process.execArgv.length,...argv);
  if(env===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=env;
  Object.defineProperty(process,'platform',platform);
 }
});
