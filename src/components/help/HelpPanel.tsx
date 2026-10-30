// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The "?" help panel (UX overhaul slice 4, lane L4A; Phase 2 spec 2.11 and 3).
//
// A side panel on the right, 360 px by default (drag or arrow keys to resize,
// remembered on this device), a sheet from the bottom under 600 px. Never a
// modal: no backdrop, the screen underneath keeps working. Opens with the "?"
// tab, the "?" key when no box has focus, and Cmd/Ctrl+/ always (even in the
// composer). Esc inside it closes it; focus goes in on open and back to where
// it was on close.
//
// Sections, top to bottom: On this screen (screens index tips); the ask slot
// (L4B, 1.0.14) or, with no engine, the line that says how to get one; Search
// help (GET /api/help/search over the shipped docs); links; and the feedback
// form, last, so asking for help always comes first.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HelpCircle, X } from "lucide-react";
import { api, useStore } from "@/state/store";
import { openKeyboardShortcuts, openWhatsNew } from "@/lib/app-events";
import type { HelpResult } from "../../../shared/help-search";
import { envelopeForScreen, resolveHelpScreen, type FeedbackSurface, type HelpScreenInput, type ScreenEnvelope } from "@/lib/screen-envelope";
import { resolveSettingsSection } from "@/lib/settings-pages";
import { shortcutPlatformIsMac } from "@/lib/mod-shortcut";
import { focusableWithin, type TrapContainer, type TrapElement } from "@/lib/focus-trap";
import { wrapTabTarget } from "@/lib/focus-wrap";
import { botRole } from "@/lib/bot-role";
import type { ScreenIndexEntry } from "@/lib/screens-index";
import { FeedbackForm, type SendFeedback } from "./FeedbackForm";
import { HelpTips } from "./HelpTips";
import { hx, modWord } from "./help-copy";

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

// ── width, remembered on this device ─────────────────────────────────────

export const HELP_WIDTH = { initial: 360, min: 320, max: 560, step: 24 } as const;
export const HELP_WIDTH_KEY = "murage.help.width";
export const clampHelpWidth = (width: number): number =>
  Number.isFinite(width) ? Math.round(Math.min(HELP_WIDTH.max, Math.max(HELP_WIDTH.min, width))) : HELP_WIDTH.initial;
function readWidth(): number {
  try {
    const raw = globalThis.localStorage?.getItem(HELP_WIDTH_KEY);
    return raw ? clampHelpWidth(Number(raw)) : HELP_WIDTH.initial;
  } catch { return HELP_WIDTH.initial; }
}
function rememberWidth(width: number): void {
  try { globalThis.localStorage?.setItem(HELP_WIDTH_KEY, String(width)); } catch { /* blocked storage: the width lasts this session */ }
}

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
function useHintsReset(): (() => void) | null {
  const [reset, setReset] = useState(() => hintsReset);
  useEffect(() => {
    const listener = () => setReset(() => hintsReset);
    hintsListeners.add(listener);
    return () => { hintsListeners.delete(listener); };
  }, []);
  return reset;
}

// ── search ───────────────────────────────────────────────────────────────

export type SearchHelp = (query: string, signal: AbortSignal) => Promise<HelpResult[]>;
export const searchHelpRoute: SearchHelp = async (query, signal) => {
  const body = await api(`/api/help/search?q=${encodeURIComponent(query)}&limit=5`, { signal });
  return Array.isArray(body?.results) ? body.results : [];
};

type SearchState = { phase: "idle" } | { phase: "loading" } | { phase: "done"; results: HelpResult[] } | { phase: "failed" };

function HelpSearch({ search }: { search: SearchHelp }) {
  const ids = useId();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ phase: "idle" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const words = query.trim();
    if (!words) { setState({ phase: "idle" }); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setState({ phase: "loading" });
      search(words, controller.signal)
        .then((results) => { if (!controller.signal.aborted) setState({ phase: "done", results }); })
        .catch(() => { if (!controller.signal.aborted) setState({ phase: "failed" }); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, search, attempt]);
  return (
    <section aria-labelledby={`${ids}-h`} className="border-b border-hairline/40 px-5 py-4">
      <h3 id={`${ids}-h`} className="mb-2.5 text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-secondary">{hx("ux.l4a.panel.searchHeading")}</h3>
      <input
        type="search"
        aria-label={hx("ux.l4a.panel.searchLabel")}
        placeholder={hx("ux.l4a.panel.searchPlaceholder")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="min-h-11 w-full rounded-lg border border-hairline/60 bg-app px-3 text-[14px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border"
      />
      <div aria-live="polite" className="mt-3">
        {state.phase === "loading" && <p className="text-[13px] text-ink-secondary">{hx("ux.l4a.panel.searching")}</p>}
        {state.phase === "failed" && (
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-[13px] text-ink">{hx("ux.l4a.panel.searchFailed")}</p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="min-h-11 rounded-lg border border-hairline/60 px-3 text-[13px] font-medium text-ink hover:bg-app focus-visible:ring-2 focus-visible:ring-accent-border">
              {hx("ux.l4a.panel.searchRetry")}
            </button>
          </div>
        )}
        {state.phase === "done" && state.results.length === 0 && <p className="text-[13px] text-ink-secondary">{hx("ux.l4a.panel.noResults")}</p>}
        {state.phase === "done" && state.results.length > 0 && (
          <ul className="flex flex-col gap-3">
            {state.results.map((result) => (
              <li key={result.id} className="rounded-lg border border-hairline/40 px-3 py-2.5">
                <div className="text-[14px] font-semibold text-ink">{result.heading ? `${result.title} · ${result.heading}` : result.title}</div>
                <p className="mt-1 line-clamp-4 text-[13px] leading-5 text-ink-secondary">{result.text}</p>
                {result.where && <p className="mt-1 text-[12px] text-ink-secondary">{hx("ux.l4a.panel.where", { where: result.where })}</p>}
                {result.url.startsWith("https://") && (
                  <a href={result.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex min-h-9 items-center text-[13px] font-semibold text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent-border">
                    {hx("ux.l4a.panel.readMore")}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ── the panel ────────────────────────────────────────────────────────────

const linkButton = "min-h-11 text-[13px] font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border";

export interface HelpPanelProps {
  entry: ScreenIndexEntry | undefined;
  params: Record<string, string>;
  title: string;
  envelope: ScreenEnvelope;
  surface: FeedbackSurface;
  /** No engine can answer: tips and search still work, plus how to get one. */
  noEngine: boolean;
  onClose: () => void;
  onOpenEngines: () => void;
  onAskBot: () => void;
  /** L4B's "Ask about this screen" (1.0.14). Above the feedback form. */
  askSlot?: ReactNode;
  search?: SearchHelp;
  sendFeedback?: SendFeedback;
  /** Tests open the form straight away; the app never passes this. */
  initialFeedbackOpen?: boolean;
}

export function HelpPanel(props: HelpPanelProps) {
  const { entry, params, title, envelope, surface, noEngine, onClose, onOpenEngines, onAskBot, askSlot, search = searchHelpRoute, sendFeedback, initialFeedbackOpen = false } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(readWidth);
  const [feedbackOpen, setFeedbackOpen] = useState(initialFeedbackOpen);
  const showHints = useHintsReset();
  useEffect(() => { headingRef.current?.focus(); }, []);
  // The desktop width rides a property the stylesheet reads at 600 px and up; the phone sheet ignores it.
  useLayoutEffect(() => { asideRef.current?.style.setProperty("--help-w", `${width}px`); }, [width]);
  const resizeTo = useCallback((next: number) => { const clamped = clampHelpWidth(next); setWidth(clamped); rememberWidth(clamped); }, []);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const move = (e: PointerEvent) => setWidth(clampHelpWidth(startWidth + (startX - e.clientX)));
    const up = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      resizeTo(startWidth + (startX - e.clientX));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <aside
      aria-label={hx("ux.l4a.panel.label")}
      data-help-panel
      tabIndex={-1}
      ref={asideRef}
      className="help-panel-in fixed inset-x-0 bottom-0 z-[80] flex h-[85vh] flex-col rounded-t-2xl border-t border-hairline/50 bg-panel text-ink shadow-2xl min-[600px]:inset-x-auto min-[600px]:right-0 min-[600px]:top-0 min-[600px]:h-[var(--vvh,100%)] min-[600px]:w-[var(--help-w)] min-[600px]:rounded-none min-[600px]:border-l min-[600px]:border-t-0"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={hx("ux.l4a.panel.resize")}
        aria-valuemin={HELP_WIDTH.min}
        aria-valuemax={HELP_WIDTH.max}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") { event.preventDefault(); resizeTo(width + HELP_WIDTH.step); }
          else if (event.key === "ArrowRight") { event.preventDefault(); resizeTo(width - HELP_WIDTH.step); }
        }}
        className="absolute inset-y-0 left-0 hidden w-2 -translate-x-1 cursor-col-resize focus-visible:bg-accent/40 focus-visible:outline-none min-[600px]:block"
      />
      <div className="flex min-h-14 items-center gap-2 border-b border-hairline/40 px-5">
        <HelpCircle size={18} aria-hidden className="shrink-0 text-accent" />
        <h2 ref={headingRef} tabIndex={-1} className="min-w-0 flex-1 truncate text-[15px] font-semibold outline-none">
          {hx("ux.l4a.panel.heading", { title })}
        </h2>
        <button type="button" aria-label={hx("ux.l4a.panel.close")} onClick={onClose}
          className="flex size-11 items-center justify-center rounded-lg text-ink-secondary hover:bg-app focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border">
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <HelpTips entry={entry} params={params} />
        {askSlot ?? (noEngine && (
          <section className="flex items-center gap-3 border-b border-hairline/40 px-5 py-4">
            <p className="min-w-0 flex-1 text-[14px] leading-5 text-ink">{hx("ux.l4a.panel.noEngine")}</p>
            <button type="button" onClick={onOpenEngines} className="min-h-11 shrink-0 rounded-lg bg-accent px-4 text-[14px] font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border">
              {hx("ux.l4a.panel.openEngines")}
            </button>
          </section>
        ))}
        <HelpSearch search={search} />
        <nav aria-label={hx("ux.l4a.panel.linksHeading")} className="flex flex-wrap gap-x-4 border-b border-hairline/40 px-5 py-2">
          <button type="button" className={linkButton} onClick={openKeyboardShortcuts}>{hx("ux.l4a.panel.shortcuts")}</button>
          <button type="button" className={linkButton} onClick={openWhatsNew}>{hx("ux.l4a.panel.whatsNew")}</button>
          {showHints && <button type="button" className={linkButton} onClick={showHints}>{hx("ux.l4a.panel.showHints")}</button>}
        </nav>
        <section className="px-5 py-4" data-help-feedback>
          {feedbackOpen ? (
            <FeedbackForm envelope={envelope} surface={surface} onCancel={() => setFeedbackOpen(false)} onAskBot={onAskBot} send={sendFeedback} />
          ) : (
            <button type="button" onClick={() => setFeedbackOpen(true)}
              className="min-h-11 w-full rounded-lg border border-hairline/60 px-4 text-left text-[14px] font-medium text-ink hover:bg-app focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border">
              {hx("ux.l4a.feedback.open")}
            </button>
          )}
        </section>
      </div>
    </aside>
  );
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
  const { state, dispatch } = useStore();
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

  // The keys go through the one window listener above (dispatchHelpKey).
  const openNow = useRef(open);
  openNow.current = open;
  useEffect(() => setHelpKeyHandler({ isOpen: () => openNow.current, open: openPanel, close }), [openPanel, close]);

  const group = state.groups.find((g) => g.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);
  const screen = resolveHelpScreen({
    activeView: state.activeView,
    bot: bot ? { id: bot.id, name: bot.name } : null,
    group: group ? { id: group.id, name: group.name } : null,
    settingsPage: state.appSettingsOpen ? resolveSettingsSection(state.appSettingsSection).section : null,
    botSettingsOpen: state.settingsOpen,
    pluginsOpen: state.pluginsOpen,
    computerOpen: state.computerOpen,
    inspectorOpen: state.inspectorOpen,
    noEngines,
    enginesOff,
    connected: state.connected,
    firstRun,
  });
  const params = { ...screen.params, mod: modWord(shortcutPlatformIsMac()) };
  const title = screen.entry ? hx(screen.entry.title, params) : hx("ux.l4a.panel.label");

  // "Ask your bot": the bot on screen, else the Chief of Staff, else the first
  // bot; its chat, with the composer focused. The panel closes so the chat is
  // what the owner sees, on a phone above all.
  const askBot = useCallback(() => {
    const visible = state.bots.filter((b) => !b.hidden);
    const target = (state.activeView === "chat" && !group ? bot : undefined) ?? visible.find((b) => botRole(b) === "chief") ?? visible[0];
    if (state.appSettingsOpen) dispatch({ type: "toggleAppSettings", open: false });
    if (state.settingsOpen) dispatch({ type: "toggleSettings", open: false });
    if (state.pluginsOpen) dispatch({ type: "togglePlugins", open: false });
    if (target) dispatch({ type: "select", id: target.id });
    setOpen(false);
    returnTo.current = null;
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-composer] textarea")?.focus());
  }, [bot, dispatch, group, state.activeView, state.appSettingsOpen, state.bots, state.pluginsOpen, state.settingsOpen]);

  const entry = !open ? <HelpLauncher onOpen={openPanel} /> : (
    <HelpPanel
      entry={screen.entry}
      params={params}
      title={title}
      envelope={envelopeForScreen(screen, hx)}
      surface={surface}
      noEngine={noEngines}
      onClose={close}
      onOpenEngines={() => dispatch({ type: "toggleAppSettings", open: true, section: "engines" })}
      onAskBot={askBot}
      askSlot={askSlot}
    />
  );
  // Inside an open modal window, the tab and the panel are drawn in it, so both can be clicked and tapped.
  return modalWindow ? createPortal(entry, modalWindow) : entry;
}
