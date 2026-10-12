// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Stale-while-revalidate for a per-key view. A slow service (the connected-apps broker behind the bot
// access card) must not leave the card blank: the last answer paints at once and the fetch updates it.
export function rememberedViews<T>() {
  const last = new Map<string, T>();
  return {
    get: (key: string): T | null => last.get(key) ?? null,
    set: (key: string, value: T): void => { last.set(key, value); },
    clear: (): void => last.clear(),
    /** Calls onView with the remembered value synchronously (if any), then with the fetched one.
     * A failed fetch is reported only when nothing was remembered to show. */
    async open(key: string, load: () => Promise<T>, onView: (value: T) => void, onError: () => void, active: () => boolean = () => true): Promise<void> {
      const remembered = last.get(key);
      if (remembered !== undefined) onView(remembered);
      try {
        const next = await load();
        last.set(key, next);
        if (active()) onView(next);
      } catch {
        if (active() && remembered === undefined) onError();
      }
    },
  };
}
