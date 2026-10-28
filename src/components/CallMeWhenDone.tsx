// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Call me when this finishes" (design BOT-CALLS-109 4.1; calls-109.yaml turn-end): beside Stop while a bot's turn runs in a
// direct conversation. POST /api/calls/turn-end marks the running turn once (a second tap is the first one's answer).
// While "Calls off for today" holds the harness answers 409 calls_off_today and queues nothing: this offers
// "Turn calls back on" (POST /api/calls/off-today {on:false}) and then asks again.
import { useEffect, useState } from "react";
import { PhoneCall } from "lucide-react";

import { api } from "@/state/store";
import { BOT_CALL_WORDS, isCallsOffToday } from "@/lib/bot-calls";
import { cn } from "@/lib/cn";

type Phase = "idle" | "sending" | "set" | "off_today" | "failed";

export function CallMeWhenDone({ threadId, botName }: { threadId: string; botName: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [refusal, setRefusal] = useState("");
  // a new conversation is a new turn
  useEffect(() => { setPhase("idle"); setRefusal(""); }, [threadId]);

  const mark = async () => {
    await api("/api/calls/turn-end", { method: "POST", body: JSON.stringify({ threadId }) });
    setPhase("set");
  };
  const refuse = (error: unknown) => {
    if (isCallsOffToday(error)) { setPhase("off_today"); return; }
    const code = (error as { body?: { error?: unknown } })?.body?.error;
    setRefusal(code === "calls_off" ? `${botName} can't call you yet. Turn on calls in ${botName}'s settings.`
      : code === "not_running" ? `${botName} has already finished.` : BOT_CALL_WORDS.failed);
    setPhase("failed");
  };
  const onClick = async () => {
    if (phase === "sending" || phase === "set") return;
    setPhase("sending"); setRefusal("");
    try { await mark(); } catch (error) { refuse(error); }
  };
  const turnBackOn = async () => {
    setPhase("sending");
    try {
      await api("/api/calls/off-today", { method: "POST", body: JSON.stringify({ on: false }) });
      await mark();
    } catch (error) { refuse(error); }
  };

  const set = phase === "set";
  return (
    <div className="relative flex items-center">
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={phase === "sending"}
        aria-pressed={set}
        aria-label={set ? BOT_CALL_WORDS.callMeWhenDoneSet : BOT_CALL_WORDS.callMeWhenDone}
        title={set ? BOT_CALL_WORDS.callMeWhenDoneSet : BOT_CALL_WORDS.callMeWhenDone}
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full disabled:opacity-50",
          set ? "bg-accent/10 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink",
        )}
      >
        <PhoneCall size={15} />
      </button>
      {(phase === "off_today" || phase === "failed") && (
        <div role="alert" className="absolute bottom-10 right-0 z-20 w-64 rounded-lg border border-hairline/40 bg-card p-3 text-[12.5px] text-ink shadow-lg">
          <p>{phase === "off_today" ? BOT_CALL_WORDS.offTodayRefusal : refusal}</p>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setPhase("idle")} className="min-h-8 rounded-md px-2 text-ink-secondary hover:bg-raised">Close</button>
            {phase === "off_today" && (
              <button type="button" onClick={() => void turnBackOn()} className="min-h-8 rounded-md bg-control px-2 font-medium hover:bg-raised">
                {BOT_CALL_WORDS.turnBackOn}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
