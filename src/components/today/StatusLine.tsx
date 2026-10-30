// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Today's status tags (lane L2A; mockup Desktop.dc.html Today header). A tag
// with something to open is a button; the rest are plain text. The dot's
// colour repeats what the words already say, so it is hidden from readers.
import { cn } from "@/lib/cn";
import { TONE_DOT } from "@/lib/today-model";
import { t } from "@/lib/i18n";
import type { TodayTag } from "@/components/shell/shell-contract";

export function StatusLine({ tags }: { tags: readonly TodayTag[] }) {
  if (tags.length === 0) return null;
  return (
    <ul aria-label={t("ux.l2a.today.statusLabel")} className="mt-2 flex flex-wrap gap-1.5" data-today-status>
      {tags.map((tag) => {
        const inner = (
          <>
            <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", TONE_DOT[tag.tone])} />
            <span>{tag.text}</span>
          </>
        );
        const base = "inline-flex min-h-8 items-center gap-1.5 rounded-full border border-hairline/50 bg-panel px-3 text-[13px] text-ink";
        return (
          <li key={tag.key} data-tag={tag.key} data-tone={tag.tone}>
            {tag.onClick ? (
              <button type="button" onClick={tag.onClick}
                className={cn(base, "tap-area hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus")}>
                {inner}
              </button>
            ) : (
              <span className={base}>{inner}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
