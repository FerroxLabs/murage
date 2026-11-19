// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Usage (SETTINGS-LOCKED-1019.md 3.16): what your bots used this month. Six cards, each its own registry entry: this month by
// bot, learning, learning limit, spend notice, by routine, then account usage. Simple filters this shared order using the
// existing manifest. Every surface shows usage live; the learning limit is edited on the computer.
import type { SettingsPageCard, SettingsPageProps } from "@/lib/settings-page-contract";
import { LearningLimitCard } from "../../LearningLimitCard";
import { PlanUsageCard } from "../../PlanUsageCard";
import { SpendLimitCard } from "../../SpendLimitCard";
import { UsageByBotCard, UsageByRoutineCard, UsageLearningCard } from "../../UsageSection";
import { PageCards } from "../PageCards";

/** The cards of Usage, in page order. `memory.limit` moved here from Memory and keeps its id and its anchor. */
export function usageCards(): SettingsPageCard[] {
  return [
    { id: "usage.by-bot", anchor: "usage-heading", simple: true, render: () => <UsageByBotCard /> },
    { id: "usage.learning", anchor: "usage-learning-heading", simple: false, render: () => <UsageLearningCard /> },
    { id: "memory.limit", anchor: "memory-limit-heading", simple: false, render: () => <LearningLimitCard /> },
    { id: "usage.spend-limit", anchor: "spend-limit-heading", simple: true, render: () => <SpendLimitCard /> },
    { id: "usage.by-routine", anchor: "usage-by-routine-heading", simple: true, render: () => <div data-setting-control="usage-by-routine-heading"><UsageByRoutineCard /></div> },
    { id: "usage.account", anchor: "plan-usage-heading", simple: true, render: () => <PlanUsageCard /> },
  ];
}

export default function UsagePage({ mode }: SettingsPageProps) {
  return <PageCards cards={usageCards()} mode={mode} />;
}
