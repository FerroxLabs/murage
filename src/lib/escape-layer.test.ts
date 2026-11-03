// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One Escape press goes to the top layer first (1.0.14 CI: the phone drawer used up the key under the New project
// dialog, and the dialog stayed open). The drawer steps aside only for modal layers; a menu inside it closes with it
// (intake.human.spec.ts:281). The press below runs the real listeners in the order a browser calls them: focus-trap
// capture listeners, then a menu's own React handler, then the drawer's document listener, then Health's window
// listener, then the native <dialog>'s cancel, which the browser skips when the key was prevented.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { MODAL_ON_TOP, OPEN_ON_TOP, drawerTakesEscape, escapeIsFree, takeDrawerEscape, takeFreeEscape } from "./escape-layer";
import { trapFocus, type TrapContainer, type TrapDocument, type TrapKeyEvent } from "./focus-trap";
import { healthEscapeListener } from "@/components/health/HealthExit";

type Layer = "dialog" | "snooze" | "menu" | "trap" | null;

function press(onTop: Layer, drawerOpen: boolean) {
  const capture: ((event: TrapKeyEvent) => void)[] = [];
  const doc: TrapDocument = {
    activeElement: null,
    addEventListener: ((type: string, listener: (event: TrapKeyEvent) => void) => { if (type === "keydown") capture.push(listener); }) as unknown as TrapDocument["addEventListener"],
    removeEventListener: ((type: string, listener: (event: TrapKeyEvent) => void) => { if (type === "keydown") capture.splice(capture.indexOf(listener), 1); }) as unknown as TrapDocument["removeEventListener"],
    querySelector: (selector: string) => {
      const modal = onTop === "dialog" || onTop === "snooze";
      if (selector === MODAL_ON_TOP) return modal ? {} : null;
      if (selector === OPEN_ON_TOP) return modal || onTop === "menu" ? {} : null;
      throw new Error(`unexpected selector ${selector}`);
    },
  };
  const closed: string[] = [];
  const panel: TrapContainer = { focus: () => {}, closest: () => null, querySelectorAll: () => [], contains: () => false };
  const trap = onTop === "trap" ? trapFocus(panel, { doc, onEscape: () => closed.push("trap") }) : null;
  const event = { key: "Escape", defaultPrevented: false, target: null, preventDefault() { this.defaultPrevented = true; }, stopPropagation: vi.fn() };
  try {
    for (const listener of [...capture]) listener(event);
    if (!event.stopPropagation.mock.calls.length) {
      // a menu's own handler closes it and, like the bot menu's onMenuKeyDown, prevents the key
      if (onTop === "menu") { closed.push("menu"); event.preventDefault(); }
      if (onTop === "snooze") { closed.push("snooze"); event.preventDefault(); }
      if (drawerOpen) takeDrawerEscape(event, doc as unknown as Pick<Document, "querySelector">, () => closed.push("drawer"));
      healthEscapeListener(() => closed.push("health"), () => doc as unknown as Pick<Document, "querySelector">)(event);
    }
    if (onTop === "dialog" && !event.defaultPrevented) closed.push("dialog"); // the native cancel
  } finally {
    trap?.release();
  }
  return closed;
}

describe("Escape goes to the top layer first", () => {
  it("closes a dialog over the open drawer and leaves the drawer and the page", () => {
    expect(press("dialog", true)).toEqual(["dialog"]);
  });

  it("closes a menu inside the open drawer and the drawer with it, and the page under them stays", () => {
    expect(press("menu", true)).toEqual(["menu", "drawer"]);
  });

  it("closes the Snooze popover over the open drawer and leaves the drawer open", () => {
    expect(press("snooze", true)).toEqual(["snooze"]);
  });

  it("closes a menu over Health without leaving Health", () => {
    expect(press("menu", false)).toEqual(["menu"]);
  });

  it("lets a focus trap close its own panel first", () => {
    expect(press("trap", true)).toEqual(["trap"]);
  });

  it("closes the drawer when it is the top layer, and the page under it stays", () => {
    expect(press(null, true)).toEqual(["drawer"]);
  });

  it("leaves Health when nothing is over it", () => {
    expect(press(null, false)).toEqual(["health"]);
  });

  it("closes a dialog over Health without leaving Health", () => {
    expect(press("dialog", false)).toEqual(["dialog"]);
  });
});

describe("escapeIsFree", () => {
  const none = { querySelector: () => null };
  it("is false for other keys, a used key and an IME composition", () => {
    expect(escapeIsFree({ key: "Enter", defaultPrevented: false }, none)).toBe(false);
    expect(escapeIsFree({ key: "Escape", defaultPrevented: true }, none)).toBe(false);
    expect(escapeIsFree({ key: "Escape", defaultPrevented: false, isComposing: true }, none)).toBe(false);
    expect(escapeIsFree({ key: "Escape", defaultPrevented: false }, none)).toBe(true);
  });

  it("asks for every kind of layer that closes on its own", () => {
    for (const part of ["dialog[open]", '[role="dialog"][aria-modal="true"]', '[role="menu"]', "[data-bot-menu]", "[data-room-menu]", "[data-section-picker]", "[data-snooze-popover]", "[data-create-menu]"]) expect(OPEN_ON_TOP).toContain(part);
  });

  it("holds the drawer back only for modal layers, never for a menu", () => {
    for (const part of ["dialog[open]", '[role="dialog"][aria-modal="true"]', "[data-snooze-popover]"]) expect(MODAL_ON_TOP).toContain(part);
    for (const part of ['[role="menu"]', "[data-bot-menu]", "[data-room-menu]", "[data-section-picker]", "[data-create-menu]"]) expect(MODAL_ON_TOP).not.toContain(part);
  });
});

describe("drawerTakesEscape", () => {
  const none = { querySelector: () => null };
  it("takes an Escape a menu already prevented, but not another key or an IME composition", () => {
    expect(drawerTakesEscape({ key: "Escape", defaultPrevented: true }, none)).toBe(true);
    expect(drawerTakesEscape({ key: "Escape", defaultPrevented: false }, none)).toBe(true);
    expect(drawerTakesEscape({ key: "Enter", defaultPrevented: false }, none)).toBe(false);
    expect(drawerTakesEscape({ key: "Escape", defaultPrevented: false, isComposing: true }, none)).toBe(false);
  });

  it("asks only for modal layers", () => {
    const seen: string[] = [];
    expect(drawerTakesEscape({ key: "Escape", defaultPrevented: false }, { querySelector: (s: string) => { seen.push(s); return {} as Element; } })).toBe(false);
    expect(seen).toEqual([MODAL_ON_TOP]);
  });

  it("takes nothing when it does not act", () => {
    const close = vi.fn();
    const event = { key: "Escape", defaultPrevented: false, preventDefault: vi.fn() };
    expect(takeFreeEscape(event, { querySelector: () => ({}) as Element }, close)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});

describe("the layers that sit under others use the one rule", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  it("binds the drawer, Health and All chats through escape-layer", () => {
    expect(read("../components/Sidebar.tsx")).toContain("takeDrawerEscape(event, document, () => { setPlusOpen(false); onClose(); })");
    expect(read("../components/health/HealthExit.tsx")).toContain("return escapeIsFree(event, doc);");
    expect(read("../components/AllChatsPage.tsx")).toContain("if (!escapeIsFree(event, document)) return;");
  });

  it("closes the + menu on an Esc outside it too, marks it as a menu on top, and keeps an Esc inside it the menu's own", () => {
    const sidebar = read("../components/Sidebar.tsx");
    expect(sidebar).toContain('<div id="sidebar-create-options" data-create-menu=""');
    const at = sidebar.indexOf("if (!plusOpen) return;");
    const effect = sidebar.slice(at, sidebar.indexOf("}, [plusOpen]);", at));
    expect(effect).toContain("if (!escapePassesModals(event, document)) return;");
    expect(effect).toContain('window.addEventListener("keydown", closeOnEscape);');
    // An Esc inside the menu closes it alone and the drawer stays (intake.human.spec.ts:55).
    const menu = sidebar.slice(sidebar.indexOf('<div id="sidebar-create-options"'), sidebar.indexOf("<SidebarNewChatPanel"));
    expect(menu).toContain("event.stopPropagation();");
    expect(read("../components/SidebarNewChatPanel.tsx")).toContain('else if (event.key === "Escape") { event.stopPropagation(); onClose(); }');
  });

  it("closes New Channel and New Project from any control in the panel, and uses the key up", () => {
    const sidebar = read("../components/Sidebar.tsx");
    const panel = sidebar.slice(sidebar.indexOf("function NewRoomPanel("), sidebar.indexOf("/** Move-to-section popover"));
    const root = panel.slice(panel.indexOf('<div role="dialog" aria-modal="true" aria-labelledby="new-channel-title"'));
    expect(root.slice(0, root.indexOf("\n"))).toContain('onKeyDown={(e) => { if (e.key === "Escape" && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); onClose(); } }}');
  });
});
