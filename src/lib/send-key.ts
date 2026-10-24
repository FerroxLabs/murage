// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The three send-key modes follow the idea in OpenMausBot (Apache-2.0), see NOTICE.

import { localeCode, subscribeLocale } from "@/lib/i18n";

/** What sends a message from the composer and the message editor.
 *  "enter": Enter sends, Shift+Enter is a newline (the long-standing way).
 *  "shift-enter": Shift+Enter sends, Enter is a newline.
 *  "mod-enter": Ctrl/Cmd+Enter sends, Enter is a newline. */
export type SendKey = "enter" | "shift-enter" | "mod-enter";

export const SEND_KEY_STORAGE = "murage.sendKey";
export const SEND_KEYS: readonly SendKey[] = ["enter", "shift-enter", "mod-enter"];

export function parseSendKey(value: unknown): SendKey | undefined {
  return value === "enter" || value === "shift-enter" || value === "mod-enter" ? value : undefined;
}

/** Japanese input confirms a candidate with Enter, so a sent-on-Enter composer
 *  fires half-typed messages. Ctrl/Cmd+Enter is the default there. Everyone
 *  else keeps Enter. A saved choice always wins. */
export function defaultSendKey(locale: string | undefined): SendKey {
  return (locale ?? "").toLowerCase().split("-")[0] === "ja" ? "mod-enter" : "enter";
}

/** The saved choice if there is one, else the language's default. Storage can
 *  throw where site data is blocked, so every read is guarded. */
export function resolveSendKey(storage: Pick<Storage, "getItem"> | undefined | null, locale: string | undefined): SendKey {
  try {
    const saved = parseSendKey(storage?.getItem(SEND_KEY_STORAGE));
    if (saved) return saved;
  } catch {
    /* blocked storage: follow the language */
  }
  return defaultSendKey(locale);
}

/** The name shown in tooltips and placeholders, e.g. "Cmd+Enter". */
export function sendKeyName(mode: SendKey, mac: boolean): string {
  if (mode === "shift-enter") return "Shift+Enter";
  if (mode === "mod-enter") return mac ? "Cmd+Enter" : "Ctrl+Enter";
  return "Enter";
}

/** What puts a newline in, the other half of the same decision. */
export function newlineKeyName(mode: SendKey): string {
  return mode === "enter" ? "Shift+Enter" : "Enter";
}

const changeListeners = new Set<() => void>();
const storage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

export function currentSendKey(): SendKey {
  return resolveSendKey(storage(), localeCode());
}

export function chooseSendKey(mode: SendKey): void {
  try {
    storage()?.setItem(SEND_KEY_STORAGE, mode);
  } catch {
    /* blocked storage: the choice holds for this run only */
  }
  for (const listener of changeListeners) listener();
}

export const SEND_KEY_SETTLED_STORAGE = "murage.sendKeySettled";

/** The Japanese default (Ctrl/Cmd+Enter) is for installs made on or after 1.0.4. An install that was already set up keeps Enter unless the
 *  person chose otherwise. Called with the server's `firstRun` answer once it is known: `true` means a fresh install (keep the language
 *  default, and never migrate it later when setup finishes); `false` on an install not yet settled means it predates this default, so
 *  Enter is saved if there is no saved choice. Runs once per install; blocked storage changes nothing. */
export function settleSendKeyForUpgrade(firstRun: boolean | undefined, store: Pick<Storage, "getItem" | "setItem"> | undefined | null = storage()): void {
  if (firstRun === undefined || !store) return;
  try {
    if (store.getItem(SEND_KEY_SETTLED_STORAGE)) return;
    store.setItem(SEND_KEY_SETTLED_STORAGE, firstRun ? "fresh" : "existing");
    if (!firstRun && !parseSendKey(store.getItem(SEND_KEY_STORAGE))) {
      store.setItem(SEND_KEY_STORAGE, "enter");
      for (const listener of changeListeners) listener();
    }
  } catch {
    /* blocked storage: the language default applies */
  }
}

/** For useSyncExternalStore: moves on a choice here, in another window
 *  (storage event), or when the app language changes. */
export function subscribeSendKey(listener: () => void): () => void {
  changeListeners.add(listener);
  const stopLocale = subscribeLocale(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === SEND_KEY_STORAGE || event.key === null) listener();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    changeListeners.delete(listener);
    stopLocale();
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

export function isMacPlatform(): boolean {
  const platform = (globalThis as { muragebox?: { platform?: string } }).muragebox?.platform
    ?? globalThis.navigator?.platform ?? "";
  return platform === "darwin" || /mac|iphone|ipad/i.test(platform);
}
