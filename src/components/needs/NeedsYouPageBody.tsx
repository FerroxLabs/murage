// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Needs you door's page (UX L2B), loaded on first use. The Inbox's data
// path (GET /api/inbox, cursors, the seven tabs and their purpose lines) in
// door mode: one line per owed row, the card opening in place, keys, bot
// chips and snooze with Undo. Health stays one quiet click away above it.
import { useState } from "react";
import { useStore } from "@/state/store";
import { openInboxLink } from "@/lib/open-inbox-link";
import { openFiles } from "@/components/Files";
import { Inbox } from "@/components/Inbox";
import { t } from "@/lib/i18n";
import { OpenBotListButton } from "@/components/OpenBotListButton";
import { StatusDot, healthLevelWords } from "@/components/shell/StatusDot";
import { OtherWorkspacesStrip } from "@/components/shell/lane-slots";
import { MonthNeedsRow } from "@/components/today/MonthCardView";
import type { NeedsYouPageProps } from "@/components/shell/shell-contract";

export function NeedsYouPageBody({ tab, onTabChange, health }: NeedsYouPageProps) {
  const { state, dispatch } = useStore();
  const [error, setError] = useState<string>();
  return (
    <main aria-label={t("ux.l2a.door.needsYou")} className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-2 px-4 pt-2 sm:px-6">
        <div className="md:hidden"><OpenBotListButton /></div>
        <button type="button" data-needs-health-link aria-label={t("ux.l2b.health.linkLabel", { level: healthLevelWords(health?.level ?? "unknown") })} onClick={() => dispatch({ type: "showHealth" })}
          className="ml-auto inline-flex min-h-10 items-center gap-2 rounded-lg px-2 text-[13px] text-ink-secondary hover:bg-raised-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
          <StatusDot level={health?.level ?? "unknown"} spoken={false} />{t("ux.l2b.health.link")}
        </button>
      </div>
      {/* An agency's other owned homes, above the tabs (L6C); nothing for a solo owner. */}
      <div className="mx-auto w-full max-w-4xl px-4 sm:px-6">
        <OtherWorkspacesStrip onOpenWorkspace={() => onTabChange("decisions")} />
        {/* The monthly limit heads-up (UX-L2C): a notice only, with Raise limit and Leave it, as on Today. */}
        <div className="pt-2 empty:hidden"><MonthNeedsRow onOpenUsage={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })} /></div>
      </div>
      {error && <p role="alert" className="px-4 pt-3 text-[13px] text-danger">{error}</p>}
      <Inbox
        door
        initialView={tab}
        onViewChange={onTabChange}
        refreshKey={state.routineRuns.length}
        onOpen={(link) => {
          // The Files pane lives in the chat view: go back to the open chat first.
          if (link.artifactId) { dispatch({ type: "select", id: state.selectedId }); openFiles({ artifactId: link.artifactId }); return; }
          setError(undefined);
          void openInboxLink(link, state, dispatch).catch((cause) => setError(cause instanceof Error ? cause.message : t("inbox.openResultError")));
        }}
        onOpenBackups={() => dispatch({ type: "toggleAppSettings", open: true, section: "backups" })}
        onOpenSettingsPage={(section, anchor) => dispatch({ type: "toggleAppSettings", open: true, section, ...(anchor ? { anchor } : {}) })}
        onOpenLearning={(botId) => { dispatch({ type: "select", id: botId }); dispatch({ type: "toggleSettings", open: true, intent: { section: "learning" } }); }}
        onOpenMemory={(subject) => {
          if (subject.kind === "bot") { dispatch({ type: "select", id: subject.id }); window.dispatchEvent(new CustomEvent("murage:open-memory", { detail: { botId: subject.id } })); }
          else dispatch({ type: "toggleAppSettings", open: true, section: "memory" });
        }}
      />
    </main>
  );
}
