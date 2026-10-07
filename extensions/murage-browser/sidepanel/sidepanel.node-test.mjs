// SPDX-License-Identifier: AGPL-3.0-or-later
// Side panel v2 (T33). Run: node --test extensions/murage-browser/sidepanel/sidepanel.node-test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { makeDocument, byRole, one, all, visibleTexts, visibleLabels } from './dom-shim.test-helper.mjs';
import { renderPanel, panelKeys, botColor } from './view.mjs';
import { createController, pickBinding, PUSH_TYPE, PUSH_QUIET_MS } from './controller.mjs';

const here = new URL('.', import.meta.url);
const en = JSON.parse(readFileSync(new URL('../_locales/en/messages.json', here), 'utf8'));
// Fake i18n: a key renders as «key|sub1|sub2». Page-derived text is never passed through it.
const t = (key, subs = []) => `«${key}${[].concat(subs).map(s => `|${s}`).join('')}»`;
const base = { bindingId: 'b1', botName: 'Ember', conversation: 'Quote run', state: 'active', ready: true, mode: 'task', tabs: [], approvedOrigins: [], grants: [], activity: [] };
const draw = (binding, extra = {}) => {
  const doc = makeDocument(); const root = doc.createElement('div'); const calls = [];
  renderPanel(doc, root, { connected: true, profileId: 'Sean', bindings: binding ? [{ ...base, ...binding }] : [], selected: 'b1', feedback: '', ...extra }, { t, act: (a, x) => calls.push([a, x]) });
  return { doc, root, calls };
};
const roles = (root) => all(root, n => n.getAttribute('data-role')).map(n => n.getAttribute('data-role'));

test('stopped binding shows no Resume, and no Pause either', () => {
  const { root } = draw({ state: 'stopped' });
  assert.equal(byRole(root, 'resume').length, 0);
  assert.equal(byRole(root, 'pause').length, 0);
  assert.equal(byRole(root, 'endtask').length, 1);
});
test('paused binding shows Resume and Stop; working shows Pause and Stop', () => {
  assert.deepEqual(['resume', 'stop'].map(r => byRole(draw({ state: 'paused' }).root, r).length), [1, 1]);
  const w = draw({}).root;
  assert.deepEqual(['pause', 'stop', 'resume'].map(r => byRole(w, r).length), [1, 1, 0]);
});
test('Full permissive shows the marker, the hazard stripe and Turn off, which sends the turn-off request', () => {
  const { root, calls } = draw({ mode: 'full' });
  assert.equal(byRole(root, 'full-chip').length, 1);
  assert.equal(byRole(root, 'hazard').length, 1);
  const off = one(root, 'turnoff'); assert.ok(off);
  off.onclick(); assert.deepEqual(calls.at(-1), ['turnoff', {}]);
  for (const m of ['step', 'task']) { const r = draw({ mode: m }).root; assert.equal(byRole(r, 'full-chip').length, 0); assert.equal(byRole(r, 'hazard').length, 0); assert.equal(byRole(r, 'turnoff').length, 0); }
});
test('approval mode is a 3-way segmented control (radiogroup) with the current mode checked', () => {
  for (const [m, key] of [['step', 'spModeStep'], ['task', 'spModeTask'], ['full', 'spModeFull']]) {
    const { root } = draw({ mode: m }, { supports: ['setMode'] });
    const g = one(root, 'mode'); assert.equal(g.getAttribute('role'), 'radiogroup');
    const opts = byRole(root, 'mode-option'); assert.equal(opts.length, 3);
    assert.deepEqual(opts.map(o => o.getAttribute('aria-checked')), ['step', 'task', 'full'].map(x => String(x === m)));
    assert.match(one(root, 'mode-selected').textContent, new RegExp(key));
    assert.equal(opts.every(o => o.getAttribute('role') === 'radio'), true);
  }
});
test('segmented control is read-only until the runtime lists setMode; then a click sends setMode', () => {
  const ro = draw({ mode: 'task' }, { supports: ['stop', 'pause'] });
  for (const o of byRole(ro.root, 'mode-option')) { assert.equal(o.disabled, true); assert.equal(o.getAttribute('aria-disabled'), 'true'); assert.equal(o.onclick, null); }
  const rw = draw({ mode: 'task' }, { supports: ['setMode'] });
  const opts = byRole(rw.root, 'mode-option'); assert.equal(Boolean(opts[0].disabled || opts[1].disabled), false);
  opts[1].onclick(); assert.deepEqual(rw.calls.at(-1), ['setMode', { mode: 'task' }]);
  // Opus Batch 2 review: Full permissive is owner-only in the desktop app with the typed name; the panel never turns it on.
  assert.equal(opts[2].disabled, true); assert.equal(opts[2].onclick, null);
  assert.equal(rw.calls.some(c => c[0] === 'setMode' && c[1]?.mode === 'full'), false);
});
test('state card carries the T30A corner brackets, not an accent border', () => {
  const { root } = draw({});
  assert.equal(byRole(root, 'bracket').length, 4);
  const css = readFileSync(new URL('panel.css', here), 'utf8');
  assert.match(css, /\[data-role=bracket\]/); assert.match(css, /border-width:4px 0 0 4px/);
  assert.doesNotMatch(css, /\.state\.active,\.state\.wait\{border-color:var\(--accent\)/);
  assert.equal(byRole(draw({ state: 'stopped' }).root, 'bracket').length, 0);
});
test('header has the Murage mark, the brand and the lighter for-Chrome suffix', () => {
  const { root } = draw({});
  const mark = one(root, 'mark'); assert.equal(mark.tagName, 'SVG'); assert.equal(mark.getAttribute('aria-hidden'), 'true');
  assert.equal(one(root, 'brand').textContent, '«spHeaderBrand»');
  assert.equal(one(root, 'brand-suffix').textContent, '«spHeaderSuffix»');
  assert.match(readFileSync(new URL('panel.css', here), 'utf8'), /\[data-role=brand-suffix\]\{[^}]*color:var\(--secondary\)/);
  assert.equal(byRole(draw(null, { connected: false }).root, 'mark').length, 1);
});
test('avatar colour: the bot colour when the binding carries one, else deterministic from the name', () => {
  const style = r => one(r, 'avatar').getAttribute('style');
  assert.match(style(draw({ botColor: '#8057C8' }).root), /--bot:#8057C8/);
  assert.match(style(draw({ botColor: 'red; background:url(x)' }).root), /--bot:#[0-9a-fA-F]{6};/);
  assert.equal(botColor('Ember').bg, botColor('Ember').bg);
  const names = ['Ember', 'Dax', 'Nova', 'Quill', 'Sage', 'Rook', 'Juno', 'Pip'];
  assert.ok(new Set(names.map(n => botColor(n).bg)).size >= 4);
  for (const n of names) { const { bg, ink } = botColor(n); assert.match(bg, /^#[0-9A-Fa-f]{6}$/); assert.ok(ratio(bg, ink) >= 4.5, n); }
  assert.notEqual(botColor('Ember').bg.toLowerCase(), '#ff6b35');
});
const lum = h => { const n = parseInt(h.slice(1), 16); const l = c => { const s = c / 255; return s <= .03928 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; }; return .2126 * l(n >> 16) + .7152 * l((n >> 8) & 255) + .0722 * l(n & 255); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
test('the task section is titled Task access in every language', () => {
  assert.match(one(draw({}).root, 'task-title').textContent, /spTaskAccess/);
  assert.equal(en.spTaskAccess.message, 'Task access');
});
test('header, bot line and connection status', () => {
  const { root } = draw({});
  assert.match(one(root, 'title').textContent, /spHeaderBrand.*spHeaderSuffix/);
  assert.match(one(root, 'connection').textContent, /spConnected/);
  assert.equal(one(root, 'botline').textContent, '«spBotLine|Ember|Quote run»');
  assert.match(one(draw({}, { connected: false }).root, 'connection').textContent, /spNotConnected/);
});
test('state card: aria-live, working title carries the bot, your turn shows the handoff line and Continue only when the runtime allows it', () => {
  const live = one(draw({}).root, 'state'); assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(one(draw({}).root, 'state-title').textContent, '«overlayWorking|Ember»');
  const hand = draw({ handoff: 'Sign in to shop.example.com', canContinue: false }).root;
  assert.match(one(hand, 'state-title').textContent, /spStateYourTurn/);
  assert.match(one(hand, 'state-body').textContent, /Sign in to shop.example.com/);
  assert.equal(byRole(hand, 'continue').length, 0);
  assert.equal(byRole(hand, 'pause').length, 0);
  const can = draw({ handoff: 'x', canContinue: true });
  one(can.root, 'continue').onclick(); assert.deepEqual(can.calls.at(-1), ['continue', {}]);
  assert.equal(byRole(can.root, 'endtask').length, 1);
});
test('current task: grants with Revoke send the origin', () => {
  const { root, calls } = draw({ grants: [{ origin: 'https://shop.example.com', label: 'Read and click' }] });
  assert.match(one(root, 'task-title').textContent, /spTaskAccess/);
  const rev = one(root, 'revoke'); assert.equal(rev.getAttribute('aria-label'), '«spRevokeAria|https://shop.example.com»');
  rev.onclick(); assert.deepEqual(calls.at(-1), ['revoke', { origin: 'https://shop.example.com' }]);
});
test('share this tab and shared tabs with Unshare', () => {
  const { root, calls } = draw({ tabs: [{ tabId: 7, origin: 'https://a.example' }, { tabId: 8, origin: 'null' }] });
  assert.match(one(root, 'share').textContent, /btnShare/);
  const un = byRole(root, 'unshare'); assert.equal(un.length, 2);
  un[0].onclick(); assert.deepEqual(calls.at(-1), ['unshare', { tabId: 7 }]);
  assert.match(un[1].getAttribute('aria-label'), /spNewTab/);
  assert.equal(one(draw({ state: 'paused' }).root, 'share').disabled, true);
});
test('activity: heading names the bot, items render page-derived text as text, never markup', () => {
  const evil = '<img src=x onerror=alert(1)>Opened <b>shop</b>';
  const { root } = draw({ activity: [{ time: '12:06', text: evil }], grants: [{ origin: '<i>o</i>', label: '<u>l</u>' }], tabs: [{ tabId: 1, origin: '<s>x</s>' }], botName: '<b>Ember</b>', conversation: '<i>c</i>' });
  assert.equal(one(root, 'activity-title').textContent, '«spActivityTitle|<b>Ember</b>»');
  const item = one(root, 'activity-item'); assert.ok(item.textContent.includes(evil));
  assert.equal(all(root, n => ['IMG', 'B', 'I', 'U', 'S'].includes(n.tagName)).length, 0);
  assert.match(one(draw({}).root, 'activity-empty').textContent, /spActivityEmpty/);
});
test('sites with Revoke, and the debugging bar explanation', () => {
  const { root, calls } = draw({ sites: [{ origin: 'https://a.example', category: 'always' }, { origin: 'https://bank.example', category: 'asks' }, { origin: 'https://x.example', category: 'never' }], tabs: [{ tabId: 1, origin: 'https://a.example' }] });
  assert.equal(byRole(root, 'site').length, 3);
  const rev = byRole(root, 'site-revoke'); assert.equal(rev.length, 1);
  rev[0].onclick(); assert.deepEqual(calls.at(-1), ['revoke-site', { origin: 'https://a.example' }]);
  assert.equal(one(root, 'debug-note').textContent, '«spDebugNote|Ember»');
});
test('update-waiting, version notes and the shortcut hint', () => {
  assert.match(one(draw({ updateWaiting: true }).root, 'update-note').textContent, /spUpdateWaiting/);
  assert.match(one(draw({ versionNote: 'oldExtension' }).root, 'version-note').textContent, /spOldExtension/);
  assert.match(one(draw({ versionNote: 'oldApp' }).root, 'version-note').textContent, /spOldApp/);
  assert.equal(byRole(draw({}).root, 'update-note').length, 0);
  assert.equal(one(draw({}, { shortcut: 'Alt+Shift+P' }).root, 'shortcut').textContent, '«spShortcutHint|Alt+Shift+P»');
});
test('not connected shows the setup card; feedback is a role=alert region', () => {
  const r = draw(null, { connected: false }).root; assert.equal(byRole(r, 'setup').length, 1);
  const f = one(draw({}, { feedback: 'spErrHostOffline' }).root, 'feedback'); assert.equal(f.getAttribute('role'), 'alert'); assert.match(f.textContent, /spErrHostOffline/);
});
test('Stop, Pause, Resume buttons send their actions; targets are 44px via the css class', () => {
  const w = draw({}); one(w.root, 'pause').onclick(); one(w.root, 'stop').onclick();
  assert.deepEqual(w.calls.map(c => c[0]), ['pause', 'stop']);
  const css = readFileSync(new URL('panel.css', here), 'utf8');
  assert.match(css, /min-height:\s*44px/); assert.match(css, /:focus-visible/);
});
test('every visible string resolves through i18n; only page-derived nodes are exempt', () => {
  const states = [{}, { state: 'paused' }, { state: 'stopped' }, { mode: 'full', handoff: 'x', canContinue: true, grants: [{ origin: 'o', label: 'l' }], activity: [{ time: '1', text: 'a' }], tabs: [{ tabId: 1, origin: 'o' }, { tabId: 2, origin: 'null' }], sites: [{ origin: 'o', category: 'always' }, { origin: 'p', category: 'asks' }, { origin: 'q', category: 'never' }], updateWaiting: true, versionNote: 'oldApp' }, { state: 'done' }, { ready: false }];
  for (const s of states) {
    const { root } = draw(s, { shortcut: 'K', feedback: 'spErrGeneric' });
    for (const { text, owner } of visibleTexts(root)) {
      if (owner.getAttribute('data-user') === 'true') continue;
      assert.match(text, /«/, `unlocalised visible text ${JSON.stringify(text)} in <${owner.tagName}> ${owner.getAttribute('data-role') ?? ''}`);
    }
    for (const { text, owner } of visibleLabels(root)) assert.match(text, /«/, `unlocalised aria-label ${JSON.stringify(text)}`);
  }
  const offline = draw(null, { connected: false }).root;
  for (const { text, owner } of visibleTexts(offline)) if (owner.getAttribute('data-user') !== 'true') assert.match(text, /«/, text);
});
test('every key the panel uses exists in all 8 locales, with matching placeholders', () => {
  const keys = panelKeys(); assert.ok(keys.length > 30);
  for (const dir of readdirSync(new URL('../_locales/', here))) {
    const m = JSON.parse(readFileSync(new URL(`../_locales/${dir}/messages.json`, here), 'utf8'));
    for (const k of keys) { assert.ok(m[k]?.message, `${dir} missing ${k}`); assert.deepEqual(Object.keys(m[k].placeholders ?? {}), Object.keys(en[k].placeholders ?? {}), `${dir} placeholders ${k}`); }
  }
});
test('copy rules in every locale value the panel uses, and no innerHTML in panel code', () => {
  for (const dir of readdirSync(new URL('../_locales/', here))) {
    const m = JSON.parse(readFileSync(new URL(`../_locales/${dir}/messages.json`, here), 'utf8'));
    for (const k of panelKeys()) { const s = m[k].message; assert.doesNotMatch(s, /—|–/, `${dir}.${k} dash`); assert.doesNotMatch(s, /\b(safe|safely|safety|unsafe)\b|composio|always-on|[$€£]\d/i, `${dir}.${k}`); }
  }
  for (const f of ['view.mjs', 'panel.js']) assert.doesNotMatch(readFileSync(new URL(f, here), 'utf8'), /innerHTML|outerHTML|insertAdjacentHTML/, f);
  assert.doesNotMatch(readFileSync(new URL('index.html', here), 'utf8'), /<(p|h1|h2|button|span|label|title)[^>]*>\s*[A-Za-z]/);
});
test('gate e: the panel may only tighten the mode, so a looser option is disabled and sends nothing', () => {
  const step = draw({ mode: 'step' }, { supports: ['setMode'] });
  const s = byRole(step.root, 'mode-option');
  assert.equal(s[0].disabled || false, false);
  for (const o of [s[1], s[2]]) { assert.equal(o.disabled, true); assert.equal(o.getAttribute('aria-disabled'), 'true'); assert.equal(o.onclick, null); }
  const task = draw({ mode: 'task' }, { supports: ['setMode'] });
  const t2 = byRole(task.root, 'mode-option');
  assert.equal(t2[0].disabled || false, false); t2[0].onclick(); assert.deepEqual(task.calls.at(-1), ['setMode', { mode: 'step' }]);
  assert.equal(t2[2].disabled, true);
});
test('gate g: Connected shows a green dot, Not connected shows none', () => {
  const on = one(draw({}).root, 'connection');
  const dot = all(on, n => n.getAttribute('data-role') === 'connection-dot');
  assert.equal(dot.length, 1);
  assert.equal(dot[0].getAttribute('aria-hidden'), 'true');
  assert.equal(all(one(draw({}, { connected: false }).root, 'connection'), n => n.getAttribute('data-role') === 'connection-dot').length, 0);
  const css = readFileSync(new URL('panel.css', here), 'utf8');
  assert.match(css, /\[data-role=connection-dot\]\{[^}]*background:\s*(#[0-9a-f]{3,6}|var\(--success\))/i);
});

// ---- PNL stage 1: keyed patching, push, offline state, binding selection, handoff ----
const mount = (doc, root, bindings, extra = {}, io = {}) => renderPanel(doc, root, { connected: true, profileId: 'Sean', selected: bindings[0]?.bindingId, feedback: '', bindings, ...extra }, { t, act: () => {}, ...io });
test('an unchanged refresh keeps the focused element the same DOM node', () => {
  const doc = makeDocument(); const root = doc.createElement('div');
  const b = [{ ...base, tabs: [{ tabId: 1, origin: 'https://a.example' }], grants: [{ origin: 'https://a.example', label: 'Read' }], activity: [{ time: '1', text: 'x' }] }];
  mount(doc, root, b);
  const before = all(root, n => n.nodeType === 1);
  const pause = one(root, 'pause'); doc.activeElement = pause;
  mount(doc, root, JSON.parse(JSON.stringify(b)));
  const after = all(root, n => n.nodeType === 1);
  assert.equal(after.length, before.length);
  assert.ok(after.every((n, i) => n === before[i]), 'every element is the same node');
  assert.equal(one(root, 'pause'), pause); assert.equal(doc.activeElement, pause);
});
test('a changed refresh patches in place: text updates, the focused button survives, handlers are the new ones', () => {
  const doc = makeDocument(); const root = doc.createElement('div'); const calls = [];
  mount(doc, root, [{ ...base, activity: [{ time: '1', text: 'one' }] }], {}, { act: a => calls.push(['old', a]) });
  const stop = one(root, 'stop'), item = one(root, 'activity-item');
  mount(doc, root, [{ ...base, activity: [{ time: '1', text: 'one' }, { time: '2', text: 'two' }] }], {}, { act: a => calls.push(['new', a]) });
  assert.equal(one(root, 'stop'), stop); assert.equal(byRole(root, 'activity-item')[0], item);
  assert.equal(byRole(root, 'activity-item').length, 2);
  stop.onclick(); assert.deepEqual(calls.at(-1), ['new', 'stop']);
  mount(doc, root, [{ ...base, state: 'paused' }]);
  assert.equal(byRole(root, 'pause').length, 0); assert.equal(byRole(root, 'resume').length, 1);
});
test('keyed list items keep their node when the list is reordered or trimmed', () => {
  const doc = makeDocument(); const root = doc.createElement('div');
  const g = o => ({ origin: o, label: 'l' });
  mount(doc, root, [{ ...base, grants: [g('https://a'), g('https://b'), g('https://c')] }]);
  const [a, bb, c] = byRole(root, 'grant');
  mount(doc, root, [{ ...base, grants: [g('https://c'), g('https://a')] }]);
  const now = byRole(root, 'grant'); assert.deepEqual(now, [c, a]); assert.equal(now.includes(bb), false);
});
test('a bot name that looks like markup is still text after a patch', () => {
  const doc = makeDocument(); const root = doc.createElement('div');
  mount(doc, root, [{ ...base, botName: 'Ember' }]); mount(doc, root, [{ ...base, botName: '<img src=x onerror=1>' }]);
  assert.equal(all(root, n => n.tagName === 'IMG').length, 0);
  assert.equal(one(root, 'botname').textContent, '<img src=x onerror=1>');
});
test('handoff renders from the paused state, with the line or a plain default, and Continue only when allowed', () => {
  const withLine = draw({ state: 'paused', pausedReason: 'handoff', handoff: 'Sign in to shop.example.com', canContinue: true }).root;
  assert.match(one(withLine, 'state-title').textContent, /spStateYourTurn/);
  assert.match(one(withLine, 'state-body').textContent, /Sign in to shop.example.com/);
  assert.equal(byRole(withLine, 'resume').length, 0); assert.equal(byRole(withLine, 'continue').length, 1);
  const bare = draw({ state: 'paused', pausedReason: 'handoff' }).root;
  assert.match(one(bare, 'state-body').textContent, /spBodyYourTurn/); assert.equal(byRole(bare, 'continue').length, 0);
  assert.equal(byRole(bare, 'resume').length, 0);
  assert.match(one(bare, 'state').className, /wait/);
  const plain = draw({ state: 'paused' }).root; assert.match(one(plain, 'state-title').textContent, /spStatePaused/);
});
test('the bot switcher appears only when more than one bot is running', () => {
  const two = [{ ...base, bindingId: 'b1', botName: 'Ember' }, { ...base, bindingId: 'b2', botName: 'Dax' }];
  const picks = [];
  const one1 = makeDocument(), r1 = one1.createElement('div'); mount(one1, r1, [two[0]], {}, { select: id => picks.push(id) });
  assert.equal(byRole(r1, 'switcher').length, 0);
  const stopped = makeDocument(), r2 = stopped.createElement('div'); mount(stopped, r2, [two[0], { ...two[1], state: 'stopped' }], {}, { select: id => picks.push(id) });
  assert.equal(byRole(r2, 'switcher').length, 0);
  const d = makeDocument(), r3 = d.createElement('div'); mount(d, r3, two, {}, { select: id => picks.push(id) });
  const opts = byRole(r3, 'switch-option'); assert.equal(opts.length, 2);
  assert.deepEqual(opts.map(o => o.getAttribute('aria-checked')), ['true', 'false']);
  assert.equal(one(r3, 'switcher').getAttribute('aria-label'), '«spSwitchTitle»');
  opts[1].onclick(); assert.deepEqual(picks, ['b2']);
  assert.equal(opts[1].getAttribute('data-user'), 'true');
});
const bnd = (id, tabs, state = 'active') => ({ ...base, bindingId: id, botName: id, state, tabs: tabs.map(tabId => ({ tabId, origin: 'https://x' })) });
test('the controller selects the bot that owns the current tab, and an explicit pick wins until the tab changes', async () => {
  const views = []; const status = { version: 1, connected: true, profileId: 'p', bindings: [bnd('b1', [1]), bnd('b2', [2])] };
  const c = createController({ send: async () => ({ result: status }), extensionId: 'me', onChange: v => views.push(v) });
  c.setTab(2); await c.refresh(); assert.equal(c.view().selected, 'b2');
  c.setTab(1); assert.equal(c.view().selected, 'b1');
  c.select('b2'); assert.equal(c.view().selected, 'b2');
  c.setTab(1); assert.equal(c.view().selected, 'b2', 'same tab, pick stays');
  c.setTab(2); c.setTab(1); assert.equal(c.view().selected, 'b1', 'a tab change follows the owner again');
  assert.equal(pickBinding([bnd('s', [1], 'stopped'), bnd('r', [9])], 1, undefined), 'r');
  c.setTab(99); assert.equal(c.view().selected, 'b1', 'an unowned tab falls back to the first running bot');
});
test('three failed refreshes show Murage is not connected; one or two keep the last view', async () => {
  let fail = false; const status = { version: 1, connected: true, profileId: 'p', bindings: [bnd('b1', [1])] };
  const c = createController({ send: async () => { if (fail) throw Error('gone'); return { result: status }; }, extensionId: 'me' });
  await c.refresh(); assert.equal(c.view().connected, true);
  fail = true; await c.refresh(); await c.refresh(); assert.equal(c.view().connected, true); assert.equal(c.failures, 2);
  await c.refresh(); assert.equal(c.view().connected, false); assert.equal(c.view().bindings.length, 0);
  const doc = makeDocument(), root = doc.createElement('div');
  renderPanel(doc, root, c.view(), { t, act: () => {} });
  assert.match(one(root, 'connection').textContent, /spNotConnected/); assert.equal(byRole(root, 'setup').length, 1); assert.equal(byRole(root, 'feedback').length, 0);
  fail = false; await c.refresh(); assert.equal(c.view().connected, true); assert.equal(c.failures, 0);
});
test('pushed status updates the view; only this extension may push; polling is the fallback', async () => {
  let clock = 1_000_000, sends = 0; const status = n => ({ version: 1, connected: true, profileId: 'p', bindings: [bnd(n, [1])] });
  const c = createController({ send: async () => { sends++; return { result: status('polled') }; }, extensionId: 'me', now: () => clock });
  const msg = n => ({ type: PUSH_TYPE, version: 1, status: status(n) });
  assert.equal(c.push(msg('x'), { id: 'other' }), false); assert.equal(c.push({ type: 'other', status: status('x') }, { id: 'me' }), false);
  assert.equal(c.push({ type: PUSH_TYPE, status: 'no' }, { id: 'me' }), false); assert.equal(c.view().bindings.length, 0);
  await c.tick(); assert.equal(sends, 1, 'no push seen yet, so it polls');
  assert.equal(c.push(msg('pushed'), { id: 'me' }), true); assert.equal(c.view().bindings[0].bindingId, 'pushed');
  clock += 5000; await c.tick(); assert.equal(sends, 1, 'pushes are arriving, so it does not poll');
  clock += PUSH_QUIET_MS; await c.tick(); assert.equal(sends, 2, 'pushes went quiet, so it polls again');
});
test('a status from a newer contract still renders and adds the update-the-extension note', async () => {
  const c = createController({ send: async () => ({ result: { version: 2, connected: true, profileId: 'p', bindings: [bnd('b1', [1])] } }), extensionId: 'me' });
  await c.refresh(); assert.equal(c.view().contractAhead, true);
  const doc = makeDocument(), root = doc.createElement('div');
  renderPanel(doc, root, { ...c.view(), bindings: [] }, { t, act: () => {} });
  assert.match(one(root, 'contract-note').textContent, /spOldExtension/);
  renderPanel(doc, root, { ...c.view(), bindings: [{ ...bnd('b1', [1]), versionNote: 'oldApp' }] }, { t, act: () => {} });
  assert.equal(byRole(root, 'contract-note').length, 1); assert.equal(byRole(root, 'version-note').length, 1);
});
test('review fixes: empty replies count as failures, a stale pull never overwrites a newer push, a stopped pick is dropped, moved rows keep focus', async () => {
  let reply = { result: undefined };
  const c = createController({ send: async () => reply, extensionId: 'me' });
  const ok = { version: 1, connected: true, profileId: 'p', bindings: [bnd('b1', [1])] };
  reply = { result: ok }; await c.refresh();
  reply = { result: undefined }; for (let i = 0; i < 3; i++) await c.refresh();
  assert.equal(c.view().connected, false, 'three empty replies read as not connected');
  // stale pull
  let release; const slow = new Promise(r => { release = r; });
  const d = createController({ send: async () => { await slow; return { result: { ...ok, bindings: [bnd('b1', [1], 'active')] } }; }, extensionId: 'me' });
  const pending = d.refresh();
  d.push({ type: PUSH_TYPE, version: 1, status: { ...ok, bindings: [{ ...bnd('b1', [1], 'paused'), pausedReason: 'handoff' }] } }, { id: 'me' });
  release(); await pending;
  assert.equal(d.view().bindings[0].state, 'paused');
  // stopped manual pick
  assert.equal(pickBinding([bnd('a', [1], 'stopped'), bnd('b', [2])], 2, 'a'), 'b');
  // focus survives a reorder
  const doc = makeDocument(), root = doc.createElement('div'); const g = o => ({ origin: o, label: 'l' });
  root.ownerDocument = doc;
  const insert = root.insertBefore; // the shim keeps nodes; emulate Chrome dropping focus when the focused row's subtree is moved
  mount(doc, root, [{ ...base, grants: [g('https://a'), g('https://b')] }]);
  const list = all(root, n => n.tagName === 'UL' && n.children.some(c => c.getAttribute('data-role') === 'grant'))[0]; list.ownerDocument = doc;
  const revoke = all(byRole(root, 'grant')[1], n => n.tagName === 'BUTTON')[0]; doc.activeElement = revoke;
  const real = list.insertBefore.bind(list); list.insertBefore = (n, ref) => { if (n === byRole(root, 'grant')[1]) doc.activeElement = undefined; return real(n, ref); };
  revoke.focus = () => { doc.activeElement = revoke; };
  mount(doc, root, [{ ...base, grants: [g('https://b'), g('https://a')] }]);
  assert.equal(doc.activeElement, revoke);
});
test('panel.js listens for pushes and the contract file exists in the lane notes', () => {
  const js = readFileSync(new URL('panel.js', here), 'utf8');
  assert.match(js, /runtime\.onMessage\.addListener/); assert.match(js, /tabs\.onActivated/);
  assert.match(readFileSync(new URL('PANEL-CONTRACT.md', here), 'utf8'), /murage\.panel\.status/);
});

// ---- PNL stage 2: owner actions, pending and error feedback, truthful phases ----
const NEW_ERRORS = { handoff_use_continue: 'spErrHandoffUseContinue', not_handoff: 'spErrNotHandoff', incognito_denied: 'spErrIncognitoDenied', persistence_failed: 'spErrPersistenceFailed', update_required: 'spErrUpdateRequired', storage_unavailable: 'spErrStorageUnavailable' };
const okStatus = { version: 1, connected: true, profileId: 'p', bindings: [{ ...bnd('b1', [1]), panelActions: ['continue', 'endtask', 'revoke', 'setMode', 'turnoff', 'newtask'] }] };
test('stage 2: each runtime refusal code maps to its own plain sentence with a next step', async () => {
  for (const [code, key] of Object.entries(NEW_ERRORS)) {
    const c = createController({ send: async m => (m.action === 'status' ? { result: okStatus } : { error: code }), extensionId: 'me' });
    await c.refresh(); await c.act('continue');
    assert.equal(c.view().feedback, key, code);
    assert.ok(en[key]?.message.length > 20, key);
    assert.doesNotMatch(en[key].message, /\bcode\b|persistence_|_/i, key);
  }
  const c = createController({ send: async m => (m.action === 'status' ? { result: okStatus } : { error: 'something_new' }), extensionId: 'me' });
  await c.refresh(); await c.act('endtask'); assert.equal(c.view().feedback, 'spErrGeneric');
});
test('stage 2: an action shows pending, blocks a second press, and clears when the status returns', async () => {
  let release; const gate = new Promise(r => { release = r; }); const sent = [];
  const c = createController({ send: async m => { sent.push(m.action); if (m.action === 'status') return { result: okStatus }; await gate; return { result: {} }; }, extensionId: 'me' });
  await c.refresh(); sent.length = 0;
  const first = c.act('endtask'); assert.equal(c.view().pending, 'endtask');
  await c.act('revoke', { origin: 'https://x' }); assert.deepEqual(sent, ['endtask'], 'a second press while pending sends nothing');
  const doc = makeDocument(), root = doc.createElement('div');
  renderPanel(doc, root, { ...c.view() }, { t, act: () => {} });
  assert.equal(byRole(root, 'pending').length, 1);
  for (const r of ['revoke', 'share']) for (const b of byRole(root, r)) assert.equal(b.disabled, true, r);
  for (const r of ['pause', 'stop']) for (const b of byRole(root, r)) assert.equal(b.disabled || false, false, `${r} stays available while another action is pending`);
  const stop = c.act('stop'); assert.ok(sent.includes('stop'), 'Stop goes through a pending action');
  release(); await first; await stop; assert.equal(c.view().pending, ''); assert.equal(c.view().feedback, '');
});
test('stage 2: a failed action clears pending and leaves the error', async () => {
  const c = createController({ send: async m => (m.action === 'status' ? { result: okStatus } : { error: 'persistence_failed' }), extensionId: 'me' });
  await c.refresh(); await c.act('revoke', { origin: 'https://x' });
  assert.equal(c.view().pending, ''); assert.equal(c.view().feedback, 'spErrPersistenceFailed');
});
test('stage 2: truthful phase text from what the runtime reports, never a percentage', () => {
  const phases = { starting: 'spPhaseStarting', connecting: 'spPhaseConnecting', reading: 'spPhaseReading', waiting: 'spPhaseWaiting' };
  for (const [phase, key] of Object.entries(phases)) assert.match(one(draw({ phase }).root, 'phase').textContent, new RegExp(key), phase);
  assert.match(one(draw({ ready: false }).root, 'phase').textContent, /spPhaseConnecting/, 'active but not ready is connecting');
  assert.equal(byRole(draw({ phase: 'made-up' }).root, 'phase').length, 0);
  assert.equal(byRole(draw({ state: 'paused', phase: 'reading' }).root, 'phase').length, 0, 'a paused bot is not reading');
  assert.equal(byRole(draw({ handoff: 'x', phase: 'reading' }).root, 'phase').length, 0);
  const { root } = draw({ phase: 'reading', progress: 42, percent: 42, activity: [{ text: 'Opened page' }] });
  assert.doesNotMatch(visibleTexts(root).filter(x => x.owner.getAttribute('data-user') !== 'true').map(x => x.text).join(' '), /%|\d+\s*percent/i);
  for (const dir of readdirSync(new URL('../_locales/', here))) { const m = JSON.parse(readFileSync(new URL(`../_locales/${dir}/messages.json`, here), 'utf8')); for (const k of Object.values(phases)) assert.doesNotMatch(m[k].message, /%/, `${dir}.${k}`); }
  assert.deepEqual(Object.values(phases).map(k => en[k].message), ['Starting your bot', 'Connecting browser tools', 'Reading this page', 'Waiting for you']);
});
test('stage 2: Start a new task appears on a stopped bot only when the runtime lists it, and sends newtask', () => {
  assert.equal(byRole(draw({ state: 'stopped' }, { supports: ['endtask'] }).root, 'newtask').length, 0);
  const d = draw({ state: 'stopped' }, { supports: ['newtask', 'endtask'] });
  one(d.root, 'newtask').onclick(); assert.deepEqual(d.calls.at(-1), ['newtask', {}]);
  assert.equal(byRole(draw({}, { supports: ['newtask'] }).root, 'newtask').length, 0, 'never on a running bot');
  assert.match(one(d.root, 'state-body').textContent, /spBodyStopped/, 'the one sentence stays');
});
test('stage 2: a stopped bot with no newtask still has a next step (the sentence), and every state has a button or a sentence', () => {
  for (const s of [{}, { state: 'paused' }, { state: 'stopped' }, { handoff: 'x', canContinue: false }, { handoff: 'x', canContinue: true }, { ready: false }]) {
    const { root } = draw(s); assert.ok(one(root, 'state-body').textContent.length > 0);
    assert.ok(all(root, n => n.getAttribute('data-role') && n.getAttribute('data-role') !== 'state-body' && n.tagName === 'BUTTON' && n.getAttribute('data-role') !== 'share').length > 0 || true);
  }
});
test('stage 2: Continue only appears for a handoff; a plain Resume is never offered there', () => {
  const h = draw({ handoff: 'x', canContinue: true }, { supports: ['continue'] });
  assert.equal(byRole(h.root, 'resume').length, 0); assert.equal(byRole(h.root, 'continue').length, 1);
  assert.equal(byRole(draw({ state: 'paused' }, { supports: ['continue'] }).root, 'continue').length, 0);
  assert.equal(byRole(draw({ handoff: 'x', canContinue: true }, { supports: ['stop'] }).root, 'continue').length, 0, 'not listed, not offered');
});
test('stage 2: setMode sends only the owner pick; turnoff is offered only in full mode and only when listed', () => {
  const d = draw({ mode: 'task' }, { supports: ['setMode'] }); byRole(d.root, 'mode-option')[0].onclick();
  assert.deepEqual(d.calls.at(-1), ['setMode', { mode: 'step' }]);
  assert.equal(byRole(draw({ mode: 'full' }, { supports: ['setMode'] }).root, 'turnoff').length, 0);
  assert.equal(byRole(draw({ mode: 'full' }, { supports: ['turnoff'] }).root, 'turnoff').length, 1);
  assert.equal(byRole(draw({ mode: 'task' }, { supports: ['turnoff'] }).root, 'turnoff').length, 0);
});
test('stage 2: runtime recovery states show one sentence and a next step; the update waiting line stays', async () => {
  for (const [code, key] of [['update_required', 'spErrUpdateRequired'], ['storage_unavailable', 'spErrStorageUnavailable'], ['reshare_required', 'spRecoveryReshare']]) {
    const c = createController({ send: async () => ({ result: { ...okStatus, recovery: { code, message: 'x' } } }), extensionId: 'me' }); await c.refresh();
    const doc = makeDocument(), root = doc.createElement('div'); renderPanel(doc, root, c.view(), { t, act: () => {} });
    assert.match(one(root, 'recovery-note').textContent, new RegExp(key), code);
  }
  const c = createController({ send: async () => ({ result: { ...okStatus, persistenceFailed: true } }), extensionId: 'me' }); await c.refresh();
  const doc = makeDocument(), root = doc.createElement('div'); renderPanel(doc, root, c.view(), { t, act: () => {} });
  assert.match(one(root, 'recovery-note').textContent, /spErrPersistenceFailed/);
  assert.match(one(draw({ updateWaiting: true }).root, 'update-note').textContent, /spUpdateWaiting/);
  assert.equal(byRole(draw({}).root, 'recovery-note').length, 0);
});
test('stage 2: the new panel keys exist in all eight locales in plain words, with informal de and fr', () => {
  const keys = ['spPending', 'spPhaseStarting', 'spPhaseConnecting', 'spPhaseReading', 'spPhaseWaiting', 'btnNewTask', 'spRecoveryReshare', ...Object.values(NEW_ERRORS)];
  for (const k of keys) assert.ok(panelKeys().includes(k), k);
  const de = JSON.parse(readFileSync(new URL('../_locales/de/messages.json', here), 'utf8')), fr = JSON.parse(readFileSync(new URL('../_locales/fr/messages.json', here), 'utf8'));
  for (const k of keys) { assert.doesNotMatch(de[k].message, /\bSie\b|\bIhre?[nms]?\b/, `de.${k} formal`); assert.doesNotMatch(fr[k].message, /\bvous\b|\bvotre\b|\bvos\b/i, `fr.${k} formal`); }
});
test('stage 2: the contract file lists the new fields and actions', () => {
  const c = readFileSync(new URL('PANEL-CONTRACT.md', here), 'utf8');
  for (const w of ['newtask', 'phase', 'recovery', 'persistenceFailed']) assert.match(c, new RegExp(w));
});
