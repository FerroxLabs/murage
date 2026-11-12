// Headless renderer/HTTP proof. The bridge below models window lifetime only;
// native window, display movement and IPC proofs remain the real-OS rows.
import { expect, test } from './page-error-guard';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, readFileSync } from 'node:fs';
import { startHeadlessEngine } from '../../server/drivers/headless-browser-proxy';
let fixture: { info: {url:string;dataDir:string;logPath:string}; fixtureDumpPath: string; close():Promise<void> }, vite: ViteDevServer, origin: string, botId: string, threadId: string, headers: Record<string,string>;
const api = async (method:string, path:string, body?:unknown) => {
  const response = await fetch(fixture.info.url + path, {method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  expect(response.status).toBeLessThan(300); return response.json();
};
test.beforeAll(async () => {
  const {launchVerificationServer} = await import(new URL('../../scripts/control-murage.ts',import.meta.url).href);
  fixture = await launchVerificationServer(process.env, undefined, {instrumentationSource:`
    import {registerHooks} from 'node:module';
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
    const fs=await import('node:fs'),path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const config=JSON.parse(fs.readFileSync(file,'utf8'));config.features={browser:true};fs.writeFileSync(file,JSON.stringify(config));
    const binary=path.join(process.env.MURAGE_DATA_DIR,'fake-agent-browser');fs.writeFileSync(binary,'#!/bin/sh\\nexit 0\\n',{mode:0o755});process.env.MURAGE_AGENT_BROWSER_PATH=binary;
    registerHooks({load(url,context,nextLoad){if(url.endsWith('/browser-native-relay.ts'))return {format:'module',shortCircuit:true,source:\`
      export function createNativeBrowser(){return {connect:async()=>"fixture-stream",protected:async()=>false,request:async(method)=>method==="tools/list"?{tools:[{name:"agent_browser_snapshot",inputSchema:{type:"object",properties:{}}}]}:{content:[]},command:async()=>({}),input:()=>{},resetStream:()=>{},close:async()=>{}}}
    \`};
    if(url.endsWith('/browser-engine.ts')) {
      let source=fs.readFileSync(new URL(url),'utf8');
      // This fixture uses the in-memory native above; it never launches Chrome.
      const guard='if (browserHostRequiresSandboxBypass({';
      if(!source.includes(guard))throw Error('Browser fixture sandbox anchor changed');
      source=source.replace(guard,'if (false && browserHostRequiresSandboxBypass({');
      const start=source.indexOf('export async function verifyAgentBrowserBinary('),end=source.indexOf('export async function ensureChrome(',start);
      if(start<0||end<0)throw Error('Browser fixture version anchor changed');
      return {format:'module-typescript',shortCircuit:true,source:source.slice(0,start)+'export async function verifyAgentBrowserBinary() {}'+String.fromCharCode(10)+source.slice(end)};
    }
    return nextLoad(url,context)}});
  `});
  try {
    const proof=await (await fetch(fixture.info.url+'/api/desktop-secret')).json();headers={'x-murage-surface':'desktop','x-murage-surface-secret':proof.secret};
    const instances=await api('GET','/api/instances');const model=instances.instances.find((item:any)=>item.instanceId==='verification').models.options[0].id;
    const created=await api('POST','/api/bots',{name:'Popout fixture',modelSelection:{instanceId:'verification',model}});botId=created.bot.id;threadId=created.bot.threadId;
    const root=fileURLToPath(new URL('../../',import.meta.url));
    vite=await createServer({configFile:false,root,envFile:false,cacheDir:join(fixture.info.dataDir,'popout-vite'),resolve:{alias:{'@':join(root,'src')}},server:{host:'127.0.0.1',port:0,watch:null,hmr:false,proxy:{'/api':{target:fixture.info.url}}},plugins:[react(),tailwindcss(),{
      name:'popout-fixture',
      transform(source,id){
        // Mutation proof for the regression: mount the old conversation store
        // only inside this isolated renderer, never in the application build.
        if(process.env.S1_STORE_MUTANT==='1' && id.endsWith('/src/components/BrowserPopout.tsx')) return source.replaceAll('BrowserStoreProvider','StoreProvider');
      },
      resolveId(id){if(id==='/__popout.js')return '\0popout-fixture'},load(id){if(id!=='\0popout-fixture')return;return `
        import React from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider,useStore} from '/src/state/store.tsx';import {UnifiedBrowserPanel} from '/src/components/UnifiedBrowserPanel.tsx';import {BrowserPopout} from '/src/components/BrowserPopout.tsx';import {browserPopoutBot} from '/src/lib/use-browser-popout.ts';import '/src/styles.css';
        const botId=${JSON.stringify(botId)};const channel=new BroadcastChannel('popout-fixture');let opened=false,childWindow=null;const listeners=new Set();
        const notify=open=>{opened=open;for(const fn of listeners)fn({botId,open})};channel.onmessage=e=>notify(e.data);
        const cloud=new URLSearchParams(location.search).get('bridge')==='cloud';const desktopBridge={platform:'linux',browserPopout:{currentState:async()=>({available:true,windows:opened?[{botId,open:true}]:[]}),onState:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},open:async()=>{childWindow=window.open('/__popout?surface=browser-popout&bridge='+(cloud?'cloud':'local')+'&bot='+botId);notify(true);channel.postMessage(true);return true},close:async()=>{childWindow?.close();notify(false);channel.postMessage(false);return true}}};
        if(cloud)window.muragecloud={...desktopBridge,homeId:'fixture-home'};else window.muragebox=desktopBridge;
        if(location.search.includes('surface=browser-popout')) {addEventListener('pagehide',()=>channel.postMessage(false));channel.addEventListener('message',e=>{if(!e.data)window.close()})}
        function Panel(){const {state}=useStore();const bot=state.bots.find(b=>b.id===botId);return bot?React.createElement(UnifiedBrowserPanel,{bot,size:'expanded'}):null}
        createRoot(document.getElementById('root')).render(browserPopoutBot(location.search,Boolean(window.muragebox)||Boolean(window.muragecloud?.browserPopout))?React.createElement(BrowserPopout,{botId}):React.createElement(StoreProvider,null,React.createElement(Panel)));
      `},configureServer(server){server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith('/__popout')||req.url.startsWith('/__popout.js'))return next();res.setHeader('content-type','text/html');res.end('<div id="root" style="max-width:1100px;margin:auto;height:100dvh;overflow-y:auto"></div><script type="module" src="/__popout.js"></script>')})}
    }]});await vite.listen(0);const address=vite.httpServer!.address();if(!address||typeof address==='string')throw Error('No fixture port');origin=`http://127.0.0.1:${address.port}`;
  } catch(error){await vite?.close();await fixture.close();throw error}
});
test.afterAll(async()=>{
  try { await vite?.close(); }
  finally {
    try { await fixture?.close(); }
    finally { if (fixture) copyFileSync(fixture.info.logPath, test.info().outputPath('server.log')); }
  }
});
for(const bridgeKind of ['local','cloud']) {
test(bridgeKind+' take in pop-out, Hand back in panel; closing retains the hold; Bring back closes the view',async({page,context})=>{
  const initial = await api('GET',`/api/bots/${botId}/browser`);
  if (initial.held) await api('POST',`/api/bots/${botId}/browser`,{action:'release',generation:initial.generation,control:initial.control});
  await context.setExtraHTTPHeaders(headers);await page.goto(origin+'/__popout?bridge='+bridgeKind);
  const popupPromise=page.waitForEvent('popup');await page.getByRole('button',{name:'Pop out view',exact:true}).click();const popup=await popupPromise;
  await popup.setViewportSize({width:390,height:400});
  await expect(popup.getByRole('button',{name:'Take control',exact:true})).toBeInViewport();
  await popup.getByRole('button',{name:'Take control',exact:true}).click();
  await expect(popup.getByRole('button',{name:'Hand back',exact:true})).toBeEnabled();
  await expect(popup.getByRole('button',{name:'Hand back',exact:true})).toBeInViewport({ratio:1});
  await popup.screenshot({path:test.info().outputPath('popout-held.png'),fullPage:true});
  await page.screenshot({path:test.info().outputPath('panel-bring-back.png'),fullPage:true});
  await page.getByRole('button',{name:'Hand back',exact:true}).click();
  expect((await api('GET',`/api/bots/${botId}/browser`)).held).toBe(false);
  await popup.getByRole('button',{name:'Take control',exact:true}).click();
  await expect(popup.getByRole('button',{name:'Hand back',exact:true})).toBeEnabled();
  await popup.close();
  expect((await api('GET',`/api/bots/${botId}/browser`)).held).toBe(true);
  // Use the real mounted bot proxy after the view closed, with only the
  // browser engine faked. A stream closing must not authorize a bot read.
  await api('POST',`/api/bots/${botId}/messages`,{threadId,text:'__fixture_hold_authority__ popout-hold-proof-'+bridgeKind});
  const dump=()=>{try{return JSON.parse(readFileSync(fixture.fixtureDumpPath,'utf8'))}catch{return null}};
  await expect.poll(()=>JSON.stringify(dump()?.prompt ?? ''),{timeout:20_000}).toContain('popout-hold-proof-'+bridgeKind);
  const mounted=dump()?.mcpConfig?.mcpServers?.browser;
  expect(mounted).toBeTruthy();
  const client=startHeadlessEngine({...mounted,env:{...process.env,...mounted.env}});
  try {
    await client.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'popout-fixture',version:'1'}});
    expect(await client.request('tools/call',{name:'agent_browser_snapshot',arguments:{}})).toMatchObject({isError:true,code:'browser_held'});
  } finally {await client.close();await api('POST',`/api/bots/${botId}/interrupt`,{threadId});}
  const nextPromise=page.waitForEvent('popup');await page.getByRole('button',{name:'Pop out view',exact:true}).click();const next=await nextPromise;
  await page.getByRole('button',{name:'Bring back',exact:true}).click();await expect.poll(()=>next.isClosed()).toBe(true);
  expect((await api('GET',`/api/bots/${botId}/browser`)).held).toBe(true);
});

test(bridgeKind+' a browser pop-out never restores a room or acknowledges its unseen messages', async ({page, context}) => {
  await context.setExtraHTTPHeaders(headers);
  const {group} = await api('POST','/api/groups',{name:'Unseen room',memberIds:[botId]});
  const writes: string[] = [], reads: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'POST') writes.push(url.pathname);
    if (request.method() === 'GET') reads.push(url.pathname + url.search);
  });
  await page.addInitScript((groupId: string) => {
    localStorage.setItem('murage.lastConversation.v1:local', groupId);
    const Original = window.EventSource;
    (window as any).fixtureStreams = [];
    window.EventSource = class extends Original {
      constructor(url: string | URL, options?: EventSourceInit) { super(url, options); (window as any).fixtureStreams.push(this); }
    };
  }, group.id);
  await page.route('**/api/setup?peek=1', route => route.fulfill({json:{firstRun:false}}));
  await page.goto(origin + '/__popout?surface=browser-popout&bridge='+bridgeKind+'&bot=' + botId);
  await expect(page.getByRole('button',{name:/^(Take control|Hand back)$/})).toBeEnabled();
  // The main window now displays a different conversation. A room stream
  // announcement must not count as a displayed room in this window.
  await page.evaluate((groupId: string) => {
    localStorage.setItem('murage.lastConversation.v1:local','another-conversation');
    for (const stream of (window as any).fixtureStreams) stream.onmessage?.(new MessageEvent('message', {data:JSON.stringify({kind:'group',group:{id:groupId,unread:true}})}));
  }, group.id);
  await page.waitForTimeout(100);
  expect(writes.filter(path => path.endsWith('/read'))).toEqual([]);
  expect(reads).not.toContain('/api/bots?view=sidebar');
  expect(await page.evaluate(() => localStorage.getItem('murage.lastConversation.v1:local'))).toBe('another-conversation');
});

test(bridgeKind+' a refused pop-out load keeps the live view and its primary control in the tab', async ({page,context}) => {
  await context.setExtraHTTPHeaders(headers);
  await page.goto(origin+'/__popout?bridge='+bridgeKind);
  await expect(page.getByRole('button',{name:'Pop out view',exact:true})).toBeEnabled();
  await page.evaluate(() => { (window.muragebox?.browserPopout ?? window.muragecloud?.browserPopout)!.open = async () => { throw Error('fixture load refused'); }; });
  await page.getByRole('button',{name:'Pop out view',exact:true}).click();
  await expect(page.getByText('Your live view is here. Try Pop out view again.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Bring back',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:/^(Take control|Hand back)$/})).toBeEnabled();
  await expect(page.getByRole('button',{name:'Pop out view',exact:true})).toBeEnabled();
});

}
