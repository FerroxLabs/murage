// Real built app through the supported companion browser door, isolated state.
// Fake engine/browser broker only; no physical phone or native browser proof.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { launchVerificationServer } from './control-murage.ts';
const root=resolve(import.meta.dirname,'..');
const round=Number(process.env.MURAGE_PHONE_ROUND||5);
const output=resolve(root,'../.planning/browser-extension/evidence/phone-ui-r'+round);mkdirSync(output,{recursive:true});
assert(tmpdir().startsWith('/Volumes/Scratch/'),'Set task-owned scratch-volume TMPDIR before launch');
assert(existsSync(join(root,'dist/index.html')),'Built app required');
const registryRoot=mkdtempSync(join(tmpdir(),'phone-registry-'));process.env.MURAGE_COMPANION_DIR=registryRoot;
const {DATA_DIR}=await import('../companion/src/state.ts');
assert.equal(resolve(DATA_DIR),resolve(registryRoot),'Companion state escaped isolated root');
assert(resolve(DATA_DIR).startsWith(resolve(tmpdir())+'/'),'Companion state must be under task temp');
const {createBrowserHandler,cookieName}=await import('../companion/src/browser.ts');
const {DeviceRegistry}=await import('../companion/src/devices.ts');const registry=new DeviceRegistry();assert.equal(registry.list().length,0,'Fixture registry must start empty');
if(process.env.MURAGE_PHONE_PRECHECK==='1'){console.log(JSON.stringify({precheck:'PASS',configuredRoot:registryRoot,actualRegistry:join(DATA_DIR,'devices.json'),count:registry.list().length}));rmSync(registryRoot,{recursive:true,force:true});process.exit(0);}
const launchProof=randomBytes(32).toString('hex');
const testSource=readFileSync(join(root,'server/browser-extension-phone.test.ts'),'utf8');
const instrumentation='process.env.MURAGE_STATIC_DIR='+JSON.stringify(join(root,'dist'))+';\n'+Function('launchProof','return '+testSource.match(/const instrumentation = ([\s\S]+?);\n\nlet fixture/)[1])(launchProof);
let fixture,door,context,page,clientId,threadId,botId,pairedDeviceId;
let owner={},client={},pending=[];
const checks=[],errors=[];
const receipt={round,viewport:{width:390,height:844},checks,errors,limitations:['fake engine and browser broker','no physical phone/mobile WebView/native messaging'],sourceSha256:createHash('sha256').update(testSource).digest('hex'),distIndexSha256:createHash('sha256').update(readFileSync(join(root,'dist/index.html'))).digest('hex')};
async function api(path,body,headers=owner){const r=await fetch(fixture.info.url+path,{method:body===undefined?'GET':'POST',headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,body:await r.json()};}
function dispatch(name,args){const task=api('/api/browser-extension/mcp',{method:'tools/call',params:{name,arguments:args}},client);pending.push(task);return task;}
function inputs(){const p=join(fixture.info.dataDir,'phone-input.jsonl');return existsSync(p)?readFileSync(p,'utf8').trim().split('\n').filter(Boolean).length:0;}
async function shot(name){await page.screenshot({path:join(output,name+'.png'),fullPage:true});}
async function decision(behavior){await expect(page.getByRole('button',{name:behavior==='allow'?'Allow once':'Deny',exact:true})).toBeVisible({timeout:15000});await shot('pending-'+checks.length);const response=page.waitForResponse(r=>r.url().endsWith(`/api/threads/${threadId}/respond`)&&r.request().method()==='POST');await page.getByRole('button',{name:behavior==='allow'?'Allow once':'Deny',exact:true}).click();const r=await response;assert.equal(r.status(),200);await expect(page.getByRole('button',{name:'Allow once',exact:true})).toBeHidden();}
try{
 fixture=await launchVerificationServer({},undefined,{instrumentationSource:instrumentation});
 receipt.fixture={url:fixture.info.url,logPath:fixture.info.logPath};
 const secret=await api('/api/desktop-secret');owner={'x-murage-surface':'desktop','x-murage-surface-secret':secret.body.secret};
 assert.equal((await fetch(fixture.info.url+'/api/config',{method:'PATCH',headers:{...owner,'content-type':'application/json'},body:JSON.stringify({features:{browser:true}})})).status,200);
 const existing=(await api('/api/bots')).body.bots[0];await api(`/api/bots/${existing.id}/browser-extension`,{action:'connect'});await api('/api/browser-extension/clients',{action:'enabled',enabled:true});
 const paired=await api('/api/browser-extension/clients',{action:'pair',label:'Phone approval fixture',profileId:'fixture_profile'});assert.equal(paired.status,201);({clientId,threadId,botId}=paired.body);
 const saved=JSON.parse(readFileSync(paired.body.config.mcpServers['murage-browser'].env.MURAGE_BROWSER_MCP_CONFIG,'utf8'));client={authorization:`Bearer ${saved.token}`,'x-murage-browser-client':saved.clientId};
 door=createServer(createBrowserHandler({harnessPort:Number(new URL(fixture.info.url).port),companionToken:launchProof,identity:()=>({scheme:'http',hosts:new Set(['127.0.0.1'])}),devices:registry,serverName:()=> 'Isolated phone qualification'}));await new Promise(r=>door.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${door.address().port}`;
 context=await chromium.launchPersistentContext(join(tmpdir(),'phone-browser-profile'),{headless:true,viewport:{width:390,height:844},isMobile:true,hasTouch:true});page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url+'/enter');await page.getByLabel('Six-digit code').fill(registry.openPairing().code);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('button',{name:'Open bot list'})).toBeVisible({timeout:30000});const sessionCookie=(await context.cookies(url)).find(c=>c.name===cookieName('http'));assert(sessionCookie);pairedDeviceId=registry.resolveSession(sessionCookie.value)?.device.id;assert(pairedDeviceId,'Current browser cookie must resolve to exact paired device');receipt.pairedDeviceId=pairedDeviceId;checks.push('Actual code-entry page pairs and loads built mobile app');
 await page.getByRole('button',{name:'Open bot list'}).click();const selector=page.locator(`[data-sidebar-select="${botId}"]`);await expect(selector).toBeVisible();await expect(selector).toBeEnabled();await selector.focus();await selector.press("Enter");await expect(page.getByRole("button",{name:"Open bot list"})).toHaveAttribute("aria-expanded","false");await expect(selector).toHaveAttribute("aria-pressed","true");
 const navigating=dispatch('agent_browser_open',{url:'https://fixture.test/'});await decision('allow');assert.equal((await navigating).status,200);checks.push('Visible site approval resolved in actual app through companion');
 const count=inputs();const allowing=dispatch('agent_browser_press',{key:'Enter'});await decision('allow');assert.equal((await allowing).status,200);assert(inputs()>count);checks.push('Visible Allow once dispatches input');
 const count2=inputs();const denying=dispatch('agent_browser_press',{key:'Enter'});await decision('deny');assert.equal((await denying).status,409);assert.equal(inputs(),count2);checks.push('Visible Deny prevents input');
 const blocked=dispatch('agent_browser_press',{key:'Enter'});await expect(page.getByRole('button',{name:'Allow once',exact:true})).toBeVisible();await shot('before-revoke');assert.equal(registry.revoke(pairedDeviceId),true);
 const response=page.waitForResponse(r=>r.url().endsWith(`/api/threads/${threadId}/respond`)&&r.request().method()==='POST');await page.getByRole('button',{name:'Allow once',exact:true}).click();assert.equal((await response).status(),401);assert.equal(inputs(),count2);await shot('revoked');checks.push('Revoked real cookie cannot approve, 401 and no input');
 await api('/api/browser-extension/clients',{action:'revoke',clientId});assert((await blocked).status>=400);receipt.result='PASS';
}catch(e){receipt.result='FAIL';receipt.failure=String(e.stack??e);if(page){await shot('failure').catch(()=>{});writeFileSync(join(output,'failure-body.txt'),await page.locator('body').innerText().catch(()=>''));}process.exitCode=1;}
finally{if(fixture&&clientId)await api('/api/browser-extension/clients',{action:'revoke',clientId}).catch(()=>{});await Promise.allSettled(pending);await context?.close();if(door){door.closeAllConnections();await new Promise(r=>door.close(r));}if(fixture){writeFileSync(join(output,'server.log'),readFileSync(fixture.info.logPath));await fixture.close();}rmSync(registryRoot,{recursive:true,force:true});writeFileSync(join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({result:receipt.result,checks,errors,failure:receipt.failure,output},null,2));}
