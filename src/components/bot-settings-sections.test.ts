import { expect, it } from "vitest";
import { activeSettingsRole, BOT_SETTINGS_SECTIONS, filterBotSettingsSections, settingsRoleLabel } from "./bot-settings-sections";

it("keeps the approved sections distinct and finds controls by their familiar names", () => {
  expect(BOT_SETTINGS_SECTIONS).toHaveLength(11);
  expect(new Set(BOT_SETTINGS_SECTIONS.map(section => section.id)).size).toBe(11);
  expect(filterBotSettingsSections("working folder").map(section => section.id)).toEqual(["access"]);
  expect(filterBotSettingsSections("effort").map(section => section.id)).toEqual(["model"]);
  expect(filterBotSettingsSections("notebook").map(section => section.id)).toEqual(["memory"]);
  expect(filterBotSettingsSections("never-matching-section")).toEqual([]);
  expect(filterBotSettingsSections("  ")).toEqual(BOT_SETTINGS_SECTIONS);
});
it("reports active roles from authority fields and never infers leadership from imported metadata", () => {
  const imported = { chiefOfStaff: false, installedPackage: { sourceRole: "chief", sourceTeam: "Studio" } };
  expect(activeSettingsRole(imported)).toBe("member");
  expect(activeSettingsRole({ chiefOfStaff: true })).toBe("leader");
  expect(activeSettingsRole({ chiefOfStaff: true, chiefScope: "workspace" })).toBe("chief");
  expect(activeSettingsRole({ individual: true })).toBe("individual");
  expect(settingsRoleLabel("leader")).toBe("Team leader");
});
