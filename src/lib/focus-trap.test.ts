// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

import { FOCUSABLE_SELECTOR, activeTrapCount, focusableWithin, trapFocus, type FocusTrap, type TrapDocument, openLayer, openLayers, canHandleLayerEscape, type LayerHandle, type LayerKind } from "./focus-trap";

import { nextLayerSequence } from "./layers";

// A DOM small enough to read: elements know their parent, focus sets the document's activeElement, and the
// container answers querySelectorAll with its own descendants in order. The trap only uses these calls.
class FakeDoc {
  activeElement: unknown = null;
  listeners = { keydown: new Set<(event: never) => void>(), focusin: new Set<(event: never) => void>() };
  fallback: FakeEl | null = null;
  native: FakeEl | null = null;
  main: FakeEl | null = null;
  root: FakeEl | null = null;
  body = new FakeEl(this, "body");
  documentElement = new FakeEl(this, "html");
  addEventListener(type: "keydown" | "focusin", listener: (event: never) => void) { this.listeners[type].add(listener); }
  removeEventListener(type: "keydown" | "focusin", listener: (event: never) => void) { this.listeners[type].delete(listener); }
  querySelector(selector: string) { return selector === "[data-focus-fallback]" ? this.fallback : selector === 'dialog[open]' ? this.native : selector === 'main' ? this.main : selector === '#root' ? this.root : null; }
  key(key: string, shiftKey = false) {
    const event = { key, shiftKey, defaultPrevented: false, preventDefault: vi.fn(() => { event.defaultPrevented = true; }), stopPropagation: vi.fn() };
    for (const listener of [...this.listeners.keydown]) listener(event as never);
    return event;
  }
  /** Focus moved somewhere by a click or a script: the browser fires focusin at the new target. */
  moveFocus(target: FakeEl) {
    target.focus();
    for (const listener of [...this.listeners.focusin]) listener({ target } as never);
  }
}

class FakeEl {
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs: Record<string, string> = {};
  isConnected = true;
  visible = true;
  focus = vi.fn(() => { this.doc.activeElement = this; });
  constructor(private readonly doc: FakeDoc, readonly name: string, readonly reachable = true) {}
  add(...kids: FakeEl[]) { for (const kid of kids) { kid.parent = this; this.children.push(kid); } return this; }
  closest(selector: string): FakeEl | null {
    if (selector === '[aria-modal="true"]') return FakeEl.upFrom(this, at => at.attrs['aria-modal'] === 'true');
    const attr = /^\[([a-z-]+)\]$/.exec(selector)?.[1];
    return attr ? FakeEl.upFrom(this, (at) => attr in at.attrs) : null;
  }
  static upFrom(start: FakeEl, match: (at: FakeEl) => boolean): FakeEl | null {
    for (let at: FakeEl | null = start; at; at = at.parent) if (match(at)) return at;
    return null;
  }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  matches(selector: string) { return selector === ":disabled" && "disabled" in this.attrs; }
  getClientRects() { return { length: this.visible ? 1 : 0 }; }
  contains(node: unknown): boolean {
    for (let at = node as FakeEl | null; at; at = at.parent) if (at === this) return true;
    return false;
  }
  querySelectorAll(selector: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (el: FakeEl) => { for (const kid of el.children) { if (selector === FOCUSABLE_SELECTOR ? kid.reachable : kid.name === selector.replace(/^#/, "")) out.push(kid); walk(kid); } };
    walk(this);
    return out;
  }
}

const setup = () => {
  const doc = new FakeDoc();
  const opener = new FakeEl(doc, "opener");
  const outside = new FakeEl(doc, "outside");
  const dialog = new FakeEl(doc, "dialog", false);
  const [first, middle, last] = [new FakeEl(doc, "first"), new FakeEl(doc, "middle"), new FakeEl(doc, "last")];
  dialog.add(new FakeEl(doc, "heading", false), first, new FakeEl(doc, "wrap", false).add(middle), last);
  opener.focus();
  return { doc, opener, outside, dialog, first, middle, last, asDoc: doc as unknown as TrapDocument };
};

const layers: LayerHandle[] = [];
const traps: FocusTrap[] = [];
const start = (...args: Parameters<typeof trapFocus>) => { const trap = trapFocus(...args); traps.push(trap); return trap; };
afterEach(() => { while (layers.length) layers.pop()!.release(); while (traps.length) traps.pop()!.release(); });

describe("focus trap", () => {
  it("lists only what a keyboard can reach, in order", () => {
    const { doc, dialog, first, middle, last } = setup();
    expect(focusableWithin(dialog as never)).toEqual([first, middle, last]);
    middle.visible = false;
    last.attrs.inert = "";
    expect(focusableWithin(dialog as never)).toEqual([first]);
    first.attrs["aria-hidden"] = "true";
    expect(focusableWithin(dialog as never)).toEqual([]);
    delete first.attrs["aria-hidden"];
    first.attrs.tabindex = "-1";
    expect(focusableWithin(dialog as never)).toEqual([]);
    first.attrs = { tabindex: "0", disabled: "" };
    expect(focusableWithin(dialog as never)).toEqual([]);
    expect(doc).toBeTruthy();
  });

  it("names every kind of control and leaves out tabindex -1 and disabled ones", () => {
    for (const part of ["a[href]", "button:not([disabled])", "input:not([disabled])", "select:not([disabled])", "textarea:not([disabled])", "summary", "[tabindex]:not([tabindex=\"-1\"])", "[contenteditable=\"true\"]"]) {
      expect(FOCUSABLE_SELECTOR, part).toContain(part);
    }
  });

  it("moves focus to the first control as it starts", () => {
    const { dialog, first, asDoc } = setup();
    start(dialog as never, { doc: asDoc });
    expect(first.focus).toHaveBeenCalled();
  });

  it("starts on the control the owner names, by element or selector", () => {
    const a = setup();
    start(a.dialog as never, { doc: a.asDoc, initialFocus: a.last as never });
    expect(a.doc.activeElement).toBe(a.last);
    traps.pop()!.release();
    const b = setup();
    start(b.dialog as never, { doc: b.asDoc, initialFocus: "#middle" });
    expect(b.doc.activeElement).toBe(b.middle);
  });

  it("focuses the container itself when it has no controls", () => {
    const { doc, asDoc } = setup();
    const empty = new FakeEl(doc, "empty", false);
    start(empty as never, { doc: asDoc });
    expect(doc.activeElement).toBe(empty);
    const tab = doc.key("Tab");
    expect(tab.preventDefault).toHaveBeenCalled();
    expect(doc.activeElement).toBe(empty);
  });

  it("wraps Tab from the last control to the first, and Shift+Tab from the first to the last", () => {
    const { doc, dialog, first, last, asDoc } = setup();
    start(dialog as never, { doc: asDoc });
    last.focus();
    expect(doc.key("Tab").preventDefault).toHaveBeenCalled();
    expect(doc.activeElement).toBe(first);
    expect(doc.key("Tab", true).preventDefault).toHaveBeenCalled();
    expect(doc.activeElement).toBe(last);
  });

  it("lets Tab move normally between the controls in the middle", () => {
    const { doc, dialog, first, asDoc } = setup();
    start(dialog as never, { doc: asDoc });
    first.focus();
    expect(doc.key("Tab").preventDefault).not.toHaveBeenCalled();
    expect(doc.key("a").preventDefault).not.toHaveBeenCalled();
  });

  it("brings focus back when it wanders outside", () => {
    const { doc, dialog, first, outside, asDoc } = setup();
    start(dialog as never, { doc: asDoc });
    first.focus.mockClear();
    doc.moveFocus(outside);
    expect(first.focus).toHaveBeenCalled();
    expect(doc.activeElement).toBe(first);
  });

  it("closes on Escape only when the owner asks, and then nothing else sees the key", () => {
    const { doc, dialog, asDoc } = setup();
    start(dialog as never, { doc: asDoc });
    expect(doc.key("Escape").preventDefault).not.toHaveBeenCalled();
    traps.pop()!.release();
    const onEscape = vi.fn();
    start(dialog as never, { doc: asDoc, onEscape });
    const escape = doc.key("Escape");
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(escape.stopPropagation).toHaveBeenCalled();
  });

  it("gives focus back to the opener on release, once", () => {
    const { doc, dialog, opener, asDoc } = setup();
    const trap = start(dialog as never, { doc: asDoc });
    expect(doc.activeElement).not.toBe(opener);
    trap.release();
    trap.release();
    expect(doc.activeElement).toBe(opener);
    expect(opener.focus).toHaveBeenCalledTimes(2); // once by setup, once on release
    expect(doc.listeners.keydown.size).toBe(0);
    expect(doc.listeners.focusin.size).toBe(0);
  });

  it("hands focus to the drawer's menu button when the opener sits in the closed drawer", () => {
    const { doc, dialog, opener, asDoc } = setup();
    const drawer = new FakeEl(doc, "drawer", false);
    drawer.add(opener);
    const menu = new FakeEl(doc, "menu");
    doc.fallback = menu;
    const trap = start(dialog as never, { doc: asDoc });
    drawer.attrs.inert = "";
    trap.release();
    expect(doc.activeElement).toBe(menu);
  });

  it("leaves focus alone on release when told to", () => {
    const { doc, dialog, first, asDoc } = setup();
    start(dialog as never, { doc: asDoc, skipReturnFocus: true });
    traps.pop()!.release();
    expect(doc.activeElement).toBe(first);
  });

  it("stacks: the inner trap owns the keyboard until it closes, then the outer one has it again", () => {
    const { doc, dialog, first, last, asDoc } = setup();
    const outer = start(dialog as never, { doc: asDoc });
    const menu = new FakeEl(doc, "menu", false);
    const item = new FakeEl(doc, "item");
    menu.add(item);
    last.add(menu);
    const onEscape = vi.fn();
    const inner = start(menu as never, { doc: asDoc, onEscape });
    expect(activeTrapCount()).toBe(2);
    expect(outer.active).toBe(false);
    expect(inner.active).toBe(true);
    expect(doc.activeElement).toBe(item);
    doc.key("Tab");
    expect(doc.activeElement).toBe(item);
    doc.key("Escape");
    expect(onEscape).toHaveBeenCalledTimes(1);
    inner.release();
    traps.splice(traps.indexOf(inner), 1);
    expect(outer.active).toBe(true);
    expect(doc.activeElement).toBe(first);
  });

  it("closing a trap that sits under another one leaves focus where it is", () => {
    const { doc, dialog, asDoc } = setup();
    const outer = start(dialog as never, { doc: asDoc });
    const popup = new FakeEl(doc, "popup", false);
    const [one, two] = [new FakeEl(doc, "one"), new FakeEl(doc, "two")];
    popup.add(one, two);
    start(popup as never, { doc: asDoc });
    two.focus();
    outer.release();
    traps.splice(traps.indexOf(outer), 1);
    expect(doc.activeElement).toBe(two);
  });

  it("puts focus back inside the outer trap when the inner one's opener is gone", () => {
    const { doc, dialog, first, middle, asDoc } = setup();
    start(dialog as never, { doc: asDoc });
    middle.focus();
    const menu = new FakeEl(doc, "menu", false).add(new FakeEl(doc, "item"));
    const inner = start(menu as never, { doc: asDoc });
    middle.isConnected = false;
    doc.activeElement = null;
    inner.release();
    traps.splice(traps.indexOf(inner), 1);
    expect(doc.activeElement).toBe(first);
  });
});

// Behavior-facing red proof on the legacy API, before the ordered engine exists.
describe("ordered engine regressions", () => {
  it("R22-RESUME: skipReturnFocus also suppresses lower resume", () => {
    const { doc, dialog, outside, asDoc } = setup();
    start(dialog, { doc: asDoc });
    const popup = new FakeEl(doc, "popup").add(new FakeEl(doc, "item"));
    const inner = start(popup, { doc: asDoc, skipReturnFocus: true });
    outside.focus();
    inner.release();
    expect(doc.activeElement).toBe(outside);
  });
  it("E8: rejects an unusable explicit initial target", () => {
    const { doc, dialog, first, outside, asDoc } = setup();
    outside.attrs.disabled = "";
    start(dialog, { doc: asDoc, initialFocus: outside });
    expect(doc.activeElement).toBe(first);
  });
  it("H1: null initial target acquires the container", () => {
    const { doc, dialog, asDoc } = setup();
    start(dialog, { doc: asDoc, initialFocus: null });
    expect(doc.activeElement).toBe(dialog);
    expect(dialog.attrs.tabindex).toBe("-1");
  });
});

const layer = (doc: FakeDoc, kind: LayerKind = 'window', extra: Partial<Parameters<typeof openLayer>[0]> = {}) => {
  const seq = nextLayerSequence();
  const handle = openLayer({ id: `test:${seq}`, name: 'test', kind, openingSequence: seq,
    returnFocusTo: doc.activeElement as FakeEl, doc: doc as unknown as TrapDocument, ...extra });
  layers.push(handle);
  return handle;
};
const surface = () => ({ style: { zIndex: '' } }) as HTMLElement;

describe('ordered layer engine', () => {
  it.each([true, false])('E1/E2: kind and sequence share paint and keyboard order, palette first %s', paletteFirst => {
    const { doc, dialog, first } = setup();
    const palette = paletteFirst ? layer(doc, 'palette') : null;
    const window = layer(doc);
    const top = palette ?? layer(doc, 'palette');
    window.attach(dialog, {}, 'loaded');
    expect(first.focus).not.toHaveBeenCalled();
    const a = surface(), b = surface();
    window.bindSurface(a); top.bindSurface(b);
    expect(window.active).toBe(false); expect(top.active).toBe(true);
    expect([a.style.zIndex, b.style.zIndex]).toEqual(['1', '2']);
    expect(openLayers().map(x => x.id)).toEqual([top.id, window.id]);
    window.close();
    expect(b.style.zIndex).toBe('1');
  });
  it('E2/E12: equal kinds have distinct ranks; duplicate ids cannot retarget the original', () => {
    const { doc, dialog } = setup();
    const a = layer(doc), b = layer(doc);
    a.attach(dialog, {}, 'loaded');
    expect(b.active).toBe(true);
    expect(a.zIndex).toBe(1); expect(b.zIndex).toBe(2);
    expect(() => layer(doc, 'palette', { id: a.id })).toThrow('Duplicate layer id');
    expect(openLayers().find(x => x.id === a.id)?.container).toBe(dialog);
    a.release(); a.close(); b.release(); b.close();
    expect(activeTrapCount()).toBe(0);
    expect(doc.listeners.keydown.size).toBe(0);
  });
  it('E5/E6: empty owner handles only one Esc even when closing synchronously', () => {
    const { doc, opener } = setup();
    const lowerClose = vi.fn();
    layer(doc, 'window', { onDismiss: lowerClose });
    const upper = layer(doc, 'palette', { onDismiss: () => upper.close() });
    expect(doc.activeElement).toBe(opener);
    expect(doc.key('Tab').defaultPrevented).toBe(false);
    expect(doc.key('Escape').defaultPrevented).toBe(true);
    expect(lowerClose).not.toHaveBeenCalled();
    expect(activeTrapCount()).toBe(1);
  });
  it('E3: bubble dispatcher respects prevented/composing keys and target ownership', () => {
    const { doc } = setup();
    const close = vi.fn();
    const a = layer(doc, 'window', { onDismiss: close });
    const event = { key: 'Escape', preventDefault: vi.fn(), defaultPrevented: true };
    for (const listener of doc.listeners.keydown) listener(event as never);
    for (const listener of doc.listeners.keydown) listener({ ...event, defaultPrevented: false, isComposing: true } as never);
    expect(close).not.toHaveBeenCalled();
    expect(canHandleLayerEscape(a, { ...event, defaultPrevented: false })).toBe(true);
    layer(doc, 'palette');
    expect(canHandleLayerEscape(a, { ...event, defaultPrevented: false })).toBe(false);
  });
  it('BF-15/E4: exact managed root allows empty palette, nested foreign root yields', () => {
    const { doc, dialog, first } = setup();
    dialog.attrs['aria-modal'] = 'true';
    const lower = layer(doc);
    lower.attach(dialog, {}, 'loaded');
    const dismiss = vi.fn();
    const upper = layer(doc, 'palette', { onDismiss: dismiss });
    expect(doc.key('Escape').defaultPrevented).toBe(true);
    expect(dismiss).toHaveBeenCalledOnce();
    const foreign = new FakeEl(doc, 'foreign').add(new FakeEl(doc, 'foreign-control'));
    foreign.attrs['aria-modal'] = 'true'; dialog.add(foreign);
    doc.moveFocus(foreign.children[0]);
    expect(doc.activeElement).toBe(foreign.children[0]);
    expect(doc.key('Escape').defaultPrevented).toBe(false);
    expect(doc.key('Tab').defaultPrevented).toBe(false);
    upper.release();
    doc.moveFocus(foreign.children[0]);
    expect(doc.activeElement).not.toBe(first);
    expect(doc.key('Escape').defaultPrevented).toBe(false);
  });
  it.each(['body', 'documentElement'] as const)('BF-9/E7: detached focus latch survives %s and stale detach', root => {
    const { doc, dialog } = setup();
    const a = layer(doc); a.attach(dialog, { holdFocus: false }, 'loading');
    dialog.isConnected = false;
    doc.moveFocus(doc[root]);
    a.detach(dialog);
    const next = new FakeEl(doc, 'next').add(new FakeEl(doc, 'retry'));
    a.attach(next, {}, 'error');
    a.detach(dialog);
    expect(a.container).toBe(next);
    expect(doc.activeElement).toBe(next.children[0]);
  });
  it('E7: lower replacement does not steal; active Help destination survives replacement', () => {
    const { doc, dialog, outside } = setup();
    const a = layer(doc); a.attach(dialog, { holdFocus: false }, 'loading');
    doc.moveFocus(outside);
    a.detach(dialog);
    const next = new FakeEl(doc, 'next').add(new FakeEl(doc, 'retry'));
    a.attach(next, { holdFocus: false }, 'loaded');
    expect(doc.activeElement).toBe(outside);
    const upper = layer(doc, 'palette');
    const input = new FakeEl(doc, 'palette').add(new FakeEl(doc, 'input'));
    upper.attach(input, {}, 'loaded');
    a.detach(next); a.attach(dialog, {}, 'error');
    expect(doc.activeElement).toBe(input.children[0]);
  });
  it.each([true, false])('BF-8/E9: accepted selection survives lower holdFocus %s', holdFocus => {
    const { doc, dialog, outside } = setup();
    layer(doc).attach(dialog, { holdFocus }, 'loaded');
    const upper = layer(doc, 'palette');
    upper.keepFocusOnClose();
    outside.focus();
    upper.close();
    expect(doc.activeElement).toBe(outside);
  });
  it.each([false, true])('R5-M5: a wrapping Tab target the browser refuses moves on to the next candidate, shift=%s', shift => {
    const { doc, dialog, first, middle, last } = setup();
    layer(doc).attach(dialog, {}, 'loaded');
    const refused = shift ? last : first;
    refused.focus = vi.fn();
    // Shift+Tab on first wraps to last; Tab on last wraps to first. The wrapped target refuses focus.
    doc.moveFocus(shift ? first : last);
    const event = doc.key('Tab', shift);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(refused.focus).toHaveBeenCalled();
    expect(doc.activeElement).toBe(middle);
  });
  // Astra r3 Medium 3: the upper layer closes while its external opener B stays usable, so no repair is needed;
  // the lower layer mounted under it, deferred its initial focus and must take it now.
  it('R5-M3/BF-8: a lower layer that mounted under the closing one takes its pending first focus after a usable return', () => {
    const { doc, dialog, first, opener } = setup();
    const upper = layer(doc, 'palette');
    upper.attach(new FakeEl(doc, 'settings').add(new FakeEl(doc, 'search')), {}, 'loaded');
    expect(doc.activeElement).not.toBe(opener);
    const lower = layer(doc, 'dialog');
    lower.attach(dialog, {}, 'loaded');
    expect(dialog.contains(doc.activeElement)).toBe(false);
    upper.close();
    expect(doc.activeElement).toBe(first);
    expect(opener.focus).toHaveBeenCalledTimes(2);
  });
  it.each(['keep', 'skip'] as const)('R5-M3/BF-8: the pending first focus still yields to the %s exit', exit => {
    const { doc, dialog, outside } = setup();
    const upper = layer(doc, 'palette', exit === 'skip' ? { skipReturnFocus: true } : {});
    upper.attach(new FakeEl(doc, 'settings').add(new FakeEl(doc, 'search')), {}, 'loaded');
    layer(doc, 'dialog').attach(dialog, {}, 'loaded');
    if (exit === 'keep') upper.keepFocusOnClose();
    outside.focus();
    upper.close();
    expect(doc.activeElement).toBe(outside);
  });
  it('BF-8: Help opener survives palette close and lower resume', () => {
    const { doc, dialog, outside } = setup();
    layer(doc).attach(dialog, { holdFocus: false }, 'loaded');
    doc.moveFocus(outside);
    const upper = layer(doc, 'palette');
    upper.attach(new FakeEl(doc, 'palette').add(new FakeEl(doc, 'input')), {}, 'loaded');
    upper.close();
    expect(doc.activeElement).toBe(outside);
  });
  it('BF-8/D6 engine: generic root fallback resumes the loaded lower window', () => {
    const { doc, dialog, first } = setup();
    const a = layer(doc); a.attach(dialog, {}, 'loading');
    const upper = layer(doc, 'palette');
    first.isConnected = false;
    dialog.isConnected = false;
    a.detach(dialog);
    const loaded = new FakeEl(doc, 'loaded').add(new FakeEl(doc, 'control'));
    a.attach(loaded, {}, 'loaded');
    doc.root = new FakeEl(doc, 'root');
    doc.activeElement = doc.body;
    upper.close();
    expect(doc.activeElement).toBe(loaded.children[0]);
    expect(doc.root.attrs.tabindex).toBe('-1');
  });
  it.each(['dead', 'disabled', 'hidden', 'inert', 'nonfocusable'])('E8: %s opener and fallback reach verified root', state => {
    const { doc, opener, dialog, outside } = setup();
    const a = layer(doc, 'window', { fallbackFocus: outside });
    a.attach(dialog, {}, 'loaded');
    if (state === 'dead') opener.isConnected = false;
    if (state === 'disabled') opener.attrs.disabled = '';
    if (state === 'hidden') opener.attrs.hidden = '';
    if (state === 'inert') opener.attrs.inert = '';
    if (state === 'nonfocusable') opener.focus.mockImplementation(() => {});
    outside.focus.mockImplementation(() => {});
    doc.root = new FakeEl(doc, 'root');
    a.close();
    expect(doc.activeElement).toBe(doc.root);
    expect(doc.root.attrs.tabindex).toBe('-1');
  });
  it('E10: holdFocus false allows Help but retains Tab wrap', () => {
    const { doc, dialog, first, last, outside } = setup();
    layer(doc).attach(dialog, { holdFocus: false }, 'loaded');
    doc.moveFocus(outside); expect(doc.activeElement).toBe(outside);
    last.focus(); doc.key('Tab'); expect(doc.activeElement).toBe(first);
  });
  it('E11/E4: native entries and foreign native dialogs suppress engine actions', () => {
    const { doc, dialog, outside, opener } = setup();
    layer(doc).attach(dialog, {}, 'loaded');
    const native = layer(doc, 'native');
    const node = new FakeEl(doc, 'native').add(new FakeEl(doc, 'native-input'));
    outside.focus(); native.attach(node, {}, 'loaded');
    expect(doc.activeElement).toBe(outside);
    expect(doc.key('Tab').defaultPrevented).toBe(false);
    expect(doc.key('Escape').defaultPrevented).toBe(false);
    native.close(); expect(doc.activeElement).toBe(outside);
    doc.native = node; doc.moveFocus(opener);
    expect(doc.activeElement).toBe(opener);
    expect(doc.key('Tab').defaultPrevented).toBe(false);
  });
  it('E12: release is terminal and silent, stale work cannot change a new handle', () => {
    const { doc, dialog, outside } = setup();
    const old = layer(doc); old.attach(dialog, {}, 'loaded');
    outside.focus(); old.release();
    expect(doc.activeElement).toBe(outside);
    const fresh = layer(doc); const s = surface(); fresh.bindSurface(s);
    old.attach(dialog, {}, 'error'); old.bindSurface(s); old.close();
    expect(fresh.active).toBe(true); expect(s.style.zIndex).toBe('1');
    expect(activeTrapCount()).toBe(1);
  });
});
