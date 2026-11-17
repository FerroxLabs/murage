// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Advanced mode (SETTINGS-LOCKED-1019.md 2.5): one switch for the whole of Settings. Off is Simple, the default for a
// new install; On shows every page and every card. A person flips it on General's first card; every "Set in Advanced"
// line and every search or link that lands on an Advanced-only control flips it on for them (nothing is unreachable).
//
// A per-device choice kept in this browser or window, like the sidebar density (lib/sidebar-preferences.ts); never read
// on the first paint. An upgrader who had opened one of the old Advanced folds starts in Advanced: the fold's first
// opening is noted below. Earlier installations also retain the complete view through their saved configuration.
import { useEffect, useSyncExternalStore } from "react";

export type SettingsMode = "simple" | "advanced";

export const SETTINGS_MODE_KEY = "murage.settings.mode";
export const SETTINGS_FOLD_SEEN_KEY = "murage.settings.advancedFoldSeen";

function readKey(key: string): string | null {
  try { return typeof localStorage === "undefined" ? null : localStorage.getItem(key); } catch { return null; }
}
function writeKey(key: string, value: string): void {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(key, value); } catch { /* private window: the choice lasts until the page closes */ }
}

let session: SettingsMode | null = null;
let installationDefault: SettingsMode = "simple";
const listeners = new Set<() => void>();

/** The stored choice; with none, Advanced for an upgrader who opened an old fold, Simple for everyone else. */
export function settingsMode(): SettingsMode {
  if (session) return session;
  const stored = readKey(SETTINGS_MODE_KEY);
  if (stored === "simple" || stored === "advanced") return stored;
  return readKey(SETTINGS_FOLD_SEEN_KEY) === "1" ? "advanced" : installationDefault;
}

export function setSettingsMode(mode: SettingsMode): void {
  if (settingsMode() === mode && readKey(SETTINGS_MODE_KEY) === mode) return;
  session = mode;
  writeKey(SETTINGS_MODE_KEY, mode);
  for (const listener of [...listeners]) listener();
}

/** A person opened one of the page folds (AdvancedSection): the one fact an upgrader's default is made from. */
export function noteAdvancedFoldOpened(): void {
  if (readKey(SETTINGS_FOLD_SEEN_KEY) === "1") return;
  // Opening a fold never changes the mode now showing: keep this session's mode, and let the note shape the next start.
  if (!session && !readKey(SETTINGS_MODE_KEY)) session = settingsMode();
  writeKey(SETTINGS_FOLD_SEEN_KEY, "1");
}

export function subscribeSettingsMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** For tests: forget the in-memory choice so the stored one is read again. */
export function resetSettingsModeForTest(): void { session = null; installationDefault = "simple"; listeners.clear(); }

/** Persist the installation default only when this device has no choice yet. */
export function initializeSettingsMode(defaultMode: SettingsMode): void {
  installationDefault = defaultMode;
  if (!session && readKey(SETTINGS_MODE_KEY) !== "simple" && readKey(SETTINGS_MODE_KEY) !== "advanced") setSettingsMode(settingsMode());
}
export function useSettingsMode(defaultMode?: SettingsMode): SettingsMode {
  if (defaultMode) installationDefault = defaultMode;
  useEffect(() => { if(defaultMode) initializeSettingsMode(defaultMode); }, [defaultMode]);
  return useSyncExternalStore(subscribeSettingsMode, settingsMode, () => "simple");
}
