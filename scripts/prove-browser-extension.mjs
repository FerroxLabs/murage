// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated Chromium proof: real extension APIs and debugger, injected fixture transport.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, mkdtemp, cp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute, sep, join } from 'node:path';
import { createHash } from 'node:crypto';
// The extension declares minimum_chrome_version; Playwright's bundled Chromium
// can be older. MURAGE_PROVE_BROWSER_EXECUTABLE names an existing read-only
// Chromium or Chrome for Testing binary to prove against instead.
// Branded Chrome (137 and later) ignores --load-extension, so there the proof loads
// the unpacked extension through the browser's Extensions.loadUnpacked command,
// which needs --enable-unsafe-extension-debugging. Chrome for Testing and Chromium
// honour the flag and keep it. Chosen from the executable; MURAGE_PROVE_EXTENSION_LOADER
// (flag or cdp) overrides the choice.
const isBrandedChrome = executable => /Google Chrome(?! for Testing)|google-chrome|[\\/]Google[\\/]Chrome[\\/]Application[\\/]/.test(executable ?? '');
const extensionLoader = () => {
  const forced = process.env.MURAGE_PROVE_EXTENSION_LOADER;
  if (forced !== undefined) { assert.ok(forced === 'flag' || forced === 'cdp', 'MURAGE_PROVE_EXTENSION_LOADER must be flag or cdp'); return forced; }
  return isBrandedChrome(process.env.MURAGE_PROVE_BROWSER_EXECUTABLE) ? 'cdp' : 'flag';
};
const proveBrowser = () => process.env.MURAGE_PROVE_BROWSER_EXECUTABLE ? { executablePath: process.env.MURAGE_PROVE_BROWSER_EXECUTABLE } : { channel: 'chromium' };
// Fail before importing application modules or starting a browser. The launcher
// must supply HOME/USERPROFILE/TMP/companion isolation externally, not after import.
const scratch = await realpath(tmpdir());
// On the Mac the scratch folder must be on the scratch volume; a test VM names its own root (QA_SCRATCH).
assert.ok(scratch.startsWith(process.env.QA_SCRATCH ?? '/Volumes/Scratch/'), 'Task TMPDIR must be on the scratch volume (or under QA_SCRATCH)');
for (const key of ['HOME','USERPROFILE','MURAGE_COMPANION_DIR']) {
  assert.ok(process.env[key], `Externally set ${key} before launching`);
  const child = relative(scratch, resolve(process.env[key]));
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), `${key} must be inside task TMPDIR`);
}
const pinnedEngine=process.env.QA_PINNED_ENGINE??'/Volumes/Scratch/work/murage-0157/dist-native/browser/darwin-arm64/agent-browser';
assert.equal(process.env.MURAGE_AGENT_BROWSER_PATH,pinnedEngine,'Set the exact pinned engine path externally before imports');
const { createBrowserExtensionService } = await import('../server/browser-extension-service.ts');
const root = fileURLToPath(new URL('../', import.meta.url));
const out = `${root}artifacts/browser-extension`;
await mkdir(out, { recursive: true });
const run = await mkdtemp(`${out}/chromium-`);
const extension = `${run}/extension`;
const profile = await mkdtemp(`${scratch}/chromium-profile-`);
assert.ok((await realpath(profile)).startsWith(scratch+sep));
await cp(`${root}dist-browser-extension`, extension, { recursive: true });
// Test-only worker: production native port is not opened or registered.
await build({ stdin: { contents: `import {createBrowserExtensionRuntime} from ${JSON.stringify(`${root}extensions/murage-browser/runtime.mjs`)};
globalThis.fixtureEvents=[];
globalThis.fixtureLifecycle={phase:'module-loaded',at:Date.now()};
const fixturePhase=(phase,error)=>{const value={phase,at:Date.now(),...(error?{error:{name:String(error.name??'Error'),message:String(error.message??error).slice(0,1000)}}:{})};globalThis.fixtureLifecycle=value;console.info('MURAGE_FIXTURE_LIFECYCLE '+JSON.stringify(value));};
const runtime=createBrowserExtensionRuntime(chrome,{emit:event=>globalThis.fixtureEvents.push(event)});
globalThis.fixtureWire={nonce:crypto.randomUUID().replaceAll('-',''),sequence:0};
globalThis.fixtureBrokerRequest=async message=>{const wireId=globalThis.fixtureWire.nonce+'_'+(++globalThis.fixtureWire.sequence);const response=await runtime.handleRequest({...message,id:wireId});if(response.id!==wireId)throw Error('Fixture broker response identity mismatch');return {...response,id:message.id};};
globalThis.fixtureReconnect=async()=>{await runtime.connection(false);const hello=await runtime.connection(true);globalThis.fixtureWire={nonce:crypto.randomUUID().replaceAll('-',''),sequence:0};return hello;};
void(async()=>{try{fixturePhase('initialize-start');await runtime.initialize();fixturePhase('initialize-complete');globalThis.fixtureHello=await runtime.connection(true);fixturePhase('connection-complete');globalThis.fixture=runtime;fixturePhase('ready');}catch(error){fixturePhase('failed',error);throw error;}})();
for(const e of [chrome.webNavigation.onCommitted,chrome.webNavigation.onHistoryStateUpdated,chrome.webNavigation.onReferenceFragmentUpdated]) e.addListener(d=>void runtime.navigation(d));
chrome.debugger.onEvent.addListener((source,method,params)=>void runtime.debuggerEvent(source,method,params));
chrome.debugger.onDetach.addListener(source=>void runtime.detached(source.tabId));
chrome.tabs.onRemoved.addListener(tabId=>void runtime.removed(tabId));
chrome.runtime.onMessage.addListener((m,s,reply)=>{ if(s.id!==chrome.runtime.id || s.url!==chrome.runtime.getURL('sidepanel/index.html')) return false; runtime.handlePanel(m).then(result=>reply({result}),e=>reply({error:e.code})); return true; });`, resolveDir: root, sourcefile: 'fixture-worker.mjs' }, outfile: `${extension}/service-worker.js`, bundle: true, format: 'esm', platform: 'browser', target: 'chrome120' });
const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); if (req.url === '/login') res.setHeader('set-cookie', 'fixture_login=yes; HttpOnly; SameSite=Lax'); res.end('<!doctype html><html lang="en"><title>Owned fixture</title><body><h1>Local browser fixture</h1><label>Name <input id="name"></label><button id="save" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Save</button><p id="result"></p></body></html>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context, worker, service, eventPump, draining, pumpError;
let eventCursor=0, pumpStopped=false;
let drainEvents=async()=>{};
const checks = [];
try {
  const loader = extensionLoader();
  const logArgs = ['--enable-logging', `--log-file=${run}/chromium.log`];
  context = await chromium.launchPersistentContext(profile, { ...proveBrowser(), headless: true, viewport: { width: 390, height: 900 },
    ...(loader === 'cdp' ? { ignoreDefaultArgs: ['--disable-extensions'], args: [...logArgs, '--enable-unsafe-extension-debugging'] }
      : { args: [...logArgs, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] }) });
  if (loader === 'cdp') { const browserSession = await context.browser().newBrowserCDPSession(); await browserSession.send('Extensions.loadUnpacked', { path: extension }); await browserSession.detach(); }
  context.setDefaultTimeout(10000);
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  for (let attempt = 0; attempt < 100 && !(await worker.evaluate(() => Boolean(globalThis.fixture))); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  const extensionId = new URL(worker.url()).host;
  const extensionInspector=await context.newPage();await extensionInspector.goto('chrome://extensions/');
  await extensionInspector.waitForFunction(()=>Boolean(globalThis.chrome?.developerPrivate?.getProfileConfiguration));
  let profileConfiguration=await extensionInspector.evaluate(()=>chrome.developerPrivate.getProfileConfiguration());
  await writeFile(`${run}/developer-profile-before.json`,JSON.stringify(profileConfiguration,null,2));
  if(!profileConfiguration.inDeveloperMode){
    assert.notEqual(profileConfiguration.isDeveloperModeControlledByPolicy,true,'Do not override browser policy');
    assert.notEqual(profileConfiguration.isChildAccount,true,'Do not alter child-account restrictions');
    await extensionInspector.evaluate(()=>new Promise((resolve,reject)=>chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true},()=>{
      const error=chrome.runtime.lastError;if(error)reject(Error(error.message));else resolve();
    })));
  }
  profileConfiguration=await extensionInspector.evaluate(()=>chrome.developerPrivate.getProfileConfiguration());
  await writeFile(`${run}/developer-profile-after.json`,JSON.stringify(profileConfiguration,null,2));
  assert.equal(profileConfiguration.inDeveloperMode,true,'Unpacked reload requires the isolated developer profile');
  const extensionInfo=()=>extensionInspector.evaluate(async id=>{
    const info=(await chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true})).find(item=>item.id===id);
    if(!info)return null;
    return {id:info.id,path:info.path,location:info.location,state:info.state,disableReasons:info.disableReasons,manifestErrors:info.manifestErrors,runtimeErrors:info.runtimeErrors};
  },extensionId);
  await writeFile(`${run}/extension-registration-before.json`,JSON.stringify({inDeveloperMode:profileConfiguration.inDeveloperMode,extension:await extensionInfo()},null,2));
  const hello = await worker.evaluate(() => globalThis.fixtureHello);
  const profileId=hello.profileId;
  const broker={profiles:()=>[hello],request:async(requestedProfile,message)=>{assert.equal(requestedProfile,profileId);return worker.evaluate(message=>globalThis.fixtureBrokerRequest(message),message);}};
  const stateDir=await mkdtemp(join(scratch,'engine-state-'));
  // Service derives the engine's data root as dirname(dirname(stateFile)).
  const stateFile=join(stateDir,'private','browser-extension.json');
  service=await createBrowserExtensionService({broker,workspaceId:'runtime_proof',stateFile,askSite:async()=> 'allow',askAction:async()=>true});
  drainEvents=async()=>{
    if(draining)return draining;
    draining=(async()=>{
      while(true){const events=await worker.evaluate(cursor=>globalThis.fixtureEvents.slice(cursor),eventCursor);if(!events.length)break;eventCursor+=events.length;for(const event of events)await service.handleMessage(profileId,event);}
    })();
    try{await draining;}finally{draining=undefined;}
  };
  eventPump=setInterval(()=>{if(!pumpStopped)void drainEvents().catch(error=>{pumpError??=error;});},10);
  // An owner action (a tab navigating, the panel's Resume) reaches the service only
  // as an event the worker publishes after its own bookkeeping. Wait for that actual
  // event, then for the pump to have delivered it, before the next dispatch. Waiting
  // on the worker's status alone is not enough: the status changes before the event
  // is published, so under load the event landed in the middle of the next dispatch
  // and the fence refused it (binding_inactive).
  const workerEventCount=()=>worker.evaluate(()=>globalThis.fixtureEvents.length);
  const deliveredOwnerEvent=async(since,match,label)=>{
    const deadline=Date.now()+30000;let total;
    for(;;){
      if(pumpError)throw pumpError;
      total=await worker.evaluate(({since,match})=>{const events=globalThis.fixtureEvents;return events.slice(since).some(event=>event.event===match.event&&(!match.urlIncludes||String(event.data?.url??'').includes(match.urlIncludes)))?events.length:-1;},{since,match});
      if(total>=0)break;
      assert.ok(Date.now()<deadline,`The worker never published ${label}`);
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    while(eventCursor<total){await drainEvents();if(pumpError)throw pumpError;}
  };
  const binding=await service.ensureBinding({botId:'proof_bot',threadId:'proof_thread',profileId});
  const bindingId=binding.bindingId;
  await service.setSiteAccess(bindingId,origin,'allow');await drainEvents();
  let id = 0, bindingGeneration = binding.generation;
  // After the owner's Stop, the proof continues on a new task (a new binding): Stop is final (coordinator ruling, 0.1.62).
  let currentBindingId = bindingId;
  const command = async (operation, params = {}, generation = bindingGeneration) => worker.evaluate(message => globalThis.fixtureBrokerRequest(message), { version: 1, type: 'command', id: `proof_${++id}`, bindingId: currentBindingId, generation, operation, params });
  const expectedTools=['open','read','snapshot','click','fill','type','press','check','uncheck','select','scroll','wait_ms','wait_for_selector','wait_for_text','wait_for_load','screenshot','get_text','get_url','get_title','close','back','forward','reload','tab_new','tab_list','tab_switch','tab_close'].map(name=>'agent_browser_'+name).sort();
  assert.deepEqual(service.tools(bindingId,()=>true).tools.map(tool=>tool.name).sort(),expectedTools);
  checks.push('real_service_exposes_exact_27_pinned_engine_tools');
  let response=await command('status');assert.ok(response.result,JSON.stringify(response));let doc=response.result;
  checks.push('real_extension_loaded_and_owned_tab_created');
  let since=await workerEventCount();
  response = await command('cdp', { method: 'Page.navigate', params: { url: `${origin}/` }, tabId: doc.tabId, navigationEpoch: doc.navigationEpoch });
  assert.ok(response.result, JSON.stringify(response));
  await new Promise(async (resolve, reject) => { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (context.pages().some(p => p.url().startsWith(origin))) return resolve(); await new Promise(r => setTimeout(r, 25)); } reject(Error('Owned page navigation did not become ready')); });
  await deliveredOwnerEvent(since,{event:'navigation',urlIncludes:`${origin}/`},'the navigation of the owned tab');
  const ownedPage = context.pages().find(p => p.url().startsWith(origin));
  // Page was usually created before listener: inspect only this isolated context.
  const page = ownedPage ?? context.pages().find(p => p.url().startsWith(origin));
  assert.ok(page); await page.waitForLoadState('load');
  doc = (await command('status')).result;
  response = await command('cdp', { method: 'Runtime.evaluate', params: { expression: `document.querySelector('#name').value='Fixture person';document.querySelector('#save').click();document.querySelector('#result').textContent`, returnByValue: true }, tabId: doc.tabId, navigationEpoch: doc.navigationEpoch });
  assert.equal(response.result.result.result.value, 'Fixture person'); checks.push('real_debugger_navigate_fill_click_read');
  response = await command('cdp', { method: 'Page.captureScreenshot', params: { format: 'png' }, tabId: doc.tabId, navigationEpoch: doc.navigationEpoch });
  assert.ok(response.result.result.data.length > 100); await writeFile(`${run}/controlled-page.png`, Buffer.from(response.result.result.data, 'base64')); checks.push('real_debugger_screenshot');
  const dispatch=async(name,args)=>{await drainEvents();if(pumpError)throw pumpError;const value=await service.dispatch(bindingId,name,args,()=>true);await drainEvents();if(pumpError)throw pumpError;if(value?.isError)throw Error(JSON.stringify(value));return value;};
  await dispatch('agent_browser_open', { url: `${origin}/semantic` }); await page.waitForURL(`${origin}/semantic`); await page.waitForLoadState('load');
  checks.push('real_semantic_executor_navigation');
  const snapshot = await dispatch('agent_browser_snapshot', {}); assert.ok(JSON.stringify(snapshot).includes('Local browser fixture'));
  await dispatch('agent_browser_fill', { selector: '#name', text: 'Semantic executor' });
  await dispatch('agent_browser_click', { selector: '#save' });
  assert.equal(await page.locator('#result').textContent(), 'Semantic executor');
  const screenshot = await dispatch('agent_browser_screenshot', {}); assert.ok(screenshot.content.some(item=>item.type==='image'),'Pinned engine screenshot must include image content');
  checks.push('real_semantic_executor_snapshot_fill_click_screenshot');
  await page.evaluate(() => { const password = document.createElement('input'); password.type = 'password'; document.body.append(password); });
  await assert.rejects(() => dispatch('agent_browser_snapshot', {}), /take over/);
  await page.evaluate(() => document.querySelector('input[type=password]').remove());
  await assert.rejects(() => dispatch('agent_browser_snapshot', {}), /YOUR TURN/);
  assert.equal(service.status().bindings.find(item => item.bindingId === bindingId).pausedReason, 'handoff');
  since = await workerEventCount();
  await service.continueHandoff(bindingId);
  await deliveredOwnerEvent(since, { event: 'resumed' }, 'the owner Continue');
  bindingGeneration = (await service.ensureBinding({ botId: 'proof_bot', threadId: 'proof_thread', profileId })).generation;
  assert.equal(service.status().bindings.find(item => item.bindingId === bindingId).state, 'active');
  checks.push('real_semantic_executor_protected_document_refusal_until_owner_continue');
  const fresh = await dispatch('agent_browser_snapshot', {});const reference=JSON.stringify(fresh).match(/(?:@|ref[=:]\s*)(e[0-9]+)/);assert.ok(reference,'Actual engine snapshot must expose an element ref');const ref='@'+reference[1];
  since=await workerEventCount();
  await page.evaluate(() => history.pushState({}, '', '/changed#fixture'));
  for (let attempt = 0; attempt < 100 && !(await command('status')).result.url.includes('/changed'); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  await deliveredOwnerEvent(since,{event:'navigation',urlIncludes:'/changed'},'the owner navigation to /changed');
  await assert.rejects(() => dispatch('agent_browser_get_text', { selector: ref }), /references expired/);
  checks.push('real_semantic_executor_stale_reference_refused');
  since=await workerEventCount();
  await page.goto(`${origin}/login`); await page.waitForLoadState('load');
  await deliveredOwnerEvent(since,{event:'navigation',urlIncludes:'/login'},'the owner navigation to /login');
  await dispatch('agent_browser_open', { url: `${origin}/after-login` }); await page.waitForURL(`${origin}/after-login`);
  assert.ok((await context.cookies(origin)).some(cookie => cookie.name === 'fixture_login' && cookie.value === 'yes'));
  checks.push('local_fixture_login_preserved_across_semantic_navigation');
  const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`); // The side panel (T33) shows the task state as its state card title, not as a page heading: "<bot> is working", "Paused", "Stopped".
  const stateTitle = text => panel.locator('[data-role="state-title"]').filter({ hasText: text });
  await stateTitle(/ is working$/).waitFor();
  const axeSource = await readFile(`${root}node_modules/axe-core/axe.min.js`, 'utf8');
  for (const width of [390, 820, 1440]) {
    await panel.setViewportSize({ width, height: 1000 }); await panel.screenshot({ path: `${run}/panel-${width}.png`, fullPage: true });
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await panel.evaluate(axeSource); const axe = await panel.evaluate(async () => globalThis.axe.run());
  await writeFile(`${run}/axe.json`, JSON.stringify(axe, null, 2)); assert.equal(axe.violations.filter(v => ['serious', 'critical'].includes(v.impact)).length, 0); checks.push('panel_390_820_1440_no_overflow_axe_no_serious_critical');
  // Agent Input.* travels through the observer's single-dispatch correlation.
  await dispatch('agent_browser_fill', { selector: '#name', text: 'Agent input remains active' });
  assert.equal((await command('status')).result.state, 'active');
  assert.equal(await page.locator('#name').inputValue(), 'Agent input remains active');
  checks.push('correlated_agent_input_keeps_binding_active');
  // A second controller supplies browser-generated trusted input outside that
  // correlation. This is not a claim to distinguish physical human input.
  const controller = await context.newCDPSession(page);
  await page.evaluate(() => { globalThis.fixtureTrustedInput = false; document.querySelector('#name').addEventListener('beforeinput', event => { globalThis.fixtureTrustedInput = event.isTrusted; }, { once: true }); });
  await controller.send('Input.insertText', { text: ' unexpected controller input' });
  assert.equal(await page.evaluate(() => globalThis.fixtureTrustedInput), true);
  let paused;
  for (let attempt = 0; attempt < 100; attempt++) { paused = (await command('status')).result; if (paused.state === 'paused') break; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(paused.state, 'paused');
  response = await command('cdp', { method: 'Runtime.evaluate', params: { expression: 'document.body.innerText', returnByValue: true }, tabId: paused.tabId, navigationEpoch: paused.navigationEpoch }, paused.generation);
  assert.equal(response.error.code, 'binding_inactive'); assert.equal(response.result, undefined);
  let takeoverPublished=false;
  for(let attempt=0;attempt<200;attempt++){takeoverPublished=await worker.evaluate(bindingId=>globalThis.fixtureEvents.some(event=>event.event==='takeover'&&event.bindingId===bindingId),bindingId);if(takeoverPublished)break;await new Promise(resolve=>setTimeout(resolve,25));}
  assert.ok(takeoverPublished,'The same binding must publish its takeover event after fencing/detach');
  await stateTitle(/^Paused$/).waitFor();
  await panel.screenshot({ path: `${run}/panel-takeover-paused.png`, fullPage: true });
  checks.push('independent_trusted_input_pauses_and_next_read_is_blocked');
  await controller.detach();
  since=await workerEventCount();
  await panel.getByRole('button', { name: 'Resume', exact: true }).click();
  await deliveredOwnerEvent(since,{event:'resumed'},'the owner resume');
  const resumed=await service.ensureBinding({botId:'proof_bot',threadId:'proof_thread',profileId});bindingGeneration=resumed.generation;
  assert.equal(service.status().bindings.find(item=>item.bindingId===bindingId).state,'active');
  await dispatch('agent_browser_snapshot', {});
  checks.push('explicit_owner_resume_reinstalls_observer_and_reconciles_before_read');
  await stateTitle(/ is working$/).waitFor();
  await panel.getByRole('button', { name: 'Pause', exact: true }).focus();
  await panel.keyboard.press('Tab');
  const stopButton=panel.getByRole('button', { name: 'Stop', exact: true });
  assert.equal(await stopButton.evaluate(el => document.activeElement === el), true);
  assert.equal(await stopButton.evaluate(el => el.matches(':focus-visible')), true);
  assert.notEqual(await stopButton.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
  await panel.keyboard.press('Enter'); await stateTitle(/^Stopped$/).waitFor();
  response = await command('cdp', { method: 'Target.getTargets' }); assert.equal(response.error.code, 'stale_generation'); checks.push('keyboard_stop_persists_and_fences_command');
  await panel.screenshot({ path: `${run}/panel-stopped.png`, fullPage: true });
  // Ordered nonce+sequence wire IDs have constant-size replay tracking. More
  // than4096 legitimate calls must succeed without forgetting an early ID.
  await drainEvents();pumpStopped=true;clearInterval(eventPump);await draining;await service.close();
  if(pumpError)throw pumpError;
  const ledger=await worker.evaluate(async({oldGeneration,tabId,navigationEpoch,bindingId})=>{
    const raw=message=>globalThis.fixture.handleRequest(message),send=message=>globalThis.fixtureBrokerRequest(message);
    const request={version:1,type:'command',bindingId,generation:oldGeneration,operation:'status',params:{}};
    const nonce=globalThis.fixtureWire.nonce,start=globalThis.fixtureWire.sequence;
    let accepted=0;for(let i=0;i<5000;i++){const response=await send({...request,id:'ledger_'+i});if(response.error)throw Error('Legitimate ordered request failed: '+response.error.code);accepted++;}
    const input={...request,id:nonce+'_1',operation:'cdp',params:{method:'Input.insertText',params:{text:'MUST NOT REPLAY'},tabId,navigationEpoch}};
    const early=await raw(input);await globalThis.fixture.connection(true);const sameConnection=await raw(input);
    const next=globalThis.fixtureWire.sequence+1,alienNonce=(nonce[0]==='f'?'e':'f')+nonce.slice(1);
    const malformed=[];for(const[id,expected]of [[nonce+'_'+(next+1),'request_sequence_gap'],[alienNonce+'_'+next,'request_sequence_mismatch'],[nonce+'_0'+next,'invalid_request_sequence'],[nonce+'_9007199254740992','invalid_request_sequence']]){const response=await raw({...input,id});malformed.push({expected,actual:response.error?.code});}
    const continued=await send({...request,id:'ledger_after_refusals'});
    await globalThis.fixtureReconnect();
    const old=await send({...input,id:'old_generation'});const repeated=await raw({...input,id:globalThis.fixtureWire.nonce+'_1'});
    const state=(await send({...request,id:'fresh_status'})).result;
    const blocked=await send({...input,id:'current_generation',generation:state.generation});
    const persisted=(await chrome.storage.local.get('murageBrowserState')).murageBrowserState.bindings.find(b=>b.id===bindingId);
    return{start,accepted,early:early.error?.code,sameConnection:sameConnection.error?.code,malformed,continued:continued.error?.code??'ok',old:old.error?.code,repeated:repeated.error?.code,blocked:blocked.error?.code,state:state.state,persisted:persisted.state};
  },{oldGeneration:bindingGeneration,tabId:paused.tabId,navigationEpoch:paused.navigationEpoch,bindingId});
  assert.equal(ledger.accepted,5000);assert.equal(ledger.early,'replayed_request');assert.equal(ledger.sameConnection,'replayed_request');for(const refusal of ledger.malformed)assert.equal(refusal.actual,refusal.expected);assert.equal(ledger.continued,'ok');assert.equal(ledger.old,'stale_generation');assert.equal(ledger.repeated,'replayed_request');assert.equal(ledger.blocked,'binding_inactive');assert.equal(ledger.state,'stopped');assert.equal(ledger.persisted,'stopped');
  assert.ok(!(await page.locator('#name').inputValue()).includes('MUST NOT REPLAY'));
  await writeFile(`${run}/ledger.json`,JSON.stringify(ledger,null,2));
  checks.push('ordered_wire_5000_requests_early_replay_refusal_fresh_connection_preserves_stop_without_replay');
  // A3: actual browser groups remain presentation, never authority.
  // Ruling (a): Resume on a task the owner stopped is refused by the runtime, and it stays stopped; a new task is the way back.
  const afterStop = await worker.evaluate(async bindingId => {
    let resume; try { await globalThis.fixture.handlePanel({action:'resume',bindingId}); resume='resumed'; } catch (error) { resume=error.code; }
    try { await globalThis.fixture.handlePanel({action:'pause',bindingId}); } catch { /* a pause of a stopped task changes nothing */ }
    let again; try { await globalThis.fixture.handlePanel({action:'resume',bindingId}); again='resumed'; } catch (error) { again=error.code; }
    const state=(await globalThis.fixture.handlePanel({action:'status'})).bindings.find(b=>b.bindingId===bindingId).state;
    return {resume,again,state};
  }, bindingId);
  assert.equal(afterStop.resume,'binding_stopped');assert.equal(afterStop.again,'binding_stopped');assert.equal(afterStop.state,'stopped');
  checks.push('resume_after_owner_stop_refused_by_runtime_and_pause_cannot_revive');
  const nextBindingId = `${bindingId}_next`;
  const isolation = await worker.evaluate(async ({profileId,origin,bindingId,stoppedId,pageTab}) => {
    let n=0; const call=(bindingId,generation,operation,params={})=>globalThis.fixtureBrokerRequest({version:1,type:'command',id:`isolation_${++n}`,bindingId,generation,operation,params});
    // The owner unshares the page from the stopped task and shares it with the new one.
    await globalThis.fixture.handlePanel({action:'unshare',bindingId:stoppedId,tabId:pageTab});
    const first=(await call(bindingId,1,'bind',{profileId,botName:'Fixture bot',approvedOrigins:[origin]})).result;
    await globalThis.fixture.handlePanel({action:'share',bindingId,tabId:pageTab});
    const shared=(await call(bindingId,first.generation,'status')).result;
    const switched=await call(bindingId,shared.generation,'tab_switch',{tabId:pageTab});
    if(switched.error)throw Error('tab_switch failed: '+switched.error.code);
    const firstGeneration=switched.result.generation;
    const second=(await call('second_bot',1,'bind',{profileId,botName:'Second fixture bot',approvedOrigins:[origin]})).result;
    const a=await chrome.tabs.get(first.tabId), b=await chrome.tabs.get(second.tabId);
    const colors=[(await chrome.tabGroups.get(a.groupId)).color,(await chrome.tabGroups.get(b.groupId)).color];
    const foreignA=await call(bindingId,firstGeneration,'cdp',{method:'Runtime.evaluate',tabId:second.tabId,navigationEpoch:second.navigationEpoch,params:{expression:'document.body.innerText'}});
    const foreignB=await call('second_bot',second.generation,'cdp',{method:'Runtime.evaluate',tabId:first.tabId,navigationEpoch:first.navigationEpoch,params:{expression:'document.body.innerText'}});
    await chrome.tabs.group({tabIds:[second.tabId],groupId:a.groupId});
    const dragged=await call(bindingId,firstGeneration,'cdp',{method:'Runtime.evaluate',tabId:second.tabId,navigationEpoch:second.navigationEpoch,params:{expression:'document.body.innerText'}});
    return {groups:[a.groupId,b.groupId],colors,foreignA:foreignA.error?.code,foreignB:foreignB.error?.code,dragged:dragged.error?.code};
  },{profileId,origin,bindingId:nextBindingId,stoppedId:bindingId,pageTab:paused.tabId});
  currentBindingId = nextBindingId;
  assert.ok(isolation.groups.every(id=>id>=0));assert.notEqual(...isolation.groups);
  // Every Murage group is orange, the palette colour closest to the Murage accent (tab-group.mjs): two bots are told apart by their titles, not by colour.
  assert.deepEqual(isolation.colors,['orange','orange']);
  assert.equal(isolation.foreignA,'stale_document');assert.equal(isolation.foreignB,'stale_document');assert.equal(isolation.dragged,'stale_document');
  await writeFile(`${run}/two-bot-isolation.json`,JSON.stringify(isolation,null,2));checks.push('two_real_colored_groups_cross_tab_reads_and_dragged_tab_authority_refused');
  // A6: extension reload drops stale authority and releases an armed page guard.
  const beforeRestart=(await command('status')).result;
  const tree=await command('cdp',{method:'Page.getFrameTree',tabId:beforeRestart.tabId,navigationEpoch:beforeRestart.navigationEpoch},beforeRestart.generation);
  const guardWorld=await command('cdp',{method:'Page.createIsolatedWorld',params:{frameId:tree.result.result.frameTree.frame.id,worldName:'murage-protected-document-v1'},tabId:beforeRestart.tabId,navigationEpoch:beforeRestart.navigationEpoch},beforeRestart.generation);
  const armed=await command('cdp',{method:'Runtime.evaluate',params:{expression:'globalThis.__murageGuard.enable(true)',contextId:guardWorld.result.result.executionContextId},tabId:beforeRestart.tabId,navigationEpoch:beforeRestart.navigationEpoch},beforeRestart.generation);assert.ok(armed.result);
  const reloadStages={startedAt:Date.now(),before:await extensionInfo(),registrationStates:[],workers:[],workerConsole:[],versions:[],workerErrors:[],evaluations:[],evaluationCount:0};
  const workerUrl=worker.url(); let restarted, wakePanel, resolveReplacement, resolveOldClosed, lifecycleSession;
  const replacement=new Promise(resolve=>{resolveReplacement=resolve;});
  const oldClosed=new Promise(resolve=>{resolveOldClosed=resolve;});
  const candidates=[];
  const shortError=error=>({name:String(error?.name??'Error'),message:String(error?.message??error).slice(0,1000)});
  const onWorkerConsole=message=>{if(message.worker()?.url()===workerUrl&&reloadStages.workerConsole.length<50){const value=message.text();if(value.startsWith('MURAGE_FIXTURE_LIFECYCLE ')||message.type()==='error')reloadStages.workerConsole.push({at:Date.now(),type:message.type(),text:value.slice(0,1500),location:message.location()});}};
  context.on('console',onWorkerConsole);
  const onVersion=event=>{for(const version of event.versions??[])if(version.scriptURL===workerUrl&&reloadStages.versions.length<50)reloadStages.versions.push({at:Date.now(),versionId:version.versionId,targetId:version.targetId,runningStatus:version.runningStatus,status:version.status});};
  const onWorkerError=event=>{const error=event.errorMessage;if(error?.sourceURL===workerUrl&&reloadStages.workerErrors.length<20)reloadStages.workerErrors.push({at:Date.now(),...error,errorMessage:String(error.errorMessage).slice(0,1000)});};
  // Read-only ServiceWorker lifecycle observer on the task's Chrome management
  // page. This does not stop, start, update, bypass or reload any worker/page.
  let observerTimer;
  try{await Promise.race([(async()=>{lifecycleSession=await context.newCDPSession(extensionInspector);lifecycleSession.on('ServiceWorker.workerVersionUpdated',onVersion);lifecycleSession.on('ServiceWorker.workerErrorReported',onWorkerError);await lifecycleSession.send('ServiceWorker.enable');})(),new Promise((_,reject)=>{observerTimer=setTimeout(()=>reject(Error('Lifecycle observer unavailable within diagnostic setup bound')),2000);})]);}
  catch(error){reloadStages.lifecycleObserverError=shortError(error);}
  finally{clearTimeout(observerTimer);}
  const onReplacement=value=>{
    if(value===worker||value.url()!==workerUrl||candidates.some(item=>item.value===value))return;
    const record={index:candidates.length,url:value.url(),attachedAt:Date.now()};
    const onClose=()=>{record.closedAt=Date.now();};
    candidates.push({value,record,onClose});reloadStages.workers.push(record);value.once('close',onClose);
    reloadStages.replacementAttachedAt=record.attachedAt;resolveReplacement(value);
  };
  const onOldClosed=()=>{reloadStages.oldClosedAt=Date.now();resolveOldClosed();};
  worker.once('close',onOldClosed);context.on('serviceworker',onReplacement);
  let reloadTimer;
  const reloadDeadline=new Promise((_,reject)=>{reloadTimer=setTimeout(()=>reject(Error('Extension reload did not complete within 15 seconds')),15000);});
  // Handle the deadline immediately even while the old evaluation is destroyed.
  void reloadDeadline.catch(()=>{});
  const bounded=promise=>Promise.race([promise,reloadDeadline]);
  try {
    void worker.evaluate(()=>chrome.runtime.reload()).then(()=>{reloadStages.reloadEvaluation='returned';},()=>{reloadStages.reloadEvaluation='context closed';});
    await bounded(oldClosed);
    let previousRegistration;
    for(;;){
      const info=await bounded(extensionInfo()),signature=JSON.stringify(info);
      if(signature!==previousRegistration&&reloadStages.registrationStates.length<20){reloadStages.registrationStates.push({at:Date.now(),info});previousRegistration=signature;}
      if(info?.state==='ENABLED'&&!info.disableReasons?.reloading){reloadStages.registrationEnabledAt=Date.now();break;}
      await bounded(new Promise(resolve=>setTimeout(resolve,50)));
    }
    // A fresh packaged panel sends the normal status message that wakes an
    // event-driven worker. Never reload the controlled website to clear its guard.
    wakePanel=await bounded(context.newPage());reloadStages.wakePanelOpenedAt=Date.now();
    await bounded(wakePanel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`,{waitUntil:'domcontentloaded'}));
    restarted=await bounded(replacement);
    for(;;){
      const sample={requestedAt:Date.now(),workerIndex:candidates.findIndex(item=>item.value===restarted)};
      reloadStages.evaluationCount++;if(reloadStages.evaluations.length<20)reloadStages.evaluations.push(sample);
      const evaluation=restarted.evaluate(()=>({ready:Boolean(globalThis.fixture),phase:globalThis.fixtureLifecycle??null})).then(value=>{sample.fulfilledAt=Date.now();sample.value=value;return value;},error=>{sample.rejectedAt=Date.now();sample.error=shortError(error);throw error;});
      const state=await bounded(evaluation); // A rejected worker is an error, never Boolean false.
      if(state.ready)break;
      if(state.phase?.phase==='failed')throw Error('Fixture initializer failed: '+JSON.stringify(state.phase.error));
      await bounded(new Promise(resolve=>setTimeout(resolve,50)));
    }
    reloadStages.initializedAt=Date.now();
  } finally {
    clearTimeout(reloadTimer);
    // Cleanup-only reads have their own short bound; they cannot turn the
    // unchanged 15-second acceptance timeout into a pass or trigger a retry.
    const capture=async operation=>{let timer;try{return await Promise.race([operation(),new Promise(resolve=>{timer=setTimeout(()=>resolve({diagnosticTimeout:true}),2000);})]);}catch(error){return{error:shortError(error)};}finally{clearTimeout(timer);}};
    reloadStages.registrationAtFinish=await capture(extensionInfo);
    reloadStages.profileAtFinish=await capture(()=>extensionInspector.evaluate(()=>chrome.developerPrivate.getProfileConfiguration()));
    reloadStages.currentMatchingWorkers=context.serviceWorkers().filter(value=>value.url()===workerUrl).map(value=>({url:value.url(),index:candidates.findIndex(item=>item.value===value),isOld:value===worker}));
    if(wakePanel)reloadStages.panelAtFinish=await capture(()=>wakePanel.evaluate(()=>({url:location.href,state:document.querySelector('#state')?.textContent,connection:document.querySelector('#connection')?.textContent,feedback:document.querySelector('#feedback')?.textContent})));
    if(lifecycleSession)await capture(()=>lifecycleSession.detach());
    worker.removeListener('close',onOldClosed);context.removeListener('serviceworker',onReplacement);context.removeListener('console',onWorkerConsole);
    for(const item of candidates)item.value.removeListener('close',item.onClose);
    await writeFile(`${run}/reload-stages.json`,JSON.stringify(reloadStages,null,2));
  }
  const afterRestart=await restarted.evaluate(async bindingId=>(await globalThis.fixture.handlePanel({action:'status'})).bindings.find(b=>b.bindingId===bindingId),currentBindingId);
  const stoppedAfterRestart=await restarted.evaluate(async bindingId=>(await globalThis.fixture.handlePanel({action:'status'})).bindings.find(b=>b.bindingId===bindingId)?.state,bindingId);
  assert.equal(stoppedAfterRestart,'stopped');
  assert.equal(afterRestart.state,'paused');assert.deepEqual(afterRestart.tabs,[]);assert.ok(afterRestart.generation>beforeRestart.generation);
  const staleRestart=await restarted.evaluate(message=>globalThis.fixtureBrokerRequest(message),{version:1,type:'command',id:'restart_stale',bindingId:currentBindingId,generation:beforeRestart.generation,operation:'cdp',params:{method:'Runtime.evaluate',tabId:beforeRestart.tabId,navigationEpoch:beforeRestart.navigationEpoch,params:{expression:'document.body.innerText'}}});
  assert.equal(staleRestart.error?.code,'stale_generation');
  await page.evaluate(()=>{const input=document.createElement('input');input.type='password';input.id='after-restart-private';document.body.append(input);});
  await page.locator('#after-restart-private').fill('fixture-private-value');
  assert.equal(await page.locator('#after-restart-private').inputValue(),'fixture-private-value');
  checks.push('extension_reload_fences_stale_authority_and_releases_private_input_guard');
  const sourceHashes={};for(const name of ['extensions/murage-browser/runtime.mjs','extensions/murage-browser/takeover.mjs','scripts/browser-extension-runtime.test.mjs','scripts/prove-browser-extension.mjs','server/browser-extension-service.ts','server/browser-extension-engine.ts','server/browser-extension-executor.ts'])sourceHashes[name]=createHash('sha256').update(await readFile(root+name)).digest('hex');
  await writeFile(`${run}/receipt.json`, JSON.stringify({ sharedRuntimeRound:Number(process.env.MURAGE_RUNTIME_ROUND??10), status: 'PASS', loader, browser: await context.browser().version(), checks, limitations: ['Injected fixture transport, not native messaging host proof', 'Not branded Chrome, Edge or Brave', 'Unexpected trusted-input correlation, not perfect physical-human attribution; identical overlapping expected events may collide', 'Lighthouse unavailable for chrome-extension origin'], sourceHashes,engine:{path:pinnedEngine,sha256:createHash('sha256').update(await readFile(pinnedEngine)).digest('hex')}, isolation:{scratch,profile}, run }, null, 2));
  console.log(JSON.stringify({ run, loader, checks, status: 'PASS' }));
} catch (error) {
  await writeFile(`${run}/events-failure.json`,JSON.stringify(worker?await worker.evaluate(()=>globalThis.fixtureEvents).catch(failure=>({unavailable:String(failure)})):[],null,2));
  await writeFile(`${run}/receipt.json`, JSON.stringify({ sharedRuntimeRound:Number(process.env.MURAGE_RUNTIME_ROUND??10), status: 'FAIL', checks, error: String(error), run }, null, 2)); throw error;
} finally { pumpStopped=true;clearInterval(eventPump);await draining?.catch(()=>{});await service?.close().catch(()=>{});await context?.close(); await new Promise(resolve => server.close(resolve)); await rm(profile, { recursive: true, force: true }); }
