import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// A source contract, not a render test. The panel is a 900-line component in a
// node-environment suite with no DOM, and the property worth pinning is not how
// it looks — it is that hiring a team can never take the roster away. That used
// to be the DEFAULT: importMode started as "replace", previewManifest actively
// selected it whenever you already owned bots, and the primary button read
// "Replace team" while "Add alongside instead" was a text link beside it. One
// stray click archived every bot you had.
const source = readFileSync(
  fileURLToPath(new URL("./TeamLibraryPanel.tsx", import.meta.url)),
  "utf8",
);

import {
  archivedRestorePatch,
  teamImportSkillSummary,
  type ArchivedTeamBot,
  type TeamImportSkillError,
} from "./TeamLibraryPanel";
import { botRole } from "@/lib/bot-role";


describe("team import is additive", () => {
  it("only ever asks the server for a mode that adds", () => {
    // `add` and `project` both create; `project` additionally opens a room on a
    // scouted folder (server/index.ts:6311). `replace` is the only mode that
    // archives what you already have, and nothing here may request it.
    const modes = [...source.matchAll(/\/api\/teams\/import\?mode=([a-z$#{}\w]*)/g)].map((m) => m[1]);
    expect(modes.length).toBeGreaterThan(0);
    expect([...new Set(modes)].sort()).toEqual(["add", "project"]);
  });

  it("carries no import-mode state that could select a destructive path", () => {
    expect(source).not.toMatch(/importMode|ImportMode/);
    expect(source).not.toMatch(/"replace"/);
  });

  it("offers no control that replaces the current team", () => {
    expect(source).not.toMatch(/Replace team|Replace current team/);
  });
});

const store = readFileSync(fileURLToPath(new URL("../state/store.tsx", import.meta.url)), "utf8");
const sidebar = readFileSync(fileURLToPath(new URL("./Sidebar.tsx", import.meta.url)), "utf8");
const intakeCard = readFileSync(fileURLToPath(new URL("./BotIntakeCard.tsx", import.meta.url)), "utf8");

describe("the panel has two halves, and 'add a skill' lands on the right one", () => {
  it("carries a real view, all the way from the action that opened it", () => {
    // It had `activeFacet` and a search box and nothing else, so "Add a skill
    // to Bruce" and "browse teams" arrived at the same screen — a grid of Load
    // buttons that import a whole crew.
    expect(store).toContain('export type TeamLibraryView = "teams" | "skills";');
    expect(store).toContain('| { type: "showTeamLibrary"; botId?: string; view?: TeamLibraryView }');
    expect(source).toContain("initialView?: TeamLibraryView;");
    expect(source).toContain('useState<TeamLibraryView>(initialView ?? "teams")');
    expect(sidebar).toContain("initialView={state.teamLibrary.view}");
  });

  it("the intake's own escape hatch opens it on Skills, naming the bot", () => {
    expect(intakeCard).toContain('dispatch({ type: "showTeamLibrary", botId: bot.id, view: "skills" })');
  });

  it("names the agent BEFORE any search, not only once results exist", () => {
    const heading = source.slice(source.indexOf('{view === "skills" && ('));
    expect(heading.slice(0, 400)).toContain("· for {preselectedBot.name}");
  });

  it("ZERO Load buttons on the skills view", () => {
    // `TeamRow`'s action imports an entire crew of bots. Offering it to
    // someone who asked for one skill is how this produced workspaces full of
    // agents nobody wanted.
    expect(source).toContain('!catalogLoading && catalog && !activeFacet && view === "teams" && (');
  });

  it("switching back is one press, so the view is never a trap", () => {
    expect(source).toContain('role="tablist" aria-label="Library view"');
    expect(source).toContain("onClick={() => setView(candidate)}");
  });
});

describe("a skill the agent already has", () => {
  it("says so instead of offering to add it again", () => {
    // server/skills.ts refuses the duplicate with an error no person is ever
    // shown, so the button simply did nothing.
    expect(source).toContain("const alreadyAdded = Boolean(target && installed?.has(skillId));");
    expect(source).toContain("if (alreadyAdded) {");
    expect(source).toContain("already has this skill");
  });

  it("reads the target's set once, and treats an unreadable answer as unknown", () => {
    expect(source).toContain("const [installedSkills, setInstalledSkills] = useState<ReadonlySet<string>>(new Set());");
    // A failed read must render the ordinary Add button, never a false "Added".
    expect(source).toContain("live && setInstalledSkills(new Set())");
  });

  it("only claims it when there is a single agent the button would land on", () => {
    expect(source).toContain("const assignTarget = preselectedBot ?? (assignableBots.length === 1 ? assignableBots[0] : undefined);");
  });
});

describe("the agent picker", () => {
  it("carries a second line, because names are not unique", () => {
    // The live workspace has "Bruce" and "Bruce (Smart Trader)", and two
    // agents both called "Seam Audit Probe".
    expect(source).toContain("const detail = bot.title?.trim() || bot.description?.trim() || \"\";");
    expect(source).toMatch(/\{detail && <span[^>]*>\{detail\}<\/span>\}/);
  });
});

/** The role the org chart would give a bot restored with this patch. The
 *  point of the tier is that the chart reads three fields together, so the
 *  assertion is made through the one reader that owns that rule rather than
 *  against a field name. */
const restoredRole = (bot: ArchivedTeamBot) => {
  const patch = archivedRestorePatch(bot);
  return botRole({
    chiefOfStaff: patch.chiefOfStaff === true,
    chiefScope: patch.chiefScope === "workspace" ? "workspace" : undefined,
  });
};

describe("archivedRestorePatch", () => {
  it("puts the workspace Chief back in the workspace chair", () => {
    expect(restoredRole({ id: "a", chiefOfStaff: true, chiefTier: "workspace" })).toBe("chief");
  });

  it("puts a section lead back as a section lead", () => {
    expect(restoredRole({ id: "b", chiefOfStaff: true, chiefTier: "section" })).toBe("leader");
  });

  it("leads nothing when the archive says it led nothing", () => {
    const patch = archivedRestorePatch({ id: "c", chiefOfStaff: false, chiefTier: null });
    expect(patch.chiefOfStaff).toBeUndefined();
    expect(patch.chiefScope).toBeUndefined();
    expect(restoredRole({ id: "c", chiefOfStaff: false, chiefTier: null })).toBe("member");
  });

  it("un-archives every restored bot", () => {
    for (const bot of [
      { id: "a", chiefOfStaff: true, chiefTier: "workspace" } as const,
      { id: "b", chiefOfStaff: true, chiefTier: "section" } as const,
      { id: "c", chiefOfStaff: false, chiefTier: null } as const,
    ]) {
      expect(archivedRestorePatch(bot).hidden).toBe(false);
    }
  });

  it("falls back to a bare election for a payload with no tier at all", () => {
    // A response from a harness older than the tier field. The old meaning
    // is kept rather than guessed at: an election with no scope, which the
    // harness reads as this section's lead.
    expect(restoredRole({ id: "old", chiefOfStaff: true })).toBe("leader");
  });
});

describe("teamImportSkillSummary", () => {
  const failure = (
    stage: TeamImportSkillError["stage"],
    skillId: string,
  ): TeamImportSkillError => ({ botId: "b", botName: "Clerk", skillId, stage, error: "nope" });

  it("says nothing went wrong when nothing went wrong", () => {
    expect(teamImportSkillSummary({ skillErrors: [] })).toEqual({
      failed: 0,
      unavailable: 0,
      disabled: 0,
    });
  });

  it("counts a skill that never arrived apart from one that arrived switched off", () => {
    const summary = teamImportSkillSummary({
      skillErrors: [failure("install", "a"), failure("install", "b"), failure("enable", "c")],
    });
    // the two are different failures and a sentence written from this must
    // be able to tell them apart
    expect(summary).toEqual({ failed: 3, unavailable: 2, disabled: 1 });
    expect(summary.unavailable + summary.disabled).toBe(summary.failed);
  });
});
