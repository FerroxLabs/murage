// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The bot page of the Settings window loads on first use, like the window itself. React.lazy suspends on its first
// render even for a chunk that is already in, which brings the fallback and its reveal throttle back; once loaded,
// the window renders the page directly (the same pattern as lib/preload-bot-settings.ts).
import type { ComponentType, MutableRefObject } from "react";
import type { Bot } from "@/state/store";
import type { BotSettingsLeave } from "@/components/BotSettingsPane";

export type BotSettingsPaneProps = { bot: Bot; onClose: () => void; leaveRef?: MutableRefObject<BotSettingsLeave | null> };
let loading: Promise<typeof import("@/components/BotSettingsPane")> | null = null;
let loaded: ComponentType<BotSettingsPaneProps> | null = null;
export function loadBotSettingsPane() {
  return loading ??= import("@/components/BotSettingsPane").then((module) => { loaded = module.BotSettingsPane; return module; }, (error) => { loading = null; throw error; });
}
export const loadedBotSettingsPane = (): ComponentType<BotSettingsPaneProps> | null => loaded;
