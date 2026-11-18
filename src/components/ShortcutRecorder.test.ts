// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, press, settle } from "../testing/dom-harness";
import { t } from "@/lib/i18n";
import { ShortcutRecorder, shortcutAccelerator, type ShortcutRecordResult } from "./ShortcutRecorder";

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(() => { cleanup(); document.body.replaceChildren(); });
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
const start = () => { const button = buttons()[0]; act(() => { button.focus(); button.click(); }); return button; };
const key = (key: string, extras: Partial<KeyboardEvent> = {}) => ({ key, code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...extras });

it("builds Electron accelerators for modifiers, layouts, named keys and platform Meta", () => {
  expect(shortcutAccelerator(key("a", { ctrlKey: true, shiftKey: true }), "win32")).toBe("Control+Shift+A");
  expect(shortcutAccelerator(key("k", { metaKey: true }), "darwin")).toBe("Command+K");
  expect(shortcutAccelerator(key("k", { metaKey: true }), "linux")).toBe("Super+K");
  expect(shortcutAccelerator(key("!", { code: "Digit1", ctrlKey: true, shiftKey: true }), "linux")).toBe("Control+Shift+1");
  expect(shortcutAccelerator(key("ф", { code: "KeyA", ctrlKey: true }), "linux")).toBe("Control+A");
  expect(shortcutAccelerator(key("ArrowUp", { altKey: true }), "linux")).toBe("Alt+Up");
  expect(shortcutAccelerator(key("+", { ctrlKey: true }), "win32")).toBe("Control+Plus");
  for (const event of [key("a"), key("Shift", { shiftKey: true }), key("Dead", { ctrlKey: true }), key("Escape", { ctrlKey: true })]) {
    expect(shortcutAccelerator(event, "darwin")).toBeNull();
  }
});
it("captures once, prevents default, waits through modifiers, and restores button focus after saving", async () => {
  let resolve!: (result: ShortcutRecordResult) => void;
  const onRecord = vi.fn(() => new Promise<ShortcutRecordResult>(yes => { resolve = yes; }));
  mount(h(ShortcutRecorder, { value: null, platform: "darwin", onRecord }));
  const button = start();
  expect(press("Meta", button, { metaKey: true }).defaultPrevented).toBe(true);
  expect(onRecord).not.toHaveBeenCalled();
  expect(press("k", button, { code: "KeyK", metaKey: true }).defaultPrevented).toBe(true);
  press("k", document, { metaKey: true, repeat: true });
  expect(onRecord).toHaveBeenCalledExactlyOnceWith("Command+K");
  expect(button.disabled).toBe(true);
  await act(async () => resolve({ ok: true }));
  expect(button.disabled).toBe(false); expect(document.activeElement).toBe(button);
});
it("Escape cancels without saving and removes the capture listener", async () => {
  const onRecord = vi.fn(async () => ({ ok: true }));
  const app = mount(h(ShortcutRecorder, { value: "Control+A", platform: "win32", onRecord }));
  const button = start();
  expect(press("Escape", document).defaultPrevented).toBe(true); await settle();
  expect(onRecord).not.toHaveBeenCalled(); expect(document.activeElement).toBe(button);
  expect(press("b", document, { ctrlKey: true }).defaultPrevented).toBe(false);
  start(); app.unmount();
  expect(press("b", document, { ctrlKey: true }).defaultPrevented).toBe(false);
});
it("rejects a key without a modifier and preserves the current chip", async () => {
  const onRecord = vi.fn(async () => ({ ok: true }));
  mount(h(ShortcutRecorder, { value: "Control+A", platform: "win32", onRecord }));
  start(); press("b", document); await settle();
  expect(onRecord).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(t("notifyMe.shortcut.invalid"));
  expect(document.querySelector("kbd")?.getAttribute("aria-label")).toBe(t("notifyMe.shortcut.current", { key: "Control+A" }));
});
it.each(["taken", "unsupported", "invalid"] as const)("shows the translated %s refusal and restores focus", async reason => {
  const onRecord = vi.fn(async () => ({ ok: false, reason }));
  mount(h(ShortcutRecorder, { value: "Control+A", platform: "win32", onRecord }));
  const button = start(); press("b", document, { ctrlKey: true }); await settle();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(t(`notifyMe.shortcut.${reason}`));
  expect(document.querySelector("kbd")?.textContent).toBe("Control+A");
  expect(document.activeElement).toBe(button);
});
it("Clear records null, or uses the supplied onClear adapter, and restores focus", async () => {
  for (const useAdapter of [false, true]) {
    const onRecord = vi.fn(async () => ({ ok: true }));
    const onClear = vi.fn(async () => ({ ok: true }));
    const app = mount(h(ShortcutRecorder, { value: "Control+A", platform: "win32", onRecord, ...(useAdapter ? { onClear } : {}) }));
    act(() => buttons()[1].click()); await settle();
    if (useAdapter) { expect(onClear).toHaveBeenCalledExactlyOnceWith(); expect(onRecord).not.toHaveBeenCalled(); }
    else expect(onRecord).toHaveBeenCalledExactlyOnceWith(null);
    expect(document.activeElement).toBe(buttons()[0]); app.unmount();
  }
});
it("shows unavailable portal copy while allowing removal of a saved key", () => {
  mount(h(ShortcutRecorder, { value: "Super+A", platform: "linux", unsupported: true, onRecord: vi.fn(async () => ({ ok: true })) }));
  expect(buttons()[0].disabled).toBe(true); expect(buttons()[1].disabled).toBe(false);
  expect(document.querySelector('[role="status"]')?.textContent).toBe(t("notifyMe.shortcut.unsupported"));
});
it("handles a rejected save without showing raw errors", async () => {
  mount(h(ShortcutRecorder, { value: null, platform: "win32", onRecord: async () => { throw Error("private detail"); } }));
  const button = start(); press("b", document, { ctrlKey: true }); await settle();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(t("notifyMe.shortcut.errorSave"));
  expect(document.activeElement).toBe(button);
});
