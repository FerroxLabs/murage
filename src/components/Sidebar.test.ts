import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// posthog-js boots on import and reaches for a real browser. Nothing under
// test here reports anything, so the module is stubbed rather than shimmed.
vi.mock("@/lib/analytics", () => ({
  analyticsEnabled: () => false,
  optAction: () => "none" as const,
  setAnalyticsEnabled: () => {},
  initAnalytics: () => {},
  track: () => {},
  identifyEmail: () => {},
  emailGateDone: () => false,
  setEmailGateDone: () => {},
}));

// Sidebar's import graph reads `window` at module scope (DesktopCapabilities
// asks the desktop shell what it is running on), and this suite runs in node.
// A bare object is the honest answer: no shell, browser capabilities.
(globalThis as unknown as { window?: unknown }).window ??= {};
const { TeamFeedbackToast, teamImportFeedback, teamImportShortfall, teamUndoRestores } =
  await import("./Sidebar");
import type {
  ArchivedTeamBot,
  TeamImportResult,
  TeamImportSkillError,
} from "./TeamLibraryPanel";
import { botRole } from "@/lib/bot-role";

/** The chair a bot lands in when the undo's PATCH is applied.
 *
 *  Asserted through `botRole` rather than against field names on purpose:
 *  the org chart is three fields read together, and the bug this guards was
 *  a body that looked right field by field and still put the workspace
 *  Chief one rung down. The only question worth asking a restore body is
 *  what chair it produces. */
const chairAfterUndo = (archived: ArchivedTeamBot) => {
  const [restore] = teamUndoRestores([archived]);
  return botRole({
    chiefOfStaff: restore.body.chiefOfStaff === true,
    chiefScope: restore.body.chiefScope === "workspace" ? "workspace" : undefined,
  });
};

const chief: ArchivedTeamBot = { id: "chief", chiefOfStaff: true, chiefTier: "workspace" };
const lead: ArchivedTeamBot = { id: "lead", chiefOfStaff: true, chiefTier: "section" };
const plain: ArchivedTeamBot = { id: "plain", chiefOfStaff: false, chiefTier: null };

describe("undoing a team import puts the old roster back in its own chairs", () => {
  it("returns the workspace Chief to the workspace chair", () => {
    expect(chairAfterUndo(chief)).toBe("chief");
  });

  it("returns a section lead as a section lead, not as the Chief", () => {
    // The opposite mistake to the one that started this. A restore that
    // reached for the workspace tier on every leader would seat the wrong
    // bot at the top and trip the harness's single-holder guard on the way.
    expect(chairAfterUndo(lead)).toBe("leader");
  });

  it("returns a bot that led nothing leading nothing", () => {
    expect(chairAfterUndo(plain)).toBe("member");
  });

  it("leaves no archived bot behind, whatever chair it held", () => {
    // The demotion arrived inside a branch split: chiefs down one path,
    // everyone else down another. One map over the whole archive is what
    // makes a second, divergent path impossible.
    const restores = teamUndoRestores([chief, lead, plain]);
    expect(restores.map((restore) => restore.id)).toEqual(["chief", "lead", "plain"]);
  });

  it("un-hides every one of them", () => {
    for (const restore of teamUndoRestores([chief, lead, plain])) {
      expect(restore.body.hidden).toBe(false);
    }
  });

  it("asks for nothing at all when nothing was archived", () => {
    // WEAKER THAN IT LOOKS: an empty archive maps to an empty list under any
    // implementation of this function, so no realistic mistake turns this
    // one red. Kept because an additive import must send no PATCH at all,
    // and that fact is worth stating even where a test cannot defend it.
    expect(teamUndoRestores([])).toEqual([]);
  });
});

const failure = (
  stage: TeamImportSkillError["stage"],
  skillId: string,
  botName = "Clerk",
): TeamImportSkillError => ({ botId: botName, botName, skillId, stage, error: "nope" });

const imported = (skillErrors: TeamImportSkillError[], archived: ArchivedTeamBot[] = []): TeamImportResult => ({
  name: "Ops crew",
  members: 3,
  importedBotIds: ["a", "b", "c"],
  importedGroupIds: [],
  importedRoutineIds: [],
  archived,
  skillErrors,
});

describe("a team that landed short of the skills it promised says so", () => {
  it("says nothing when the import was whole", () => {
    expect(teamImportShortfall({ skillErrors: [] })).toBe("");
  });

  it("speaks up when a skill did not make it", () => {
    expect(teamImportShortfall({ skillErrors: [failure("install", "web-search")] })).not.toBe("");
  });

  it("counts what is missing", () => {
    const detail = teamImportShortfall({
      skillErrors: [failure("install", "a"), failure("install", "b")],
    });
    expect(detail).toContain("2");
  });

  it("tells a skill that never arrived apart from one that arrived switched off", () => {
    // Two different things to go and fix. A summary that folds them into one
    // number sends somebody looking in the wrong place.
    const neverArrived = teamImportShortfall({ skillErrors: [failure("install", "a")] });
    const switchedOff = teamImportShortfall({ skillErrors: [failure("enable", "a")] });
    expect(switchedOff).not.toBe(neverArrived);
  });

  it("names the one bot that is short, and stops naming them past that", () => {
    const one = teamImportShortfall({ skillErrors: [failure("install", "a", "Clerk")] });
    expect(one).toContain("Clerk");
    const many = teamImportShortfall({
      skillErrors: [
        failure("install", "a", "Clerk"),
        failure("install", "b", "Scout"),
        failure("enable", "c", "Runner"),
      ],
    });
    expect(many).not.toContain("Clerk");
    expect(many).toContain("3");
  });

  it("never quotes a total it was not given", () => {
    // The response carries the failures, not the number of skills the
    // profile declared. "7 of 9" would be invented.
    const detail = teamImportShortfall({ skillErrors: [failure("install", "a"), failure("enable", "b")] });
    expect(detail).not.toMatch(/\bof\s+\d/);
  });

  it("carries no em dash", () => {
    expect(teamImportShortfall({ skillErrors: [failure("install", "a"), failure("enable", "b")] })).not.toMatch(
      /[–—]/,
    );
  });
});

describe("the toast a finished import puts up", () => {
  it("is not an error, even when skills were lost", () => {
    // The bots landed and the rooms landed. A red toast over a working team
    // would be wrong in the other direction, and would teach people to
    // dismiss the one that matters.
    expect(teamImportFeedback(imported([failure("install", "a")])).error).toBe(false);
  });

  it("carries the shortfall as a second line rather than in the headline", () => {
    const feedback = teamImportFeedback(imported([failure("install", "a")]));
    expect(feedback.detail).toBe(teamImportShortfall({ skillErrors: [failure("install", "a")] }));
    // Guarded, because `not.toContain("")` would report a missing detail as a
    // headline problem and send the next reader to the wrong place.
    expect(feedback.detail).not.toBe("");
    expect(feedback.text).not.toContain(feedback.detail);
  });

  it("says nothing extra about a whole import", () => {
    expect(teamImportFeedback(imported([])).detail).toBe("");
  });

  it("offers Undo only when there is a previous roster to put back", () => {
    expect(teamImportFeedback(imported([])).undo).toBeUndefined();
    expect(teamImportFeedback(imported([], [chief])).undo).toBeDefined();
  });

  it("renders the shortfall where a person will read it", () => {
    const feedback = teamImportFeedback(imported([failure("install", "a"), failure("enable", "b")]));
    const markup = renderToStaticMarkup(
      createElement(TeamFeedbackToast, { feedback, onUndoTeam: () => {}, onUndoBot: () => {} }),
    );
    expect(feedback.detail).not.toBe("");
    expect(markup).toContain(feedback.detail);
  });

  it("renders no second line at all when there is nothing to add", () => {
    const markup = renderToStaticMarkup(
      createElement(TeamFeedbackToast, {
        feedback: teamImportFeedback(imported([])),
        onUndoTeam: () => {},
        onUndoBot: () => {},
      }),
    );
    expect(markup).not.toContain("<p");
  });

  it("does not dress a short import in the error styling", () => {
    const markup = renderToStaticMarkup(
      createElement(TeamFeedbackToast, {
        feedback: teamImportFeedback(imported([failure("install", "a")])),
        onUndoTeam: () => {},
        onUndoBot: () => {},
      }),
    );
    expect(markup).not.toContain("text-danger");
  });
});
