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
import { searchSettingsCards, type SettingsSearchHit } from "@/lib/settings-search";
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

function ResultPath({ hit }: { hit: SettingsSearchHit }) {
  return <div className="text-[12.5px] text-ink-secondary">{hit.page}{hit.advanced ? ` › ${t("settings.l1.advancedPath")}` : ""}</div>;
}

const rowClass = "flex min-h-11 w-full items-center justify-between gap-4 rounded-xl border border-hairline/40 bg-card px-4 py-3 text-left";

export function SettingsSearchResults({ query, desktop, onOpen }: { query: string; desktop: boolean | undefined; onOpen: (card: SettingsCard) => void }) {
  const toolCalls = useShowToolCalls();
  const [analytics, setAnalytics] = useState(analyticsEnabled);
  const hits = useMemo(() => searchSettingsCards(query, desktop), [query, desktop]);
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
        const toggle = toggles[hit.card.id];
        const label = <div className="text-[14.5px] text-ink"><ResultLabel label={hit.label} query={query} /></div>;
        return (
          <li key={hit.card.id}>
            {toggle ? (
              <div className={rowClass}>
                <div className="min-w-0">{label}<ResultPath hit={hit} /></div>
                <Switch checked={toggle.checked} disabled={toggle.busy} aria-label={hit.label} onClick={toggle.onToggle} />
              </div>
            ) : (
              <button type="button" data-settings-result={hit.card.id} onClick={() => onOpen(hit.card)} className={`${rowClass} hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}>
                <div className="min-w-0">{label}<ResultPath hit={hit} /></div>
                <span className="shrink-0 text-[12.5px] text-ink-secondary">{t("settings.l1.open")}</span>
              </button>
            )}
          </li>
        );
      })}
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
