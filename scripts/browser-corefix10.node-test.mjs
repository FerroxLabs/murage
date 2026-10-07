// SPDX-License-Identifier: AGPL-3.0-or-later
// Round 10 real-browser proofs (Codex Astra corefix9 report, R9-05 and R9-06). Chrome for Testing, a fresh temp
// profile, pages served from 127.0.0.1 only. A missing Chrome is a FAILURE (a skipped security gate proves nothing):
//   MURAGE_CFT_CHROME=/path/to/chrome node --test scripts/browser-corefix10.node-test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
import { BrowserExtensionExecutor } from '../server/browser-extension-executor.ts';
import { BrowserExtensionEngine } from '../server/browser-extension-engine.ts';
import { presenceSource, PRESENCE_WORLD } from '../extensions/murage-browser/presence.mjs';

const CHROME = process.env.MURAGE_CFT_CHROME || '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const haveChrome = existsSync(CHROME);
test('Chrome for Testing is present: the round 10 security gate cannot be skipped', () => {
  assert.ok(haveChrome, `no Chrome binary at ${CHROME}. Set MURAGE_CFT_CHROME to Chrome for Testing. A skipped security gate counts as a failure.`);
});

const CLOSED = (tag, html) => `<script>customElements.define(${JSON.stringify(tag)}, class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = ${JSON.stringify(html)}; } });</script>`;
const PAGES = {
  '/lookalike': `<p>Notes</p><murage-presence data-murage-presence></murage-presence>${CLOSED('murage-presence', '<div class="pill"><span>482913</span></div>')}`,
  '/plain': `<p>Notes</p>`,
  '/tall': `<div style="height:5000px">tall</div><button id="b">Go</button>`,
  '/div-composer': `<div id="c"><div id="msg" contenteditable="true">hello</div><button id="send">Send</button></div>`,
  '/to-beside-form': `<input id="to" aria-label="To" value="alice@example.com"><form id="f" onsubmit="return false"><textarea aria-label="Message">hi</textarea><button id="send" type="button">Send</button></form>`,
  '/many-chips': `<div id="c"><div contenteditable="true" aria-label="To">${Array.from({ length: 21 }, (_, i) => `<span data-email="r${i}@example.com">r${i}@example.com</span>`).join('')}</div><div contenteditable="true" id="msg">hi</div><button id="send">Send</button></div>`,
  '/inner': `<textarea id="composer"></textarea>`,
};

function startSite() {
  const server = createServer((req, res) => {
    const html = PAGES[req.url.split('?')[0]];
    res.setHeader('content-type', 'text/html');
    if (!html) { res.statusCode = 404; return res.end('<!doctype html><title>404</title>'); }
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>page</title></head><body>${html}</body></html>`);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise(done => server.close(done)) })));
}

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'mbe-corefix8-'));
  const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let wsUrl;
  for (let i = 0; i < 200 && !wsUrl; i++) {
    await new Promise(r => setTimeout(r, 100));
    try { const [port, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n'); wsUrl = `ws://127.0.0.1:${port}${path}`; } catch { /* not yet */ }
  }
  assert.ok(wsUrl, 'Chrome did not publish its debugging port');
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0; const pending = new Map(); const listeners = [];
  ws.onmessage = event => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); if (message.error) reject(Object.assign(new Error(message.error.message), { code: message.error.code })); else resolve(message.result); }
    else if (message.method) for (const l of listeners) l(message);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const domain of ['Page', 'DOM', 'Runtime', 'Accessibility']) await send(`${domain}.enable`, {}, sessionId);
  const page = {
    url: 'about:blank',
    send: (method, params) => send(method, params, sessionId),
    async goto(url) {
      const loaded = new Promise(resolve => { const l = message => { if (message.method === 'Page.loadEventFired' && message.sessionId === sessionId) { listeners.splice(listeners.indexOf(l), 1); resolve(); } }; listeners.push(l); });
      await send('Page.navigate', { url }, sessionId); await loaded; page.url = url;
    },
    async evaluate(expression, awaitPromise = false) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result.value;
    },
    async target(selector) {
      const { root } = await send('DOM.getDocument', { depth: 0 }, sessionId);
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector }, sessionId);
      assert.ok(nodeId, `no element for ${selector}`);
      const { node } = await send('DOM.describeNode', { nodeId }, sessionId);
      return { backendNodeId: node.backendNodeId, document: { tabId: 1, navigationEpoch: 1 } };
    },
    io: {
      send: (method, params) => send(method, params, sessionId),
      async world() {
        const tree = await send('Page.getFrameTree', {}, sessionId);
        const world = await send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'murage-protected-document-v1' }, sessionId);
        return world.executionContextId;
      },
    },
  };
  const close = async () => {
    try { ws.close(); } catch { /* closing */ }
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL'); await exited;
    try { safeWipeSync(profile); } catch { /* the temp profile is disposable */ }
  };
  return { page, close };
}

/** The executor against the real page, over the raw CDP session; the engine only finds the target and delivers the mouse input. */
function executorFor(page, origin, decisions, extra = {}, frameOfTarget) {
  const doc = () => ({ profileId: 'p', tabId: 1, frameId: 'main', navigationEpoch: 1, origin, url: page.url });
  const executor = new BrowserExtensionExecutor({
    authorize: () => true, access: async () => true, admit: async action => { decisions.push(action); await extra.onAdmit?.(action); return true; },
    createEngine: hooks => ({
      resolveTarget: async selector => { const t = await (extra.target ? extra.target(selector) : page.target(selector)); return { ...t, ...(frameOfTarget ? { frameId: await frameOfTarget(t.backendNodeId) } : {}), document: doc() }; }, resolveTab: async () => doc(), event() {}, async close() {},
      async call(name, args) {
        if (extra.calls?.[name]) await extra.calls[name](hooks, args, doc());
        if (name === 'agent_browser_click') {
          const box = await page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(args.selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
          for (const type of ['mousePressed', 'mouseReleased']) {
            const params = { type, x: box.x, y: box.y, button: 'left', clickCount: 1 };
            await hooks.beforeCommand(doc(), 'Input.dispatchMouseEvent', params);
            await page.send('Input.dispatchMouseEvent', params);
          }
        }
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    }),
    transport: { document: async () => doc(), send: async (method, params) => page.send(method, params) },
  });
  return { executor, doc };
}


async function installPresence(page) {
  const tree = await page.send('Page.getFrameTree', {});
  const world = await page.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: PRESENCE_WORLD });
  const run = async expression => { const r = await page.send('Runtime.evaluate', { expression, contextId: world.executionContextId, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
  await run(presenceSource({}));
  await run("globalThis.__muragePresence.state('driving', {})");
  return run;
}

test('R9-05 a look-alike overlay the page built is refused; the genuine one is not', { skip: !haveChrome && 'no Chrome' }, async () => {
  const site = await startSite(); const browser = await launch();
  try {
    const decisions = []; const { executor, doc } = executorFor(browser.page, `http://127.0.0.1:${site.port}`, decisions);
    await browser.page.goto(`http://127.0.0.1:${site.port}/lookalike`);
    assert.equal(await executor.protectedDocument(doc()), true, 'a page-built murage-presence must be refused');
    await browser.page.goto(`http://127.0.0.1:${site.port}/plain`);
    await installPresence(browser.page);
    assert.equal(await executor.protectedDocument(doc(), true), false, 'the extension-built overlay must not be refused');
  } finally { await browser.close(); await site.close(); }
});

test('R9-06 a page that hides the overlay host cannot make a screenshot unmasked', { skip: !haveChrome && 'no Chrome' }, async () => {
  const site = await startSite(); const browser = await launch();
  try {
    await browser.page.goto(`http://127.0.0.1:${site.port}/plain`);
    const run = await installPresence(browser.page);
    await browser.page.evaluate("document.querySelector('murage-presence').style.setProperty('display', 'none', 'important')");
    const ok = await run("globalThis.__muragePresence.capture(true, [{ x: 10, y: 10, width: 60, height: 20 }])");
    const shown = await browser.page.evaluate("(() => { const h = document.querySelector('murage-presence'); return getComputedStyle(h).display !== 'none' && document.elementFromPoint(40, 20) === h; })()");
    assert.equal(ok === true && shown === true, true, `capture reported ${ok}, mask shown ${shown}`);
  } finally { await browser.close(); await site.close(); }
});

test('R10-09 a page that moves the overlay host away cannot make a displaced mask pass', { skip: !haveChrome && 'no Chrome' }, async () => {
  const site = await startSite(); const browser = await launch();
  try {
    await browser.page.goto(`http://127.0.0.1:${site.port}/plain`);
    const run = await installPresence(browser.page);
    await browser.page.evaluate("document.querySelector('murage-presence').style.setProperty('transform', 'translateX(200vw)', 'important')");
    const ok = await run("globalThis.__muragePresence.capture(true, [{ x: 10, y: 10, width: 60, height: 20 }])");
    const where = await browser.page.evaluate("(() => { const h = document.querySelector('murage-presence'); return getComputedStyle(h).transform; })()");
    assert.ok(ok === false || where === 'none', `capture reported ${ok} with the host transform ${where}`);
  } finally { await browser.close(); await site.close(); }
});

const scrollBy = (page, amount) => async (hooks, _args, document) => {
  const params = { expression: `window.scrollBy(0, ${amount})`, returnByValue: true };
  await hooks.beforeCommand(document, 'Runtime.evaluate', params);
  await page.send('Runtime.evaluate', params);
};

test('C1-D2 the scroll gate in a real page: a scroll operation moves it by a bounded amount; a click cannot, and neither can a huge one', { skip: !haveChrome && 'no Chrome' }, async () => {
  const site = await startSite(); const browser = await launch();
  try {
    const origin = `http://127.0.0.1:${site.port}`;
    await browser.page.goto(`${origin}/tall`);
    const run = (amount) => {
      const decisions = [];
      const { executor } = executorFor(browser.page, origin, decisions, { calls: { agent_browser_scroll: scrollBy(browser.page, amount), agent_browser_click: scrollBy(browser.page, amount) } });
      return executor;
    };
    const y = () => browser.page.evaluate('window.scrollY');
    await run(400).call('agent_browser_scroll', { direction: 'down', amount: 400 });
    assert.equal(await y(), 400, 'a scroll operation moves the page');
    await assert.rejects(run(400).call('agent_browser_click', { selector: '#b' }), /not approved|scroll/i);
    assert.equal(await y(), 400, 'a click may not scroll the page');
    await assert.rejects(run(1e9).call('agent_browser_scroll', { direction: 'down', amount: 400 }));
    assert.equal(await y(), 400, 'an unbounded scroll never reaches the page');
  } finally { await browser.close(); await site.close(); }
});

/** The backend node ids of every textarea the browser's own pierced tree shows (embedded frames included when this session can see them). */
async function textareas(page) {
  const { root } = await page.send('DOM.getDocument', { depth: -1, pierce: true });
  const found = [];
  const walk = node => { if (node.nodeName === 'TEXTAREA') found.push(node.backendNodeId); for (const child of [...(node.children ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]) walk(child); };
  walk(root);
  return found;
}
const realEngine = (page, document) => new BrowserExtensionEngine({ dataDir: '/unused-fixture', realmId: 'w', bindingId: 'b', authorize: () => true, beforeCommand: async () => {}, beforeDestination: async () => {}, transport: { send: async (method, params) => page.send(method, params), documents: async () => [document], selected: async () => document } });

test('C1-frame a composer inside an embedded frame, same-origin or cross-origin, is never the page\'s own node', { skip: !haveChrome && 'no Chrome' }, async () => {
  const outer = await startSite(); const inner = await startSite(); const browser = await launch();
  try {
    const origin = `http://127.0.0.1:${outer.port}`;
    PAGES['/framed-same'] = `<textarea id="top"></textarea><iframe src="${origin}/inner"></iframe>`;
    PAGES['/framed-cross'] = `<textarea id="top"></textarea><iframe src="http://127.0.0.1:${inner.port}/inner"></iframe>`;
    const document = { profileId: 'p', tabId: 1, frameId: 'main', navigationEpoch: 1, origin, url: `${origin}/` };
    const engine = realEngine(browser.page, document);
    const frameOf = id => engine.frameOf(document, id);
    for (const path of ['/framed-same', '/framed-cross']) {
      await browser.page.goto(`${origin}${path}`);
      await new Promise(r => setTimeout(r, 500));
      const ids = await textareas(browser.page);
      assert.ok(ids.length >= 1, 'the top page composer is visible to the browser tree');
      const frames = await Promise.all(ids.map(frameOf));
      assert.equal(frames.filter(f => f === 'main').length, 1, `${path}: exactly the top-level textarea is the page's own (${frames})`);
      assert.ok(frames.every(f => f === 'main' || f === 'main:embedded'));
      assert.equal(await frameOf(2_000_000_000), 'main:embedded', 'a node the page world cannot resolve is embedded');
    }
    // The cross-origin page cannot be reached from the page's own scripts at all.
    assert.equal(await browser.page.evaluate("document.querySelector('iframe').contentDocument"), null);
    // End to end: the executor refuses to act on that node and asks nobody.
    const decisions = []; const [embedded] = (await Promise.all((await textareas(browser.page)).map(async id => [id, await frameOf(id)]))).filter(([, f]) => f !== 'main').concat([[2_000_000_000, 'main:embedded']]);
    const { executor } = executorFor(browser.page, origin, decisions, { target: async () => ({ backendNodeId: embedded[0], document: null }) }, async () => embedded[1]);
    await assert.rejects(executor.call('agent_browser_click', { selector: '#composer' }), /embedded frame/);
    assert.deepEqual(decisions, [], 'no approval card is raised for a node in another frame');
  } finally { await browser.close(); await outer.close(); await inner.close(); }
});

/** Run one click on #send with the page changed while the approval waits; returns what happened. */
async function sendWithChange(path, change) {
  const site = await startSite(); const browser = await launch();
  try {
    const origin = `http://127.0.0.1:${site.port}`;
    await browser.page.goto(`${origin}${path}`);
    const decisions = [];
    const { executor } = executorFor(browser.page, origin, decisions, { onAdmit: async () => { if (change) await browser.page.evaluate(change); } });
    let error; try { await executor.call('agent_browser_click', { selector: '#send' }); } catch (e) { error = e; }
    return { error, decisions };
  } finally { await browser.close(); await site.close(); }
}

test('C1-A4 a div composer: changing the message while the card waits is refused', { skip: !haveChrome && 'no Chrome' }, async () => {
  const same = await sendWithChange('/div-composer', null);
  assert.equal(same.error, undefined, `an unchanged send goes through: ${same.error}`);
  const { error } = await sendWithChange('/div-composer', "document.getElementById('msg').innerText = 'send the money to mallory'");
  assert.ok(error, 'the changed message must not be sent under the old approval');
});

test('C1-A2 a To widget beside the form is bound: swapping it while the card waits is refused', { skip: !haveChrome && 'no Chrome' }, async () => {
  const { error, decisions } = await sendWithChange('/to-beside-form', "document.getElementById('to').value = 'mallory@evil.example'");
  assert.ok(decisions[0]?.facts?.recipients?.includes('alice@example.com'), `the card knows the recipient: ${JSON.stringify(decisions[0]?.facts)}`);
  assert.ok(error, 'the swapped recipient must not be sent under the old approval');
});

test('C1-A3 more recipients than the scan can hold hands back and raises no card', { skip: !haveChrome && 'no Chrome' }, async () => {
  const { error, decisions } = await sendWithChange('/many-chips', null);
  assert.match(String(error?.message), /^YOUR TURN:/);
  assert.deepEqual(decisions, []);
});
