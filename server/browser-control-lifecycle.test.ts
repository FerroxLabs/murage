import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnifiedBrowserController } from './browser-control.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import type { NativeBrowser } from './browser-native-relay.ts';
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'murage-session-gate-')); dirs.push(dir);
  const stateFile = join(dir, 'control.json');
  const spec = { command: '/fixture/engine', args: [], env: { AGENT_BROWSER_SESSION: 'session', AGENT_BROWSER_SOCKET_DIR: dir } };
  const native: NativeBrowser = { daemonIdentity: { pid: 123, start: '100', bootId: 'fixture-boot' }, protected: async () => false, request: vi.fn(async () => ({ tools: [] })), command: vi.fn(async () => ({})), connect: vi.fn(async () => 'stream'), input() {}, resetStream() {}, close: vi.fn(async () => {}) };
  const factory = vi.fn(() => native);
  const controller = new UnifiedBrowserController({ stateFile, createNative: factory, judgeDaemon: async () => 'unknown' });
  return { dir, stateFile, spec, native, factory, controller };
}
it('T6b/M37s probes restored holds without binding a spec', async () => {
  const f = fixture(); await f.controller.register('key', f.spec, 'bot'); await f.controller.take('key', 'owner');
  const restored = new UnifiedBrowserController({ stateFile: f.stateFile });
  expect(restored.holdState('key')).toMatchObject({ held: true, registered: false });
  expect(restored.blocksCommit('key')).toBe('held');
});
it.each(['restart', 'reopen', 'forgetEntry'] as const)('T17/M51s/M58s %s excludes every native creator through close acknowledgement', async action => {
  const f = fixture(); await f.controller.register('key', f.spec, 'bot'); await f.controller.connect('key');
  const held = action === 'reopen' ? await f.controller.take('key', 'owner') : f.controller.status('key');
  const close = deferred(), entered = deferred(); f.native.close = vi.fn(async () => { entered.resolve(); await close.promise; });
  const operation = action === 'forgetEntry' ? f.controller.forgetEntry('key') : action === 'reopen' ? f.controller.reopen('key', 'owner', held.generation) : f.controller.restart('key', 'owner');
  await entered.promise; const before = f.factory.mock.calls.length;
  await f.controller.refresh('key'); await f.controller.connect('key');
  await expect(f.controller.dispatch('key', 'tools/list', {}, () => true)).rejects.toMatchObject({ code: 'browser_closing' });
  await expect(f.controller.dispatch('key', 'tools/call', { name: 'agent_browser_snapshot' }, () => true)).rejects.toMatchObject({ code: 'browser_closing' });
  await expect(f.controller.take('key', 'owner')).rejects.toMatchObject({ status: 409 });
  expect(f.factory).toHaveBeenCalledTimes(before);
  const registered = f.controller.register('key', f.spec, 'bot'); let finished = false; void registered.then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBe(false);
  close.resolve(); await operation; await registered;
});
it.each(['restart', 'reopen', 'forgetEntry'] as const)('T23/M62s %s retains uncertain teardown across restart', async action => {
  const f = fixture(); await f.controller.register('key', f.spec, 'bot'); await f.controller.connect('key');
  const held = action === 'reopen' ? await f.controller.take('key', 'owner') : f.controller.status('key');
  f.native.close = vi.fn(async () => { throw new Error('close timeout'); });
  const operation = action === 'forgetEntry' ? f.controller.forgetEntry('key') : action === 'reopen' ? f.controller.reopen('key', 'owner', held.generation) : f.controller.restart('key', 'owner');
  await expect(operation).rejects.toMatchObject({ status: 503 });
  expect(f.controller.holdState('key')).toMatchObject({ closeFailed: true });
  expect(JSON.parse(readFileSync(f.stateFile, 'utf8'))[0][1]).toMatchObject({ closeFailed: true, daemonIdentity: f.native.daemonIdentity, closeTarget: { botId: 'bot', command: f.spec.command, session: 'session', socketDir: f.dir } });
  const restored = new UnifiedBrowserController({ stateFile: f.stateFile, createNative: f.factory, judgeDaemon: async () => 'unknown' });
  expect(restored.failedKeyForBot('bot')).toBe('key');
  expect(await restored.refresh('key')).toMatchObject({ closeFailed: true });
  await expect(restored.take('key', 'owner')).rejects.toMatchObject({ code: 'browser_close_failed' });
  await expect(restored.register('key', f.spec, 'bot')).rejects.toMatchObject({ code: 'browser_closing' });
  await expect(restored.dispatch('key', 'tools/list', {}, () => true)).rejects.toMatchObject({ code: 'browser_closing' });
  f.native.close = vi.fn(async () => {});
  await restored.restart('key', 'owner');
  expect(restored.holdState('key')?.closeFailed).toBe(false);
  await restored.register('key', f.spec, 'bot'); await restored.dispatch('key', 'tools/list', {}, () => true);
});
it('T23 close deadline retains exclusion while the late acknowledgement is unresolved', async () => {
  vi.useFakeTimers(); const f = fixture(); await f.controller.register('key', f.spec, 'bot'); await f.controller.connect('key');
  const close = deferred(); f.native.close = async () => close.promise;
  const result = f.controller.restart('key', 'owner').catch(e => e);
  await vi.advanceTimersByTimeAsync(5001); expect(await result).toMatchObject({ status: 503 });
  expect(f.controller.holdState('key')?.closeFailed).toBe(true); close.resolve(); await Promise.resolve();
  expect(f.controller.holdState('key')?.closeFailed).toBe(true);
});
it('T25/M63s only verified termination clears a restored refusal', async () => {
  const f = fixture(); await f.controller.register('key', f.spec, 'bot'); await f.controller.connect('key');
  f.native.close = async () => { throw new Error('timeout'); }; await f.controller.restart('key', 'owner').catch(() => {});
  let verdict: 'unknown' | 'alive' | 'gone' = 'unknown';
  const restored = new UnifiedBrowserController({ stateFile: f.stateFile, createNative: f.factory, judgeDaemon: async () => verdict });
  expect(await restored.recoverClosed('key')).toBe(false); verdict = 'alive'; expect(await restored.recoverClosed('key')).toBe(false);
  verdict = 'gone'; expect(await restored.recoverClosed('key')).toBe(true);
  await restored.register('key', f.spec, 'bot'); expect(restored.status('key').closeFailed).toBe(false);
});
it('T25 rejects malformed persisted daemon identity and close target', async () => {
  const f = fixture();
  for (const extra of [{ daemonIdentity: { pid: -1, start: 'x', bootId: 'b' } }, { closeTarget: { botId: 'b', command: [], socketDir: '/tmp', session: '../x' } }]) {
    writeFileSync(f.stateFile, JSON.stringify([['key', { generation: 1, held: false, closeFailed: true, ...extra }]]));
    expect(() => new UnifiedBrowserController({ stateFile: f.stateFile })).toThrow('Invalid browser control state');
  }
});
it('T9/M47s every controller mutation rejects a forged session token', async()=>{
 const f=fixture();await f.controller.register('key',f.spec,'bot');const fake={keys:['key']};
 const mutations=[()=>f.controller.registerLocked(fake,'key',f.spec),()=>f.controller.takeLocked(fake,'key','owner'),()=>f.controller.reclaimLocked(fake,'key','owner'),()=>f.controller.releaseLocked(fake,'key','owner',1),()=>f.controller.reopenLocked(fake,'key','owner',1),()=>f.controller.restartLocked(fake,'key','owner'),()=>f.controller.retryLocked(fake,'key'),()=>f.controller.navigateLocked(fake,'key','owner',1,'https://example.com')];
 for(const mutate of mutations)expect(mutate).toThrow('gate_token');expect(f.controller.holdState('key')?.held).toBe(false);
});
it('T12/M52s a registration with a live token cannot clear another operation\'s forget',async()=>{
 const f=fixture();await f.controller.register('key',f.spec,'bot');await f.controller.connect('key');const entered=deferred(),finish=deferred();f.native.close=async()=>{entered.resolve();await finish.promise;};
 const forgetting=f.controller.forgetEntry('key');await entered.promise;
 await expect(f.controller.sessionGate.run(['key'],token=>f.controller.registerLocked(token,'key',f.spec))).rejects.toMatchObject({code:'forget_in_progress'});
 expect(f.controller.holdState('key')?.forgetting).toBe(true);finish.resolve();await forgetting;expect(f.controller.holdState('key')).toBeNull();
});
it('T17/M53s an overtaken blank-page continuation cannot clear protection for a successor hold',async()=>{
 const f=fixture();await f.controller.register('key',f.spec,'bot');await f.controller.connect('key');const held=await f.controller.take('key','owner');
 await f.controller.input('key','owner',held.generation,{type:'input_keyboard',eventType:'char',text:'fixture'});
 const entered=deferred(),finish=deferred();f.native.command=vi.fn(async()=>{entered.resolve();await finish.promise;return {};});
 const reopen=f.controller.reopen('key','owner',f.controller.status('key').generation).catch(error=>error);await entered.promise;
 await f.controller.reclaim('key','owner');finish.resolve();await reopen;
 expect(f.controller.status('key')).toMatchObject({held:true,protectedDocument:true,protectedReason:'owner-input'});
});
it('T11 restart waiting for Allow leaves the session gate available to Hand back',async()=>{
 const f=fixture();await f.controller.register('key',f.spec,'bot');await f.controller.connect('key');await f.controller.take('key','owner');
 const entered=deferred(),finish=deferred();f.native.connect=vi.fn(async()=>{entered.resolve();await finish.promise;return 'new-stream';});
 const restart=f.controller.restart('key','owner');await entered.promise;
 const status=f.controller.status('key');expect((await f.controller.release('key','owner',status.generation,status.control)).held).toBe(false);
 finish.resolve();await restart;
},10000);
it('M59s failed close restores the identical native for retry, without an extra close-only instance',async()=>{
 const f=fixture();await f.controller.register('key',f.spec);await f.controller.connect('key');
 vi.mocked(f.native.close).mockRejectedValueOnce(new Error('close refused'));
 await expect(f.controller.restart('key','owner')).rejects.toMatchObject({code:'browser_close_failed'});expect(f.factory).toHaveBeenCalledTimes(1);
 await f.controller.restart('key','owner');expect(f.native.close).toHaveBeenCalledTimes(2);expect(f.factory).toHaveBeenCalledTimes(2);
});
// T12/T17 deterministic cross product, each cell owns a fresh controller.
const rivals=['refresh','dispatch','tools/list','take','release','navigate','restart','reopen','register','forgetEntry'] as const;
for(const operation of ['forgetEntry','restart','reopen'] as const)for(const phase of ['before','close-in-flight','after'] as const)for(const rival of rivals){
 it(`T12/T17 table ${operation} / ${phase} / ${rival}`,async()=>{
  const f=fixture();await f.controller.register('key',f.spec,'bot');await f.controller.connect('key');
  if(operation==='reopen')await f.controller.take('key','owner');
  const close=deferred(),entered=deferred();let block=phase==='close-in-flight';
  f.native.close=vi.fn(async()=>{if(block){entered.resolve();await close.promise;}});
  const run=()=>operation==='forgetEntry'?f.controller.forgetEntry('key'):operation==='restart'?f.controller.restart('key','owner'):f.controller.reopen('key','owner',f.controller.status('key').generation);
  const compete=()=>{
   const status=f.controller.holdState('key')?f.controller.status('key'):undefined;
   if(rival==='refresh')return f.controller.refresh('key');
   if(rival==='dispatch'||rival==='tools/list')return f.controller.dispatch('key',rival==='dispatch'?'tools/call':'tools/list',{name:'agent_browser_snapshot'},()=>true);
   if(rival==='register')return f.controller.register('key',f.spec,'bot');
   if(rival==='forgetEntry')return f.controller.forgetEntry('key');
   if(rival==='release')return f.controller.release('key','owner',status?.generation??0,status?.control);
   if(rival==='navigate')return f.controller.navigate('key','owner',status?.generation??0,'https://example.com');
   if(rival==='reopen')return f.controller.reopen('key','owner',status?.generation??0);
   return f.controller[rival]('key','owner');
  };
  const safe=(fn:()=>unknown)=>Promise.resolve().then(fn).then(value=>({ok:true,value}),error=>({ok:false,error}));
  if(phase==='before'){
   await safe(compete);await safe(run);
   if(f.controller.holdState('key')?.held)expect(f.controller.blocksCommit('key')).toBe('held');
  }else if(phase==='after'){
   await safe(run);const result=await safe(compete);
   if(operation==='forgetEntry'&&!['register','forgetEntry'].includes(rival))expect(result.ok).toBe(false);
  }else{
   const pending=safe(run);await entered.promise;const created=f.factory.mock.calls.length;
   const before=f.controller.status('key');let settled=false;
   const other=safe(compete).then(value=>{settled=true;return value;});
   // A session barrier flushes gated refusals without advancing the close.
   await f.controller.sessionGate.run(['key'],()=>{});await Promise.resolve();
   expect(f.factory).toHaveBeenCalledTimes(created);
   expect(f.native.request).not.toHaveBeenCalled();
   if(['register','forgetEntry'].includes(rival))expect(settled).toBe(false);
   if(rival==='refresh')expect(f.controller.status('key').problem).toBe(before.problem);
   block=false;close.resolve();await pending;const result=await other;
   if(!['register','forgetEntry','refresh'].includes(rival))expect(result.ok).toBe(false);
   if(rival==='register')expect(f.controller.holdState('key')?.registered).toBe(true);
  }
 },3000);
}
// Every trailing await where another transition can win: identity read,
// blank-page command, and refresh/Allow. Close-in-flight is the table above.
for(const action of ['reopen','restart'] as const)for(const phase of ['identity','blank','refresh'] as const)for(const rival of ['release','take','register','forgetEntry'] as const){
 if(action==='restart'&&phase==='blank')continue; // restart has no blank-page command
 it(`T17 trailing table ${action} / ${phase} / ${rival}`,async()=>{
  const f=fixture(),entered=deferred(),finish=deferred();
  await f.controller.register('key',f.spec,'bot');await f.controller.connect('key');
  await f.controller.take('key','owner');
  await f.controller.input('key','owner',f.controller.status('key').generation,{type:'input_keyboard',eventType:'char',text:'private'});
  let pause=true;
  if(phase==='identity')(f.controller as any).judgeDaemon=async()=>{if(pause){entered.resolve();await finish.promise;}return 'unknown';};
  if(phase==='blank')f.native.command=vi.fn(async()=>{if(pause){entered.resolve();await finish.promise;}return {};});
  if(phase==='refresh')f.native.connect=vi.fn(async()=>{if(pause){entered.resolve();await finish.promise;}return 'next-stream';});
  const op=(action==='reopen'?f.controller.reopen('key','owner',f.controller.status('key').generation):f.controller.restart('key','owner')).catch(e=>e);
  await entered.promise;const previous=f.controller.status('key'),creates=f.factory.mock.calls.length;
  const other=Promise.resolve().then<unknown>(()=>rival==='register'?f.controller.register('key',f.spec,'bot'):rival==='forgetEntry'?f.controller.forgetEntry('key'):rival==='take'?f.controller.take('key','owner'):f.controller.release('key','owner',previous.generation,previous.control)).catch(e=>e);
  await f.controller.sessionGate.run(['key'],()=>{});
  if(phase==='identity')expect(f.factory).toHaveBeenCalledTimes(creates);
  pause=false;finish.resolve();const result=await op;await other;
  if(phase==='blank'&&['take','register'].includes(rival)){
   expect(result).toMatchObject({status:503});
   expect(f.controller.status('key').protectedDocument).toBe(true);
  }
  // A successor's hold and protection survive a stale trailing completion.
  if(rival==='take'&&phase!=='identity')expect(f.controller.holdState('key')?.held).toBe(true);
 },3000);
}
for(const phase of ['pending-drain','phase2-gate'] as const)for(const rival of rivals){
 it(`T12 forget ${phase} / ${rival}`,async()=>{
  const f=fixture(),entered=deferred(),finish=deferred();await f.controller.register('key',f.spec,'bot');await f.controller.connect('key');
  let dispatch:Promise<unknown>|undefined;
  if(phase==='pending-drain'){
   f.native.request=vi.fn(async()=>{entered.resolve();await finish.promise;return {};});
   dispatch=f.controller.dispatch('key','tools/call',{name:'agent_browser_snapshot'},()=>true).catch(error=>error);await entered.promise;
  }else{
   const original=f.controller.sessionGate.run.bind(f.controller.sessionGate);let count=0;
   vi.spyOn(f.controller.sessionGate,'run').mockImplementation(async(keys,fn)=>{if(++count===2){entered.resolve();await finish.promise;}return original(keys,fn);});
  }
  const forgetting=f.controller.forgetEntry('key');
  if(phase==='pending-drain')await f.controller.sessionGate.run(['key'],()=>{});else await entered.promise;
  expect(f.controller.holdState('key')?.forgetting).toBe(true);
  const created=f.factory.mock.calls.length,requests=vi.mocked(f.native.request).mock.calls.length,status=f.controller.status('key');
  const other=Promise.resolve().then(()=>{
   switch(rival){
    case 'refresh':return f.controller.refresh('key');
    case 'tools/list':case 'dispatch':return f.controller.dispatch('key',rival==='dispatch'?'tools/call':'tools/list',{name:'agent_browser_snapshot'},()=>true);
    case 'take':return f.controller.take('key','owner');
    case 'release':return f.controller.release('key','owner',status.generation,status.control);
    case 'navigate':return f.controller.navigate('key','owner',status.generation,'https://example.com');
    case 'restart':return f.controller.restart('key','owner');
    case 'reopen':return f.controller.reopen('key','owner',status.generation);
    case 'register':return f.controller.register('key',f.spec,'bot');
    case 'forgetEntry':return f.controller.forgetEntry('key');
   }
  }).then(value=>({ok:true,value}),error=>({ok:false,error}));
  await f.controller.sessionGate.run(['key'],()=>{});
  expect(f.factory).toHaveBeenCalledTimes(created);expect(f.native.request).toHaveBeenCalledTimes(requests);expect(f.controller.holdState('key')?.held).toBe(false);
  finish.resolve();await forgetting;await dispatch;const result=await other;
  if(!['refresh','register','forgetEntry'].includes(rival))expect(result.ok).toBe(false);
  if(rival==='register')expect(f.controller.holdState('key')?.registered).toBe(true);
  else expect(f.controller.holdState('key')).toBeNull();
  expect(f.native.close).toHaveBeenCalledTimes(1);
 },3000);
}
