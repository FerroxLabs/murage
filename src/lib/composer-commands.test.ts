import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { enabledSlashSkills } from "./use-slash-skills";
import {
  composerSlashTrigger,
  goalTextFromComposer,
  replaceComposerSlashTrigger,
  skillSlashRows,
  slashSkillMatches,
} from "./composer-commands";

describe("composer slash commands", () => {
  it("opens command search only for the first unfinished token", () => {
    expect(composerSlashTrigger("/", 1)).toEqual({ query: "", start: 0, end: 1 });
    expect(composerSlashTrigger("/go", 3)).toEqual({ query: "go", start: 0, end: 3 });
    expect(composerSlashTrigger("hello /go", 9)).toBeNull();
    expect(composerSlashTrigger("/goal write", 11)).toBeNull();
  });

  it("reads the token at the caret, not the whole draft", () => {
    // The caret can sit inside a draft the user came back to edit; only the
    // text BEFORE it decides whether a command is being typed.
    expect(composerSlashTrigger("/go later", 3)).toEqual({ query: "go", start: 0, end: 3 });
    expect(composerSlashTrigger("/go later", 9)).toBeNull();
    // out-of-range and fractional carets are clamped rather than thrown at
    expect(composerSlashTrigger("/go", 99)).toEqual({ query: "go", start: 0, end: 3 });
    expect(composerSlashTrigger("/go", -4)).toBeNull();
  });

  it("replaces the active token without losing text after the caret", () => {
    expect(
      replaceComposerSlashTrigger("/go later", { query: "go", start: 0, end: 3 }, ""),
    ).toEqual({ text: " later", caret: 0 });
    expect(
      replaceComposerSlashTrigger("/le", { query: "le", start: 0, end: 3 }, "/learn "),
    ).toEqual({ text: "/learn ", caret: 7 });
  });

  it("turns a manually typed goal command into a goal request", () => {
    expect(goalTextFromComposer("/goal ship the release")).toBe("ship the release");
    expect(goalTextFromComposer("/GOAL\n  investigate the failure")).toBe(
      "investigate the failure",
    );
    expect(goalTextFromComposer("/goalie says hello")).toBeNull();
    expect(goalTextFromComposer("discuss /goal later")).toBeNull();
  });

  it("distinguishes an unfinished goal from no goal at all", () => {
    // "" means the chip should light and the send should stay disabled;
    // null means this is an ordinary chat message. Collapsing the two is how
    // a bare "/goal" would either send an empty goal or refuse to light.
    expect(goalTextFromComposer("/goal")).toBe("");
    expect(goalTextFromComposer("/goal   ")).toBe("");
    expect(goalTextFromComposer("hello")).toBeNull();
    expect(goalTextFromComposer("")).toBeNull();
  });
});

describe("where the menu renders", () => {
  // The composer is a two-row bar now (textarea on top, controls beneath).
  // A menu positioned inside either row would open behind the other one, so
  // this pins the geometry the component cannot assert about itself: both
  // listboxes are `absolute bottom-full` and both sit AHEAD of the bar
  // wrapper rather than inside it — they float above the whole bar.
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "components", "Composer.tsx"),
    "utf8",
  );
  const commandsAt = source.indexOf('aria-label="Composer commands"');
  const mentionsAt = source.indexOf('aria-label="Tag a bot"');
  const barWrapperAt = source.indexOf(
    'className="relative z-[1] flex flex-col gap-1.5 rounded-3xl bg-raised',
  );

  it("floats both pickers above the bar rather than inside a row", () => {
    for (const at of [commandsAt, mentionsAt]) {
      expect(at).toBeGreaterThan(-1);
      expect(source.slice(at, at + 260)).toContain("absolute bottom-full left-2");
    }
  });

  it("keeps the command menu ahead of the mention menu and both ahead of the bar", () => {
    expect(mentionsAt).toBeGreaterThan(commandsAt);
    expect(barWrapperAt).toBeGreaterThan(mentionsAt);
  });

  it("opens on a skill name with digits", () => {
    expect(composerSlashTrigger("/weekly-2", 9)).toEqual({ query: "weekly-2", start: 0, end: 9 });
  });

  it("lists enabled skills as rows, never shadowing a built-in or an engine command", () => {
    const rows = skillSlashRows([
      { name: "standup", description: "Writes the weekly standup note." },
      { name: "goal", description: "A skill that happens to be called goal." },
      { name: "compact", description: "Same name as an engine command." },
      { name: "release-notes", description: "Drafts release notes." },
    ], new Set(["compact"]));
    expect(rows.map((row) => row.name)).toEqual(["release-notes", "standup"]);
    expect(slashSkillMatches(rows[1]!, "sta")).toBe(true);
    expect(slashSkillMatches(rows[1]!, "WEEKLY")).toBe(true);
    expect(slashSkillMatches(rows[1]!, "release")).toBe(false);
    expect(replaceComposerSlashTrigger("/sta", { query: "sta", start: 0, end: 4 }, "/standup ")).toEqual({ text: "/standup ", caret: 9 });
  });

  it("reads only enabled, named skills from the skills listing", () => {
    expect(enabledSlashSkills({ skills: [
      { name: "standup", description: "Writes the note.", enabled: true },
      { name: "draft", description: "Off for now.", enabled: false },
      { name: 7, description: "broken", enabled: true },
      { name: "bare", enabled: true },
    ] })).toEqual([
      { name: "standup", description: "Writes the note." },
      { name: "bare", description: "" },
    ]);
    expect(enabledSlashSkills(null)).toEqual([]);
  });
});
