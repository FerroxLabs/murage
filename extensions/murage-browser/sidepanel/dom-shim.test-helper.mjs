// SPDX-License-Identifier: AGPL-3.0-or-later
// A minimal DOM for the side panel tests (no jsdom in this repo). innerHTML and outerHTML throw: the panel must
// build page-derived text with textContent only. Strict by design: it exposes only what real DOM nodes have. Attributes
// live behind a private field (no `.attrs`; real `attributes` is a NamedNodeMap, not a plain object), so a view that reads
// shim-only state throws here instead of rendering nothing in a real browser.
class Text { constructor(t) { this.nodeType = 3; this.data = String(t); } get textContent() { return this.data; } }
export class El {
  #attrs = {};
  constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.children = []; this.hidden = false; this.disabled = false; this.className = ''; this.onclick = null; this.onchange = null; this.value = ''; }
  append(...nodes) { for (const n of nodes) this.children.push(typeof n === 'object' && n ? n : new Text(n)); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  get childNodes() { return this.children; }
  removeChild(n) { const i = this.children.indexOf(n); if (i < 0) throw Error('not a child'); this.children.splice(i, 1); return n; }
  insertBefore(n, ref) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); const at = ref ? this.children.indexOf(ref) : -1; if (ref && at < 0) throw Error('reference is not a child'); this.children.splice(at < 0 ? this.children.length : at, 0, n); return n; }
  getAttributeNames() { return Object.keys(this.#attrs); }
  removeAttribute(k) { delete this.#attrs[k]; }
  get lastChild() { return this.children.at(-1); }
  get firstChild() { return this.children[0]; }
  setAttribute(k, v) { this.#attrs[k] = String(v); }
  getAttribute(k) { return k in this.#attrs ? this.#attrs[k] : null; }
  get textContent() { return this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.children = v === '' ? [] : [new Text(v)]; }
  set innerHTML(_) { throw Error('innerHTML is not allowed in the side panel'); }
  set outerHTML(_) { throw Error('outerHTML is not allowed in the side panel'); }
  get innerHTML() { throw Error('innerHTML is not allowed in the side panel'); }
}
export const makeDocument = () => ({ createElement: tag => new El(tag), createElementNS: (_ns, tag) => new El(tag), createTextNode: t => new Text(t), title: '', documentElement: new El('html') });
export function walk(node, fn, parent = null, hiddenAbove = false) {
  const hidden = hiddenAbove || Boolean(node.hidden);
  fn(node, parent, hidden);
  for (const c of node.children ?? []) walk(c, fn, node, hidden);
}
export function all(root, pred) { const out = []; walk(root, (n, p, h) => { if (n.nodeType === 1 && !h && pred(n)) out.push(n); }); return out; }
export const byRole = (root, role) => all(root, n => n.getAttribute('data-role') === role);
export const one = (root, role) => byRole(root, role)[0];
// Visible text nodes with their owning element (hidden subtrees skipped).
export function visibleTexts(root) { const out = []; walk(root, (n, p, h) => { if (n.nodeType === 3 && !h && p) out.push({ text: n.data, owner: p }); }); return out; }
// Attributes a person reads or hears.
export function visibleLabels(root) { return all(root, n => n.getAttribute('aria-label') !== null).map(n => ({ text: n.getAttribute('aria-label'), owner: n })); }
