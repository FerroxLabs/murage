// SPDX-License-Identifier: AGPL-3.0-or-later
// Static assets for the fixture site. Everything is served same-origin so strict CSP pages
// (script-src 'self') can load it. Nothing here touches the network or a real third-party script.

export const REC_JS = `(() => {
  const page = (document.currentScript && document.currentScript.dataset.page) || location.pathname;
  const SENSITIVE = /pass|card|cvc|cvv|secret|token|otp/i;
  function send(kind, detail) {
    try {
      const body = JSON.stringify({ kind, page, detail: Object.assign({ frame: window.top !== window, path: location.pathname }, detail || {}) });
      const ok = navigator.sendBeacon && navigator.sendBeacon('/__rec', new Blob([body], { type: 'text/plain' }));
      if (!ok) fetch('/__rec', { method: 'POST', body, keepalive: true });
    } catch (e) { /* recording must never break the page */ }
  }
  window.__fixtureRec = send;
  function describe(el) {
    if (!(el instanceof Element)) return {};
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('alt') || '').trim().slice(0, 80);
    return { tag: el.tagName.toLowerCase(), id: el.id || undefined, name: el.getAttribute('name') || undefined, type: el.getAttribute('type') || undefined, text, href: el.getAttribute('href') || undefined, rec: el.getAttribute('data-rec') || undefined };
  }
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? (e.target.closest('a,button,input,label,select,textarea,[role=button],[data-rec]') || e.target) : null;
    send('click', Object.assign(describe(t), { trusted: e.isTrusted }));
  }, true);
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const d = describe(t);
    const sensitive = SENSITIVE.test(d.name || '') || d.type === 'password';
    d.length = typeof t.value === 'string' ? t.value.length : undefined;
    if (d.type === 'checkbox' || d.type === 'radio') d.checked = t.checked;
    if (t.tagName === 'SELECT') d.value = t.value;
    if (!sensitive && (d.type === 'text' || d.type === 'email' || d.type === 'search') && d.length <= 200) d.value = t.value;
    d.text = undefined;
    send('change', d);
  }, true);
  const timers = new Map();
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;
    clearTimeout(timers.get(t));
    timers.set(t, setTimeout(() => send('input', { name: t.getAttribute('name') || undefined, id: t.id || undefined, type: t.getAttribute('type') || undefined, length: t.value.length }), 120));
  }, true);
  document.addEventListener('securitypolicyviolation', (e) => {
    send('csp-violation', { directive: e.violatedDirective, blocked: String(e.blockedURI).slice(0, 120), sample: String(e.sample || '').slice(0, 80) });
  });
  window.addEventListener('pagehide', () => send('pagehide', {}));
})();`;

export const FIXTURE_CSS = `
:root { color-scheme: light; font-family: system-ui, sans-serif; }
body { margin: 0 auto; max-width: 860px; padding: 16px; line-height: 1.45; }
nav a { margin-right: 12px; }
label { display: block; margin: 8px 0 2px; }
input[type=text], input[type=email], input[type=tel], input[type=password], input[type=search], input[type=number], textarea, select { width: 100%; max-width: 480px; padding: 6px; box-sizing: border-box; }
button, .btn { padding: 8px 14px; margin: 6px 6px 6px 0; cursor: pointer; }
.banner { position: fixed; left: 0; right: 0; bottom: 0; background: #eee; border-top: 1px solid #999; padding: 12px; }
.hidden-offscreen { position: absolute; left: -9999px; top: -9999px; }
.hidden-display { display: none; }
.white-on-white { color: #fff; background: #fff; font-size: 2px; }
table { border-collapse: collapse; width: 100%; }
td, th { border-bottom: 1px solid #ddd; padding: 2px 6px; text-align: left; }
.card { border: 1px solid #bbb; padding: 12px; margin: 12px 0; }
#result { margin: 12px 0; padding: 6px; background: #f4f4f4; min-height: 1.5em; }
.spacer { height: 1600px; }
`;

export const DIALOGS_JS = `(() => {
  const out = document.getElementById('result');
  const rec = window.__fixtureRec;
  function say(msg) { if (out) out.textContent = msg; }
  let guard = false;
  const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; rec('dialog', { kind: 'beforeunload', shown: true }); };
  document.getElementById('do-alert').addEventListener('click', () => { alert('Fixture alert: saved'); rec('dialog', { kind: 'alert', result: 'dismissed' }); say('alert dismissed'); });
  document.getElementById('do-confirm').addEventListener('click', () => { const r = confirm('Do you agree to the updated terms?'); rec('dialog', { kind: 'confirm', message: 'Do you agree to the updated terms?', result: r }); say('confirm=' + r); });
  document.getElementById('do-prompt').addEventListener('click', () => { const r = prompt('Name for the report?', 'Report'); rec('dialog', { kind: 'prompt', result: r === null ? null : String(r).slice(0, 80) }); say('prompt=' + r); });
  document.getElementById('do-beforeunload').addEventListener('click', () => {
    guard = !guard;
    if (guard) window.addEventListener('beforeunload', onBeforeUnload); else window.removeEventListener('beforeunload', onBeforeUnload);
    rec('dialog', { kind: 'beforeunload-armed', armed: guard });
    say('beforeunload ' + (guard ? 'armed' : 'disarmed'));
  });
})();`;

export const CONFIRM_TERMS_JS = `(() => {
  document.getElementById('continue').addEventListener('click', () => {
    const r = confirm('Do you agree to the updated terms?');
    window.__fixtureRec('dialog', { kind: 'confirm', message: 'Do you agree to the updated terms?', result: r });
    if (r) location.href = '/h10-dashboard';
  });
})();`;

export const SPA_JS = `(() => {
  const view = document.getElementById('view');
  const rec = window.__fixtureRec;
  function render() { view.textContent = 'SPA view: ' + location.pathname + location.search; rec('nav', { path: location.pathname + location.search }); }
  document.getElementById('push').addEventListener('click', () => { history.pushState({ n: 2 }, '', '/spa/step2'); render(); });
  document.getElementById('replace').addEventListener('click', () => { history.replaceState({ n: 3 }, '', '/spa/step3?replaced=1'); render(); });
  document.getElementById('js-redirect').addEventListener('click', () => { location.replace('/redirect/js-target'); });
  window.addEventListener('popstate', render);
  render();
})();`;

export const SHADOW_JS = `(() => {
  const rec = window.__fixtureRec;
  function build(host, mode, label) {
    const root = host.attachShadow({ mode });
    const wrap = document.createElement('div');
    const input = document.createElement('input');
    input.setAttribute('aria-label', label + ' shadow input');
    input.name = label + '-shadow-input';
    const btn = document.createElement('button');
    btn.textContent = 'Shadow ' + label + ' button';
    btn.addEventListener('click', () => rec('click', { tag: 'button', rec: 'shadow-' + label, text: btn.textContent }));
    wrap.append(input, btn);
    root.append(wrap);
    return root;
  }
  build(document.getElementById('open-host'), 'open', 'open');
  // The closed root is deliberately not kept anywhere reachable from the page.
  const closedHost = document.getElementById('closed-host');
  if (closedHost) build(closedHost, 'closed', 'closed');
})();`;

export const INFINITE_JS = `(() => {
  const list = document.getElementById('items');
  const sentinel = document.getElementById('sentinel');
  const rec = window.__fixtureRec;
  let offset = 0, loading = false, done = false;
  async function more() {
    if (loading || done) return;
    loading = true;
    const r = await fetch('/fixture-api/items?offset=' + offset + '&limit=40');
    const j = await r.json();
    for (const it of j.items) { const li = document.createElement('li'); li.textContent = it; list.append(li); }
    offset = j.next;
    if (j.next >= j.total) { done = true; sentinel.textContent = 'End of list'; }
    rec('load', { offset });
    loading = false;
  }
  new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) more(); }).observe(sentinel);
  more();
})();`;

export const ROWS_JS = `(() => {
  const body = document.getElementById('rows');
  const cat = document.getElementById('f-cat');
  const max = document.getElementById('f-max');
  const q = document.getElementById('f-q');
  const count = document.getElementById('count');
  function apply() {
    let n = 0;
    for (const tr of body.rows) {
      const ok = (!cat.value || tr.dataset.cat === cat.value) && (!max.value || Number(tr.dataset.price) <= Number(max.value)) && (!q.value || tr.textContent.toLowerCase().includes(q.value.toLowerCase()));
      tr.hidden = !ok;
      if (ok) n++;
    }
    count.textContent = String(n);
  }
  for (const el of [cat, max, q]) el.addEventListener('input', apply);
  apply();
})();`;

export const POPUP_JS = `(() => {
  const rec = window.__fixtureRec;
  const open = document.getElementById('open-popup');
  if (open) open.addEventListener('click', () => { const w = window.open('/t6-oauth-popup', 'oauthpopup', 'width=480,height=600'); rec('popup', { opened: !!w }); });
  const close = document.getElementById('popup-close');
  if (close) close.addEventListener('click', () => { rec('popup', { closing: true }); window.close(); });
  const allow = document.getElementById('popup-allow');
  if (allow) allow.addEventListener('click', () => { rec('popup', { decision: 'allow' }); if (window.opener) window.opener.postMessage('fixture-oauth-allowed', location.origin); window.close(); });
  window.addEventListener('message', (e) => { if (e.origin === location.origin) { const r = document.getElementById('result'); if (r) r.textContent = String(e.data); rec('message', { data: String(e.data).slice(0, 60) }); } });
})();`;

export const CMP_JS = `(() => {
  const rec = window.__fixtureRec;
  for (const b of document.querySelectorAll('[data-dismiss]')) {
    b.addEventListener('click', () => { rec('cookie-choice', { choice: b.getAttribute('data-dismiss') }); const t = document.querySelector('[data-banner]'); if (t) t.hidden = true; });
  }
})();`;

export const TT_JS = `(() => {
  const rec = window.__fixtureRec;
  const out = document.getElementById('result');
  const policy = window.trustedTypes.createPolicy('fixture-policy', { createHTML: (s) => s });
  out.innerHTML = policy.createHTML('<b>Trusted Types render ok</b>');
  document.getElementById('raw').addEventListener('click', () => {
    try { document.getElementById('sink').innerHTML = '<i>raw</i>'; rec('tt', { raw: 'allowed' }); }
    catch (e) { rec('tt', { raw: 'blocked' }); document.getElementById('sink').textContent = 'raw innerHTML blocked'; }
  });
})();`;

export const CSP_JS = `(() => { document.getElementById('result').textContent = 'Strict CSP script ran'; })();`;

export const SCROLL_JS = `(() => { window.__fixtureRec('scroll-ready', { height: document.documentElement.scrollHeight }); })();`;

export const S_POPUPS_JS = `(() => {
  const rec = window.__fixtureRec;
  const b = document.getElementById('open-other-popup');
  b.addEventListener('click', () => { const w = window.open(b.dataset.alt + '/t5-site-b', 'otherpopup', 'width=480,height=600'); rec('popup', { opened: !!w, other: true }); });
})();`;

export const S_SHADOW_LATE_JS = `(() => {
  const rec = window.__fixtureRec;
  const host = document.getElementById('late-host');
  const root = host.attachShadow({ mode: 'open' });
  const wrap = document.createElement('div');
  const field = document.createElement('input'); field.setAttribute('aria-label', 'Nickname'); field.name = 'nickname';
  const btn = document.createElement('button'); btn.textContent = 'Late button'; btn.addEventListener('click', () => rec('click', { tag: 'button', rec: 'late-button' }));
  wrap.append(field, btn); root.append(wrap);
  // After the page has been looked at, a component renders a password field inside the open root.
  window.__addPrivateField = () => { const p = document.createElement('input'); p.type = 'password'; p.setAttribute('aria-label', 'Password'); p.name = 'late-password'; root.append(p); document.getElementById('late-status').textContent = 'private field added'; };
})();`;

export const STATIC_FILES = {
  '/static/rec.js': ['text/javascript', REC_JS],
  '/static/fixture.css': ['text/css', FIXTURE_CSS],
  '/static/dialogs.js': ['text/javascript', DIALOGS_JS],
  '/static/confirm-terms.js': ['text/javascript', CONFIRM_TERMS_JS],
  '/static/spa.js': ['text/javascript', SPA_JS],
  '/static/shadow.js': ['text/javascript', SHADOW_JS],
  '/static/infinite.js': ['text/javascript', INFINITE_JS],
  '/static/rows.js': ['text/javascript', ROWS_JS],
  '/static/popup.js': ['text/javascript', POPUP_JS],
  '/static/cmp.js': ['text/javascript', CMP_JS],
  '/static/tt.js': ['text/javascript', TT_JS],
  '/static/csp.js': ['text/javascript', CSP_JS],
  '/static/scroll.js': ['text/javascript', SCROLL_JS],
  '/static/s-popups.js': ['text/javascript', S_POPUPS_JS],
  '/static/s-shadow-late.js': ['text/javascript', S_SHADOW_LATE_JS],
};
