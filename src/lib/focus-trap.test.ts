// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

import { FOCUSABLE_SELECTOR, activeTrapCount, focusableWithin, trapFocus, type FocusTrap, type TrapDocument } from "./focus-trap";

// A DOM small enough to read: elements know their parent, focus sets the document's activeElement, and the
// container answers querySelectorAll with its own descendants in order. The trap only uses these calls.
class FakeDoc {
  activeElement: unknown = null;
  listeners = { keydown: new Set<(event: never) => void>(), focusin: new Set<(event: never) => void>() };
  fallback: FakeEl | null = null;
  addEventListener(type: "keydown" | "focusin", listener: (event: never) => void) { this.listeners[type].add(listener); }
  removeEventListener(type: "keydown" | "focusin", listener: (event: never) => void) { this.listeners[type].delete(listener); }
  querySelector(selector: string) { return selector === "[data-focus-fallback]" ? this.fallback : null; }
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
    const attr = /^\[([a-z-]+)\]$/.exec(selector)?.[1];
    return attr ? FakeEl.upFrom(this, (at) => attr in at.attrs) : null;
  }
  static upFrom(start: FakeEl, match: (at: FakeEl) => boolean): FakeEl | null {
    for (let at: FakeEl | null = start; at; at = at.parent) if (match(at)) return at;
    return null;
  }
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

const traps: FocusTrap[] = [];
const start = (...args: Parameters<typeof trapFocus>) => { const trap = trapFocus(...args); traps.push(trap); return trap; };
afterEach(() => { while (traps.length) traps.pop()!.release(); });

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
