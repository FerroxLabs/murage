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
 import{UpdateBanner}from'${root}/src/components/UpdateBanner.tsx';import{UpdateIndicator}from'${root}/src/components/UpdateIndicator.tsx';import{UndoToastHost}from'${root}/src/components/ui/UndoToast.tsx';import{undoHost}from'${root}/src/lib/undo.ts';import './style.css';
 const listeners=new Set();let state={status:'idle'};
 window.fixtureState=(next)=>{state=next;for(const l of listeners)l(next);};window.fixtureUndo=undoHost;
 const q=new URLSearchParams(location.search);
 if(q.get('surface')!=='browser')window.muragebox={updater:{onState:(l)=>{listeners.add(l);l(state);return()=>listeners.delete(l);},download:async()=>{},install:async()=>{},retry:async()=>{},check:async()=>{}}};
 const rail=q.get('rail')==='1';
 createRoot(document.getElementById('root')).render(<div className="flex h-full bg-app text-ink">
  <UpdateBanner/><aside className={(rail?'w-[64px]':'w-[320px]')+' flex h-full shrink-0 flex-col justify-end max-md:hidden'}><div data-update-popup-anchor="" data-testid="footer" className="px-3 pb-3 pt-2" style={rail?{height:170}:{height:68}}><UpdateIndicator/></div></aside>
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
test('never shows in the browser or on the phone: no updater bridge',async({page})=>{
 await page.setViewportSize({width:1280,height:800});await go(page,'surface=browser');
 await push(page,{status:'downloading',version:'1.0.12',percent:10});await expect(page.getByTestId('update-popup')).toHaveCount(0);await expect(page.getByTestId('update-indicator')).toHaveCount(0);
});
