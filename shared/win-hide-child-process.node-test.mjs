import assert from 'node:assert/strict';
import test from 'node:test';
import cp, { spawn as namedSpawn, execFileSync as namedSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { installWindowsHide, withHideInherit } from './win-hide-child-process.mjs';
const names = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];

test('non-win32 preserves API, options, env and execArgv identities and bytes', () => {
 const platform = Object.getOwnPropertyDescriptor(process,'platform');
 const original = {...cp}, argv = [...process.execArgv], env = {...process.env};
 try {
  for(const value of ['linux','darwin']) {
   Object.defineProperty(process,'platform',{value});
   installWindowsHide(cp,syncBuiltinESMExports);
   const options = Object.freeze({env:Object.freeze({A:'same'}),execArgv:Object.freeze([])});
   assert.equal(withHideInherit(options),options);
   for(const name of names) assert.equal(cp[name],original[name]);
   assert.deepEqual(process.execArgv,argv); assert.deepEqual({...process.env},env);
  }
 } finally {Object.defineProperty(process,'platform',platform);}
});

test('post-normalization hook covers named, CJS and captured async functions; sync restores binding', () => {
 const platform=Object.getOwnPropertyDescriptor(process,'platform'), original={...cp};
 const native=cp.ChildProcess.prototype.spawn, binding=process.binding('spawn_sync'), sync=binding.spawn;
 const argv=[...process.execArgv], env=process.env.NODE_OPTIONS, stop=Error('boundary'); let received;
 const capture=options=>{received=options;throw stop;};
 cp.ChildProcess.prototype.spawn=binding.spawn=capture;
 Object.defineProperty(process,'platform',{value:'win32'});
 try {
  installWindowsHide(cp,syncBuiltinESMExports);
  const once=cp.ChildProcess.prototype.spawn;
  installWindowsHide(cp,syncBuiltinESMExports); assert.equal(cp.ChildProcess.prototype.spawn,once);
  const require=createRequire(import.meta.url);
  for(const fn of [original.spawn,cp.spawn,namedSpawn,require('child_process').spawn,namedSync]) {
   assert.throws(()=>fn('fixture'),e=>e===stop); assert.equal(received.windowsHide,true);
  }
  assert.equal(binding.spawn,capture,'sync restores even when the native boundary throws');
  const options=Object.freeze({env:Object.freeze({TEST:'unchanged'}),execArgv:Object.freeze(['--no-warnings'])});
  assert.equal(withHideInherit(undefined),undefined);assert.equal(withHideInherit(null),null);
  assert.deepEqual(withHideInherit({env:null,execArgv:null}),{env:null,execArgv:null});
  const inherited=withHideInherit(options);
  assert.equal(options.env.NODE_OPTIONS,undefined);assert.equal(options.execArgv.length,1);
  assert.match(inherited.env.NODE_OPTIONS,/--require=/);assert.equal(inherited.execArgv.length,2);
  assert.deepEqual(withHideInherit(inherited),inherited,'deduplicates overrides');
  // There are no reviewed opt-outs. Node normalizes omitted windowsHide to
  // false too, so a false boolean alone cannot authorize a visible window.
  assert.throws(()=>cp.spawn('fixture',{windowsHide:false}),e=>e===stop); assert.equal(received.windowsHide,true);
 } finally {
  delete process[Symbol.for('murage.windowsHide.installed')];
  Object.assign(cp,original);cp.ChildProcess.prototype.spawn=native;binding.spawn=sync;syncBuiltinESMExports();
  process.execArgv.splice(0,process.execArgv.length,...argv);
  if(env===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=env;
  Object.defineProperty(process,'platform',platform);
 }
});

test('Windows inheritance deduplicates preload spellings and retains other quoted flags', () => {
 const platform=Object.getOwnPropertyDescriptor(process,'platform'),original={...cp};
 const native=cp.ChildProcess.prototype.spawn,binding=process.binding('spawn_sync'),sync=binding.spawn;
 const argv=[...process.execArgv],env=process.env.NODE_OPTIONS;
 Object.defineProperty(process,'platform',{value:'win32'});
 try {
  installWindowsHide(cp,syncBuiltinESMExports);
  const flag=process.execArgv.find(arg=>arg.startsWith('--require=')&&arg.includes('win-hide-child-process.cjs'));
  const path=flag.slice(10),envFlag='--require='+JSON.stringify(path);
  const other='--title="fixture with spaces" --require="/other preload.cjs" --no-warnings';
  for(const preload of [envFlag,`--require ${JSON.stringify(path)}`,`-r ${JSON.stringify(path)}`,flag]) {
   const options=withHideInherit({env:{NODE_OPTIONS:`${other} ${preload} ${preload}`}});
   assert.equal(options.env.NODE_OPTIONS,`${envFlag} ${other}`);
  }
 } finally {
  delete process[Symbol.for('murage.windowsHide.installed')];Object.assign(cp,original);cp.ChildProcess.prototype.spawn=native;binding.spawn=sync;syncBuiltinESMExports();
  process.execArgv.splice(0,process.execArgv.length,...argv);if(env===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=env;
  Object.defineProperty(process,'platform',platform);
 }
});
