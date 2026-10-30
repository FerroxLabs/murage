// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L2A STAND-IN for L2B's Needs you door (src/components/needs/NeedsYouPage.tsx).
// It keeps the contract's names and props so the shell works before L2B
// merges: the page is today's Inbox, in the main column instead of a dialog,
// and the summary is the sidebar's existing count with no rows. L2B replaces
// the re-export line in ../lane-slots.tsx; nothing else changes.
import { useState } from "react";
import { useStore } from "@/state/store";
import { openInboxLink } from "@/lib/open-inbox-link";
import { openFiles } from "@/components/Files";
import { Inbox } from "@/components/Inbox";
import { healthDestination } from "@/components/HealthCard";
import { usePendingApprovals } from "@/components/usePendingApprovals";
import { useDesktopSurface } from "@/lib/use-surface";
import { t } from "@/lib/i18n";
import { OpenBotListButton } from "@/components/OpenBotListButton";
import type { NeedsSummary, NeedsYouPageProps } from "../shell-contract";

export function NeedsYouPage({ tab }: NeedsYouPageProps) {
  const { state, dispatch } = useStore();
  const [error, setError] = useState<string>();
  return (
    <main aria-label={t("ux.l2a.door.needsYou")} className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      {/* Phones only (OpenBotListButton.tsx): the way back to the rail drawer. */}
      <div className="px-4 pt-3 md:hidden"><OpenBotListButton /></div>
      {error && <p role="alert" className="px-4 pt-3 text-[13px] text-danger">{error}</p>}
      <Inbox
        key={tab}
        initialView={tab}
        refreshKey={state.routineRuns.length}
        onOpen={(link) => {
          if (link.artifactId) { openFiles({ artifactId: link.artifactId }); return; }
          setError(undefined);
          void openInboxLink(link, state, dispatch).catch((cause) => setError(cause instanceof Error ? cause.message : t("inbox.openResultError")));
        }}
        onOpenBackups={() => dispatch({ type: "toggleAppSettings", open: true, section: "backups" })}
        onOpenHealthAction={(action) => { const to = healthDestination(action); if (to) dispatch({ type: "toggleAppSettings", open: true, section: to.section, ...(to.anchor ? { anchor: to.anchor } : {}) }); }}
        onOpenLearning={(botId) => { dispatch({ type: "select", id: botId }); dispatch({ type: "toggleSettings", open: true, intent: { section: "learning" } }); }}
        onOpenMemory={(subject) => {
          if (subject.kind === "bot") { dispatch({ type: "select", id: subject.id }); window.dispatchEvent(new CustomEvent("murage:open-memory", { detail: { botId: subject.id } })); }
          else dispatch({ type: "toggleAppSettings", open: true, section: "memory" });
        }}
      />
    </main>
  );
}

/** The sidebar's count as it is today (desktop only), with no rows: Today's card then shows the count and the door. */
export function useNeedsSummary(): NeedsSummary {
  const { state } = useStore();
  const desktop = useDesktopSurface();
  const approvals = usePendingApprovals(desktop === true, state.connected);
  return { count: approvals.decisions, stale: approvals.stale, top: [] };
}
