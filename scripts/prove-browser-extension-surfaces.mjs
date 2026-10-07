// SPDX-License-Identifier: AGPL-3.0-or-later
// Real-browser proofs of the page surfaces Murage for Chrome meets (lane chromebatch1, 0.1.62).
// Same rig as prove-browser-extension.mjs (isolated profile, the real extension, the real debugger, the real
// service and executor, the pinned engine), plus the T15 fixture site and the extension's full listener set
// (downloads, new tabs). Every check records pass or fail with its evidence; one failing check never hides another.
//   MURAGE_PROVE_BROWSER_EXECUTABLE   the browser binary (Chrome for Testing, Chrome, Edge or Brave)
//   MURAGE_PROVE_EXTENSION_LOADER     flag | cdp (default: cdp for branded browsers)
//   MURAGE_PROVE_LABEL                a label for the evidence folder
//   MURAGE_PROVE_ONLY                 comma list of check names to run (default all)
//   MURAGE_PROVE_HEADLESS_ONLY        1 on a VM: skip nothing, only declares the display-less run in the result
import { watchProofWorker } from './browser-extension-proof-worker.mjs';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, mkdtemp, cp, writeFile, readFile, realpath, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { tmpdir, platform } from 'node:os';
import { resolve, relative, isAbsolute, join } from 'node:path';

const exe = process.env.MURAGE_PROVE_BROWSER_EXECUTABLE;
assert.ok(exe, 'MURAGE_PROVE_BROWSER_EXECUTABLE names the browser to prove against');
const label = process.env.MURAGE_PROVE_LABEL ?? 'browser';
const isBranded = /Google Chrome(?! for Testing)|google-chrome|Microsoft Edge|msedge|Brave|brave|[\\/]Google[\\/]Chrome[\\/]Application[\\/]/.test(exe);
const loader = process.env.MURAGE_PROVE_EXTENSION_LOADER ?? (isBranded ? 'cdp' : 'flag');
const scratch = await realpath(tmpdir());
if (platform() === 'darwin') assert.ok(scratch.startsWith('/Volumes/Scratch/'), 'Task TMPDIR must be on the scratch volume');
for (const key of ['HOME', 'USERPROFILE', 'MURAGE_COMPANION_DIR']) {
  assert.ok(process.env[key], `Externally set ${key} before launching`);
  const child = relative(scratch, resolve(process.env[key]));
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), `${key} must be inside task TMPDIR`);
}
if (process.env.MURAGE_AGENT_BROWSER_PATH === undefined && platform() === 'darwin') process.env.MURAGE_AGENT_BROWSER_PATH = '/Volumes/Scratch/work/murage-0157/dist-native/browser/darwin-arm64/agent-browser';
const { createBrowserExtensionService } = await import('../server/browser-extension-service.ts');
const { BrowserExtensionEngine } = await import('../server/browser-extension-engine.ts');
const { startFixtureSite } = await import('./browser-extension-fixture-site/server.mjs');
const root = fileURLToPath(new URL('../', import.meta.url));
const out = process.env.MURAGE_PROVE_OUT ?? `${root}artifacts/browser-extension`;
await mkdir(out, { recursive: true });
const run = await mkdtemp(`${out}/surfaces-${label}-`);
const shots = `${run}/shots`; await mkdir(shots, { recursive: true });
const extension = `${run}/extension`;
const profile = await mkdtemp(join(scratch, 'surfaces-profile-'));
await cp(`${root}dist-browser-extension`, extension, { recursive: true });
// A real install holds a native port open, which keeps the worker alive. This rig has none: a test-only extension page sends the worker a message every 5 s instead.
await writeFile(`${extension}/rig-keepalive.html`, '<!doctype html><title>rig keepalive</title><script src="rig-keepalive.js"></script>');
await writeFile(`${extension}/rig-keepalive.js`, 'setInterval(() => { try { chrome.runtime.sendMessage({ rigKeepalive: true }).catch(() => {}); } catch {} }, 5000);');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const only = process.env.MURAGE_PROVE_ONLY ? new Set(process.env.MURAGE_PROVE_ONLY.split(',')) : undefined;

// The extension's own service-worker wiring (same listeners as extensions/murage-browser/service-worker.mjs), with the native port
// replaced by a function the proof calls, and a log of what the downloads API asked the extension.
await build({ stdin: { contents: `import {createBrowserExtensionRuntime} from ${JSON.stringify(`${root}extensions/murage-browser/runtime.mjs`)};
globalThis.fixtureEvents=[];globalThis.fixtureDownloadLog=[];
// A real install holds a native port open, which keeps the worker alive; this rig has none, so an API call every 10 s does the same.
setInterval(()=>{try{chrome.runtime.getPlatformInfo(()=>{});}catch{}},10000);
const runtime=createBrowserExtensionRuntime(chrome,{emit:event=>globalThis.fixtureEvents.push(event)});
globalThis.fixtureWire={nonce:crypto.randomUUID().replaceAll('-',''),sequence:0};
globalThis.fixtureCdpLog=[];globalThis.fixtureBrokerRequest=async message=>{if(message.operation==='cdp'&&/Dialog|Input\.dispatchMouse/.test(message.params?.method??''))globalThis.fixtureCdpLog.push({at:Date.now(),method:message.params.method,type:message.params.params?.type,accept:message.params.params?.accept});const wireId=globalThis.fixtureWire.nonce+'_'+(++globalThis.fixtureWire.sequence);const response=await runtime.handleRequest({...message,id:wireId});if(response.id!==wireId)throw Error('Fixture broker response identity mismatch');return {...response,id:message.id};};
const ready=(async()=>{try{await runtime.initialize();globalThis.fixtureHello=await runtime.connection(true);globalThis.fixture=runtime;}catch(e){globalThis.fixtureError=String(e&&e.stack||e);throw e;}})();ready.catch(()=>{});
for(const e of [chrome.webNavigation.onCommitted,chrome.webNavigation.onHistoryStateUpdated,chrome.webNavigation.onReferenceFragmentUpdated]) e.addListener(d=>{void ready.then(()=>runtime.navigation(d));});
chrome.downloads.onCreated.addListener(item=>{globalThis.fixtureDownloadLog.push({at:Date.now(),event:'created',id:item.id,url:item.url,state:item.state});void ready.then(()=>runtime.downloadCreated(item));});
chrome.downloads.onDeterminingFilename.addListener((item,suggest)=>{
  globalThis.fixtureDownloadLog.push({at:Date.now(),event:'determining',id:item.id,url:item.url,filename:item.filename});
  const answer=()=>{try{suggest();}catch{}};
  ready.then(()=>runtime.downloadDetermining(item)).then(r=>{globalThis.fixtureDownloadLog.push({at:Date.now(),event:'decided',id:item.id,cancelled:r});answer();},answer);return true;});
chrome.webNavigation.onCreatedNavigationTarget.addListener(d=>{(globalThis.fixtureTabLog??=[]).push({at:Date.now(),navTarget:d.tabId,source:d.sourceTabId});void ready.then(()=>runtime.navigationTarget(d));});
chrome.tabs.onCreated.addListener(tab=>{(globalThis.fixtureTabLog??=[]).push({at:Date.now(),id:tab.id,openerTabId:tab.openerTabId,url:tab.url,pendingUrl:tab.pendingUrl});void ready.then(()=>runtime.tabCreated(tab));});
chrome.tabs.onRemoved.addListener(tabId=>{void ready.then(()=>runtime.removed(tabId));});
chrome.debugger.onDetach.addListener(source=>{if(source.tabId!==undefined)void ready.then(()=>runtime.detached(source.tabId));});
chrome.debugger.onEvent.addListener((source,method,params)=>{void ready.then(()=>runtime.debuggerEvent(source,method,params));});
chrome.runtime.onMessage.addListener((m,s,reply)=>{ if(s.id!==chrome.runtime.id || s.url!==chrome.runtime.getURL('sidepanel/index.html')) return false; ready.then(()=>runtime.handlePanel(m)).then(result=>reply({result}),e=>reply({error:e.code})); return true; });`, resolveDir: root, sourcefile: 'surfaces-worker.mjs' }, outfile: `${extension}/service-worker.js`, bundle: true, format: 'esm', platform: 'browser', target: 'chrome120' });

// A stand-in for the pinned engine, used only by the dialog-card proof: it clicks like the engine would, then answers the
// page's dialog with Page.handleJavaScriptDialog (promptText included) through the same hooks the real engine's commands take,
// so the real extension and the real Chrome run the whole path and only the engine process is replaced.
const fakeEngine = engine => {
  const send = (method, params = {}, doc) => engine.transport.send(method, params, doc);
  const resolve = async selector => {
    const doc = await engine.transport.selected();
    const root = await send('DOM.getDocument', { depth: 0 }, doc);
    const found = await send('DOM.querySelector', { nodeId: root.root.nodeId, selector }, doc);
    const node = await send('DOM.describeNode', { nodeId: found.nodeId }, doc);
    return { backendNodeId: node.node.backendNodeId, document: doc };
  };
  let opened;
  return {
    resolveTarget: selector => resolve(selector), resolveTab: async () => engine.transport.selected(), event(tabId, epoch, method, params) { if (method === 'Page.javascriptDialogOpening') opened = params; }, async close() {},
    async call(name, args) {
      const doc = await engine.transport.selected();
      await engine.beforeCommand(doc, 'Runtime.evaluate', { expression: 'document.title' });
      // Trigger the prompt from the page without blocking the command: the click handler runs on the next tick.
      await send('Runtime.evaluate', { expression: `setTimeout(() => document.querySelector(${JSON.stringify(args.selector)}).click(), 50); 1`, returnByValue: true }, doc);
      for (let i = 0; i < 100 && !opened; i++) await sleep(50);
      assert.ok(opened, 'the page opened no dialog');
      const params = { accept: true, promptText: 'Murage bot text' };
      await engine.beforeCommand(doc, 'Page.handleJavaScriptDialog', params);
      await send('Page.handleJavaScriptDialog', params, doc);
      opened = undefined;
      return { content: [{ type: 'text', text: 'clicked' }] };
    },
  };
};

const fixture = await startFixtureSite();
const results = [];
let browserProc, browser, context, worker, service, eventPump, draining, pumpError, eventCursor = 0, pumpStopped = false;
const cards = [];
let decide = async () => true;
const instructions = new Map();
const siteAllow = new Map();
const deliveredDialog = [];
let ownerDialog; const pendingDialogs = [];
let fakeEngineMode = false;

async function launch() {
  const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--password-store=basic', '--use-mock-keychain', '--disable-background-networking', '--disable-component-update', '--headless=new', '--window-size=1280,900', 'about:blank'];
  if (loader === 'cdp') args.unshift('--enable-unsafe-extension-debugging'); else args.unshift(`--disable-extensions-except=${extension}`, `--load-extension=${extension}`);
  if (process.env.MURAGE_PROVE_NO_SANDBOX === '1') args.unshift('--no-sandbox');
  browserProc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; browserProc.stderr.on('data', c => { stderr = (stderr + c).slice(-4000); });
  const portFile = join(profile, 'DevToolsActivePort');
  let port;
  for (let i = 0; i < 200 && !port; i++) { await sleep(100); if (existsSync(portFile)) { // Windows locks the file while the browser writes it: EBUSY/EPERM means try again next tick.
    let text; try { text = await readFile(portFile, 'utf8'); } catch (error) { if (['EBUSY', 'EPERM', 'ENOENT'].includes(error?.code)) continue; throw error; }
    const lines = text.split('\n'); if (lines.length >= 2 && /^\d+$/.test(lines[0])) port = lines[0]; } }
  assert.ok(port, `The browser did not open its debugging port. ${stderr}`);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  context = browser.contexts()[0];
  // Playwright dismisses a page's dialogs itself unless something listens; a listener that does nothing leaves them open for the owner (and the bot) to answer.
  context.on('dialog', dialog => { pendingDialogs.push(dialog); void (ownerDialog ? ownerDialog(dialog) : undefined); });
  // Playwright installs its own download handling on the browser's default context; hand downloads back to the browser,
  // so the extension's downloads listeners decide, as they do for the owner.
  const session = await browser.newBrowserCDPSession();
  await session.send('Browser.setDownloadBehavior', { behavior: 'default' });
  if (loader === 'cdp') await session.send('Extensions.loadUnpacked', { path: extension });
  await session.detach();
  context.setDefaultTimeout(15000);
  const found = async () => { for (const w of context.serviceWorkers()) { try { if (await w.evaluate(() => typeof globalThis.fixtureBrokerRequest === 'function')) return w; } catch { /* another worker */ } } return undefined; };
  for (let attempt = 0; attempt < 300 && !worker; attempt++) { worker = await found(); if (!worker) await sleep(100); }
  watchWorker(worker);
  assert.ok(worker, `the extension's service worker did not start: ${context.serviceWorkers().map(w => w.url()).join(', ')}`);
  // The worker can be replaced once while the extension finishes loading: ask again until one answers.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      for (let wait = 0; wait < 200 && !(await worker.evaluate(() => Boolean(globalThis.fixture || globalThis.fixtureError))); wait++) await sleep(50);
      const err = await worker.evaluate(() => globalThis.fixtureError); assert.ok(!err, `worker failed to start: ${err}`); return;
    } catch (error) {
      if (!/closed|destroyed|Target/i.test(String(error.message))) throw error;
      worker = undefined; for (let wait = 0; wait < 100 && !worker; wait++) { worker = await found(); if (!worker) await sleep(100); }
      assert.ok(worker, 'the extension worker never came back'); watchWorker(worker);
    }
  }
}

const rigStart = Date.now();
const workerRestarts = [], workerClosures = [];
let closing = false;
const watchWorker = w => watchProofWorker(w, {
  closing: () => closing, step: () => stepName, reconnect: refind,
  record: event => {
    workerClosures.push(event);
    if (event.phase === 'teardown') { console.log('  . extension service worker closed during proof teardown'); return; }
    workerRestarts.push(event);
    console.log('  ! extension service worker closed at step: ' + event.step + ' (' + Math.round((event.at - rigStart) / 1000) + ' s after the rig started)');
  },
});
async function refind() {
  for (let attempt = 0; attempt < 200 && !closing; attempt++) {
    for (const w of context.serviceWorkers()) {
      if (w === worker) continue;
      try { if (await w.evaluate(() => typeof globalThis.fixtureBrokerRequest === 'function')) { for (let i = 0; i < 100 && !(await w.evaluate(() => Boolean(globalThis.fixture || globalThis.fixtureError))); i++) await sleep(50); worker = w; eventCursor = 0; watchWorker(w); console.log('  ! extension service worker restarted and re-attached'); return; } } catch { /* not ready */ }
    }
    await sleep(100);
  }
}
const allowedOrigins = () => [fixture.origin, fixture.altOrigin];
let profileId, extensionId;
const drain = async () => {
  if (draining) return draining;
  draining = (async () => {
    while (true) { const events = await worker.evaluate(cursor => globalThis.fixtureEvents.slice(cursor), eventCursor); if (!events.length) break; eventCursor += events.length; for (const event of events) { if (event.event === 'cdp' && /Dialog/.test(event.data?.method ?? '')) deliveredDialog.push({ at: Date.now(), method: event.data.method, generation: event.generation }); await service.handleMessage(profileId, event); if (event.event === 'cdp' && /Dialog/.test(event.data?.method ?? '')) deliveredDialog.push({ at: Date.now(), handled: event.data.method }); } }
  })();
  try { await draining; } finally { draining = undefined; }
};

let taskCounter = 0;
/** A new task (binding) with its own owned tab. `sites` are the origins the owner allows for it. */
async function task(name, { sites = [fixture.origin], instruction } = {}) {
  const botId = `bot_${name}_${++taskCounter}`;
  const binding = await service.ensureBinding({ botId, threadId: `thread_${botId}`, profileId });
  const bindingId = binding.bindingId; siteAllow.set(bindingId, new Set(sites));
  for (const origin of sites) await service.setSiteAccess(bindingId, origin, 'allow');
  await drain();
  if (instruction) instructions.set(bindingId, instruction);
  let seq = 0;
  const status = async () => { const response = await worker.evaluate(m => globalThis.fixtureBrokerRequest(m), { version: 1, type: 'command', id: `s_${++seq}`, bindingId, generation: (await service.ensureBinding({ botId, threadId: `thread_${botId}`, profileId })).generation, operation: 'status', params: {} }); if (response.error) throw Object.assign(Error(response.error.code), { code: response.error.code }); return response.result; };
  const textOf = value => { try { return (value?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n'); } catch { return ''; } };
  const tool = async (op, args = {}) => {
    step(`tool ${op} ${JSON.stringify(args).slice(0, 80)}`);
    await drain();
    try {
      const value = await service.dispatch(bindingId, `agent_browser_${op}`, args, () => true);
      await drain();
      return { ok: !value?.isError, value, text: textOf(value) };
    } catch (error) { await drain().catch(() => {}); return { ok: false, error: String(error.message ?? error), code: error.code, text: String(error.message ?? error) }; }
  };
  const raw = async (method, params = {}, doc) => {
    const d = doc ?? await status();
    const response = await worker.evaluate(m => globalThis.fixtureBrokerRequest(m), { version: 1, type: 'command', id: `r_${++seq}_${Date.now()}`, bindingId, generation: d.generation, operation: 'cdp', params: { method, params, tabId: d.tabId, navigationEpoch: d.navigationEpoch } });
    return response;
  };
  const owned = async () => { const d = await status(); return context.pages().find(p => d.url && p.url() === d.url) ?? context.pages().find(p => d.url && p.url().startsWith(d.url.split('#')[0])); };
  const stop = async () => { try { await service.stop(bindingId); await drain(); } catch { /* already gone */ } };
  return { bindingId, botId, status, tool, raw, owned, stop, textOf, cardsFor: () => cards.filter(c => c.bindingId === bindingId) };
}
const ownerLog = (since, f = {}) => fixture.actions({ since, ...f });

let EV = {};
const CHECK_MS = Number(process.env.MURAGE_CHECK_MS ?? 200000);
let stepName = '';
const step = name => { stepName = name; if (process.env.MURAGE_PROVE_VERBOSE) console.log('  . ' + name); };
async function check(name, fn) {
  if (only && !only.has(name)) return;
  stepName = 'start'; EV = {};
  const started = Date.now();
  try { const evidence = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error(`check timed out after ${CHECK_MS} ms at step: ${stepName}`)), CHECK_MS))]); results.push({ name, status: 'pass', ms: Date.now() - started, evidence }); console.log(`PASS ${name}`); }
  catch (error) { try { EV.cdpLog = await Promise.race([worker.evaluate(() => globalThis.fixtureCdpLog), sleep(3000).then(() => 'worker unreachable')]); EV.deliveredDialog = deliveredDialog; EV.dialogEvents = await Promise.race([worker.evaluate(() => globalThis.fixtureEvents.filter(e => e.event === 'notice' || (e.event === 'cdp' && /Dialog/.test(e.data?.method ?? ''))).map(e => ({ event: e.event, kind: e.data?.kind, method: e.data?.method, type: e.data?.dialogType }))), sleep(3000).then(() => 'worker unreachable')]); } catch { /* ignore */ } results.push({ name, status: 'fail', ms: Date.now() - started, error: String(error.stack ?? error).slice(0, 1500), evidence: EV }); console.log(`FAIL ${name}: ${String(error.message).slice(0, 300)}`); }
}
const shot = async (page, name) => { try { await page.screenshot({ path: `${shots}/${name}.png` }); return `${shots}/${name}.png`; } catch { return undefined; } };
const refOf = (text, pattern) => { for (const line of text.split('\n')) if (pattern.test(line)) { const m = /\[?ref=(e\d+)|@(e\d+)|\b(e\d+)\b/.exec(line); if (m) return '@' + (m[1] ?? m[2] ?? m[3]); } return undefined; };
const countPixels = (page, b64, mime, rect, rgb) => page.evaluate(async ({ b64, mime, rect, rgb }) => {
  const img = new Image(); img.src = `data:${mime};base64,${b64}`; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const scale = img.width / (rect.vw || img.width);
  const x = Math.round(rect.x * scale), y = Math.round(rect.y * scale), w = Math.round(rect.w * scale), h = Math.round(rect.h * scale);
  const d = g.getImageData(x, y, w, h).data; let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - rgb[0]) < 60 && Math.abs(d[i + 1] - rgb[1]) < 60 && Math.abs(d[i + 2] - rgb[2]) < 60) n++;
  return { magenta: n, pixels: w * h, image: [img.width, img.height] };
}, { b64, mime, rect, rgb });

try {
  await launch();
  extensionId = new URL(worker.url()).host;
  { const keep = await context.newPage(); await keep.goto(`chrome-extension://${extensionId}/rig-keepalive.html`); }
  // The isolated profile needs developer mode for an unpacked extension to be managed (same step as the controls proof).
  const inspector = await context.newPage(); await inspector.goto('chrome://extensions/');
  await inspector.waitForFunction(() => Boolean(globalThis.chrome?.developerPrivate?.getProfileConfiguration));
  const cfg = await inspector.evaluate(() => chrome.developerPrivate.getProfileConfiguration());
  if (!cfg.inDeveloperMode) { assert.notEqual(cfg.isDeveloperModeControlledByPolicy, true); await inspector.evaluate(() => new Promise((res, rej) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => { const e = chrome.runtime.lastError; e ? rej(Error(e.message)) : res(); }))); }
  await inspector.close();
  const hello = await worker.evaluate(() => globalThis.fixtureHello); profileId = hello.profileId;
  const broker = { profiles: () => [hello], request: async (requested, message) => { assert.equal(requested, profileId); return worker.evaluate(m => globalThis.fixtureBrokerRequest(m), message); } };
  const stateDir = await mkdtemp(join(scratch, 'engine-state-'));
  service = await createBrowserExtensionService({ broker, workspaceId: 'surfaces_proof', stateFile: join(stateDir, 'private', 'browser-extension.json'),
    // Only the sites the task's owner allowed: any other site is asked and answered No, never auto-allowed by the rig.
    createEngine: engineOptions => (fakeEngineMode ? fakeEngine(engineOptions) : new BrowserExtensionEngine(engineOptions)),
    askSite: async (context, origin) => (siteAllow.get(context.bindingId)?.has(origin) ? 'allow' : 'never'),
    askAction: async (context, action) => { const entry = { at: Date.now(), bindingId: context.bindingId, name: action.name, summary: action.summary, mutation: action.mutation }; cards.push(entry); const answer = await decide(context, action); entry.answer = answer; return answer; },
    ownerInstruction: context => instructions.get(context.bindingId) });
  eventPump = setInterval(() => { if (!pumpStopped) void drain().catch(error => { pumpError ??= error; }); }, 10);
  const meta = { browser: await context.browser().version(), exe, loader, platform: platform(), fixture: { origin: fixture.origin, alt: fixture.altOrigin } };
  await writeFile(`${run}/meta.json`, JSON.stringify(meta, null, 2));
  console.log(`rig ready: ${meta.browser} (${loader})`);
  const OWNER = await context.newPage(); // owner-side scratch page for decoding images
  await OWNER.goto(`${fixture.origin}/`);

  // ---------------------------------------------------------------- 1. large page
  await check('large_page', async () => {
    const t = await task('large'); const ev = EV = {};
    let r = await t.tool('open', { url: fixture.url('t3-rows') }); assert.ok(r.ok, r.text);
    const page = await t.owned(); ev.elements = await page.evaluate(() => document.querySelectorAll('*').length); assert.ok(ev.elements > 1400, `elements ${ev.elements}`);
    // The accessibility tree is clamped to one frame (and its depth), and the page is still usable.
    const ownerCdp = await context.newCDPSession(page); await ownerCdp.send('Accessibility.enable');
    const full = await ownerCdp.send('Accessibility.getFullAXTree'); ev.axNodesUnclamped = full.nodes.length; await ownerCdp.detach();
    const ax = await t.raw('Accessibility.getFullAXTree', {}); assert.ok(ax.result, JSON.stringify(ax.error));
    const nodes = ax.result.result.nodes; ev.axNodesClamped = nodes.length; ev.axWireBytes = Buffer.byteLength(JSON.stringify(ax.result));
    assert.ok(ev.axWireBytes <= 1024 * 1024, `ax response ${ev.axWireBytes} bytes`); assert.ok(nodes.length > 100 && nodes.length < full.nodes.length, 'the tree was not clamped');
    // The 1 MiB frame: an oversize answer is refused as too large, the connection stays, the next call works.
    const big = await t.raw('Runtime.evaluate', { expression: `'x'.repeat(2*1024*1024)`, returnByValue: true });
    ev.oversize = big.error?.code ?? 'ACCEPTED'; assert.equal(ev.oversize, 'response_too_large');
    const after = await t.status(); assert.equal(after.state, 'active'); ev.afterOversizeState = after.state;
    // Tools on the big page: snapshot, fill, read (HTML in slices).
    r = await t.tool('snapshot'); assert.ok(r.ok, r.text); ev.snapshotChars = r.text.length;
    const search = refOf(r.text, /search/i); assert.ok(search, 'no search ref in snapshot: ' + r.text.slice(0, 400)); ev.searchRef = search;
    r = await t.tool('fill', { selector: search, text: 'Product 4411' }); assert.ok(r.ok, r.text);
    ev.visibleRows = await page.evaluate(() => document.getElementById('count').textContent); assert.equal(ev.visibleRows, '1');
    r = await t.tool('read', {}); assert.ok(r.ok, r.text); ev.readChars = r.text.length;
    assert.ok(r.text.length < 20400, 'read exceeded its output bound');
    assert.match(r.text, /Showing the first .* characters.*read with filter/s);
    r = await t.tool('read', { filter: 'Product 5000' }); assert.ok(r.ok, r.text);
    ev.lastRowReadChars = r.text.length; assert.ok(r.text.includes('Product 5000'), 'the last row was not in the filtered read');
    ev.screenshot = await shot(page, 'large-page');
    await t.stop(); return ev;
  });
  await check('large_page_deep_ax_clamp', async () => {
    const t = await task('deep'); const ev = EV = {};
    let r = await t.tool('open', { url: fixture.url('s-deep') }); assert.ok(r.ok, r.text);
    const ax = await t.raw('Accessibility.getFullAXTree', {}); assert.ok(ax.result, JSON.stringify(ax.error));
    const nodes = ax.result.result.nodes; const byId = new Map(nodes.map(n => [n.nodeId, n])); let maxDepth = 0;
    for (const n of nodes) { let d = 0, cur = n; while (cur?.parentId && byId.has(cur.parentId) && d < 400) { cur = byId.get(cur.parentId); d++; } maxDepth = Math.max(maxDepth, d); }
    ev.nodes = nodes.length; ev.maxDepth = maxDepth; ev.wireBytes = Buffer.byteLength(JSON.stringify(ax.result));
    assert.ok(maxDepth <= 49, `depth ${maxDepth}`); assert.ok(ev.wireBytes <= 1024 * 1024);
    r = await t.tool('snapshot'); assert.ok(r.ok, r.text); ev.snapshotOk = true;
    await t.stop(); return ev;
  });

  // ---------------------------------------------------------------- 2. iframes
  await check('iframes_focus_and_targets_refused', async () => {
    const t = await task('frames', { sites: [fixture.origin, fixture.altOrigin] }); const ev = EV = {};
    let r = await t.tool('open', { url: fixture.url('iframes') }); assert.ok(r.ok, r.text);
    r = await t.tool('snapshot'); assert.ok(r.ok, `a page with frames must stay usable: ${r.text}`); ev.snapshot = r.text.slice(0, 600);
    const page = await t.owned(); const mark = fixture.mark();
    r = await t.tool('click', { selector: '#outer-button' }); assert.ok(r.ok, r.text);
    assert.equal(ownerLog(mark, { page: 'iframes' }).filter(e => e.kind === 'click').length, 1); ev.outerClick = 'recorded';
    for (const which of ['same-origin-frame', 'cross-origin-frame']) {
      const frame = page.frames().find(f => f !== page.mainFrame() && (which === 'same-origin-frame' ? f.url().startsWith(fixture.origin) : f.url().startsWith(fixture.altOrigin)));
      assert.ok(frame, `frame ${which} not found`);
      await frame.evaluate(() => document.getElementById('inner-field').focus());
      const pressed = await t.tool('press', { key: 'a' });
      ev[which] = { ok: pressed.ok, text: pressed.text.slice(0, 200) };
      assert.equal(pressed.ok, false); assert.match(pressed.text, /embedded frame/i);
    }
    // Typed into a frame by the bot: nothing may have reached either frame.
    assert.equal(fixture.actions({ since: mark, page: 'frames-inner' }).filter(e => ['click', 'input', 'change'].includes(e.kind)).length, 0); ev.frameEvents = 0;
    // A target that lives in a frame cannot be named from the page's own tree.
    const inner = await t.tool('click', { selector: '#inner-button' }); ev.innerClick = { ok: inner.ok, text: inner.text.slice(0, 200) };
    assert.equal(fixture.actions({ since: mark, page: 'frames-inner' }).filter(e => e.kind === 'click').length, 0);
    await t.stop(); return ev;
  });
  await check('iframes_screenshot_hides_other_sites_frames', async () => {
    const t = await task('shotframe', { sites: [fixture.origin, fixture.altOrigin] }); const ev = EV = {};
    let r = await t.tool('open', { url: fixture.url('h8-checkout') }); assert.ok(r.ok, r.text);
    const page = await t.owned(); const frame = page.frames().find(f => f !== page.mainFrame() && f.url().startsWith(fixture.altOrigin)); assert.ok(frame, 'pay frame missing');
    await frame.evaluate(() => { document.body.style.background = '#ff00ff'; const i = document.getElementById('cc-number'); i.value = '4242 4242 4242 4242'; });
    await page.evaluate(() => document.getElementById('pay-frame').scrollIntoView({ block: 'center' })); await sleep(300);
    const rect = await page.evaluate(() => { const e = document.getElementById('pay-frame').getBoundingClientRect(); return { x: e.x, y: e.y, w: e.width, h: e.height, vw: innerWidth }; });
    await page.bringToFront(); await sleep(500);
    const control = await page.screenshot({ type: 'png', timeout: 40000 }); await writeFile(`${shots}/frame-owner-view.png`, control); ev.rect = rect;
    ev.control = await countPixels(OWNER, control.toString('base64'), 'image/png', rect, [255, 0, 255]); assert.ok(ev.control.magenta > rect.w * rect.h * 0.3, 'control screenshot should show the frame');
    const viaRuntime = await t.raw('Page.captureScreenshot', { format: 'png' }); assert.ok(viaRuntime.result, JSON.stringify(viaRuntime.error));
    ev.runtime = await countPixels(OWNER, viaRuntime.result.result.data, 'image/jpeg', rect, [255, 0, 255]); assert.ok(ev.runtime.magenta < rect.w * rect.h * 0.02, `frame visible in the bot's capture: ${JSON.stringify(ev.runtime)}`);
    const viaTool = await t.tool('screenshot', {}); assert.ok(viaTool.ok, viaTool.text);
    const image = viaTool.value.content.find(c => c.type === 'image'); assert.ok(image, 'tool screenshot has no image');
    ev.tool = await countPixels(OWNER, image.data, image.mimeType ?? 'image/png', rect, [255, 0, 255]); assert.ok(ev.tool.magenta < rect.w * rect.h * 0.02, `frame visible in the tool screenshot: ${JSON.stringify(ev.tool)}`);
    // The mask is lifted again: the owner still sees the frame, and the frame element keeps its own style.
    ev.afterVisibility = await page.evaluate(() => ({ visibility: getComputedStyle(document.getElementById('pay-frame')).visibility, mask: document.getElementById('pay-frame').hasAttribute('data-murage-frame-mask'), inline: document.getElementById('pay-frame').style.visibility }));
    assert.equal(ev.afterVisibility.visibility, 'visible'); assert.equal(ev.afterVisibility.mask, false); assert.equal(ev.afterVisibility.inline, '');
    await page.bringToFront(); const after = await page.screenshot({ type: 'png', timeout: 40000 }); ev.afterControl = await countPixels(OWNER, after.toString('base64'), 'image/png', rect, [255, 0, 255]); assert.ok(ev.afterControl.magenta > rect.w * rect.h * 0.3);
    await writeFile(`${shots}/frame-bot-view.jpg`, Buffer.from(viaRuntime.result.result.data, 'base64')); await writeFile(`${shots}/frame-owner-view.png`, control);
    ev.shots = [`${shots}/frame-bot-view.jpg`, `${shots}/frame-owner-view.png`];
    await t.stop(); return ev;
  });

  // ---------------------------------------------------------------- 3. popups and target=_blank
  await check('popups_and_new_tabs', async () => {
    const t = await task('popups', { sites: [fixture.origin] }); const ev = EV = {};
    let r = await t.tool('open', { url: fixture.url('s-popups') }); assert.ok(r.ok, r.text);
    const page = await t.owned();
    const list0 = await t.tool('tab_list'); ev.tabsBefore = (list0.text.match(/tabId|tab_id|"tabId"/g) ?? []).length;
    // Same approved site in a new tab: adopted, and the bot is told.
    r = await t.tool('click', { selector: '#same-site-blank' }); assert.ok(r.ok, r.text);
    await sleep(1500); ev.workerNotices = await worker.evaluate(() => globalThis.fixtureEvents.filter(e => e.event === 'notice').map(e => e.data)); ev.tabsAfterClick = (await t.status()).tabs.map(x => ({ tabId: x.tabId, origin: x.origin })); ev.pages = context.pages().map(p => p.url().slice(0, 70)); ev.tabLog = await worker.evaluate(() => globalThis.fixtureTabLog ?? []); ev.allTabs = await worker.evaluate(() => new Promise(res => chrome.tabs.query({}, tabs => res(tabs.map(t => ({ id: t.id, url: t.url, opener: t.openerTabId, groupId: t.groupId, active: t.active })))))); const notes = [r.text]; r = await t.tool('tab_list'); notes.push(r.text); ev.sameSiteNotice = notes.join(' | ').slice(0, 600);
    assert.match(notes.join(' '), /now shared with you/i, 'the adopted tab was not announced');
    const tabs = (await t.status()).tabs; ev.sharedTabs = tabs.length; assert.equal(tabs.length, 2);
    // Another site in a new tab: stays private, and the bot is told so.
    const before = (await t.status()).tabs.length;
    r = await t.tool('click', { selector: '#other-site-blank' }); assert.ok(r.ok, r.text);
    await sleep(1500); const notes2 = [r.text]; r = await t.tool('tab_list'); notes2.push(r.text); ev.otherSiteNotice = notes2.join(' | ').slice(0, 600);
    assert.match(notes2.join(' '), /stays private|private/i, 'the private tab was not announced');
    assert.equal((await t.status()).tabs.length, before, 'an unapproved site became shared');
    // The same through window.open from a script.
    r = await t.tool('click', { selector: '#open-other-popup' }); assert.ok(r.ok, r.text);
    await sleep(1500); const notes3 = [r.text]; r = await t.tool('tab_list'); notes3.push(r.text); ev.popupNotice = notes3.join(' | ').slice(0, 600);
    assert.match(notes3.join(' '), /stays private|private/i, 'the window.open popup on another site was not announced as private');
    assert.equal((await t.status()).tabs.length, before);
    ev.pagesInBrowser = context.pages().map(p => p.url().slice(0, 60));
    ev.shot = await shot(page, 'popups');
    for (const p of context.pages()) if (p.url().includes('t6-report') || p.url().includes('t5-site-b')) await p.close().catch(() => {});
    await t.stop(); return ev;
  });

  // ---------------------------------------------------------------- 4. JavaScript dialogs
  const dialogLog = since => worker.evaluate(s => globalThis.fixtureCdpLog.filter(e => e.at >= s && /Dialog/.test(e.method)), since);
  await check('dialogs_alert_confirm_prompt', async () => {
    const ev = EV = {};
    const t = await task('dialogs'); let r = await t.tool('open', { url: fixture.url('t8-dialogs') }); assert.ok(r.ok, r.text);
    const page = await t.owned();
    // alert: nobody answers; the engine dismisses it itself, the click returns, the bot is told in the page's own words.
    let since = Date.now(), before = t.cardsFor().length, mark = fixture.mark();
    r = await t.tool('click', { selector: '#do-alert' }); assert.ok(r.ok, r.text);
    ev.alert = { text: r.text.slice(0, 260), answers: await dialogLog(since), cards: t.cardsFor().slice(before).map(c => c.summary.split('\n')[0]), result: await page.locator('#result').textContent(), recorded: ownerLog(mark, { kind: 'dialog' }).map(e => e.detail) };
    assert.match(r.text, /opened a alert dialog/); assert.match(r.text, /comes from the page, not from the owner/); assert.equal(ev.alert.result, 'alert dismissed'); assert.ok(ev.alert.answers.some(a => a.accept === true), 'the engine did not dismiss the alert');
    // confirm: the owner answers it in the browser (OK); Murage sends no answer of its own.
    ownerDialog = async dialog => { await sleep(1200); ev.confirmSeen = { type: dialog.type(), message: dialog.message() }; await dialog.accept(); };
    since = Date.now(); mark = fixture.mark();
    r = await t.tool('click', { selector: '#do-confirm' });
    ev.confirm = { ok: r.ok, text: r.text.slice(0, 260), answers: await dialogLog(since), result: await page.locator('#result').textContent(), recorded: ownerLog(mark, { kind: 'dialog' }).map(e => e.detail) };
    assert.ok(r.ok, `the click did not return after the owner answered: ${r.text}`); assert.equal(ev.confirm.result, 'confirm=true'); assert.equal(ev.confirm.answers.length, 0, 'Murage answered a confirm itself');
    assert.match(r.text, /opened a confirm dialog/);
    // prompt with text the owner typed.
    ownerDialog = async dialog => { await sleep(1200); ev.promptSeen = { type: dialog.type(), message: dialog.message(), default: dialog.defaultValue() }; await dialog.accept('Owner typed this'); };
    since = Date.now(); mark = fixture.mark();
    r = await t.tool('click', { selector: '#do-prompt' });
    ev.prompt = { ok: r.ok, text: r.text.slice(0, 260), answers: await dialogLog(since), result: await page.locator('#result').textContent(), recorded: ownerLog(mark, { kind: 'dialog' }).map(e => e.detail) };
    assert.ok(r.ok, r.text); assert.equal(ev.prompt.result, 'prompt=Owner typed this'); assert.equal(ev.prompt.answers.length, 0); assert.match(r.text, /opened a prompt dialog/);
    ownerDialog = undefined;
    ev.shot = await shot(page, 'dialogs');
    await t.stop(); return ev;
  });
  await check('dialog_unanswered_then_owner_answers', async () => {
    const ev = EV = {};
    const t = await task('dialogwait'); let r = await t.tool('open', { url: fixture.url('t8-dialogs') }); assert.ok(r.ok, r.text);
    const page = await t.owned(); const started = Date.now(); pendingDialogs.length = 0;
    // The bot clicks a button whose handler opens a confirm; nobody answers. The call stays blocked (Chrome holds the click); measure, then let the owner answer by hand.
    let done; const call = t.tool('click', { selector: '#do-confirm' }).then(x => { done = { ms: Date.now() - started, ok: x.ok, text: x.text.slice(0, 200) }; return x; });
    await sleep(20000); ev.stillBlockedAt20s = done === undefined; ev.dialogOpen = pendingDialogs.length === 1 ? pendingDialogs[0].type() : pendingDialogs.length;
    assert.equal(ev.dialogOpen, 'confirm', 'the confirm did not open');
    ev.stateWhileBlocked = await Promise.race([t.status().then(s => s.state, e => String(e.code ?? e.message)), sleep(5000).then(() => 'status hung')]);
    await pendingDialogs[0].dismiss(); ev.ownerAnsweredAtMs = Date.now() - started;
    const settled = await Promise.race([call.then(() => 'returned'), sleep(60000).then(() => 'still blocked 60 s after the owner answered')]);
    ev.afterOwnerAnswer = { settled, ...(done ?? {}) };
    ev.pageResult = await page.locator('#result').textContent().catch(() => 'unreadable');
    ev.stateAfter = await Promise.race([t.status().then(s => s.state, e => String(e.code ?? e.message)), sleep(8000).then(() => 'status hung')]);
    assert.equal(settled, 'returned', 'the click never returned after the owner answered the dialog'); assert.equal(ev.pageResult, 'confirm=false');
    await t.stop(); return ev;
  });
  await check('dialog_prompt_text_on_card_real_chrome', async () => {
    const ev = EV = {};
    fakeEngineMode = true;
    try {
      const t = await task('dialogcard');
      let r = await t.raw('Page.navigate', { url: fixture.url('t8-dialogs') }); // bootstrap tab to the fixture page through the real extension
      assert.ok(r.result, JSON.stringify(r.error)); await sleep(1200);
      const page = await t.owned(); assert.ok(page, 'no owned page');
      // The page opens a prompt by itself shortly after; the owner is not answering it.
      const decisions = []; decide = async (context, action) => { decisions.push(action.summary); return true; };
      ev.dialog = 'prompt';
      r = await t.tool('click', { selector: '#do-prompt' }); ev.click = { ok: r.ok, text: r.text.slice(0, 300) };
      decide = async () => true;
      ev.cards = t.cardsFor().map(c => c.summary); ev.decisions = decisions;
      const card = decisions.find(text => /Answer the page's prompt dialog/.test(text)); assert.ok(card, 'no dialog card was raised: ' + JSON.stringify(decisions));
      assert.match(card, /Text the bot will enter: "Murage bot text"/); assert.match(card, /From the page, written by the site and not by Murage: "Name for the report\?"/);
      ev.pageResult = await page.locator('#result').textContent(); assert.equal(ev.pageResult, 'prompt=Murage bot text');
      ev.shot = await shot(page, 'dialog-card');
      await t.stop();
    } finally { fakeEngineMode = false; }
    return ev;
  });

  // Tool results recorded as evidence, shared by the checks below.
  const toolEvidence = result => ({ ok: result.ok, text: result.text, ...(result.code ? { code: result.code } : {}) });

  // ---------------------------------------------------------------- 5. downloads
  await check('downloads_filename_step', async () => {
    const ev = EV = {};
    const t = await task('downloads'); let r = await t.tool('open', { url: fixture.url('s-downloads') }); assert.ok(r.ok, r.text);
    const page = await t.owned();
    const items = () => worker.evaluate(() => new Promise(res => chrome.downloads.search({}, res)));
    const log = since => worker.evaluate(s => globalThis.fixtureDownloadLog.filter(e => e.at >= s), since);
    // small
    let mark = fixture.mark(), since = Date.now();
    r = await t.tool('click', { selector: '#small-download' }); ev.smallClick = toolEvidence(r); await sleep(1500);
    let after = await t.tool('get_title'); ev.smallTitle = toolEvidence(after); ev.small = { clickOk: r.ok, listener: await log(since), items: (await items()).map(i => ({ state: i.state, filename: String(i.filename).split(/[\\/]/).pop(), error: i.error })), notice: (r.text + ' ' + after.text).match(/tried to download[^.]*\./)?.[0] };
    assert.ok(ev.small.listener.some(e => e.event === 'determining'), 'the downloads API never asked the extension (no filename step)');
    // Brave sometimes delivers the page's own download event after the 500 ms the filename step waits: the file is then cancelled by the late path (nothing is saved) and the finding is recorded, not hidden.
    ev.small.cancelledAtFilenameStep = ev.small.listener.some(e => e.event === 'decided' && e.cancelled === true);
    if (!ev.small.cancelledAtFilenameStep) { await sleep(1500); ev.small.lateCancel = true; ev.small.itemsAfterWait = (await items()).map(i => ({ state: i.state, filename: String(i.filename).split(/[\\/]/).pop() })); ev.small.downloadsFolderAfterWait = await readdir(join(process.env.HOME, 'Downloads')).catch(() => []); assert.ok(ev.small.itemsAfterWait.length === 0 && ev.small.downloadsFolderAfterWait.length === 0, 'a file was saved after the late cancel'); }
    assert.ok(!ev.small.items.some(i => i.state === 'complete'), 'a small file completed');
    ev.small.downloadsFolder = await readdir(join(process.env.HOME, 'Downloads')).catch(() => []); assert.deepEqual(ev.small.downloadsFolder, [], 'files were left in the downloads folder: ' + ev.small.downloadsFolder.join(',')); assert.ok(ev.small.notice, 'the bot was not told');
    // large
    mark = fixture.mark(); since = Date.now();
    r = await t.tool('click', { selector: '#big-download' }); ev.largeClick = toolEvidence(r); await sleep(2500);
    after = await t.tool('get_title'); ev.largeTitle = toolEvidence(after);
    ev.binding = service.status().bindings.find(b => b.bindingId === t.bindingId);
    const closed = fixture.events({ since: mark, kind: 'download-closed' });
    ev.large = { clickOk: r.ok, listener: await log(since), serverClosed: closed.map(e => e.detail), items: (await items()).map(i => ({ state: i.state, filename: String(i.filename).split(/[\\/]/).pop(), bytesReceived: i.bytesReceived, error: i.error })), notice: (r.text + ' ' + after.text).match(/archive\.bin[^.]*\./)?.[0] };
    // The cancel may come from downloads.onCreated (a referrer of the bot's own tab during its action) or from the filename step; either way nothing may be saved.
    ev.large.cancelledBy = ev.large.listener.some(e => e.event === 'decided' && e.cancelled === true) ? 'filename step' : 'downloads.onCreated while the action ran';
    ev.large.downloadsFolder = await readdir(join(process.env.HOME, 'Downloads')).catch(() => []); assert.deepEqual(ev.large.downloadsFolder, [], 'files were left in the downloads folder: ' + ev.large.downloadsFolder.join(','));
    assert.ok(!ev.large.items.some(i => i.state === 'complete' || i.state === 'in_progress'), 'a large file is downloading or complete');
    assert.ok(closed.length >= 1 && closed.every(e => e.detail.complete === false), 'the server saw the large transfer finish: ' + JSON.stringify(closed.map(e => e.detail)));
    // owner's own download in the shared tab (known Low L3): blocked while connected.
    since = Date.now();
    await page.evaluate(() => document.getElementById('small-download').click()); await sleep(1500);
    ev.ownerInSharedTab = { listener: await log(since), items: (await items()).filter(i => i.state === 'complete').map(i => String(i.filename).split(/[\\/]/).pop()) };
    ev.ownerInSharedTab.blocked = ev.ownerInSharedTab.listener.some(e => e.event === 'decided' && e.cancelled === true);
    // control: a tab the bot does not share downloads normally.
    since = Date.now();
    const free = await context.newPage(); await free.goto(fixture.url('s-downloads')); await free.evaluate(() => document.getElementById('small-download').click()); await sleep(2000);
    ev.ownerInOtherTab = { listener: await log(since), complete: (await items()).filter(i => i.state === 'complete').map(i => String(i.filename).split(/[\\/]/).pop()) };
    // The extension must leave an unshared tab's download alone ("decided: false"). Whether the browser then saves it headless is the browser's own business (Brave saves nothing headless), so a missing file is recorded, not failed.
    const untouched = ev.ownerInOtherTab.listener.some(e => e.event === 'decided' && e.cancelled === false) && !ev.ownerInOtherTab.listener.some(e => e.event === 'decided' && e.cancelled === true);
    ev.ownerInOtherTab.savedByBrowser = ev.ownerInOtherTab.complete.includes('receipt.txt');
    assert.ok(untouched, 'the extension interfered with a download in a tab the bot does not share: ' + JSON.stringify(ev.ownerInOtherTab));
    await free.close(); await t.stop(); return ev;
  });

  // ---------------------------------------------------------------- 6. shadow DOM
  await check('shadow_open_only', async () => {
    const t = await task('shadow'); const ev = EV = {};
    let r = await t.tool('open', { url: fixture.url('shadow-open') }); assert.ok(r.ok, r.text);
    const page = await t.owned();
    r = await t.tool('snapshot'); assert.ok(r.ok, r.text); ev.snapshot = r.text.slice(0, 800);
    const openBtn = refOf(r.text, /open button/i), openInput = refOf(r.text, /open shadow input/i);
    ev.refs = { openBtn, openInput };
    assert.ok(openBtn, 'open shadow button not in the snapshot');
    // Filling is quiet. Then add an anonymous control to exercise strict uncertainty
    // beside the readable open-root field, without skipping the click proof.
    assert.ok(openInput, 'open shadow input not in the snapshot');
    r = await t.tool('fill', { selector: openInput, text: 'in the open root' }); assert.ok(r.ok, r.text);
    ev.openFill = await page.evaluate(() => document.getElementById('open-host').shadowRoot.querySelector('input').value);
    assert.equal(ev.openFill, 'in the open root');
    await page.evaluate(() => document.getElementById('open-host').shadowRoot.append(document.createElement('input')));
    const mark = fixture.mark(), beforeCards = t.cardsFor().length;
    r = await t.tool('click', { selector: openBtn });
    ev.strictClick = toolEvidence(r);
    ev.recipientCards = t.cardsFor().slice(beforeCards).map(c => c.summary);
    const asked = ev.recipientCards.some(text => /could not check who this goes to|could not read who this goes to/.test(text));
    const handedBack = !r.ok && /YOUR TURN/.test(r.text);
    assert.ok(asked || handedBack, 'unresolved open-root field neither asked the owner nor handed back');
    const clicks = ownerLog(mark, { kind: 'click' }).filter(e => e.detail.rec === 'shadow-open').length;
    if (r.ok) { assert.ok(asked, 'a send ran without the recipient decision'); assert.equal(clicks, 1); }
    else { assert.ok(handedBack, r.text); assert.equal(clicks, 0); }
    ev.openClick = clicks;
    ev.shot = await shot(page, 'shadow-open');
    await t.stop(); return ev;
  });
  await check('shadow_closed_handoff', async () => {
    const t = await task('shadowclosed'); const ev = EV = {};
    const mark = fixture.mark();
    const opened = await t.tool('open', { url: fixture.url('shadow') });
    ev.open = { ok: opened.ok, text: opened.text.slice(0, 240) };
    const r = await t.tool('snapshot'); ev.snapshot = { ok: r.ok, text: r.text.slice(0, 240) };
    assert.equal(r.ok, false); assert.match(r.text, /YOUR TURN/);
    assert.equal(service.status().bindings.find(b => b.bindingId === t.bindingId).pausedReason, 'handoff');
    const click = await t.tool('click', { selector: 'text=Shadow closed button' });
    assert.equal(click.ok, false); assert.match(click.text, /YOUR TURN/);
    assert.equal(ownerLog(mark, { kind: 'click' }).filter(e => e.detail.rec === 'shadow-closed').length, 0);
    ev.closedReached = 0;
    await t.stop(); return ev;
  });
  await check('shadow_private_field_appears_later', async () => {
    const t = await task('shadowlate'); const ev = EV = {};
    let r = await t.tool('open', { url: fixture.url('s-shadow-late') }); assert.ok(r.ok, r.text);
    const page = await t.owned();
    r = await t.tool('snapshot'); assert.ok(r.ok, r.text); ev.before = 'readable';
    await page.evaluate(() => window.__addPrivateField());
    r = await t.tool('snapshot'); ev.afterAdd = { ok: r.ok, text: r.text.slice(0, 200) }; assert.equal(r.ok, false); assert.match(r.text, /take over/i);
    const mark = fixture.mark(); r = await t.tool('click', { selector: '#late-status' }); ev.clickAfter = { ok: r.ok, text: r.text.slice(0, 120) }; assert.equal(r.ok, false);
    await page.evaluate(() => document.getElementById('late-host').shadowRoot.querySelector('input[type=password]').remove());
    r = await t.tool('snapshot'); ev.afterRemove = { ok: r.ok, text: r.text.slice(0, 240) };
    assert.equal(r.ok, false); assert.match(r.text, /YOUR TURN/);
    // The app's owner Continue asks the runtime to resume, then consumes its resumed event.
    await service.continueHandoff(t.bindingId);
    const continuedBy = Date.now() + 20000;
    do { await drain(); if (service.status().bindings.find(b => b.bindingId === t.bindingId).state === 'active') break; await sleep(20); } while (Date.now() < continuedBy);
    assert.equal(service.status().bindings.find(b => b.bindingId === t.bindingId).state, 'active');
    r = await t.tool('snapshot'); ev.afterContinue = { ok: r.ok, text: r.text.slice(0, 240) }; assert.ok(r.ok, r.text);
    await t.stop(); return ev;
  });

  // ---------------------------------------------------------------- 7. navigate between approval and input
  await check('race_navigate_between_approval_and_input', async () => {
    const t = await task('race'); const ev = EV = {};
    let r = await t.tool('open', { url: fixture.url('s-race-a') }); assert.ok(r.ok, r.text);
    const page = await t.owned();
    r = await t.tool('snapshot'); assert.ok(r.ok, r.text); const go = refOf(r.text, /\bGo\b/); assert.ok(go, 'no Go ref: ' + r.text.slice(0, 300));
    const mark = fixture.mark();
    decide = async () => { await page.goto(fixture.url('s-race-b')); return true; };
    try { r = await t.tool('click', { selector: go }); } finally { decide = async () => true; }
    ev.refusal = { ok: r.ok, text: r.text.slice(0, 240) }; assert.equal(r.ok, false);
    ev.clicksAfter = ownerLog(mark, { kind: 'click' }).map(e => `${e.page}:${e.detail.text}`); assert.equal(ev.clicksAfter.length, 0, 'an input reached a page: ' + ev.clicksAfter.join(','));
    await t.stop(); return ev;
  });
  await check('race_navigate_stress', async () => {
    const ev = EV = { iterations: 0, reachedB: 0, reachedA: 0, refused: 0, completed: 0 }; const N = Number(process.env.MURAGE_RACE_N ?? 24);
    for (let i = 0; i < N; i++) {
      const t = await task('stress'); let r = await t.tool('open', { url: fixture.url('s-race-a') }); if (!r.ok) throw Error('open: ' + r.text);
      const page = await t.owned(); r = await t.tool('snapshot'); const go = refOf(r.text, /\bGo\b/); if (!go) throw Error('no ref: ' + r.text.slice(0, 200));
      const mark = fixture.mark(); const delay = Math.floor(Math.random() * 40);
      decide = async () => { setTimeout(() => { void page.evaluate(url => { location.href = url; }, fixture.url('s-race-b')).catch(() => {}); }, delay); return true; };
      try { r = await t.tool('click', { selector: go }); } finally { decide = async () => true; }
      await sleep(250);
      const clicks = ownerLog(mark, { kind: 'click' }); ev.iterations++;
      ev.reachedB += clicks.filter(e => e.page === 's-race-b').length; ev.reachedA += clicks.filter(e => e.page === 's-race-a').length;
      if (r.ok) ev.completed++; else ev.refused++;
      await t.stop();
    }
    assert.equal(ev.reachedB, 0, `inputs reached the new document in ${ev.reachedB} of ${N} runs`);
    return ev;
  });

  // ---------------------------------------------------------------- 8. clipboard shortcuts
  await check('clipboard_shortcuts_refused', async () => {
    const t = await task('clip'); const ev = EV = { refused: {} };
    let r = await t.tool('open', { url: fixture.url('s-clip') }); assert.ok(r.ok, r.text);
    const page = await t.owned(); r = await t.tool('snapshot'); assert.ok(r.ok, r.text);
    const field = refOf(r.text, /clip field/i); assert.ok(field, 'no clip field ref: ' + r.text.slice(0, 300));
    r = await t.tool('click', { selector: field }); assert.ok(r.ok, r.text);
    const keys = platform() === 'darwin' ? ['Meta+V', 'Meta+C', 'Meta+X', 'Meta+A', 'Control+V', 'Shift+Insert'] : ['Control+V', 'Control+C', 'Control+X', 'Control+A', 'Shift+Insert', 'Control+Insert'];
    for (const key of keys) { r = await t.tool('press', { key }); ev.refused[key] = { ok: r.ok, text: r.text.slice(0, 120) }; assert.equal(r.ok, false, key); assert.match(r.text, /Pasting, copying and select-all/); }
    ev.value = await page.locator('#clip-field').inputValue(); assert.equal(ev.value, 'original');
    // The same keys sent below the tool: the extension refuses them itself.
    const modifier = platform() === 'darwin' ? 4 : 2;
    const rawKey = await t.raw('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: modifier, windowsVirtualKeyCode: 86 }); ev.rawKey = rawKey.error?.code; assert.equal(rawKey.error?.code, 'clipboard_denied');
    const rawCommand = await t.raw('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', commands: ['paste'] }); ev.rawCommand = rawCommand.error?.code; assert.equal(rawCommand.error?.code, 'clipboard_denied');
    // A normal key still works (positive control).
    r = await t.tool('press', { key: 'x' }); ev.normalKey = { ok: r.ok, text: r.text.slice(0, 100) }; assert.ok(r.ok, r.text);
    ev.afterNormal = await page.locator('#clip-field').inputValue();
    await t.stop(); return ev;
  });

  // ---------------------------------------------------------------- 9. Resume after Stop, through the real side panel
  await check('resume_after_stop_real_panel', async () => {
    const t = await task('panel'); const ev = EV = {};
    let r = await t.tool('open', { url: fixture.url('s-race-a') }); assert.ok(r.ok, r.text);
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    const stateTitle = text => panel.locator('[data-role="state-title"]').filter({ hasText: text });
    await stateTitle(/ is working$/).waitFor();
    // Pause then Resume with the real button works.
    await service.pause(t.bindingId); await drain();
    await stateTitle(/^Paused$/).waitFor({ timeout: 20000 });
    ev.pausedResumeVisible = await panel.getByRole('button', { name: 'Resume', exact: true }).isVisible(); assert.equal(ev.pausedResumeVisible, true);
    await panel.screenshot({ path: `${shots}/panel-paused.png` });
    await panel.getByRole('button', { name: 'Resume', exact: true }).click();
    await stateTitle(/ is working$/).waitFor({ timeout: 20000 }); ev.resumedFromPause = true;
    // Stop with the real button; Resume is gone and a Resume message is refused.
    await panel.getByRole('button', { name: 'Stop', exact: true }).click();
    await stateTitle(/^Stopped$/).waitFor({ timeout: 20000 });
    ev.stoppedResumeVisible = await panel.getByRole('button', { name: 'Resume', exact: true }).isVisible().catch(() => false); assert.equal(ev.stoppedResumeVisible, false);
    await panel.screenshot({ path: `${shots}/panel-stopped.png` }); ev.shots = [`${shots}/panel-paused.png`, `${shots}/panel-stopped.png`];
    const answer = await panel.evaluate(id => chrome.runtime.sendMessage({ action: 'resume', bindingId: id }), t.bindingId); ev.resumeMessage = answer; assert.equal(answer?.error, 'binding_stopped');
    await panel.evaluate(id => chrome.runtime.sendMessage({ action: 'pause', bindingId: id }), t.bindingId);
    const again = await panel.evaluate(id => chrome.runtime.sendMessage({ action: 'resume', bindingId: id }), t.bindingId); assert.equal(again?.error, 'binding_stopped');
    await drain(); const state = (await panel.evaluate(() => chrome.runtime.sendMessage({ action: 'status' }))).result.bindings.find(b => b.bindingId === t.bindingId).state; ev.state = state; assert.equal(state, 'stopped');
    r = await t.tool('get_title'); ev.toolAfterStop = { ok: r.ok, text: r.text.slice(0, 120) }; assert.equal(r.ok, false);
    await panel.close(); return ev;
  });

  // ---------------------------------------------------------------- 10. free first navigation versus a later cross-origin open with a query
  await check('free_first_navigation_vs_later_open', async () => {
    const ev = EV = {}; const both = [fixture.origin, fixture.altOrigin];
    const counted = async (t, op, args) => { const before = t.cardsFor().length; const r = await t.tool(op, args); return { r, cards: t.cardsFor().length - before }; };
    // A: the owner's instruction names the first address: no card. A later cross-origin open under the same instruction: card.
    const named = `${fixture.origin}/s-search?q=mugs`;
    const a = await task('nav-a', { sites: both, instruction: { id: 'i1', text: `Search for mugs at ${named} and tell me the first result` } });
    let x = await counted(a, 'open', { url: named }); ev.firstNamed = { ok: x.r.ok, cards: x.cards, text: x.r.text.slice(0, 100) }; assert.ok(x.r.ok, x.r.text); assert.equal(x.cards, 0, 'the owner-named first navigation raised a card');
    x = await counted(a, 'open', { url: `${fixture.altOrigin}/t9-routine-new?ref=x` }); ev.laterWithQuery = { ok: x.r.ok, cards: x.cards }; assert.equal(x.cards, 1, 'a later cross-origin open with a query did not raise a card');
    await a.stop();
    // B: a result link the search page presents, first navigation of a new instruction: free; the next cross-origin open with a query: card.
    const b = await task('nav-b', { sites: both, instruction: { id: 'i2', text: `Search for mugs at ${named}` } });
    let y = await counted(b, 'open', { url: named }); assert.ok(y.r.ok, y.r.text);
    instructions.set(b.bindingId, { id: 'i3', text: 'Open the cheaper result' });
    y = await counted(b, 'open', { url: `${fixture.altOrigin}/t9-routine-new` }); ev.presentedResult = { ok: y.r.ok, cards: y.cards, text: y.r.text.slice(0, 100) }; assert.ok(y.r.ok, y.r.text); assert.equal(y.cards, 0, 'the first result link of a search page raised a card');
    y = await counted(b, 'open', { url: `${fixture.origin}/t9-routine-allow?ref=2` }); ev.secondWithQuery = { ok: y.r.ok, cards: y.cards }; assert.equal(y.cards, 1, 'a second open raised no card');
    await b.stop();
    // C: no instruction at all: a cross-origin open with a path needs a card.
    const c = await task('nav-c', { sites: both });
    let z = await counted(c, 'open', { url: `${fixture.altOrigin}/t9-routine-new` }); ev.noInstruction = { ok: z.r.ok, cards: z.cards }; assert.equal(z.cards, 1);
    await c.stop(); return ev;
  });
} catch (error) {
  results.push({ name: 'rig', status: 'fail', error: String(error.stack ?? error).slice(0, 2000) });
  console.log('RIG FAILURE', error);
} finally {
  closing = true;
  pumpStopped = true; clearInterval(eventPump);
  const bounded = (promise, ms = 8000) => Promise.race([promise, sleep(ms)]);
  try { await bounded((async () => { await draining; await service?.close(); })()); } catch { /* ignore */ }
  try { await bounded(browser?.close()); } catch { /* ignore */ }
  try { browserProc?.kill('SIGKILL'); } catch { /* ignore */ }
  await fixture.close().catch(() => {});
  await writeFile(`${run}/cards.json`, JSON.stringify(cards, null, 2)).catch(() => {});
  const summary = { label, run, workerRestarts, workerClosures, results };
  await writeFile(`${run}/results.json`, JSON.stringify(summary, null, 2));
  const failed = results.filter(r => r.status !== 'pass');
  console.log(JSON.stringify({ run, label, pass: results.length - failed.length, fail: failed.length, failed: failed.map(f => f.name) }));
  process.exitCode = failed.length ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 500).unref();
}
