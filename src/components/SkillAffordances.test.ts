// Every action needs a control you can SEE.
//
// Source contracts, not render tests: the renderer suite runs in a node
// environment with no DOM, and these components are 1,000–1,900 lines each.
// What is worth pinning is not how they look — it is that the four ways into
// skill assignment exist at all, and that none of them is behind a right-click.
//
// `Sidebar.tsx` exposed its entire bot menu through `onContextMenu` alone. A
// touch device fires no `contextmenu` event, so on a phone pin, Chief of
// Staff, move-to-section, duplicate and delete did not exist. That is a live
// defect this feature had to stop repeating, not a hypothetical.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

const sidebar = read("./Sidebar.tsx");
const skillsPanel = read("./BotSkillsPanel.tsx");
const library = read("./TeamLibraryPanel.tsx");
const chat = read("./ChatView.tsx");
const settings = read("./SettingsPanel.tsx");

/** The bot row component alone, so an assertion cannot be satisfied by the
 *  room row — which already had keyboard access to its menu. */
const botListItem = (() => {
  const start = sidebar.indexOf("function BotListItem(");
  expect(start, "BotListItem is missing entirely").toBeGreaterThan(-1);
  return sidebar.slice(start, sidebar.indexOf("\nfunction ", start + 10));
})();

describe("the bot row's menu is reachable without a right-click", () => {
  it("has a visible control that opens it", () => {
    expect(botListItem).toContain("More actions for");
    expect(botListItem).toMatch(/aria-haspopup="menu"/);
    // Not hidden behind hover alone: `max-md:opacity-100` is what keeps it on
    // screen on a touch device, where there is no hover at all.
    const button = botListItem.slice(botListItem.indexOf("More actions for"));
    expect(button.slice(0, button.indexOf("</button>"))).toContain("max-md:opacity-100");
  });

  it("opens it from the keyboard, the way the room row already did", () => {
    expect(botListItem).toContain('event.key !== "ContextMenu"');
    expect(botListItem).toContain('event.shiftKey && event.key === "F10"');
  });

  it("still opens it on right-click, because taking that away would be a regression", () => {
    expect(botListItem).toContain("onContextMenu");
  });
});

describe("every way into skill assignment", () => {
  it("1. the bot menu offers it", () => {
    expect(sidebar).toContain('"Add a skill"');
    expect(sidebar).toContain('dispatch({ type: "showTeamLibrary", botId: bot.id })');
  });

  it("2. the agent's own Skills panel offers it, with that agent pre-filled", () => {
    expect(skillsPanel).toContain("onBrowse?: () => void");
    expect(skillsPanel).toContain("Add a skill");
    // In BOTH states. The empty state used to be the only guidance and it
    // pointed at a menu three levels away; a bot that already has skills had
    // no way to add another from here at all.
    expect(skillsPanel.match(/props\.onBrowse && <AddSkillButton/g)).toHaveLength(2);
    expect(settings).toContain('onBrowse={() => dispatch({ type: "showTeamLibrary", botId: bot.id })}');
  });

  it("3. the library's own skill rows offer it, naming the agent", () => {
    expect(library).toContain("<SkillAssignButton");
    expect(library).toContain("preselected={preselectedBot}");
    // The OUTCOME, with the agent in it — "Add to Bruce", never "Assign".
    expect(library).toContain("`Add to ${target.name}`");
    // With exactly one agent there is nothing to choose, so no picker appears.
    expect(library).toContain("preselected ?? (bots.length === 1 ? bots[0] : undefined)");
  });

  it("4. a new bot's first chat asks the question that leads there", () => {
    expect(chat).toContain("<BotIntakeCard bot={bot} />");
  });
});

describe("the intake card", () => {
  const card = read("./BotIntakeCard.tsx");

  it("asks one plain question, not a wizard", () => {
    expect(card).toContain("What do you mostly want help with?");
    // One question means one input and one primary action per state — a second
    // step here would be the wizard this replaces.
    expect(card.match(/What do you mostly want help with\?/g)).toHaveLength(2); // heading + aria-label
  });

  it("shows itself only while the agent has no skills", () => {
    expect(card).toContain("if (!needsSetup(skillCount)) return null;");
  });

  it("hands the transcript the same answer, so the question is asked once", () => {
    // The seeded four-option quiz asks exactly this question. Both on screen
    // at once, in two different widgets, is the "don't make me think" failure
    // the intake exists to remove.
    expect(chat).toContain("if (intakeOwnsTheQuestion(skillCount)) return null;");
    expect(card).toContain("useSkillCount(bot.id, api)");
    expect(chat).toContain("useSkillCount(bot.id, api)");
  });

  it("leaves a way back after it is dismissed", () => {
    // The previous setup question was a one-way door: nothing anywhere in the
    // app could bring it back.
    expect(card).toContain("Set {bot.name} up");
    expect(card).toContain("writeDismissed(bot.id, false)");
  });

  it("configures this bot and never creates another", () => {
    expect(card).toContain("applyProfileToBot(bot.id");
    expect(card).not.toContain("/api/teams/import");
    expect(card).not.toContain('type: "newBot"');
  });

  it("says out loud that nothing else changes", () => {
    expect(card).toContain("no new agent");
  });
});
