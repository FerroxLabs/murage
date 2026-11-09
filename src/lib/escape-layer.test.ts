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
import { MODAL_ON_TOP, OPEN_ON_TOP, drawerTakesEscape, escapeIsFree, overlayTakesEscape, takeDrawerEscape, takeFreeEscape } from "./escape-layer";
import { trapFocus, type TrapContainer, type TrapDocument, type TrapKeyEvent } from "./focus-trap";
import { healthEscapeListener } from "@/components/health/HealthExit";

type Layer = "dialog" | "snooze" | "menu" | "trap" | null;

function press(onTop: Layer, drawerOpen: boolean) {
  const capture: ((event: TrapKeyEvent) => void)[] = [];
  const doc: TrapDocument = {
    activeElement: null,
    body: null,
    documentElement: null,
    addEventListener: ((type: string, listener: (event: TrapKeyEvent) => void) => { if (type === "keydown") capture.push(listener); }) as unknown as TrapDocument["addEventListener"],
    removeEventListener: ((type: string, listener: (event: TrapKeyEvent) => void) => { if (type === "keydown") capture.splice(capture.indexOf(listener), 1); }) as unknown as TrapDocument["removeEventListener"],
    querySelector: (selector: string) => {
      if (selector === 'dialog[open]' || selector === 'main' || selector === '#root') return null;
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
    for (const part of ["dialog[open]", '[role="dialog"][aria-modal="true"]', "[data-snooze-popover]", "[data-lazy-overlay]"]) expect(MODAL_ON_TOP).toContain(part);
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

describe("a real keydown dispatched through the listeners (HEALTH-EXIT-FOLLOWUPS)", () => {
  /** A real Event on a real EventTarget, so preventDefault and defaultPrevented are the platform's, not a stub's. */
  const keydown = (key: string, isComposing = false) => Object.assign(new Event("keydown", { cancelable: true }), { key, isComposing });
  const nothingOnTop = { querySelector: (() => null) as Document["querySelector"] };

  it("a layer that takes the key uses it up, and the page listener after it leaves it alone", () => {
    const target = new EventTarget(), drawer = vi.fn(), page = vi.fn();
    target.addEventListener("keydown", (event) => { takeDrawerEscape(event as ReturnType<typeof keydown>, nothingOnTop, drawer); });
    target.addEventListener("keydown", (event) => { takeFreeEscape(event as ReturnType<typeof keydown>, nothingOnTop, page); });
    const event = keydown("Escape");
    expect(target.dispatchEvent(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(drawer).toHaveBeenCalledOnce();
    expect(page).not.toHaveBeenCalled();
  });

  it("a page alone takes a free Esc, and none takes the Esc that ends a composition or another key", () => {
    const target = new EventTarget(), page = vi.fn();
    const onKey = (event: Event) => { takeFreeEscape(event as ReturnType<typeof keydown>, nothingOnTop, page); };
    target.addEventListener("keydown", onKey);
    expect(target.dispatchEvent(keydown("Escape", true))).toBe(true);
    expect(target.dispatchEvent(keydown("Enter"))).toBe(true);
    expect(page).not.toHaveBeenCalled();
    expect(target.dispatchEvent(keydown("Escape"))).toBe(false);
    expect(page).toHaveBeenCalledOnce();
    // once unbound, as Health does on unmount, a later Esc reaches it no more
    target.removeEventListener("keydown", onKey);
    target.dispatchEvent(keydown("Escape"));
    expect(page).toHaveBeenCalledOnce();
  });

  it("Health's own listener, bound and unbound like useHealthEscape, leaves once and then never again", () => {
    const target = new EventTarget(), leave = vi.fn();
    const onKey = healthEscapeListener(leave, () => nothingOnTop) as unknown as EventListener;
    target.addEventListener("keydown", onKey);
    target.dispatchEvent(keydown("Escape"));
    target.removeEventListener("keydown", onKey);
    target.dispatchEvent(keydown("Escape"));
    expect(leave).toHaveBeenCalledOnce();
  });

  it("a loading or failed panel overlay takes the Esc before the page under it", () => {
    expect(overlayTakesEscape({ key: "Escape", defaultPrevented: false })).toBe(true);
    expect(overlayTakesEscape({ key: "Escape", defaultPrevented: false, isComposing: true })).toBe(false);
    expect(overlayTakesEscape({ key: "Escape", defaultPrevented: true })).toBe(false);
    expect(overlayTakesEscape({ key: "Enter", defaultPrevented: false })).toBe(false);
    // the overlay is in MODAL_ON_TOP, so a page and the drawer both wait for it
    const overlayOnTop = { querySelector: ((selector: string) => (selector.includes("[data-lazy-overlay]") ? ({} as Element) : null)) as Document["querySelector"] };
    expect(escapeIsFree({ key: "Escape", defaultPrevented: false }, overlayOnTop)).toBe(false);
    expect(drawerTakesEscape({ key: "Escape", defaultPrevented: false }, overlayOnTop)).toBe(false);
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
    // Neither the + menu's own Esc nor the New chat filter's acts on the Esc that ends an IME composition, and
    // both ask the layer registry first (Astra r3 High 2): canHandleLayerEscape refuses a composing Esc.
    expect(menu).toContain('if (event.key === "Escape" && canHandleLayerEscape(null, event.nativeEvent)) {');
    expect(read("../components/SidebarNewChatPanel.tsx")).toContain('else if (event.key === "Escape" && canHandleLayerEscape(null, event.nativeEvent)) { event.stopPropagation(); onClose(); }');
    expect(read("./focus-trap.ts")).toContain("if (event.key !== 'Escape' || event.defaultPrevented || imeComposing(event)) return false;");
  });

  it("closes New Channel and New Project from any control in the panel, and uses the key up", () => {
    const sidebar = read("../components/Sidebar.tsx");
    const panel = sidebar.slice(sidebar.indexOf("function NewRoomPanel("), sidebar.indexOf("/** Move-to-section popover"));
    expect(panel).toContain('useFocusTrap(dialogRef, true, { name: project ? "new-project-form" : "new-channel-form"');
    expect(panel).toContain('onEscape: onClose');
    expect(panel).toContain('ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true"');
    expect(panel).toContain('<LayerSurface handle={layer}>');
    // Real control bubbling and higher-owner suppression are mounted in additional-modal-layers.dom.test.ts.

  });
});
