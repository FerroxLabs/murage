// SPDX-License-Identifier: AGPL-3.0-or-later
// Round 8 real-browser proofs (Codex Astra chrome7 report, SEC-02, SEC-05, SEC-06, SEC-08, SEC-09, SEC-10). Chrome for Testing, a fresh temp
// profile, pages served from 127.0.0.1 only. A missing Chrome is a FAILURE (a skipped security gate proves nothing):
//   MURAGE_CFT_CHROME=/path/to/chrome node --test scripts/browser-corefix8.node-test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
import { BrowserExtensionExecutor } from '../server/browser-extension-executor.ts';
import { collectFloorFacts } from '../server/browser-floor-facts.ts';
import { SENSITIVE_RECTS, FRAME_MASK } from '../extensions/murage-browser/runtime.mjs';

const CHROME = process.env.MURAGE_CFT_CHROME || '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const haveChrome = existsSync(CHROME);
test('Chrome for Testing is present: the round 8 security gate cannot be skipped', () => {
  assert.ok(haveChrome, `no Chrome binary at ${CHROME}. Set MURAGE_CFT_CHROME to Chrome for Testing. A skipped security gate counts as a failure.`);
});

const CLOSED = (tag, html) => `<script>customElements.define(${JSON.stringify(tag)}, class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = ${JSON.stringify(html)}; } });</script>`;
const OPEN = (tag, html) => `<script>customElements.define(${JSON.stringify(tag)}, class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(html)}; } });</script>`;
const PAGES = {
  '/div-closed': `<p>Sign in</p><div id="d"></div><script>document.getElementById('d').attachShadow({mode:'closed'}).innerHTML='<input type="password" aria-label="Password">';</script>`,
  '/label-copy': `<input id="code" aria-label="Notes" value="482913"><button id="b" type="button">Save</button><script>document.getElementById('b').setAttribute('aria-label', document.getElementById('code').value);</script>`,
  '/frame-code': `<iframe id="f" srcdoc="<input value='482913'>" width="200" height="40"></iframe>`,
  '/click': `<button id="b">Continue</button><script>window.clicked=0;const b=document.getElementById('b');b.onmousedown=()=>{b.textContent='Accept terms'};b.onclick=()=>{window.clicked++};</script>`,
  '/editable': `<div id="notes" contenteditable="true" aria-label="Notes">482913</div><button id="go" type="button">Save</button>`,
  '/closed-password': `<p>Sign in</p><x-vault></x-vault>${CLOSED('x-vault', '<input type="password" aria-label="Password" value="hunter2">')}`,
  '/closed-ssn': `<p>Verify</p><x-id></x-id>${CLOSED('x-id', '<input aria-label="Social security number" value="078-05-1120">')}`,
  '/fake-overlay-password': `<p>Sign in</p><murage-presence data-murage-presence></murage-presence>${CLOSED('murage-presence', '<input type="password" aria-label="Password">')}`,
  '/overlay-shape': `<p>Notes</p><murage-presence data-murage-presence></murage-presence>${CLOSED('murage-presence', '<div class="pill"><button>Pause</button><span>Murage is working</span></div>')}`,
  '/open-clean': `<p>Notes</p><x-note></x-note>${OPEN('x-note', '<span>hello</span>')}`,
  '/light-custom': `<x-label>hello world</x-label><p>Notes</p>`,
  '/masks': `<p><input id="nid" aria-label="National ID" value="x"></p><p><div id="otp" contenteditable aria-label="Notes">482913</div></p><p><input id="subject" aria-label="Subject" value="hello"></p><p style="margin-top:80px"><x-vault style="display:block;width:200px;height:30px"></x-vault></p>${CLOSED('x-vault', '<input aria-label="Card" value="4111">')}`,
  '/r1': `<form action="/x" method="post"><input name="to" value="4111.1111.1111.1111"><button id="send" type="submit">Send</button></form>`,
  '/r2': `<form action="/x" method="post"><div contenteditable="true" aria-label="To"><div contenteditable="true" aria-label="カード番号">4111.1111.1111.1111</div></div><button id="send" type="submit">Send</button></form>`,
  '/r3': `<form action="/x" method="post"><input name="to" value="078-05-1120"><button id="send" type="submit">Send</button></form>`,
  '/r4': `<form action="/x" method="post"><input name="to" value="12345678"><button id="send" type="submit">Send</button></form>`,
  '/r5': `<form action="/x" method="post"><input name="to" value="@４１１１１１１１"><button id="send" type="submit">Send</button></form>`,
  '/r6': `<form action="/x" method="post"><input name="to" value="ana@example.com"><button id="send" type="submit">Send</button></form>`,
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
function executorFor(page, origin, decisions) {
  const doc = () => ({ profileId: 'p', tabId: 1, frameId: 'main', navigationEpoch: 1, origin, url: page.url });
  const executor = new BrowserExtensionExecutor({
    authorize: () => true, access: async () => true, admit: async action => { decisions.push(action); return true; },
    createEngine: hooks => ({
      resolveTarget: async selector => ({ ...(await page.target(selector)), document: doc() }), resolveTab: async () => doc(), event() {}, async close() {},
      async call(name, args) {
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

test('SEC-02 a button that becomes "Accept terms" on mousedown is never clicked', { skip: !haveChrome && 'no Chrome' }, async () => {
  const site = await startSite(); const browser = await launch();
  try {
    await browser.page.goto(`http://127.0.0.1:${site.port}/click`);
    const decisions = []; const { executor } = executorFor(browser.page, `http://127.0.0.1:${site.port}`, decisions);
    await assert.rejects(() => executor.call('agent_browser_click', { selector: '#b' }));
    assert.equal(await browser.page.evaluate('window.clicked'), 0, 'the click event must not have fired');
  } finally { await browser.close(); await site.close(); }
});

test('SEC-10 a contenteditable OTP never reaches the description or the approval text', { skip: !haveChrome && 'no Chrome' }, async () => {
  const site = await startSite(); const browser = await launch();
  try {
    await browser.page.goto(`http://127.0.0.1:${site.port}/editable`);
    const decisions = []; const { executor } = executorFor(browser.page, `http://127.0.0.1:${site.port}`, decisions);
    await executor.call('agent_browser_click', { selector: '#notes' }).catch(() => {});
    assert.equal(decisions.length, 1, 'the action should reach the owner card');
    const shown = JSON.stringify(decisions[0]);
    assert.ok(!shown.includes('482913'), `the live value leaked into: ${shown.slice(0, 400)}`);
    // A changed value still changes the digest.
    const first = decisions[0].digest;
    await browser.page.evaluate("document.getElementById('notes').textContent = '482914'");
    const again = []; const second = executorFor(browser.page, `http://127.0.0.1:${site.port}`, again);
    await second.executor.call('agent_browser_click', { selector: '#notes' }).catch(() => {});
    assert.notEqual(again[0]?.digest, first);
  } finally { await browser.close(); await site.close(); }
});

test('SEC-05 a closed shadow root is refused, an open or light one is not', { skip: !haveChrome && 'no Chrome' }, async () => {
  const site = await startSite(); const browser = await launch();
  try {
    const decisions = []; const { executor, doc } = executorFor(browser.page, `http://127.0.0.1:${site.port}`, decisions);
    for (const path of ['/closed-password', '/closed-ssn', '/fake-overlay-password', '/overlay-shape']) {
      await browser.page.goto(`http://127.0.0.1:${site.port}${path}`);
      assert.equal(await executor.protectedDocument(doc()), true, `${path} must be refused`);
    }
    for (const path of ['/open-clean', '/light-custom']) {
      await browser.page.goto(`http://127.0.0.1:${site.port}${path}`);
      assert.equal(await executor.protectedDocument(doc()), false, `${path} must not be over-refused`);
    }
  } finally { await browser.close(); await site.close(); }
});

test('SEC-05 and SEC-06 the screenshot masks cover National ID, a code in a contenteditable and a closed root, not a plain field', { skip: !haveChrome && 'no Chrome' }, async () => {
  const site = await startSite(); const browser = await launch();
  try {
    await browser.page.goto(`http://127.0.0.1:${site.port}/masks`);
    await browser.page.evaluate("globalThis.__muragePresence = { capture: (on, rects) => { window.__rects = rects; return true; } }");
    await browser.page.evaluate(SENSITIVE_RECTS, true);
    const rects = await browser.page.evaluate('window.__rects');
    const ids = await browser.page.evaluate(`(() => ['nid', 'otp', 'subject'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return [id, r.x + r.width / 2, r.y + r.height / 2]; }))()`);
    const covers = id => { const [, x, y] = ids.find(item => item[0] === id); return rects.some(r => x >= r.x - 1 && x <= r.x + r.width && y >= r.y - 1 && y <= r.y + r.height); };
    assert.ok(covers('nid'), 'National ID must be covered');
    assert.ok(covers('otp'), 'a code in a contenteditable must be covered');
    assert.ok(!covers('subject'), `a plain field must not be covered: ${JSON.stringify({ rects, ids })}`);
    assert.ok(rects.length >= 3, `the closed root must be covered too (${rects.length} rects)`);
  } finally { await browser.close(); await site.close(); }
});

test('SEC-08 and SEC-09 secrets in recipient-labelled places never become recipients, through the real collector', { skip: !haveChrome && 'no Chrome' }, async () => {
  const site = await startSite(); const browser = await launch();
  try {
    const failures = [];
    for (const path of ['/r1', '/r2', '/r3', '/r4', '/r5']) {
      await browser.page.goto(`http://127.0.0.1:${site.port}${path}`);
      const facts = await collectFloorFacts(browser.page.io, await browser.page.target('#send'), 'click', {});
      const text = JSON.stringify(facts.recipients ?? []);
      if (/4111|078|12345678|４１１１/.test(text)) failures.push(`${path} leaked ${text}`);
      if (facts.recipientScanFailed !== true) failures.push(`${path}: the recipients should be unknown`);
    }
    await browser.page.goto(`http://127.0.0.1:${site.port}/r6`);
    const ok = await collectFloorFacts(browser.page.io, await browser.page.target('#send'), 'click', {});
    if (JSON.stringify(ok.recipients) !== '["ana@example.com"]') failures.push(`a plain address was lost: ${JSON.stringify(ok.recipients)}`);
    assert.deepEqual(failures, []);
  } finally { await browser.close(); await site.close(); }
});

test('round 9 R8-01 a div with a closed root is refused (found through the browser tree)', { skip: !haveChrome && 'no Chrome' }, async () => {
  const site = await startSite(); const browser = await launch();
  try {
    await browser.page.goto(`http://127.0.0.1:${site.port}/div-closed`);
    const { executor, doc } = executorFor(browser.page, `http://127.0.0.1:${site.port}`, []);
    assert.equal(await executor.protectedDocument(doc()), true);
  } finally { await browser.close(); await site.close(); }
});

test('round 9 R8-05 a code copied into aria-label does not reach the description or fieldNames', { skip: !haveChrome && 'no Chrome' }, async () => {
  const site = await startSite(); const browser = await launch();
  try {
    await browser.page.goto(`http://127.0.0.1:${site.port}/label-copy`);
    const decisions = []; const { executor } = executorFor(browser.page, `http://127.0.0.1:${site.port}`, decisions);
    await executor.call('agent_browser_click', { selector: '#b' }).catch(() => {});
    assert.equal(decisions.length, 1);
    { const j = JSON.stringify(decisions[0]); const at = j.indexOf('482913'); assert.ok(at < 0, j.slice(Math.max(0, at - 200), at + 60)); }
  } finally { await browser.close(); await site.close(); }
});

test('round 9 R8-06 a same-origin frame is hidden for the capture, whatever it holds', { skip: !haveChrome && 'no Chrome' }, async () => {
  const site = await startSite(); const browser = await launch();
  try {
    await browser.page.goto(`http://127.0.0.1:${site.port}/frame-code`);
    await browser.page.evaluate(FRAME_MASK);
    assert.equal(await browser.page.evaluate("getComputedStyle(document.getElementById('f')).visibility"), 'hidden');
  } finally { await browser.close(); await site.close(); }
});
