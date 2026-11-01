// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Today's cards (lane L2A; mockup Desktop.dc.html ~278-330, copy verbatim).
// Each card has one header and at most one way onward (the arrow), so the
// owner reads the page top to bottom in ten seconds and never has to choose.
import type { ReactNode } from "react";
import { ArrowRight, Check, Lightbulb } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { NeedsSummary } from "@/components/shell/shell-contract";
import type { TodayRow } from "@/lib/today-model";

const rowButton = "flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";
const smallButton = "min-h-11 shrink-0 rounded-lg border border-hairline/50 px-3 text-[13px] font-medium text-ink hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

export function TodayCard({ title, arrowLabel, onArrow, children, className, id }: { title: string; arrowLabel?: string; onArrow?: () => void; children: ReactNode; className?: string; id: string }) {
  return (
    <section aria-labelledby={id} className={cn("rounded-xl border border-hairline/50 bg-panel p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 id={id} className="text-[13px] font-semibold text-ink-secondary">{title}</h2>
        {onArrow && arrowLabel && (
          <button type="button" onClick={onArrow} aria-label={arrowLabel} title={arrowLabel}
            className="flex size-11 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function Line({ line, meta }: { line: string; meta: string }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[14px] text-ink">{line}</span>
      {meta && <span className="block truncate text-[13px] text-ink-secondary">{meta}</span>}
    </span>
  );
}

function Mark({ tone }: { tone: TodayRow["tone"] }) {
  return (
    <span aria-hidden="true" className={cn(
      "flex size-5 shrink-0 items-center justify-center rounded-full",
      tone === "ok" ? "bg-success-soft text-success" : tone === "bad" ? "bg-danger-soft text-danger" : "border border-hairline text-ink-secondary",
    )}>
      {tone === "ok" ? <Check size={12} strokeWidth={3} /> : tone === "bad" ? "!" : null}
    </span>
  );
}

/** Needs you (top 3). With no rows yet (the count is known, the rows are not), one row opens the door. */
export function NeedsCard({ needs, onOpen }: { needs: NeedsSummary; onOpen: () => void }) {
  const count = needs.count;
  const title = count === undefined ? t("ux.l2a.door.needsYou") : t("ux.l2a.today.needsTitle", { n: count });
  return (
    <TodayCard id="today-needs" title={title} arrowLabel={t("ux.l2a.today.openNeeds")} onArrow={onOpen}>
      {count === 0 ? (
        <div className="flex items-start gap-3 px-2 py-2">
          <Mark tone="ok" />
          <Line line={t("ux.l2a.today.needsEmpty")} meta={t("ux.l2a.today.needsEmptySub")} />
        </div>
      ) : count === undefined ? (
        <p className="px-2 py-2 text-[13px] text-ink-secondary">{t("ux.l2a.today.needsChecking")}</p>
      ) : needs.top.length === 0 ? (
        <button type="button" className={rowButton} onClick={onOpen}>
          <Line line={count === 1 ? t("ux.l2a.tag.needsOne") : t("ux.l2a.tag.needsMany", { n: count })} meta={t("ux.l2a.today.openNeeds")} />
        </button>
      ) : (
        <>
          <ul>
            {needs.top.slice(0, 3).map((row) => (
              <li key={row.id}><button type="button" className={rowButton} onClick={row.open}><Line line={row.line} meta={row.meta} /></button></li>
            ))}
          </ul>
          {count > 3 && (
            <button type="button" className={cn(rowButton, "text-[13px] font-medium text-accent-text")} onClick={onOpen}>
              {t("ux.l2a.today.moreNeeds", { n: count - 3 })}
            </button>
          )}
        </>
      )}
    </TodayCard>
  );
}

export function RoutineRows({ rows, onOpen, emptyLine }: { rows: readonly TodayRow[]; onOpen: (row: TodayRow) => void; emptyLine: string }) {
  if (rows.length === 0) return <p className="px-2 py-2 text-[13px] text-ink-secondary">{emptyLine}</p>;
  return (
    <ul>
      {rows.map((row) => (
        <li key={row.id}><button type="button" className={rowButton} onClick={() => onOpen(row)}><Mark tone={row.tone} /><Line line={row.line} meta={row.meta} /></button></li>
      ))}
    </ul>
  );
}

export function TeamRow({ names, meta, onHire }: { names: string; meta: string; onHire: () => void }) {
  return (
    <div className="flex items-center gap-3 px-2 py-2">
      <Line line={names} meta={meta} />
      <button type="button" className={smallButton} onClick={onHire}>{t("ux.l2a.today.hire")}</button>
    </div>
  );
}

export function TryNextCard({ onTry, onDismiss }: { onTry: () => void; onDismiss: () => void }) {
  return (
    <section aria-labelledby="today-try" className="flex flex-wrap items-center gap-3 rounded-xl border border-hairline/50 bg-panel p-4">
      <Lightbulb size={18} aria-hidden="true" className="shrink-0 text-ink-secondary" />
      <div className="min-w-0 flex-1">
        <h2 id="today-try" className="text-[14px] font-semibold text-ink">{t("ux.l2a.today.tryTitle")}</h2>
        <p className="text-[14px] text-ink-secondary">{t("ux.l2a.today.tryLine")}</p>
      </div>
      <button type="button" onClick={onDismiss} className="min-h-11 rounded-lg px-3 text-[13px] font-medium text-ink-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">{t("ux.l2a.today.tryNotNow")}</button>
      <button type="button" onClick={onTry} className="min-h-11 rounded-lg bg-accent px-4 text-[13px] font-medium text-accent-ink hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">{t("ux.l2a.today.tryIt")}</button>
    </section>
  );
}
