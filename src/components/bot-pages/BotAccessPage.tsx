// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: moved out of SettingsPanel.tsx verbatim (behaviour unchanged).
import { BrowserChoice } from "../BrowserChoice";
import { BrowserExtensionPanel } from "../BrowserExtensionPanel";
import { FolderOpen } from "lucide-react";
import { useState } from "react";
import { api, type Bot } from "@/state/store";
import { CloudBackendPicker } from "../CloudBackendPicker";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { shortPath } from "@/lib/short-path";
import { PublishedSitesPanel } from "../PublishCard";
import { FolderTrustNote } from "../FolderTrustNote";
import { Switch } from "../SettingsPrimitives";
import { BotAccessSettings } from "../BotAccessSettings";
import { PhoneAccessCard } from "../PhoneAccessCard";
import { PhoneForBotsRow } from "../PhoneForBotsRow";
import { BotEmailAccessLine } from "../BotEmailSettings";
import { findTask } from "@/lib/task-window";
import { useBotSettingsDraft } from "../bot-settings-drafts";
import { SettingsSection } from "./section";
import { inputCls } from "./field";
import type { BotPanelCtx } from "./context";

/** Where a bot's shell tools run. Set per bot; each task pins its own copy
 * on its first turn (the server does the pinning — Claude keeps sessions
 * per project folder, so a folder must not move under a live task). The
 * PATCH is made directly rather than through updateBot: the server
 * validates the path and a rejected folder must not stick in local state. */
function WorkingFolder({ bot }: { bot: Bot }) {
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canPick = Boolean(window.muragebox?.pickFolder);
  const task = findTask(bot, bot.threadId);
  const pinned = task?.cwd; // undefined = not yet, null = legacy home, string = folder
  const pinnedElsewhere = pinned !== undefined && (pinned ?? undefined) !== bot.cwd;
  useBotSettingsDraft("Working folder", draft !== null && draft !== (bot.cwd ?? ""), saving);
  // The folder is an element, so the sentence is split around its placeholder.
  const [pinnedBefore = "", pinnedAfter = ""] = t("settings.bot.folder.pinned").split("{folder}");

  const save = async (cwd: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd }) });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const pick = async () => {
    const chosen = await window.muragebox?.pickFolder?.(bot.cwd);
    if (chosen) void save(chosen);
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{t("settings.bot.folder.title")}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{t("settings.bot.folder.note")}</div>
      {canPick ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink" title={bot.cwd}>
            {bot.cwd ? shortPath(bot.cwd, home) : <span className="text-ink-secondary">{t("settings.bot.folder.private")}</span>}
          </div>
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14} /> {t("settings.bot.folder.choose")}
          </button>
          {bot.cwd && (
            <button onClick={() => void save(null)} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
              {t("settings.bot.folder.clear")}
            </button>
          )}
        </div>
      ) : (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            // an emptied field clears the folder — the server wants null
            void save((draft ?? bot.cwd ?? "").trim() || null);
          }}
        >
          <input
            className={cn(inputCls, "font-mono text-[12.5px]")}
            aria-label={t("settings.bot.folder.pathLabel")}
            placeholder={t("settings.bot.folder.pathPlaceholder")}
            value={draft ?? bot.cwd ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={saving || draft === null} className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            {t("settings.bot.save")}
          </button>
        </form>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      {pinnedElsewhere && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          {pinnedBefore}{pinned ? <span className="font-mono">{shortPath(pinned, home)}</span> : t("settings.bot.folder.homeFolder")}{pinnedAfter}
        </div>
      )}
      <FolderTrustNote folder={bot.cwd} botId={bot.id} threadId={bot.threadId} />
    </div>
  );
}

export function AccessAppsPart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section, patch, canUseConnectedApps, connectedAppsConfigured, connectedAppsEnabled, canUseBrowser, browserFeature, browserAllowed, browserEnabled } = ctx;
  return (
    <>
          <SettingsSection id="access" active={section}>
          <div id="bot-setting-apps" data-setting="bot.access.apps" className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">{t("settings.bot.apps.title")}</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {!connectedAppsConfigured
                  ? t("settings.bot.apps.connectFirst")
                  : !canUseConnectedApps
                    ? t("settings.bot.apps.engineCannot")
                    : connectedAppsEnabled
                      ? t("settings.bot.apps.on")
                      : t("settings.bot.apps.off")}
              </div>
            </div>
            <Switch
              checked={connectedAppsEnabled}
              aria-label={t("settings.bot.apps.switchLabel")}
              disabled={
                !connectedAppsEnabled && (!connectedAppsConfigured || !canUseConnectedApps)
              }
              onClick={() => patch({ composio: !connectedAppsEnabled })}
              title={
                !connectedAppsEnabled && !connectedAppsConfigured
                  ? t("settings.bot.apps.connectFirstTitle")
                  : !connectedAppsEnabled && !canUseConnectedApps
                    ? t("settings.bot.apps.engineCannotTitle")
                    : undefined
              }
              className="disabled:cursor-not-allowed"
            />
          </div>

          <div id="bot-setting-app-access" data-setting="bot.access.app-access" className="empty:hidden"><BotAccessSettings key={`access-${bot.id}`} botId={bot.id} /></div>
          <div id="bot-setting-phone" data-setting="bot.access.phone" className="empty:hidden"><PhoneAccessCard key={`phone-${bot.id}`} bot={bot} /></div>
          <div id="bot-setting-phone-for-bots" data-setting="bot.access.phone-for-bots" className="empty:hidden"><PhoneForBotsRow /></div>

          <div id="bot-setting-browser" data-setting="bot.access.browser" className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">{t("settings.bot.browser.title")}</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {!browserFeature
                    ? t("settings.bot.browser.featureOff")
                    : !canUseBrowser
                      ? t("settings.bot.browser.engineCannot")
                      : browserEnabled
                        ? t("settings.bot.browser.on")
                        : t("settings.bot.browser.off")}
              </div>
            </div>
            <Switch
              checked={browserEnabled}
              aria-label={t("settings.bot.browser.switchLabel")}
              disabled={!browserEnabled && (!browserFeature || !canUseBrowser)}
              onClick={() => patch({ browser: !browserAllowed })}
              className="disabled:cursor-not-allowed"
            />
          </div>
          <div id="bot-setting-browser-choice" data-setting="bot.access.browser-choice"><BrowserChoice bot={bot}>{choose=>bot.browserMode==='chrome-extension'?<BrowserExtensionPanel bot={bot} onChoose={choose}/>:null}</BrowserChoice></div>

          </SettingsSection>
    </>
  );
}

export function AccessComputerPart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section, desktop, state, patch, setLocalAutoWarning, localSelectable, localDisabledReason, canUseVps } = ctx;
  return (
    <>
          <SettingsSection id="access" active={section}>
          {/* WHERE THE WORK RUNS is a decision for the keyboard.
              Rendered only on a confirmed desktop — `undefined` shows nothing,
              because showing it and then taking it away is worse than a card
              that arrives a moment late. The bot keeps whatever it is already
              set to; nothing here is required to read a conversation, approve
              an action, or send a message from a phone. */}
          {desktop === true && (
          <div id="bot-setting-computer" data-setting="bot.access.computer" className="rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">{t("settings.bot.computer.title")}</div>
            {(!bot.computer || bot.computer === "local") && state.botComputerNotices?.[bot.id] && (
              <p role="status" className="mt-2 text-[13px] text-ink-secondary">{state.botComputerNotices[bot.id]}</p>
            )}
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {bot.computer ? t("settings.bot.computer.note") : t("settings.bot.computer.noteAuto")}
            </div>
            <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
              {([
                ["cloud", t("settings.bot.computer.cloud")],
                ["vm", t("settings.bot.computer.vm")],
                ["local", t("settings.bot.computer.local")],
                ["off", t("settings.bot.computer.off")],
              ] as const).map(([mode, label], i) => (
                <button
                  key={mode}
                  disabled={mode === "local" && !localSelectable}
                  title={mode === "local" && !localSelectable ? localDisabledReason ?? undefined : undefined}
                  onClick={() => {
                    if (mode === bot.computer) return;
                    if (mode === "local" && bot.autoApprove) setLocalAutoWarning("local");
                    else patch({ computer: mode });
                  }}
                  className={cn(
                    "flex-1 py-1.5 text-[13px] capitalize",
                    i > 0 && "border-l border-hairline/40",
                    mode === "local" && !localSelectable && "cursor-not-allowed opacity-40",
                    bot.computer === mode
                      ? "bg-control text-ink"
                      : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {(!bot.computer || bot.computer === "cloud") && (
              <>
                <CloudBackendPicker
                  value={bot.cloudBackend ?? "box"}
                  vpsSupported={canUseVps}
                  onChange={(backend) => patch({ cloudBackend: backend })}
                />
                {!bot.computer && bot.cloudBackend === "vps" && (
                  <div className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-inset px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink">{t("settings.bot.computer.vpsTitle")}</div>
                      <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                        {t("settings.bot.computer.vpsNote")}
                      </div>
                    </div>
                    <Switch
                      checked={Boolean(bot.autoStartVps)}
                      aria-label={t("settings.bot.computer.vpsTitle")}
                      onClick={() => patch({ autoStartVps: !bot.autoStartVps })}
                    />
                  </div>
                )}
              </>
            )}
          </div>
          )}

          </SettingsSection>
    </>
  );
}

export function AccessFolderPart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section } = ctx;
  return (
    <>
          <SettingsSection id="access" active={section}>
          <div id="bot-setting-folder" data-setting="bot.access.folder" className="empty:hidden"><WorkingFolder bot={bot} /></div>
          <div id="bot-setting-sites" data-setting="bot.access.sites" className="empty:hidden"><PublishedSitesPanel bot={bot} /></div>
          {/* bot email section 8: only for an install that had email on and lost its Flux key */}
          <BotEmailAccessLine />
          </SettingsSection>
    </>
  );
}
