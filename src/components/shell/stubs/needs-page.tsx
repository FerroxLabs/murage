// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The body of L2A's Needs you stand-in (needs-stub.tsx), loaded on first use so
// the Inbox it shows stays out of the first paint (scripts/check-bundle-budget.mjs).
import { useState } from "react";
import { useStore } from "@/state/store";
import { openInboxLink } from "@/lib/open-inbox-link";
import { openFiles } from "@/components/Files";
import { Inbox } from "@/components/Inbox";
import { healthDestination } from "@/components/HealthCard";
import { t } from "@/lib/i18n";
import { OpenBotListButton } from "@/components/OpenBotListButton";
import type { NeedsYouPageProps } from "../shell-contract";

export function NeedsYouPageBody({ tab }: NeedsYouPageProps) {
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
          // The Files pane lives in the chat view: go back to the open chat first (the dialog this page replaced sat over it).
          if (link.artifactId) { dispatch({ type: "select", id: state.selectedId }); openFiles({ artifactId: link.artifactId }); return; }
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
