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

  it("is visible AT REST on any device with no pointer, not just narrow ones", () => {
    // `max-md:opacity-100` was the whole defence, and it is a WIDTH test. An
    // iPad in landscape is wider than `md` and has no hover at all, so both
    // controls stayed at `opacity-0` forever — archive included, which is the
    // one with no keyboard route of its own.
    const sites = [...sidebar.matchAll(/group-hover:opacity-100[^"]*"/g)].map((match) => match[0]);
    expect(sites.length, "the two hover-revealed controls are gone").toBe(2);
    for (const site of sites) {
      expect(site, site).toContain("[@media(hover:none)]:opacity-100");
    }
    // An unavailable archive must not appear as a live control there. Since
    // U0-T2 (#762/#767) the row never mounts a disabled Archive at all — its
    // invisible pixels swallowed clicks — so the guard is the omission itself.
    expect(sidebar).toContain("{showInlineArchive && <button");
    expect(sidebar).not.toContain("disabled={archiveDisabled}");
    // And the timestamp those two are positioned on top of has to get out of
    // the way at rest too, or they render over it.
    expect(sidebar).toContain("group-hover:opacity-0 group-focus-within:opacity-0 [@media(hover:none)]:opacity-0");
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
    // It asks it as the bot talking, in the transcript, rather than as a panel
    // docked above the composer. The branch is what makes that reachable: an
    // intake turn renders as `IntakeTurn` or it renders as nothing.
    expect(chat).toContain("<IntakeTurn bot={bot} message={m} />");
    expect(chat).toContain('import { IntakeTurn } from "./IntakeTurn";');
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

  it("is not in the composer at all any more", () => {
    // It used to dock above the composer for any agent that looked new, which
    // put an options box at the bottom of the screen in place of the bot
    // saying anything. The transcript asks now; this file's copy of the
    // question survives only behind the profile's own button.
    expect(card).toContain("export function BotSetupAction(");
    expect(card).not.toContain("export function BotIntakeCard(");
    expect(chat).not.toContain("BotIntakeCard");
  });

  it("asks the question once, because only one thing asks it", () => {
    // The suppression guard that existed to stop the seeded quiz and the
    // docked card asking the same question twice is gone with the card. If it
    // had survived, it would suppress the conversation too and a new bot would
    // render one greeting and nothing else.
    expect(chat).not.toContain("intakeOwnsTheQuestion");
    expect(chat).not.toContain("useSkillCount(bot.id, api)");
  });

  it("leaves a way back after it is dismissed", () => {
    // The setup question was once a one-way door: nothing anywhere in the app
    // could bring it back. The way back is the bot's own profile, which is
    // always there — which is also what lets a person walk out of the
    // conversation in the transcript without losing anything.
    expect(card).toContain("Set up this bot");
    expect(settings).toContain("<BotSetupAction bot={bot} />");
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
