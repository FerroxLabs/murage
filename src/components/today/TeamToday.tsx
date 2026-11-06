// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Detailed only (Today slice 1.0.18, designs/TODAY-SLICE-1104.md section 2b D4 and D2), loaded lazily so Calm's first
// paint never carries it.
//   TeamToday     "Your team today": one row per visible bot (two columns on the desktop, one on the phone): its
//                 state, last run (or last active) and next run. Replaces the team chips in Detailed.
//   DoneDetailed  Done today with every run today and the detail line "{bot} · {time} · took {dur} · {cost} · runs
//                 on {engine}"; the engine is the bot's engine now, never claimed as the run's.
import type { ReactNode } from "react";
import type { LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { Routine, RoutineRun } from "@/lib/routines";
import type { DoneRow } from "@/lib/today-model";
import { botLines, doneMeta, type BotLine, type BotState } from "@/lib/today-detail";
import type { Bot, InstanceInfo } from "@/state/store";
import { DoneTodayCard, TodayCard } from "./TodayCards";
import { say, whenLabel } from "./say";

const STATE_KEY: Record<BotState, LocaleKey> = {
  working: "ux.l2a.today.bot.working", waiting: "ux.l2a.today.bot.waiting", ready: "ux.l2a.today.bot.ready",
  noSignal: "ux.l2a.today.bot.noSignal", stopped: "ux.l2a.today.bot.stopped",
};
const DOT: Record<BotState, string> = { working: "bg-success", waiting: "bg-accent", ready: "bg-ink-secondary/40", noSignal: "bg-warning", stopped: "bg-danger" };

function lastWords(line: BotLine, now: number): string {
  if (!line.last) return t("ux.l2a.today.bot.never");
  return t(line.last.kind === "run" ? "ux.l2a.today.bot.last" : "ux.l2a.today.bot.lastActive", { when: whenLabel(line.last.at, now) });
}

export function TeamToday({ bots, routines, runs, now, onOpen, onHire, children }: {
  bots: readonly Bot[]; routines: readonly Routine[]; runs: readonly RoutineRun[]; now: number;
  onOpen: (botId: string) => void; onHire: () => void; children?: ReactNode;
}) {
  const lines = botLines(bots, routines, runs, now);
  return (
    <TodayCard id="today-team" title={t("ux.l2a.today.bots.title")}>
      {children}
      <ul data-today="team-today" className="grid gap-1 md:grid-cols-2">
        {lines.map((line) => (
          <li key={line.botId}>
            <button type="button" onClick={() => onOpen(line.botId)} data-bot-state={line.state}
              className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
              <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", DOT[line.state])} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-ink">{line.name} <span className="text-ink-secondary">· {t(STATE_KEY[line.state])}</span></span>
                <span className="block truncate text-[13px] text-ink-secondary">
                  {lastWords(line, now)} · {line.next !== null ? t("ux.l2a.today.bot.next", { when: whenLabel(line.next, now) }) : t("ux.l2a.today.bot.noNext")}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex justify-end px-2 pt-1">
        <button type="button" onClick={onHire} className="min-h-11 shrink-0 rounded-lg border border-hairline/50 px-3 text-[13px] font-medium text-ink hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">{t("ux.l2a.today.hire")}</button>
      </div>
    </TodayCard>
  );
}

export function DoneDetailed({ rows, runs, bots, instances, onOpen, onOpenResults }: {
  rows: readonly DoneRow[]; runs: readonly RoutineRun[]; bots: readonly Bot[]; instances: readonly Pick<InstanceInfo, "instanceId" | "displayName">[];
  onOpen: (row: DoneRow) => void; onOpenResults: () => void;
}) {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const detailFor = (row: DoneRow): string => {
    const run = byId.get(row.runId);
    return run ? doneMeta(run, row, bots, instances).map(say).join(" · ") : "";
  };
  return <DoneTodayCard rows={rows} onOpen={onOpen} onOpenResults={onOpenResults} limit={Number.POSITIVE_INFINITY} detailFor={detailFor} />;
}
