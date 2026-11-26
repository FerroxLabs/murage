// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: moved out of SettingsPanel.tsx verbatim (behaviour unchanged).
import { BotEmailSectionHost } from "../BotEmailSettings";
import { SettingsSection } from "./section";
import type { BotPanelCtx } from "./context";

export function EmailPart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section } = ctx;
  return (
    <>
          <SettingsSection id="email" active={section}>
          <div id="bot-setting-email" data-setting="bot.email.email" className="empty:hidden"><BotEmailSectionHost bot={bot} /></div>
          </SettingsSection>
    </>
  );
}
