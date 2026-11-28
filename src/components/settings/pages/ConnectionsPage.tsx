// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Connected apps (SETTINGS-LOCKED-1019.md 3.11): the apps you connect once and the tools your bots can use. Simple shows
// the apps card and the tools (MCP) card; Advanced adds bot email and Claude Code import. One list of cards, filtered by
// the shell (PageCards). Remote surfaces retain app/email readouts and stub computer-only actions.
import { cloudCardHidden } from "@/lib/cloud-settings";
import { t } from "@/lib/i18n";
import type { SettingsPageCard, SettingsPageProps } from "@/lib/settings-page-contract";
import { settingsSectionLabel } from "@/lib/settings-sections";
import { useStore, type AppSettingsSection } from "@/state/store";
import { BotEmailAccountCard } from "../../BotEmailSettings";
import { ClaudeCodeImportCard } from "../../ClaudeCodeImportCard";
import { Card } from "../../SettingsPrimitives";
import { ComputerOnlyStub } from "../../SettingsStub";
import { PageCards } from "../PageCards";
import { PluginsPanel } from "../../PluginsPanel";
import { ReconnectAppsNeedsYou } from "../../ReconnectAppsBanner";
import { McpServersPanel } from "../../McpServersPanel";
import { BotEmailReadout } from "./BotEmailReadout";

const linkButton = "rounded px-0.5 font-medium text-accent-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";
/** One catalog/account component owns both views, including authorization and its retained drafts. */
export function ConnectedAppsCard({ readOnly = false }: { readOnly?: boolean }) {
  const { state, dispatch } = useStore();
  const go = (section: AppSettingsSection) => dispatch({ type: "toggleAppSettings", open: true, section });
  return (
    <>
      <Card title={t("settings.section.connections")} subtitle={t(state.config?.composio?.mode === "managed" ? "settings.connections.noteManaged" : "settings.connections.note")}>
        <div className="flex flex-col gap-4">
          {/* An app to sign in again, first: the reconnect line can be put away, this stays until it is done (1.0.20). */}
          {!readOnly && <ReconnectAppsNeedsYou dispatch={dispatch} label={t("connectorHealth.reconnect")} />}
          <PluginsPanel embedded readOnly={readOnly} />
          {state.config?.composio?.mode === "managed" ? (
            <div className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[13px] text-success">{t("settings.connections.ready")}</div>
          ) : null}
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
        {" · "}
        <button type="button" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "calls", anchor: "phone-calls-heading" })}
          className={linkButton}>{t("settings.l1.card.connections.phone-calls")}</button>
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
  ];
}

export default function ConnectionsPage({ mode, desktop, cloud }: SettingsPageProps) {
  return <div className="space-y-4"><PageCards cards={connectionsCards({ desktop, cloud })} mode={mode} /></div>;
}
