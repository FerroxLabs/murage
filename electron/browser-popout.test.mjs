import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createBrowserPopouts, BROWSER_POPOUT_PROVEN_PLATFORMS } from './browser-popout.mjs';
class Window extends EventEmitter {
  constructor(options) { super(); this.options = options; this.dead = false; this.webContents = new EventEmitter(); Object.assign(this.webContents, { setWindowOpenHandler: fn => this.openHandler = fn, send: vi.fn(), focus: vi.fn() }); this.focus = vi.fn(); this.show = vi.fn(); }
  isDestroyed() { return this.dead; }
  async loadURL(url) { this.url = url; if (this.fail) throw Error('fixture'); }
  close() { this.emit('close'); if (!this.preventClose) this.destroy(); }
  destroy() { this.dead = true; this.emit('closed'); }
  getNormalBounds() { return { x: 30, y: 50, width: 1000, height: 800 }; }
  isMaximized() { return false; }
}
function fixture({ rejectLoad = false, preventClose = false } = {}) {
  const owner = new Window({}); const windows = []; const saved = new Map();
  const manager = createBrowserPopouts({ owner: () => owner, origin: () => 'http://localhost:7777', preload: '/fixture/preload.cjs',
    createWindow: options => { const w = new Window(options); w.fail = rejectLoad; w.preventClose = preventClose; windows.push(w); return w; },
    readState: id => saved.get(id), writeState: (id, state) => saved.set(id, state), workAreas: () => [{ x: 0, y: 0, width: 1920, height: 1080 }], openExternal: vi.fn() });
  return { owner, windows, saved, manager };
}
describe('browser pop-out lifetime', () => {
  it('opens once per bot, focuses again, restores bounds, and never exposes another window', async () => {
    const f = fixture(); await f.manager.open('ava'); await f.manager.open('ava'); await f.manager.open('bea');
    expect(f.windows).toHaveLength(2); expect(f.windows[0].focus).toHaveBeenCalled();
    const w = f.windows[0]; expect(w.options).toMatchObject({ parent: f.owner, modal: false, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    expect(w.url).toBe('http://localhost:7777/?surface=browser-popout&bot=ava');
    expect(w.openHandler({url:'https://example.com'})).toEqual({action:'deny'});
    f.manager.close('ava'); expect(f.manager.states()).toEqual([{botId:'bea',open:true}]);
    await f.manager.open('ava'); expect(f.windows[2].options).toMatchObject(f.saved.get('ava').bounds);
    f.owner.close(); expect(f.manager.states()).toEqual([]); expect(f.windows.every(w => w.dead)).toBe(true);
  });
  it.each(['', '../bot', 'a b', 'x'.repeat(121), null])('refuses invalid bot %s', async id => {
    const f = fixture(); await expect(f.manager.open(id)).rejects.toThrow(); expect(f.windows).toHaveLength(0);
  });
  it('removes trust on close and refuses sibling closes', async () => {
    const f = fixture(); await f.manager.open('ava'); await f.manager.open('bea');
    expect(() => f.manager.close('bea', f.windows[0].webContents)).toThrow();
    expect(f.manager.windowFor(f.windows[0].webContents)).toBe(f.windows[0]);
    f.manager.close('ava', f.windows[0].webContents); expect(f.manager.windowFor(f.windows[0].webContents)).toBeUndefined();

  });
  it('keeps every platform unqualified until real-machine proofs are recorded', () => { expect(BROWSER_POPOUT_PROVEN_PLATFORMS).toEqual([]); });
});

it('closes views when the owner close is intercepted by background mode', async () => {
  const f = fixture(); await f.manager.open('ava');
  f.owner.emit('close', { preventDefault() {} });
  expect(f.manager.states()).toEqual([]);
  expect(f.windows[0].dead).toBe(true);
});

it('restores a narrow pop-out at its saved size', async () => {
  const f = fixture(); await f.manager.open('ava');
  f.windows[0].getNormalBounds = () => ({x:30,y:50,width:450,height:500});
  f.manager.close('ava'); await f.manager.open('ava');
  expect(f.windows[1].options).toMatchObject({x:30,y:50,width:450,height:500});
});

it.each([false, true])('a rejected load destroys and unregisters the view even when close is intercepted (%s)', async preventClose => {
  const f = fixture({rejectLoad:true, preventClose});
  await expect(f.manager.open('ava')).rejects.toThrow('fixture');
  const failed = f.windows[0];
  expect(failed.dead).toBe(true);
  expect(f.manager.windowFor(failed.webContents)).toBeUndefined();
  expect(f.manager.states()).toEqual([]);
  expect(f.owner.webContents.send).not.toHaveBeenCalledWith('browser-popout:state', {botId:'ava',open:true});
  expect(f.owner.webContents.send).toHaveBeenCalledWith('browser-popout:state', {botId:'ava',open:false});
});

function cloudEvent(window) { return { sender: window.webContents, senderFrame: window.webContents.mainFrame }; }
async function cloudFixture({ rejectLoad = false, preventClose = false } = {}) {
  const { installCloudHome } = await import('./cloud-home-window.mjs');
  const windows = [], saved = new Map(), opened = vi.fn();
  class CloudWindow extends Window {
    constructor(options) {
      super(options); windows.push(this);
      this.webContents.mainFrame = { url: '', parent: null };
      this.webContents.isDestroyed = () => this.dead;
      if (options.webPreferences.additionalArguments.includes('--murage-cloud-surface=browser-popout')) {
        this.fail = rejectLoad; this.preventClose = preventClose;
      }
    }
    async loadURL(url) { this.webContents.mainFrame.url = url; return super.loadURL(url); }
  }
  const cloud = installCloudHome({
    packaged: false, env: { MURAGE_DESKTOP_CLOUD: '1' }, protocol: { registerSchemesAsPrivileged() {} },
    session: { fromPartition: () => ({ protocol: { handle() {} }, setPermissionRequestHandler() {}, webRequest: { onBeforeRequest() {} } }) },
    BrowserWindow: CloudWindow, shell: { openExternal: opened }, net: {}, distDir: '/fixture', cloudPreload: '/fixture/preload-cloud.cjs',
    popoutState: { readState: id => saved.get(id), writeState: (id, state) => saved.set(id, state), workAreas: () => [{ x: 0, y: 0, width: 1920, height: 1080 }] },
  });
  const owner = cloud.open('home-a'), other = cloud.open('home-b');
  return { cloud, manager: cloud.browserPopouts, owner, other, windows, saved, opened };
}
describe('Cloud browser pop-out (A7)', () => {
  it('uses sender home, its parent, session, preload and exact guarded URL; focuses one per home and bot', async () => {
    const { cloudPartition, cloudHomeEntryUrl } = await import('./cloud-home-protocol.mjs');
    const { cloudHomeNavigationAction } = await import('./main-ipc-trust.mjs');
    const f = await cloudFixture();
    await f.manager.open(cloudEvent(f.owner), 'ava', 'home-b');
    await f.manager.open(cloudEvent(f.owner), 'ava');
    const w = f.windows[2]; expect(f.windows).toHaveLength(3); expect(w.focus).toHaveBeenCalled();
    expect(w.options).toMatchObject({ parent: f.owner, minWidth:390, minHeight:400, modal:false, show:false,
      webPreferences: { partition:cloudPartition('home-a'), preload:'/fixture/preload-cloud.cjs', sandbox:true, contextIsolation:true, nodeIntegration:false, webSecurity:true,
        additionalArguments:['--murage-cloud-home=home-a','--murage-cloud-surface=browser-popout'] } });
    expect(w.url).toBe(cloudHomeEntryUrl('home-a','/?surface=browser-popout&bot=ava'));
    expect(cloudHomeNavigationAction(w.url,{homeId:'home-a'})).toBe('allow');
    for (const url of ['murage-home://home-a/api/bots','murage-home://home-b/']) {
      expect(cloudHomeNavigationAction(url,{homeId:'home-a'})).toBe('deny');
      for (const name of ['will-navigate','will-redirect']) { const ev={url,isMainFrame:true,preventDefault:vi.fn()};w.webContents.emit(name,ev);expect(ev.preventDefault).toHaveBeenCalled(); }
    }
    expect(w.openHandler({url:'https://example.com/'})).toEqual({action:'deny'});expect(f.opened).not.toHaveBeenCalled();
    const externalNavigation={url:'https://example.com/',isMainFrame:true,preventDefault:vi.fn()};
    w.webContents.emit('will-navigate',externalNavigation);
    expect(externalNavigation.preventDefault).toHaveBeenCalled();expect(f.opened).toHaveBeenCalledWith('https://example.com/');
    expect(f.cloud.windows().size).toBe(2);
    expect(f.cloud.senderHomeId(cloudEvent(w))).toBeNull(); expect(f.cloud.isCloudSender(cloudEvent(w))).toBe(false);
    expect(f.manager.windowFor(w.webContents)).toMatchObject({window:w,homeId:'home-a'});
    await f.manager.open(cloudEvent(f.other),'ava'); expect(f.windows).toHaveLength(4);
    expect(f.manager.states(cloudEvent(f.owner))).toEqual([{botId:'ava',open:true}]);
    expect(f.manager.states(cloudEvent(w))).toEqual([{botId:'ava',open:true}]);
    expect(() => f.manager.close(cloudEvent(w),'bea')).toThrow();
    f.manager.close(cloudEvent(w),'ava');
    expect(f.saved.has('cloud:home-a:ava')).toBe(true);
    expect(f.manager.windowFor(w.webContents)).toBeUndefined();
    expect(f.manager.states(cloudEvent(f.other))).toHaveLength(1);
    f.manager.closeAll();
  });
  it('refuses inactive, missing and foreign senders, closed homes and invalid bot IDs', async () => {
    const f=await cloudFixture();
    for(const bot of ['', '../x', 'a b', 'x'.repeat(121), null]) await expect(f.manager.open(cloudEvent(f.owner),bot)).rejects.toThrow();
    for(const event of [cloudEvent(new Window({})), {sender:{},senderFrame:{url:'murage-home://home-a/'}}, {sender:f.owner.webContents,senderFrame:{url:'murage-home://home-a/',parent:f.owner.webContents.mainFrame}}]) await expect(f.manager.open(event,'ava')).rejects.toThrow();
    const active=f.cloud.active; f.cloud.active=()=>false;
    await expect(f.manager.open(cloudEvent(f.owner),'ava')).rejects.toThrow(); f.cloud.active=active;
    f.owner.close();await expect(f.manager.open(cloudEvent(f.owner),'ava')).rejects.toThrow();expect(f.windows).toHaveLength(2);
  });
  it.each(['close','closed','disconnect'])('revokes all of one home on %s, before notifying',async action=>{
    const f=await cloudFixture();await f.manager.open(cloudEvent(f.owner),'ava');await f.manager.open(cloudEvent(f.owner),'bea');await f.manager.open(cloudEvent(f.other),'ava');
    const child=f.windows[2];
    f.owner.webContents.send.mockImplementation((channel,state)=>{if(!state.open)expect(f.manager.windowFor(child.webContents)).toBeUndefined();});
    if(action==='disconnect')f.cloud.close('home-a');else f.owner.emit(action);
    expect(f.windows[2].dead).toBe(true);expect(f.windows[3].dead).toBe(true);expect(f.windows[4].dead).toBe(false);
    f.manager.closeAll();expect(f.windows[4].dead).toBe(true);
  });
  it('destroys and unregisters a rejected load even with an intercepted close',async()=>{
    const f=await cloudFixture({rejectLoad:true,preventClose:true});
    await expect(f.manager.open(cloudEvent(f.owner),'ava')).rejects.toThrow('fixture');
    const w=f.windows[2];expect(w.dead).toBe(true);expect(f.manager.windowFor(w.webContents)).toBeUndefined();
    expect(f.manager.states(cloudEvent(f.owner))).toEqual([]);
    expect(f.owner.webContents.send).toHaveBeenCalledWith('cloud-home:browser-popout:state',{botId:'ava',open:false});
    expect(f.owner.webContents.send).not.toHaveBeenCalledWith('cloud-home:browser-popout:state',{botId:'ava',open:true});
  });
});
