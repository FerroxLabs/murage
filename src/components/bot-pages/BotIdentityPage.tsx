// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: moved out of SettingsPanel.tsx verbatim (behaviour unchanged).
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { BotProfileAvatarCard } from "../BotProfileAvatarCard";
import { BOT_PROFILE_LIMITS } from "../../../shared/bot-profile";
import { SettingsSection } from "./section";
import { ArchiveOrDeleteRow } from "./BotArchiveRow";
import { Field, inputCls } from "./field";
import type { BotPanelCtx } from "./context";

export function IdentityPart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section, patch, persona, activeState, mascotMotion } = ctx;
  return (
    <>
          <SettingsSection id="identity" active={section}>
          {/* Appearance opens Identity & instructions, always open: a bot's
              looks sit with its name and instructions (Sean, 2026-10-03). */}
          <div id="bot-setting-avatar" data-setting="bot.identity.avatar" className="rounded-xl bg-card p-3">
            <h3 className="mb-2 text-[13px] font-medium">{t("settings.appearance.title")}</h3>
            <BotProfileAvatarCard
              bot={bot}
              activeState={activeState}
              mascotMotion={mascotMotion}
              onPatch={patch}
            />
          </div>
          <div id="bot-setting-name" data-setting="bot.identity.name"><Field label={t("settings.bot.identity.name")}>
            <input
              className={inputCls}
              maxLength={BOT_PROFILE_LIMITS.name}
              value={bot.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field></div>
          <div id="bot-setting-title" data-setting="bot.identity.title"><Field label={t("settings.bot.identity.title")}>
            <input
              className={inputCls}
              maxLength={BOT_PROFILE_LIMITS.title}
              placeholder={t("settings.bot.identity.titlePlaceholder")}
              value={bot.title}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </Field></div>
          {/* Description is NOT a note about the bot. It is pasted verbatim
              into the bot's system prompt on every turn ("About: …"), and it
              is also what a Chief of Staff, the avatar prompt and the team
              manifest read to decide who does the work. The label said
              neither, so people wrote notes where instructions go — and, once
              they realised, wrote voice ("be snarky") into the one field that
              routing reads. Personality below is the field for that. */}
          <div id="bot-setting-instructions" data-setting="bot.identity.instructions"><Field label={t("settings.bot.identity.instructions")}>
            <textarea
              className={cn(inputCls, "min-h-[96px] resize-none")}
              maxLength={BOT_PROFILE_LIMITS.description}
              placeholder={t("settings.bot.identity.instructionsPlaceholder")}
              value={bot.description}
              disabled={bot.descriptionCut === true}
              onChange={(e) => patch({ description: e.target.value })}
            />
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">
              {t("settings.bot.identity.instructionsHint")}
            </p>
          </Field></div>
          <div id="bot-setting-personality" data-setting="bot.identity.personality"><Field label={t("settings.bot.identity.personality")}>
            <textarea
              className={cn(inputCls, "min-h-[64px] resize-none")}
              maxLength={BOT_PROFILE_LIMITS.persona}
              placeholder={t("settings.bot.identity.personalityPlaceholder")}
              value={persona}
              onChange={(e) => patch({ persona: e.target.value })}
            />
            <div className="mt-1.5 flex items-start justify-between gap-3">
              <p className="text-[12px] leading-relaxed text-ink-secondary">
                {t("settings.bot.identity.personalityHint")}
              </p>
              <span className="shrink-0 pt-px text-[11.5px] tabular-nums text-ink-secondary">
                {persona.length}/{BOT_PROFILE_LIMITS.persona}
              </span>
            </div>
          </Field></div>

          <ArchiveOrDeleteRow bot={bot} />
          </SettingsSection>
    </>
  );
}
