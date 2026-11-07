// The real UpdateBanner and round button in a browser, on a fake updater bridge: the pop-up comes up by itself, typing is never
// interrupted, it clears the footer, the Undo toast and the composer, and it closes and comes back by the rule.
import {test,expect} from "./page-error-guard";
import {build} from 'vite';
import tailwindcss from '@tailwindcss/vite';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,mkdtempSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
const root=fileURLToPath(new URL('../../',import.meta.url));let scratch='',server:any,origin='';
test.beforeAll(async()=>{
 scratch=realpathSync(mkdtempSync(join(tmpdir(),'murage-update-popup-')));
 writeFileSync(join(scratch,'index.html'),'<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="height:100vh"></div><script type="module" src="/entry.tsx"></script>');
 writeFileSync(join(scratch,'style.css'),readFileSync(join(root,'src/styles.css'),'utf8').replace('@import "tailwindcss";',`@import "${root}/node_modules/tailwindcss/index.css" source(none);\n@source "${root}/src";\n@source "./entry.tsx";`));
 writeFileSync(join(scratch,'entry.tsx'),`
 import React from '${root}/node_modules/react/index.js';import{createRoot}from'${root}/node_modules/react-dom/client.js';
 import{updatePopupAnchorRef}from'${root}/src/lib/update-card.ts';
 import{UpdateBanner}from'${root}/src/components/UpdateBanner.tsx';import{UpdateIndicator}from'${root}/src/components/UpdateIndicator.tsx';import{UndoToastHost}from'${root}/src/components/ui/UndoToast.tsx';import{undoHost}from'${root}/src/lib/undo.ts';import './style.css';
 const listeners=new Set();let state={status:'idle'};
 window.fixtureState=(next)=>{state=next;for(const l of listeners)l(next);};window.fixtureUndo=undoHost;
 const q=new URLSearchParams(location.search);
 if(q.get('surface')!=='browser')window.muragebox={updater:{onState:(l)=>{listeners.add(l);l(state);return()=>listeners.delete(l);},download:async()=>{},install:async()=>{},retry:async()=>{},check:async()=>{}}};
 const rail=q.get('rail')==='1';
 // late=1: the terms screen first, so the sidebar (and its footer) mounts only once the terms are accepted.
 function Aside(){const[shown,setShown]=React.useState(q.get('late')!=='1');window.fixtureShowFooter=()=>setShown(true);
  return shown?<aside className={(rail?'w-[64px]':'w-[320px]')+' flex h-full shrink-0 flex-col justify-end max-md:hidden'}><div data-update-popup-anchor="" ref={updatePopupAnchorRef} data-testid="footer" className="px-3 pb-3 pt-2" style={rail?{height:170}:{height:68}}><UpdateIndicator/></div></aside>:null;}
 createRoot(document.getElementById('root')).render(<div className="flex h-full bg-app text-ink">
  <UpdateBanner/><Aside/>
  <main className="flex flex-1 flex-col justify-end p-4"><textarea data-testid="composer" className="h-24 w-full bg-control"/></main><UndoToastHost/></div>);
 `);
 await build({configFile:false,root:scratch,envFile:false,logLevel:'silent',resolve:{alias:{'@':join(root,'src'),react:join(root,'node_modules/react'),'react-dom':join(root,'node_modules/react-dom')}},esbuild:{jsx:'automatic'},build:{outDir:join(scratch,'dist'),emptyOutDir:true},plugins:[tailwindcss()]});
 server=createServer((req,res)=>{const path=(req.url||'/').split('?')[0];const file=join(scratch,'dist',path==='/'?'index.html':path.slice(1));try{const body=readFileSync(file);res.writeHead(200,{'content-type':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript'});res.end(body);}catch{res.writeHead(404);res.end();}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async()=>{await new Promise<void>(resolve=>server?server.close(()=>resolve()):resolve());if(scratch)safeWipeSync(scratch);});
const go=async(page:any,query='')=>{await page.goto(`${origin}/?${query}`);await page.evaluate(()=>{try{localStorage.clear();}catch{}});await page.reload();};
const push=(page:any,state:any)=>page.evaluate((s:any)=>(window as any).fixtureState(s),state);
const box=(locator:any)=>locator.boundingBox() as Promise<{x:number;y:number;width:number;height:number}>;
const apart=(a:any,b:any)=>a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y;

test('comes up by itself during typing, keeps focus and every key, and shows no scrim',async({page})=>{
 await page.setViewportSize({width:1280,height:800});await go(page);
 const composer=page.getByTestId('composer');await composer.click();await page.keyboard.type('hello ');
 await push(page,{status:'available',version:'1.0.12'});await expect(page.getByTestId('update-popup')).toHaveCount(0);
 await push(page,{status:'downloading',version:'1.0.12'});await push(page,{status:'downloading',version:'1.0.12',percent:37});
 await expect(page.getByTestId('update-popup')).toContainText('37%');await expect(composer).toBeFocused();
 await page.keyboard.type('world');await expect(composer).toHaveValue('hello world');
 await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByTestId('update-card-layer')).toHaveCount(0);
 await expect(page.getByTestId('update-popup').getByRole('status')).toBeVisible();
 // The pop-up slides in 28px; measure where it rests, not where the slide happens to be.
 await page.getByTestId('update-popup').evaluate((el:Element)=>Promise.all(el.getAnimations().map(a=>a.finished)));
 const popup=await box(page.getByTestId('update-popup'));const footer=await box(page.getByTestId('footer'));
 expect(apart(popup,footer)).toBe(true);expect(apart(popup,await box(composer))).toBe(true);expect(popup.x+popup.width).toBeLessThanOrEqual(320);
});
test('closing keeps the round button, stays closed for the download, comes back at ready, and the button brings it back',async({page})=>{
 await page.setViewportSize({width:1280,height:800});await go(page);
 await push(page,{status:'downloading',version:'1.0.12',percent:10});
 await page.getByTestId('update-popup').getByRole('button',{name:'Dismiss'}).click();await expect(page.getByTestId('update-popup')).toHaveCount(0);await expect(page.getByTestId('update-indicator')).toBeVisible();
 await push(page,{status:'downloading',version:'1.0.12',percent:50});await expect(page.getByTestId('update-popup')).toHaveCount(0);
 await page.getByTestId('update-indicator').click();await expect(page.getByTestId('update-popup')).toContainText('50%');await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.getByTestId('update-popup').getByRole('button',{name:'Dismiss'}).click();
 await push(page,{status:'downloaded',version:'1.0.12',installMode:'restart'});await expect(page.getByTestId('update-popup').getByRole('button',{name:'Restart to update'})).toBeVisible();
 await page.getByTestId('update-popup').getByRole('button',{name:'Later'}).click();await expect(page.getByTestId('update-popup')).toHaveCount(0);
 await page.reload();await push(page,{status:'downloaded',version:'1.0.12',installMode:'restart'});await expect(page.getByTestId('update-indicator')).toBeVisible();await expect(page.getByTestId('update-popup')).toHaveCount(0);
});
test('a keyboard that closes it lands on the round button, not the page',async({page})=>{
 await page.setViewportSize({width:1280,height:800});await go(page);
 await push(page,{status:'downloading',version:'1.0.12',percent:10});
 await page.getByTestId('update-popup').getByRole('button',{name:'Dismiss'}).focus();await page.keyboard.press('Escape');
 await expect(page.getByTestId('update-popup')).toHaveCount(0);await expect(page.getByTestId('update-indicator')).toBeFocused();
});
test('the card hands a download to the pop-up and focus returns to the round button',async({page})=>{
 await page.setViewportSize({width:1280,height:800});await go(page);
 await push(page,{status:'available',version:'1.0.12'});await page.getByTestId('update-indicator').click();await expect(page.getByRole('dialog')).toBeVisible();
 await push(page,{status:'downloading',version:'1.0.12'});await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByTestId('update-popup')).toBeVisible();await expect(page.getByTestId('update-indicator')).toBeFocused();
});
test('lifts clear of the Undo toast and settles back',async({page})=>{
 await page.setViewportSize({width:1280,height:800});await go(page);
 await push(page,{status:'downloading',version:'1.0.12',percent:10});const before=await box(page.getByTestId('update-popup'));
 await page.evaluate(()=>(window as any).fixtureUndo.offerUndo({kind:'local',key:'updpop',ms:30000,message:'Moved to archive, with a headline long enough to wrap onto more lines in the toast than one',undo:()=>{}}));
 const toast=page.locator('[data-undo-toast]');await expect(toast).toBeVisible();
 await expect.poll(async()=>apart(await box(page.getByTestId('update-popup')),await box(toast))).toBe(true);
 await toast.getByRole('button',{name:'Dismiss'}).click();await expect(toast).toHaveCount(0);
 await expect.poll(async()=>(await box(page.getByTestId('update-popup'))).y).toBe(before.y);
});
test('on the rail it clears the rail footer and the composer; narrow it hangs at the top, clear of the composer',async({page})=>{
 await page.setViewportSize({width:900,height:800});await go(page,'rail=1');
 await push(page,{status:'downloading',version:'1.0.12',percent:10});const composer=page.getByTestId('composer');
 let popup=await box(page.getByTestId('update-popup'));expect(apart(popup,await box(page.getByTestId('footer')))).toBe(true);expect(apart(popup,await box(composer))).toBe(true);
 await page.setViewportSize({width:420,height:700});
 await expect.poll(async()=>(await box(page.getByTestId('update-popup'))).y).toBeLessThan(120);
 popup=await box(page.getByTestId('update-popup'));expect(popup.x).toBeGreaterThanOrEqual(0);expect(popup.x+popup.width).toBeLessThanOrEqual(420);expect(apart(popup,await box(composer))).toBe(true);
});
// A full-window modal <dialog>, as What's New opens it after an update (showModal: top layer, the rest of the page inert).
const openModal=(page:any,box=false)=>page.evaluate((box:boolean)=>{const d=document.createElement('dialog');d.dataset.fixtureModal='';d.textContent="New in 1.0.18";
 if(box){d.className='box-dialog';d.style.cssText='width:420px;height:300px;overflow:clip';}else d.style.cssText='width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0';
 document.body.append(d);d.showModal();},box);
// What a person sees at the pop-up's centre: the pop-up itself, or whatever covers it.
const onTop=(page:any)=>page.getByTestId('update-popup').evaluate((el:Element)=>{const r=el.getBoundingClientRect();const top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return Boolean(top&&el.contains(top))&&r.width>0&&r.top>=0&&r.bottom<=innerHeight;});
const settle=(page:any)=>page.getByTestId('update-popup').evaluate((el:Element)=>Promise.all(el.getAnimations().map(a=>a.finished)));
test('a download that starts under an open What\'s New shows above it, with its percent, then Restart can be pressed',async({page})=>{
 await page.setViewportSize({width:1280,height:800});await go(page);
 await page.evaluate(()=>{(window as any).installs=0;(window as any).muragebox.updater.install=async()=>{(window as any).installs++;};});
 await openModal(page);
 await push(page,{status:'downloading',version:'1.0.18'});await push(page,{status:'downloading',version:'1.0.18',percent:37});
 await expect(page.getByTestId('update-popup')).toContainText('Downloading 1.0.18');await expect(page.getByTestId('update-popup')).toContainText('37%');
 await settle(page);await expect.poll(()=>onTop(page)).toBe(true);
 await push(page,{status:'downloading',version:'1.0.18',percent:64});await expect(page.getByTestId('update-popup')).toContainText('64%');await expect.poll(()=>onTop(page)).toBe(true);
 await push(page,{status:'downloaded',version:'1.0.18',installMode:'restart'});
 await expect(page.getByTestId('update-popup')).toContainText('1.0.18 is ready');await expect.poll(()=>onTop(page)).toBe(true);
 await page.getByTestId('update-popup').getByRole('button',{name:'Restart to update'}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).installs)).toBe(1);
 // What's New stays open behind it: the pop-up never closed it.
 await expect(page.locator('dialog[data-fixture-modal]')).toHaveJSProperty('open',true);
});
test('a What\'s New that opens over a running download goes under the pop-up; closing it leaves the pop-up up',async({page})=>{
 await page.setViewportSize({width:1280,height:800});await go(page);
 await push(page,{status:'downloading',version:'1.0.18',percent:20});await settle(page);
 await openModal(page);await expect.poll(()=>onTop(page)).toBe(true);
 await push(page,{status:'downloading',version:'1.0.18',percent:50});await expect(page.getByTestId('update-popup')).toContainText('50%');await expect.poll(()=>onTop(page)).toBe(true);
 // Escape in the pop-up closes the pop-up only; What's New stays.
 await page.getByTestId('update-popup').getByRole('button',{name:'Dismiss'}).focus();await page.keyboard.press('Escape');
 await expect(page.getByTestId('update-popup')).toHaveCount(0);await expect(page.locator('dialog[data-fixture-modal]')).toHaveJSProperty('open',true);
 // The sidebar is inert under the window, so focus stays in the window (it has no control here: the window itself).
 await expect(page.locator('dialog[data-fixture-modal]')).toBeFocused();
 await page.evaluate(()=>{const d=document.querySelector('dialog[data-fixture-modal]') as HTMLDialogElement;d.close();d.remove();});
 await push(page,{status:'downloading',version:'1.0.18',percent:80});await expect(page.getByTestId('update-popup')).toHaveCount(0);
 // Closed during the download, it comes back when the update is ready, on top.
 await push(page,{status:'downloaded',version:'1.0.18',installMode:'restart'});await expect(page.getByTestId('update-popup')).toContainText('1.0.18 is ready');await expect.poll(()=>onTop(page)).toBe(true);
});
test('a centred box dialog (shifted with translate, clipped) does not hide or clip the pop-up either',async({page})=>{
 await page.setViewportSize({width:1280,height:800});await go(page);
 await openModal(page,true);await push(page,{status:'downloading',version:'1.0.18',percent:45});
 await expect(page.getByTestId('update-popup')).toContainText('45%');await settle(page);await expect.poll(()=>onTop(page)).toBe(true);
 const popup=await box(page.getByTestId('update-popup'));expect(popup.x).toBeLessThan(320);expect(popup.y+popup.height).toBeGreaterThan(600);
});
test('Dismiss inside a window with a control hands focus to that control, never to the inert sidebar',async({page})=>{
 await page.setViewportSize({width:1280,height:800});await go(page);
 await page.evaluate(()=>{const d=document.createElement('dialog');d.dataset.fixtureModal='';const b=document.createElement('button');b.textContent='Close';b.dataset.testid='fixture-close';d.append('New in 1.0.18',b);document.body.append(d);d.showModal();});
 await push(page,{status:'downloading',version:'1.0.18',percent:30});await settle(page);
 await page.getByTestId('update-popup').getByRole('button',{name:'Dismiss'}).focus();await page.keyboard.press('Enter');
 await expect(page.getByTestId('update-popup')).toHaveCount(0);await expect(page.locator('[data-testid="fixture-close"]')).toBeFocused();
});
for(const key of ['Escape','Enter'])test(`a control that turned disabled while focus was in the pop-up is skipped (${key})`,async({page})=>{
 await page.setViewportSize({width:1280,height:800});await go(page);
 await page.evaluate(()=>{const d=document.createElement('dialog');d.dataset.fixtureModal='';for(const id of ['fixture-close','fixture-next']){const b=document.createElement('button');b.textContent=id;b.dataset.testid=id;d.append(b);}document.body.append(d);d.showModal();});
 await push(page,{status:'downloading',version:'1.0.18',percent:30});await settle(page);
 await page.locator('[data-testid="fixture-close"]').focus();await page.getByTestId('update-popup').getByRole('button',{name:'Dismiss'}).focus();
 await page.evaluate(()=>{(document.querySelector('[data-testid="fixture-close"]') as HTMLButtonElement).disabled=true;});
 await page.keyboard.press(key);
 await expect(page.getByTestId('update-popup')).toHaveCount(0);await expect(page.locator('[data-testid="fixture-next"]')).toBeFocused();
});
test('stays up and working while the window it lives in closes, is removed, and another one opens over it',async({page})=>{
 await page.setViewportSize({width:1280,height:800});await go(page);
 await page.evaluate(()=>{(window as any).installs=0;(window as any).muragebox.updater.install=async()=>{(window as any).installs++;};});
 await openModal(page);await push(page,{status:'downloading',version:'1.0.18',percent:20});await settle(page);await expect.poll(()=>onTop(page)).toBe(true);
 // The window closes with the pop-up still in it: one pop-up, back in the page, still counting.
 await page.evaluate(()=>(document.querySelector('dialog[data-fixture-modal]') as HTMLDialogElement).close());
 await expect(page.getByTestId('update-popup')).toHaveCount(1);await push(page,{status:'downloading',version:'1.0.18',percent:40});await expect(page.getByTestId('update-popup')).toContainText('40%');
 await expect.poll(()=>page.getByTestId('update-popup').evaluate((el:Element)=>el.isConnected&&!el.closest('dialog'))).toBe(true);
 // Opened again, then taken out of the page while open.
 await page.evaluate(()=>(document.querySelector('dialog[data-fixture-modal]') as HTMLDialogElement).showModal());await expect.poll(()=>onTop(page)).toBe(true);
 await page.evaluate(()=>document.querySelector('dialog[data-fixture-modal]')!.remove());
 await expect(page.getByTestId('update-popup')).toHaveCount(1);await push(page,{status:'downloading',version:'1.0.18',percent:60});await expect(page.getByTestId('update-popup')).toContainText('60%');
 // Two windows, the one later in the page opened first: the pop-up follows the one opened last, and back when it closes.
 await page.evaluate(()=>{for(const id of ['a','b']){const d=document.createElement('dialog');d.dataset.fixtureWin=id;d.textContent='win '+id;d.style.cssText='width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0';document.body.append(d);}
  (document.querySelector('dialog[data-fixture-win="b"]') as HTMLDialogElement).showModal();(document.querySelector('dialog[data-fixture-win="a"]') as HTMLDialogElement).showModal();});
 await expect.poll(()=>page.getByTestId('update-popup').evaluate((el:Element)=>(el.closest('dialog') as HTMLElement|null)?.dataset.fixtureWin)).toBe('a');await expect.poll(()=>onTop(page)).toBe(true);
 await page.evaluate(()=>(document.querySelector('dialog[data-fixture-win="a"]') as HTMLDialogElement).close());
 await expect.poll(()=>page.getByTestId('update-popup').evaluate((el:Element)=>(el.closest('dialog') as HTMLElement|null)?.dataset.fixtureWin)).toBe('b');await expect.poll(()=>onTop(page)).toBe(true);
 await push(page,{status:'downloaded',version:'1.0.18',installMode:'restart'});
 await page.getByTestId('update-popup').getByRole('button',{name:'Restart to update'}).click();await expect.poll(()=>page.evaluate(()=>(window as any).installs)).toBe(1);
});
test('a pop-up that came up on the terms screen moves above the sidebar footer once it mounts',async({page})=>{
 await page.setViewportSize({width:1280,height:800});await go(page,'late=1');
 await push(page,{status:'downloading',version:'1.0.18',percent:15});await settle(page);
 await page.evaluate(()=>(window as any).fixtureShowFooter());await expect(page.getByTestId('footer')).toBeVisible();
 await expect.poll(async()=>apart(await box(page.getByTestId('update-popup')),await box(page.getByTestId('footer')))).toBe(true);
});
test('with no window open it stays under a menu, as before',async({page})=>{
 await page.setViewportSize({width:1280,height:800});await go(page);
 await push(page,{status:'downloading',version:'1.0.18',percent:15});await settle(page);
 await expect(page.getByTestId('update-popup')).not.toHaveAttribute('popover',/.*/);
 await page.getByTestId('update-popup').evaluate((el:Element)=>{const r=el.getBoundingClientRect();const m=document.createElement('div');m.style.cssText=`position:fixed;z-index:50;background:#222;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;document.body.append(m);});
 await expect.poll(()=>onTop(page)).toBe(false);
});
test('never shows in the browser or on the phone: no updater bridge',async({page})=>{
 await page.setViewportSize({width:1280,height:800});await go(page,'surface=browser');
 await push(page,{status:'downloading',version:'1.0.12',percent:10});await expect(page.getByTestId('update-popup')).toHaveCount(0);await expect(page.getByTestId('update-indicator')).toHaveCount(0);
});
