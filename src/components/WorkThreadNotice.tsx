// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The strip under a work thread's header (SPEC-X 13.2): which team the work
// is for and what the bot follows here, and once sharing with that team has
// stopped, that the conversation is kept for reading (the composer is
// locked with the same line).
import { Users } from "lucide-react";
import { cn } from "@/lib/cn";
import { activeWorkThread, closedComposerLine, workThreadHeader } from "@/lib/shared-teams";
import type { Bot } from "@/state/store";

export function WorkThreadNotice({ bot }: { bot: Pick<Bot, "name" | "threadId" | "tasks"> }) {
  const work = activeWorkThread(bot);
  if (!work) return null;
  const closed = closedComposerLine(bot);
  return (
    <div data-work-thread-notice className={cn("flex shrink-0 items-start gap-2 border-b border-hairline/40 px-4 py-2 text-[12.5px]", closed ? "bg-warning/10 text-ink" : "bg-panel text-ink-secondary")} role={closed ? "status" : undefined}>
      <Users size={14} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p>{workThreadHeader(bot.name, work.teamName)}</p>
        {closed && <p className="mt-0.5 font-medium">{closed}</p>}
      </div>
    </div>
  );
}
