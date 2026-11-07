// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One Settings window (SETTINGS-UX-1011 S7). A bot's settings are a page of the Settings window, under its Bots group;
// this is the thin opener every "Bot settings" entry still mounts (App.tsx, lib/preload-bot-settings.ts). It shows the
// window with this bot selected. The page itself (sections, drafts, the unsaved-edit guard, murage:open-memory) is
// BotSettingsPane, and both load on first use.
import { lazy } from "react";
import type { Bot } from "@/state/store";
import { loadBotSettingsPane } from "@/lib/bot-settings-pane-load";

type Shell = typeof import("./SettingsModal").SettingsModal;
let shell: Shell | null = null;
let loading: Promise<Shell> | null = null;
/** The Settings window and its bot page, together: the opener renders with no fallback once both are in. */
export function loadBotSettingsWindow(): Promise<Shell> {
  return loading ??= Promise.all([import("./SettingsModal"), loadBotSettingsPane()]).then(([module]) => (shell = module.SettingsModal), (error) => { loading = null; throw error; });
}
const LazyShell = lazy(() => loadBotSettingsWindow().then((component) => ({ default: component })));

export function BotSettingsDialog({ bot, onClose }: { bot: Bot; onClose?: () => void }) {
  const Window = shell ?? LazyShell;
  return <Window bot={bot} onBotClose={onClose} />;
}
