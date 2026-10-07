import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { useDesktopSurface } from "@/lib/use-surface";
import { SettingsPanel } from "./SettingsPanel";
import { BOT_SETTINGS_SECTIONS, DESKTOP_ONLY_BOT_SETTINGS, LEARNING_BADGE_SECTION, botSettingsSectionLabel, filterBotSettingsSections, type BotSettingsSection } from "./bot-settings-sections";
import { BotSettingsDraftContext, BotSettingsNavigationContext, type BotSettingsDraft } from "./bot-settings-drafts";
import { returnFocus } from "@/lib/return-focus";
import { badgeLabel, badgeText, useLearningBadge } from "@/lib/learning-counts";

export function BotSettingsDialog({ bot, onClose }: { bot: Bot; onClose?: () => void }) {
  const { state, dispatch } = useStore(), dialog = useRef<HTMLDialogElement>(null), content = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [section, setSection] = useState<BotSettingsSection>(state.botSettingsIntent?.section ?? "overview"), [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<Record<string, BotSettingsDraft>>({}), [notice, setNotice] = useState<string | null>(null);
  // "What shapes" and Teams read desktop-only routes; elsewhere they would be
  // empty pages, so the sections are not offered at all.
  const desktop = useDesktopSurface();
  const matches = useMemo(() => filterBotSettingsSections(query).filter(item => desktop || !DESKTOP_ONLY_BOT_SETTINGS.has(item.id)), [query, desktop]);
  const selected = BOT_SETTINGS_SECTIONS.find(item => item.id === section)!;
  // What was learned since the owner last looked: a count on the row, gone once the section is opened.
  const newLearning = useLearningBadge(bot.id, section === LEARNING_BADGE_SECTION);
  const label = (item: typeof selected) => botSettingsSectionLabel(item, bot.name);
  const dirty = Object.entries(drafts).filter(([, state]) => state.dirty), saving = Object.values(drafts).some(state => state.saving);
  const updateDraft = useCallback((key: string, state: BotSettingsDraft | null) => setDrafts(current => {
    if (state && current[key]?.dirty === state.dirty && current[key]?.saving === state.saving) return current;
    if (!state && !current[key]) return current;
    const next = { ...current }; if (state) next[key] = state; else delete next[key]; return next;
  }), []);
  const navigate = (operation: () => void) => {
    if (saving) { setNotice("Wait for the current operation to finish before closing."); return; }
    if (dirty.length && !window.confirm("Discard unsaved changes and close bot settings?")) return;
    operation();
  };
  const close = () => navigate(() => { if (onClose) onClose(); else dispatch({ type: "toggleSettings", open: false }); });
  useEffect(() => {
    const node = dialog.current;
    if (!opener.current && document.activeElement instanceof HTMLElement && !node?.contains(document.activeElement)) opener.current = document.activeElement;
    if (node && !node.open) node.showModal();
    return () => { queueMicrotask(() => {
      if (!node?.isConnected) returnFocus(opener.current);
    }); };
  }, []);
  useEffect(() => { content.current?.querySelector<HTMLElement>("[data-settings-scroll]")?.scrollTo({ top: 0 }); }, [section]);
  // "Add a skill" from anywhere, even with this window already open, lands
  // on Skills (BotSkillsPanel opens its picker and clears the intent). The
  // Edit links in "What shapes" move between sections the same way.
  useEffect(() => { if (state.botSettingsIntent) setSection(state.botSettingsIntent.section); }, [state.botSettingsIntent]);
  useEffect(() => { if (!saving) setNotice(null); }, [saving]);
  // On the desktop, "Open memory" in the Memory section shows the bot's memory
  // in the workspace pane (MemoryLauncher, Sidebar). That pane is behind this
  // modal, so the window closes to let it be seen; unsaved edits still ask.
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const opened = () => closeRef.current();
    window.addEventListener("murage:open-memory", opened);
    return () => window.removeEventListener("murage:open-memory", opened);
  }, []);
  useEffect(() => { if (query && matches.length && !matches.some(item => item.id === section)) setSection(matches[0].id); }, [query, matches, section]);
  // Overlay convention (styles.css): a modal with text fields is pinned to the
  // top of the layout viewport and sized to the VISUAL viewport (--vvh), so the
  // on-screen keyboard shrinks it instead of covering its lower half.
  return <dialog ref={dialog} aria-labelledby="bot-settings-title" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}
    className="fixed inset-x-0 top-0 bottom-auto mx-auto my-0 h-[var(--vvh,100dvh)] max-h-[var(--vvh,100dvh)] w-screen max-w-none overflow-hidden bg-panel p-0 text-ink backdrop:bg-black/60 sm:top-[max(calc((var(--vvh,100dvh)_-_840px)/2),calc(0.04*var(--vvh,100dvh)))] sm:h-[min(840px,calc(0.92*var(--vvh,100dvh)))] sm:max-h-[calc(0.92*var(--vvh,100dvh))] sm:w-[min(1040px,calc(100vw-32px))] sm:rounded-2xl sm:border sm:border-hairline sm:shadow-2xl">
    <div className="flex h-full min-h-0 flex-col">
      {/* Below sm the dialog is the whole screen from its top edge, so the
          title and the Close button start below the status bar. */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline/40 px-4 py-3 max-sm:pt-[calc(0.75rem+var(--inset-top))] sm:px-5">
        <div className="min-w-0"><h1 id="bot-settings-title" className="text-[18px] font-semibold">Bot settings</h1><p className="truncate text-[13px] text-ink-secondary">{bot.name}</p></div>
        <button type="button" aria-label="Close bot settings" onClick={close} className="flex size-10 shrink-0 items-center justify-center rounded-lg hover:bg-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"><X size={18} /></button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav aria-label="Bot settings sections" className="shrink-0 border-b border-hairline/40 p-3 sm:w-[230px] sm:overflow-y-auto sm:border-b-0 sm:border-r">
          {/* On a phone the search and the section choice share one row, so
              a short screen (the keyboard up, or a small phone) keeps its
              height for the settings themselves. */}
          <div className="flex gap-2 sm:block">
          <label htmlFor="bot-settings-search" className="sr-only">Search settings</label>
          <input id="bot-settings-search" autoFocus type="search" value={query} maxLength={100} onChange={event => setQuery(event.target.value)} placeholder="Search settings" className="min-h-10 w-full min-w-0 flex-1 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus sm:min-h-0" />
          <label className="block min-w-0 flex-1 text-[12px] sm:hidden"><span className="sr-only">Section</span><select value={section} onChange={event => setSection(event.target.value as BotSettingsSection)} className="min-h-10 w-full rounded-lg border border-hairline/50 bg-inset px-2 text-[13px]">
            {!matches.some(item => item.id === section) && <option value={section}>{label(selected)}</option>}{matches.map(item => <option key={item.id} value={item.id}>{label(item)}{item.id === LEARNING_BADGE_SECTION && badgeText(newLearning) ? ` (${badgeText(newLearning)})` : ""}</option>)}
          </select></label>
          </div>
          <div className="mt-3 hidden space-y-1 sm:block">{matches.map(item => <button key={item.id} type="button" aria-pressed={section === item.id} onClick={() => setSection(item.id)} className={`min-h-10 w-full rounded-lg px-3 py-2 text-left text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${section === item.id ? "bg-control font-medium text-ink" : "text-ink-secondary hover:bg-inset"}`}>{label(item)}{item.id === LEARNING_BADGE_SECTION && badgeText(newLearning) && <span aria-label={badgeLabel(newLearning) ?? undefined} className="ml-2 rounded-full bg-accent/15 px-1.5 text-[11px] font-medium text-ink">{badgeText(newLearning)}</span>}</button>)}</div>
          {!matches.length && <p className="mt-3 text-[12px] text-ink-secondary">No matching settings sections.</p>}
          {query && <button className="mt-2 min-h-9 text-[12px] text-ink-secondary underline" onClick={() => setQuery("")}>Clear search</button>}
        </nav>
        <div ref={content} className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* The section menu above already shows this name on a phone. */}
          <h2 className="shrink-0 px-5 pt-4 text-[17px] font-medium max-sm:sr-only">{label(selected)}</h2>
          <BotSettingsDraftContext.Provider value={updateDraft}><BotSettingsNavigationContext.Provider value={navigate}><SettingsPanel bot={bot} section={section} embedded /></BotSettingsNavigationContext.Provider></BotSettingsDraftContext.Provider>
        </div>
      </div>
      {/* The standing note gives way on a short screen; a notice or unsaved
          changes are always shown. */}
      <footer className={`shrink-0 border-t border-hairline/40 px-4 py-2 max-sm:pb-[calc(0.5rem+var(--inset-bottom))] text-[12px] text-ink-secondary ${!notice && !dirty.length ? "[@media(max-height:640px)]:hidden" : ""}`}>
        {notice ? <p role="status">{notice}</p> : dirty.length ? <p>Unsaved changes: {dirty.map(([key]) => key).join(", ")}</p> : <p>Most changes save immediately. Fields with a Save button wait for you.</p>}
      </footer>
    </div>
  </dialog>;
}
