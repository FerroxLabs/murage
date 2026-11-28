// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: moved out of SettingsPanel.tsx verbatim (behaviour unchanged).
import { BotSkillsPanel } from "../BotSkillsPanel";
import { SettingsSection } from "./section";
import type { BotPanelCtx } from "./context";

export function SkillsPart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section } = ctx;
  return (
    <>
          {/* "Add a skill" picks and adds skills right here, inside this
              window (skills/SkillPicker): nothing to close, nothing behind. */}
          <SettingsSection id="skills" active={section}>
          <div id="bot-setting-skills" data-setting="bot.skills.skills" className="empty:hidden"><BotSkillsPanel key={`skills-${bot.id}`} bot={bot} /></div>
          </SettingsSection>
    </>
  );
}
