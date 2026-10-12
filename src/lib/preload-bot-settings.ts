// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot settings loads on first use (a phone that never opens it never downloads it). Opening it cold
// shows the loading spinner for the chunk, and React then holds the real dialog back for its 300 ms
// Suspense reveal throttle, so the dialog arrived about 300 ms after the chunk was already in. Loading
// the chunk when the person shows intent (hover, focus, press) or, on a desktop, once the app is idle
// means the dialog opens with no fallback at all.
import type { ComponentType } from "react";
import type { Bot } from "@/state/store";

type Dialog = ComponentType<{ bot: Bot; onClose?: () => void }>;
let loading: Promise<typeof import("@/components/BotSettingsDialog")> | null = null;
let loaded: Dialog | null = null;
const listeners = new Set<() => void>();
export function loadBotSettings() {
  return loading ??= import("@/components/BotSettingsDialog").then((module) => {
    loaded = module.BotSettingsDialog;
    for (const listener of listeners) listener();
    return module;
  }, (error) => { loading = null; throw error; });
}
export function preloadBotSettings(): void { void loadBotSettings().catch(() => {}); }
/** The dialog once its chunk is in. React.lazy suspends on its first render even for a chunk that is
 * already loaded, which brings the fallback and its reveal throttle back; a loaded component renders
 * directly instead. */
export const loadedBotSettings = (): Dialog | null => loaded;
export function subscribeBotSettings(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** True on a pointer-and-hover device: the only place an idle prefetch is free. */
export function canPrefetchWhenIdle(): boolean {
  try { return typeof window.matchMedia === "function" && window.matchMedia("(hover: hover) and (pointer: fine)").matches; } catch { return false; }
}
