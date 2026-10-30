// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Working now (UX 1.0.13, lane L2A): who counts as working, the rail tooltip,
// and the ten quiet minutes before "Still working on this".
import { describe, expect, it } from "vitest";
import { STILL_WORKING_MS, minutesSince, railWorkingTip, soFarLine, stillWorking, workingNow } from "./working-now";

const T0 = Date.UTC(2026, 9, 30, 8, 41);
const bot = (over: Record<string, unknown> = {}) => ({ id: "max", name: "Max", threadId: "t1", ...over }) as Parameters<typeof workingNow>[0][number];

describe("workingNow", () => {
  it("counts a running turn, from activity or from busy when no activity is reported", () => {
    expect(workingNow([bot({ activity: "working", turnStartedAt: T0 })])).toEqual([{ botId: "max", botName: "Max", threadId: "t1", what: "", since: T0 }]);
    expect(workingNow([bot({ busy: true })])).toHaveLength(1);
  });

  it("does not count a bot waiting on the owner, idle, or busy with an idle activity", () => {
    expect(workingNow([bot({ activity: "waiting-on-you", busy: true })])).toEqual([]);
    expect(workingNow([bot({ activity: "idle", busy: true })])).toEqual([]);
    expect(workingNow([bot({})])).toEqual([]);
  });

  it("lists each running task once, with its title, the open one included, longest-running first", () => {
    const items = workingNow([
      bot({ activity: "working", turnStartedAt: T0 + 60_000, tasks: [{ threadId: "t1", title: "matching invoices", activity: "working", turnStartedAt: T0 + 60_000 }, { threadId: "t2", title: "filing receipts", busy: true, turnStartedAt: T0 }] }),
      bot({ id: "nova", name: "Nova", threadId: "n1", activity: "working" }),
    ]);
    expect(items.map((item) => [item.botName, item.threadId, item.what])).toEqual([["Max", "t2", "filing receipts"], ["Max", "t1", "matching invoices"], ["Nova", "n1", ""]]);
  });

  it("counts a hidden bot: hiding it does not stop it", () => {
    expect(workingNow([bot({ hidden: true, activity: "working" })])).toHaveLength(1);
  });
});

describe("the words", () => {
  it("says minutes so far, under a minute, or nothing when the start is unknown", () => {
    expect(soFarLine(T0, T0 + 4 * 60_000 + 5_000)).toBe("4 min so far");
    expect(soFarLine(T0, T0 + 20_000)).toBe("Under a minute so far");
    expect(soFarLine(null, T0)).toBe("");
    expect(minutesSince(T0 + 60_000, T0)).toBe(0);
  });

  it("reads the rail tooltip as in the mockup", () => {
    expect(railWorkingTip({ botId: "max", botName: "Max", threadId: "t1", what: "matching invoices", since: T0 }, T0 + 4 * 60_000)).toBe("Working: matching invoices, 4 min");
    expect(railWorkingTip({ botId: "max", botName: "Max", threadId: "t1", what: "", since: null }, T0)).toBe("Working: a task");
    expect(railWorkingTip({ botId: "max", botName: "Max", threadId: "t1", what: "x", since: T0 }, T0)).toBe("Working: x, 1 min");
  });
});

describe("stillWorking", () => {
  it("turns on at ten quiet minutes, counted from the turn start or the newest row, whichever is later", () => {
    expect(STILL_WORKING_MS).toBe(600_000);
    expect(stillWorking({ working: true, since: T0, lastRowAt: null, now: T0 + 599_999 })).toBe(false);
    expect(stillWorking({ working: true, since: T0, lastRowAt: null, now: T0 + 600_000 })).toBe(true);
    expect(stillWorking({ working: true, since: T0, lastRowAt: T0 + 300_000, now: T0 + 600_000 })).toBe(false);
    expect(stillWorking({ working: true, since: T0, lastRowAt: T0 + 300_000, now: T0 + 900_000 })).toBe(true);
  });
  it("stays off when nothing runs or nothing says when it started", () => {
    expect(stillWorking({ working: false, since: T0, lastRowAt: null, now: T0 + 3_600_000 })).toBe(false);
    expect(stillWorking({ working: true, since: null, lastRowAt: null, now: T0 })).toBe(false);
  });
});
