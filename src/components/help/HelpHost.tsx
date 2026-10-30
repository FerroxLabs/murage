// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The "?" help panel's always-loaded part (UX overhaul slice 4, lane L4A):
// the "?" tab, the one key listener (installed when this module loads, ahead
// of every overlay), the modal-window watch and the host App.tsx mounts. The
// panel itself (HelpPanel.tsx: tips, search, links and the feedback form,
// with the screens index and the envelope) loads on first use, so the first
// paint does not carry it (src/first-paint.test.ts, the bundle budget).
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { focusableWithin, type TrapContainer, type TrapElement } from "@/lib/focus-trap";
import { wrapTabTarget } from "@/lib/focus-wrap";
import type { FeedbackSurface } from "@/lib/feedback-surface";
import type { HelpScreenInput } from "@/lib/screen-envelope";
import { hx } from "./help-copy";

// ── keys ─────────────────────────────────────────────────────────────────

export type HelpKeyAction = "toggle" | "open" | null;
interface KeyLike { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing?: boolean; defaultPrevented?: boolean }
interface TargetLike { tagName?: string; isContentEditable?: boolean; type?: string }

const NOT_TYPING_INPUTS = new Set(["button", "checkbox", "radio", "submit", "reset", "range", "color", "file", "image"]);
/** A box the owner types into: "?" there is a character, never a shortcut. */
export function isTypingTarget(target: TargetLike | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  return tag === "INPUT" && !NOT_TYPING_INPUTS.has((target.type ?? "text").toLowerCase());
}

/** Cmd/Ctrl+/ toggles help from anywhere, a box included. "?" opens it only
 *  when no box has focus, so typing a question mark always types one. */
export function helpKeyAction(event: KeyLike, target: TargetLike | null | undefined): HelpKeyAction {
  if (event.isComposing || event.defaultPrevented) return null;
  const mod = event.metaKey || event.ctrlKey;
  if (mod && !event.altKey && (event.key === "/" || event.code === "Slash")) return "toggle";
  if (event.key === "?" && !mod && !event.altKey && !isTypingTarget(target)) return "open";
  return null;
}

// ── one listener for help's keys, ahead of every overlay ─────────────────
// Overlays (the team library and others) listen on window in the capture
// phase and stop Esc and Tab there. Listeners on one target run in the order
// they were added, so help adds its listener when this module loads, before
// any screen mounts. It answers Cmd/Ctrl+/ and "?" as above. While focus is
// inside the help panel, Esc and Tab are help's alone: Esc closes it, Tab and
// Shift+Tab go round its controls (the wrap from L8's focus trap, without the
// trap's pull-back, so the panel stays non-modal and a click on the page
// behind still works), and no overlay listener sees them. Outside the panel
// those keys are left to the page.

export interface HelpKeyHandler { isOpen(): boolean; open(): void; close(): void }
interface HelpKeyTarget extends TargetLike { closest?(selector: string): unknown }
export interface HelpKeyEvent extends KeyLike {
  shiftKey?: boolean;
  target: unknown;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

let keyHandler: HelpKeyHandler | null = null;
/** HelpHost registers itself here; returns the unregister. */
export function setHelpKeyHandler(handler: HelpKeyHandler): () => void {
  keyHandler = handler;
  return () => { if (keyHandler === handler) keyHandler = null; };
}

/** True when help took the key. */
export function dispatchHelpKey(event: HelpKeyEvent, handler: HelpKeyHandler | null = keyHandler, activeElement: unknown = globalThis.document?.activeElement): boolean {
  if (!handler) return false;
  const target = (event.target ?? null) as HelpKeyTarget | null;
  const panel = handler.isOpen() ? (target?.closest?.("[data-help-panel]") as (TrapContainer & TrapElement) | null | undefined) : null;
  if (panel && !event.isComposing && !event.defaultPrevented) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      handler.close();
      return true;
    }
    if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.stopImmediatePropagation();
      const controls = focusableWithin(panel);
      if (controls.length === 0) { event.preventDefault(); panel.focus(); return true; }
      const next = wrapTabTarget(controls.length, controls.indexOf(activeElement as TrapElement), Boolean(event.shiftKey));
      if (next !== null) { event.preventDefault(); controls[next]!.focus(); }
      return true;
    }
  }
  const action = helpKeyAction(event, event.target as TargetLike | null);
  if (!action) return false;
  event.preventDefault();
  if (action === "toggle" && handler.isOpen()) handler.close();
  else if (!handler.isOpen()) handler.open();
  return true;
}

const INSTALLED = "__murageHelpKeys";
/** Adds the one capture listener to `target` (the window). A second call (a
 *  hot reload) swaps the listener rather than adding another. */
export function installHelpKeys(target: EventTarget): void {
  const marked = target as EventTarget & { [INSTALLED]?: EventListener };
  const listener: EventListener = (event) => { dispatchHelpKey(event as unknown as HelpKeyEvent); };
  if (marked[INSTALLED]) target.removeEventListener("keydown", marked[INSTALLED], true);
  marked[INSTALLED] = listener;
  target.addEventListener("keydown", listener, true);
}
if (typeof window !== "undefined") installHelpKeys(window);

// ── Show hints again (L4C registers it in 1.0.13) ────────────────────────

let hintsReset: (() => void) | null = null;
const hintsListeners = new Set<() => void>();
/** L4C's coach marks call this once; until then the link is not drawn, so no
 *  button on the panel does nothing. Returns the unregister. */
export function registerHintsReset(reset: () => void): () => void {
  hintsReset = reset;
  for (const listener of hintsListeners) listener();
  return () => {
    if (hintsReset === reset) hintsReset = null;
    for (const listener of hintsListeners) listener();
  };
}
export function useHintsReset(): (() => void) | null {
  const [reset, setReset] = useState(() => hintsReset);
  useEffect(() => {
    const listener = () => setReset(() => hintsReset);
    hintsListeners.add(listener);
    return () => { hintsListeners.delete(listener); };
  }, []);
  return reset;
}


/** Help's layer: above every fixed full-screen window in the app (the highest
 *  is z-[71]; HelpPanel.test.ts fails if one reaches this). Native modal
 *  windows sit in the top layer above any z-index, so help is drawn inside
 *  them instead (below). */
export const HELP_LAYER = 80;

/** The "?" tab on the right edge, drawn while the panel is closed. */
export function HelpLauncher({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      data-help-launcher
      aria-label={hx("ux.l4a.panel.open")}
      onClick={onOpen}
      className="fixed right-0 top-1/2 z-[80] flex size-11 -translate-y-1/2 items-center justify-center rounded-l-lg border border-r-0 border-hairline/50 bg-panel text-[16px] font-semibold text-ink-secondary shadow-xl hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border"
    >
      ?
    </button>
  );
}

// ── over a modal window ──────────────────────────────────────────────────
// A window opened with showModal() (bot settings, Files, What's new, ...)
// sits in the browser's top layer and makes the rest of the page inert, so a
// panel or "?" tab drawn beside it could be seen but never used. While one is
// open, the tab and the panel are drawn inside it instead (a portal), which
// keeps them usable and in that window's Tab order; help is still not a
// modal of its own.
export function openModalWindow(root: Pick<Document, "querySelectorAll"> = document): HTMLElement | null {
  let found: HTMLElement[] = [];
  try {
    found = [...root.querySelectorAll<HTMLElement>("dialog:modal")];
  } catch {
    found = [...root.querySelectorAll<HTMLElement>("dialog[open]")];
  }
  return found.at(-1) ?? null;
}
type ObserverLike = Pick<MutationObserver, "observe" | "disconnect">;
type ObserverMaker = new (callback: () => void) => ObserverLike;
/** Calls `onChange` with the open modal window, now and whenever that changes:
 *  one watch on `open` attributes for the whole page (showModal and close set
 *  and clear it), plus, only while a window is held, a watch for that window
 *  being taken out of the page. Returns the stop. */
export function watchModalWindow(
  onChange: (host: HTMLElement | null) => void,
  doc: Pick<Document, "querySelectorAll" | "body"> = document,
  Observer: ObserverMaker = MutationObserver,
): () => void {
  let host: HTMLElement | null = null;
  let removal: ObserverLike | null = null;
  let first = true;
  const update = () => {
    const next = openModalWindow(doc);
    if (next !== host || first) { host = next; first = false; onChange(host); }
    if (host && !removal) {
      removal = new Observer(() => { if (host && !host.isConnected) update(); });
      removal.observe(doc.body, { childList: true, subtree: true });
    } else if (!host && removal) {
      removal.disconnect();
      removal = null;
    }
  };
  const opens = new Observer(update);
  opens.observe(doc.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
  update();
  return () => { opens.disconnect(); removal?.disconnect(); removal = null; };
}
function useModalWindow(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  // Always watched, open or closed: the "?" tab has to be inside the window too.
  useLayoutEffect(() => watchModalWindow(setHost), []);
  return host;
}

// ── the host App.tsx mounts ──────────────────────────────────────────────

/** The open panel, loaded on first use. */
export const loadHelpPanel = () => import("./HelpPanel");
const HelpOpen = lazy(() => loadHelpPanel().then((module) => ({ default: module.HelpOpen })));

export interface HelpHostProps {
  surface: FeedbackSurface;
  noEngines: boolean;
  enginesOff: boolean;
  firstRun: HelpScreenInput["firstRun"];
  /** L4B's ask (1.0.14). */
  askSlot?: ReactNode;
}

/** The panel, the "?" tab and the two keys, for every surface: desktop, the
 *  phone through the Door and the Cloud window. */
export function HelpHost({ surface, noEngines, enginesOff, firstRun, askSlot }: HelpHostProps) {
  const [open, setOpen] = useState(false);
  const modalWindow = useModalWindow();
  const returnTo = useRef<HTMLElement | null>(null);
  const openPanel = useCallback(() => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    const back = returnTo.current;
    returnTo.current = null;
    // Opened from the "?" tab, which is not drawn while the panel is open: focus the tab again once it is back.
    requestAnimationFrame(() => (back?.isConnected ? back : document.querySelector<HTMLElement>("[data-help-launcher]"))?.focus());
  }, []);
  /** Closed for "Ask your bot": focus goes to the composer, not back. */
  const dismiss = useCallback(() => { setOpen(false); returnTo.current = null; }, []);

  // The keys go through the one window listener above (dispatchHelpKey).
  const openNow = useRef(open);
  openNow.current = open;
  useEffect(() => setHelpKeyHandler({ isOpen: () => openNow.current, open: openPanel, close }), [openPanel, close]);
  // Fetch the panel once the app is idle, so the first open is instant.
  useEffect(() => {
    const timer = setTimeout(() => { void loadHelpPanel().catch(() => undefined); }, 3000);
    return () => clearTimeout(timer);
  }, []);

  const entry = !open ? <HelpLauncher onOpen={openPanel} /> : (
    <Suspense fallback={null}>
      <HelpOpen surface={surface} noEngines={noEngines} enginesOff={enginesOff} firstRun={firstRun} askSlot={askSlot} onClose={close} onDismiss={dismiss} />
    </Suspense>
  );
  // Inside an open modal window, the tab and the panel are drawn in it, so both can be clicked and tapped.
  return modalWindow ? createPortal(entry, modalWindow) : entry;
}
