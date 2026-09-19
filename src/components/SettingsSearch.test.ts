// The settings search box: the words people actually type for a setting
// must land on the section that holds it.
import { describe, expect, it } from "vitest";

import { settingsSearchResults, updatesSubtitle } from "./SettingsModal";

describe("settings search", () => {
  it("finds the recovery key under Backups, in the words people use for it", () => {
    for (const query of ["recovery key", "Recovery Key", "age key", "encryption key", "restore"]) {
      expect(settingsSearchResults(query), query).toContain("backups");
    }
  });

  it("finds the app version under General, where the Updates row shows it", () => {
    for (const query of ["version", "app version", "about", "About"]) {
      expect(settingsSearchResults(query), query).toContain("general");
    }
  });

  it("still narrows: an unrelated query keeps neither section", () => {
    expect(settingsSearchResults("telegram")).not.toContain("backups");
    expect(settingsSearchResults("telegram")).not.toContain("general");
  });
});

describe("Settings → General → Updates", () => {
  it("names the running version before the update status", () => {
    expect(updatesSubtitle({ status: "idle", currentVersion: "0.1.56" })).toBe("Murage 0.1.56. You're on the latest version we know of.");
    expect(updatesSubtitle({ status: "available", version: "0.1.57", currentVersion: "0.1.56" })).toBe("Murage 0.1.56. 0.1.57 available");
  });

  it("claims no version it was not told", () => {
    expect(updatesSubtitle(null)).toBe("You're on the latest version we know of.");
    expect(updatesSubtitle({ status: "idle" })).toBe("You're on the latest version we know of.");
  });
});
