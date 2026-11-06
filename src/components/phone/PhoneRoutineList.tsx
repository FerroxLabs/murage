// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX L7 part 2: the Routines tab on a phone is a list by day (Today, Tomorrow,
// Later this week) from L5B's model (routineDayBuckets), not the week grid.
// A row opens the routine sheet, which on a phone has Run now only (Edit and
// delete stay on the computer). New routine opens the sentence sheet, which
// hands the words to the bot's chat. Rendered inside the Routines page chunk,
// so it never touches the first paint.

import { Plus } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Routine } from "@/lib/routines";
import { occurrenceWords, routineDayBuckets, type RoutineDayBuckets } from "@/lib/routine-sheet-model";
import type { LocaleKey } from "@/locales";

export const PHONE_DAY_KEYS = ["today", "tomorrow", "later"] as const satisfies ReadonlyArray<keyof RoutineDayBuckets>;
const DAY_TITLE: Record<(typeof PHONE_DAY_KEYS)[number], LocaleKey> = {
  today: "ux.l5b.day.today",
  tomorrow: "ux.l5b.day.tomorrow",
  later: "ux.l5b.day.later",
};

export interface PhoneRoutineListProps {
  routines: readonly Routine[];
  botName: (botId: string) => string | undefined;
  now: number;
  onOpen: (routine: Routine) => void;
  /** null when there is no bot to ask */
  onNew: (() => void) | null;
}

export function PhoneRoutineList({ routines, botName, now, onOpen, onNew }: PhoneRoutineListProps) {
  const buckets = routineDayBuckets(routines, now);
  const empty = PHONE_DAY_KEYS.every((key) => buckets[key].length === 0);
  return (
    <div data-phone-routine-list className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] md:hidden">
      {empty && <p data-phone-routine-empty className="text-[14px] text-ink-secondary">{t("ux.l7.routines.empty")}</p>}
      {PHONE_DAY_KEYS.map((key) => buckets[key].length > 0 && (
        <section key={key} aria-label={t(DAY_TITLE[key])} data-phone-routine-day={key}>
          <h2 className="pb-1 text-[12px] font-medium uppercase tracking-wider text-ink-secondary">{t(DAY_TITLE[key])}</h2>
          <ul className="flex flex-col">
            {buckets[key].map(({ routine, at }) => (
              <li key={routine.id}>
                <button type="button" data-phone-routine-row={routine.id} onClick={() => onOpen(routine)}
                  className="flex min-h-14 w-full flex-col justify-center rounded-lg px-2 text-left hover:bg-raised/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                  <span className="truncate text-[15px] text-ink">{routine.name}</span>
                  <span className="truncate text-[13px] text-ink-secondary">{[botName(routine.botId), occurrenceWords(at, now)].filter(Boolean).join(" · ")}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {onNew && (
        <button type="button" data-phone-routine-new onClick={onNew}
          className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-[15px] font-semibold text-accent-ink hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
          <Plus size={16} aria-hidden="true" />{t("ux.l5b.new.button")}
        </button>
      )}
    </div>
  );
}
