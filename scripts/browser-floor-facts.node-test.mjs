// SPDX-License-Identifier: AGPL-3.0-or-later
// Real-browser proof of the floor facts collector (T01): Chrome for Testing, a fresh temp profile, the T15 fixture
// site on 127.0.0.1, never the network. For each case the collector runs against the live page, its facts go through
// the real `classifyFloor`, and the floor kind must be the expected one. This proves the collector and the classifier
// agree end to end.
//
// Run on a host that has Chrome for Testing:
//   MURAGE_CFT_CHROME=/path/to/chrome node --test scripts/browser-floor-facts.node-test.mjs
// Round 7: a missing Chrome is a FAILURE, never a skip. This file holds a security gate ("no typed value reaches a name, description, snippet
// or cover"), and a silent skip hid a real card-number leak for three review rounds. The only way to run without Chrome is the explicit local
// opt-out MURAGE_ALLOW_NO_CHROME=1, and that opt-out is refused when CI or MURAGE_GATE is set. It never downloads a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
import { startFixtureSite } from './browser-extension-fixture-site/server.mjs';
import { classifyFloor } from '../server/browser-floor.ts';
import { collectFloorFacts } from '../server/browser-floor-facts.ts';

const CHROME = process.env.MURAGE_CFT_CHROME || '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const haveChrome = existsSync(CHROME);
const optOut = process.env.MURAGE_ALLOW_NO_CHROME === '1' && !process.env.CI && !process.env.MURAGE_GATE;
// The six Chrome tests cannot run without Chrome (they would hang launching it), so they skip; the guard test below fails instead,
// and the gate runner (scripts/run-extension-node-tests.mjs) also fails on any skip.
const skip = haveChrome ? false : `no Chrome binary at ${CHROME}`;
// Fails loudly (one named failure) instead of letting six tests silently skip.
test('Chrome for Testing is present: the floor-facts security gate cannot be skipped', () => {
  assert.ok(haveChrome || optOut, `no Chrome binary at ${CHROME}. Set MURAGE_CFT_CHROME to Chrome for Testing. A skipped security gate counts as a failure.`);
});
const WORLD = 'murage-protected-document-v1';

/** A minimal CDP client over the browser websocket (Node's global WebSocket). */
async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'mbe-floorfacts-'));
  const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let wsUrl;
  for (let i = 0; i < 200 && !wsUrl; i++) {
    await new Promise(r => setTimeout(r, 100));
    try {
      const [port, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
      wsUrl = `ws://127.0.0.1:${port}${path}`;
    } catch { /* not yet */ }
  }
  assert.ok(wsUrl, 'Chrome did not publish its debugging port');
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = event => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else resolve(message.result);
    } else if (message.method) for (const l of listeners) l(message);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const domain of ['Page', 'DOM', 'Runtime', 'Accessibility']) await send(`${domain}.enable`, {}, sessionId);
  const page = {
    send: (method, params) => send(method, params, sessionId),
    async goto(url) {
      const loaded = new Promise(resolve => {
        const l = message => { if (message.method === 'Page.loadEventFired' && message.sessionId === sessionId) { listeners.splice(listeners.indexOf(l), 1); resolve(); } };
        listeners.push(l);
      });
      await send('Page.navigate', { url }, sessionId);
      await loaded;
    },
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    },
    /** The target as the executor holds it: a backendNodeId and a document. */
    async target(selector) {
      const { root } = await send('DOM.getDocument', { depth: 0 }, sessionId);
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector }, sessionId);
      assert.ok(nodeId, `no element for ${selector}`);
      const { node } = await send('DOM.describeNode', { nodeId }, sessionId);
      return { backendNodeId: node.backendNodeId, document: { tabId: 1, navigationEpoch: 1 } };
    },
    /** A target found by an expression (reaches into open shadow roots, which DOM.querySelector does not). */
    async targetBy(expression) {
      const r = await send('Runtime.evaluate', { expression }, sessionId);
      assert.ok(r.result?.objectId, `no element for ${expression}`);
      const { node } = await send('DOM.describeNode', { objectId: r.result.objectId }, sessionId);
      return { backendNodeId: node.backendNodeId, document: { tabId: 1, navigationEpoch: 1 } };
    },
    /** The executor's own `send` and `world`, as T03 will pass them. */
    io: {
      send: (method, params) => send(method, params, sessionId),
      async world() {
        const tree = await send('Page.getFrameTree', {}, sessionId);
        const world = await send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: WORLD }, sessionId);
        return world.executionContextId;
      },
    },
  };
  const close = async () => {
    try { ws.close(); } catch { /* closing */ }
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    try { safeWipeSync(profile); } catch { /* the temp profile is disposable */ }
  };
  return { page, close };
}

/** A tiny page of our own for a Stripe-style element, which the T15 fixture serves only as a cross-origin mock. */
function startStripeStyleSite() {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/blank') return res.end('<!doctype html><title>frame</title><p>card field</p>');
    res.end(`<!doctype html><html lang="en"><head><title>Subscribe</title></head><body><h1>Pro plan</h1><p>$19.00 per month</p>
<div class="StripeElement"><iframe name="__privateStripeFrame1" src="/blank" title="Secure card input" width="300" height="40"></iframe></div>
<button type="button" id="go">Continue</button><a href="/blank" id="terms-link">Terms of Service</a></body></html>`);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(done => server.close(done)) })));
}

/** Inline pages for the Opus gate findings, served on 127.0.0.1 only. */
function startInlineSite(pages) {
  const server = createServer((req, res) => {
    const html = pages[req.url.split('?')[0]];
    res.setHeader('content-type', 'text/html');
    if (!html) { res.statusCode = 404; return res.end('<!doctype html><title>404</title>'); }
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${req.url.slice(1)}</title></head><body>${html}</body></html>`);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ url: path => `http://127.0.0.1:${server.address().port}${path}`, close: () => new Promise(done => server.close(done)) })));
}

const SHADOW = (tag, html) => `<script>customElements.define(${JSON.stringify(tag)}, class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(html)}; } });</script>`;
const TERMS = 'By clicking Create account you agree to the Terms of Service.';

const GATE_PAGES = {
  // H1: values reachable through names and descriptions.
  '/h1': `<form action="/x" method="post">
<span id="cl">Card number</span> <input id="cc" aria-labelledby="cl cc">
<label><input type="checkbox" id="agree"> Send receipts to <input id="addr"></label>
<button type="button" id="send" aria-describedby="note">Send</button><textarea id="note" aria-label="Note"></textarea>
<span id="planl">Plan</span><select id="plan" aria-label="Plan"><option>Choose one</option><option>SECRETOPTION Gold</option></select><button type="button" id="pick" aria-labelledby="planl plan">x</button>
<div id="ed" contenteditable="true" aria-label="Editor"></div><button type="button" id="post" aria-describedby="ed">Post</button>
<input type="password" id="pw" aria-label="Password"><button type="button" id="show" aria-labelledby="pw">Show</button>
<button type="button" id="long" aria-describedby="longnote">Save</button><textarea id="longnote" aria-label="Long note"></textarea>
<span id="cvl">CVC</span> <input id="cvc" aria-labelledby="cvl cvc">
<button type="submit" id="go">Continue</button></form>`,
  // H1 design check: a search term elsewhere on the page does not erase the pay button's name.
  '/h1b': `<input id="search" type="search" aria-label="Search"><p>Total $40.00</p><button id="po" type="button">Place order</button>`,
  // L1: focus sits in a frame the reader cannot see into.
  '/l1f': `<p>Card</p><iframe id="fr" src="/h1b" title="Card frame" width="300" height="80"></iframe>`,
  // H1: a custom element labelled by its own shadow input.
  '/h1c': `<x-card id="host" role="textbox" aria-label="Card"></x-card>${SHADOW('x-card', '<input id="inner" aria-label="inner">')}<button id="go" type="button">Go</button>`,
  // M1: editor text and an editable overlay.
  '/m1': `<p>Intro text</p><div contenteditable="true" id="ed2">SECRETDRAFT <b id="t">x</b> more SECRETTAIL</div><p>After text</p>
<div style="position:relative;height:120px"><button id="under" style="position:absolute;left:10px;top:10px;width:120px;height:40px">Go</button><div contenteditable="true" id="cover" style="position:absolute;left:0;top:0;width:300px;height:100px;z-index:5;background:#fff">SECRETCOVER</div></div>`,
  // M2: wording on screen but hidden from assistive technology or marked as a textbox.
  '/m2a': `<form action="/x" method="post"><label>Email <input id="email" type="email"></label><p aria-hidden="true">${TERMS}</p><button id="create" type="submit">Create account</button></form>`,
  '/m2b': `<h2>Checkout</h2><p>Total $40.00</p><button id="po" type="button"><span aria-hidden="true">Place order</span></button>`,
  '/m2c': `<style>[hidden]{display:block}</style><form action="/x" method="post"><label>Email <input id="email" type="email"></label><p hidden>${TERMS}</p><button id="create" type="submit">Create account</button></form>`,
  '/m2d': `<form action="/x" method="post"><label>Email <input id="email" type="email"></label><div role="textbox">${TERMS}</div><button id="create" type="submit">Create account</button></form>`,
  // M3: open shadow DOM.
  '/m3a': `<main><p>By clicking Join you agree to the Terms of Service.</p><x-join id="host"></x-join></main>${SHADOW('x-join', '<button id="join" type="button">Join</button>')}`,
  '/m3b': `<x-login id="host"></x-login>${SHADOW('x-login', '<div><input id="u" placeholder="Email"><input id="p" type="password" placeholder="Password"><button id="signin" type="button">Sign in</button></div>')}`,
  '/m3c': `<x-form id="host"></x-form>${SHADOW('x-form', '<form action="/x" method="post"><input id="u" name="u"><input id="p" type="password" name="p"><button id="signin" type="submit">Sign in</button></form>')}`,
  // M4: fields outside the form element, and a login with no form at all.
  '/m4a': `<main><h2>Welcome back</h2><div class="login"><input id="u" placeholder="Email"><input id="p" type="password" placeholder="Password"><button id="signin" type="button">Sign in</button></div></main>`,
  '/m4b': `<form id="f" action="/x" method="post"><input id="u" name="u" aria-label="Username"><button id="go" type="submit">Continue</button></form><input type="password" form="f" id="p" aria-label="Secret">`,
  // M6: a consent manager whose optional toggle says "required".
  '/m6': `<div id="onetrust-consent-sdk"><div id="onetrust-pc-sdk" role="dialog" aria-label="Privacy preferences"><p>We use cookies.</p><label><input type="checkbox" checked disabled> Strictly necessary</label><label><input type="checkbox" id="mk"> Marketing</label><label><input type="checkbox" id="partners" checked> Share data with partners (consent required)</label><button id="save" type="button">Confirm my choices</button></div></div>`,
  // L4: a long form with the password field past the old cap.
  '/l4': `<form action="/x" method="post">${Array.from({ length: 70 }, (_, i) => `<input name="f${i}" aria-label="Field ${i}">`).join('')}<input type="password" id="p" name="p"><button id="go" type="submit">Continue</button></form>`,
};

const CLOSED = (tag, html, expose) => `<script>customElements.define(${JSON.stringify(tag)}, class extends HTMLElement { constructor() { super(); const r = this.attachShadow({ mode: 'closed' }); r.innerHTML = ${JSON.stringify(html)};${expose ? ` window[${JSON.stringify(expose)}] = r;` : ''} } });</script>`;
const LOGIN_FIELDS = '<label>Email <input id="email" type="email" name="email"></label><label>Password <input id="pw" type="password" name="pw"></label>';

/** Pages for the Opus gate round 2 findings. */
const ROUND2_PAGES = {
  // N1: Enter in the email field of a login form, spelt every way.
  '/n1': `<form action="/login" method="post">${LOGIN_FIELDS}<button id="go">Log in</button></form>`,
  // N1: no native submit button, a div button instead (Enter is bound by the page).
  '/n1b': `<form action="/login" method="post">${LOGIN_FIELDS}<div role="button" tabindex="0" id="lb">Log in</div></form>`,
  // Implicit submission rules: one field submits, two fields with no button do not.
  '/n1c': `<form action="/pin" method="post"><input id="only" type="password" aria-label="PIN"></form><form action="/two" method="post"><input id="a" aria-label="First"><input id="b" aria-label="Second"></form><form action="/three" method="post"><input id="c" aria-label="Name"><button type="button" id="tb">Help</button><button type="reset" id="rb">Clear</button></form>`,
  // N3: Enter in a chat box.
  '/n3': `<textarea id="chat" aria-label="Message"></textarea><div id="ce" contenteditable="true" aria-label="Compose"></div><div id="rt" role="textbox" tabindex="0" aria-label="Reply"></div><form action="/c" method="post"><textarea id="ft" aria-label="Comment"></textarea><button id="post">Post</button></form>`,
  // N4: a shadow submit button in a light-DOM login form, and a div button "Log in" inside a form.
  '/n4a': `<form action="/login" method="post">${LOGIN_FIELDS}<x-sub id="host"></x-sub></form>${SHADOW('x-sub', '<button type="submit" id="b">Log in</button>')}`,
  '/n4b': `<form action="/login" method="post">${LOGIN_FIELDS}<div role="button" tabindex="0" id="lb">Log in</div></form>`,
  // N5: closed shadow roots.
  '/n5a': `<x-closed id="host" role="textbox" aria-label="Card"></x-closed>${CLOSED('x-closed', '<input id="inner" aria-label="inner">', '__closedA')}`,
  '/n5b': `<span id="lab">Code <x-pin id="pinhost"></x-pin></span><button id="ok" type="button" aria-labelledby="lab">ok</button>${CLOSED('x-pin', '<input id="inner" aria-label="pin">', '__closedB')}`,
  '/n5c': `<p id="para">Chat</p><x-chat id="host"></x-chat>${CLOSED('x-chat', '<input id="inner" aria-label="message">', '__closedC')}`,
  // N6: a 4-digit PIN reaches the button's name through a descendant's aria-labelledby.
  '/n6': `<button id="confirm" type="button"><span aria-labelledby="pin">x</span> Confirm</button><input id="pin" aria-label="PIN">`,
  // L1: a value straddling the 300-character and 1,000-character cuts.
  '/l1': `<form action="/x" method="post"><input id="v" aria-label="Value"><p id="echo"></p><button id="go" type="button">Go</button></form>`,
  // L2: values in the title, the path, a field's id or name, and a covering element's id.
  '/l2': `<input id="v1" aria-label="One"><input id="v2" aria-label="Two"><input id="v3" aria-label="Three"><input id="v4" aria-label="Four"><div style="position:relative;height:80px"><button id="under" style="position:absolute;left:0;top:0;width:100px;height:40px">Go</button><div id="cov" style="position:absolute;left:0;top:0;width:200px;height:60px;z-index:3;background:#fff"></div></div>`,
};

// page id, selector, operation, key, expected floor
const CASES = [
  ['h1-signup-terms', '#terms', 'click', undefined, 'consent', 'terms checkbox'],
  ['h1-signup-terms', 'label:has(#terms)', 'click', undefined, 'consent', 'click on the label reaches the checkbox'],
  ['h1-signup-terms', '#email', 'type', undefined, null, 'plain email field'],
  ['h2-click-agree', '#submit', 'click', undefined, 'consent', 'By clicking Create account'],
  ['h5-cookie-onetrust', '#onetrust-accept-btn-handler', 'click', undefined, 'consent', 'OneTrust accept'],
  ['h5-cookie-onetrust', '#onetrust-reject-all-handler', 'click', undefined, null, 'OneTrust reject'],
  ['h5-cookie-onetrust', '#onetrust-pc-btn-handler', 'click', undefined, null, 'OneTrust settings'],
  ['h5-cookie-generic', '#accept-all', 'click', undefined, 'consent', 'generic cookie banner accept'],
  ['h3-verify-human', '.g-recaptcha iframe', 'click', undefined, 'verification', 'reCAPTCHA mock'],
  ['h4-not-robot', '#not-robot', 'click', undefined, 'verification', "I'm not a robot"],
  ['h6-signin', '#password', 'type', undefined, 'credentials', 'password field'],
  ['h6-signin', '#username', 'type', undefined, null, 'username field'],
  ['h6-signin', '#submit', 'click', undefined, 'credentials', 'submit a form with a password'],
  ['h6-signin', '#username', 'press', 'Enter', 'credentials', 'Enter in the form reaches the default submit'],
  ['h7-payment', '#card-number', 'fill', undefined, 'credentials', 'card number on a tel input'],
  ['h7-payment', 'label[for=card-number]', 'click', undefined, null, 'click on the Card number label only focuses the field'],
  ['h7-payment', '#pw', 'type', undefined, 'credentials', 'password behind a show-password toggle'],
  ['h7-payment', '#toggle-pw', 'click', undefined, null, 'the show-password toggle itself'],
  ['h8-checkout', '#place-order', 'click', undefined, 'payment', 'Place order'],
  ['h8-checkout', '#pay-now', 'click', undefined, 'payment', 'Pay now'],
  ['h8-checkout', '#addr-name', 'type', undefined, null, 'address field'],
  ['h9-oauth', '#allow', 'click', undefined, 'consent', 'OAuth allow'],
  ['h9-oauth', '#deny', 'click', undefined, null, 'OAuth deny'],
  ['h11-invite', '#accept', 'click', undefined, null, 'accept a calendar invite'],
  ['h12-verify-address', '#verify-address', 'click', undefined, 'verification', 'Verify address'],
  ['h12-verify-address', '#continue-checkout', 'click', undefined, null, 'Continue after the address form'],
];

test('floor facts on real pages classify as the spec expects', { skip, timeout: 240000 }, async () => {
  const site = await startFixtureSite();
  const stripe = await startStripeStyleSite();
  const browser = await launch();
  try {
    const { page } = browser;
    const failures = [];
    for (const [id, selector, operation, key, expected, label] of CASES) {
      await page.goto(site.url(id));
      const target = await page.target(selector);
      const facts = await collectFloorFacts(page.io, target, operation, key ? { key } : {});
      const got = classifyFloor(facts);
      if (facts.factsFailed || got.floor !== expected) failures.push(`${id} ${label}: expected ${expected}, got ${got.floor} (${got.rule}) failed=${!!facts.factsFailed} facts=${JSON.stringify({ tag: facts.tag, type: facts.type, name: facts.name, role: facts.role, submits: facts.submits, signatures: facts.signatures })}`);
    }
    // A password revealed by its toggle is still a password: type into it after the toggle.
    await page.goto(site.url('h7-payment'));
    await page.evaluate("document.getElementById('toggle-pw').click()");
    assert.equal(await page.evaluate("document.getElementById('pw').type"), 'text');
    const revealed = await collectFloorFacts(page.io, await page.target('#pw'), 'type', {});
    if (classifyFloor(revealed).floor !== 'credentials') failures.push(`revealed password: ${JSON.stringify(classifyFloor(revealed))}`);

    // Stripe-style element: a bare Continue on a page that carries a payment frame and an amount.
    await page.goto(stripe.url);
    const bare = await collectFloorFacts(page.io, await page.target('#go'), 'click', {});
    assert.equal(bare.page?.hasPaymentFrame, true, 'the StripeElement container is a payment signature');
    assert.equal(classifyFloor(bare).floor, 'payment');
    const readLink = await collectFloorFacts(page.io, await page.target('#terms-link'), 'click', {});
    assert.equal(classifyFloor(readLink).floor, null, 'reading the terms is not floor');

    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
    await site.close();
    await stripe.close();
  }
});

test('effect target, form facts and visibility on a live page', { skip, timeout: 120000 }, async () => {
  const site = await startFixtureSite();
  const browser = await launch();
  try {
    const { page } = browser;
    await page.goto(site.url('h6-signin'));
    const enter = await collectFloorFacts(page.io, await page.target('#username'), 'press', { key: 'Enter' });
    assert.equal(enter.tag, 'button');
    assert.equal(enter.submits, true);
    assert.equal(enter.form?.hasPasswordField, true);
    assert.equal(enter.form?.method, 'post');
    assert.match(enter.form?.action ?? '', /\/__submit\/h6-signin$/);
    assert.equal(enter.page?.urlPath, '/h6-signin');
    assert.equal(enter.page?.title, 'Sign in');
    assert.equal(enter.visibility.inViewport, true);
    assert.equal(enter.visibility.ariaHidden, false);
    assert.equal(enter.visibility.coveredBy, null);
    assert.ok(enter.visibility.box && enter.visibility.box.width > 0);

    await page.goto(site.url('h7-payment'));
    const label = await collectFloorFacts(page.io, await page.target('label[for=card-number]'), 'click', {});
    assert.equal(label.tag, 'input');
    assert.equal(label.type, 'tel');
    assert.equal(label.name, 'Card number');
    assert.equal(label.form?.hasCardFields, true);
    assert.equal(label.form?.hasPasswordField, true);

    // An element something else covers reports what covers it, and one that is not shown says so.
    await page.evaluate("(() => { const d = document.createElement('div'); d.id = 'overlay'; d.textContent = 'Win a prize'; d.style.cssText = 'position:fixed;inset:0;background:#fff;opacity:.5;z-index:99'; document.body.append(d); document.getElementById('toggle-pw').style.visibility = 'hidden'; })()");
    const covered = await collectFloorFacts(page.io, await page.target('#pw'), 'click', {});
    assert.match(covered.visibility.coveredBy ?? '', /^div#overlay/);
    const hidden = await collectFloorFacts(page.io, await page.target('#toggle-pw'), 'click', {});
    assert.equal(hidden.visibility.visibility, 'hidden');

    // A frame the page embeds shows up in the page facts.
    await page.goto(site.url('h8-checkout'));
    const checkout = await collectFloorFacts(page.io, await page.target('#place-order'), 'click', {});
    assert.ok(checkout.page?.frames?.some(f => f.path === '/widgets/pay-frame'), JSON.stringify(checkout.page?.frames));
    assert.equal(checkout.page?.hasCurrencyAmount, true);
  } finally {
    await browser.close();
    await site.close();
  }
});

test('no field value ever appears in the facts', { skip, timeout: 120000 }, async () => {
  const site = await startFixtureSite();
  const browser = await launch();
  try {
    const { page } = browser;
    const password = 'Hunter2-SECRET-PW-731';
    const typed = 'typed-visible-VALUE-882';
    const note = 'multi line NOTE-VALUE-405';
    await page.goto(site.url('h6-signin'));
    await page.evaluate(`document.getElementById('password').value = ${JSON.stringify(password)}; document.getElementById('username').value = ${JSON.stringify(typed)};`);
    for (const selector of ['#password', '#username', '#submit']) {
      for (const operation of ['type', 'click']) {
        const facts = await collectFloorFacts(page.io, await page.target(selector), operation, {});
        const json = JSON.stringify(facts);
        assert.equal(json.includes(password), false, `${selector} ${operation} leaked the password`);
        assert.equal(json.includes(typed), false, `${selector} ${operation} leaked the typed text`);
      }
    }
    await page.goto(site.url('t2-eight-field'));
    await page.evaluate(`(() => { const t = document.createElement('textarea'); t.setAttribute('aria-label', 'Notes'); document.querySelector('form').prepend(t); })();document.querySelector('textarea').value = ${JSON.stringify(note)}; document.querySelector('input').value = ${JSON.stringify(typed)};`);
    for (const selector of ['textarea', 'input', 'button[type=submit]']) {
      const json = JSON.stringify(await collectFloorFacts(page.io, await page.target(selector), 'click', {}));
      assert.equal(json.includes(note), false, `${selector} leaked the textarea`);
      assert.equal(json.includes(typed), false, `${selector} leaked the input`);
    }
    // Even when the field's accessible name IS its value (a field labelled by what the owner typed).
    await page.goto(site.url('h6-signin'));
    await page.evaluate(`(() => { const u = document.getElementById('username'); u.setAttribute('aria-label', ${JSON.stringify(typed)}); u.value = ${JSON.stringify(typed)}; })()`);
    const named = await collectFloorFacts(page.io, await page.target('#username'), 'type', {});
    assert.equal(JSON.stringify(named).includes(typed), false, 'an accessible name equal to the value must be dropped');
  } finally {
    await browser.close();
    await site.close();
  }
});

test('Opus gate H1/M1: no typed value reaches a name, description, snippet or cover', { skip, timeout: 180000 }, async () => {
  const site = await startInlineSite(GATE_PAGES);
  const browser = await launch();
  try {
    const { page } = browser;
    const leaks = [];
    const check = (facts, secrets, label) => {
      const json = JSON.stringify(facts).toLowerCase();
      for (const secret of secrets) if (json.includes(secret.toLowerCase())) leaks.push(`${label} leaked ${secret}: ${JSON.stringify(facts).slice(0, 600)}`);
    };
    await page.goto(site.url('/h1'));
    await page.evaluate(`(() => {
      document.getElementById('cc').value = '4111 1111 1111 1111';
      document.getElementById('addr').value = 'SECRETADDR 42 Elm';
      document.getElementById('note').value = 'SECRETNOTE draft';
      document.getElementById('plan').selectedIndex = 1;
      document.getElementById('ed').textContent = 'SECRETEDIT words here';
      document.getElementById('pw').value = 'SECRETPASS 99';
      document.getElementById('longnote').value = Array.from({ length: 160 }, (_, i) => 'lw' + i).join(' ');
      document.getElementById('cvc').value = 'Q7Z';
    })()`);
    // A 700-character note goes past the 500-character name cap: no part of it may survive.
    const h1Secrets = ['4111 1111 1111 1111', '4111', 'SECRETADDR', 'SECRETNOTE', 'SECRETOPTION', 'SECRETEDIT', 'SECRETPASS', 'lw0 lw1', 'lw40 lw41', 'lw100 lw101', 'Q7Z'];
    for (const id of ['cc', 'agree', 'addr', 'send', 'note', 'plan', 'pick', 'ed', 'post', 'pw', 'show', 'long', 'longnote', 'cvc', 'go']) {
      for (const operation of ['click', 'type']) check(await collectFloorFacts(page.io, await page.target(`#${id}`), operation, {}), h1Secrets, `h1 #${id} ${operation}`);
    }
    await page.goto(site.url('/h1c'));
    await page.evaluate("document.getElementById('host').shadowRoot.getElementById('inner').value = 'SHADOWSECRET 5'; document.getElementById('host').setAttribute('aria-labelledby', 'host')");
    check(await collectFloorFacts(page.io, await page.target('#host'), 'click', {}), ['SHADOWSECRET'], 'h1c shadow host');

    await page.goto(site.url('/h1b'));
    await page.evaluate("document.getElementById('search').value = 'order'");
    const po = await collectFloorFacts(page.io, await page.target('#po'), 'click', {});
    if (classifyFloor(po).floor !== 'payment') leaks.push(`h1b a search for "order" erased the pay button: ${JSON.stringify(classifyFloor(po))} name=${po.name}`);
    check(po, ['"order"'], 'h1b');

    await page.goto(site.url('/h1'));
    await page.evaluate("document.getElementById('cc').value = '4111 1111 1111 1111'");
    const card = await collectFloorFacts(page.io, await page.target('#cc'), 'type', {});
    if (classifyFloor(card).floor !== 'credentials') leaks.push(`h1 card field no longer credentials: ${JSON.stringify(classifyFloor(card))} name=${card.name}`);

    await page.goto(site.url('/m1'));
    const m1Secrets = ['SECRETDRAFT', 'SECRETTAIL', 'SECRETCOVER'];
    for (const selector of ['#t', '#ed2', '#under', '#cover']) {
      for (const operation of ['click', 'type']) check(await collectFloorFacts(page.io, await page.target(selector), operation, {}), m1Secrets, `m1 ${selector} ${operation}`);
    }
    const under = await collectFloorFacts(page.io, await page.target('#under'), 'click', {});
    if (!/^div#cover/.test(under.visibility.coveredBy ?? '')) leaks.push(`m1 overlay not reported: ${under.visibility.coveredBy}`);
    assert.deepEqual(leaks, []);
  } finally {
    await browser.close();
    await site.close();
  }
});

test('Opus gate M2/M3/M4/M6/L1/L4: floors the page cannot hide', { skip, timeout: 180000 }, async () => {
  const site = await startInlineSite(GATE_PAGES);
  const fixture = await startFixtureSite();
  const browser = await launch();
  try {
    const { page } = browser;
    const failures = [];
    const expect = async (label, target, operation, extra, floor, rule) => {
      const facts = await collectFloorFacts(page.io, target, operation, extra);
      const got = classifyFloor(facts);
      if (got.floor !== floor || (rule && got.rule !== rule)) failures.push(`${label}: expected ${floor}${rule ? `/${rule}` : ''}, got ${got.floor}/${got.rule} failed=${!!facts.factsFailed} name=${facts.name} text=${facts.text} snippets=${JSON.stringify(facts.snippets)} form=${JSON.stringify(facts.form)} submits=${facts.submits} optional=${facts.consentOptionalOn}`);
      return facts;
    };
    for (const id of ['/m2a', '/m2c', '/m2d']) {
      await page.goto(site.url(id));
      await expect(`${id} Create account`, await page.target('#create'), 'click', {}, 'consent');
    }
    await page.goto(site.url('/m2b'));
    await expect('m2b aria-hidden Place order', await page.target('#po'), 'click', {}, 'payment');

    await page.goto(site.url('/m3a'));
    await expect('m3a shadow Join', await page.targetBy("document.getElementById('host').shadowRoot.getElementById('join')"), 'click', {}, 'consent');
    await page.goto(site.url('/m3b'));
    const shadowLogin = await expect('m3b shadow form-less sign in', await page.targetBy("document.getElementById('host').shadowRoot.getElementById('signin')"), 'click', {}, 'credentials', 'submit-credentials-form');
    if (shadowLogin.factsFailed !== true) failures.push('m3b: a shadow target with no form or dialog must be factsFailed');
    await expect('m3b shadow password entry', await page.targetBy("document.getElementById('host').shadowRoot.getElementById('p')"), 'type', {}, 'credentials');
    await page.goto(site.url('/m3c'));
    const shadowForm = await expect('m3c shadow form sign in', await page.targetBy("document.getElementById('host').shadowRoot.getElementById('signin')"), 'click', {}, 'credentials', 'submit-credentials-form');

    if (shadowForm.factsFailed) failures.push('m3c: a shadow target inside a form is fully read');
    await page.goto(site.url('/m4a'));
    await expect('m4a div login', await page.target('#signin'), 'click', {}, 'credentials', 'submit-credentials-form');
    await page.goto(site.url('/m4b'));
    await expect('m4b form= password', await page.target('#go'), 'click', {}, 'credentials', 'submit-credentials-form');

    await page.goto(site.url('/m6'));
    await expect('m6 required-labelled optional toggle on', await page.target('#save'), 'click', {}, 'consent', 'cmp-save-choices');
    await page.evaluate("document.getElementById('partners').checked = false");
    await expect('m6 every optional toggle off', await page.target('#save'), 'click', {}, null, 'cmp-save-required-only');

    await page.goto(site.url('/l4'));
    await expect('l4 password past the field cap', await page.target('#go'), 'click', {}, 'credentials');

    // L1: a press acts on the focused element, whatever target the step named.
    await page.goto(fixture.url('h6-signin'));
    await page.evaluate("document.getElementById('username').focus()");
    const pressed = await expect('l1 Enter at focus', await page.target('h1'), 'press', { key: 'Enter' }, 'credentials');
    if (pressed.tag !== 'button' || pressed.submits !== true) failures.push(`l1 effect target: tag=${pressed.tag} submits=${pressed.submits}`);
    await page.goto(site.url('/l1f'));
    await page.evaluate("document.getElementById('fr').focus()");
    const framed = await collectFloorFacts(page.io, await page.target('p'), 'press', { key: 'Enter' });
    const framedResult = classifyFloor(framed);
    if (framed.factsFailed !== true || framed.frame?.readable !== false || framedResult.floor === null) failures.push(`l1 focus in a frame: ${JSON.stringify({ failed: framed.factsFailed, frame: framed.frame, result: framedResult })}`);

    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
    await site.close();
    await fixture.close();
  }
});

test('Opus gate round 2: Enter spellings, chat boxes, shadow submits, closed roots, labelledby descendants, masking', { skip, timeout: 240000 }, async () => {
  const site = await startInlineSite(ROUND2_PAGES);
  const browser = await launch();
  try {
    const { page } = browser;
    const failures = [];
    const brief = facts => JSON.stringify({ failed: facts.factsFailed, tag: facts.tag, type: facts.type, name: facts.name, submits: facts.submits, form: facts.form, key: facts.key });

    // N1: every spelling of Enter in the email field reaches the default submit and floors as credentials.
    const SPELLINGS = ['Enter', 'Return', 'enter', 'NumpadEnter', 'Shift+Enter', 'Control+Enter', undefined, '\n', '\r', '\r\n'];
    for (const id of ['/n1', '/n1b']) {
      await page.goto(site.url(id));
      for (const key of SPELLINGS) {
        await page.evaluate("document.getElementById('email').focus()");
        const facts = await collectFloorFacts(page.io, await page.target('#email'), 'press', key === undefined ? {} : { key });
        if (facts.submits !== true || facts.form?.hasPasswordField !== true) failures.push(`${id} key ${JSON.stringify(key)}: collector ${brief(facts)}`);
        const got = classifyFloor(facts);
        if (got.floor !== 'credentials') failures.push(`${id} key ${JSON.stringify(key)}: floor ${got.floor}/${got.rule} ${brief(facts)}`);
      }
    }
    await page.goto(site.url('/n1c'));
    // #c: one field and only type=button/reset controls: HTML still submits on Enter (no submit button, one field).
    for (const [sel, want] of [['#only', true], ['#a', false], ['#c', true]]) {
      await page.evaluate(`document.querySelector(${JSON.stringify(sel)}).focus()`);
      const facts = await collectFloorFacts(page.io, await page.target(sel), 'press', { key: 'Return' });
      if (facts.submits !== want) failures.push(`n1c ${sel} Enter: expected submits ${want}, got ${brief(facts)}`);
    }
    for (const sel of ['#tb', '#rb']) {
      const facts = await collectFloorFacts(page.io, await page.target(sel), 'click', {});
      if (facts.submits !== false) failures.push(`n1c ${sel} click: a type=button/reset control is proved not to submit, got ${brief(facts)}`);
    }

    // N3: Enter in a textarea, an editor or a role=textbox is unsure, never an explicit false.
    await page.goto(site.url('/n3'));
    for (const sel of ['#chat', '#ce', '#rt', '#ft']) {
      await page.evaluate(`document.querySelector(${JSON.stringify(sel)}).focus()`);
      const facts = await collectFloorFacts(page.io, await page.target(sel), 'press', { key: 'Enter' });
      if (facts.submits !== undefined) failures.push(`n3 ${sel}: submits must be unsure, got ${brief(facts)}`);
    }

    // N4: a shadow submit button in a light form, and a div button inside a form, both submit.
    await page.goto(site.url('/n4a'));
    const shadowSubmit = await collectFloorFacts(page.io, await page.targetBy("document.getElementById('host').shadowRoot.getElementById('b')"), 'click', {});
    const shadowGot = classifyFloor(shadowSubmit);
    if (shadowSubmit.submits !== true || shadowGot.floor !== 'credentials') failures.push(`n4a shadow submit: ${shadowGot.floor}/${shadowGot.rule} ${brief(shadowSubmit)}`);
    await page.goto(site.url('/n4b'));
    const divButton = await collectFloorFacts(page.io, await page.target('#lb'), 'click', {});
    const divGot = classifyFloor(divButton);
    if (divButton.submits !== true || divGot.floor !== 'credentials') failures.push(`n4b div button: ${divGot.floor}/${divGot.rule} ${brief(divButton)}`);

    // N5: closed shadow roots never let a value through and make the facts partial.
    await page.goto(site.url('/n5a'));
    await page.evaluate("window.__closedA.getElementById('inner').value = 'CLOSEDSECRET 41'; document.getElementById('host').setAttribute('aria-labelledby', 'host')");
    const closedHost = await collectFloorFacts(page.io, await page.target('#host'), 'click', {});
    if (JSON.stringify(closedHost).toLowerCase().includes('closedsecret') || closedHost.factsFailed !== true) failures.push(`n5a closed host: ${JSON.stringify(closedHost).slice(0, 500)}`);
    await page.goto(site.url('/n5b'));
    await page.evaluate("window.__closedB.getElementById('inner').value = '7316'");
    const closedLabel = await collectFloorFacts(page.io, await page.target('#ok'), 'click', {});
    if (JSON.stringify(closedLabel).includes('7316') || closedLabel.factsFailed !== true) failures.push(`n5b closed root in a labelledby target: ${JSON.stringify(closedLabel).slice(0, 500)}`);
    await page.goto(site.url('/n5c'));
    await page.evaluate("window.__closedC.getElementById('inner').focus()");
    const closedFocus = await collectFloorFacts(page.io, await page.target('#para'), 'press', { key: 'Enter' });
    // factsFailed is the collector's job; classifyFloor reads a partial click or Enter on a known tag as none (REPORT).
    if (closedFocus.factsFailed !== true) failures.push(`n5c focus inside a closed root: ${brief(closedFocus)}`);

    // N6: a short value reached through a descendant's aria-labelledby is caught.
    await page.goto(site.url('/n6'));
    await page.evaluate("document.getElementById('pin').value = '4821'");
    const pinButton = await collectFloorFacts(page.io, await page.target('#confirm'), 'click', {});
    if (JSON.stringify(pinButton).includes('4821')) failures.push(`n6 descendant labelledby: ${JSON.stringify(pinButton).slice(0, 500)}`);

    // L1: values are masked before any cut, so no fragment survives at the edge of a snippet.
    await page.goto(site.url('/l1'));
    await page.evaluate("document.getElementById('v').value = 'ZQ9XK7WM'; document.getElementById('echo').textContent = 'a'.repeat(996) + 'ZQ9XK7WM' + ' ' + 'lead ZQ9XK7WM' + 'b'.repeat(296)");
    const cut = await collectFloorFacts(page.io, await page.target('#go'), 'click', {});
    const cutJson = JSON.stringify(cut).toLowerCase();
    for (const fragment of ['zq9x', 'k7wm', 'q9xk', '9xk7']) if (cutJson.includes(fragment)) failures.push(`l1 fragment ${fragment} survived: before=${cut.snippets?.before?.slice(0, 40)} form=${cut.snippets?.form?.slice(990, 1000)}`);

    // L2: the title, the path, a field id or name and a covering element's id are scrubbed too.
    await page.goto(site.url('/l2'));
    await page.evaluate(`(() => {
      document.getElementById('v1').value = 'TITLESECRET9'; document.title = 'Hello TITLESECRET9';
      document.getElementById('v2').value = 'PATHSECRET77'; history.pushState({}, '', '/p/PATHSECRET77');
      document.getElementById('v3').value = 'NAMESECRET88'; document.getElementById('under').name = 'NAMESECRET88';
      document.getElementById('v4').value = 'COVERSECRET1'; document.getElementById('cov').id = 'COVERSECRET1';
    })()`);
    const scrubbed = await collectFloorFacts(page.io, await page.target('#under'), 'click', {});
    const scrubbedJson = JSON.stringify(scrubbed).toLowerCase();
    for (const secret of ['titlesecret9', 'pathsecret77', 'namesecret88', 'coversecret1']) if (scrubbedJson.includes(secret)) failures.push(`l2 ${secret} leaked: ${JSON.stringify({ page: scrubbed.page, fieldName: scrubbed.fieldName, coveredBy: scrubbed.visibility.coveredBy })}`);
    if (!scrubbed.visibility.coveredBy) failures.push('l2: the covering element must still be reported');

    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
    await site.close();
  }
});
