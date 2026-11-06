// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Needs you door (UX L2B; designs/UX-OVERHAUL-BUILD-PLAN.md, L2B brief).
// Replaces L2A's stand-in (shell/stubs/needs-stub.tsx) with the contract's
// names and props unchanged. The page body loads on first use so the Inbox it
// draws stays out of the first paint (scripts/check-bundle-budget.mjs).
import { Suspense, useEffect, useState } from "react";
import { api, useStore } from "@/state/store";
import { usePendingApprovals } from "@/components/usePendingApprovals";
import { useDesktopSurface } from "@/lib/use-surface";
import { LazyBoundary, retryableLazy } from "@/components/LazyBoundary";
import { LazyFallback } from "@/components/LazyFallback";
import { t } from "@/lib/i18n";
import { oldestFirst, waitingSinceTime } from "@/lib/needs-keys";
import { onInboxChanged, serialRefresh } from "@/lib/inbox-changed";
import { useMonthNeedsRow } from "@/components/today/MonthCard";
import type { InboxItem, InboxPage } from "../../../shared/inbox";
import type { NeedsSummary, NeedsSummaryRow, NeedsYouPageProps } from "@/components/shell/shell-contract";

const Body = retryableLazy(() => import("./NeedsYouPageBody").then((module) => ({ default: module.NeedsYouPageBody })));

export function NeedsYouPage(props: NeedsYouPageProps) {
  return <LazyBoundary onRetry={Body.retry}><Suspense fallback={<LazyFallback />}><Body.Component {...props} /></Suspense></LazyBoundary>;
}

/** Today's three oldest owed rows, from one Inbox read: "<bot> · waiting since 07:12". Pure, for the test. */
export function needsTopRows(items: readonly InboxItem[], now: number, open: () => void): NeedsSummaryRow[] {
  return needsOwedRows(items, now, open).slice(0, 3).map((row) => {
    const top = { ...row };
    delete top.segment;
    return top;
  });
}

/** Every owed row of one Inbox read, oldest first, each with its segment (Today filters by segment before any cut). */
export function needsOwedRows(items: readonly InboxItem[], now: number, open: () => void): NeedsSummaryRow[] {
  return oldestFirst(items.filter((item) => item.decision)).map((item) => {
    const bot = item.sourceLabel.split(" · ")[0]?.trim() ?? "";
    const time = waitingSinceTime(item.at, now);
    return {
      id: item.id,
      ...(item.botId ? { botId: item.botId } : {}),
      line: item.title,
      meta: bot ? t("ux.l2b.door.meta", { bot, time }) : t("ux.l2b.door.metaNoBot", { time }),
      open,
      segment: item.segment,
    };
  });
}

/** What Today takes from one `GET /api/inbox?view=decisions&pageSize=25` answer. Pure, for the test. */
export type NeedsPageSummary = Pick<NeedsSummary, "top" | "rows" | "split" | "restore">;
export function needsPageSummary(page: InboxPage, now: number, open: () => void): Required<NeedsPageSummary> {
  const items = page.items ?? [];
  return {
    top: needsTopRows(items, now, open),
    rows: needsOwedRows(items, now, open),
    split: { approvals: tally(page.approvals), questions: tally(page.questions), connections: tally(page.connections) },
    restore: Array.isArray(page.restore) ? page.restore : [],
  };
}

function tally(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

const NO_ROWS: NeedsPageSummary = { top: [] };

/** The one Needs you count (snoozed rows still count), the three oldest rows, and for Today every owed row with its
 *  segment, the segment split and the restore rows, all from ONE Inbox read. Desktop only, as the rail's badge is.
 *  The rows are read again when the count changes, on `inbox.changed` and on window focus (a decision replaced by
 *  another at the same count), one read in flight (serialRefresh). `count` stays the badge truth. */
export function useNeedsSummary(): NeedsSummary {
  const { state, dispatch } = useStore();
  const desktop = useDesktopSurface();
  const approvals = usePendingApprovals(desktop === true, state.connected);
  const count = approvals.decisions;
  const [read, setRead] = useState<NeedsPageSummary>(NO_ROWS);
  useEffect(() => {
    if (desktop !== true || !count) { setRead(NO_ROWS); return; }
    const controller = new AbortController();
    const refresh = serialRefresh(async () => {
      if (controller.signal.aborted) return;
      try {
        const page = await api("/api/inbox?view=decisions&pageSize=25", { signal: controller.signal }) as InboxPage;
        if (controller.signal.aborted || page.preparing) return;
        setRead(needsPageSummary(page, Date.now(), () => dispatch({ type: "showNeedsYou" })));
      } catch { /* the count and the door still show; rows come with the next change */ }
    });
    void refresh();
    const stopListening = onInboxChanged(() => { void refresh(); });
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { controller.abort(); stopListening(); window.removeEventListener("focus", onFocus); };
  }, [desktop, count, dispatch]);
  // The monthly limit heads-up (UX-L2C) is owed too: one row first, counted, until the owner leaves it for Flux's month.
  // It asks GET /api/spend again whenever the count moves, and shows only a figure matched to the current key.
  const spendRow = useMonthNeedsRow(() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" }), count);
  const spend = desktop === true ? spendRow : null;
  return { count: count ?? 0, stale: approvals.stale, ...composeTop(read, spend), healthLevel: approvals.healthLevel };
}

/** The spend heads-up goes first in the Needs you top rows ONLY. It is not an owed item: it stays out of `count` and out of
 *  `rows` (Today shows the real month card), so Today's count always equals the rows it lists. */
export function composeTop(read: NeedsPageSummary, spend: NeedsSummaryRow | null): NeedsPageSummary {
  return spend ? { ...read, top: [spend, ...read.top].slice(0, 3) } : read;
}
