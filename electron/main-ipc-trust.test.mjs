import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createOwnedMainIpc, createMainNavigationGuard } from './main-ipc-trust.mjs';
import { isOwnedMainSender } from './main-trust.mjs';
const origin = 'http://localhost:7777';
function fixture() {
  const frame = {url: origin + '/', parent: null};
  const sender = {mainFrame: frame, isDestroyed: () => false};
  const window = {webContents: sender, isDestroyed: () => false};
  const event = {sender, senderFrame: frame};
  return {window, event};
}
const allowed = ['desktop:surface-secret', 'desktop:skin', 'browser-popout:close', 'browser-popout:state-now'];
it('grants a registered pop-out exactly four channels across the entire main registration list', async () => {
  const f = fixture(); const handlers = new Map();
  const gate = createOwnedMainIpc({ipcMain: {handle: (c, fn) => handlers.set(c, fn), on: (c, fn) => handlers.set(c, fn)}, isTrusted: () => false, popout: {windowFor: sender => sender === f.event.sender ? f.window : undefined, origin: () => origin}});
  const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  const channels = new Set([...allowed, ...[...source.matchAll(/ipcMain\.(?:handle|on)\(\s*["']([^"']+)["']/g)].map(m => m[1]), 'future:owned-channel']);
  expect(channels.size).toBeGreaterThan(100);
  for (const channel of channels) {
    const listener = vi.fn(() => 'ok'); gate.handle(channel, listener);
    if (allowed.includes(channel)) expect(await handlers.get(channel)(f.event)).toBe('ok');
    else { await expect(handlers.get(channel)(f.event)).rejects.toThrow(); expect(listener).not.toHaveBeenCalled(); }
  }
});
it('rechecks top frame, origin, liveness and registration on each call; navigation stays on origin', async () => {
  const f = fixture(); let registered = f.window; let handler;
  const gate = createOwnedMainIpc({ipcMain: {handle: (_c,fn) => handler=fn}, isTrusted: () => false, popout: {windowFor: sender => sender === registered?.webContents ? registered : undefined, origin: () => origin}});
  gate.handle('desktop:surface-secret', () => 'fixture-secret');
  expect(await handler(f.event)).toBe('fixture-secret');
  await expect(handler({...f.event, senderFrame: {url:origin, parent:f.event.senderFrame}})).rejects.toThrow();
  f.event.senderFrame.url='https://elsewhere.test'; await expect(handler(f.event)).rejects.toThrow(); f.event.senderFrame.url=origin;
  f.window.isDestroyed=()=>true; await expect(handler(f.event)).rejects.toThrow(); f.window.isDestroyed=()=>false;
  registered=fixture().window; await expect(handler(f.event)).rejects.toThrow(); registered=undefined; await expect(handler(f.event)).rejects.toThrow();
  const guard=createMainNavigationGuard({origin:()=>origin,openExternal:vi.fn()});
  for(const name of ['willNavigate','willRedirect']) { const event={url:'https://elsewhere.test',isMainFrame:true,preventDefault:vi.fn()}; guard[name](event); expect(event.preventDefault).toHaveBeenCalled(); }
  expect(isOwnedMainSender(f.event,{window:f.window,origin})).toBe(true);
});

it('withholds the pop-out preload bridge when main refuses the surface secret', async () => {
  const { runInNewContext } = await import('node:vm');
  const source = readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8');
  const expose = vi.fn();
  runInNewContext(source, {
    require: () => ({ contextBridge: { exposeInMainWorld: expose }, ipcRenderer: { on: () => {}, sendSync: () => '', invoke: async () => false }, webUtils: {} }),
    process: { platform: 'linux', argv: ['--murage-renderer-origin=' + origin] },
    location: { origin, search: '?surface=browser-popout&bot=ava' }, URL, URLSearchParams, queueMicrotask,
  });
  expect(expose).not.toHaveBeenCalled();
});

it('A7 Cloud pop-out admits exactly two channels across every channel class and main registration', async()=>{
  const {channelClass,CLOUD_ONLY_CHANNELS,CLOUD_SAFE_CHANNELS,LOCAL_ONLY_CHANNELS}=await import('./ipc-channel-classes.mjs');
  const {isCloudHomeSender}=await import('./main-trust.mjs');
  const f=fixture(), parent=fixture(), local=fixture();f.event.senderFrame.url='murage-home://home-a/?surface=browser-popout&bot=ava';parent.event.senderFrame.url='murage-home://home-a/';
  let registered={window:f.window,homeId:'home-a'};
  const handlers=new Map(), gate=createOwnedMainIpc({ipcMain:{handle:(c,fn)=>handlers.set(c,fn)},isTrusted:event=>event.sender===local.event.sender,
    cloudPopout:{windowFor:sender=>sender===registered?.window.webContents?registered:undefined},
    cloud:{classOf:channelClass,isCloudSender:event=>isCloudHomeSender(event,{window:parent.window,homeId:'home-a'})}});
  const allow=['cloud-home:browser-popout:close','cloud-home:browser-popout:state-now'];
  const source=readFileSync(new URL('./main.mjs',import.meta.url),'utf8');
  const channels=new Set([...CLOUD_ONLY_CHANNELS,...CLOUD_SAFE_CHANNELS,...LOCAL_ONLY_CHANNELS,...allowed,...allow,'cloud-home:browser-popout:open','cloud-home:browser-popout:state','future:unknown',...[...source.matchAll(/ipcMain\.(?:handle|on)\(\s*["']([^"']+)["']/g)].map(m=>m[1])]);
  for(const channel of channels){const listener=vi.fn(()=>true);gate.handle(channel,listener);
    if(allow.includes(channel))expect(await handlers.get(channel)(f.event)).toBe(true);
    else {await expect(handlers.get(channel)(f.event)).rejects.toThrow();expect(listener).not.toHaveBeenCalled();}
  }
  for(const channel of ['cloud-home:browser-popout:open',...allow]){expect(await handlers.get(channel)(parent.event)).toBe(true);await expect(handlers.get(channel)(local.event)).rejects.toThrow();}
  const call=handlers.get(allow[0]);
  await expect(call({...f.event,senderFrame:{url:f.event.senderFrame.url,parent:f.event.senderFrame}})).rejects.toThrow();
  for(const url of ['https://elsewhere.test/','murage-home://home-b/','murage-home://u:p@home-a/','murage-home://home-a:8080/']){
    f.event.senderFrame.url=url;await expect(call(f.event)).rejects.toThrow();
  }
  f.event.senderFrame.url='murage-home://home-a/';f.window.isDestroyed=()=>true;await expect(call(f.event)).rejects.toThrow();f.window.isDestroyed=()=>false;
  registered={window:fixture().window,homeId:'home-a'};await expect(call(f.event)).rejects.toThrow();registered=undefined;await expect(call(f.event)).rejects.toThrow();
});
