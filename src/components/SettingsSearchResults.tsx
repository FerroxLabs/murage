// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the Settings search box shows (the approved mockup, Search): every card
// and row the query finds, never pages, as "Show tool calls in the
// conversation" over "Bots > Advanced". A plain switch changes right in the
// results; anything else is "Open": the page, Advanced first if it lives
// there, scrolled to and highlighted (SettingsModal.tsx owns the opening).
import { useMemo, useState, type ReactNode } from "react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { analyticsEnabled, setAnalyticsEnabled } from "@/lib/analytics";
import { askBotTarget, askYourBot } from "@/lib/health-actions";
import { DISCARD_SETTINGS_CHANGES, settingsDrafts } from "@/lib/settings-drafts";
import { openHelp } from "./help/HelpHost";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { inNativeShell } from "@/lib/native-shell";
import { t } from "@/lib/i18n";
import type { SettingsCard } from "@/lib/settings-cards";
import { searchSettingsIndex, type SettingsIndexHit } from "@/lib/settings-search";
import { openSettingsAddress } from "@/lib/open-settings-address";
import { useApproveAllSurface } from "./ApproveAll";
import { Switch } from "./SettingsPrimitives";

/** Settings > Bots > Show tool calls: the one saved switch the card and the search result share. */
export function useShowToolCalls() {
  const { state, dispatch } = useStore();
  const enabled = showToolCallsEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { showToolCalls: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the tool-call setting.");
    } finally {
      setSaving(false);
    }
  };
  return { enabled, saving, error, toggle };
}

interface ToggleRow { checked: boolean; busy?: boolean; onToggle: () => void }

/** Split `label` around the first case-insensitive match of `query`, for the <mark>. */
export function markParts(label: string, query: string): [string, string, string] {
  const q = query.trim().toLowerCase();
  const at = q ? label.toLowerCase().indexOf(q) : -1;
  return at < 0 ? [label, "", ""] : [label.slice(0, at), label.slice(at, at + q.length), label.slice(at + q.length)];
}

function ResultLabel({ label, query }: { label: string; query: string }): ReactNode {
  const [before, hit, after] = markParts(label, query);
  return <>{before}{hit && <mark className="bg-transparent font-semibold text-accent-text">{hit}</mark>}{after}</>;
}

/** "Nova > Access > Working folder" without the label itself (the row's first line says it). */
function ResultPath({ hit }: { hit: SettingsIndexHit }) {
  return <div className="text-[12.5px] text-ink-secondary">{hit.path.slice(0, -1).join(" > ")}</div>;
}

/** Approve all's state line, from the server's own eligibility answer (ApproveAll.tsx), never decided here. */
function ApproveAllWhere() {
  const [surface] = useApproveAllSurface();
  return <div className="text-[12.5px] text-ink-secondary">{surface.show ? t("settings.search.approveAll.on") : t("settings.search.approveAll.off")}</div>;
}

const rowClass = "flex min-h-11 w-full items-center justify-between gap-4 rounded-xl border border-hairline/40 bg-card px-4 py-3 text-left";
const keyOf = (hit: SettingsIndexHit) => (hit.bot ? `${hit.entry.id}@${hit.bot.id}` : hit.entry.id);

/** SETTINGS-LOCKED-1019 section 6: one search over the app's cards, every bot's rows and the Approve all entry. Every
 *  Open goes by the entry's existing anchor (app card anchor, `bot-setting-*` row, Needs you tab), so a later layout
 *  change keeps every result working. 12 rows, then "More results (N)" expands in place. */
export function SettingsSearchResults({ query, desktop, onOpen, onLeave }: { query: string; desktop: boolean | undefined; onOpen: (card: SettingsCard) => void; onLeave?: () => void }) {
  const { state, dispatch } = useStore();
  const toolCalls = useShowToolCalls();
  const [analytics, setAnalytics] = useState(analyticsEnabled);
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const bots = useMemo(() => {
    const visible = state.bots.filter((bot) => !bot.hidden);
    const chief = askBotTarget(visible);
    return (chief ? [chief, ...visible.filter((bot) => bot.id !== chief.id)] : visible).map((bot) => ({ id: bot.id, name: bot.name }));
  }, [state.bots]);
  const found = useMemo(() => searchSettingsIndex(query, { desktop, bots }), [query, desktop, bots]);
  const expanded = expandedFor === query;
  const hits = expanded ? [...found.hits, ...found.more] : found.hits;
  const leaveFor = (go: () => void) => {
    if (settingsDrafts.anyUnsaved() && !window.confirm(DISCARD_SETTINGS_CHANGES)) return;
    settingsDrafts.clear();
    go();
  };
  const open = (hit: SettingsIndexHit) => {
    const entry = hit.entry;
    if (entry.scope === "app") { onOpen(entry.card); onLeave?.(); return; }
    if (entry.scope === "explainer") { leaveFor(() => { dispatch(entry.open); onLeave?.(); }); return; }
    const name = entry.id.slice(`bot.${entry.section}.`.length);
    const opened = openSettingsAddress({ scope: "bot", botId: hit.bot?.id ?? null, section: entry.section, name }, { botIds: state.bots.map((bot) => bot.id), selectedBotId: state.selectedId }, dispatch);
    if (opened) onLeave?.();
  };
  const toggles: Readonly<Record<string, ToggleRow | undefined>> = {
    "botDefaults.tool-calls": { checked: toolCalls.enabled, busy: toolCalls.saving, onToggle: () => void toolCalls.toggle() },
    // The phone apps never send usage analytics and show no switch for it, so their results do not either.
    ...(inNativeShell() ? {} : { "general.analytics": { checked: analytics, onToggle: () => { const next = !analytics; setAnalyticsEnabled(next); setAnalytics(next); } } }),
  };

  return (
    <>
    {/* One live line that only says the count (zero too), so a screen reader hears what typing found without leaving
        the box, and hears nothing new while the count stays the same. */}
    <p role="status" data-settings-result-count className="sr-only">{t("ux.l8.results.count", { count: String(hits.length) })}</p>
    {hits.length === 0 ? <SettingsNoResults query={query.trim()} /> : <ul aria-label={t("settings.l1.resultsFor", { query: query.trim() })} className="flex flex-col gap-2.5">
      {hits.map((hit) => {
        const toggle = hit.entry.scope === "app" ? toggles[hit.entry.id] : undefined;
        const label = <div className="text-[14.5px] text-ink"><ResultLabel label={hit.label} query={query} /></div>;
        const where = <>{label}<ResultPath hit={hit} />{hit.entry.scope === "explainer" && <ApproveAllWhere />}</>;
        return (
          <li key={keyOf(hit)}>
            {toggle ? (
              <div className={rowClass}>
                <div className="min-w-0">{where}</div>
                <Switch checked={toggle.checked} disabled={toggle.busy} aria-label={hit.label} onClick={toggle.onToggle} />
              </div>
            ) : (
              <button type="button" data-settings-result={hit.entry.id} data-settings-result-bot={hit.bot?.id} onClick={() => open(hit)} className={`${rowClass} hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}>
                <div className="min-w-0">{where}</div>
                <span className="shrink-0 text-[12.5px] text-ink-secondary">{t("settings.l1.open")}</span>
              </button>
            )}
          </li>
        );
      })}
      {!expanded && found.more.length > 0 && (
        <li>
          <button type="button" data-settings-more-results onClick={() => setExpandedFor(query)} className={`${rowClass} justify-center text-[13px] text-ink-secondary hover:border-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}>
            {t("settings.search.more", { count: String(found.more.length) })}
          </button>
        </li>
      )}
    </ul>}
    </>
  );
}

/** No hits is never a dead end (SETTINGS-UX-1011 section 4, S5): ask the Chief in their chat with the words typed,
 *  or open the help. Both work on any engine. With no bot yet, only the help row shows. */
export function SettingsNoResults({ query }: { query: string }) {
  const { state, dispatch } = useStore();
  const chief = askBotTarget(state.bots);
  const ask = () => {
    // Leaving Settings for the chat asks first when typed words are not saved, the way closing Settings does.
    if (settingsDrafts.anyUnsaved() && !window.confirm(DISCARD_SETTINGS_CHANGES)) return;
    settingsDrafts.clear();
    dispatch({ type: "toggleAppSettings", open: false });
    askYourBot(query, state.bots, (id) => dispatch({ type: "select", id }));
  };
  return (
    <div className="flex flex-col gap-2.5">
      <p className="px-1 text-[13px] text-ink-secondary">{t("ux.l3a.empty.line", { query })}</p>
      <ul aria-label={t("ux.l3a.empty.label")} className="flex flex-col gap-2.5">
        {chief && (
          <li>
            <button type="button" data-settings-ask-chief onClick={ask} className={`${rowClass} hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}>
              <span className="min-w-0 text-[14.5px] text-ink">{t("ux.l3a.empty.ask", { name: chief.name, query })}</span>
              <span className="shrink-0 text-[12.5px] text-ink-secondary">{t("ux.l3a.empty.askAction")}</span>
            </button>
          </li>
        )}
        <li>
          <button type="button" data-settings-open-help onClick={() => openHelp()} className={`${rowClass} hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}>
            <span className="min-w-0 text-[14.5px] text-ink">{t("ux.l3a.empty.help")}</span>
            <span className="shrink-0 text-[12.5px] text-ink-secondary">{t("settings.l1.open")}</span>
          </button>
        </li>
      </ul>
    </div>
  );
}
