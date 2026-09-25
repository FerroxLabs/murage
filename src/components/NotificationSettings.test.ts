// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Source contract, not a render test: the renderer suite runs with no DOM.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import en from "../locales/en.json";

const source = readFileSync(fileURLToPath(new URL("./NotificationSettings.tsx", import.meta.url)), "utf8");

describe("notification sounds switch", () => {
  it("is one switch in the notifications card that applies to this computer at once", () => {
    expect(source).toContain("useNotificationSounds()");
    expect(source).toContain("setNotificationSounds(event.target.checked)");
    // not part of the saved server preferences: it never marks the form dirty
    expect(source).not.toMatch(/edit\(\{[^}]*sound/i);
  });

  it("says what it does in plain words", () => {
    expect(en["notificationSettings.soundLabel"]).toBe("Play a sound");
    expect(en["notificationSettings.soundHelp"]).toMatch(/this computer/);
    expect(en["notificationSettings.soundHelp"]).not.toMatch(/—|safe/i);
  });
});
