// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Working now (lane L2A; mockup Desktop.dc.html Today, "Working now"): one row
// per running conversation with [Watch] (open its chat) and [Stop] (the
// existing interrupt, the same as the chat's own Stop). After Stop the toast
// says what happens to the work so far; it is not undoable (a stopped turn
// cannot be restarted where it was), so there is no Undo on it.
import { t } from "@/lib/i18n";
import { soFarLine, type WorkingItem } from "@/lib/working-now";

export interface WorkingNowCardProps {
  items: readonly WorkingItem[];
  now: number;
  /** "Next: Weekly digest, Friday 17:00" when nothing runs; empty for none */
  nextLine: string;
  onWatch: (item: WorkingItem) => void;
  onStop: (item: WorkingItem) => void;
}

const button = "min-h-11 shrink-0 rounded-lg border border-hairline/50 px-3 text-[13px] font-medium text-ink hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

export function WorkingNowCard({ items, now, nextLine, onWatch, onStop }: WorkingNowCardProps) {
  return (
    <div data-working-now>
      {items.length === 0 ? (
        <div className="py-2">
          <p className="text-[14px] text-ink">{t("ux.l2a.working.none")}</p>
          {nextLine && <p className="text-[13px] text-ink-secondary">{nextLine}</p>}
        </div>
      ) : (
        <ul className="divide-y divide-hairline/30">
          {items.map((item) => {
            const what = item.what ? `${item.botName} · ${item.what}` : item.botName;
            const soFar = soFarLine(item.since, now);
            return (
              <li key={`${item.botId}:${item.threadId}`} className="flex flex-wrap items-center gap-2 py-2">
                <span aria-hidden="true" className="relative size-2.5 shrink-0 rounded-full bg-success animate-status-pulse" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{what}</span>
                  {soFar && <span className="block text-[13px] text-ink-secondary">{soFar}</span>}
                </span>
                <button type="button" className={button} onClick={() => onWatch(item)} aria-label={t("ux.l2a.working.watchName", { name: item.botName })}>{t("ux.l2a.working.watch")}</button>
                <button type="button" className={button} onClick={() => onStop(item)} aria-label={t("ux.l2a.working.stopName", { name: item.botName })}>{t("ux.l2a.working.stop")}</button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
