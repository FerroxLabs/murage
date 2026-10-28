// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The desktop ring (design BOT-CALLS-109 rev 4.2, section 3 "Ring"): an in-app banner with Answer, Not now, Text me instead
// and "Don't call me about this again" in the overflow. The live stream's kind "call" frames (call.ring, call.answered,
// call.ended) are hints only: each one re-reads GET /api/calls/active, the one source of what is ringing. A hidden window
// gets the closed OS notification ("Murage is calling" / "Answer to hear what it is.") and nothing more.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { MoreHorizontal, Phone, PhoneOff } from "lucide-react";

import { api, useStore } from "@/state/store";
import { startCall, useOnCall } from "@/lib/call";
import { attachAnsweredCall, callSessionOpening, onCallSessionChange } from "@/lib/bot-call-session";
import { BOT_CALL_WORDS, CALL_EVENT, thisCallDevice, type ActiveCalls } from "@/lib/bot-calls";
import { CALL_CLOSED_TEXT, CALL_COPY } from "../../shared/bot-calls-contract";

export function BotCallRing() {
  const { state, dispatch } = useStore();
  const [ringing, setRinging] = useState<ActiveCalls["ringing"]>(null);
  const [note, setNote] = useState("");
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const notified = useRef<string | null>(null);
  // no ring on a call screen that is still opening its session (bot-call-session.ts). The session tells us when it
  // starts opening, gets its id or ends, so a ring already showing hides while an open hangs; a session that opens
  // ends the ring on the server (call.ended hint)
  useOnCall();
  const [, sessionChanged] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onCallSessionChange(sessionChanged), []);
  const ring = ringing && !callSessionOpening() ? ringing : null;

  const refresh = useCallback(async () => {
    try {
      const active = await api("/api/calls/active") as ActiveCalls;
      const live = active.ringing && active.ringing.deadlineAt !== null && active.ringing.deadlineAt > Date.now() ? active.ringing : null;
      setRinging(live);
      if (!live) setMenu(false);
    } catch { /* a phone surface or a locked app: no banner */ }
  }, []);

  useEffect(() => {
    void refresh();
    const onHint = (event: Event) => {
      const detail = (event as CustomEvent<{ type?: string; text?: unknown }>).detail;
      if (detail?.type === "call.answered") setNote(CALL_COPY.answeredElsewhere);
      // the call ended here for a reason the owner should hear (bot-call-session.ts: no session could be opened)
      else if (detail?.type === "call.note" && typeof detail.text === "string") { setNote(detail.text); return; }
      void refresh();
    };
    window.addEventListener(CALL_EVENT, onHint);
    return () => window.removeEventListener(CALL_EVENT, onHint);
  }, [refresh]);

  // the ring lasts until its deadline; then the banner goes without waiting for a hint
  useEffect(() => {
    if (!ringing?.deadlineAt) return;
    const timer = setTimeout(() => void refresh(), Math.max(0, ringing.deadlineAt - Date.now()) + 250);
    return () => clearTimeout(timer);
  }, [ringing?.intentId, ringing?.deadlineAt, refresh]);

  // a hidden window: the closed OS notification, once per ring
  useEffect(() => {
    if (!ring || notified.current === ring.intentId) return;
    notified.current = ring.intentId;
    setNote("");
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        const shown = new Notification(CALL_CLOSED_TEXT.ring.title, { body: CALL_CLOSED_TEXT.ring.body, tag: `call-${ring.intentId}` });
        shown.onclick = () => { window.focus(); shown.close(); };
      }
    } catch { /* no notifications on this surface */ }
  }, [ring]);

  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(""), 6000); return () => clearTimeout(t); }, [note]);

  if (!ring && !note) return null;
  const botName = ring?.botName ?? state.bots.find((b) => b.id === ring?.botId)?.name ?? "Your bot";

  const act = async (action: "answer" | "decline" | "text-instead" | "never-again") => {
    if (!ring || busy) return;
    const { intentId, botId, threadId } = ring;
    setBusy(true); setMenu(false);
    try {
      if (action === "answer") {
        const device = thisCallDevice();
        const r = await api(`/api/calls/${intentId}/answer`, { method: "POST", body: JSON.stringify({ device }) }) as { callId: string; threadId: string };
        dispatch({ type: "select", id: botId, threadId: r.threadId ?? threadId });
        // the call screen holds the answer's session (bot-call-session.ts): channel, call id, opener first, one end
        attachAnsweredCall({ intentId, callId: r.callId, botId, device });
        startCall(botId);
      } else {
        // never-again cancels the rule's open intents, the ringing one included (design 3)
        await api(`/api/calls/${intentId}/${action}`, { method: "POST", body: "{}" });
      }
      setRinging(null);
    } catch (error) {
      const code = (error as { body?: { error?: unknown } })?.body?.error;
      setNote(code === "answered_elsewhere" ? CALL_COPY.answeredElsewhere : BOT_CALL_WORDS.failed);
      void refresh();
    } finally { setBusy(false); }
  };

  return (
    <div role={ring ? "alertdialog" : "status"} aria-label={ring ? BOT_CALL_WORDS.ringing(botName) : undefined}
      className="fixed left-1/2 top-3 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-2xl border border-hairline/40 bg-card px-3 py-2 text-[13px] text-ink shadow-xl">
      {ring ? (
        <>
          <Phone size={16} aria-hidden="true" className="shrink-0 animate-pulse text-accent" />
          <span className="min-w-0 truncate font-medium">{BOT_CALL_WORDS.ringing(botName)}</span>
          <button type="button" disabled={busy} onClick={() => void act("answer")} className="min-h-9 rounded-lg bg-accent px-3 font-medium text-white disabled:opacity-50">{BOT_CALL_WORDS.answer}</button>
          <button type="button" disabled={busy} onClick={() => void act("decline")} className="flex min-h-9 items-center gap-1 rounded-lg bg-control px-3 disabled:opacity-50">
            <PhoneOff size={14} aria-hidden="true" />{BOT_CALL_WORDS.notNow}
          </button>
          <button type="button" disabled={busy} onClick={() => void act("text-instead")} className="min-h-9 rounded-lg bg-control px-3 disabled:opacity-50">{BOT_CALL_WORDS.textInstead}</button>
          <div className="relative">
            <button type="button" aria-label="More" aria-expanded={menu} onClick={() => setMenu(!menu)} className="flex size-9 items-center justify-center rounded-lg hover:bg-raised"><MoreHorizontal size={16} /></button>
            {menu && (
              <button type="button" disabled={busy} onClick={() => void act("never-again")}
                className="absolute right-0 top-10 w-64 rounded-lg border border-hairline/40 bg-card px-3 py-2 text-left shadow-lg hover:bg-raised">
                {BOT_CALL_WORDS.neverAgain}
              </button>
            )}
          </div>
        </>
      ) : <span>{note}</span>}
    </div>
  );
}
