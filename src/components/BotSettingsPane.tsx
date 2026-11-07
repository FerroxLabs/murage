// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One bot's settings, hosted inside the Settings window (SETTINGS-UX-1011 S7): the section list, the page and the
// footer. The window (SettingsModal) owns the frame, the title and Close; every way out of a bot's page (Close,
// Escape, another page, another bot) goes through `leaveRef`, so unsaved edits still ask and a save still finishes.
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useStore, type Bot } from "@/state/store";
import { useDesktopSurface } from "@/lib/use-surface";
import { SettingsPanel } from "./SettingsPanel";
import { BOT_SETTINGS_SECTIONS, DESKTOP_ONLY_BOT_SETTINGS, GATED_BOT_SETTINGS, GATED_ROW_MARK, LEARNING_BADGE_SECTION, botSettingsSectionLabel, filterBotSettingsSections, type BotSettingsSection } from "./bot-settings-sections";
import { BotSettingsDraftContext, BotSettingsNavigationContext, type BotSettingsDraft } from "./bot-settings-drafts";
import { revealAnchor, waitForAnchor } from "@/lib/anchor-wait";
import { lastBotSection, rememberBotSection } from "@/lib/last-bot-section";
import { badgeLabel, badgeText, useLearningBadge } from "@/lib/learning-counts";
import { useEmailStatus } from "@/lib/bot-email";
import { BoxBody, BoxFoot } from "./ui/BoxShell";
import { passThrough } from "@/lib/settings-leave";

/** Runs `operation` once the bot's page may be left: asks first when there are unsaved edits, waits while one saves. */
export type BotSettingsLeave = (operation: () => void) => void;

/** The bot header chips: each opens its section with its row highlighted, as a Settings address does. */
export const BOT_HEADER_CHIPS: readonly { id: string; label: string; section: BotSettingsSection; anchor: string }[] = [
  { id: "level", label: "Level", section: "permissions", anchor: "bot-setting-level" },
  { id: "engine", label: "Engine", section: "model", anchor: "bot-setting-model" },
  { id: "apps", label: "Apps", section: "access", anchor: "bot-setting-apps" },
  { id: "folder", label: "Folder", section: "access", anchor: "bot-setting-folder" },
  { id: "email", label: "Email", section: "email", anchor: "bot-setting-email" },
];

export function BotSettingsPane({ bot, onClose, leaveRef }: { bot: Bot; onClose: () => void; leaveRef?: MutableRefObject<BotSettingsLeave | null> }) {
  const { state } = useStore(), content = useRef<HTMLDivElement>(null);
  const desktop = useDesktopSurface();
  // bot email (1.0.9): the Email row is always listed (SETTINGS-UX-1011 S1); while the server does not say email is on,
  // the row is marked "Off" and the section body is the stub that says why and how to turn it on. Checking (EMAIL-CAPS-CACHE-1011: no
  // definitive answer yet) is never off. Opening a bot's settings re-reads the capability (M4); the shared store keeps the last state.
  const emailStatus = useEmailStatus(true);
  const gatedOff = (id: BotSettingsSection) => GATED_BOT_SETTINGS.has(id) && (emailStatus.kind === "off" || emailStatus.kind === "flux-off" || emailStatus.kind === "flux-refused" || emailStatus.kind === "flux-sign-in" || emailStatus.kind === "flux-line");
  // A deep link (intent) wins; otherwise the profile reopens where the person last was.
  const [section, setSection] = useState<BotSettingsSection>(() =>
    state.botSettingsIntent?.section
    ?? lastBotSection(BOT_SETTINGS_SECTIONS.map(item => item.id).filter(id => desktop === true || !DESKTOP_ONLY_BOT_SETTINGS.has(id)), [LEARNING_BADGE_SECTION])
    ?? "overview");
  const [query, setQuery] = useState("");
  const chooseSection = (id: BotSettingsSection) => { setSection(id); rememberBotSection(id); };
  const [drafts, setDrafts] = useState<Record<string, BotSettingsDraft>>({}), [notice, setNotice] = useState<string | null>(null);
  // "What shapes" and Teams read desktop-only routes; elsewhere they would be
  // empty pages, so the sections are not offered at all.
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
  const navigate: BotSettingsLeave = (operation) => {
    if (saving) { setNotice("Wait for the current operation to finish before closing."); return; }
    if (dirty.length && !window.confirm("Discard unsaved changes and close bot settings?")) return;
    // Answered: what the operation dispatches is not asked again by the store's gate (lib/settings-leave.ts).
    passThrough(operation);
  };
  // The window asks this page before it closes or shows another page.
  if (leaveRef) leaveRef.current = navigate;
  useEffect(() => () => { if (leaveRef) leaveRef.current = null; }, [leaveRef]);
  const close = () => navigate(onClose);
  useEffect(() => { content.current?.querySelector<HTMLElement>("[data-settings-scroll]")?.scrollTo({ top: 0 }); }, [section]);
  // "Add a skill" from anywhere, even with this window already open, lands
  // on Skills (BotSkillsPanel opens its picker and clears the intent). The
  // Edit links in "What shapes" move between sections the same way.
  useEffect(() => { if (state.botSettingsIntent) setSection(state.botSettingsIntent.section); }, [state.botSettingsIntent]);
  // A Settings address (lib/settings-address.ts) names a row: once its section has rendered, the row is scrolled to,
  // focused and marked, as a search "Open" does in the app's Settings. A row that never mounts leaves the section's top.
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(() => (state.botSettingsIntent && "anchor" in state.botSettingsIntent ? state.botSettingsIntent.anchor ?? null : null));
  useEffect(() => { const intent = state.botSettingsIntent; if (intent && "anchor" in intent && intent.anchor) setPendingAnchor(intent.anchor); }, [state.botSettingsIntent]);
  useEffect(() => {
    if (!pendingAnchor) return;
    return waitForAnchor({
      find: () => content.current?.querySelector<HTMLElement>(`#${CSS.escape(pendingAnchor)}`) ?? null,
      onFound: (element) => { setPendingAnchor(null); revealAnchor(element); },
      onGiveUp: () => setPendingAnchor(null),
    });
  }, [pendingAnchor, section]);
  const openChip = (chip: typeof BOT_HEADER_CHIPS[number]) => { setQuery(""); chooseSection(chip.section); setPendingAnchor(chip.anchor); };
  useEffect(() => { if (!saving) setNotice(null); }, [saving]);
  // On the desktop, "Open memory" in the Memory section shows the bot's memory
  // in the workspace pane (MemoryLauncher, Sidebar). That pane is behind this
  // window, so the window closes to let it be seen; unsaved edits still ask.
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const opened = () => closeRef.current();
    window.addEventListener("murage:open-memory", opened);
    return () => window.removeEventListener("murage:open-memory", opened);
  }, []);
  useEffect(() => { if (query && matches.length && !matches.some(item => item.id === section)) setSection(matches[0].id); }, [query, matches, section]);
  return <div data-bot-settings-pane={bot.id} className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
      <nav aria-label="Bot settings sections" className="shrink-0 border-b border-hairline/40 p-3 sm:w-[220px] sm:overflow-y-auto sm:border-b-0 sm:border-r">
        {/* On a phone the search and the section choice share one row, so
            a short screen (the keyboard up, or a small phone) keeps its
            height for the settings themselves. */}
        <div className="flex gap-2 sm:block">
        <label htmlFor="bot-settings-search" className="sr-only">Search settings</label>
        <input id="bot-settings-search" autoFocus type="search" value={query} maxLength={100} onChange={event => setQuery(event.target.value)} placeholder={`Search ${bot.name}'s settings`} className="min-h-10 w-full min-w-0 flex-1 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus sm:min-h-0" />
        <label className="block min-w-0 flex-1 text-[12px] sm:hidden"><span className="sr-only">Section</span><select value={section} onChange={event => chooseSection(event.target.value as BotSettingsSection)} className="min-h-10 w-full rounded-lg border border-hairline/50 bg-inset px-2 text-[13px]">
          {!matches.some(item => item.id === section) && <option value={section}>{label(selected)}{gatedOff(section) ? ` (${GATED_ROW_MARK})` : ""}</option>}{matches.map(item => <option key={item.id} value={item.id}>{label(item)}{item.id === LEARNING_BADGE_SECTION && badgeText(newLearning) ? ` (${badgeText(newLearning)})` : ""}{gatedOff(item.id) ? ` (${GATED_ROW_MARK})` : ""}</option>)}
        </select></label>
        </div>
        <div className="mt-3 hidden space-y-1 sm:block">{matches.map(item => <button key={item.id} type="button" aria-pressed={section === item.id} onClick={() => chooseSection(item.id)} className={`min-h-10 w-full rounded-lg px-3 py-2 text-left text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${section === item.id ? "bg-control font-medium text-ink" : "text-ink-secondary hover:bg-inset"}`}>{label(item)}{item.id === LEARNING_BADGE_SECTION && badgeText(newLearning) && <span aria-label={badgeLabel(newLearning) ?? undefined} className="ml-2 rounded-full bg-accent/15 px-1.5 text-[11px] font-medium text-ink">{badgeText(newLearning)}</span>}{gatedOff(item.id) && <span data-gated-row={item.id} className="ml-2 text-[11px] text-ink-secondary">{GATED_ROW_MARK}</span>}</button>)}</div>
        {!matches.length && <p className="mt-3 text-[12px] text-ink-secondary">No matching settings sections.</p>}
        {query && <button className="mt-2 min-h-9 text-[12px] text-ink-secondary underline" onClick={() => setQuery("")}>Clear search</button>}
      </nav>
      {/* The page scrolls one level down, in [data-settings-scroll], under its own section title. */}
      <BoxBody ref={content} className="flex flex-1 flex-col overflow-y-clip">
        <div role="group" aria-label={`Go to one of ${bot.name}'s settings`} data-bot-header-chips className="flex shrink-0 flex-wrap gap-1.5 px-5 pt-3 [html[data-keyboard=open]_&]:hidden">
          {BOT_HEADER_CHIPS.map(chip => <button key={chip.id} type="button" data-bot-header-chip={chip.id} onClick={() => openChip(chip)}
            className="min-h-8 rounded-full border border-hairline/40 bg-raised/60 px-3 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">{chip.label}{chip.section === "email" && gatedOff("email") ? ` (${GATED_ROW_MARK})` : ""}</button>)}
        </div>
        {/* The section menu above already shows this name on a phone. */}
        <h2 className="shrink-0 px-5 pt-3 text-[17px] font-medium max-sm:sr-only">{label(selected)}</h2>
        <BotSettingsDraftContext.Provider value={updateDraft}><BotSettingsNavigationContext.Provider value={navigate}><SettingsPanel bot={bot} section={section} embedded /></BotSettingsNavigationContext.Provider></BotSettingsDraftContext.Provider>
      </BoxBody>
    </div>
    {/* The standing note gives way on a short screen; a notice or unsaved
        changes are always shown. The window pads the phone's home indicator. */}
    <BoxFoot className={`block border-t border-hairline/40 px-4 py-2 text-[12px] text-ink-secondary ${!notice && !dirty.length ? "[@media(max-height:640px)]:hidden [html[data-keyboard=open]_&]:hidden" : ""}`}>
      {notice ? <p role="status">{notice}</p> : dirty.length ? <p>Unsaved changes: {dirty.map(([key]) => key).join(", ")}</p> : <p>Most changes save immediately. Fields with a Save button wait for you.</p>}
    </BoxFoot>
  </div>;
}

export default BotSettingsPane;
