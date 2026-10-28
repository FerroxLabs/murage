// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Notifications > Calls (design BOT-CALLS-109 rev 4.2, sections 3 and 8): "Calls off for today" and History.
// The switch reads offUntil from GET /api/calls/active and writes POST /api/calls/off-today {on, tz} (this computer's zone,
// so "today" ends at its midnight); it lapses on its own. History pages GET /api/calls/history, newest first, each row
// with the receipt's sentences.
import { useCallback, useEffect, useState } from "react";

import { api, useStore } from "@/state/store";
import { Switch } from "./SettingsPrimitives";
import { BOT_CALL_WORDS, CALL_EVENT, callsOffNow, deviceZone, receiptLines, type ActiveCalls, type CallView } from "@/lib/bot-calls";

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });

/** One History row's headline, in the card's words (design 8). */
function historyLine(item: CallView, botName: string): string {
  const at = clock(item.rangAt ?? item.createdAt);
  switch (item.outcome) {
    case "answered": return `${botName} called you at ${at}`;
    case "missed": case "text_instead": return `${botName} tried to call you at ${at}`;
    case "declined": return `${botName} tried to call you at ${at}. You declined.`;
    case "late": return `${botName} would have called you at ${at}, while Murage wasn't running.`;
    case "texted": case "seen": return `${botName} messaged you at ${at}`;
    case "cancelled": return `${botName}'s call at ${at}. Stopped by you.`;
    case "restored": return `${botName}'s call at ${at}. Ended by a restore.`;
    case "dropped": return `${botName} had a call for you at ${at} that no longer applied.`;
    default: return item.state === "ringing" ? `${botName} is calling` : `${botName} needs you`;
  }
}

export function CallsSettings() {
  const { state } = useStore();
  const [offUntil, setOffUntil] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [items, setItems] = useState<CallView[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const readActive = useCallback(async () => {
    try { const active = await api("/api/calls/active") as ActiveCalls; setOffUntil(active.offUntil ?? null); setLoaded(true); }
    catch { setLoaded(true); }
  }, []);
  const readHistory = useCallback(async (before?: number) => {
    try {
      const page = await api(`/api/calls/history?limit=20${before ? `&before=${before}` : ""}`) as { items?: unknown; next?: unknown } | null;
      // a reply without a list (an older server, a proxy page) is an empty page, never a Settings crash
      const got = Array.isArray(page?.items) ? page.items as CallView[] : [];
      setItems((prev) => before ? [...prev, ...got] : got);
      setNext(typeof page?.next === "number" ? page.next : null);
    } catch { /* History stays as it was */ }
  }, []);
  useEffect(() => {
    void readActive(); void readHistory();
    const onHint = () => { void readActive(); void readHistory(); };
    window.addEventListener(CALL_EVENT, onHint);
    return () => window.removeEventListener(CALL_EVENT, onHint);
  }, [readActive, readHistory]);
  // it lapses at midnight with no hint: re-read then
  useEffect(() => {
    if (!callsOffNow(offUntil, Date.now())) return;
    const timer = setTimeout(() => void readActive(), Math.min(offUntil! - Date.now() + 500, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [offUntil, readActive]);

  const off = callsOffNow(offUntil, Date.now());
  const toggle = async () => {
    if (saving) return;
    setSaving(true); setError("");
    try {
      const zone = deviceZone();
      const r = await api("/api/calls/off-today", { method: "POST", body: JSON.stringify({ on: !off, ...(zone ? { tz: zone } : {}) }) }) as { offUntil: number | null };
      setOffUntil(r.offUntil);
    } catch { setError(BOT_CALL_WORDS.failed); } finally { setSaving(false); }
  };
  const nameOf = (botId: string) => state.bots.find((b) => b.id === botId)?.name ?? "Your bot";

  return (
    <section aria-labelledby="calls-settings-title" className="rounded-xl border border-hairline/40 bg-card p-4">
      <h3 id="calls-settings-title" className="text-[15px] font-medium text-ink">Calls</h3>
      <div className="mt-3 flex min-h-11 items-start justify-between gap-3 py-1.5 text-[13px] text-ink">
        <span id="calls-off-today">{BOT_CALL_WORDS.offToday}
          <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-secondary">
            {off ? BOT_CALL_WORDS.offTodayOn(clock(offUntil!)) : BOT_CALL_WORDS.offTodayHelp}
          </span>
        </span>
        <Switch aria-labelledby="calls-off-today" checked={off} disabled={!loaded || saving} onClick={() => void toggle()} className={focus} />
      </div>
      {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
      <h4 className="mt-4 text-[13px] font-medium text-ink">{BOT_CALL_WORDS.history}</h4>
      {items.length === 0 ? <p className="mt-1 text-[12px] text-ink-secondary">{BOT_CALL_WORDS.historyEmpty}</p> : (
        <ul className="mt-2 divide-y divide-hairline/30">
          {items.map((item) => {
            const lines = receiptLines(item.receipt, item.outcome);
            const expanded = open === item.intentId;
            return (
              <li key={item.intentId} className="py-2 text-[12.5px] text-ink">
                <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : item.intentId)} className={"w-full text-left " + focus}>
                  <span className="text-ink-secondary">{day(item.createdAt)}</span> {historyLine(item, nameOf(item.botId))}
                </button>
                {expanded && (lines.length ? (
                  <ul className="mt-1 list-disc pl-5 text-[12px] text-ink-secondary">{lines.map((line, i) => <li key={i}>{line}</li>)}</ul>
                ) : <p className="mt-1 text-[12px] text-ink-secondary">It followed the rule you set.</p>)}
              </li>
            );
          })}
        </ul>
      )}
      {next !== null && (
        <button type="button" onClick={() => void readHistory(next)} className={"mt-2 min-h-9 rounded-lg bg-control px-3 text-[12.5px] text-ink " + focus}>Show more</button>
      )}
    </section>
  );
}
