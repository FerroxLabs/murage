// SPDX-License-Identifier: AGPL-3.0-or-later
// Real local page/CDP executor regression. No extension or native registration.
import { chromium } from '@playwright/test';
import { BrowserExtensionExecutor } from '../server/browser-extension-executor.ts';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(`${root}artifacts/browser-extension`, { recursive: true });
const run = await mkdtemp(`${root}artifacts/browser-extension/approval-`);
const server = createServer((_req,res) => {res.setHeader('content-type','text/html');res.end(`<!doctype html><html lang="en"><title>Approval fixture</title><body><form onsubmit="event.preventDefault();window.sent++"><label>Recipient<input id="recipient" name="recipient" value="Sarah"></label><label>Message<textarea name="message">Original message</textarea></label><button type="submit" id="send">Send message</button></form><script>window.sent=0</script></body></html>`)});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let context;
const checks=[];
try {
 context=await chromium.launchPersistentContext(`${run}/profile`,{channel:'chromium',headless:true});
 const page=await context.newPage();await page.goto(origin);await page.locator('#send').waitFor();
 const cdp=await context.newCDPSession(page);
 let epoch=1;page.on('framenavigated',frame=>{if(frame===page.mainFrame())epoch++});
 let callback=async()=>true;
 const executor=new BrowserExtensionExecutor({authorize:()=>true,access:async()=>true,admit:action=>callback(action),transport:{document:async()=>({profileId:'fixture',tabId:1,frameId:'main',navigationEpoch:epoch,origin,url:page.url()}),send:(method,params)=>cdp.send(method,params)}});
 callback=async action=>{assert.ok(action.summary.includes('Original message'));assert.ok(action.summary.includes('Sarah'));return true};
 await executor.call('agent_browser_click',{selector:'#send'});
 assert.equal(await page.evaluate(()=>window.sent),1);checks.push('approved_current_content_sent_once');
 await page.evaluate(()=>window.sent=0);
 callback=async()=>{await page.locator('textarea').fill('Changed while approval waited');return true};
 await assert.rejects(executor.call('agent_browser_click',{selector:'#send'}),/target changed/i);
 assert.equal(await page.evaluate(()=>window.sent),0);checks.push('changed_message_refused_before_input');
 callback=async()=>{await page.locator('#recipient').fill('Different recipient');return true};
 await assert.rejects(executor.call('agent_browser_press',{key:'Enter'}),/target changed/i);
 assert.equal(await page.evaluate(()=>window.sent),0);checks.push('changed_recipient_refused_before_enter');
 callback=async()=>true;
 await page.evaluate(()=>{const el=document.createElement('div');el.id='overlay';el.style='position:fixed;inset:0;z-index:999999;background:transparent';el.onclick=()=>window.sent++;document.body.append(el)});
 await assert.rejects(executor.call('agent_browser_click',{selector:'#send'}),/covers the approved target/i);
 assert.equal(await page.evaluate(()=>window.sent),0);checks.push('covering_overlay_receives_no_click');
 await page.screenshot({path:`${run}/overlay-fixture.png`});
 await writeFile(`${run}/receipt.json`,JSON.stringify({status:'PASS',checks,browser:context.browser().version(),limitations:['Direct CDP fixture; not extension/native transport proof','Hit-test prevents an already covering overlay; it is not an atomic browser transaction or a guarantee against arbitrary page event handlers'],run},null,2));
 console.log(JSON.stringify({status:'PASS',checks,run}));
} catch(error) {await writeFile(`${run}/receipt.json`,JSON.stringify({status:'FAIL',checks,error:String(error),run},null,2));throw error}
finally {await context?.close();await new Promise(resolve=>server.close(resolve));await rm(`${run}/profile`,{recursive:true,force:true})}
