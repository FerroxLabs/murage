// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Detailed only (Today slice 1.0.18, designs/TODAY-SLICE-1104.md section 2b D3 and D5), loaded lazily so Calm's first
// paint never carries it. "Reported routine cost": 7 plain div bars (6 days and today, today in the accent), no
// chart library; a day whose runs reported no cost is a hollow bar, never $0. The routines line sits beside it.
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { Routine, RoutineRun } from "@/lib/routines";
import { routinesLine, spendCard, spendLines, type SpendDay } from "@/lib/today-detail";
import { formatUsd } from "@/lib/usage";
import { say, whenLabel } from "./say";

const dayName = (start: number) => new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(start);
const barWords = (day: SpendDay) => day.kind === "cost" || day.kind === "empty" ? formatUsd(day.total) : t("ux.l2a.today.done.noCost");

export function SpendCard({ runs, now, onOpenUsage }: { runs: readonly RoutineRun[]; now: number; onOpenUsage: () => void }) {
  const card = spendCard(runs, now);
  const open = (
    <button type="button" onClick={onOpenUsage} className="min-h-11 rounded-lg px-2 text-[13px] font-medium text-accent-text hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
      {t("ux.l2a.today.runCost.open")}
    </button>
  );
  let body: ReactNode;
  if (card.state === "tooMany") body = <p className="px-2 py-2 text-[13px] text-ink-secondary">{t("ux.l2a.today.runCost.tooMany")}</p>;
  else if (card.state === "none") body = <p className="px-2 py-2 text-[13px] text-ink-secondary">{t("ux.l2a.today.runCost.none")}</p>;
  else {
    const words = spendLines(card);
    const top = Math.max(...card.days.map((day) => (day.kind === "cost" ? day.total : 0)), 0);
    const list = card.days.filter((day) => day.kind !== "uncovered").map((day) => `${dayName(day.start)} ${barWords(day)}`).join(", ");
    body = (
      <>
        <p className="px-2 pt-1 text-[20px] font-semibold tabular-nums text-ink">{say(words.today)}</p>
        {words.partial && <p className="px-2 text-[13px] text-ink-secondary">{say(words.partial)}</p>}
        <p className="px-2 text-[13px] text-ink-secondary">{say(words.usual)}</p>
        <div role="img" aria-label={t("ux.l2a.today.runCost.bars", { list })} data-cost-bars="" className="mt-3 flex h-16 items-end gap-1.5 px-2">
          {card.days.map((day, i) => {
            const today = i === card.days.length - 1;
            const hollow = day.kind === "unreported" || day.kind === "uncovered";
            const height = day.kind === "cost" && top > 0 ? Math.max(4, Math.round((day.total / top) * 100)) : hollow ? 30 : 2;
            return (
              <div key={day.start} data-bar={day.kind} style={{ height: `${height}%` }}
                className={cn("flex-1 rounded-sm", hollow ? "border border-dashed border-ink-secondary/50" : today ? "bg-accent" : "bg-ink-secondary/40")} />
            );
          })}
        </div>
      </>
    );
  }
  return (
    <section aria-labelledby="today-cost" data-today="cost" className="rounded-xl border border-hairline/50 bg-panel p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id="today-cost" className="text-[13px] font-semibold text-ink-secondary">{t("ux.l2a.today.runCost.title")}</h2>
        {open}
      </div>
      {body}
      <p className="mt-2 px-2 text-[12px] text-ink-secondary">{t("ux.l2a.today.runCost.sub")}</p>
    </section>
  );
}

/** D5: one line above Done today. Hidden with no routines. */
export function RoutinesLine({ routines, runs, now }: { routines: readonly Routine[]; runs: readonly RoutineRun[]; now: number }) {
  const line = routinesLine(routines, runs, now);
  if (!line) return null;
  const text = line.next
    ? t("ux.l2a.today.routines.line", { ran: line.ran, failed: line.failed, name: line.next.name, when: whenLabel(line.next.at, now) })
    : t("ux.l2a.today.routines.lineNoNext", { ran: line.ran, failed: line.failed });
  return <p data-today="routines-line" className="px-2 py-2 text-[13px] text-ink-secondary">{text}</p>;
}
