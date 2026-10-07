// SPDX-License-Identifier: AGPL-3.0-or-later
// C3 (T43) real-browser proof: JavaScript dialogs as a modal state, on the T15 dialog page (/t8-dialogs) in Chrome for Testing, a fresh
// temp profile, 127.0.0.1 only. A missing Chrome is a FAILURE (a skipped security gate proves nothing):
//   MURAGE_CFT_CHROME=/path/to/chrome node --test scripts/browser-c3.node-test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
import { startFixtureSite } from './browser-extension-fixture-site/server.mjs';
import { BrowserExtensionExecutor } from '../server/browser-extension-executor.ts';

const CHROME = process.env.MURAGE_CFT_CHROME || '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
test('Chrome for Testing is present: the C3 dialog gate cannot be skipped', () => {
  assert.ok(existsSync(CHROME), `no Chrome binary at ${CHROME}. Set MURAGE_CFT_CHROME to Chrome for Testing. A skipped gate counts as a failure.`);
});

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'mbe-c3-'));
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
    else if (message.method) for (const l of [...listeners]) l(message);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const domain of ['Page', 'DOM', 'Runtime', 'Accessibility']) await send(`${domain}.enable`, {}, sessionId);
  const page = {
    url: 'about:blank',
    send: (method, params) => send(method, params, sessionId),
    on(fn) { const l = m => { if (m.sessionId === sessionId) fn(m); }; listeners.push(l); return () => listeners.splice(listeners.indexOf(l), 1); },
    async goto(url) {
      const loaded = new Promise(resolve => { const l = m => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) { listeners.splice(listeners.indexOf(l), 1); resolve(); } }; listeners.push(l); });
      await send('Page.navigate', { url }, sessionId); await loaded; page.url = url;
    },
    async evaluate(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId); return r.result?.value; },
  };
  const close = async () => {
    try { ws.close(); } catch { /* closing */ }
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL'); await exited;
    try { safeWipeSync(profile); } catch { /* the temp profile is disposable */ }
  };
  return { page, close };
}

const within = (promise, ms, what) => (Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish in ${ms} ms`)), ms))]));

test('T43: alert, confirm, prompt and beforeunload on the T15 dialog page follow the modal rules', { timeout: 120_000 }, async () => {
  const site = await startFixtureSite();
  const { page, close } = await launch();
  try {
    await within(page.goto(`${site.origin}/t8-dialogs`), 15_000, 'page load');
    const decisions = [], phases = [];
    const doc = () => ({ profileId: 'p', tabId: 1, frameId: 'main', navigationEpoch: 1, origin: site.origin, url: page.url });
    const executor = new BrowserExtensionExecutor({
      authorize: () => true, access: async () => true, admit: async action => { decisions.push(action); return true; },
      phase: event => phases.push(event.phase),
      createEngine: () => ({ resolveTarget: async () => ({ backendNodeId: 1, document: doc() }), resolveTab: async () => doc(), event() {}, async close() {}, async call() { return { content: [] }; } }),
      transport: { document: async () => doc(), send: (method, params) => page.send(method, params) },
    });
    page.on(m => { if (m.method === 'Page.javascriptDialogOpening') executor.event(1, 1, m.method, m.params); else if (m.method === 'Page.javascriptDialogClosed') executor.event(1, 1, m.method, m.params); });
    const opened = kind => new Promise(resolve => { const off = page.on(m => { if (m.method === 'Page.javascriptDialogOpening' && m.params.type === kind) { off(); resolve(m.params); } }); });
    const answer = async accept => {
      executor.executing = true;
      try { await within(executor.answerDialog(doc(), { accept, ...(accept ? { promptText: 'Q3' } : {}) }), 20_000, 'the dialog answer'); } finally { executor.executing = false; }
      await within(page.send('Page.handleJavaScriptDialog', { accept, promptText: 'Q3' }), 10_000, 'handleJavaScriptDialog');
    };
    for (const [kind, button, accept] of [['alert', '#do-alert', true], ['confirm', '#do-confirm', false], ['prompt', '#do-prompt', true]]) {
      const seen = opened(kind);
      await page.evaluate(`setTimeout(() => document.querySelector(${JSON.stringify(button)}).click(), 0), 0`);
      const params = await within(seen, 10_000, `the ${kind} dialog`);
      // Modal: nothing but looking moves while it is open, and it is refused before it reaches the page.
      await assert.rejects(executor.call('agent_browser_click', { selector: '#do-confirm' }), /A dialog is open on the page: ".*" \(written by the site, not by Murage\)\. Answer it first\./);
      await assert.rejects(executor.call('agent_browser_fill', { selector: '#x', text: 'x' }), /Answer it first/);
      await answer(accept);
      const last = decisions.at(-1);
      assert.equal(last.name, accept ? 'agent_browser_dialog_accept' : 'agent_browser_dialog_dismiss', `${kind}: the answer is judged as accept or dismiss`);
      assert.equal(last.facts?.dialog?.kind, kind, `${kind}: the card carries the dialog's kind`);
      assert.match(last.summary, new RegExp(params.message.slice(0, 10)));
      await new Promise(r => setTimeout(r, 200));
      assert.ok(!executor.dialog, `${kind}: answered, so the modal state is gone`);
    }
    // beforeunload: armed by the page, typed data present, leaving asks "Leave this page?".
    await page.evaluate("document.getElementById('do-beforeunload').click(); document.body.dispatchEvent(new Event('input')); true");
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 });
    const seen = opened('beforeunload');
    await page.evaluate("setTimeout(() => { location.href = '/t8-after'; }, 0), 0");
    await within(seen, 10_000, 'the beforeunload dialog');
    await assert.rejects(executor.call('agent_browser_click', { selector: '#leave' }), /Answer it first/);
    await answer(true);
    assert.match(decisions.at(-1).summary, /Leave this page\?/);
    assert.equal(decisions.at(-1).facts?.dialog?.kind, 'beforeunload');
    // Accepting really leaves: the page ends up on the next address.
    await within((async () => { while (await page.evaluate('location.pathname') !== '/t8-after') await new Promise(r => setTimeout(r, 100)); })(), 15_000, 'leaving the page');
    // A dialog the owner opened while the bot was not acting is left alone.
    await within(page.goto(`${site.origin}/t8-dialogs`), 15_000, 'the second page load');
    const ownerSeen = opened('alert');
    await page.evaluate("setTimeout(() => alert('owner'), 0), 0");
    await within(ownerSeen, 10_000, 'the owner alert');
    const before = decisions.length;
    await assert.rejects(executor.answerDialog(doc(), { accept: true }), /needs the owner/);
    assert.equal(decisions.length, before);
    await page.send('Page.handleJavaScriptDialog', { accept: true });
  } finally { await close(); await site.close(); }
});
