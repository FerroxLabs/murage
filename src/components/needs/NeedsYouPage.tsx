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
import type { InboxItem, InboxPage } from "../../../shared/inbox";
import type { NeedsSummary, NeedsSummaryRow, NeedsYouPageProps } from "@/components/shell/shell-contract";

const Body = retryableLazy(() => import("./NeedsYouPageBody").then((module) => ({ default: module.NeedsYouPageBody })));

export function NeedsYouPage(props: NeedsYouPageProps) {
  return <LazyBoundary onRetry={Body.retry}><Suspense fallback={<LazyFallback />}><Body.Component {...props} /></Suspense></LazyBoundary>;
}

/** Today's three oldest owed rows, from one Inbox read: "<bot> · waiting since 07:12". Pure, for the test. */
export function needsTopRows(items: readonly InboxItem[], now: number, open: () => void): NeedsSummaryRow[] {
  return oldestFirst(items.filter((item) => item.decision)).slice(0, 3).map((item) => {
    const bot = item.sourceLabel.split(" · ")[0]?.trim() ?? "";
    const time = waitingSinceTime(item.at, now);
    return {
      id: item.id,
      ...(item.botId ? { botId: item.botId } : {}),
      line: item.title,
      meta: bot ? t("ux.l2b.door.meta", { bot, time }) : t("ux.l2b.door.metaNoBot", { time }),
      open,
    };
  });
}

/** The one Needs you count (snoozed rows still count) and the three oldest rows for Today. Desktop only, as the
 *  rail's badge is; the rows are read again only when the count changes. */
export function useNeedsSummary(): NeedsSummary {
  const { state, dispatch } = useStore();
  const desktop = useDesktopSurface();
  const approvals = usePendingApprovals(desktop === true, state.connected);
  const count = approvals.decisions;
  const [top, setTop] = useState<NeedsSummaryRow[]>([]);
  useEffect(() => {
    if (desktop !== true || !count) { setTop((current) => (current.length ? [] : current)); return; }
    const controller = new AbortController();
    void api("/api/inbox?view=decisions&pageSize=25", { signal: controller.signal }).then((value) => {
      const page = value as InboxPage;
      if (controller.signal.aborted || page.preparing) return;
      setTop(needsTopRows(page.items ?? [], Date.now(), () => dispatch({ type: "showNeedsYou" })));
    }).catch(() => { /* the count and the door still show; rows come with the next change */ });
    return () => controller.abort();
  }, [desktop, count, dispatch]);
  return { count, stale: approvals.stale, top, healthLevel: approvals.healthLevel };
}
