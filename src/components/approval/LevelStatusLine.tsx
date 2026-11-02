// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The status line under the level menu (UX-TRUST-MOMENTS-1012 2.5): the Undo
// toast host refuses server work, so level Undo lives inline, the way
// GrantAddedLine does, for UNDO_WINDOW_MS.
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { UNDO_WINDOW_MS } from "@/lib/undo-window";
import type { LevelLine } from "@/lib/level-change";

const LINK = "inline-flex min-h-11 items-center rounded-md px-2 text-[12.5px] text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";

export function LevelStatusLine({ line, undoing, onUndo, onReview }: { line: LevelLine; undoing?: boolean; onUndo: () => void; onReview: () => void }) {
  const [, tick] = useState(0);
  const windowed = line.undo !== null && !line.retry;
  useEffect(() => {
    if (!windowed) return;
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, line.at + UNDO_WINDOW_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [windowed, line.at]);
  const undoOpen = line.undo !== null && (line.retry === true || Date.now() - line.at < UNDO_WINDOW_MS);
  return (
    <div role="status" data-level-line={line.kind} className="mt-2 flex flex-wrap items-center gap-x-1 text-[12.5px] text-ink">
      <span>{line.text}</span>
      {line.review && <button type="button" onClick={onReview} className={LINK}>{t("ux.l1.levelLine.review")}</button>}
      {undoOpen && (
        <button type="button" onClick={() => { if (!undoing) onUndo(); }} aria-disabled={undoing || undefined} aria-busy={undoing || undefined} className={cn(LINK, undoing && "cursor-progress opacity-70")}>
          {undoing ? t("ux.l1.added.takingBack") : line.retry ? t("ux.l1.added.tryAgain") : t("ux.l1.added.undo")}
        </button>
      )}
      {line.restoreOnComputer && <span className="text-ink-secondary">{t("ux.l1.levelLine.restoreOnComputer")}</span>}
    </div>
  );
}
