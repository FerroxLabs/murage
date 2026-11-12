import assert from 'node:assert/strict';
import test from 'node:test';
import cp from 'node:child_process';
import { promisify } from 'node:util';
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
Object.defineProperty(process, 'platform', { value: 'linux' });
const { installWindowsHide } = await import(process.env.WINHIDE_INSTALLER_URL ?? new URL('./win-hide-child-process.mjs', import.meta.url));
Object.defineProperty(process, 'platform', hostPlatform);

// Cartesian product, including sparse/absent positions, not a curated list of
// overloads. Both sides execute the REAL Node API, stopping only at the native
// boundary. Throwing there also prevents fork IPC handles or real processes.
const absent = Symbol('absent');
const kinds = [absent, undefined, null, [], () => {}, Object.freeze({}), 'arg', 42];
const apis = ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync', 'promisify:exec', 'promisify:execFile'];
for (const platform of ['win32', 'linux', 'darwin']) test(`${platform}: 4608 generated native differentials`, async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const nativeAsync = cp.ChildProcess.prototype.spawn;
  const binding = process.binding('spawn_sync'), nativeSync = binding.spawn;
  const execArgv = [...process.execArgv], nodeOptions = process.env.NODE_OPTIONS;
  const stop = new Error('native boundary');
  let received;
  const capture = options => { received = options; throw stop; };
  cp.ChildProcess.prototype.spawn = capture;
  binding.spawn = capture;
  const facade = { ...cp };
  Object.defineProperty(process, 'platform', { value: platform });
  const cases = [];
  for (const name of apis) for (const a of kinds) for (const b of kinds) for (const c of kinds) {
    const slots = [a, b, c];
    const args = [process.execPath];
    for (let i = 0; i < slots.length; i++) if (slots[i] !== absent) args[i + 1] = slots[i];
    cases.push({ name, args, label: `${name}(${slots.map(v => kinds.indexOf(v)).join(',')})` });
  }
  const invoke = async (api, entry) => {
    received = undefined;
    try {
      const fn = entry.name.startsWith('promisify:') ? promisify(api[entry.name.slice(10)]) : api[entry.name];
      const fresh = entry.args.map(v => Array.isArray(v) ? [] : v && typeof v === 'object' ? Object.freeze({}) : v);
      await fn(...fresh);
      assert.fail('test must stop before any native process');
    } catch (error) {
      return error === stop ? { options: received } : { code: error.code, message: error.message };
    }
  };
  try {
    const expected = [];
    for (const entry of cases) expected.push(await invoke(cp, entry));
    installWindowsHide(facade, () => {});
    process.execArgv.splice(0, process.execArgv.length, ...execArgv);
    if (nodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = nodeOptions;
    const mismatches = [];
    for (let i = 0; i < cases.length; i++) {
      const actual = await invoke(facade, cases[i]);
      const baseline = expected[i];
      if (baseline.options && platform === 'win32') {
        baseline.options.windowsHide = true;
        const preload = new URL(process.env.WINHIDE_INSTALLER_URL ?? new URL('./win-hide-child-process.cjs', import.meta.url)).pathname;
        const envFlag = '--require=' + JSON.stringify(preload);
        const pairs = baseline.options.envPairs;
        const old = pairs.find(p => /^NODE_OPTIONS=/i.test(p))?.slice('NODE_OPTIONS='.length) ?? '';
        baseline.options.envPairs = [...pairs.filter(p => !/^NODE_OPTIONS=/i.test(p)), 'NODE_OPTIONS=' + envFlag + (old ? ' ' + old : '')];
      }
      try { assert.deepEqual(actual, baseline); }
      catch (error) { mismatches.push(cases[i].label); if (mismatches.length === 1) console.error(error.message.slice(0, 2000)); }
      if (baseline.options && platform !== 'win32') assert.equal(JSON.stringify(actual), JSON.stringify(baseline));
    }
    assert.equal(cases.length, 4608);
    assert.equal(mismatches.length, 0, `${mismatches.length} mismatches: ${mismatches.slice(0, 25).join('; ')}`);
  } finally {
    delete process[Symbol.for('murage.windowsHide.installed')];
    cp.ChildProcess.prototype.spawn = nativeAsync; binding.spawn = nativeSync;
    process.execArgv.splice(0, process.execArgv.length, ...execArgv);
    if (nodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = nodeOptions;
    Object.defineProperty(process, 'platform', descriptor);
  }
});

test('native differential repairs child env and fork execArgv for direct/call/apply/alias launches', async () => {
 const descriptor=Object.getOwnPropertyDescriptor(process,'platform');
 const original={...cp}, native=cp.ChildProcess.prototype.spawn, binding=process.binding('spawn_sync'), nativeSync=binding.spawn;
 const argv=[...process.execArgv], prior=process.env.NODE_OPTIONS, stop=Error('native boundary');let received;
 const capture=options=>{received=options;throw stop;};
 cp.ChildProcess.prototype.spawn=binding.spawn=capture;
 Object.defineProperty(process,'platform',{value:'win32'});
 try {
  installWindowsHide(cp,()=>{});
  const flag=process.execArgv.find(v=>v.startsWith('--require=')&&v.includes('win-hide-child-process.cjs'));
  const envFlag='--require='+JSON.stringify(flag.slice('--require='.length));
  let count=0;
  for(const name of apis) for(const env of [{},{NODE_OPTIONS:''},{NODE_OPTIONS:'--no-warnings'},{NODE_OPTIONS:`--no-warnings ${envFlag} ${envFlag}`},{node_options:'--no-warnings'}]) for(const form of ['direct','call','apply','alias']) for(const execArgv of [[], ['--no-warnings'], ['--no-warnings',flag,flag], ['--require',flag.slice(10),'-r',flag.slice(10),'--no-warnings']]) {
   const options={env,execArgv};
   const args=name.endsWith('exec')||name==='execSync'?[process.execPath,options]:[process.execPath,[],options];
   const fn=name.startsWith('promisify:')?promisify(cp[name.slice(10)]):cp[name];
   received=undefined;
   try{if(form==='call')await fn.call(null,...args);else if(form==='apply')await fn.apply(null,args);else {const alias=fn;await alias(...args);}}catch(e){assert.equal(e,stop);}
   assert.ok(received,`${name} ${form}`);assert.equal(received.windowsHide,true);
   const pairs=received.envPairs.filter(p=>/^NODE_OPTIONS=/i.test(p));assert.equal(pairs.length,1);
   assert.equal(pairs[0],`NODE_OPTIONS=${envFlag}${Object.values(env)[0]?.includes('--no-warnings')?' --no-warnings':''}`);
   if(name==='fork') {assert.equal(received.args.filter(a=>a===flag).length,1);assert.equal(received.args.includes('--no-warnings'),execArgv.includes('--no-warnings'));
    assert.equal(received.args.at(-1),process.execPath,'module argument stays in place');}
   count++;
  }
  // Unknown fork-like fields on an ordinary spawn are not fork arguments.
  for(const name of ['spawn','spawnSync']) {
   assert.throws(()=>cp[name]('fixture',['arg'],{env:{},execPath:'fixture',execArgv:[]}),e=>e===stop);
   assert.deepEqual(received.args,['fixture','arg']);
  }
  // Review chain at the real normalized boundary: Claude -> Node stdio MCP -> cmd.exe.
  assert.throws(()=>cp.spawn(process.execPath,['mcp.cjs'],{env:{NODE_OPTIONS:''}}),e=>e===stop);
  const mcpEnv=Object.fromEntries(received.envPairs.map(p=>{const i=p.indexOf('=');return [p.slice(0,i),p.slice(i+1)];}));
  assert.equal(mcpEnv.NODE_OPTIONS,envFlag);
  assert.throws(()=>cp.spawn('C:/Windows/System32/cmd.exe',['/k'],{env:mcpEnv}),e=>e===stop);
  assert.equal(received.windowsHide,true);assert.ok(received.envPairs.includes(`NODE_OPTIONS=${envFlag}`));
  console.log(`${count} child-env/form differentials; Claude -> MCP -> cmd.exe boundary passed`);
 } finally {
  delete process[Symbol.for('murage.windowsHide.installed')];Object.assign(cp,original);cp.ChildProcess.prototype.spawn=native;binding.spawn=nativeSync;
  process.execArgv.splice(0,process.execArgv.length,...argv);if(prior===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=prior;
  Object.defineProperty(process,'platform',descriptor);
 }
});

test('Claude -> Node stdio MCP -> cmd.exe: fresh descendants repair a cleared environment', async () => {
 const {mkdtempSync,writeFileSync,readFileSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {removeTempDir}=await import('../server/testing/cleanup.ts');
 const dir=mkdtempSync(join(tmpdir(),'murage claude mcp-'));
 try {
  const preload=join(dir,'win-hide-child-process.cjs');
  const original=new URL(process.env.WINHIDE_INSTALLER_URL ?? new URL('./win-hide-child-process.cjs',import.meta.url));
  // Simulate Windows only inside these isolated realms. Stop cmd.exe at the
  // native boundary; Claude and the MCP server are real fresh Node processes.
  writeFileSync(preload,`Object.defineProperty(process,'platform',{value:'win32'});
const proto=require('node:child_process').ChildProcess.prototype, native=proto.spawn;
proto.spawn=function(options){if(options.file==='C:/Windows/System32/cmd.exe'){
 require('node:assert/strict').equal(options.windowsHide,true);
 const pairs=options.envPairs.filter(p=>/^NODE_OPTIONS=/i.test(p));
 require('node:assert/strict').equal(pairs.length,1);
 require('node:assert/strict').match(pairs[0],/win-hide-child-process.cjs/);
 console.log('cmd.exe hidden; inherited preload present');throw Error('fixture boundary');
}return Reflect.apply(native,this,[options]);};\n`+readFileSync(original,'utf8'));
  const inheritedRuntime=Object.fromEntries(['ELECTRON_RUN_AS_NODE','LD_LIBRARY_PATH'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  writeFileSync(join(dir,'mcp.cjs'),`const cp=require('node:child_process');
try{cp.spawn('C:/Windows/System32/cmd.exe',['/k'],{env:{NODE_OPTIONS:''}});}catch(e){if(e.message!=='fixture boundary')throw e;}`);
  writeFileSync(join(dir,'claude.cjs'),`require(${JSON.stringify(preload)});
const cp=require('node:child_process');
// Third-party Claude settings overlay clears NODE_OPTIONS before stdio MCP.
const mcp=cp.spawn(process.execPath,[${JSON.stringify(join(dir,'mcp.cjs'))}],{env:{...${JSON.stringify(inheritedRuntime)},NODE_OPTIONS:''},stdio:'inherit'});
mcp.on('exit',code=>process.exitCode=code);`);
  const result=cp.spawnSync(process.execPath,[join(dir,'claude.cjs')],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/cmd.exe hidden; inherited preload present/);
 } finally {await removeTempDir(dir);}
});
