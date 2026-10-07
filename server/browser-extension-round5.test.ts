// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { BROWSER_DOCUMENT_GUARD_SOURCE } from './browser-document-guard.ts';
import { COLLECT_RECIPIENTS_SOURCE } from './browser-floor-facts.ts';
import { nativeRealm } from './testing/native-dom-fixture.ts';
import { h, page } from './testing/chat-dom-fixture.ts';

function realm(target: ReturnType<typeof h>) {
  // Unlike the old fixture, a native Node accessor rejects Window receivers.
  class Node {}
  Object.defineProperties(Node.prototype, Object.getOwnPropertyDescriptors(nativeRealm.Node.prototype));
  Object.defineProperty(Node.prototype, 'nodeType', { get() {
    if (typeof (this as any).nodeType !== 'number') throw new TypeError('Illegal invocation');
    return (this as any).nodeType;
  } });
  const listeners = new Map<string, (event: unknown) => void>();
  const document = target.ownerDocument as any;
  for (const node of document.documentElement.all()) (node as any).hasAttribute = (key: string) => key in node.attrs;
  Object.assign(document, { nodeType: 9, addEventListener: (key: string, fn: (event: unknown) => void) => listeners.set(key, fn), removeEventListener: (key: string) => listeners.delete(key) });
  const context: any = { ...nativeRealm, Node, document, getComputedStyle: () => ({ webkitTextSecurity: 'none' }), setTimeout: () => 0, clearTimeout() {} };
  context.globalThis = context;
  return { context, listeners, scan: () => runInNewContext(`(${COLLECT_RECIPIENTS_SOURCE})`, context).call(target) };
}

describe('Round 5: exact serialized sources with no module scope', () => {
  it('Window in an ordinary event path never poisons the next guard check', () => {
    const button = h('button', {}, 'Go'); const p = page(button); const f = realm(button);
    runInNewContext(BROWSER_DOCUMENT_GUARD_SOURCE, f.context);
    for (const type of ['click', 'pointerdown', 'mousedown', 'keydown', 'beforeinput', 'input', 'change', 'submit']) {
      f.context.__murageGuard.enable(true);
      expect(f.context.__murageGuard()).toBe(false);
      const event = { composedPath: () => [button, p.body, p.doc, runInNewContext('globalThis', f.context)], preventDefault() { throw Error('Ordinary input was blocked'); }, stopImmediatePropagation() {} };
      expect(() => f.listeners.get(type)!(event)).not.toThrow();
      f.context.__murageGuard.enable(true);
      expect(f.context.__murageGuard()).toBe(false);
    }
  });
  it('unexpected non-Node receivers still block the event and the next check', () => {
    const button = h('button'); page(button); const f = realm(button);
    runInNewContext(BROWSER_DOCUMENT_GUARD_SOURCE, f.context); f.context.__murageGuard.enable(true);
    let blocked = false;
    f.listeners.get('click')!({ composedPath: () => [button, {}], preventDefault() { blocked = true; }, stopImmediatePropagation() {} });
    expect(blocked).toBe(true); expect(f.context.__murageGuard()).toBe(true);
  });
  it.each(['getAttribute', 'querySelectorAll', 'shadowRoot', 'length'])('native presence and select values survive named %s', property => {
    const option = h('option', { value: 'unrequested@example.com' }, 'Alice');
    const select = h('select', {}, option); Object.assign(select, { selectedOptions: [option] });
    const hidden = h('input', { type: 'hidden', name: property });
    const form = h('form', { 'aria-label': 'To' }, hidden, select);
    Object.defineProperty(form, property, { value: hidden });
    const send = h('button', {}, 'Send'); const root = h('div', {}, form, send); const host = h('div'); const p = page(host);
    Object.assign(root, { nodeType: 11, host }); Object.assign(host, { shadowRoot: root });
    for (const n of root.all()) n.ownerDocument = p.doc;
    const result = realm(send).scan();
    expect(result.noRecipientField).toBe(false);
    expect(result.recipients).toContain('unrequested@example.com');
  });
  it('the presence overlay outside body cannot make a plain Go unreadable', () => {
    const button = h('button', {}, 'Go'); const p = page(button);
    const overlay = h('murage-presence'); const html = p.doc.documentElement;
    overlay.parentNode = html; html.children.push(overlay); html.childNodes.push(overlay);
    expect(realm(button).scan()).toMatchObject({ incomplete: false, noRecipientField: true });
  });
});
