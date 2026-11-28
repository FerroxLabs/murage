// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: moved out of SettingsPanel.tsx verbatim (behaviour unchanged).
import { useStore, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import { usageCaption } from "@/lib/usage-card";
import { botUsage, formatTokens, formatUsd, freshTokens, hasFiniteCost, usageDetail } from "@/lib/usage";
import { useBotSettingsNavigation } from "../bot-settings-drafts";
import { SettingsSection } from "./section";
import type { BotPanelCtx } from "./context";

/** What this bot has spent across its tasks. Cost is captioned by how the
 * engine is billed — on a subscription the figure is an equivalent. */
function BotUsageCard({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const navigate = useBotSettingsNavigation();
  const usage = botUsage(bot);
  const instance = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
  if (usage.turns === 0) return null;
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-baseline justify-between">
        <div className="text-[15px] font-medium text-ink">{t("usageCard.title")}</div>
        <button
          onClick={() => navigate(() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" }))}
          className="text-[12px] text-ink-secondary hover:text-ink"
        >
          {t("usageCard.allBots")}
        </button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-[13px]">
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">{t("usageCard.colTurns")}</div>
          <div className="mt-0.5 tabular-nums text-ink">{usage.turns}</div>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">{t("usageCard.colTokens")}</div>
          <div className="mt-0.5 tabular-nums text-ink" title={usageDetail(usage)}>
            {formatTokens(freshTokens(usage))}
          </div>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">{t("usageCard.colCost")}</div>
          <div className="mt-0.5 tabular-nums text-ink">{hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : t("usageCard.unknown")}</div>
        </div>
      </div>
      <div className="mt-2 text-[12px] text-ink-secondary">
        {hasFiniteCost(usage.costUsd) ? t("usageCard.costLine", { caption: usageCaption(instance?.snapshot.billing) }) : t("usageCard.unpriced")}
      </div>
    </div>
  );
}

export function UsagePart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section } = ctx;
  return (
    <>
          <SettingsSection id="usage" active={section}>
          <div id="bot-setting-usage" data-setting="bot.usage.usage" className="space-y-4"><BotUsageCard bot={bot} />
          {botUsage(bot).turns === 0 && <p className="text-[13px] text-ink-secondary">{t("usageCard.empty")}</p>}</div>
          </SettingsSection>
    </>
  );
}
