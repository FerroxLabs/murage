// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Connected apps (SETTINGS-LOCKED-1019.md 3.11): the apps you connect once and the tools your bots can use. Simple shows
// the apps card and the tools (MCP) card; Advanced adds bot email, HighLevel and phone calls. One list of cards, filtered by
// the shell (PageCards). Remote surfaces retain app/email readouts and stub computer-only actions.
import { Suspense, useEffect, useId, useState } from "react";
import { cloudCardHidden } from "@/lib/cloud-settings";
import { t } from "@/lib/i18n";
import type { SettingsPageCard, SettingsPageProps } from "@/lib/settings-page-contract";
import { settingsSectionLabel } from "@/lib/settings-sections";
import { useStore, type AppSettingsSection } from "@/state/store";
import { BotEmailAccountCard } from "../../BotEmailSettings";
import { ClaudeCodeImportCard } from "../../ClaudeCodeImportCard";
import { HighLevelSettings } from "../../HighLevelSettings";
import { LazyBoundary, retryableLazy } from "../../LazyBoundary";
import { Card } from "../../SettingsPrimitives";
import { ComputerOnlyStub } from "../../SettingsStub";
import { PageCards } from "../PageCards";
import { PluginsPanel } from "../../PluginsPanel";
import { McpServersPanel } from "../../McpServersPanel";
import { ChannelsPageBody, channelsCards } from "./ChannelsPage";
import { BotEmailReadout } from "./BotEmailReadout";
import { settingsTabKeys } from "./settings-tab-keys";

const PhoneCallsSection = retryableLazy(() => import("../../PhoneCallsSettings"));

const linkButton = "rounded px-0.5 font-medium text-accent-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";
/** One catalog/account component owns both views, including authorization and its retained drafts. */
export function ConnectedAppsCard({ readOnly = false }: { readOnly?: boolean }) {
  const { state, dispatch } = useStore();
  const go = (section: AppSettingsSection) => dispatch({ type: "toggleAppSettings", open: true, section });
  return (
    <>
      <Card title={t("settings.section.connections")} subtitle={t("settings.connections.note")}>
        <div className="flex flex-col gap-4">
          {state.config?.composio?.mode === "managed" ? (
            <div className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[13px] text-success">{t("settings.connections.ready")}</div>
          ) : null}
          <PluginsPanel embedded readOnly={readOnly} />
        </div>
      </Card>
      {readOnly && <ComputerOnlyStub anchor="connections-heading" />}
      {/* 0.1.62 only: image generation, web search and transcription keys used to sit on this page, and an old notice or habit still lands here looking for them. */}
      <p className="px-1 text-[12.5px] leading-relaxed text-ink-secondary">
        {t("settings.connections.moved")}{" "}
        <button type="button" onClick={() => go("images")} className={linkButton}>{settingsSectionLabel("images")}</button>
        {" · "}
        <button type="button" onClick={() => go("webSearch")} className={linkButton}>{settingsSectionLabel("webSearch")}</button>
        {" · "}
        <button type="button" onClick={() => go("voice")} className={linkButton}>{settingsSectionLabel("voice")}</button>
        {" · "}
        <button type="button" onClick={() => go("models")} className={linkButton}>{t("settings.models.pasteTitle")}</button>
      </p>
    </>
  );
}

/** The tools card: the servers panel runs this computer's servers, which a Cloud window's bridge refuses, so a Cloud window gets the stub. */
export function McpToolsCard({ cloud }: { cloud: boolean }) {
  return cloudCardHidden("mcp-servers-heading", cloud) ? <ComputerOnlyStub anchor="mcp-servers-heading" /> : (
    <Card title={t("settings.l1.mcp.title")} subtitle={t("settings.l1.mcp.note")}>
      <McpServersPanel embedded />
    </Card>
  );
}

/** The Claude Code copy reads this computer's home folder, which a Cloud window cannot reach, so a Cloud window gets the stub. */
export function ClaudeCodeCard({ cloud }: { cloud: boolean }) {
  return cloudCardHidden("claude-code-import-heading", cloud) ? <ComputerOnlyStub anchor="claude-code-import-heading" /> : <ClaudeCodeImportCard />;
}

const stub = (anchor: string) => <ComputerOnlyStub anchor={anchor} />;

/** Same cards on every surface; only the actions that need the computer become stubs. */
export function connectionsCards({ desktop, cloud }: Pick<SettingsPageProps, "desktop" | "cloud">): SettingsPageCard[] {
  const live = desktop === true;
  return [
    { id: "connections.apps", anchor: "connections-heading", simple: true, render: () => <ConnectedAppsCard readOnly={!live || cloud} /> },
    { id: "connections.bot-email", anchor: "bot-email-heading", simple: false, render: () => (live && !cloud ? <BotEmailAccountCard /> : <BotEmailReadout />) },
    { id: "connections.mcp", anchor: "mcp-servers-heading", simple: true, render: () => (live ? <McpToolsCard cloud={cloud} /> : stub("mcp-servers-heading")) },
    { id: "connections.claude-code", anchor: "claude-code-import-heading", simple: false, render: () => (live ? <ClaudeCodeCard cloud={cloud} /> : stub("claude-code-import-heading")) },
    { id: "connections.highlevel", anchor: "highlevel-heading", simple: false, render: () => (live && !cloud ? <HighLevelSettings /> : stub("highlevel-heading")) },
    // Phone calls moves to the Calls page with SETPAGES-A; until that lands it keeps its registered home here.
    {
      id: "connections.phone-calls", anchor: "phone-calls-heading", simple: false, render: () => (live
        ? <LazyBoundary inline onRetry={PhoneCallsSection.retry}><Suspense fallback={null}><PhoneCallsSection.Component /></Suspense></LazyBoundary>
        : stub("phone-calls-heading")),
    },
  ];
}

export default function ConnectionsPage({ mode, desktop, cloud, anchor }: SettingsPageProps) {
  const messagingAnchor = channelsCards({ desktop }).some((card) => card.anchor === anchor);
  const [tab, setTab] = useState<"apps" | "messaging">(messagingAnchor ? "messaging" : "apps");
  const [messagingOpened, setMessagingOpened] = useState(messagingAnchor);
  const tabsId = useId();
  useEffect(() => {
    if (!anchor) return;
    setTab(messagingAnchor ? "messaging" : "apps");
    if (messagingAnchor) setMessagingOpened(true);
  }, [anchor, messagingAnchor]);
  return <>
    <div role="tablist" aria-label={t("settings.section.connections")} className="flex flex-wrap gap-2">
      {(["apps", "messaging"] as const).map((item) => <button key={item} type="button" role="tab"
        id={`${tabsId}-${item}`} aria-controls={`${tabsId}-panel-${item}`} aria-selected={tab === item}
        tabIndex={tab === item ? 0 : -1} onKeyDown={settingsTabKeys}
        onClick={() => { setTab(item); if (item === "messaging") setMessagingOpened(true); }}
        className={`min-h-11 rounded-lg px-3 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${tab === item ? "bg-control text-ink" : "text-ink-secondary"}`}>
        {t(item === "apps" ? "nav.apps" : "settings.section.channels")}
      </button>)}
    </div>
    <div role="tabpanel" id={`${tabsId}-panel-apps`} aria-labelledby={`${tabsId}-apps`} hidden={tab !== "apps"}>
      <div className="space-y-4"><PageCards cards={connectionsCards({ desktop, cloud })} mode={mode} /></div>
    </div>
    <div role="tabpanel" id={`${tabsId}-panel-messaging`} aria-labelledby={`${tabsId}-messaging`} hidden={tab !== "messaging"}>
      {messagingOpened && <div className="space-y-4"><ChannelsPageBody mode={mode} desktop={cloud ? false : desktop} cloud={cloud} /></div>}
    </div>
  </>;
}
