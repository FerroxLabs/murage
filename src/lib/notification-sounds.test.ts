// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

import { NOTIFICATION_SOUNDS_KEY, notificationSoundsEnabled, setNotificationSounds } from "./notification-sounds";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    values,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setNotificationSounds(true);
});

describe("notification sounds on this computer", () => {
  it("are on unless this computer turned them off", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    setNotificationSounds(true);
    expect(notificationSoundsEnabled()).toBe(true);
  });

  it("stay off after a reload once muted", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    setNotificationSounds(false);
    expect(storage.values.get(NOTIFICATION_SOUNDS_KEY)).toBe("0");
    expect(notificationSoundsEnabled()).toBe(false);
  });

  it("keep the choice for this session when storage refuses the write", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("quota"); } });
    setNotificationSounds(false);
    expect(notificationSoundsEnabled()).toBe(false);
  });
});
