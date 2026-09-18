import { describe, expect, it } from "vitest";

import { AGENT_PLAN_MAX_CHARS, AGENT_PLAN_MAX_ENTRIES, normalizeAgentPlan } from "./agent-plan";

describe("normalizeAgentPlan", () => {
  it("keeps each entry's text and status", () => {
    expect(normalizeAgentPlan([
      { content: "Read the folder", priority: "high", status: "completed" },
      { content: "Fix the bug", priority: "medium", status: "in_progress" },
      { content: "Report back", priority: "low", status: "pending" },
    ])).toEqual([
      { content: "Read the folder", status: "completed" },
      { content: "Fix the bug", status: "in_progress" },
      { content: "Report back", status: "pending" },
    ]);
  });

  it("ignores an update whose entries are not a list, but keeps an emptied plan", () => {
    expect(normalizeAgentPlan("not a list")).toBeNull();
    expect(normalizeAgentPlan(undefined)).toBeNull();
    expect(normalizeAgentPlan([])).toEqual([]);
  });

  it("drops entries without text and reads an unknown status as pending", () => {
    expect(normalizeAgentPlan([
      null,
      { status: "pending" },
      { content: "   ", status: "pending" },
      { content: "Later", status: "someday" },
    ])).toEqual([{ content: "Later", status: "pending" }]);
  });

  it("bounds the number of entries and the length of each", () => {
    const many = Array.from({ length: AGENT_PLAN_MAX_ENTRIES + 5 }, (_, index) => ({ content: `step ${index}`, status: "pending" }));
    expect(normalizeAgentPlan(many)).toHaveLength(AGENT_PLAN_MAX_ENTRIES);
    const [long] = normalizeAgentPlan([{ content: "x".repeat(AGENT_PLAN_MAX_CHARS * 2), status: "pending" }])!;
    expect(long.content).toHaveLength(AGENT_PLAN_MAX_CHARS);
    expect(long.content.endsWith("…")).toBe(true);
  });

  it("folds line breaks so an entry stays one line", () => {
    expect(normalizeAgentPlan([{ content: "one\n  two", status: "pending" }])).toEqual([{ content: "one two", status: "pending" }]);
  });
});
