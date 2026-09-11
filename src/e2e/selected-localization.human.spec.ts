import {test,expect} from '@playwright/test';
import {build} from 'vite';
import tailwindcss from '@tailwindcss/vite';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,mkdtempSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
const root=fileURLToPath(new URL('../../',import.meta.url));let scratch='',server:any,origin='';
const name='<Mira & team>';
test.beforeAll(async()=>{
 scratch=realpathSync(mkdtempSync(join(tmpdir(),'murage-selected-locales-')));
 writeFileSync(join(scratch,'index.html'),'<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/entry.tsx"></script>');
 writeFileSync(join(scratch,'style.css'),readFileSync(join(root,'src/styles.css'),'utf8').replace('@import "tailwindcss";',`@import "${root}/node_modules/tailwindcss/index.css" source(none);\n@source "${root}/src";\n@source "./entry.tsx";`));
 writeFileSync(join(scratch,'entry.tsx'),`
 import React from '${root}/node_modules/react/index.js';import{createRoot}from'${root}/node_modules/react-dom/client.js';
 import{EngineSetup}from'${root}/src/components/EngineSetup.tsx';import{UpdateBanner}from'${root}/src/components/UpdateBanner.tsx';import{UpdatesRow}from'${root}/src/components/SettingsModal.tsx';import{CallTargetButton}from'${root}/src/components/CallView.tsx';import{setLocale}from'${root}/src/lib/i18n.ts';import './style.css';
 const q=new URLSearchParams(location.search);setLocale(q.get('lang')||'en');window.fixtureCalls={terminal:0,retry:0,download:0};window.fixtureInstance={instanceId:'fixture',driverKind:'claudeAgent',displayName:'Claude',snapshot:{state:'available',authenticated:false},install:{command:{win32:'fixture install'},signInCommand:'claude auth login'}};
 const listeners=new Set();let state={status:'available',version:'2.0.0',installMode:'restart'};window.fixtureEmit=next=>{state=next;for(const cb of listeners)cb(next);};window.muragebox={platform:'win32',speechStart:async()=>{},openEngineSetupTerminal:async()=>{window.fixtureCalls.terminal++;return true;},updater:{onState:cb=>{listeners.add(cb);cb(state);return()=>listeners.delete(cb);},download:async()=>{window.fixtureCalls.download++;window.fixtureEmit({status:'downloaded',version:'2.0.0'});},check:async()=>{},install:async()=>{},retry:async()=>{window.fixtureCalls.retry++;}}};
 createRoot(document.getElementById('root')).render(<main className="min-h-screen bg-app p-4 pb-64 text-ink"><section data-testid="setup" className="max-w-lg"><EngineSetup instance={window.fixtureInstance} authRequired/></section><section data-testid="settings" className="mt-4 max-w-lg"><UpdatesRow/></section><section data-testid="call" className="mt-4"><CallTargetButton targetId="fixture" targetName=${JSON.stringify(name)} voices={['fixture-voice']} requireExplicitVoices={false} onStart={()=>{}}/></section><section data-testid="banner"><UpdateBanner/></section></main>);
 `);
 await build({configFile:false,root:scratch,envFile:false,resolve:{alias:{'@':join(root,'src'),react:join(root,'node_modules/react'), 'react-dom':join(root,'node_modules/react-dom')}},esbuild:{jsx:'automatic'},build:{outDir:join(scratch,'dist'),emptyOutDir:true},plugins:[tailwindcss(),{name:'selected-locale-fixture',enforce:'pre',resolveId(id){if(id==='@/state/store'||id.endsWith('/src/state/store'))return '\0locale-store';if(id==='./DesktopCapabilities')return '\0locale-capabilities';},load(id){if(id==='\0locale-store')return `export * from '${root}/src/state/store.tsx';export const useStore=()=>({state:{config:{tts:{configured:true,ready:true}}},dispatch:()=>{}});export const api=async()=>({instances:[window.fixtureInstance]});`;if(id==='\0locale-capabilities')return 'export const useDesktopCapabilities=()=>({ready:true,capabilities:{dictation:{available:true}}});';}}]});
 server=createServer((req,res)=>{const pathname=new URL(req.url??'/','http://fixture').pathname;const file=pathname==='/'?'index.html':pathname.slice(1);if(file.includes('..')){res.statusCode=400;return res.end();}try{res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(readFileSync(join(scratch,'dist',file)));}catch{res.statusCode=404;res.end();}});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async()=>{await new Promise<void>(resolve=>server?server.close(()=>resolve()):resolve());if(scratch)safeWipeSync(scratch);});
for(const locale of ['en','de','es','fr','hi','ja','pt-br','zh'])test('selected setup, update and call controls: '+locale,async({page},info)=>{
 test.skip(info.project.name==='desktop'&&locale!=='en'||info.project.name==='mobile'&&locale==='en','one matching viewport per locale');
 const pack=JSON.parse(readFileSync(join(root,'src/locales',locale+'.json'),'utf8'));
 await page.setViewportSize(locale==='en'?{width:1280,height:900}:{width:390,height:844});await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());await page.goto(origin+'/?lang='+locale);
 const setup=page.getByTestId('setup'),settings=page.getByTestId('settings'),banner=page.getByTestId('banner');
 await expect(setup.getByRole('button',{name:pack['setup.copyCommand'],exact:true})).toBeVisible();
 await setup.getByRole('button',{name:pack['setup.openSignIn'],exact:true}).press('Enter');await expect(setup.getByRole('button',{name:pack['setup.terminalOpened'],exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as any).fixtureCalls.terminal)).toBe(1);
 await expect(settings.getByText(pack['updates.title'],{exact:true})).toBeVisible();await settings.getByRole('button',{name:pack['updates.download'],exact:true}).click();await expect(banner.getByRole('button',{name:pack['updates.restart'],exact:true})).toBeVisible();
 await expect(page.getByTestId('call').getByRole('button',{name:pack['calls.call'].replace('{name}',name),exact:true})).toBeVisible();expect(await page.locator('mira').count()).toBe(0);
 await page.evaluate(()=>(window as any).fixtureEmit({status:'error',version:'2.0.0',message:'Fixture interruption'}));await banner.getByRole('button',{name:pack['updates.retry'],exact:true}).click();expect(await page.evaluate(()=>(window as any).fixtureCalls.retry)).toBe(1);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 if(['en','de','hi','ja'].includes(locale))await page.screenshot({path:info.outputPath('selected-'+locale+'.png'),fullPage:true,animations:'disabled'});
});
