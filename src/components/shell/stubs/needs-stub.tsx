// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L2A STAND-IN for L2B's Needs you door (src/components/needs/NeedsYouPage.tsx).
// It keeps the contract's names and props so the shell works before L2B
// merges: the page is today's Inbox, in the main column instead of a dialog,
// and the summary is the sidebar's existing count with no rows. L2B replaces
// the re-export line in ../lane-slots.tsx; nothing else changes.
import { Suspense } from "react";
import { useStore } from "@/state/store";
import { usePendingApprovals } from "@/components/usePendingApprovals";
import { useDesktopSurface } from "@/lib/use-surface";
import { LazyBoundary, retryableLazy } from "@/components/LazyBoundary";
import { LazyFallback } from "@/components/LazyFallback";
import type { NeedsSummary, NeedsYouPageProps } from "../shell-contract";

// The page body (today's Inbox) loads on first use, like every other view's page.
const Body = retryableLazy(() => import("./needs-page").then((module) => ({ default: module.NeedsYouPageBody })));

export function NeedsYouPage(props: NeedsYouPageProps) {
  return <LazyBoundary onRetry={Body.retry}><Suspense fallback={<LazyFallback />}><Body.Component {...props} /></Suspense></LazyBoundary>;
}

/** The sidebar's count as it is today (desktop only), with no rows: Today's card then shows the count and the door. */
export function useNeedsSummary(): NeedsSummary {
  const { state } = useStore();
  const desktop = useDesktopSurface();
  const approvals = usePendingApprovals(desktop === true, state.connected);
  return { count: approvals.decisions, stale: approvals.stale, top: [] };
}
