// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Your day (Today slice 1.0.18, designs/TODAY-SLICE-1104.md sections 2 and 3): what still runs between now and the
// viewer's midnight, from dayTimeline (src/lib/today-day.ts). No calendar read: the meetings row is a placeholder
// until 1.0.19. Empty states: a later run ("Nothing else is scheduled today. Next: {name}, {when}."), no routines
// at all ("No routines yet. Tell {chief} what you want done every day."), or routines with no time at all.
import { ArrowRight } from "lucide-react";
import { t } from "@/lib/i18n";
import type { DayTimeline } from "@/lib/today-day";
import { clockLabel, whenLabel } from "./say";

const marker = "px-2 text-[12px] font-semibold uppercase tracking-wide text-ink-secondary";

export interface YourDayProps {
  timeline: DayTimeline;
  now: number;
  botNames: Readonly<Record<string, string>>;
  /** the Chief's name, for "Tell {chief} ..." (empty when there is no Chief) */
  chiefName: string;
  onOpenRoutines: () => void;
}

export function emptyDayLine(timeline: DayTimeline, now: number, chiefName: string): string {
  if (!timeline.hasRoutines) return chiefName ? t("ux.l2a.today.day.none", { chief: chiefName }) : t("ux.l2a.today.routinesEmpty");
  if (timeline.next) return t("ux.l2a.today.day.empty", { name: timeline.next.name, when: whenLabel(timeline.next.at, now) });
  return t("ux.l2a.today.routinesEmpty");
}

export function YourDay({ timeline, now, botNames, chiefName, onOpenRoutines }: YourDayProps) {
  return (
    <section aria-labelledby="today-day" className="rounded-xl border border-hairline/50 bg-panel p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id="today-day" className="text-[13px] font-semibold text-ink-secondary">{t("ux.l2a.today.day.title")}</h2>
        <button type="button" onClick={onOpenRoutines} aria-label={t("ux.l2a.today.openRoutines")} title={t("ux.l2a.today.openRoutines")}
          className="flex size-11 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </div>
      {timeline.rows.length === 0 ? (
        <p className="px-2 py-2 text-[13px] text-ink-secondary">{emptyDayLine(timeline, now, chiefName)}</p>
      ) : (
        <>
          <p className={marker}>{t("ux.l2a.today.day.now")}</p>
          <ol className="my-1 border-l border-hairline/60 pl-2">
            {timeline.rows.map((row) => {
              const bot = botNames[row.botId] ?? "";
              const meta = row.everyMinutes !== undefined ? t("ux.l2a.today.day.every", { n: row.everyMinutes }) : bot;
              return (
                <li key={row.id} className="flex min-h-11 items-center gap-3 px-2 py-1">
                  <span className="w-12 shrink-0 text-[13px] tabular-nums text-ink-secondary">{clockLabel(row.at)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-ink">{row.name}</span>
                    {meta && <span className="block truncate text-[13px] text-ink-secondary">{meta}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
          {timeline.more > 0 && (
            <button type="button" onClick={onOpenRoutines} className="flex min-h-11 w-full items-center rounded-lg px-2 text-left text-[13px] font-medium text-accent-text hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
              {t("ux.l2a.today.day.more", { n: timeline.more })}
            </button>
          )}
          <p className={marker}>{t("ux.l2a.today.day.midnight")}</p>
        </>
      )}
      <p data-day="meetings" className="mt-2 px-2 py-1 text-[13px] text-ink-secondary">{t("ux.l2a.today.day.meetings")}</p>
    </section>
  );
}
