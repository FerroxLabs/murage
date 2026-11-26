// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: moved out of SettingsPanel.tsx verbatim (behaviour unchanged).
import { t } from "@/lib/i18n";
import { requestNotificationPermission } from "@/lib/notify";
import { VoiceSettings } from "../VoiceSettings";
import { BotCallsSettings } from "../BotCallsSettings";
import { Switch } from "../SettingsPrimitives";
import { SettingsSection } from "./section";
import type { BotPanelCtx } from "./context";

export function VoicePart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section, desktop, patch } = ctx;
  return (
    <>
          <SettingsSection id="voice" active={section}>
          <div id="bot-setting-voice" data-setting="bot.voice.voice" className="empty:hidden"><VoiceSettings bot={bot} onPatch={patch} /></div>

          <div id="bot-setting-notifications" data-setting="bot.voice.notifications" className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">
                {t("settings.bot.notifications.title")}
              </div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {t("settings.bot.notifications.note")}
              </div>
            </div>
            <Switch
              checked={bot.notifications}
              aria-label={t("settings.bot.notifications.switchLabel")}
              onClick={() => {
                const enabled = !bot.notifications;
                if (enabled) void requestNotificationPermission();
                patch({ notifications: enabled });
              }}
            />
          </div>
          {/* bot calls (design BOT-CALLS-109 3): on the desktop, like Settings > Notifications > Calls */}
          {desktop === true && <BotCallsSettings key={`calls-${bot.id}`} botId={bot.id} botName={bot.name} />}
          </SettingsSection>
    </>
  );
}
