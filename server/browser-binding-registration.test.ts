import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnifiedBrowserController } from './browser-control.ts';
import { registerBrowserBinding } from './browser-binding-registration.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
it('T18/M54s registration failure publishes no proxy or binding and closes only the prepared proxy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'murage-registration-')); dirs.push(dir);
  const controller = new UnifiedBrowserController({ stateFile: join(dir, 'control.json') });
  const spec = { command: 'old', args: [], env: {} }; await controller.register('key', spec);
  const previous = { close: vi.fn(async () => {}) }, prepared = { close: vi.fn(async () => {}) };
  const proxies = new Map([['bot', previous]]), bindings = new Map([['memo', { key: 'key', spec }]]);
  await expect(registerBrowserBinding({ controller, botId: 'bot', memo: 'memo', key: 'key', spec: { ...spec, command: 'changed' }, fresh: () => true, bindings, proxies, prepared })).rejects.toThrow('binding changed');
  expect(proxies.get('bot')).toBe(previous); expect(bindings.get('memo')?.spec).toBe(spec);
  expect(prepared.close).toHaveBeenCalledTimes(1); expect(previous.close).not.toHaveBeenCalled();
});
it('T12/T18 registration waits outside teardown then revalidates before publishing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'murage-registration-')); dirs.push(dir);
  let close!: () => void; let entered!: () => void; const closing = new Promise<void>(r => { entered = r; });
  const native = { protected: async () => false, request: async () => ({}), command: async () => ({}), connect: async () => 's', input() {}, resetStream() {}, close: async () => { entered(); await new Promise<void>(r => { close = r; }); } };
  const controller = new UnifiedBrowserController({ stateFile: join(dir, 'control.json'), createNative: () => native });
  const spec = { command: 'engine', args: [], env: {} }; await controller.register('key', spec); await controller.connect('key');
  const forgetting = controller.forgetEntry('key'); await closing;
  let fresh = true; const prepared = { close: vi.fn(async () => {}) }, bindings = new Map(), proxies = new Map();
  const registration = registerBrowserBinding({ controller, botId: 'bot', memo: 'memo', key: 'key', spec, fresh: () => fresh, bindings, proxies, prepared });
  fresh = false; close(); await forgetting;
  await expect(registration).rejects.toMatchObject({ code: 'revision_changed' });
  expect(bindings.size).toBe(0); expect(proxies.size).toBe(0); expect(prepared.close).toHaveBeenCalledTimes(1);
});
it('T18 a publication failure restores the controller entry as well as both maps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'murage-registration-')); dirs.push(dir);
  const controller = new UnifiedBrowserController({ stateFile: join(dir, 'control.json') });
  const prepared = { close: vi.fn(async () => {}) }, bindings = new Map(), proxies = new Map();
  await expect(registerBrowserBinding({ controller, botId: 'bot', memo: 'memo', key: 'new', spec: { command: 'engine', args: [], env: {} }, fresh: () => true, bindings, proxies, prepared, publish: () => { throw new Error('publication failed'); } })).rejects.toThrow('publication failed');
  expect(controller.holdState('new')).toBeNull(); expect(bindings.size).toBe(0); expect(proxies.size).toBe(0);
  expect(new UnifiedBrowserController({ stateFile: join(dir, 'control.json') }).holdState('new')).toBeNull();
  expect(prepared.close).toHaveBeenCalledTimes(1);
});
// T18: every named throw site, both prior-entry states, and an overlapping successor.
for(const existing of [false,true])for(const failure of ['changed-spec','capacity','save','proxy-map','binding-map','publish'] as const)for(const successor of [false,true]){
 it(`T18 table existing=${existing} failure=${failure} successor=${successor}`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'murage-registration-table-'));dirs.push(dir);
  const controller=new UnifiedBrowserController({stateFile:join(dir,'control.json')});
  const spec={command:'engine',args:[],env:{}};
  if(existing)await controller.register('key',spec);
  let closing!:()=>void,finish!:()=>void;
  const entered=new Promise<void>(resolve=>{closing=resolve;}),proceed=new Promise<void>(resolve=>{finish=resolve;});
  const old={close:vi.fn(async()=>{})},prepared={close:vi.fn(async()=>{if(successor){closing();await proceed;}})},next={close:vi.fn(async()=>{})};
  const previousBinding={key:'key',spec};
  const proxies=new Map(existing?[['bot',old]]:[]),bindings=new Map(existing?[['memo',previousBinding]]:[]);
  const injected=new Error(failure);
  if(['changed-spec','capacity'].includes(failure))vi.spyOn(controller,'registerLocked').mockImplementationOnce(()=>{throw injected;});
  if(failure==='save')vi.spyOn(controller as any,'save').mockImplementationOnce(()=>{throw injected;});
  if(failure==='proxy-map')vi.spyOn(proxies,'set').mockImplementationOnce(()=>{throw injected;});
  if(failure==='binding-map')vi.spyOn(bindings,'set').mockImplementationOnce(()=>{throw injected;});
  const observed=registerBrowserBinding({controller,botId:'bot',memo:'memo',key:'key',spec,fresh:()=>true,bindings,proxies,prepared,publish:()=>{if(failure==='publish')throw injected;}}).catch(error=>error);
  if(successor){
   await entered;
   // Disposal is outside the session gate. A complete successor transaction
   // publishes while this failed attempt is still closing its prepared proxy.
   await registerBrowserBinding({controller,botId:'bot',memo:'memo',key:'key',spec,fresh:()=>true,bindings,proxies,prepared:next});
   finish();
  }
  expect(await observed).toBe(injected);
  if(successor){expect(proxies.get('bot')).toBe(next);expect(bindings.get('memo')?.key).toBe('key');expect(controller.holdState('key')?.registered).toBe(true);}
  else{expect(proxies.get('bot')).toBe(existing?old:undefined);expect(bindings.get('memo')).toBe(existing?previousBinding:undefined);expect(controller.holdState('key')?.registered??false).toBe(existing);}
  expect(prepared.close).toHaveBeenCalledTimes(1);expect(old.close).not.toHaveBeenCalled();expect(next.close).not.toHaveBeenCalled();
 },3000);
}
