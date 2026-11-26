// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: moved out of SettingsPanel.tsx verbatim (behaviour unchanged).
import { BotShapesPanel } from "../BotShapesPanel";
import { SettingsSection } from "./section";
import type { BotPanelCtx } from "./context";

export function ShapesPart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section, desktop } = ctx;
  return (
    <>
          {/* Everything that goes into this bot's instructions, in the order it
              reads it (server/bot-shapes.ts). The route is desktop only: it
              shows the bot's notes and its team's brief. Read again each
              time the section is shown. */}
          <SettingsSection id="shapes" active={section}>
          <div id="bot-setting-shapes" data-setting="bot.shapes.shapes" className="empty:hidden">{desktop === true && <BotShapesPanel key={`shapes-${bot.id}`} bot={bot} active={section === undefined || section === "shapes"} />}</div>
          </SettingsSection>
    </>
  );
}
