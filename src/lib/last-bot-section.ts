// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// A bot's profile reopens on the section you were last in, on this device.
// One id in localStorage, validated against the sections this window offers,
// so an id from a desktop window never opens on a phone that lacks it.

export const LAST_BOT_SECTION_KEY = "murage-last-bot-section";

type ReadStore = Pick<Storage, "getItem">;
type WriteStore = Pick<Storage, "setItem">;
const deviceStorage = (): Storage | undefined => globalThis.localStorage;

/** The remembered section if it is still one this window offers, else null. */
export function lastBotSection<T extends string>(
  offered: readonly T[],
  skip: readonly T[] = [],
  storage: () => ReadStore | undefined = deviceStorage,
): T | null {
  try {
    const stored = storage()?.getItem(LAST_BOT_SECTION_KEY);
    if (!stored) return null;
    const match = offered.find((id) => id === stored);
    return match && !skip.includes(match) ? match : null;
  } catch {
    return null;
  }
}

export function rememberBotSection(id: string, storage: () => WriteStore | undefined = deviceStorage): void {
  try { storage()?.setItem(LAST_BOT_SECTION_KEY, id); } catch { /* blocked storage: the profile opens on Overview */ }
}
