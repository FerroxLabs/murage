// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: moved out of SettingsPanel.tsx verbatim (behaviour unchanged).
import { t } from "@/lib/i18n";
import { SettingsSection } from "./section";
import { BotRoutineRow } from "./BotRoutineRow";
import type { BotPanelCtx } from "./context";

export function RoutinesPart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section, navigate, state, dispatch } = ctx;
  return (
    <>
          <SettingsSection id="routines" active={section}>
          <div id="bot-setting-routines" data-setting="bot.routines.routines" className="space-y-4">
          {state.routines.filter(routine => routine.botId === bot.id).map(routine => <BotRoutineRow key={routine.id} routine={routine} onSaved={saved => dispatch({ type: "routinePatched", routine: saved })} />)}
          {!state.routines.some(routine => routine.botId === bot.id) && <p className="text-[13px] text-ink-secondary">{t("settings.bot.routines.none")}</p>}
          <button type="button" onClick={() => navigate(() => dispatch({ type: "showRoutines" }))} className="min-h-10 rounded-lg bg-control px-3 py-2 text-[13px]">{t("settings.bot.routines.open")}</button>
          </div>
          </SettingsSection>
    </>
  );
}
