import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));cache=mkdtempSync(join(tmpdir(),'murage-telegram-ui-'));
  server=await createServer({configFile:false,root,cacheDir:cache,envFile:false,resolve:{alias:{'@':`${root}/src`}},server:{host:'127.0.0.1',watch:null,hmr:false},plugins:[tailwindcss(),{
    name:'telegram-fixture',resolveId(id){if(id==='/__telegram.js')return '\0fixture-telegram';},load(id){if(id!=='\0fixture-telegram')return;return `import React from 'react';import {createRoot} from 'react-dom/client';import {TelegramSettings} from '/src/components/TelegramSettings.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(TelegramSettings));`;},
    configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/__telegram')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="padding:16px"></div><script type="module" src="/__telegram.js"></script>');});},
  }]});await server.listen(0);const address=server.httpServer!.address();if(!address||typeof address==='string')throw new Error('No fixture port');origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await server?.close();safeWipeSync(cache);});
test('Receiver conflict Retry restores pairing without exposing Retry for other blocked states',async({page},testInfo)=>{
  let state={configured:true,enabled:false,paired:false,pending:0,uncertain:0,connecting:false,requiresRevoke:true,canResume:true,resumeState:'blocked',resumeMessage:'Stop the other receiver, then use Retry now. Your pairing is saved.',error:'conflict' as string|null};
  let retries=0,pairs=0,revokes=0;
  await page.route('**/api/desktop-secret',route=>route.fulfill({json:{secret:'fixture'}}));
  await page.route('**/api/telegram/status',route=>route.fulfill({json:state}));
  await page.route('**/api/telegram/resume',route=>{retries++;state={...state,enabled:true,paired:true,canResume:false,resumeState:'active',resumeMessage:'',error:null};return route.fulfill({json:state});});
  await page.route('**/api/telegram/pair',route=>{pairs++;return route.fulfill({status:409,json:{}});});
  await page.route('**/api/telegram/revoke',route=>{revokes++;return route.fulfill({json:{}});});
  await page.goto(`${origin}/__telegram`);
  for(const width of [390,820,1440]){
    await page.setViewportSize({width,height:1000});
    await expect(page.getByText('Another app is receiving this bot',{exact:true})).toBeVisible();
    const retry=page.getByRole('button',{name:'Retry now',exact:true});await expect(retry).toBeEnabled();
    await expect(page.getByRole('button',{name:'Pair with Chief',exact:true})).toBeDisabled();
    await expect(page.getByLabel('Bot token',{exact:true})).toBeDisabled();
    const box=await retry.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width);
    await page.screenshot({path:testInfo.outputPath(`conflict-retry-${width}.png`),fullPage:true});
  }
  const retry=page.getByRole('button',{name:'Retry now',exact:true});await retry.focus();await expect(retry).toBeFocused();await page.keyboard.press('Enter');
  await expect(page.getByText('Paired',{exact:true})).toBeVisible();await expect(retry).toHaveCount(0);expect(retries).toBe(1);expect(pairs).toBe(0);expect(revokes).toBe(0);
  for(const error of ['auth','forbidden','conflict']){
    state={...state,enabled:false,paired:false,canResume:false,resumeState:'blocked',resumeMessage:'Retry now is not authorised for this saved connection.',error};
    await page.getByRole('button',{name:'Refresh status',exact:true}).click();await expect(retry).toHaveCount(0);
  }
});
test('Telegram token, pairing, refresh and revoke remain deliberate with recoverable failures',async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});
  // pending/uncertain are delivery COUNTS, as the server sends them (server/telegram-channel.ts status()); the status parser refuses a body with booleans there.
  let state={configured:false,enabled:false,paired:false,pending:0,uncertain:0,connecting:false,pairingExpired:false};let pairs=0;let fail=false;let statusReads=0;let revokes=0;
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.route('**/api/desktop-secret',route=>route.fulfill({json:{secret:'fixture'}}));
  await page.route('**/api/config',route=>{state.configured=true;return route.fulfill({json:{}});});
  await page.route('**/api/telegram/status',route=>{statusReads++;return route.fulfill({json:state});});
  await page.route('**/api/telegram/pair',route=>{pairs++;if(fail)return route.fulfill({status:503,json:{error:'private-token-canary'}});state.pending=1;state.enabled=true;return route.fulfill({json:{code:'PAIR1234',expiresAt:Date.now()+60000,username:'FixtureBot',botIdentityId:'123'}});});
  await page.route('**/api/telegram/revoke',route=>{revokes++;state={...state,enabled:false,paired:false,pending:0,pairingExpired:false};return route.fulfill({json:{}});});
  await page.goto(`${origin}/__telegram`);
  await expect(page.getByRole('link',{name:'BotFather',exact:true})).toHaveAttribute('href','https://t.me/BotFather');
  await page.getByLabel('Bot token',{exact:true}).fill('fake-token');await page.getByRole('button',{name:'Save token'}).click();
  await expect(page.getByText('Token saved. Pairing has not started.')).toBeVisible();expect(pairs).toBe(0);
  await page.getByRole('button',{name:'Pair with Chief'}).click();await expect(page.getByText('/pair PAIR1234')).toBeVisible();
  await expect(page.getByRole('link',{name:'Open Telegram bot'})).toHaveAttribute('href','https://t.me/FixtureBot');
  await expect(page.getByLabel('Bot token',{exact:true})).toBeDisabled();
  await expect(page.getByLabel('Bot token',{exact:true})).toHaveValue('');
  await page.getByRole('button',{name:'Copy pairing command'}).click();
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('/pair PAIR1234');
  expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain('PAIR1234');
  state={...state,pairingExpired:true};
  await expect(page.getByText('Pairing expired · create a new code',{exact:true})).toBeVisible();
  await expect(page.getByText('/pair PAIR1234')).toHaveCount(0);
  await page.getByRole('button',{name:'Create new pairing code'}).click();
  await expect(page.getByText('/pair PAIR1234')).toBeVisible();
  expect(revokes).toBe(1);expect(pairs).toBe(2);
  await page.screenshot({path:testInfo.outputPath('telegram-settings-mobile.png'),fullPage:true});
  state={...state,paired:true,pending:0};
  await expect(page.getByText('Paired',{exact:true})).toBeVisible();await expect(page.getByText('/pair PAIR1234')).toHaveCount(0);
  // A saved connection keeps a health poll after pairing (shouldPollTelegramStatus: a paired bot can still be
  // taken by another receiver or have its token rejected), so the settled screen is re-read, not frozen. The
  // spec used to assert the opposite (`expect(statusReads).toBe(readsAfterPair)` after 2.3 s).
  const readsAfterPair=statusReads;await expect.poll(()=>statusReads,{timeout:5000}).toBeGreaterThan(readsAfterPair);
  await expect(page.getByText('Paired',{exact:true})).toBeVisible();await expect(page.getByText('/pair PAIR1234')).toHaveCount(0);
  await page.setViewportSize({width:1000,height:900});
  await page.screenshot({path:testInfo.outputPath('telegram-settings-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'Revoke',exact:true}).click();await expect(page.getByLabel('Bot token',{exact:true})).toBeEnabled();
  fail=true;await page.getByRole('button',{name:'Pair with Chief'}).click();await expect(page.getByRole('alert')).toContainText('could not be completed');
  await expect(page.getByText('private-token-canary')).toHaveCount(0);
});
