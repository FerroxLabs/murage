// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Calm | Detailed switch (Today slice 1.0.18, designs/TODAY-SLICE-1104.md section 2b): one segmented control,
// `role="radiogroup"` with two `role="radio"` buttons. Arrow keys move and choose; only the chosen one is in the tab
// order. Each half is 44 px high under 760 px. Not drawn in first run (TodayView). The save is use-today-view.ts's.
import { useRef, type KeyboardEvent } from "react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { TodayView } from "./use-today-view";

const VIEWS: readonly TodayView[] = ["calm", "detailed"];

export function TodayViewSwitch({ view, failed, onPick, className }: { view: TodayView; failed: boolean; onPick: (view: TodayView) => void; className?: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const at = (VIEWS.indexOf(view) + step + VIEWS.length) % VIEWS.length;
    onPick(VIEWS[at]!);
    refs.current[at]?.focus();
  };
  return (
    <div className={cn("flex flex-col items-end gap-1", className)}>
      <div role="radiogroup" aria-label={t("ux.l2a.today.view.label")} data-today="view-switch" onKeyDown={onKey}
        className="inline-flex rounded-lg border border-hairline/50 bg-panel p-0.5">
        {VIEWS.map((option, i) => {
          const on = option === view;
          return (
            <button key={option} ref={(node) => { refs.current[i] = node; }} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
              data-view-option={option} onClick={() => { if (!on) onPick(option); }}
              className={cn(
                "h-8 rounded-md px-3 text-[13px] font-medium max-[760px]:h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                on ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
              )}>
              {t(option === "calm" ? "ux.l2a.today.view.calm" : "ux.l2a.today.view.detailed")}
            </button>
          );
        })}
      </div>
      <p role="status" className="text-[12px] text-danger empty:hidden">{failed ? t("ux.l2a.today.view.saveFailed") : ""}</p>
    </div>
  );
}
