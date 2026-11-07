// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Today's "This month" card and the heads-up's buttons (UX-L2C, 1.0.18), loaded on first show so they stay off
// the first paint (MonthCard.tsx keeps the reading, the tag and the Needs you row).
// The figure is Flux's own (src/lib/spend-meter.ts): the key's month to date,
// as of Flux's time, for Flux's month. Not reported yet reads "Spending will
// show here once Flux reports it", never $0. The heads-up at 80% and at the
// limit is a notice only: nothing here holds or refuses work.
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { useAction } from "@/lib/use-action";
import { ActionButton } from "@/components/ActionButton";
import { formatDollars, SUGGESTED_MONTHLY_LIMIT_USD, type SpendState } from "@/lib/spend-meter";
import type { MonthCardProps } from "@/components/shell/shell-contract";
import { headsUpLine, monthLine, useMonthReading } from "./MonthCard";

const smallButton = "min-h-11 shrink-0 rounded-lg border border-hairline/50 px-3 text-[13px] font-medium text-ink hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50";

function useLeave(state: SpendState) {
  return useAction(
    async () => {
      if (!state.leaveKey) return;
      await api("/api/config", { method: "PATCH", body: JSON.stringify({ spend: { headsUpLeft: state.leaveKey } }) });
    },
    { idle: t("ux.l2c.headsUp.leave"), pending: t("ux.l2c.headsUp.leaving"), success: t("ux.l2c.headsUp.left"), failure: t("ux.l2c.headsUp.leaveFailed") },
  );
}

/** "As of 14:05, resets 1 Dec", from Flux's own fields. */
export function asOfLine(reading: { asOf: string; resetsAt: string }): string {
  return t("ux.l2c.month.asOf", {
    time: new Date(reading.asOf).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    date: new Date(reading.resetsAt).toLocaleDateString([], { day: "numeric", month: "short" }),
  });
}

/** The same heads-up on the Needs you page, with its two buttons. */
export function MonthNeedsRow({ onOpenUsage }: MonthCardProps) {
  const { show, state } = useMonthReading();
  const leave = useLeave(state);
  if (!show || !state.headsUp || state.limitUsd === null) return null;
  return <HeadsUp state={state} limit={state.limitUsd} leave={leave} onOpenUsage={onOpenUsage} />;
}

function HeadsUp({ state, limit, leave, onOpenUsage }: { state: SpendState; limit: number; leave: ReturnType<typeof useLeave>; onOpenUsage: () => void }) {
  return (
    <div role="status" data-testid="month-heads-up" className="rounded-lg border border-hairline/50 bg-raised p-3">
      <p className="text-[14px] font-medium text-ink">{headsUpLine(state, limit)}</p>
      <p className="mt-0.5 text-[13px] text-ink-secondary">{t("ux.l2c.headsUp.sub")}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={smallButton} onClick={onOpenUsage}>{t("ux.l2c.headsUp.raise")}</button>
        <ActionButton action={leave} className={smallButton}>{t("ux.l2c.headsUp.leave")}</ActionButton>
      </div>
    </div>
  );
}

export function MonthCardView({ onOpenUsage }: MonthCardProps) {
  const { show, total, state } = useMonthReading();
  const leave = useLeave(state);
  if (!show) return null;
  const limit = state.limitUsd;
  const line = monthLine(total, state);
  const meta = [total.state === "ok" ? asOfLine(total) : "",
    limit === null ? t("ux.l2c.month.noLimit", { suggested: formatDollars(SUGGESTED_MONTHLY_LIMIT_USD) }) : "",
    total.state === "ok" ? t("ux.l2c.month.chatOnly") : ""].filter(Boolean).join(" ");
  // No bar without a Flux figure: an empty bar would read as $0.
  const bar = limit !== null && state.percent !== null;
  const fill = bar ? Math.min(100, state.percent ?? 0) : 0;
  return (
    <div data-testid="month-card" className="mb-2 flex flex-col gap-2 px-2 py-2">
      <button type="button" onClick={onOpenUsage} className="flex min-h-11 flex-col items-start rounded-lg text-left hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" aria-label={`${line}. ${t("ux.l2c.month.open")}`}>
        <span data-testid="month-line" className={cn("text-[14px] tabular-nums", state.level === "limit" ? "text-danger" : state.level === "warn" ? "text-warning" : "text-ink")}>{line}</span>
        {meta && <span className="text-[13px] text-ink-secondary">{meta}</span>}
      </button>
      {bar && (
        <div role="progressbar" aria-label={line} aria-valuemin={0} aria-valuemax={100} aria-valuenow={fill} className="h-2 overflow-hidden rounded bg-control">
          <div className={cn("h-full", state.level === "limit" ? "bg-danger" : state.level === "warn" ? "bg-warning" : "bg-accent")} style={{ width: `${fill}%` }} />
        </div>
      )}
      {state.headsUp && limit !== null && <HeadsUp state={state} limit={limit} leave={leave} onOpenUsage={onOpenUsage} />}
    </div>
  );
}
