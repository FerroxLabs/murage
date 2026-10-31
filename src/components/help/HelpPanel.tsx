// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The "?" help panel (UX overhaul slice 4, lane L4A; Phase 2 spec 2.11 and 3).
// Loaded on first use by HelpHost.tsx, which holds the tab, the keys and the
// modal-window watch.
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
import { HelpCircle, X } from "lucide-react";
import { api, useStore } from "@/state/store";
import { openKeyboardShortcuts, openWhatsNew } from "@/lib/app-events";
import type { HelpResult } from "../../../shared/help-search";
import { feedbackEnvelopeForScreen, resolveHelpScreen, type FeedbackSurface, type HelpScreenInput, type ScreenEnvelope } from "@/lib/screen-envelope";
import { resolveSettingsSection } from "@/lib/settings-pages";
import { shortcutPlatformIsMac } from "@/lib/mod-shortcut";
import { botRole } from "@/lib/bot-role";
import type { ScreenIndexEntry } from "@/lib/screens-index";
import { FeedbackForm, type SendFeedback } from "./FeedbackForm";
import { HelpTips } from "./HelpTips";
import { hx, modWord } from "./help-copy";
import { useHintsReset } from "./HelpHost";

// The always-loaded part, named here too so callers and tests have one place.
export {
  dispatchHelpKey, HELP_LAYER, HelpHost, helpKeyAction, HelpLauncher, installHelpKeys, isTypingTarget, openModalWindow,
  registerHintsReset, setHelpKeyHandler, watchModalWindow,
  type HelpHostProps, type HelpKeyAction, type HelpKeyEvent, type HelpKeyHandler,
} from "./HelpHost";

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
  /** What the feedback form sends about this screen: feedbackEnvelopeForScreen(), fixed tables only. */
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

// ── the open panel, for HelpHost ─────────────────────────────────────────

export interface HelpOpenProps {
  surface: FeedbackSurface;
  noEngines: boolean;
  enginesOff: boolean;
  firstRun: HelpScreenInput["firstRun"];
  askSlot?: ReactNode;
  onClose: () => void;
  /** Closes without taking focus back (Ask your bot focuses the composer). */
  onDismiss: () => void;
}

export function HelpOpen({ surface, noEngines, enginesOff, firstRun, askSlot, onClose, onDismiss }: HelpOpenProps) {
  const { state, dispatch } = useStore();
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
    onDismiss();
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-composer] textarea")?.focus());
  }, [bot, dispatch, group, state.activeView, state.appSettingsOpen, state.bots, state.pluginsOpen, state.settingsOpen, onDismiss]);

  return (
    <HelpPanel
      entry={screen.entry}
      params={params}
      title={title}
      envelope={feedbackEnvelopeForScreen(screen)}
      surface={surface}
      noEngine={noEngines}
      onClose={onClose}
      onOpenEngines={() => dispatch({ type: "toggleAppSettings", open: true, section: "engines" })}
      onAskBot={askBot}
      askSlot={askSlot}
    />
  );
}
