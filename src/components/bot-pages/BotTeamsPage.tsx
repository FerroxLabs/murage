// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: moved out of SettingsPanel.tsx verbatim (behaviour unchanged).
import { Suspense } from "react";
import { t } from "@/lib/i18n";
import { LazyBoundary, retryableLazy } from "../LazyBoundary";
import { SettingsSection } from "./section";
import type { BotPanelCtx } from "./context";

// Bot settings > Teams loads on first open (SPEC-X 13.1): the owner's
// sharing routes are desktop only, and none of it belongs in first paint.
const TeamsSection = retryableLazy(() => import("../BotTeamsSection"));

export function TeamsPart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section, desktop } = ctx;
  return (
    <>
          <SettingsSection id="teams" active={section}>
          <div id="bot-setting-teams" data-setting="bot.teams.teams" className="empty:hidden">{desktop === true && section === "teams" && <LazyBoundary inline onRetry={TeamsSection.retry}><Suspense fallback={<p role="status" className="text-[13px] text-ink-secondary">{t("settings.bot.teams.loading")}</p>}><TeamsSection.Component key={`teams-${bot.id}`} bot={bot} /></Suspense></LazyBoundary>}</div>
          </SettingsSection>
    </>
  );
}
