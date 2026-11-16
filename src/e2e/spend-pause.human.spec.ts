// SPDX-License-Identifier: AGPL-3.0-or-later
// Actual Usage and composer components, real isolated control launcher, fake
// Flux account figures. No provider request or installed application is used.
import { test, expect } from './page-error-guard';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { evidenceRoot } from './evidence';
let fixture: any, vite: ViteDevServer, origin: string;
const actions: unknown[] = [];
const proofHeaders: Record<string,string> = {};
async function api(path: string, method = 'GET', input?: unknown) {
 const response = await fetch(fixture.info.url + path, {method,headers:{...proofHeaders,'content-type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});
 const body = await response.json();expect(response.ok,`${method} ${path}`).toBe(true);
 if(path!=='/api/desktop-secret') actions.push({path,method,input,status:response.status,body});
 return body;
}
test.beforeAll(async()=>{
 const {launchVerificationServer} = await import(new URL('../../scripts/control-murage.ts',import.meta.url).href);
 fixture = await launchVerificationServer(process.env,undefined,{qualifySpendPause:true,instrumentationSource:`
 const fs=await import('node:fs'),path=await import('node:path');
 const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
 cfg.flux={apiKey:'sk-flux-gap-spend-fixture-000000000000'};cfg.spend={monthlyLimitUsd:100};fs.writeFileSync(file,JSON.stringify(cfg));
 const state=path.join(process.env.MURAGE_DATA_DIR,'pause-fixture.json');fs.writeFileSync(state,JSON.stringify({spent:100,fail:false}));
 let seq=0;const original=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 if(url.hostname==='api.fluxrouter.ai'||url.hostname==='fluxrouter.ai'){
 if(url.pathname==='/v1/key/limits'){const row=JSON.parse(fs.readFileSync(state,'utf8'));if(row.fail)return Response.json({error:'fixture unreadable'},{status:503});const stamp=new Date(Date.UTC(2026,10,13,12,0,++seq)).toISOString();return Response.json({key_id:'fixture-key',key_monthly_budget_usd:null,key_monthly_token_limit:null,spent_usd_this_month:1,tokens_this_month:0,spend_basis:'customer_billed_sale',resets_at:'2026-12-01T00:00:00Z',as_of:stamp,account_id:'fixture-account',month:'2026-11',account_spent_usd_this_month:row.spent,account_as_of:stamp});}
 if(url.pathname.endsWith('/models'))return Response.json({data:[{id:'flux-fast',object:'model',owned_by:'fixture'}]});return Response.json({error:'fixture only'},{status:404});}
 if(url.hostname==='127.0.0.1'||url.hostname==='localhost')return original(input,init);throw Error('external request refused by spending fixture');};
 `});
 try {
 const proof=await api('/api/desktop-secret');Object.assign(proofHeaders,{'x-murage-surface':'desktop','x-murage-surface-secret':proof.secret});await api('/api/spend/check','POST',{});
 // The app owns a scrolling content pane; its global body stays clipped.
 // Give the isolated component fixture that same pane, including on narrow screens.
 const root=fileURLToPath(new URL('../../',import.meta.url));
 vite=await createServer({configFile:false,root,envFile:false,cacheDir:join(fixture.info.dataDir,'ui-cache'),resolve:{alias:{'@':join(root,'src')}},plugins:[react(),tailwindcss(),{name:'spend-ui-fixture',resolveId(id){if(id==='/__spend.js')return '\0spend-ui-fixture';},load(id){if(id!=='\0spend-ui-fixture')return;return `import React from 'react';import{createRoot}from'react-dom/client';import{StoreProvider}from'/src/state/store.tsx';import{SpendLimitCard}from'/src/components/SpendLimitCard.tsx';import{ComposerSpendPause}from'/src/components/SpendPauseCard.tsx';import'/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,React.createElement('main',{className:'mx-auto h-screen max-w-3xl overflow-y-auto p-8 space-y-6'},React.createElement('h1',{className:'text-xl font-semibold text-ink'},'Usage'),React.createElement(SpendLimitCard),React.createElement('h2',{className:'text-lg font-semibold text-ink'},'Conversation'),React.createElement(ComposerSpendPause,{model:'flux-fast',onOpenUsage:()=>document.querySelector('[data-setting-control="spend-limit-heading"]').focus()}))));`;},configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/__spend')return next();res.setHeader('content-type','text/html');res.end('<html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__spend.js"></script></body></html>');});}}],server:{host:'127.0.0.1',watch:null,hmr:false,proxy:{'/api':{target:fixture.info.url}}}});
 await vite.listen(0);const address=vite.httpServer!.address();if(!address||typeof address==='string')throw Error('UI fixture did not listen');origin=`http://127.0.0.1:${address.port}`;
 }catch(error){await vite?.close();await fixture.close();throw error;}
});
test.afterAll(async()=>{try{await vite?.close();if(fixture){const dir=join(evidenceRoot('spend-pause'),'spend-ui');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'actions.json'),JSON.stringify({fixture:fixture.info,actions},null,2));writeFileSync(join(dir,'server.log'),readFileSync(fixture.info.logPath));}}finally{await fixture?.close();}});
test('the owner reads the pause promise, raises the limit, and rechecks an unreadable figure',async({page})=>{
 const dir=join(evidenceRoot('spend-pause'),'spend-ui');mkdirSync(dir,{recursive:true});
 await page.goto(origin+'/__spend');
 await expect(page.getByText('You reached your $100 monthly limit.',{exact:true}).first()).toBeVisible();
 await expect(page.locator('[data-spend-pause]')).toHaveCount(2);
 await expect(page.getByTestId('spend-month')).toHaveText('Account spend through Flux Router this month: $100');
 await page.getByText('How the limit works',{exact:true}).click();
 await expect(page.getByText(/can take up to 5 minutes/)).toBeVisible();
 await page.screenshot({path:join(dir,'01-limit-and-promise.png'),fullPage:true});writeFileSync(join(dir,'01-visible-copy.txt'),await page.locator('body').innerText());
 const input=page.getByRole('textbox',{name:'Monthly limit in dollars'});
 await page.getByRole('button',{name:'Raise limit',exact:true}).last().click();await expect(input).toBeFocused();
 await input.fill('200');await page.getByRole('button',{name:'Save limit',exact:true}).click();
 await expect(page.locator('[data-spend-pause]')).toHaveCount(0);
 expect((await api('/api/spend')).pause.limitUsd).toBe(200);
 await page.screenshot({path:join(dir,'02-raised-and-resumed.png'),fullPage:true});
 writeFileSync(join(fixture.info.dataDir,'pause-fixture.json'),JSON.stringify({spent:100,fail:true}));await api('/api/spend/check','POST',{});await page.reload();
 await expect(page.getByText("Murage cannot read Flux Router's figure right now.",{exact:true}).first()).toBeVisible();
 await page.screenshot({path:join(dir,'03-unreadable-figure.png'),fullPage:true});writeFileSync(join(dir,'03-visible-copy.txt'),await page.locator('body').innerText());
 writeFileSync(join(fixture.info.dataDir,'pause-fixture.json'),JSON.stringify({spent:100,fail:false}));
 await page.getByRole('button',{name:'Check again',exact:true}).first().click();await expect(page.locator('[data-spend-pause]')).toHaveCount(0);
 await page.screenshot({path:join(dir,'04-check-recovered.png'),fullPage:true});
});
