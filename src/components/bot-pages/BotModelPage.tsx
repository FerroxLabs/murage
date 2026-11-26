// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: moved out of SettingsPanel.tsx verbatim (behaviour unchanged).
import { ModelRouteRow } from "../ModelRouteRow";
import { ModelPicker } from "../ModelPicker";
import { BotFollowModelRow, LimitBackupRow } from "../ThreadFollowControls";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { effortLabel } from "@/lib/effort-label";
import { SettingsSection } from "./section";
import type { BotPanelCtx } from "./context";

export function ModelPart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section, desktop, dispatch, patch, engine } = ctx;
  return (
    <>
          <SettingsSection id="model" active={section}>
          <div id="bot-setting-model" data-setting="bot.model.model" className="rounded-xl bg-card p-4">
            <ModelRouteRow engine={engine} manage={() => dispatch({ type: "toggleAppSettings", open: true, section: "models", anchor: "engines-heading" })} className="mb-3" />
            <ModelPicker
              bot={bot}
              contained
              label={
                <div>
                  <div className="text-[15px] font-medium text-ink">{t("settings.bot.model.title")}</div>
                  <div className="mt-0.5 text-[13px] text-ink-secondary">
                    {t("slik.botModelDetail")}
                  </div>
                </div>
              }
            />
            <BotFollowModelRow bot={bot} />
          </div>
          <div id="bot-setting-backup" data-setting="bot.model.backup" className="empty:hidden">{desktop && <LimitBackupRow bot={bot} />}</div>

          {!!engine?.capabilities?.effortLevels?.length && (
            <div id="bot-setting-effort" data-setting="bot.model.effort" className="rounded-xl bg-card p-4">
              <div className="text-[15px] font-medium text-ink">{t("settings.bot.effort.title")}</div>
              {/* Says what the app does, not what the engine ends up at:
                  Codex applies a level to the whole thread and has no way to
                  take one back, so "currently: engine default" was a promise
                  we could not keep for a thread that had already been sent
                  one. Sending nothing is true on every engine. */}
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {bot.modelSelection.effort ? t("settings.bot.effort.note") : t("settings.bot.effort.noteEngineDecides")}
              </div>
              <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
                {([undefined, ...engine.capabilities.effortLevels] as const).map((level, i) => (
                  <button
                    key={level ?? "default"}
                    aria-pressed={bot.modelSelection.effort === level}
                    onClick={() => patch({ modelSelection: { ...bot.modelSelection, effort: level } })}
                    className={cn(
                      "flex-1 py-1.5 text-[13px] capitalize",
                      i > 0 && "border-l border-hairline/40",
                      bot.modelSelection.effort === level
                        ? "bg-control text-ink"
                        : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                    )}
                  >
                    {effortLabel(level)}
                  </button>
                ))}
              </div>
            </div>
          )}

          </SettingsSection>
    </>
  );
}
