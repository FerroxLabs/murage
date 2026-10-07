// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { h, page, runRecipientScan, realCollectFacts } from './testing/chat-dom-fixture.ts';
import { domFunction, nativeBacking, nativeList } from './testing/native-dom-fixture.ts';
import { checkIntent } from './browser-intent.ts';
import { COLLECT_FLOOR_FACTS_SOURCE, EFFECT_TARGET_SOURCE, RELATED_ELEMENTS_SOURCE } from './browser-floor-facts.ts';
import { DESCRIBE_TARGET_SOURCE } from './browser-extension-page-scripts.ts';
import { BROWSER_DOCUMENT_GUARD_SOURCE } from './browser-document-guard.ts';

function review(property = 'children', outside = true, custom = false) {
  const hidden = h('input', { type: 'hidden', name: property });
  const recipient = h('input', { type: 'email', value: 'unrequested@example.com' });
  const message = h('input', { name: 'message' });
  const send = h('button', { type: 'button' }, 'Send');
  const form = h(custom ? 'x-compose' : 'form', {}, hidden, recipient, message, ...outside ? [] : [send]);
  const root = h('div', {}, form, ...outside ? [send] : []);
  const host = h('div'); const p = page(host);
  Object.assign(root, { nodeType: 11, host }); Object.assign(host, { shadowRoot: root });
  for (const n of root.all()) Object.assign(n, { ownerDocument: p.doc, getRootNode: () => root });
  nativeBacking.set(form, { nodeType: 1, localName: form.localName, childNodes: nativeList([...form.childNodes]), elements: nativeList([hidden, recipient, message]) });
  // Keep the fixture's type independent of its overridable localName getter.
  if (custom) Object.defineProperty(form, 'type', { value: '' });
  if (custom) for (const key of ['children', 'childNodes', 'elements', 'firstElementChild', 'length', 'querySelectorAll', 'nodeType', 'localName']) Object.defineProperty(form, key, { get: () => { throw Error('page getter'); } });
  else Object.defineProperty(form, property, { value: hidden });
  return { send, form, recipient, root };
}
async function decisions(send: ReturnType<typeof h>) {
  const facts = await realCollectFacts(() => send)(null, null, 'click');
  const input = { ownerWords: ['Send my message'], taskSites: new Set(['https://chat.example']), readOrigins: new Map(), probeFlagged: false,
    mode: 'full' as const, visibility: facts.visibility!, counters: { hits: 0 },
    action: { operation: 'click', level: 'L3' as const, origin: 'https://chat.example', recipients: facts.recipients, recipientScanFailed: facts.recipientScanFailed, recipientNoField: facts.recipientNoField } };
  expect(checkIntent(input)).toMatchObject({ result: 'card', rule: 'I2' });
  expect(checkIntent({ ...input, counters: { hits: 2 } })).toMatchObject(facts.recipientScanFailed ? { result: 'refuse', rule: 'I7' } : { result: 'card', rule: 'I2' });
}
describe('Round 4 native recipient traversal', () => {
  it.each(['children', 'childNodes', 'elements', 'firstElementChild', 'length'])('review page with named %s and Send outside form', async property => {
    const { send } = review(property);
    expect(runRecipientScan(send)).toMatchObject({ recipients: ['unrequested@example.com'], incomplete: true });
    await decisions(send);
  });
  it('custom element getters cannot hide its fields', async () => {
    const { send } = review('children', true, true);
    expect(runRecipientScan(send).recipients).toEqual(['unrequested@example.com']); await decisions(send);
  });
  it.each(['unreadable', 'missing', 'changed'])('native children %s makes the scan incomplete', async fault => {
    const { send, form } = review('length');
    const list = nativeList([]);
    if (fault === 'missing') Object.defineProperty(list, 'values', { value: [null] });
    if (fault === 'changed') { let reads = 0; Object.defineProperty(list, 'values', { get: () => ++reads === 1 ? [] : [null] }); }
    nativeBacking.set(form, { nodeType: 1, localName: form.localName, childNodes: fault === 'unreadable' ? Error('native read failed') : list });
    expect(runRecipientScan(send)).toMatchObject({ incomplete: true, noRecipientField: false }); await decisions(send);
  });
  it('associated native form controls outside the subtree are scanned', () => {
    const { send, form } = review('elements', false);
    const bcc = h('input', { type: 'email', value: 'external@example.com' });
    Object.assign(bcc, { ownerDocument: send.ownerDocument });
    nativeBacking.get(form)!.elements = nativeList([bcc]);
    const body = (send.ownerDocument as any).body; bcc.parentNode = body; body.children.push(bcc); body.childNodes.push(bcc);
    expect(runRecipientScan(send).recipients).toContain('external@example.com');
  });
});

// Query results are stored before page getters are replaced. This models the
// isolated world's native selector engine independently of page properties.
function collectorFixture() {
  const field = h('input', { type: 'password', name: 'password', value: 'private-value-example' });
  const button = h('button', { type: 'submit' }, 'Continue');
  const label = h('span', { id: 'label' }, 'Name');
  const ref = h('span', { 'aria-labelledby': 'label' });
  const form = h('form', {}, field, button, ref);
  const { doc, body } = page(form, label);
  const all = body.all();
  const matches = (n: ReturnType<typeof h>, sel: string) => sel === '*' || sel.split(',').some(s => s.startsWith(n.localName) || s.startsWith('[aria-labelledby]') && n.attrs['aria-labelledby']);
  for (const n of all) {
    const descendants = n.all().slice(1);
    Object.assign(n, { matches: (s: string) => matches(n, s), closest: (s: string) => s === 'form' ? form : null,
      getRootNode: () => doc, hasAttribute: (s: string) => s in n.attrs,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }),
      contains: (other: unknown) => other === n || descendants.includes(other as never),
      querySelectorAll: (s: string) => descendants.filter(e => matches(e, s)) });
    nativeBacking.set(n, { childNodes: nativeList([...n.childNodes]), querySelectorAll: (s: string) => descendants.filter(e => matches(e, s)) });
  }
  Object.assign(doc, { nodeType: 9, title: 'Fixture', location: { pathname: '/' }, baseURI: 'https://fixture.test/', activeElement: field,
    querySelectorAll: (s: string) => all.filter(e => matches(e, s)), elementFromPoint: () => button });
  nativeBacking.set(doc, { childNodes: nativeList([body]) });
  nativeBacking.get(form)!.elements = nativeList([field, button]);
  const call = (source: string, target: unknown, ...args: unknown[]) => domFunction('document', 'location', 'window', 'getComputedStyle', `return (${source});`)(
    doc, { pathname: '/' }, { innerWidth: 1000, innerHeight: 800 }, () => ({ display: 'block', visibility: 'visible', opacity: '1', webkitTextSecurity: 'none' })
  ).apply(target, args);
  const opts = { operation: 'click', name: 'Continue private-value-example', selectors: { consent: [], captcha: [], payment: [], paymentRequest: [], challenge: [] }, currency: { source: '[$][0-9]', flags: '' } };
  return { field, button, label, form, doc, opts, call };
}
describe('Round 4 other security collectors', () => {
  it('floor values and field descriptors traverse a form with clobbered querySelectorAll, childNodes and elements', () => {
    const f = collectorFixture();
    for (const key of ['querySelectorAll', 'childNodes', 'elements']) Object.defineProperty(f.form, key, { value: f.field });
    const raw = f.call(COLLECT_FLOOR_FACTS_SOURCE, f.button, f.opts);
    expect(raw.nameHasValue).toBe(true);
    expect(raw.form.fields).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'password' })]));
    expect(raw.nearFailed).toBe(false);
  });
  it('effect target reads native form elements', () => {
    const f = collectorFixture(); Object.defineProperty(f.form, 'elements', { value: f.field });
    Object.defineProperty(f.form, 'querySelectorAll', { value: f.field });
    expect(f.call(EFFECT_TARGET_SOURCE, f.field, 'press', 'Enter') === f.button).toBe(true);
  });
  it('related accessible-name descendants use a native selector', () => {
    const f = collectorFixture(); Object.defineProperty(f.form, 'querySelectorAll', { value: f.field });
    expect(f.call(RELATED_ELEMENTS_SOURCE, f.form)).toContain(f.label);
  });
  it('target binding includes fields despite a clobbered form collection and selector', () => {
    const f = collectorFixture(); Object.defineProperty(f.form, 'elements', { value: f.field });
    Object.defineProperty(f.form, 'querySelectorAll', { value: f.field });
    expect(JSON.parse(f.call(DESCRIBE_TARGET_SOURCE, f.button)).values).toContain('private-value-example');
  });
  it.each([COLLECT_FLOOR_FACTS_SOURCE, RELATED_ELEMENTS_SOURCE, DESCRIBE_TARGET_SOURCE])('native selector read failure cannot complete collector %#', source => {
    const f = collectorFixture(); nativeBacking.get(f.form)!.querySelectorAll = Error('native selector unavailable');
    expect(() => f.call(source, source === RELATED_ELEMENTS_SOURCE ? f.form : f.button, f.opts)).toThrow();
  });
  it('the document guard refuses when its native query cannot finish', () => {
    const f = collectorFixture(); Object.assign(f.field.attrs, { type: 'text', name: 'search', value: '' });
    nativeBacking.get(f.doc)!.querySelectorAll = Error('native selector unavailable');
    const isolated: Record<string, any> = {};
    domFunction('document', 'globalThis', BROWSER_DOCUMENT_GUARD_SOURCE)(f.doc, isolated);
    expect(isolated.__murageGuard()).toBe(true);
  });
});
