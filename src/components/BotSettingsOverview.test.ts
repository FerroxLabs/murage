// What Bot settings opens on (0.1.57 sweep, item 9).
//
// It opened on the avatar studio — shape, expression, colour, body and a
// "paste an OpenAI image key" box — with "What is this bot for?" and the
// Role picker below the fold. And a brand-new bot, alone in the workspace,
// was already labelled "Team member" of a "General" team nobody made.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BOT_ROLE_BADGE, BOT_ROLE_TITLE, botRoleTitle } from "@/lib/bot-role";
import { settingsRoleLabel } from "./bot-settings-sections";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const settings = read("./SettingsPanel.tsx");
const overviewAt = settings.indexOf('<SettingsSection id="overview" active={section}>');
const at = (needle: string) => settings.indexOf(needle, overviewAt);

describe("the order of Bot settings → Overview", () => {
  it("asks what the bot is for before anything else", () => {
    expect(overviewAt).toBeGreaterThan(-1);
    expect(read("./BotIntakeCard.tsx")).toContain("What is this bot for?");
    expect(at("<BotSetupAction bot={bot} />")).toBeGreaterThan(overviewAt);
    expect(at("<BotSetupAction bot={bot} />")).toBeLessThan(at("<BotProfileAvatarCard"));
  });

  it("folds Appearance away instead of opening on it", () => {
    const details = settings.slice(at("<details"), settings.indexOf("</details>", at("<details")));
    expect(details).toContain("<BotProfileAvatarCard");
    expect(details).not.toContain(" open=");
  });
});

describe("Role waits until there is an org to chart", () => {
  it("hides the picker and the role line until a second bot exists", () => {
    expect(settings).toContain("const hasTeammates = state.bots.filter((candidate) => !candidate.hidden).length > 1;");
    expect(settings).toContain("{hasTeammates && <BotRoleControl bot={bot} canCoordinate={canCoordinate} />}");
    expect(settings).toContain("{hasTeammates && <div className=\"rounded-xl bg-card p-4 text-[13px]\">");
  });

  it("calls a bot with no team 'On its own', not a member of one nobody made", () => {
    expect(BOT_ROLE_TITLE.individual).toBe("On its own");
    expect(BOT_ROLE_BADGE.individual).toBe("On its own");
    expect(botRoleTitle({})).toBe("On its own");
    expect(botRoleTitle({ section: "   " })).toBe("On its own");
    expect(botRoleTitle({ section: "Growth" })).toBe("Team member");
    expect(botRoleTitle({ chiefOfStaff: true, chiefScope: "workspace" })).toBe("Chief of Staff");
    expect(botRoleTitle({ chiefOfStaff: true, section: "Growth" })).toBe("Team leader");
    expect(settings).toContain("{botRoleTitle(bot)}");
  });

  it("spells the role the same way wherever it is written", () => {
    for (const role of ["chief", "leader", "individual", "member"] as const) {
      expect(settingsRoleLabel(role)).toBe(BOT_ROLE_TITLE[role]);
    }
  });
});
