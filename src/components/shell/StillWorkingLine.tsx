// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Still working on this." (UX 1.0.13, lane L2A; mockup Desktop.dc.html chat,
// plan 1.1 Working now). Under the chat header once a running turn has gone
// ten minutes with nothing new on screen: [Stop] (the existing interrupt) and
// [Ask what is taking long] (puts the question in this chat's composer; the
// owner presses Send). Mounted only while the bot is busy, so an idle chat
// runs no timer.
import { useEffect, useState } from "react";
import { askAgainFromLine } from "@/lib/compose-link";
import { t } from "@/lib/i18n";
import { stillWorking, STILL_WORKING_MS } from "@/lib/working-now";
import { useStore, type Bot, type Message } from "@/state/store";

const link = "min-h-11 rounded-lg px-2 text-[13px] font-medium text-accent-text hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

export function StillWorkingLine({ bot, messages }: { bot: Pick<Bot, "id" | "threadId" | "busy" | "activity" | "turnStartedAt">; messages: readonly Pick<Message, "at">[] }) {
  const { dispatch } = useStore();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), Math.min(60_000, STILL_WORKING_MS / 10));
    return () => window.clearInterval(timer);
  }, []);
  const working = bot.activity ? bot.activity === "working" : bot.busy === true;
  const lastRowAt = messages.length ? messages[messages.length - 1]!.at : null;
  if (!stillWorking({ working, since: bot.turnStartedAt ?? null, lastRowAt, now })) return null;
  return (
    <div role="status" data-still-working className="flex flex-wrap items-center gap-2 border-b border-hairline/30 bg-panel px-4 py-1.5 text-[13px] text-ink">
      <span className="min-w-0 flex-1">{t("ux.l2a.still.line")}</span>
      <button type="button" className={link} onClick={() => askAgainFromLine({ text: t("ux.l2a.still.question") }, { botId: bot.id, threadId: bot.threadId })}>
        {t("ux.l2a.still.ask")}
      </button>
      <button type="button" className={link} onClick={() => dispatch({ type: "interrupt", botId: bot.id, threadId: bot.threadId })}>
        {t("ux.l2a.working.stop")}
      </button>
    </div>
  );
}
