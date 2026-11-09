// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// HEALTH-EXIT-FOLLOWUPS, the lazy overlay contract (PULLBACK-1018 redesign after Astra r2 and r3):
//  - data-lazy-overlay ("this layer takes Esc") is set ONLY when a dismiss path exists, on the loading overlay and on
//    both error overlays of LazyBoundary;
//  - such an overlay joins the app's ONE layer stack (focus-trap.ts): Esc goes to the topmost layer, never to whichever
//    listener registered first, so Settings with a failed palette over it closes the palette first, then Settings;
//  - every caller that draws an overlay over the app passes onDismiss, every other bare LazyFallback is inline or pane;
//  - with no onDismiss there is no marker, no Close, and Esc falls through to the next layer.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LazyBoundary, overlayMarker } from "@/components/LazyBoundary";
import { LazyFallback } from "@/components/LazyFallback";
import { healthEscapeListener } from "@/components/health/HealthExit";
import { activeTrapCount, openLayer as registerOwner, type LayerHandle, type TrapDocument } from "@/lib/focus-trap";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const source = (path: string) => readFileSync(join(SRC, path), "utf8");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "e2e" || name === "node_modules") continue;
      out.push(...sourceFiles(path));
    } else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

/** Every `<LazyBoundary` and `<LazyFallback` use in the app, as file:line with the text of that line. */
const uses = sourceFiles(SRC).flatMap((file) =>
  readFileSync(file, "utf8").split("\n").flatMap((text, index) => (/<LazyBoundary|<LazyFallback/.test(text) && !/^\s*(\/\/|\*)/.test(text) ? [{ where: `${file.slice(SRC.length)}:${index + 1}`, text }] : [])),
);
// the boundary of a panel drawn over the app (not inline in a pane) is what takes the key
const overlayBoundaries = uses.filter((use) => /<LazyBoundary\b/.test(use.text) && !/<LazyBoundary\b[^>]*\binline\b/.test(use.text) && !use.where.startsWith("components/LazyBoundary.tsx"));
const fallbackUses = uses.filter((use) => /<LazyFallback\b/.test(use.text) && !use.where.startsWith("components/LazyFallback"));

// A DOM small enough to read (the same shape focus-trap.test.ts uses): capture listeners run first, then the bubble
// ones, and a stopped or prevented key does not reach them, as in a browser.
class FakeEl {
  isConnected = true;
  focus = vi.fn(() => { this.doc.activeElement = this; });
  constructor(readonly doc: FakeDoc) {}
  closest() { return null; }
  getAttribute() { return null; }
  contains(node: unknown) { return node === this; }
  querySelectorAll() { return []; }
}
class FakeDoc {
  activeElement: unknown = null;
  capture = new Set<(event: never) => void>();
  bubble = new Set<(event: never) => void>();
  windowBubble = new Set<(event: never) => void>();
  addEventListener(type: string, listener: (event: never) => void, capture?: boolean) { if (type === "keydown") (capture ? this.capture : this.bubble).add(listener); }
  removeEventListener(type: string, listener: (event: never) => void, capture?: boolean) { if (type === "keydown") (capture ? this.capture : this.bubble).delete(listener); }
  querySelector() { return null; }
  press(key: string, extra: Record<string, unknown> = {}) {
    let stopped = false;
    const event = { key, defaultPrevented: false, preventDefault: vi.fn(() => { event.defaultPrevented = true; }), stopPropagation: vi.fn(() => { stopped = true; }), ...extra };
    for (const listener of [...this.capture]) listener(event as never);
    if (!stopped) for (const listener of [...this.bubble]) listener(event as never);
    if (!stopped) for (const listener of [...this.windowBubble]) listener(event as never);
    return event;
  }
}
const layers: LayerHandle[] = [];
let sequence = 0;
const openLayer = (doc: FakeDoc, onDismiss: () => void) => {
  const openingSequence = ++sequence;
  const layer = registerOwner({ id: `contract:${openingSequence}`, name: 'contract', kind: 'dialog', openingSequence,
    returnFocusTo: doc.activeElement as FakeEl | null, onDismiss, doc: doc as unknown as TrapDocument });
  layer.attach(new FakeEl(doc) as never, { onEscape: onDismiss }, 'error');
  layers.push(layer);
  return layer;
};
afterEach(() => { while (layers.length) layers.pop()!.close(); });

/** What SettingsModal does: a bubble keydown listener on the window that skips a key somebody used (SettingsModal.tsx onKey). */
const settingsListener = (close: () => void) => (event: { key: string; defaultPrevented: boolean; preventDefault: () => void }) => {
  if (event.defaultPrevented) return;
  if (event.key === "Escape") { event.preventDefault(); close(); }
};

const failedBoundary = (props: Partial<ConstructorParameters<typeof LazyBoundary>[0]>, state: { failed: boolean; broken: boolean }) => {
  const boundary = new LazyBoundary({ children: null, onRetry: vi.fn(), ...props });
  boundary.state = state;
  return renderToStaticMarkup(boundary.render() as ReactElement);
};
const overlayDoc = { querySelector: ((selector: string) => (selector.includes("[data-lazy-overlay]") ? ({} as Element) : null)) as Document["querySelector"] };
const bareDoc = { querySelector: (() => null) as Document["querySelector"] };

describe("the marker is set only with a dismiss path", () => {
  it("overlayMarker", () => {
    expect(overlayMarker(vi.fn())).toEqual({ "data-lazy-overlay": "" });
    expect(overlayMarker(undefined)).toEqual({});
  });

  it("a failed load and a render error mark the overlay with onDismiss, and not without it", () => {
    for (const state of [{ failed: true, broken: false }, { failed: false, broken: true }]) {
      const withDismiss = failedBoundary({ onDismiss: vi.fn() }, state);
      expect(withDismiss).toContain("data-lazy-overlay");
      expect(withDismiss).toContain("Close");
      const without = failedBoundary({}, state);
      expect(without).toContain("fixed inset-0");
      expect(without).not.toContain("data-lazy-overlay");
      expect(without).not.toContain("Close");
    }
  });

  it("a loading overlay marks itself only with onDismiss, and a pane spinner covers nothing", () => {
    expect(renderToStaticMarkup(createElement(LazyFallback, { onDismiss: vi.fn() }))).toContain("data-lazy-overlay");
    expect(renderToStaticMarkup(createElement(LazyFallback))).not.toContain("data-lazy-overlay");
    const pane = renderToStaticMarkup(createElement(LazyFallback, { pane: true }));
    expect(pane).toContain("Loading");
    expect(pane).not.toContain("fixed");
    expect(pane).not.toContain("data-lazy-overlay");
  });
});

describe("Esc goes to the topmost layer of the one stack", () => {
  it("Settings open, its palette chunk fails: Esc closes the palette first, then Settings", () => {
    const doc = new FakeDoc(), closeSettings = vi.fn(), closePalette = vi.fn();
    doc.windowBubble.add(settingsListener(closeSettings) as never); // Window bubble follows document bubble, even when registered first.
    const palette = openLayer(doc, closePalette);
    expect(activeTrapCount()).toBe(1);
    const first = doc.press("Escape");
    expect(closePalette).toHaveBeenCalledOnce();
    expect(closeSettings).not.toHaveBeenCalled();
    expect(first.preventDefault).toHaveBeenCalled();
    palette.close();
    doc.press("Escape");
    expect(closeSettings).toHaveBeenCalledOnce();
    expect(closePalette).toHaveBeenCalledOnce();
  });

  it("layers close top down whatever order they registered in", () => {
    const doc = new FakeDoc(), order: string[] = [];
    const bottom = openLayer(doc, () => { order.push("bottom"); bottom.close(); });
    const top = openLayer(doc, () => { order.push("top"); top.close(); });
    doc.press("Escape");
    doc.press("Escape");
    expect(order).toEqual(["top", "bottom"]);
    expect(activeTrapCount()).toBe(0);
  });

  it("an Esc that ends an IME composition is left alone, and focus goes back to the opener on close", () => {
    const doc = new FakeDoc(), dismiss = vi.fn(), opener = new FakeEl(doc);
    opener.focus();
    const layer = openLayer(doc, dismiss);
    doc.press("Escape", { isComposing: true });
    expect(dismiss).not.toHaveBeenCalled();
    // b12's IME rule: Safari ends a composition with isComposing already false and keyCode 229.
    doc.press("Escape", { isComposing: false, keyCode: 229 });
    expect(dismiss).not.toHaveBeenCalled();
    doc.press("Tab");
    expect(dismiss).not.toHaveBeenCalled();
    layer.close();
    expect(opener.focus).toHaveBeenCalledTimes(2);
  });

  it("Settings' own key handler skips a key somebody used (the layer's prevent is what stops it)", () => {
    const settings = source("components/SettingsModal.tsx");
    expect(settings).toContain("canHandleLayerEscape(layer, e.nativeEvent)");
    expect(settings).not.toContain('window.addEventListener("keydown"');
    expect(source("components/LazyBoundary.tsx")).toContain("useLayerContainer(ref, { onEscape: onDismiss }");
    expect(source("components/LazyBoundary.tsx")).not.toContain('addEventListener("keydown"');
  });
});

describe("Esc over Health", () => {
  it("closes a failed load over Health, and Health keeps the key", () => {
    const onLeave = vi.fn(), dismiss = vi.fn(), doc = new FakeDoc();
    expect(failedBoundary({ onDismiss: dismiss }, { failed: true, broken: false })).toContain("data-lazy-overlay");
    openLayer(doc, dismiss);
    const event = doc.press("Escape");
    expect(dismiss).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalled();
    // Health asks the page: an overlay is on top (and a trap holds the keyboard), so it keeps its place
    healthEscapeListener(onLeave, () => overlayDoc)({ key: "Escape", defaultPrevented: false, preventDefault: vi.fn() });
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("with no onDismiss there is no marker, so Esc falls through to the next layer (Health leaves)", () => {
    const onLeave = vi.fn();
    expect(failedBoundary({}, { failed: true, broken: false })).not.toContain("data-lazy-overlay");
    healthEscapeListener(onLeave, () => bareDoc)({ key: "Escape", defaultPrevented: false, preventDefault: vi.fn() });
    expect(onLeave).toHaveBeenCalledOnce();
  });
});

describe("every caller that draws an overlay passes onDismiss (list with file:line)", () => {
  it("finds the callers", () => {
    expect(overlayBoundaries).toHaveLength(1);
  });

  it.each(overlayBoundaries.map((use) => [use.where, use.text] as const))("%s passes onDismiss and closes on Esc", (_where, text) => {
    expect(text).toMatch(/\bonDismiss=/);
    const dismiss = vi.fn(), doc = new FakeDoc();
    expect(failedBoundary({ onDismiss: dismiss }, { failed: true, broken: false })).toContain("data-lazy-overlay");
    openLayer(doc, dismiss);
    doc.press("Escape");
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("covers every bare LazyFallback: onDismiss when it is an overlay, pane or inline when it is not", () => {
    expect(fallbackUses.length).toBeGreaterThan(5);
    for (const use of fallbackUses) expect(use.text, use.where).toMatch(/<LazyFallback\b[^>]*(onDismiss=|\binline\b|\bpane\b)/);
  });

  it("the page bodies (Needs you, Routines, All chats, Team map, Skill recorder, Plugins) are wired to leave", () => {
    const app = source("App.tsx");
    expect(app).toContain('onLeave={() => dispatch({ type: "showToday" })}');
    for (const closeAction of ['"closeAllChats"', '"togglePlugins", open: false']) expect(app).toContain(closeAction);
    expect(source("components/needs/NeedsYouPage.tsx")).toContain("onDismiss={props.onLeave ??");
  });

  it("each page boundary in App is keyed by its view, so a failure never follows the person to the next page", () => {
    const keys = [...source("App.tsx").matchAll(/<LazyOverlay name="page-[a-z-]+" kind="page" covers="while-loading" key="([a-z-]+)" onRetry=\{(\w+)\.retry\}/g)].map((match) => match[1]);
    expect(keys).toEqual(["all-chats", "team-map", "routines", "skill-recorder", "browser-workspace", "local-vm-workspace"]);
  });

  it("a fallback or error dismissed before its dialog mounted hands focus back to the opener", () => {
    const group = source("components/GroupView.tsx");
    expect(group).toContain("const dismissLifecycleDialog = () => { setLifecycleDialog(null); };");
    expect(group.match(/onDismiss=\{dismissLifecycleDialog\}/g)).toHaveLength(2);
    const sidebar = source("components/Sidebar.tsx");
    expect(sidebar).toContain("const dismissNewProject = () => { setNewRoom(null); };");
    expect(sidebar.match(/onDismiss=\{dismissNewProject\}/g)).toHaveLength(1);
  });
});


describe("PULLBACK S1-S4 wrapper ownership", () => {
  it("S1: only LazyOverlay calls a non-inline LazyBoundary", () => {
    expect(overlayBoundaries.map(use => use.where.split(':')[0])).toEqual(['components/LazyOverlay.tsx']);
  });
  it("S2/S4: all overlay callers declare name, kind and coverage", () => {
    const rows = sourceFiles(SRC).flatMap(file => [...readFileSync(file, 'utf8').matchAll(/<LazyOverlay\b([^>]*(?:=>[^>]*)?)/g)].map(match => ({ file, text: match[1] })));
    expect(rows.length).toBeGreaterThan(30);
    const names: string[] = [];
    for (const row of rows) {
      expect(row.text, row.file).toMatch(/name="[a-z-]+"/);
      expect(row.text, row.file).toMatch(/kind="(page|window|dialog|palette)"/);
      expect(row.text, row.file).toMatch(/covers="(always|while-loading)"/);
      names.push(row.text.match(/name="([a-z-]+)"/)![1]);
    }
    expect(new Set(names).size).toBe(names.length);
  });
});


describe("S5/S6 migrated window and palette owners", () => {
  it("loaded windows attach without competing window key or return effects", () => {
    for (const file of ['SettingsModal', 'PluginsPanel', 'TeamLibraryPanel']) {
      const text = source(`components/${file}.tsx`);
      expect(text).toContain('useLayerContainer(');
      expect(text).toContain('<LayerSurface>');
      expect(text).not.toMatch(/window\.addEventListener\(["']keydown/);
      expect(text).not.toContain('returnFocus(');
    }
  });
  it("palette owns no global listeners or local open state and paints through its slot", () => {
    const text = source('components/CommandPalette.tsx');
    expect(text).not.toContain('setOpen(');
    expect(text).not.toContain('autoFocus');
    expect(text).not.toContain('addEventListener(');
    expect(text).toContain('useLayerContainer(');
    expect(text).toContain('<LayerSurface>');
    expect(source('components/CommandPaletteHost.tsx')).toContain('openingSequence={request.openingSequence}');
  });
});

describe('S8/S9 and R24-AUDIT exact inventories', () => {
  it('the four independent Settings children bind their own hook and surface', () => {
    const rows = [['SectionContextDialog', 'section-context'], ['FullAccessWarning', 'full-access-warning'], ['LocalComputerAutoWarning', 'local-computer-warning'], ['CompanionSection', 'confirm-remote-access']];
    for (const [file, name] of rows) { const text = source(`components/${file}.tsx`); expect(text).toContain('useFocusTrap('); expect(text).toContain(`name: "${name}"`); expect(text).toContain('<LayerSurface handle={layer}>'); }
    expect(rows).toHaveLength(4);
  });
  it('the five Settings native children register only through successful showModal', () => {
    const files = ['MemoryLauncher', 'EngineSignInDialog', 'EngineChatLinkDialog', 'ImageMedia', 'KeyboardShortcutsDialog'];
    for (const file of files) { const text = source(`components/${file}.tsx`); expect(text).toContain('useNativeDialogLayer('); expect(text).toContain('native.show()'); expect(text).not.toContain('useLayerContainer('); }
    const helper = source('lib/native-dialog-layer.ts'); expect(helper.indexOf('node.showModal()')).toBeLessThan(helper.indexOf('const handle = openLayer(')); expect(helper).toContain("kind: 'native'"); expect(helper).toContain('skipReturnFocus: true'); expect(files).toHaveLength(5);
  });
  it('all nine calendar adapters have page ownership, with both RoutineSheet callers leased', () => {
    const calendar = source('components/RoutineCalendarPage.tsx');
    const names = ['routine-editor', 'routine-quick-create', 'routine-event-details', 'routine-paused-list', 'routine-editor-unavailable'];
    for (const name of names) expect(calendar).toContain(`"${name}"`);
    expect(calendar).not.toContain('useModalDialog('); expect(calendar).not.toContain('autoFocus');
    expect(calendar.match(/<RoutineSheet lifecycle=\{lifecycle\}/g)).toHaveLength(2);
    for (const file of ['RoutineSheet', 'NewRoutineSheet', 'RoutineProblemsList']) {
      const text = source(`components/routines/${file}.tsx`); expect(text).toContain('useCalendarLayer('); expect(text).toContain('<LayerSurface handle={layer}>'); expect(text).not.toContain('z-50'); expect(text).not.toContain('autoFocus');
    }
    expect(source('components/CalendarLayer.tsx')).toContain("kind: 'page'");
  });
  it('the five exclusions remain inline or explicitly nonmodal', () => {
    const approvals = source('components/ApproveAll.tsx'); expect(approvals.match(/role="group"/g)?.length).toBeGreaterThanOrEqual(2); expect(approvals).not.toContain('aria-modal'); expect(approvals).not.toContain('useFocusTrap');
    expect(source('components/BotPermissionDefault.tsx')).not.toContain('useFocusTrap');
    const companion = source('components/CompanionSection.tsx').split('export function RevokeDeviceConfirm')[1].split('function QrLogin')[0]; expect(companion).not.toContain('useFocusTrap'); expect(companion).toContain('canHandleLayerEscape(');
    expect(source('components/ModelPicker.tsx')).not.toContain('useFocusTrap'); expect(source('components/help/HelpHost.tsx')).not.toContain('useFocusTrap');
  });
});
