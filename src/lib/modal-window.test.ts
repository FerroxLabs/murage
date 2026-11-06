// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The top modal window is the one opened last (the top layer's order), not the last one in the page.
import { expect, it } from "vitest";
import { noteModalWindowChange, openModalWindow, startModalWindowOrder, watchModalWindow } from "./modal-window";

type FakeDialog = { name: string; open: boolean; isConnected: boolean; matches: (selector: string) => boolean };
const dialog = (name: string): FakeDialog => {
  const d: FakeDialog = { name, open: false, isConnected: true, matches: (selector) => selector === "dialog:modal" && d.open };
  return d;
};

function page(...dialogs: FakeDialog[]) {
  // Document order is the order given.
  return { body: {}, querySelectorAll: (selector: string) => (selector === "dialog:modal" ? dialogs.filter((d) => d.open && d.isConnected) : []) };
}

function fakeObservers() {
  const list: { cb: (records?: { target: unknown; attributeName: string | null }[]) => void; on: boolean }[] = [];
  class FakeObserver {
    entry: (typeof list)[number];
    constructor(cb: (typeof list)[number]["cb"]) { this.entry = { cb, on: false }; list.push(this.entry); }
    observe() { this.entry.on = true; }
    disconnect() { this.entry.on = false; }
  }
  return { list, FakeObserver };
}

it("a window opened over one that comes later in the page is the top, and closing it gives the top back", () => {
  const first = dialog("first-in-page");
  const later = dialog("later-in-page");
  const doc = page(first, later);
  const { list, FakeObserver } = fakeObservers();
  const seen: unknown[] = [];
  const stop = watchModalWindow((host) => seen.push(host), doc as unknown as Document, FakeObserver as unknown as never);
  const opens = list[0]!;
  later.open = true;
  opens.cb([{ target: later, attributeName: "open" }]);
  expect(seen.at(-1)).toBe(later);
  first.open = true; // opened second, so it is drawn above
  opens.cb([{ target: first, attributeName: "open" }]);
  expect(seen.at(-1)).toBe(first);
  first.open = false;
  opens.cb([{ target: first, attributeName: "open" }]);
  expect(seen.at(-1)).toBe(later);
  // Closed and opened again in one batch: it comes back on top.
  first.open = true;
  opens.cb([{ target: first, attributeName: "open" }, { target: first, attributeName: "open" }]);
  expect(seen.at(-1)).toBe(first);
  later.open = false;
  later.open = true; // later closed and reopened over first
  opens.cb([{ target: later, attributeName: "open" }]);
  expect(seen.at(-1)).toBe(later);
  stop();
  expect(opens.on).toBe(false);
});

it("windows already open before any watch fall back to page order, after every window seen opening", () => {
  const a = dialog("a");
  const b = dialog("b");
  const c = dialog("c");
  c.open = true;
  noteModalWindowChange(c); // seen opening
  a.open = true;
  b.open = true; // open before any watch: stamped now, in page order
  expect(openModalWindow(page(a, b, c) as unknown as Document)).toBe(b);
});

it("an engine without :modal counts any open dialog", () => {
  const old = { isConnected: true, matches: (selector: string) => { if (selector.includes(":modal")) throw new SyntaxError("unknown"); return true; } };
  const root = { querySelectorAll: (selector: string) => { if (selector.includes(":modal")) throw new SyntaxError("unknown"); return [old]; } };
  noteModalWindowChange(old);
  expect(openModalWindow(root as unknown as Document)).toBe(old);
});

// Last in this file: once the page-wide record starts it stays started (as in the app).
it("the page-wide record knows the order before any watcher starts: two watchers, late and remounted, agree on the top", () => {
  const first = dialog("first-in-page");
  const later = dialog("later-in-page");
  const doc = page(first, later);
  const { list, FakeObserver } = fakeObservers();
  expect(startModalWindowOrder({} as Node, FakeObserver as unknown as never)).toBe(true);
  expect(startModalWindowOrder({} as Node, FakeObserver as unknown as never)).toBe(true); // once only
  expect(list).toHaveLength(1);
  const record = list[0]!;
  // Opened in reverse page order while no watcher runs (the update pop-up is not up yet).
  later.open = true;
  record.cb([{ target: later, attributeName: "open" }]);
  first.open = true;
  record.cb([{ target: first, attributeName: "open" }]);
  const help: unknown[] = [];
  const popup: unknown[] = [];
  const stopHelp = watchModalWindow((host) => help.push(host), doc as unknown as Document, FakeObserver as unknown as never);
  const stopPopup = watchModalWindow((host) => popup.push(host), doc as unknown as Document, FakeObserver as unknown as never);
  expect(help.at(-1)).toBe(first);
  expect(popup.at(-1)).toBe(first);
  // The pop-up goes and comes back: still the window opened last.
  stopPopup();
  const again: unknown[] = [];
  const stopAgain = watchModalWindow((host) => again.push(host), doc as unknown as Document, FakeObserver as unknown as never);
  expect(again.at(-1)).toBe(first);
  // The top one closes: the record hears it first, then both watchers move to the one under it.
  first.open = false;
  record.cb([{ target: first, attributeName: "open" }]);
  for (const entry of list.slice(1).filter((item) => item.on)) entry.cb([{ target: first, attributeName: "open" }]);
  expect(help.at(-1)).toBe(later);
  expect(again.at(-1)).toBe(later);
  stopHelp();
  stopAgain();
});
