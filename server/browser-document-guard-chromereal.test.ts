// SPDX-License-Identifier: AGPL-3.0-or-later
import { nativeRealm } from "./testing/native-dom-fixture.ts";
// Red-first tests (lane 0162-chromereal): the page guard's private-input detection, run against a small DOM
// built from real HTML (parse5). Real-browser behavior is proved separately in the controls proof.
import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { parse } from "parse5";
import { BROWSER_DOCUMENT_GUARD_SOURCE } from "./browser-document-guard.ts";

function dom(html: string) {
  const root: any = parse(html); const all: any[] = []; const byId = new Map<string, any>();
  const wrap = (n: any, parent: any): any => {
    const attrs = Object.fromEntries((n.attrs ?? []).map((a: any) => [a.name, a.value]));
    const el: any = { nodeType: 1, tagName: n.tagName.toUpperCase(), parentNode: parent, kids: [], getAttribute: (k: string) => attrs[k] ?? null, hasAttribute: (k: string) => k in attrs,
      get type() { return attrs.type ?? (n.tagName === "input" ? "text" : undefined); }, set type(v) { attrs.type = v; }, name: attrs.name, id: attrs.id, autocomplete: attrs.autocomplete,
      textContent: "", getRootNode: () => docEl, closest(tag: string) { for (let p: any = el; p; p = p.parentNode) if (p.tagName === tag.toUpperCase()) return p; return null; },
      get labels() { return all.filter(l => l.tagName === "LABEL" && ((l.getAttribute("for") && l.getAttribute("for") === attrs.id) || l.contains?.(el))); }, contains: (x: any) => { for (let p = x; p; p = p.parentNode) if (p === el) return true; return false; } };
    all.push(el); if (attrs.id) byId.set(attrs.id, el);
    const text = (m: any): string => m.nodeName === "#text" ? m.value : (m.childNodes ?? []).map(text).join("");
    el.textContent = text(n);
    for (const c of n.childNodes ?? []) if (c.tagName) el.kids.push(wrap(c, el));
    return el;
  };
  const htmlEl = (root.childNodes as any[]).find(c => c.tagName === "html");
  const docEl: any = { nodeType: 9, getElementById: (id: string) => byId.get(id) ?? null, querySelectorAll: (sel: string) => all.filter(e => sel === "*" || sel.split(",").some(s => s === e.tagName.toLowerCase() || (s.startsWith("[") && e.hasAttribute(s.slice(1).split(/[\]=]/)[0]) ))), addEventListener() {} };
  wrap(htmlEl, docEl);
  const listeners: any = {}; docEl.addEventListener = (t: string, f: any) => { listeners[t] = f; };
  return { docEl, all, byId };
}
function guard(html: string) {
  const d = dom(html); const observers: any[] = [];
  class MO { cb: any; constructor(cb: any) { this.cb = cb; observers.push(this); } observe() {} }
  // The guard holds a lease timer while armed (lane X1); the double never fires it.
  const g: any = { ...nativeRealm, document: d.docEl, MutationObserver: MO, getComputedStyle: () => ({}), WeakSet, setTimeout: () => 0, clearTimeout: () => {} };
  g.globalThis = g; runInNewContext(BROWSER_DOCUMENT_GUARD_SOURCE, g);
  return { state: () => g.__murageGuard() as boolean, arm: () => g.__murageGuard.enable(true), observers, byId: d.byId, d };
}
describe("Astra 6: private input is found by what its label says, and by being a revealed password", () => {
  it("control: a native password input", () => { expect(guard('<input type="password">').state()).toBe(true); });
  it("control: an ordinary field is not private", () => { expect(guard('<label for="q">Search</label><input id="q" type="text">').state()).toBe(false); });
  it("a text input named only by aria-labelledby", () => {
    expect(guard('<span id="l">Your password</span><input id="f" type="text" aria-labelledby="l">').state()).toBe(true);
  });
  it("a generic input labelled Card number by an external label", () => {
    expect(guard('<label for="f1">Card number</label><input id="f1" type="tel">').state()).toBe(true);
  });
  it("a field inside a wrapping label", () => { expect(guard("<label>Security code <input type='tel'></label>").state()).toBe(true); });
  it("a password the page revealed (type switched to text) stays private", () => {
    const g = guard('<input id="p" type="password">'); const input = g.byId.get("p");
    expect(g.state()).toBe(true);
    // The page flips the type; the mutation record carries the old value.
    input.type = "text"; for (const o of g.observers) o.cb([{ type: "attributes", attributeName: "type", oldValue: "password", target: input }]);
    expect(g.state()).toBe(true);
  });
  it("uses a cached verdict until the page changes (no scan per keystroke)", () => {
    // Lane X1: the guard observes only while armed (each mediated action arms it); disarmed it keeps no observer and rescans.
    const g = guard('<input id="q" type="text">'); g.arm(); expect(g.state()).toBe(false);
    g.byId.get("q").getAttribute = () => "card number"; // would flip a rescan, but nothing mutated
    expect(g.state()).toBe(false);
    for (const o of g.observers) o.cb([{ type: "childList" }]);
    expect(g.state()).toBe(true); // after a mutation the page is looked at again
  });
  it("an iframe alone no longer makes the page private", () => { expect(guard('<p>hi</p><iframe src="https://ads.test/"></iframe>').state()).toBe(false); });
});
