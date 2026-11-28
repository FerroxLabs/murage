// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: moved out of SettingsPanel.tsx verbatim (behaviour unchanged).
import { useEffect, useState } from "react";
import { useStore, type Bot } from "@/state/store";
import { stateForBot } from "@/lib/mascot";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { builtInBrowserEnabled } from "@/lib/feature-flags";
import { useDesktopSurface } from "@/lib/use-surface";
import { computerHere } from "@/lib/computer-surface";
import { autoMountsThisComputer, autoNeedsLocalComputerWarning, instanceSupportsLocalComputer, localAutoHostPlatform, localComputerDisabledReason, localComputerSelectable } from "@/lib/local-computer";
import { noLimitsTermsPending, useAcceptNoLimitsTerms } from "../NoLimitsTermsPrompt";
import { defaultModeStep, permissionModeOf, ownerBotPermissions, type PermissionMode } from "@/lib/permission-mode";
import { useLevelChange } from "../approval/use-level-change";
import { useOlderTasks } from "@/lib/use-ensure-task";
import { useBotSettingsNavigation } from "../bot-settings-drafts";
import type { BotSettingsSection } from "../bot-settings-sections";

export function useBotPanel(bot: Bot, section: BotSettingsSection | undefined) {
  const navigate = useBotSettingsNavigation();
  const olderHistory = useOlderTasks("bot", bot.id);
  // The one card in this panel that provisions rather than configures: "This
  // computer" hands a bot the machine, and Cloud opens the Box / VPS backend
  // picker, which is where a managed container gets created and started. Those
  // routes require the desktop marker and the browser door strips it, so from
  // a phone the segmented control was four buttons that 404. See below.
  const desktop = useDesktopSurface();
  const computer = computerHere(desktop);
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localSelectable = localComputerSelectable({ capabilities, providerSupportsLocal });
  const [localAutoWarning, setLocalAutoWarning] = useState<"auto" | "local" | null>(null);
  const [fullAccessWarning, setFullAccessWarning] = useState<{ level: "full" | "unlimited" } | null>(null);
  const hostPlatform = localAutoHostPlatform(capabilities, { harness: state.config?.harness });
  const permissionBot = ownerBotPermissions(bot, state.bots, state.config?.newBots?.permissionLevel);
  const levelChange = useLevelChange({ bot: permissionBot, desktop, drivesComputer: autoMountsThisComputer({ platform: hostPlatform, computer: bot.computer }) });
  const [reviewingTerms, setReviewingTerms] = useState(false);
  const acceptTerms = useAcceptNoLimitsTerms();
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  // The roster carries the first lines of a long description (`descriptionCut`). The whole text is fetched before the field can be
  // edited, so an edit never writes the cut copy back over the rest.
  useEffect(() => {
    if (bot.descriptionCut) dispatch({ type: "ensureBotDetail", botId: bot.id });
  }, [bot.id, bot.descriptionCut, dispatch]);
  const patch = (
    p: Partial<
      Pick<
        Bot,
        | "name"
        | "title"
        | "description"
        | "notifications"
        | "computer"
        | "cloudBackend"
        | "autoStartVps"
        | "color"
        | "mascotExpression"
        | "mascotBody"
        | "avatarUrl"
        | "avatarCrop"
        | "autoApprove"
        | "fullAccess"
        | "noLimits"
        | "fullAccessChannelMessages"
        | "fullAccessSetupRequests"
        | "imageApproval"
        | "imageAskAfter"
        | "autoReview"
        | "speakReplies"
        | "voice"
        | "chiefOfStaff"
        | "approvePeerComms"
        | "composio"
        | "browser"
        | "continuity"
        | "modelSelection"
      >
    > & { acknowledgeLocalAuto?: boolean; acknowledgeFullAccess?: boolean; acknowledgeNoLimits?: boolean; persona?: string },
  ) => {
    dispatch({ type: "updateBot", botId: bot.id, patch: {...p,...(p.modelSelection!==undefined||p.autoApprove!==undefined||p.fullAccess!==undefined||p.noLimits!==undefined?{settingsScope:"defaults" as const}:{})} });
  };
  // The bot's default approval level goes through useLevelChange: a higher
  // pick to Full access or No limits is the confirm card, the rest saves at
  // once with its status line. Two warnings stay here: Auto reaching this
  // computer, and the one-time acknowledgement a bot already standing at Full
  // access or No limits from an older build never gave, which the open
  // conversations apply asks for. The platform is the harness's own
  // (announced on /api/config), not this browser's UA.
  const chooseDefaultMode = (mode: PermissionMode) => {
    const current = permissionModeOf(permissionBot);
    const termsPending = noLimitsTermsPending(state.config);
    if (mode !== current) {
      // New No limits terms are read in No limits' own warning, which accepts them: the confirm card does not.
      if (mode === "unlimited" && termsPending) setFullAccessWarning({ level: "unlimited" });
      else if (mode === "auto" && autoNeedsLocalComputerWarning({ platform: hostPlatform, computer: bot.computer, autoApprove: bot.autoApprove })) setLocalAutoWarning("auto");
      else void levelChange.pick(mode);
      return;
    }
    const step = defaultModeStep(permissionBot, mode, false, termsPending);
    if (step.kind === "full-warning") setFullAccessWarning({ level: "full" });
    else if (step.kind === "no-limits-warning") setFullAccessWarning({ level: "unlimited" });
  };
  // `persona` is validated, persisted and prompted server-side already
  // (shared/bot-profile.ts, server/bot-profile.ts, server/index.ts). The
  // renderer's `Bot` record and `BotUpdatePatch` live in src/state/, which
  // this lane does not own, so it is read through a narrow view until the
  // field lands there. The PATCH body is untyped JSON either way, so the
  // round trip is real today.
  const persona = (bot as { persona?: string }).persona ?? "";
  const activeState = stateForBot(bot);
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const canAutoReview = engine?.capabilities?.approvalReview === true;
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const canUseConnectedApps = engine?.capabilities?.composioMcp === true;
  const canUseVps = engine?.capabilities?.computerMcp === true && engine.driverKind !== "boxAgent";
  const connectedAppsConfigured = state.config?.composio?.configured === true;
  // "A second bot exists" — an archived one is not somebody to report to.
  const hasTeammates = state.bots.filter((candidate) => !candidate.hidden).length > 1;
  const connectedAppsEnabled = bot.composio !== false;
  const canUseBrowser = engine?.capabilities?.browserMcp === true;
  const browserFeature = builtInBrowserEnabled(state.config);
  const browserAllowed = bot.browser !== false;
  const browserEnabled = browserFeature && browserAllowed;

  return { bot, section, navigate, olderHistory, desktop, computer, state, dispatch, capabilities, patch, permissionBot, levelChange, chooseDefaultMode, setLocalAutoWarning, setReviewingTerms, localSelectable, localDisabledReason, persona, activeState, mascotMotion, engine, canAutoReview, canCoordinate, canUseConnectedApps, canUseVps, connectedAppsConfigured, hasTeammates, connectedAppsEnabled, canUseBrowser, browserFeature, browserAllowed, browserEnabled, localAutoWarning, fullAccessWarning, setFullAccessWarning, reviewingTerms, acceptTerms };
}

export type BotPanelCtx = ReturnType<typeof useBotPanel>;
