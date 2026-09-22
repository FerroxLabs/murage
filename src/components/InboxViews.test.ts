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
import { INBOX_OWED_VIEWS, INBOX_VIEWS, INBOX_VIEW_COPY, INBOX_VIEW_EMPTY, inboxCardItems, owedWaitingLine, waitedFor } from "./Inbox";
import type { InboxItem } from "../../shared/inbox";
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

  it("reads each tab's number off its own field, and no other", () => {
    // WHAT THIS TEST IS NOT. It used to claim it proved the three parts sum
    // to the umbrella, using a page object whose four numbers were written
    // here to sum. It could not have failed, and it did not: a routine run
    // whose goal came back needing input was counted in `decisions` and in
    // no segment at all, so the badge said one and all three tabs said none.
    //
    // THE SUM IS A PROPERTY OF THE QUERY, so it is proved where the query
    // is: "counts nothing under an umbrella no tab can lift" in
    // server/inbox.test.ts, against real rows. All this can honestly check
    // is that no tab is quietly reading a neighbour's field.
    const page = { decisions: 9, approvals: 4, questions: 3, connections: 2 } as never;
    expect(byValue.decisions!.count!(page)).toBe(9);
    expect(byValue.approvals!.count!(page)).toBe(4);
    expect(byValue.questions!.count!(page)).toBe(3);
    expect(byValue.connections!.count!(page)).toBe(2);
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

// ONE LINE PER ROUTINE, AND THEN THIRTY SIX LINES UNDERNEATH IT.
//
// The rolled-up rows were added ABOVE the item list and the item list was
// never told to stand down, so the Routines tab rendered four summary lines
// followed by every run they summarised. The tab's own sentence promises
// "one line per routine, not per run" three inches above the thirty six.
describe("which lists get a card per row", () => {
  const items = [{ id: "a" }, { id: "b" }] as unknown as InboxItem[];

  it("draws no per-run cards under the rolled-up routines", () => {
    expect(inboxCardItems("routines", items)).toEqual([]);
  });

  it("draws them everywhere else", () => {
    // The negative control. Suppressing the cards on any other view would
    // empty a list the owner came to act on, which is a worse defect than
    // the one above.
    for (const { value } of INBOX_VIEWS) {
      if (value === "routines") continue;
      expect(inboxCardItems(value, items), `${value} must still render its rows`).toHaveLength(2);
    }
  });
});

describe("how long a thing has been waiting", () => {
  it("says it in a unit a person reads without arithmetic", () => {
    expect(waitedFor(9 * 60_000)).toBe("9 min");
    expect(waitedFor(60 * 60_000)).toBe("1 hour");
    expect(waitedFor(5 * 60 * 60_000)).toBe("5 hours");
    expect(waitedFor(4 * 24 * 60 * 60_000)).toBe("4 days");
    // It said "Waiting 6231 min for your approval", which is Tuesday.
    expect(waitedFor(4 * 24 * 60 * 60_000)).not.toMatch(/min/);
  });

  it("names what is wanted from the segment, not from the title", () => {
    // It chose its noun by searching the TITLE for the word "Question", so a
    // dead login read "waiting for your approval" and so did a routine that
    // had stopped to ask something.
    const at = 1_000_000, now = at + 9 * 60_000;
    const row = (segment: string, title: string) => ({ at, segment, title }) as unknown as InboxItem;
    expect(owedWaitingLine(row("approval", "Approval requested"), now)).toBe("Waiting 9 min for your approval.");
    expect(owedWaitingLine(row("question", "Morning digest"), now)).toBe("Waiting 9 min for your answer.");
    expect(owedWaitingLine(row("connection", "Connection setup"), now))
      .toBe("Stopped 9 min ago, and it stays stopped until you reconnect it.");
    // No em dashes, and never the vendor's name: the release is gated on both.
    for (const segment of ["approval", "question", "connection"]) {
      expect(owedWaitingLine(row(segment, "x"), now)).not.toMatch(/[\u2014\u2013]/);
    }
  });
});
