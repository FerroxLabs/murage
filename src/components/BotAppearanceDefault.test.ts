// Appearance lives at the top of Identity & instructions, OPEN.
//
// 0.1.57 folded it away on Overview so the panel opened on what the bot is
// for. Sean (2026-10-03) moved it: a bot's looks belong with its name and
// instructions, and a folded disclosure hid the avatar editor from people
// looking for it. It is now the first thing in Identity & instructions, as
// plain open content, with no disclosure toggle.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const settings = readFileSync(fileURLToPath(new URL("./SettingsPanel.tsx", import.meta.url)), "utf8");
const identityStart = settings.indexOf('<SettingsSection id="identity" active={section}>');
const identityEnd = settings.indexOf("</SettingsSection>", identityStart);
const identity = settings.slice(identityStart, identityEnd);

describe("bot Appearance placement", () => {
  it("is in Identity & instructions, above the Name field", () => {
    expect(identityStart).toBeGreaterThan(-1);
    expect(identity).toContain("<BotProfileAvatarCard");
    expect(identity.indexOf("<BotProfileAvatarCard")).toBeLessThan(identity.indexOf('<Field label="Name">'));
    expect(identity).toContain('t("settings.appearance.title")');
  });

  it("is open by default: no disclosure, no summary toggle", () => {
    expect(settings).not.toContain("<details");
    expect(settings).not.toContain("<summary");
    expect(identity).not.toMatch(/<(?:details|summary)\b/);
  });

  it("is not in Overview any more", () => {
    const overviewAt = settings.indexOf('<SettingsSection id="overview" active={section}>');
    expect(overviewAt).toBeGreaterThan(-1);
    expect(settings.slice(overviewAt, identityStart)).not.toContain("<BotProfileAvatarCard");
  });

  it("makes the avatar viewable through the shared lightbox", () => {
    const card = readFileSync(fileURLToPath(new URL("./BotProfileAvatarCard.tsx", import.meta.url)), "utf8");
    expect(card).toContain("ViewableBotAvatar");
  });
});
