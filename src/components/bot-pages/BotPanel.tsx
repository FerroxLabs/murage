// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: moved out of SettingsPanel.tsx verbatim (behaviour unchanged).
import { ChevronLeft, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { LocalComputerAutoWarning } from "../LocalComputerAutoWarning";
import { FullAccessWarning } from "../FullAccessWarning";
import { OverviewHeadPart, OverviewRolePart } from "./BotOverviewPage";
import { IdentityPart } from "./BotIdentityPage";
import { PermissionsPeersPart, PermissionsLevelPart } from "./BotPermissionsPage";
import { AccessAppsPart, AccessComputerPart, AccessFolderPart } from "./BotAccessPage";
import { ModelPart } from "./BotModelPage";
import { UsagePart } from "./BotUsagePage";
import { EmailPart } from "./BotEmailPage";
import { MemoryPart } from "./BotMemoryPage";
import { ShapesPart } from "./BotShapesPage";
import { SkillsPart } from "./BotSkillsPage";
import { LearningPart } from "./BotLearningPage";
import { VoicePart } from "./BotVoicePage";
import { RoutinesPart } from "./BotRoutinesPage";
import { TeamsPart } from "./BotTeamsPage";
import { HistoryPart } from "./BotHistoryPage";
import { useBotPanel } from "./context";
import type { Bot } from "@/state/store";
import type { BotSettingsSection } from "../bot-settings-sections";

export function BotPanel({ bot, section, embedded = false }: { bot: Bot; section?: BotSettingsSection; embedded?: boolean }) {
  const ctx = useBotPanel(bot, section);
  const { dispatch, state, patch, levelChange, localAutoWarning, setLocalAutoWarning, fullAccessWarning, setFullAccessWarning, reviewingTerms, setReviewingTerms, acceptTerms, engine } = ctx;
  return (
    <>
    <aside
      className={embedded ? "relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip bg-panel" : cn(
        // Clip without creating a second scroll container. overflow:hidden
        // still lets focus/scrollIntoView scroll this aside past its header.
        "animate-panel-in relative z-20 flex h-full min-h-0 flex-col overflow-clip border-l border-hairline/40 bg-panel",
        "md:w-[400px] md:shrink-0",
        // Same collapse as InspectorPanel: a fixed 400px column beside the chat
        // takes main to 0px wide below ~800px. Below md the profile covers the
        // chat; its header already carries the "Collapse agent profile" back
        // button, so there is a way out.
        "max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full",
        // Covering the chat means covering its header's status-bar inset too.
        "max-md:pt-[var(--inset-top)] max-md:pb-[var(--inset-bottom)]",
      )}
    >
      {/* The native wrapper owns its own header. */}
      {!embedded && <div className="flex shrink-0 items-center justify-between px-4 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          aria-label={t("settings.bot.header.collapse")}
          title={t("settings.bot.header.collapse")}
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-[15px] font-semibold text-ink">{t("settings.bot.header.title")}</span>
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          aria-label={t("settings.bot.header.close")}
          title={t("settings.bot.header.close")}
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>}

      <div data-settings-scroll className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 [--box-pad:1.25rem]">
        <div className="flex flex-col gap-4 pt-4">
          {/* Below md this panel covers the chat, and the chat is where the
              app's error banner renders — a refused role change would land
              behind it with nothing on screen to explain the snap-back. */}
          {state.error && (
            <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-danger">
              {state.error}
            </div>
          )}
          <OverviewHeadPart ctx={ctx} />
          <IdentityPart ctx={ctx} />

          <OverviewRolePart ctx={ctx} />


          <PermissionsPeersPart ctx={ctx} />
          <AccessAppsPart ctx={ctx} />
          <ModelPart ctx={ctx} />
          <AccessComputerPart ctx={ctx} />
          <UsagePart ctx={ctx} />
          <AccessFolderPart ctx={ctx} />
          <EmailPart ctx={ctx} />


          <MemoryPart ctx={ctx} />


          <ShapesPart ctx={ctx} />


          <SkillsPart ctx={ctx} />
          <LearningPart ctx={ctx} />


          <PermissionsLevelPart ctx={ctx} />
          <VoicePart ctx={ctx} />
          <RoutinesPart ctx={ctx} />
          <TeamsPart ctx={ctx} />
          <HistoryPart ctx={ctx} />
        </div>
      </div>
    </aside>
    <LocalComputerAutoWarning
      open={localAutoWarning !== null}
      mode="auto"
      onCancel={() => setLocalAutoWarning(null)}
      onConfirm={() => {
        if (localAutoWarning === "auto") void levelChange.pick("auto");
        if (localAutoWarning === "local") patch({ computer: "local", acknowledgeLocalAuto: true });
        setLocalAutoWarning(null);
      }}
    />
    <FullAccessWarning
      open={fullAccessWarning !== null}
      botName={bot.name}
      level={fullAccessWarning?.level ?? "full"}
      scope="bot"
      openClaw={engine?.driverKind === "openclawAgent"}
      onThisComputer={false}
      onCancel={() => setFullAccessWarning(null)}
      onConfirm={() => {
        if (fullAccessWarning) patch({
          autoApprove: true, fullAccess: true,
          ...(fullAccessWarning.level === "unlimited" ? { noLimits: true, acknowledgeNoLimits: true } : { noLimits: false, acknowledgeFullAccess: true }),
        });
        if (fullAccessWarning?.level === "unlimited") dispatch({ type: "noLimitsTermsAccepted" });
        setFullAccessWarning(null);
      }}
    />
    <FullAccessWarning
      open={reviewingTerms}
      botName={bot.name}
      level="unlimited"
      terms
      openClaw={engine?.driverKind === "openclawAgent"}
      onThisComputer={false}
      onCancel={() => setReviewingTerms(false)}
      onConfirm={() => { setReviewingTerms(false); void acceptTerms(); }}
    />
    </>
  );
}

