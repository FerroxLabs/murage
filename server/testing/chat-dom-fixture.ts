// SPDX-License-Identifier: AGPL-3.0-or-later
// Test support: a small DOM that models real chat pages, and a `collectFacts` that runs Murage's REAL recipient scan
// (COLLECT_RECIPIENTS_SOURCE) and the REAL collectFloorFacts over it. A test never hand-sets `recipientNoField`: it comes out of the scan,
// exactly as on the page. The floor's own page function (COLLECT_FLOOR_FACTS_SOURCE) needs a browser, so its raw answer is derived here from
// the element (tag, type, role, accessible name); the recipient scan is the part that decides `recipientNoField`.
import { COLLECT_FLOOR_FACTS_SOURCE, COLLECT_RECIPIENTS_SOURCE, EFFECT_TARGET_SOURCE, RELATED_ELEMENTS_SOURCE, SEND_CAPABLE_SOURCE, collectFloorFacts, type FloorFactsIo } from '../browser-floor-facts.ts';

import { NATIVE_DOM_SOURCE } from '../browser-native-dom.ts';
import { domFunction } from './native-dom-fixture.ts';

let nextNodeId = 100;
export class FakeNode {
  /** The engine's node identity (backendNodeId): unique per element, so a replaced element is a new node even when it looks identical. */
  nodeId = nextNodeId++;
  nodeType = 1; parentNode: FakeNode | null = null; children: FakeNode[] = []; shadowRoot = null; ownerDocument: unknown = null;
  localName: string; attrs: Record<string, string>;
  constructor(localName: string, attrs: Record<string, string> = {}, kids: (FakeNode | string)[] = []) {
    this.localName = localName; this.attrs = attrs;
    for (const kid of kids) {
      if (typeof kid === 'string') { const t = new TextNode(kid); t.parentNode = this; this.childNodes.push(t); }
      else { kid.parentNode = this; this.children.push(kid); this.childNodes.push(kid); }
    }
  }
  childNodes: (FakeNode | TextNode)[] = [];
  get tagName() { return this.localName.toUpperCase(); }
  get id() { return this.attrs.id ?? ''; }
  get name() { return this.attrs.name ?? ''; }
  get type() { return this.attrs.type ?? (this.localName === 'input' ? 'text' : ''); }
  get value() { return this.attrs.value ?? ''; }
  get labels() { return []; }
  get form(): FakeNode | null { for (let n = this.parentNode; n; n = n.parentNode) if (n.localName === 'form') return n; return null; }
  get textContent(): string { return this.childNodes.map(c => (c as FakeNode).textContent ?? (c as TextNode).textContent).join(' '); }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null; }
  /** An identical element with a new node identity, as a page that re-renders the same markup produces. */
  clone(): FakeNode { return new FakeNode(this.localName, { ...this.attrs }, this.childNodes.map(c => (c instanceof FakeNode ? c.clone() : (c as TextNode).textContent))); }
  all(): FakeNode[] { return [this, ...this.children.flatMap(c => c.all())]; }
}
class TextNode { nodeType = 3; parentNode: FakeNode | null = null; textContent: string; constructor(textContent: string) { this.textContent = textContent; } }

/** h('div', { role: 'button', 'aria-label': 'Send' }, ...children) */
export const h = (tag: string, attrs: Record<string, string> = {}, ...kids: (FakeNode | string)[]) => new FakeNode(tag, attrs, kids);
export function page(...body: FakeNode[]) {
  const bodyEl = h('body', {}, ...body); const html = h('html', {}, bodyEl);
  const doc = { body: bodyEl, documentElement: html, getElementById: (id: string) => html.all().find(n => n.attrs.id === id) ?? null };
  for (const n of html.all()) n.ownerDocument = doc;
  return { doc, body: bodyEl, all: () => html.all() };
}

/** The accessibility role a browser would give the element. */
export function roleOf(el: FakeNode): string {
  const explicit = el.getAttribute('role'); if (explicit) return explicit;
  if (el.localName === 'button') return 'button';
  if (el.localName === 'textarea') return 'textbox';
  if (el.localName === 'input') return el.type === 'search' ? 'searchbox' : 'textbox';
  return 'generic';
}
const nameOfEl = (el: FakeNode) => el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? el.textContent.trim();

const getComputedStyleStub = () => ({ webkitTextSecurity: 'none' });
/** Runs the real page function with `this` = el. */
export function runRecipientScan(el: FakeNode, operation = 'click', key: unknown = null) {
  const fn = domFunction('getComputedStyle', 'document', `return (${COLLECT_RECIPIENTS_SOURCE});`)(getComputedStyleStub, el.ownerDocument) as (this: unknown, operation: string, key: unknown) => unknown;
  return fn.call(el, operation, key) as { recipients: string[]; incomplete: boolean; noRecipientField?: boolean; composerOnly?: boolean };
}

/** A `collectFacts` for the service options: the REAL collectFloorFacts over the element `current()` names, with the REAL recipient scan. */
export function realCollectFacts(current: () => FakeNode) {
  return async (_io: unknown, _target: unknown, operation: string, extra: Record<string, unknown> = {}) => {
    const el = current();
    const sendCapable = domFunction('document', `return function(el,op,key){const dom=(${NATIVE_DOM_SOURCE})();return (${SEND_CAPABLE_SOURCE})(el,op,key,dom);};`)(el.ownerDocument)(el,operation,extra.key);
    const raw = { sendCapable, tag: el.localName, type: el.type || undefined, fieldName: `${el.id} ${el.name}`.trim(), autocomplete: '', fallbackName: nameOfEl(el), nameHasValue: false, descriptionHasValue: false,
      submits: operation === 'press' && extra.key === 'Enter' && roleOf(el) === 'textbox' && el.localName !== 'input' ? true : undefined, page: { urlPath: '/', title: 'Chat' },
      visibility: { box: { x: 10, y: 10, width: 120, height: 24 }, inViewport: true, opacity: 1, visibility: 'visible', ariaHidden: false, coveredBy: null } };
    const io: FloorFactsIo = {
      async world() { return 7; },
      async send(method, params) {
        switch (method) {
          case 'Page.getFrameTree': return { frameTree: { frame: { id: 'main', url: 'https://chat.example/', name: '' } } };
          case 'DOM.resolveNode': return { object: { objectId: 'target' } };
          case 'Runtime.callFunctionOn': {
            const source = (params as { functionDeclaration?: string }).functionDeclaration;
            if (source === EFFECT_TARGET_SOURCE) return { result: { objectId: 'effect' } };
            if (source === RELATED_ELEMENTS_SOURCE) return { result: { objectId: 'related' } };
            if (source === COLLECT_RECIPIENTS_SOURCE) return { result: { value: runRecipientScan(el, operation, extra.key) } };
            if (source === COLLECT_FLOOR_FACTS_SOURCE) return { result: { value: raw } };
            return { result: { value: raw } };
          }
          case 'DOM.describeNode': return { node: { backendNodeId: 11 } };
          case 'Runtime.getProperties': return { result: [] };
          case 'Accessibility.getPartialAXTree': return { nodes: [{ backendDOMNodeId: 11, role: { value: roleOf(el) }, name: { value: nameOfEl(el) }, properties: [] }] };
          default: return {};
        }
      },
    };
    return collectFloorFacts(io, { backendNodeId: 10, document: { tabId: 1, navigationEpoch: 1 } as never }, operation, extra as never);
  };
}

/** Gmail Chat pop-up over the inbox: a sidebar of contacts (no form), a chat bubble header, and a rich-text composer with a Send button. */
export function gmailChat() {
  const alice = h('div', { role: 'button', 'aria-label': 'Alice Nguyen', tabindex: '0' }, 'Alice Nguyen');
  const bob = h('div', { role: 'button', 'aria-label': 'Bob Smith', tabindex: '0' }, 'Bob Smith');
  const find = h('input', { type: 'text', role: 'combobox', 'aria-label': 'Find a person, room or bot', placeholder: 'Find a person, room or bot' });
  const bubble = h('div', { role: 'button', 'aria-label': 'Open chat with Bob Smith' }, 'Bob Smith');
  const composer = h('div', { role: 'textbox', contenteditable: 'true', 'aria-label': 'History is on', 'aria-multiline': 'true' });
  const send = h('div', { role: 'button', 'aria-label': 'Send message' }, 'Send');
  const p = page(h('div', { role: 'navigation' }, find, h('div', { role: 'list' }, alice, bob)), h('div', { role: 'region' }, bubble, h('div', {}, 'Hi, are we still on for lunch?'), composer, send));
  return { ...p, alice, bob, find, bubble, composer, send };
}

/** Teams v2 (?tenantId=...): a search combobox in the header, a chat list, a CKEditor-style message box and a Send button. */
export function teamsV2() {
  const search = h('input', { type: 'search', role: 'combobox', 'aria-label': 'Search', placeholder: 'Search (Ctrl+E)', 'aria-expanded': 'false' });
  const alice = h('div', { role: 'treeitem', 'aria-label': 'Chat Alice Nguyen' }, 'Alice Nguyen');
  const bob = h('div', { role: 'treeitem', 'aria-label': 'Chat Bob Smith' }, 'Bob Smith');
  const composer = h('div', { role: 'textbox', contenteditable: 'true', 'aria-label': 'Type a message', 'data-tid': 'ckeditor' });
  const send = h('button', { 'aria-label': 'Send', 'data-tid': 'newMessageCommands-send' }, 'Send');
  const p = page(h('header', {}, search), h('nav', {}, alice, bob), h('main', {}, composer, send));
  return { ...p, search, alice, bob, composer, send };
}

/** A Chat contact or space whose display name is exactly the Send button's accessible name. An outside sender can choose such a name. */
export function addLookalikeContact(dom: ReturnType<typeof gmailChat>) {
  const lookalike = h('div', { role: 'button', 'aria-label': 'Send message', tabindex: '0' }, 'Send message');
  dom.body.children.push(lookalike); dom.body.childNodes.push(lookalike); lookalike.parentNode = dom.body; lookalike.ownerDocument = dom.body.ownerDocument;
  return lookalike;
}
/** Gmail stacks several Chat bubbles on one URL: a second window with the same composer and Send labels as the first. */
export function addSecondWindow(dom: ReturnType<typeof gmailChat>) {
  const composer = h('div', { role: 'textbox', contenteditable: 'true', 'aria-label': 'History is on', 'aria-multiline': 'true' });
  const send = h('div', { role: 'button', 'aria-label': 'Send message' }, 'Send');
  const region = h('div', { role: 'region' }, h('div', { role: 'button', 'aria-label': 'Open chat with Carol Diaz' }, 'Carol Diaz'), composer, send);
  dom.body.children.push(region); dom.body.childNodes.push(region); region.parentNode = dom.body;
  for (const n of region.all()) n.ownerDocument = dom.body.ownerDocument;
  return { composer, send };
}
