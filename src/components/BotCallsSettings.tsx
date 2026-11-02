// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot settings > Voice & alerts > Calls (design BOT-CALLS-109 rev 4.2, sections 3 and 8; MurageMain 11-02,
// BOT-CALLS-UNREACHABLE). "<Bot> can call me" (off until the owner turns it on) and its urgent rule, "When <Bot> thinks
// you're needed now" (needs_owner_now, Tier B: always a message first, one ring after 10 unseen minutes; no Emergency
// switch, design 4.6). Reads GET /api/bots/:id/calls/rules; writes PUT /api/bots/:id/calls/rules with { enabled } and
// { neededNow }, never the whole rule list, so a "Call me when this finishes" mark made meanwhile is never lost. Turning
// the switch on with no urgent rule yet makes it on, in the same request. Quiet hours are shown read-only; they stay
// the owner's one setting in Notifications.
import { useCallback, useEffect, useState } from "react";

import { api } from "@/state/store";
import { Switch } from "./SettingsPrimitives";
import { BOT_CALL_WORDS, CALL_EVENT, neededNowOn, quietLine, switchBody, type BotCallRulesView } from "@/lib/bot-calls";

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function BotCallsSettings({ botId, botName }: { botId: string; botName: string }) {
  const [view, setView] = useState<BotCallRulesView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const read = useCallback(async () => {
    try { setView(await api(`/api/bots/${encodeURIComponent(botId)}/calls/rules`) as BotCallRulesView); } catch { /* stays as it was */ }
  }, [botId]);
  useEffect(() => {
    setView(null); setError("");
    void read();
    const onHint = () => { void read(); };
    window.addEventListener(CALL_EVENT, onHint);
    return () => window.removeEventListener(CALL_EVENT, onHint);
  }, [read]);

  const put = async (body: object) => {
    if (saving) return;
    setSaving(true); setError("");
    try {
      setView(await api(`/api/bots/${encodeURIComponent(botId)}/calls/rules`, { method: "PUT", body: JSON.stringify(body) }) as BotCallRulesView);
    } catch (e) {
      const code = (e as { body?: { error?: unknown } })?.body?.error;
      setError(code === "no_voice" ? BOT_CALL_WORDS.needsVoice : BOT_CALL_WORDS.failed);
      void read();
    } finally { setSaving(false); }
  };
  const rearm = async () => {
    if (saving || !view?.restoreGen) return;
    setSaving(true); setError("");
    try { await api("/api/calls/rearm", { method: "POST", body: JSON.stringify({ restoreGen: view.restoreGen }) }); }
    catch { setError(BOT_CALL_WORDS.failed); }
    finally { setSaving(false); void read(); }
  };

  const on = view?.enabled === true;
  const urgent = neededNowOn(view?.rules);
  // design 3: no voice source, the switch is disabled (it can still be turned off)
  const noVoice = view !== null && !view.voice;
  return (
    <section id="bot-setting-calls" data-setting="bot.voice.calls" aria-labelledby={`bot-calls-${botId}`} className="rounded-xl bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div id={`bot-calls-${botId}`} className="text-[15px] font-medium text-ink">{BOT_CALL_WORDS.canCallMe(botName)}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">{noVoice && !on ? BOT_CALL_WORDS.needsVoice : BOT_CALL_WORDS.canCallMeHelp(botName)}</div>
        </div>
        <Switch
          checked={on}
          aria-labelledby={`bot-calls-${botId}`}
          disabled={view === null || saving || (noVoice && !on)}
          onClick={() => void put(switchBody(!on, view?.rules))}
          className={focus}
        />
      </div>
      {on && (
        <>
          <div className="mt-3 flex items-start justify-between gap-4 border-t border-hairline/30 pt-3">
            <div>
              <div id={`bot-calls-urgent-${botId}`} className="text-[13px] text-ink">{BOT_CALL_WORDS.neededNow(botName)}</div>
              <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{BOT_CALL_WORDS.tierBHelp}</div>
            </div>
            <Switch
              checked={urgent}
              aria-labelledby={`bot-calls-urgent-${botId}`}
              disabled={saving}
              onClick={() => void put({ neededNow: !urgent })}
              className={focus}
            />
          </div>
          <p className="mt-3 text-[12px] text-ink-secondary">{BOT_CALL_WORDS.botCaps}</p>
          <p className="mt-1 text-[12px] text-ink-secondary">{quietLine(view?.quietHours ?? null)}. Change in Notifications.</p>
          {view?.held && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-raised p-2 text-[12.5px] text-ink">
              <span>{BOT_CALL_WORDS.pausedAfterRestore}</span>
              <button type="button" disabled={saving || !view.restoreGen} onClick={() => void rearm()} className={"min-h-8 rounded-md bg-control px-2 font-medium hover:bg-raised " + focus}>
                {BOT_CALL_WORDS.turnBackOn}
              </button>
            </div>
          )}
        </>
      )}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </section>
  );
}
