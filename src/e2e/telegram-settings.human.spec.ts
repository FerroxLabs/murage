import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));cache=mkdtempSync(join(tmpdir(),'murage-telegram-ui-'));
  server=await createServer({configFile:false,root,cacheDir:cache,envFile:false,resolve:{alias:{'@':`${root}/src`}},server:{host:'127.0.0.1',watch:null,hmr:false},plugins:[tailwindcss(),{
    name:'telegram-fixture',resolveId(id){if(id==='/__telegram.js')return '\0fixture-telegram';},load(id){if(id!=='\0fixture-telegram')return;return `import React from 'react';import {createRoot} from 'react-dom/client';import {TelegramSettings} from '/src/components/TelegramSettings.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(TelegramSettings));`;},
    configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/__telegram')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="padding:16px"></div><script type="module" src="/__telegram.js"></script>');});},
  }]});await server.listen(0);const address=server.httpServer!.address();if(!address||typeof address==='string')throw new Error('No fixture port');origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await server?.close();rmSync(cache,{recursive:true,force:true});});
test('Telegram token, pairing, refresh and revoke remain deliberate with recoverable failures',async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});
  let state={configured:false,enabled:false,paired:false,pending:false,uncertain:false,connecting:false,pairingExpired:false};let pairs=0;let fail=false;let statusReads=0;let revokes=0;
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.route('**/api/desktop-secret',route=>route.fulfill({json:{secret:'fixture'}}));
  await page.route('**/api/config',route=>{state.configured=true;return route.fulfill({json:{}});});
  await page.route('**/api/telegram/status',route=>{statusReads++;return route.fulfill({json:state});});
  await page.route('**/api/telegram/pair',route=>{pairs++;if(fail)return route.fulfill({status:503,json:{error:'private-token-canary'}});state.pending=true;state.enabled=true;return route.fulfill({json:{code:'PAIR1234',expiresAt:Date.now()+60000,username:'FixtureBot',botIdentityId:'123'}});});
  await page.route('**/api/telegram/revoke',route=>{revokes++;state={...state,enabled:false,paired:false,pending:false,pairingExpired:false};return route.fulfill({json:{}});});
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
  state={...state,paired:true,pending:false};
  await expect(page.getByText('Paired',{exact:true})).toBeVisible();await expect(page.getByText('/pair PAIR1234')).toHaveCount(0);
  const readsAfterPair=statusReads;await page.waitForTimeout(2300);expect(statusReads).toBe(readsAfterPair);
  await page.setViewportSize({width:1000,height:900});
  await page.screenshot({path:testInfo.outputPath('telegram-settings-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'Revoke',exact:true}).click();await expect(page.getByLabel('Bot token',{exact:true})).toBeEnabled();
  fail=true;await page.getByRole('button',{name:'Pair with Chief'}).click();await expect(page.getByRole('alert')).toContainText('could not be completed');
  await expect(page.getByText('private-token-canary')).toHaveCount(0);
});
