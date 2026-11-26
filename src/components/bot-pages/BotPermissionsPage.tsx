// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: moved out of SettingsPanel.tsx verbatim (behaviour unchanged).
import { NoLimitsFollowers } from "../NoLimitsFollowers";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { CanTalkToControl } from "../CanTalkToControl";
import { noLimitsTermsPending } from "../NoLimitsTermsPrompt";
import { BotPermissionDefault } from "../BotPermissionDefault";
import { BotImageApproval } from "../BotImageApproval";
import { RememberedApprovals } from "../RememberedApprovals";
import { PEER_CONTACT_LABEL, peerContactHint } from "@/lib/permission-mode";
import { Switch } from "../SettingsPrimitives";
import { SettingsSection } from "./section";
import type { BotPanelCtx } from "./context";

export function PermissionsPeersPart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section, desktop, patch, permissionBot, canCoordinate } = ctx;
  return (
    <>
          <SettingsSection id="permissions" active={section}>
          {desktop === true && <NoLimitsFollowers />}
          <div id="bot-setting-can-talk" data-setting="bot.permissions.can-talk" className="empty:hidden"><CanTalkToControl bot={bot} /></div>
          <div id="bot-setting-peers" data-setting="bot.permissions.peers" className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">
                {PEER_CONTACT_LABEL}
              </div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {peerContactHint(permissionBot)}
              </div>
            </div>
            <Switch
              checked={Boolean(bot.approvePeerComms)}
              aria-label={PEER_CONTACT_LABEL}
              disabled={!bot.approvePeerComms && !canCoordinate}
              onClick={() => patch({ approvePeerComms: !bot.approvePeerComms })}
              title={!bot.approvePeerComms && !canCoordinate ? t("settings.bot.peer.engineCannot") : undefined}
              className="disabled:cursor-not-allowed"
            />
          </div>

          </SettingsSection>
    </>
  );
}

export function PermissionsLevelPart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section, desktop, computer, state, patch, permissionBot, levelChange, chooseDefaultMode, setReviewingTerms, canAutoReview } = ctx;
  return (
    <>
          <SettingsSection id="permissions" active={section}>
          <div id="bot-setting-level" data-setting="bot.permissions.level" className="empty:hidden"><BotPermissionDefault
            botId={bot.id}
            botName={bot.name}
            bot={permissionBot}
            change={levelChange}
            onThisComputer={bot.computer === "local"}
            desktop={desktop}
            termsPending={noLimitsTermsPending(state.config)}
            onReviewTerms={() => setReviewingTerms(true)}
            onChoose={chooseDefaultMode}
            onOption={(key, value) => patch(key === "fullAccessChannelMessages" ? { fullAccessChannelMessages: value } : { fullAccessSetupRequests: value })}
          />

          </div>

          <div id="bot-setting-images" data-setting="bot.permissions.images" className="empty:hidden"><BotImageApproval
            bot={bot}
            desktop={desktop}
            onChoose={(setting) => patch({ imageApproval: setting })}
            onAskAfter={(value) => patch({ imageAskAfter: value })}
          />

          </div>

          <div id="bot-setting-always-allowed" data-setting="bot.permissions.always-allowed" className="empty:hidden"><RememberedApprovals bot={bot} desktop={desktop} computer={computer} /></div>

          <div id="bot-setting-review" data-setting="bot.permissions.review" className="rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">{t("settings.bot.review.title")}</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {canAutoReview
                ? t("settings.bot.review.supported")
                : t("settings.bot.review.unsupported")}
            </div>
            <div className="mt-3 flex gap-1 rounded-lg bg-inset p-0.5">
              {(
                [
                  ["off", t("settings.bot.review.off"), t("settings.bot.review.offHint")],
                  ["shadow", t("settings.bot.review.shadow"), t("settings.bot.review.shadowHint")],
                  ["enforce", t("settings.bot.review.enforce"), t("settings.bot.review.enforceHint")],
                ] as const
              ).map(([value, label, hint]) => {
                const current = bot.autoReview === "shadow" || bot.autoReview === "enforce" ? bot.autoReview : "off";
                const disabled = value !== "off" && !canAutoReview;
                return (
                  <button
                    key={value}
                    title={disabled ? t("settings.bot.review.notSupported") : hint}
                    disabled={disabled}
                    onClick={() => patch({ autoReview: value })}
                    className={cn(
                      "flex-1 rounded-md px-2.5 py-1.5 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-40",
                      current === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          </SettingsSection>
    </>
  );
}
