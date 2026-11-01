// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 1.3 and 1.5: the fold under the verb. Each row
// answers the card with the verb AND that scope, in one request. On the
// desktop it opens under the caret; on the phone it is a sheet opened from
// "{Verb} and stop asking…", where bot-level rows are listed greyed with
// "Give this on your computer" (the bot routes are desktop only).
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { FoldScope } from "../../../shared/fold-scopes";
import { foldRowWords } from "@/lib/fold-words";

export interface GrantFoldProps {
  id: string;
  rows: readonly FoldScope[];
  bot: string;
  /** the level's frozen name, for the footer */
  level: string;
  verb: string;
  /** true on the desktop app: bot-level rows can be chosen */
  desktop: boolean;
  variant: "menu" | "sheet";
  busy: string | null;
  onChoose: (row: FoldScope) => void;
  onClose: () => void;
  /** extra content under a row (the routine's stop checkboxes) */
  below?: (row: FoldScope) => ReactNode;
}

export function rowChoosable(row: FoldScope, desktop: boolean): boolean {
  return row.surface === "any" || desktop;
}

export function GrantFold({ id, rows, bot, level, verb, desktop, variant, busy, onChoose, onClose, below }: GrantFoldProps) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const body = (
    <div id={id} role="group" aria-label={t("ux.l1.fold.heading", { verb })} data-grant-fold={variant} className="w-full rounded-xl border border-hairline/50 bg-raised p-2 text-left">
      <p className="px-2 pb-1 text-[11px] uppercase tracking-[0.12em] text-ink-secondary">{t("ux.l1.fold.heading", { verb })}</p>
      <ul className="flex flex-col gap-1">
        {rows.map((row, index) => {
          const choosable = rowChoosable(row, desktop);
          const words = foldRowWords(row, { bot });
          return (
            <li key={`${row.id}:${row.keys.join(",")}`} data-fold-row={row.id} data-fold-scope={row.scope}>
              <button
                ref={index === 0 ? first : undefined}
                type="button"
                aria-disabled={!choosable || busy !== null || undefined}
                aria-busy={busy === row.id || undefined}
                onClick={() => { if (choosable && busy === null) onChoose(row); }}
                className={cn(
                  "flex min-h-11 w-full flex-col items-start justify-center rounded-lg px-3 py-2 text-left text-[13.5px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
                  choosable ? "text-ink hover:bg-control" : "cursor-not-allowed text-ink-secondary",
                )}
              >
                <span className="break-words">{words}</span>
                {!choosable && <span className="text-[12px] text-ink-secondary">{t("ux.l1.fold.onComputer")}</span>}
              </button>
              {below?.(row)}
            </li>
          );
        })}
      </ul>
      <p className="px-2 pt-1 text-[12px] text-ink-secondary">
        {t(desktop ? "ux.l1.fold.footer" : "ux.l1.fold.footerPhone", { bot, level })}
      </p>
    </div>
  );
  if (variant === "menu") return body;
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/30" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={t("ux.l1.fold.heading", { verb })} className="w-full rounded-t-2xl bg-card p-3 pb-[max(env(safe-area-inset-bottom),12px)]">
        {body}
        <button type="button" onClick={onClose} className="mt-2 min-h-11 w-full rounded-lg text-[13.5px] text-ink-secondary hover:bg-control">
          {t("ux.l1.fold.close")}
        </button>
      </div>
    </div>
  );
}
