// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: moved out of SettingsPanel.tsx verbatim (behaviour unchanged).
import { LearningSettings } from "../LearningSettings";
import { SettingsSection } from "./section";
import type { BotPanelCtx } from "./context";

export function LearningPart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section, desktop } = ctx;
  return (
    <>
          <SettingsSection id="learning" active={section}>
          <div id="bot-setting-learning" data-setting="bot.learning.learning" className="empty:hidden">{desktop === true && <LearningSettings key={`learning-${bot.id}`} bot={bot} />}</div>
          </SettingsSection>
    </>
  );
}
