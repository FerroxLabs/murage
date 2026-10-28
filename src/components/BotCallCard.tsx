// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bot call's card in the conversation (design BOT-CALLS-109 rev 4.2, sections 3 and 8). The server writes the words
// (server/bot-calls-card.ts) and rewrites the row in place; this adds the buttons: Call back / Call me now start an ordinary
// owner call with the bot, "Don't call me about this again" posts never-again, and "Why I called" reads the receipt
// (GET /api/calls/:id). A waiting card ("Scout needs you") reports /seen once it has been on screen, in a focused window,
// for seenAfterMs (design 4.5).
import { useEffect, useRef, useState } from "react";
import { PhoneCall } from "lucide-react";

import { api, type Bot, type Message } from "@/state/store";
import { startCall } from "@/lib/call";
import { BOT_CALL_WORDS, cardActions, receiptLines, type CallView } from "@/lib/bot-calls";
import { CALL_PROTOCOL } from "../../shared/bot-calls-contract";

const button = "min-h-9 rounded-lg border border-hairline/50 bg-control px-3 text-[12.5px] text-ink hover:bg-raised disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function BotCallCard({ bot, message }: { bot: Bot; message: Message }) {
  const mark = message.botCall!;
  const [why, setWhy] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [never, setNever] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const actions = cardActions(mark).filter((a) => !(a === "neverAgain" && never));

  // /seen: the card on screen, the window focused and visible, for seenAfterMs without a break (only a waiting card is
  // owed a seen). The dwell restarts whenever any of the three comes back, so a card read after refocusing still counts.
  useEffect(() => {
    const el = ref.current;
    if (mark.state !== "waiting" || !el || typeof IntersectionObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onScreen = false;
    let sent = false;
    const watching = () => onScreen && document.visibilityState === "visible" && document.hasFocus();
    const restart = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (sent || !watching()) return;
      timer = setTimeout(() => {
        if (sent || !watching()) return;
        sent = true;
        void api(`/api/calls/${mark.intentId}/seen`, { method: "POST", body: "{}" }).catch(() => { sent = false; });
      }, CALL_PROTOCOL.seenAfterMs);
    };
    const observer = new IntersectionObserver(([entry]) => { onScreen = entry?.isIntersecting === true; restart(); }, { threshold: 0.6 });
    observer.observe(el);
    window.addEventListener("focus", restart);
    window.addEventListener("blur", restart);
    document.addEventListener("visibilitychange", restart);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener("focus", restart);
      window.removeEventListener("blur", restart);
      document.removeEventListener("visibilitychange", restart);
    };
  }, [mark.intentId, mark.state]);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setNote("");
    try { await fn(); } catch { setNote(BOT_CALL_WORDS.failed); } finally { setBusy(false); }
  };
  const onAction = (action: ReturnType<typeof cardActions>[number]) => {
    if (action === "callBack" || action === "callMeNow") { startCall(bot.id); return; }
    if (action === "neverAgain") {
      void run(async () => { await api(`/api/calls/${mark.intentId}/never-again`, { method: "POST", body: "{}" }); setNever(true); });
      return;
    }
    if (why) { setWhy(null); return; }
    void run(async () => {
      const view = await api(`/api/calls/${mark.intentId}`) as CallView;
      const lines = receiptLines(view.receipt, view.outcome);
      setWhy(lines.length ? lines : [`${bot.name} followed the rule you set.`]);
    });
  };

  return (
    <div ref={ref} data-testid="bot-call-card" className="w-full max-w-[34rem] rounded-xl border border-hairline/40 bg-card p-3">
      <div className="flex items-start gap-2 text-[13.5px] text-ink">
        <PhoneCall size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-secondary" />
        <div className="min-w-0 whitespace-pre-line">{message.text}</div>
      </div>
      {actions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {actions.map((action) => (
            <button key={action} type="button" disabled={busy} aria-expanded={action === "whyCalled" ? why !== null : undefined} onClick={() => onAction(action)} className={button}>
              {BOT_CALL_WORDS[action]}
            </button>
          ))}
        </div>
      )}
      {never && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{`${bot.name} won't call you about this again.`}</p>}
      {why && (
        <ul aria-label={BOT_CALL_WORDS.whyCalled} className="mt-2 list-disc space-y-0.5 pl-5 text-[12px] text-ink-secondary">
          {why.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      )}
      {note && <p role="alert" className="mt-2 text-[12px] text-danger">{note}</p>}
    </div>
  );
}
