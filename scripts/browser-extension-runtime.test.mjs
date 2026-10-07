// SPDX-License-Identifier: AGPL-3.0-or-later
import { nativeRealm } from '../server/testing/native-dom-fixture.ts';
import { describe, it, expect, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { takeoverSource } from '../extensions/murage-browser/takeover.mjs';
import { createBrowserExtensionRuntime, SENSITIVE_RECTS, PRESENCE_LABEL_KEYS } from '../extensions/murage-browser/runtime.mjs';
import { readFileSync } from 'node:fs';
function fixture(stored = {}, runtimeOptions = {}) {
  const tabs = new Map([[999, { id: 999, url: 'https://private.test/secrets' }]]);
  let next = 1; const completionListeners = new Set();
  const observer = { paused: false, calls: [] };
  const sendCommand = async (_source, method, params = {}) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'observer-script' };
    if (method === 'Runtime.evaluate' && params.expression?.startsWith('globalThis.__murageTakeover?.')) {
      observer.calls.push(params.expression);
      return { result: { type: 'boolean', value: params.expression.includes('.arm(') ? !observer.paused : observer.paused } };
    }
    return { value: 'owned' };
  };
  const api = {
    webNavigation: { onCompleted: { addListener: listener => completionListeners.add(listener), removeListener: listener => completionListeners.delete(listener) } },
    storage: { local: { get: vi.fn(async key => ({ [key]: stored[key] })), set: vi.fn(async value => Object.assign(stored, structuredClone(value))) } },
    runtime: { getManifest: () => ({ version: '0.1.0' }) },
    tabs: { create: vi.fn(async ({ url }) => { const tab = { id: next++, url }; tabs.set(tab.id, tab); for (const listener of completionListeners) listener({ tabId: tab.id, frameId: 0, url }); return tab; }), get: vi.fn(async id => { if (!tabs.has(id)) throw Error('missing'); return tabs.get(id); }), group: vi.fn(async () => 42), remove: vi.fn(async id => tabs.delete(id)) },
    tabGroups: { update: vi.fn(async () => {}) }, action: { setBadgeText: vi.fn(async () => {}) },
    debugger: { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), sendCommand: vi.fn(sendCommand) },
  };
  const events = []; const runtime = createBrowserExtensionRuntime(api, { uuid: () => 'profile_1', emit: e => events.push(e), commandTimeoutMs: 500, ...runtimeOptions });
  let requestId = 0, connectionNumber = 0, nonce = 'a'.repeat(32), wireConnected = false;
  const originalConnection=runtime.connection;
  runtime.connection=async value=>{const result=await originalConnection(value);if(value&&!wireConnected){requestId=0;nonce=(++connectionNumber).toString(16).padStart(32,'0');}wireConnected=value;return result;};
  const wireId=sequence=>`${nonce}_${sequence}`;const nextId=()=>wireId(++requestId);
  const command = (operation, params = {}, generation = 1, bindingId = 'bot_a') => runtime.handleRequest({ version: 1, type: 'command', id: nextId(), bindingId, generation, operation, params });
  const bind = (bindingId = 'bot_a', generation = 1) => command('bind', { profileId: 'profile_1', botName: bindingId, approvedOrigins: ['https://allowed.test'] }, generation, bindingId);
  const init = async () => { await runtime.initialize(); await runtime.connection(true); return bind(); };
  const navigate = async () => { tabs.get(1).url = 'https://allowed.test/page'; await runtime.navigation({ tabId: 1, frameId: 0, url: tabs.get(1).url }); };
  return { api, runtime, command, bind, init, navigate, tabs, stored, events, completionListeners, observer, sendCommand, wireId, nextId };
}
describe('browser extension scoped runtime', () => {
  it('persists a random profile and creates an explicitly owned blank tab', async () => { const f = fixture(); const r = await f.init(); expect(r.result.tabId).toBe(1); expect(f.stored.murageBrowserState.profileId).toBe('profile_1'); expect(f.api.action.setBadgeText).toHaveBeenCalledWith({ tabId: 1, text: 'ON' }); });
  it('rejects wrong profile and protected origins', async () => { const f = fixture(); await f.init(); expect((await f.command('bind', { profileId: 'wrong', approvedOrigins: [] })).error.code).toBe('wrong_profile'); expect((await f.command('bind', { profileId: 'profile_1', approvedOrigins: ['https://bitwarden.com'] })).error.code).toBe('human_handover'); });
  it('scopes inventory to explicit ownership and never browser inventory', async () => { const f = fixture(); await f.init(); await f.bind('bot_b'); const r = await f.command('cdp', { method: 'Target.getTargets' }); expect(r.result.targetInfos.map(t => t.targetId)).toEqual(['1']); expect(f.api.debugger.sendCommand).not.toHaveBeenCalled(); });
  it('does not grant a tab through group membership or remote share', async () => { const f = fixture(); await f.init(); expect((await f.command('share', { tabId: 999 })).error.code).toBe('owner_action_required'); expect((await f.command('cdp', { method: 'Runtime.evaluate', tabId: 999, navigationEpoch: 1 })).error.code).toBe('stale_document'); });
  it('attaches the exact owned tab and wraps current document identity', async () => { const f = fixture(); await f.init(); await f.navigate(); const r = await f.command('cdp', { method: 'Runtime.evaluate', params: { expression: 'trusted engine script' }, tabId: 1, navigationEpoch: 2 }); expect(r.result).toEqual({ result: { value: 'owned' }, tabId: 1, navigationEpoch: 2, origin: 'https://allowed.test', url: 'https://allowed.test/page' }); expect(f.api.debugger.attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3'); });
  it('rejects stale documents, cookie interfaces and alien execution contexts', async () => { const f = fixture(); await f.init(); await f.navigate(); expect((await f.command('cdp', { method: 'Runtime.evaluate', tabId: 1, navigationEpoch: 1 })).error.code).toBe('stale_document'); expect((await f.command('cdp', { method: 'Network.getAllCookies' })).error.code).toBe('method_denied'); expect((await f.command('cdp', { method: 'Runtime.evaluate', params: { contextId: 991 }, tabId: 1, navigationEpoch: 2 })).error.code).toBe('context_denied'); });
  it('durably stops locally while offline and cannot be cleared by bind', async () => { const f = fixture(); await f.init(); await f.runtime.connection(false); await f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' }); const persisted = f.stored.murageBrowserState.bindings[0]; expect(persisted.state).toBe('stopped'); await f.runtime.connection(true); expect((await f.bind('bot_a', persisted.generation)).result.state).toBe('stopped'); expect((await f.command('cdp', { method: 'Target.getTargets' }, persisted.generation)).error.code).toBe('binding_inactive'); });
  it('drops an in-flight result after local Stop', async () => { const f = fixture(); await f.init(); await f.navigate(); let finish; await f.command('cdp', { method: 'Page.enable', tabId: 1, navigationEpoch: 2 }); f.api.debugger.sendCommand.mockImplementation((source, method, params) => method === 'Runtime.evaluate' && params.expression === 'delayed fixture read' ? new Promise(resolve => { finish = resolve; }) : f.sendCommand(source, method, params)); const pending = f.command('cdp', { method: 'Runtime.evaluate', params: { expression: 'delayed fixture read' }, tabId: 1, navigationEpoch: 2 }); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); await f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' }); finish({ secret: 'must not leave' }); expect((await pending).error.code).toBe('binding_inactive'); });
  it('drops an in-flight observation across disconnect and fresh reconnect without replay', async () => {
    const f=fixture();await f.init();await f.navigate();
    await f.command('cdp',{method:'Page.enable',tabId:1,navigationEpoch:2});
    let finish,dispatches=0;
    f.api.debugger.sendCommand.mockImplementation((source,method,params)=>{
      if(method==='Runtime.evaluate'&&params.expression==='delayed connection read'){dispatches++;return new Promise(resolve=>{finish=resolve;});}
      return f.sendCommand(source,method,params);
    });
    const request={version:1,type:'command',id:f.nextId(),bindingId:'bot_a',generation:1,operation:'cdp',params:{method:'Runtime.evaluate',params:{expression:'delayed connection read'},tabId:1,navigationEpoch:2}};
    const pending=f.runtime.handleRequest(request);
    await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
    expect((await f.runtime.handleRequest(request)).error.code).toBe('replayed_request');
    await f.runtime.connection(false);await f.runtime.connection(true);finish({result:{value:'private old connection result'}});
    const result=await pending;expect(result.error).toBeDefined();expect(JSON.stringify(result)).not.toContain('private old connection result');expect(dispatches).toBe(1);
    expect((await f.command('status')).result.state).toBe('paused');
  });
  it('pauses on unapproved navigation and does not disclose destination', async () => { const f = fixture(); await f.init(); await f.runtime.navigation({ tabId: 1, frameId: 0, url: 'https://private.test/?secret=yes' }); expect(f.stored.murageBrowserState.bindings[0].state).toBe('paused'); expect(JSON.stringify(f.events)).not.toContain('private.test'); });
  it('restart fences stale tab IDs and keeps stopped bindings stopped', async () => { const f = fixture(); await f.init(); await f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' }); const next = fixture(f.stored); await next.runtime.initialize(); const s = await next.runtime.handlePanel({ action: 'status' }); expect(s.bindings[0].tabs).toEqual([]); expect(s.bindings[0].state).toBe('stopped'); expect(s.bindings[0].generation).toBe(3); });
  it('restart releases the private-input guard it left armed in the tab it had, and still fences authority', async () => {
    // Chrome 151+ keeps a named isolated world across debugger sessions, so an
    // armed guard outlives the worker; only the new worker can release it.
    const f = fixture(); await f.init(); await f.navigate();
    const next = fixture(f.stored); next.tabs.set(1, { id: 1, url: 'https://allowed.test/page' });
    await next.runtime.initialize();
    expect(next.api.debugger.attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3');
    const calls = next.api.debugger.sendCommand.mock.calls;
    expect(calls.some(([source, method, params]) => source.tabId === 1 && method === 'Page.createIsolatedWorld' && params.worldName === 'murage-protected-document-v1')).toBe(true);
    expect(calls.some(([source, method, params]) => source.tabId === 1 && method === 'Runtime.evaluate' && params.expression === 'globalThis.__murageGuard?.enable(false)' && params.contextId === 7)).toBe(true);
    expect(next.api.debugger.detach).toHaveBeenCalledWith({ tabId: 1 });
    // Nothing else is sent to the page, and no authority survives.
    expect(calls.every(([, method, params]) => ['Page.getFrameTree', 'Page.createIsolatedWorld'].includes(method) || (method === 'Runtime.evaluate' && /^globalThis\.__murage(Guard|Takeover|Presence)\?\.(enable\(false\)|remove\(\))$/.test(params.expression)))).toBe(true);
    const s = await next.runtime.handlePanel({ action: 'status' });
    expect(s.bindings[0].tabs).toEqual([]); expect(s.bindings[0].state).toBe('paused'); expect(s.bindings[0].generation).toBe(2);
    await next.runtime.connection(true);
    expect((await next.command('cdp', { method: 'Runtime.evaluate', params: { expression: 'document.body.innerText' }, tabId: 1, navigationEpoch: 2 }, 1)).error.code).toBe('stale_generation');
  });
  it('restart never touches a closed tab or a reused tab ID now showing another site', async () => {
    const f = fixture(); await f.init(); await f.navigate();
    const closed = fixture(structuredClone(f.stored)); closed.tabs.delete(1);
    await expect(closed.runtime.initialize()).resolves.toBe('profile_1');
    expect(closed.api.debugger.attach).not.toHaveBeenCalled();
    const reused = fixture(structuredClone(f.stored)); reused.tabs.set(1, { id: 1, url: 'https://unrelated.test/' });
    await reused.runtime.initialize();
    expect(reused.api.debugger.attach).not.toHaveBeenCalled();
    const busy = fixture(structuredClone(f.stored)); busy.tabs.set(1, { id: 1, url: 'https://allowed.test/page' }); busy.api.debugger.attach.mockRejectedValue(Error('Another debugger is already attached'));
    await expect(busy.runtime.initialize()).resolves.toBe('profile_1');
    expect((await busy.runtime.handlePanel({ action: 'status' })).bindings[0].state).toBe('paused');
  });
  it('restart cleanup has a time limit per tab and overall: a hung page cannot hold up reconnect', async () => {
    const tabsFor = n => Array.from({ length: n }, (_, i) => ({ tabId: i + 1, navigationEpoch: 1, origin: 'https://allowed.test', url: 'https://allowed.test/p', bootstrap: false }));
    const state = n => ({ murageBrowserState: { profileId: 'profile_1', bindings: [{ id: 'bot_a', botName: 'bot_a', generation: 1, state: 'active', approvedOrigins: ['https://allowed.test'], tabs: tabsFor(n) }] } });
    // One hung tab, one healthy tab: the healthy one is still released, the hung one is let go.
    const one = fixture(state(2), { releaseTabMs: 50, releaseTotalMs: 1000 });
    for (const id of [1, 2]) one.tabs.set(id, { id, url: 'https://allowed.test/p' });
    one.api.debugger.attach.mockImplementation(async source => source.tabId === 1 ? new Promise(() => {}) : undefined);
    let started = Date.now(); await one.runtime.initialize();
    expect(Date.now() - started).toBeLessThan(800);
    expect(one.api.debugger.sendCommand.mock.calls.some(([source, method, params]) => source.tabId === 2 && method === 'Runtime.evaluate' && params.expression === 'globalThis.__murageGuard?.enable(false)')).toBe(true);
    expect(one.api.debugger.detach).toHaveBeenCalledWith({ tabId: 1 });
    // Every tab hangs: the whole loop stops at its overall limit.
    const many = fixture(state(20), { releaseTabMs: 50, releaseTotalMs: 160 });
    for (let id = 1; id <= 20; id++) many.tabs.set(id, { id, url: 'https://allowed.test/p' });
    many.api.debugger.attach.mockImplementation(() => new Promise(() => {}));
    started = Date.now(); await many.runtime.initialize();
    expect(Date.now() - started).toBeLessThan(700);
    expect(many.api.debugger.attach.mock.calls.length).toBeLessThan(6);
    // The defaults are bounded too.
    expect((await import('../extensions/murage-browser/runtime.mjs')).RELEASE_LIMITS).toMatchObject({ tabMs: expect.any(Number), totalMs: expect.any(Number) });
  });
  it('rejects replayed requests', async () => { const f = fixture(); await f.init(); const msg = { version: 1, type: 'command', id: f.nextId(), bindingId: 'bot_a', generation: 1, operation: 'status', params: {} }; await f.runtime.handleRequest(msg); expect((await f.runtime.handleRequest(msg)).error.code).toBe('replayed_request'); });
  it('owner resume requires broker reconciliation before execution', async () => { const f = fixture(); await f.init(); await f.navigate(); await f.runtime.handlePanel({ action: 'pause', bindingId: 'bot_a' }); const r = await f.runtime.handlePanel({ action: 'resume', bindingId: 'bot_a' }); expect((await f.command('cdp', { method: 'Target.getTargets' }, r.generation)).error.code).toBe('binding_inactive'); await f.bind('bot_a', r.generation); expect((await f.command('cdp', { method: 'Target.getTargets' }, r.generation)).result.targetInfos).toHaveLength(1); });
  it('waits for bootstrap completion after create resolves', async () => { const f = fixture(); f.api.tabs.create.mockImplementation(async () => { const tab = { id: 1, url: 'about:blank' }; f.tabs.set(1, tab); setTimeout(() => { for (const listener of f.completionListeners) listener({ tabId: 1, frameId: 0, url: 'about:blank' }); }, 5); return tab; }); expect((await f.init()).result.tabId).toBe(1); expect(f.completionListeners.size).toBe(0); });
  it('does not acquire a tab when Stop occurs during bootstrap', async () => { const f = fixture(); let complete; f.api.tabs.create.mockImplementation(async () => { const tab = { id: 1, url: 'about:blank' }; f.tabs.set(1, tab); complete = () => { for (const listener of f.completionListeners) listener({ tabId: 1, frameId: 0, url: 'about:blank' }); }; return tab; }); await f.runtime.initialize(); await f.runtime.connection(true); const pending = f.bind(); await vi.waitFor(() => expect(complete).toBeTypeOf('function')); await f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' }); complete(); expect((await pending).error.code).toBe('binding_inactive'); expect((await f.runtime.handlePanel({ action: 'status' })).bindings[0].tabs).toEqual([]); });
  it('never reads bootstrap or grants bootstrap from local Share', async () => { const f = fixture(); await f.init(); expect((await f.command('cdp', { method: 'Runtime.evaluate', tabId: 1, navigationEpoch: 1 })).error.code).toBe('site_denied'); f.tabs.set(2, { id: 2, url: 'about:blank' }); await expect(f.runtime.handlePanel({ action: 'share', bindingId: 'bot_a', tabId: 2 })).rejects.toMatchObject({ code: 'site_denied' }); });
  it('fences later about:blank or privileged navigation', async () => { for (const url of ['about:blank', 'chrome://settings']) { const f = fixture(); await f.init(); await f.navigate(); await f.runtime.navigation({ tabId: 1, frameId: 0, url }); expect((await f.runtime.handlePanel({ action: 'status' })).bindings[0].state).toBe('paused'); } });

  it('never emits private navigation after Pause or Stop', async () => { const f = fixture(); await f.init(); await f.runtime.handlePanel({ action: 'pause', bindingId: 'bot_a' }); f.events.length = 0; await f.runtime.navigation({ tabId: 1, frameId: 0, url: 'https://allowed.test/private?secret=yes' }); expect(f.events).toEqual([]); expect(JSON.stringify(await f.runtime.handlePanel({ action: 'status' }))).not.toContain('secret=yes'); });

  it('accepts5000 further ordered requests without forgetting early replay or clearing Stop', async () => {
    const f=fixture();await f.init();const early=f.wireId(1);
    for(let i=0;i<5000;i++)expect((await f.command('status')).error).toBeUndefined();
    const input={version:1,type:'command',id:early,bindingId:'bot_a',generation:1,operation:'cdp',params:{method:'Input.insertText',params:{text:'must not replay'},tabId:1,navigationEpoch:1}};
    const before=f.api.debugger.sendCommand.mock.calls.length;
    expect((await f.runtime.handleRequest(input)).error.code).toBe('replayed_request');
    await f.runtime.connection(true);expect((await f.runtime.handleRequest(input)).error.code).toBe('replayed_request');
    await f.runtime.handlePanel({action:'stop',bindingId:'bot_a'});await f.runtime.connection(false);await f.runtime.connection(true);
    const old={...input,id:f.nextId()};expect((await f.runtime.handleRequest(old)).error.code).toBe('stale_generation');expect((await f.runtime.handleRequest(old)).error.code).toBe('replayed_request');
    const state=(await f.command('status')).result;expect(state.state).toBe('stopped');
    expect((await f.command('cdp',input.params,state.generation)).error.code).toBe('binding_inactive');
    expect(f.api.debugger.sendCommand.mock.calls.length).toBe(before);expect(f.stored.murageBrowserState.bindings[0].state).toBe('stopped');
  });
  it('refuses duplicate, skipped, changed nonce and noncanonical sequences without consuming the next sequence',async()=>{
    const f=fixture();await f.init();const request={version:1,type:'command',bindingId:'bot_a',generation:1,operation:'status',params:{}};
    for(const[id,code]of [[f.wireId(1),'replayed_request'],[f.wireId(3),'request_sequence_gap'],['b'.repeat(32)+'_2','request_sequence_mismatch'],[f.wireId('02'),'invalid_request_sequence'],[f.wireId('9007199254740992'),'invalid_request_sequence']])expect((await f.runtime.handleRequest({...request,id})).error.code).toBe(code);
    expect((await f.command('status')).error).toBeUndefined();
    expect((await f.command('bind',{profileId:'wrong',approvedOrigins:[]})).error.code).toBe('wrong_profile');
    expect((await f.command('status')).error).toBeUndefined();
  });
  it('rejects disconnected requests without consuming an ID in the next connection', async () => {
    const f = fixture(); await f.runtime.initialize();
    const request = { version: 1, type: 'command', id: 'a'.repeat(32)+'_1', bindingId: 'bot_a', generation: 1, operation: 'bind', params: { profileId: 'profile_1', approvedOrigins: [] } };
    expect((await f.runtime.handleRequest(request)).error.code).toBe('host_offline');
    await f.runtime.connection(true);
    expect((await f.runtime.handleRequest(request)).error).toBeUndefined();
  });

  it('new, switch and close only select or remove explicitly owned tabs', async () => {
    const f = fixture(); await f.init();
    const created = await f.command('tab_new'); expect(created.result.selectedTabId).toBe(2);
    expect((await f.command('tab_switch', { tabId: 999 })).error.code).toBe('tab_not_shared');
    expect((await f.command('tab_close', { tabId: 999 })).error.code).toBe('tab_not_shared');
    expect(f.api.tabs.remove).not.toHaveBeenCalled();
    expect((await f.command('tab_switch', { tabId: 1 })).result.selectedTabId).toBe(1);
    const closed = await f.command('tab_close', { tabId: 1 });
    expect(closed.result.tabs.map(t => t.tabId)).toEqual([2]);
    expect(closed.result.selectedTabId).toBe(2); expect(f.tabs.has(999)).toBe(true);
  });
  it('only emits scoped CDP metadata without headers, response bodies or console content', async () => {
    const f = fixture(); await f.init(); await f.navigate();
    await f.command('cdp', { method: 'Page.enable', tabId: 1, navigationEpoch: 2 });
    f.events.length = 0;
    await f.runtime.debuggerEvent({tabId:999}, 'Network.responseReceived', {response:{url:'https://private.test/secret',headers:{cookie:'SECRET'}}});
    await f.runtime.debuggerEvent({tabId:1}, 'Runtime.consoleAPICalled', {args:[{value:'SECRET'}]});
    expect(f.events).toEqual([]);
    await f.runtime.debuggerEvent({tabId:1}, 'Network.responseReceived', {requestId:'req',timestamp:1,type:'Document',response:{url:'https://allowed.test/path?token=SECRET',status:200,mimeType:'text/html',headers:{cookie:'SECRET'},body:'SECRET'}});
    expect(f.events).toHaveLength(1); expect(f.events[0].event).toBe('cdp');
    expect(JSON.stringify(f.events)).not.toContain('SECRET');
    await f.runtime.handlePanel({action:'pause',bindingId:'bot_a'}); f.events.length=0;
    await f.runtime.debuggerEvent({tabId:1}, 'Page.loadEventFired', {timestamp:2}); expect(f.events).toEqual([]);
  });

  it('installs the isolated takeover observer before agent input and clears only that expected dispatch', async () => {
    const f = fixture(); await f.init(); await f.navigate();
    const result = await f.command('cdp', { method: 'Input.insertText', params: { text: 'expected' }, tabId: 1, navigationEpoch: 2 });
    expect(result.error).toBeUndefined();
    const calls = f.api.debugger.sendCommand.mock.calls;
    const installed = calls.findIndex(([, method]) => method === 'Runtime.addBinding');
    const armed = calls.findIndex(([, method, params]) => method === 'Runtime.evaluate' && params.expression?.includes('.arm('));
    const input = calls.findIndex(([, method]) => method === 'Input.insertText');
    const cleared = calls.findIndex(([, method, params]) => method === 'Runtime.evaluate' && params.expression?.includes('.clear('));
    expect(installed).toBeGreaterThanOrEqual(0); expect(armed).toBeGreaterThan(installed); expect(input).toBeGreaterThan(armed); expect(cleared).toBeGreaterThan(input);
    expect((await f.command('status')).result.state).toBe('active');
  });
  it('accepts takeover signals only from the installed isolated context and fences subsequent reads', async () => {
    const f = fixture(); await f.init(); await f.navigate();
    await f.command('cdp', { method: 'Page.enable', tabId: 1, navigationEpoch: 2 });
    const name = f.api.debugger.sendCommand.mock.calls.find(([,method]) => method === 'Runtime.addBinding')[2].name;
    for (const [source, params] of [[{tabId:999},{name,executionContextId:7,payload:'pause'}],[{tabId:1},{name,executionContextId:991,payload:'pause'}],[{tabId:1},{name:'forged',executionContextId:7,payload:'pause'}]]) {
      await f.runtime.debuggerEvent(source,'Runtime.bindingCalled',params);
      expect((await f.command('status')).result.state).toBe('active');
    }
    await f.runtime.debuggerEvent({tabId:1},'Runtime.bindingCalled',{name,executionContextId:7,payload:'pause'});
    const state=(await f.command('status')).result;expect(state.state).toBe('paused');expect(f.stored.murageBrowserState.bindings[0].state).toBe('paused');
    const before=f.api.debugger.sendCommand.mock.calls.length;
    expect((await f.command('cdp',{method:'Runtime.evaluate',params:{expression:'private read'},tabId:1,navigationEpoch:2},state.generation)).error.code).toBe('binding_inactive');
    expect(f.api.debugger.sendCommand.mock.calls.length).toBe(before);
  });
  it('checks the local latch before reading even when the takeover notification is unavailable', async () => {
    const f=fixture();await f.init();await f.navigate();
    await f.command('cdp',{method:'Page.enable',tabId:1,navigationEpoch:2});
    f.observer.paused=true;
    const result=await f.command('cdp',{method:'Runtime.evaluate',params:{expression:'private read'},tabId:1,navigationEpoch:2});
    expect(result.error.code).toBe('binding_inactive');
    expect(f.api.debugger.sendCommand.mock.calls.some(([,method,params])=>method==='Runtime.evaluate'&&params.expression==='private read')).toBe(false);
    expect(f.stored.murageBrowserState.bindings[0].state).toBe('paused');
  });
  it('drops a read result when unexpected input latches while the read is in flight', async () => {
    const f=fixture();await f.init();await f.navigate();
    f.api.debugger.sendCommand.mockImplementation(async(source,method,params)=>{
      if(method==='Runtime.evaluate'&&params.expression==='racing read'){f.observer.paused=true;return {result:{value:'private result'}};}
      return f.sendCommand(source,method,params);
    });
    const result=await f.command('cdp',{method:'Runtime.evaluate',params:{expression:'racing read'},tabId:1,navigationEpoch:2});
    expect(result.error.code).toBe('binding_inactive');expect(JSON.stringify(result)).not.toContain('private result');
  });

});

// Actual observer source evaluated with a minimal DOM/event fixture. These are
// correlation/latch unit tests; real trusted Chromium input is proved separately.
function observerFixture() {
  const listeners=new Map();const target={}, other={};let now=0;const signals=[];
  const world={document:{activeElement:target,elementFromPoint:()=>target},performance:{now:()=>now},fixtureSignal:message=>signals.push(message),window:{addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:(type,fn)=>{if(listeners.get(type)===fn)listeners.delete(type);}}};
  const install=()=>runInNewContext(takeoverSource('fixtureSignal'),world);install();
  const input=(type,props={})=>listeners.get(type)?.({type,isTrusted:true,composedPath:()=>[target],...props});
  return {world,target,other,signals,listeners,input,install,advance:ms=>{now+=ms;},control:()=>world.__murageTakeover};
}
describe('takeover observer trusted input correlation and local latch',()=>{
  it('ignores untrusted page-generated events but latches each unexpected trusted input class',()=>{
    for(const type of ['pointerdown','keydown','beforeinput','wheel','touchstart']){
      const f=observerFixture();f.input(type,{isTrusted:false});expect(f.control().state()).toBe(false);
      f.input(type);expect(f.control().state()).toBe(true);expect(f.signals).toEqual(['pause']);
      f.input(type);expect(f.signals).toEqual(['pause']);expect(f.control().arm('Input.insertText',{text:'x'})).toBe(false);expect(f.control().clear()).toBe(true);
    }
  });
  it('consumes one matching expected pointer event and pauses on a duplicate',()=>{
    const f=observerFixture();expect(f.control().arm('Input.dispatchMouseEvent',{type:'mousePressed',x:10,y:20,button:'left'})).toBe(true);
    f.input('pointerdown',{clientX:10,clientY:20,button:0});expect(f.control().state()).toBe(false);
    f.input('pointerdown',{clientX:10,clientY:20,button:0});expect(f.control().state()).toBe(true);
  });
  it('correlates key modifiers and text while rejecting wrong target, text and expired expectations',()=>{
    const good=observerFixture();good.control().arm('Input.dispatchKeyEvent',{type:'keyDown',key:'A',text:'A',modifiers:8});good.input('keydown',{key:'A',altKey:false,ctrlKey:false,metaKey:false,shiftKey:true});good.input('beforeinput',{data:'A'});expect(good.control().clear()).toBe(false);
    for(const mismatch of ['target','text','expired']){
      const f=observerFixture();f.control().arm('Input.insertText',{text:'expected'});if(mismatch==='expired')f.advance(1001);
      f.input('beforeinput',{data:mismatch==='text'?'private':'expected',...(mismatch==='target'?{composedPath:()=>[f.other]}:{})});expect(f.control().state()).toBe(true);
    }
  });
  it('matches Enter line-break input semantics without accepting arbitrary null-data edits',()=>{
    for(const inputType of ['insertLineBreak','insertParagraph']){const f=observerFixture();f.control().arm('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',modifiers:0});f.input('keydown',{key:'Enter',altKey:false,ctrlKey:false,metaKey:false,shiftKey:false});f.input('beforeinput',{data:null,inputType});expect(f.control().clear()).toBe(false);}
    const other=observerFixture();other.control().arm('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',text:'\r'});other.input('beforeinput',{data:null,inputType:'deleteContentBackward'});expect(other.control().state()).toBe(true);
  });
  it('removes listeners and reinstalls a fresh unlatched observer for explicit owner resume',()=>{
    const f=observerFixture();f.input('keydown');expect(f.control().state()).toBe(true);f.control().remove();expect(f.listeners.size).toBe(0);expect(f.control()).toBeUndefined();f.install();expect(f.control().state()).toBe(false);expect(f.listeners.size).toBe(5);f.input('touchstart');expect(f.control().state()).toBe(true);
  });
  it('documents correlation collision: identical trusted input inside the dispatch window has no human provenance bit',()=>{
    const f=observerFixture();f.control().arm('Input.insertText',{text:'same'});f.input('beforeinput',{data:'same'});expect(f.control().state()).toBe(false);
    f.control().clear();f.input('beforeinput',{data:'same'});expect(f.control().state()).toBe(true);
  });
});

describe('T30 gate items', () => {
  const rect = (x) => ({ nodeType: 1, localName: 'input', attrs: { type: 'password' }, getBoundingClientRect: () => ({ x, y: 1, width: 10, height: 5 }) });
  it('capture masks cover private inputs inside open shadow roots, nested ones too', async () => {
    const inner = { nodeType: 11, children: [rect(30)] };
    const outer = { nodeType: 11, children: [rect(20), { nodeType: 1, localName: 'div', shadowRoot: inner }] };
    const document = { documentElement: { nodeType: 1, localName: 'html', children: [rect(10), { nodeType: 1, localName: 'div', shadowRoot: outer }] } };
    let got; const sandbox = { ...nativeRealm, document, getComputedStyle: () => ({ webkitTextSecurity: 'none' }), __muragePresence: { capture: (on, rects) => { got = rects; return true; } } };
    await runInNewContext(SENSITIVE_RECTS, sandbox);
    expect(got.map((r) => r.x).sort((a, b) => a - b)).toEqual([10, 20, 30]);
  });
  it('the pill reads its two strings from the catalogue, in every language', () => {
    const keys = Object.fromEntries(PRESENCE_LABEL_KEYS.map(([name, key]) => [name, key]));
    expect(keys.waiting).toBe('overlayYourTurn'); expect(keys.stopTask).toBe('overlayStopTask');
    for (const lang of ['en', 'es', 'fr', 'de', 'pt_BR', 'ja', 'zh_CN', 'hi']) {
      const pack = JSON.parse(readFileSync(new URL(`../extensions/murage-browser/_locales/${lang}/messages.json`, import.meta.url), 'utf8'));
      expect(pack.overlayYourTurn?.message, lang).toMatch(/\$BOT\$/);
      expect(pack.overlayStopTask?.message?.trim(), lang).toBeTruthy();
      for (const key of ['overlayYourTurn', 'overlayStopTask']) expect(pack[key].message, `${lang} ${key}`).not.toMatch(/—|\b(safe|safely|safety|unsafe)\b|always-on/i);
    }
  });
});
