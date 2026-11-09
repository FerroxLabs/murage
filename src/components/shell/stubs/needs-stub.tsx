// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { LazyOverlay } from "@/components/LazyOverlay";
//
// L2A STAND-IN for L2B's Needs you door (src/components/needs/NeedsYouPage.tsx).
// It keeps the contract's names and props so the shell works before L2B
// merges: the page is today's Inbox, in the main column instead of a dialog,
// and the summary is the sidebar's existing count with no rows. L2B replaces
// the re-export line in ../lane-slots.tsx; nothing else changes.
import { useStore } from "@/state/store";
import { usePendingApprovals } from "@/components/usePendingApprovals";
import { useDesktopSurface } from "@/lib/use-surface";
import { retryableLazy } from "@/components/LazyBoundary";
import type { NeedsSummary, NeedsYouPageProps } from "../shell-contract";

// The page body (today's Inbox) loads on first use, like every other view's page.
const Body = retryableLazy(() => import("./needs-page").then((module) => ({ default: module.NeedsYouPageBody })));

export function NeedsYouPage(props: NeedsYouPageProps) {
  const { dispatch } = useStore();
  return <LazyOverlay name="page-needs-you-stub" kind="page" covers="while-loading" onRetry={Body.retry} onDismiss={props.onLeave ?? (() => dispatch({ type: "showToday" }))}><Body.Component {...props} /></LazyOverlay>;
}

/** The sidebar's count as it is today (desktop only), with no rows: Today's card then shows the count and the door. */
export function useNeedsSummary(): NeedsSummary {
  const { state } = useStore();
  const desktop = useDesktopSurface();
  const approvals = usePendingApprovals(desktop === true, state.connected);
  return { count: approvals.decisions, stale: approvals.stale, top: [], healthLevel: approvals.healthLevel };
}
