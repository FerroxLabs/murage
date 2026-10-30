// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { clampHelpWidth, HELP_LAYER, HELP_WIDTH, HelpLauncher, HelpPanel, helpKeyAction, installHelpKeys, isTypingTarget, openModalWindow, registerHintsReset, setHelpKeyHandler, watchModalWindow, type HelpPanelProps } from "./HelpPanel";
import { feedbackEnvelopeForScreen, resolveHelpScreen } from "@/lib/screen-envelope";
import { SHORTCUT_GROUPS } from "@/lib/keyboard-shortcuts";

const key = (over: Partial<Parameters<typeof helpKeyAction>[0]>) => ({ key: "", metaKey: false, ctrlKey: false, altKey: false, ...over });
const composer = { tagName: "TEXTAREA" };

describe("help keys", () => {
  it("Cmd / with the composer focused opens help", () => {
    expect(helpKeyAction(key({ key: "/", metaKey: true }), composer)).toBe("toggle");
    expect(helpKeyAction(key({ key: "/", ctrlKey: true }), composer)).toBe("toggle");
    expect(helpKeyAction(key({ key: "÷", code: "Slash", metaKey: true }), { tagName: "INPUT", type: "text" })).toBe("toggle");
  });
  it("? in the composer types a question mark", () => {
    expect(helpKeyAction(key({ key: "?" }), composer)).toBeNull();
    expect(helpKeyAction(key({ key: "?" }), { tagName: "INPUT", type: "search" })).toBeNull();
    expect(helpKeyAction(key({ key: "?" }), { tagName: "DIV", isContentEditable: true })).toBeNull();
  });
  it("? with no box focused opens help", () => {
    expect(helpKeyAction(key({ key: "?" }), { tagName: "BODY" })).toBe("open");
    expect(helpKeyAction(key({ key: "?" }), { tagName: "INPUT", type: "checkbox" })).toBe("open");
    expect(helpKeyAction(key({ key: "?" }), null)).toBe("open");
  });
  it("leaves other keys, composition and handled events alone", () => {
    expect(helpKeyAction(key({ key: "/" }), { tagName: "BODY" })).toBeNull();
    expect(helpKeyAction(key({ key: "/", metaKey: true, altKey: true }), null)).toBeNull();
    expect(helpKeyAction(key({ key: "/", metaKey: true, isComposing: true }), null)).toBeNull();
    expect(helpKeyAction(key({ key: "?", defaultPrevented: true }), null)).toBeNull();
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
  });
  it("is listed in Keyboard shortcuts", () => {
    const items = SHORTCUT_GROUPS.flatMap((group) => group.items);
    expect(items.find((item) => item.id === "help")?.keys).toEqual(["Mod", "/"]);
    expect(items.find((item) => item.id === "help-question")?.keys).toEqual(["?"]);
  });
});

describe("help panel", () => {
  const screen = resolveHelpScreen({ activeView: "routines", connected: true });
  const props = (over: Partial<HelpPanelProps> = {}): HelpPanelProps => ({
    entry: screen.entry,
    params: { ...screen.params, mod: "Ctrl" },
    title: "Routines",
    envelope: feedbackEnvelopeForScreen(screen),
    surface: "desktop",
    noEngine: false,
    onClose: vi.fn(),
    onOpenEngines: vi.fn(),
    onAskBot: vi.fn(),
    ...over,
  });
  const render = (over?: Partial<HelpPanelProps>) => renderToStaticMarkup(createElement(HelpPanel, props(over)));

  it("shows the screen's tips, search, links and the feedback door, in that order", () => {
    const html = render();
    expect(html).toContain("Help · Routines");
    expect(html).toContain("Things your bots do on a schedule. Click a routine or a mark to open it.");
    expect(html).toContain("Open a routine to run it now, pause it or change when it runs.");
    const order = ["On this screen", "Search help", "Keyboard shortcuts", "What&#x27;s new", "Tell us what to make easier"].map((text) => html.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // never a modal
    expect(html).not.toContain("aria-modal");
    expect(html).toContain('aria-label="Close help"');
  });

  it("with no engine, tips and search still work, plus how to get one", () => {
    const html = render({ noEngine: true });
    expect(html).toContain("Connect an engine to ask questions here.");
    expect(html).toContain("Open Engines");
    expect(html).toContain("Search help");
    expect(render()).not.toContain("Connect an engine to ask questions here.");
  });

  it("puts the ask slot above the feedback form", () => {
    const html = render({ askSlot: createElement("div", { "data-ask": "1" }, "ASK-SLOT"), initialFeedbackOpen: true });
    expect(html.indexOf("ASK-SLOT")).toBeGreaterThan(0);
    expect(html.indexOf("ASK-SLOT")).toBeLessThan(html.indexOf("Tell us what to make easier"));
  });

  it("draws Show hints again only once coach marks register it", () => {
    expect(render()).not.toContain("Show hints again");
    const unregister = registerHintsReset(() => undefined);
    expect(render()).toContain("Show hints again");
    unregister();
    expect(render()).not.toContain("Show hints again");
  });

  it("keeps its width between the limits", () => {
    expect(clampHelpWidth(100)).toBe(HELP_WIDTH.min);
    expect(clampHelpWidth(9000)).toBe(HELP_WIDTH.max);
    expect(clampHelpWidth(Number.NaN)).toBe(HELP_WIDTH.initial);
    expect(HELP_WIDTH.initial).toBe(360);
  });

  it("the ? tab is a 44 px target with a spoken name", () => {
    const html = renderToStaticMarkup(createElement(HelpLauncher, { onOpen: vi.fn() }));
    expect(html).toContain('aria-label="Help and ask about this screen (?)"');
    expect(html).toContain("size-11");
  });

  it("is drawn inside a modal window when one is open, so it stays usable", () => {
    const top = { id: "top" } as unknown as HTMLElement;
    const under = { id: "under" } as unknown as HTMLElement;
    const modern = { querySelectorAll: (selector: string) => (selector === "dialog:modal" ? [under, top] : []) };
    expect(openModalWindow(modern as unknown as Document)).toBe(top);
    const older = { querySelectorAll: (selector: string) => { if (selector === "dialog:modal") throw new SyntaxError("unknown"); return [top]; } };
    expect(openModalWindow(older as unknown as Document)).toBe(top);
    expect(openModalWindow({ querySelectorAll: () => [] } as unknown as Document)).toBeNull();
    const source = readFileSync(fileURLToPath(new URL("./HelpHost.tsx", import.meta.url)), "utf8");
    expect(source).toContain("return modalWindow ? createPortal(entry, modalWindow) : entry;");
    // the "?" tab is the closed entry, so it is drawn inside the window too
    expect(source).toContain("const entry = !open ? <HelpLauncher onOpen={openPanel} /> : (");
    expect(source).toContain("useLayoutEffect(() => watchModalWindow(setHost), []);");
  });

  it("follows modal windows while help is closed, watching cheaply", () => {
    const observers: { cb: () => void; options?: MutationObserverInit; on: boolean }[] = [];
    class FakeObserver {
      entry: { cb: () => void; options?: MutationObserverInit; on: boolean };
      constructor(cb: () => void) { this.entry = { cb, on: false }; observers.push(this.entry); }
      observe(_node: unknown, options: MutationObserverInit) { this.entry.options = options; this.entry.on = true; }
      disconnect() { this.entry.on = false; }
    }
    const open: { isConnected: boolean }[] = [];
    const doc = { body: {}, querySelectorAll: (selector: string) => (selector === "dialog:modal" ? open.filter((d) => d.isConnected) : []) };
    const seen: unknown[] = [];
    const stop = watchModalWindow((host) => seen.push(host), doc as unknown as Document, FakeObserver as unknown as never);
    expect(seen).toEqual([null]);
    // with no window open, only the open-attribute watch runs
    expect(observers).toHaveLength(1);
    expect(observers[0]!.options).toEqual({ subtree: true, attributes: true, attributeFilter: ["open"] });
    const files = { isConnected: true };
    open.push(files);
    observers[0]!.cb(); // showModal() set open
    expect(seen.at(-1)).toBe(files);
    expect(observers).toHaveLength(2);
    expect(observers[1]!.options).toEqual({ childList: true, subtree: true });
    files.isConnected = false;
    observers[1]!.cb(); // the window was taken out of the page
    expect(seen.at(-1)).toBeNull();
    expect(observers[1]!.on).toBe(false);
    stop();
    expect(observers[0]!.on).toBe(false);
  });

  it("sits above every fixed window in the app", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const layers: [string, number][] = [];
    const walk = (dir: string) => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, item.name);
        if (item.isDirectory()) { if (item.name !== "e2e" && item.name !== "help") walk(path); continue; }
        if (!/\.(tsx?|css)$/.test(item.name) || /\.test\.tsx?$/.test(item.name)) continue;
        for (const line of readFileSync(path, "utf8").split("\n")) {
          // a layer that takes no clicks (a drag ghost, a menu anchor) cannot cover the tab
          if (/pointer-events:\s*none|pointer-events-none/.test(line)) continue;
          for (const m of line.matchAll(/\bz-\[(\d+)\]|\bz-(\d+)\b|z-index:\s*(\d+)|zIndex:\s*(\d+)/g)) {
            layers.push([path, Number(m[1] ?? m[2] ?? m[3] ?? m[4])]);
          }
        }
      }
    };
    walk(root);
    expect(layers.length).toBeGreaterThan(50);
    expect(layers.filter(([, z]) => z >= HELP_LAYER)).toEqual([]);
    const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
    expect(read("./HelpPanel.tsx").match(/z-\[80\]/g)).toHaveLength(1); // the panel
    expect(read("./HelpHost.tsx").match(/z-\[80\]/g)).toHaveLength(1); // the tab
    expect(HELP_LAYER).toBe(80);
  });
});

describe("help keys ahead of overlays", () => {
  const control = () => ({ focus: vi.fn(), closest: () => null });
  const first = control();
  const last = control();
  const panel = { querySelectorAll: () => [first, last], contains: () => true, focus: vi.fn(), closest: () => null };
  const inside = { tagName: "BUTTON", closest: (selector: string) => (selector === "[data-help-panel]" ? panel : null) };
  const outside = { tagName: "BODY", closest: () => null };

  const setup = () => {
    const win = new EventTarget();
    let open = true;
    const handler = { isOpen: () => open, open: vi.fn(() => { open = true; }), close: vi.fn(() => { open = false; }) };
    const unregister = setHelpKeyHandler(handler);
    installHelpKeys(win); // when the module loads, before any screen
    const overlay = vi.fn(); // the team library's window capture listener, added later
    win.addEventListener("keydown", overlay, true);
    const press = (key: string, target: unknown, more: Record<string, boolean> = {}) => {
      const event = new Event("keydown", { cancelable: true });
      Object.defineProperties(event, {
        key: { value: key }, target: { value: target },
        metaKey: { value: Boolean(more.metaKey) }, ctrlKey: { value: false }, altKey: { value: false }, shiftKey: { value: Boolean(more.shiftKey) },
      });
      win.dispatchEvent(event);
      return event;
    };
    return { handler, overlay, press, unregister, reopen: () => { open = true; } };
  };

  it("Esc inside help closes help and the overlay never sees it", () => {
    const { handler, overlay, press, unregister } = setup();
    const event = press("Escape", inside);
    expect(handler.close).toHaveBeenCalledTimes(1);
    expect(overlay).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    unregister();
  });

  it("Tab and Shift+Tab go round help's controls and the overlay never sees them", () => {
    const { overlay, press, unregister } = setup();
    expect(press("Tab", inside, { shiftKey: true }).defaultPrevented).toBe(true);
    expect(last.focus).toHaveBeenCalled();
    press("Tab", inside);
    expect(first.focus).toHaveBeenCalled();
    expect(overlay).not.toHaveBeenCalled();
    unregister();
  });

  it("outside help, Esc and Tab are left to the overlay", () => {
    const { handler, overlay, press, unregister } = setup();
    expect(press("Escape", outside).defaultPrevented).toBe(false);
    press("Tab", outside, { shiftKey: true });
    expect(overlay).toHaveBeenCalledTimes(2);
    expect(handler.close).not.toHaveBeenCalled();
    unregister();
  });

  it("Cmd / still opens and closes help over an overlay", () => {
    const { handler, press, unregister } = setup();
    press("/", outside, { metaKey: true });
    expect(handler.close).toHaveBeenCalledTimes(1);
    press("/", outside, { metaKey: true });
    expect(handler.open).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("is mounted in the app shell on every surface", () => {
    const app = readFileSync(fileURLToPath(new URL("../../App.tsx", import.meta.url)), "utf8");
    expect(app).toContain('import { HelpHost } from "@/components/help/HelpHost";');
    expect(app).not.toMatch(/from "@\/components\/help\/HelpPanel"|from "@\/lib\/screen-envelope"/);
    // The panel, the screens index and the envelope load on first use, not in the first paint.
    const host = readFileSync(fileURLToPath(new URL("./HelpHost.tsx", import.meta.url)), "utf8");
    expect(host).toContain('import("./HelpPanel")');
    expect(host).not.toMatch(/^import (?!type)[^;]*from "(?:\.\/HelpPanel|\.\/FeedbackForm|@\/lib\/screen-envelope|@\/lib\/screens-index)"/m);
    expect(app).toMatch(/<HelpHost\s/);
    expect(app).toContain("surface={feedbackSurface(desktop, isCloudOrigin())}");
  });
});
