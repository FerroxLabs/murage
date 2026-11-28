// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: moved out of SettingsPanel.tsx verbatim (behaviour unchanged).
import { t } from "@/lib/i18n";
import { BotRoleControl } from "../BotRoleControl";
import { BotSetupAction } from "../BotIntakeCard";
import { LearningOverviewLine } from "../LearningOverviewLine";
import { activeSettingsRole, settingsRoleLabel } from "../bot-settings-sections";
import { botRoleTitle } from "@/lib/bot-role";
import { SettingsSection } from "./section";
import type { BotPanelCtx } from "./context";

export function OverviewHeadPart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section, desktop, hasTeammates } = ctx;
  return (
    <>
          <SettingsSection id="overview" active={section}>
          {/* What this bot is FOR comes first. The avatar studio used to open
              the panel, with the purpose and the role below the fold. */}
          <div id="bot-setting-setup" data-setting="bot.overview.setup" className="space-y-4 empty:hidden">
          <BotSetupAction bot={bot} />
          {desktop === true && <LearningOverviewLine key={`learning-line-${bot.id}`} botId={bot.id} />}
          </div>
          {/* An org chart needs an org. With one bot in the workspace there is
              nobody to lead and nobody to report to, so the role summary and
              the Role control below are both hidden until a second bot
              exists. */}
          {hasTeammates && <div className="rounded-xl bg-card p-4 text-[13px]">
            <p className="font-medium">{botRoleTitle(bot)}</p>
            <p className="mt-1 text-ink-secondary">{bot.title || t("settings.bot.overview.noTitle")}{bot.section ? ` · ${bot.section}` : ""}</p>
            {bot.installedPackage?.sourceRole && <div className="mt-3 border-t border-hairline/40 pt-3">
              <p>{t("settings.bot.overview.importedRole", { role: settingsRoleLabel(bot.installedPackage.sourceRole) })}</p>
              {bot.installedPackage.sourceTeam && <p className="mt-1">{t("settings.bot.overview.importedTeam", { team: bot.installedPackage.sourceTeam })}</p>}
              <p className="mt-2 text-ink-secondary">{bot.installedPackage.sourceRole === activeSettingsRole(bot)
                ? t("settings.bot.overview.roleMatches")
                : t("settings.bot.overview.roleInactive")}</p>
              <p className="mt-1 text-ink-secondary">{t("settings.bot.overview.noGrant")}</p>
            </div>}
          </div>}
          </SettingsSection>
    </>
  );
}

export function OverviewRolePart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section, canCoordinate, hasTeammates } = ctx;
  return (
    <>
          {/* SETUP LIVES HERE, not in the composer dock.
              Beside the role control because this is the same kind of
              question — what IS this bot — and because a person arrives at
              this panel on purpose. The composer version renders only for a
              genuinely new agent; this one is always reachable, and warns
              before it touches an agent that already has skills, a
              description, or a conversation behind it. */}
          <SettingsSection id="overview" active={section}>
          <div id="bot-setting-role" data-setting="bot.overview.role" className="empty:hidden">{hasTeammates && <BotRoleControl bot={bot} canCoordinate={canCoordinate} />}</div>
          </SettingsSection>
    </>
  );
}
