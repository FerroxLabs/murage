import { expect, it } from "vitest";
import { activeSettingsRole, BOT_SETTINGS_SECTIONS, DESKTOP_ONLY_BOT_SETTINGS, LEARNING_BADGE_SECTION, botSettingsSectionLabel, filterBotSettingsSections, settingsRoleLabel } from "./bot-settings-sections";

it("keeps the approved sections distinct and finds controls by their familiar names", () => {
  expect(BOT_SETTINGS_SECTIONS).toHaveLength(14);
  expect(new Set(BOT_SETTINGS_SECTIONS.map(section => section.id)).size).toBe(14);
  expect(filterBotSettingsSections("house rules").map(section => section.id)).toEqual(["shapes"]);
  expect(filterBotSettingsSections("what it reads").map(section => section.id)).toEqual(["shapes"]);
  expect(filterBotSettingsSections("working folder").map(section => section.id)).toEqual(["access"]);
  expect(filterBotSettingsSections("effort").map(section => section.id)).toEqual(["model"]);
  expect(filterBotSettingsSections("notebook").map(section => section.id)).toEqual(["memory"]);
  expect(filterBotSettingsSections("never-matching-section")).toEqual([]);
  // SPEC-X 13.1: the Teams section, found by what a person would type
  for (const word of ["shared", "sharing", "copy", "client", "general notes"]) expect(filterBotSettingsSections(word).map(section => section.id), word).toContain("teams");
  expect(DESKTOP_ONLY_BOT_SETTINGS.has("teams")).toBe(true);
  expect(filterBotSettingsSections("  ")).toEqual(BOT_SETTINGS_SECTIONS);
});
it("puts Learning right after Skills, desktop only, and the new-things badge on its row", () => {
  const ids = BOT_SETTINGS_SECTIONS.map(section => section.id) as string[];
  expect(ids[ids.indexOf("skills") + 1]).toBe("learning");
  expect(DESKTOP_ONLY_BOT_SETTINGS.has("learning")).toBe(true);
  expect(LEARNING_BADGE_SECTION).toBe("learning");
  for (const word of ["learn", "lessons", "feedback", "nudge", "teach", "undo", "suggestions"]) expect(filterBotSettingsSections(word).map(section => section.id), word).toContain("learning");
});
it("reports active roles from authority fields and never infers leadership from imported metadata", () => {
  const imported = { chiefOfStaff: false, installedPackage: { sourceRole: "chief", sourceTeam: "Studio" } };
  expect(activeSettingsRole(imported)).toBe("member");
  expect(activeSettingsRole({ chiefOfStaff: true })).toBe("leader");
  expect(activeSettingsRole({ chiefOfStaff: true, chiefScope: "workspace" })).toBe("chief");
  expect(activeSettingsRole({ individual: true })).toBe("individual");
  expect(settingsRoleLabel("leader")).toBe("Team leader");
});
it("names the shapes section after the bot", () => {
  const shapes = BOT_SETTINGS_SECTIONS.find(section => section.id === "shapes")!;
  expect(botSettingsSectionLabel(shapes, "Moss")).toBe("What shapes Moss");
  expect(botSettingsSectionLabel(BOT_SETTINGS_SECTIONS[0], "Moss")).toBe("Overview");
});
it("finds Appearance and Avatar in Identity & instructions, not Overview", () => {
  for (const word of ["appearance", "avatar", "upload", "shape", "mascot", "generate"]) {
    expect(filterBotSettingsSections(word).map(section => section.id), word).toContain("identity");
    expect(filterBotSettingsSections(word).map(section => section.id), word).not.toContain("overview");
  }
});
