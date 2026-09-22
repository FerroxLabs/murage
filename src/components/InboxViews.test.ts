// THE RULE THE WHOLE REDESIGN RESTS ON.
//
// The owner's Inbox said thirty six. Thirty five of those were one provider
// outage listed once per run, every one already recovered; the thirty sixth
// was a dead Gmail token that only he could fix, and it was invisible inside
// them. The fix is not a better label. It is that A COUNT HE CANNOT ACT ON IS
// A COUNT HE STOPS READING.
//
// So: approvals, decisions and connections carry numbers, because each is a
// thing a person is being asked for. Routines and results carry none, because
// they are things that HAPPENED — telling him is the whole job, and a badge
// on them grows by itself until it means nothing again.
//
// This is a cheap test guarding an expensive lesson. If someone ever adds a
// count to Routines "so you can see how many ran", it goes red and this
// comment is why.
import { describe, expect, it } from "vitest";

import en from "@/locales/en.json";
import { INBOX_OWED_VIEWS, INBOX_VIEWS, INBOX_VIEW_COPY, INBOX_VIEW_EMPTY } from "./Inbox";
import { INBOX_BADGED_SEGMENTS } from "../../shared/inbox";

const byValue = Object.fromEntries(INBOX_VIEWS.map(entry => [entry.value, entry]));

describe("which Inbox lists are allowed to show a number", () => {
  it("counts the three things a person is asked for", () => {
    for (const value of ["decisions", "approvals", "questions", "connections"] as const) {
      expect(byValue[value]?.count, `${value} must carry a count`).toBeTypeOf("function");
    }
  });

  it("never counts the things that merely happened", () => {
    for (const value of ["routines", "results", "all"] as const) {
      expect(byValue[value]?.count, `${value} must NOT carry a count`).toBeUndefined();
    }
  });

  it("agrees with the segments the shared model says may badge", () => {
    // Two files could drift here: the server decides which segments badge,
    // this decides which tabs show a number. They have to name the same set.
    expect([...INBOX_BADGED_SEGMENTS].sort()).toEqual(["approval", "connection", "question"]);
    const badgedTabs = INBOX_VIEWS.filter(entry => entry.count).map(entry => entry.value).sort();
    expect(badgedTabs, "the umbrella plus one tab per badged segment")
      .toEqual(["approvals", "connections", "decisions", "questions"]);
  });

  it("opens on the umbrella the sidebar badge points at", () => {
    // The sidebar row asks for `view=decisions` and shows `page.decisions`.
    // If that view had no tab, pressing the badge would land on a list with
    // nothing selected and a number that matched none of the tabs.
    expect(INBOX_VIEWS[0]?.value).toBe("decisions");
    expect(INBOX_VIEWS[0]?.label).toBe("Needs you");
  });

  it("breaks the umbrella into parts that sum to it", () => {
    const page = { decisions: 5, approvals: 2, questions: 1, connections: 2 } as never;
    const part = (value: string) => byValue[value]!.count!(page);
    expect(part("approvals") + part("questions") + part("connections")).toBe(part("decisions"));
  });
});

describe("what each list says for itself", () => {
  it("gives every tab a sentence and an empty state", () => {
    for (const { value, label } of INBOX_VIEWS) {
      expect(INBOX_VIEW_COPY[value], `${label} needs a sentence`).toBeTruthy();
      if (value !== "all") expect(INBOX_VIEW_EMPTY[value], `${label} needs an empty state`).toBeTruthy();
    }
  });

  it("says what each of the three is, in words that tell them apart", () => {
    // They read identically today, which is the whole reason the owner could
    // not find the one that mattered.
    expect(INBOX_VIEW_COPY.approvals, "an approval is already drafted").toMatch(/drafted/i);
    expect(INBOX_VIEW_COPY.questions, "a question has nothing drafted").toMatch(/nothing is drafted/i);
    expect(INBOX_VIEW_COPY.connections, "a connection needs hands").toMatch(/your hands/i);
    expect(INBOX_VIEW_COPY.routines, "a routine is not waiting on anybody").toMatch(/nothing here is waiting on you/i);
  });

  it("promises one line per routine, because that is the fix", () => {
    expect(INBOX_VIEW_COPY.routines).toMatch(/per routine, not per run/i);
  });

  it("keeps the house copy rules the release is gated on", () => {
    // No em dashes anywhere a person reads, and the price rule.
    for (const [view, copy] of Object.entries({ ...INBOX_VIEW_COPY, ...INBOX_VIEW_EMPTY })) {
      expect(copy, `${view} must not use an em or en dash`).not.toMatch(/[—–]/);
      expect(copy!.toLowerCase(), `${view} must not name the connector vendor`).not.toContain("composio");
    }
  });

  it("offers no snooze filter on anything that is owed", () => {
    expect([...INBOX_OWED_VIEWS].sort()).toEqual(["approvals", "connections", "decisions", "questions"]);
    expect(INBOX_OWED_VIEWS).not.toContain("routines");
  });

  it("uses the owner's own word for the judgement list", () => {
    // The wire name is `questions` because `decisions` is taken by the
    // umbrella; the LABEL is his word, and the two must not swap by accident.
    expect(byValue.questions?.label).toBe("Decisions");
    expect(en, "the tab labels are literals here, not lookups").toBeTruthy();
  });
});
