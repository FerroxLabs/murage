// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// CHARGE-UNKNOWN-1018: when some turn's charge is only its known part, both places that show the project's reported charge
// say "at least" (ProjectStripDetails and the goal view's budget lines); an exact charge keeps its plain wording.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ProjectStripDetails } from "./ProjectStripDetails";
import { goalBudgetLines } from "@/lib/project-goal-view";
import type { ProjectRead, UsageRead } from "@/lib/project-client";

vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { groups: [], bots: [] } }),
}));

const strip = (chargeIsLowerBound: boolean): ProjectRead => ({
  lifecycle: "open", settings: { groupId: "g", mode: "ongoing", leadBotId: "a", parts: {}, runState: "running", closedAt: null, endedAt: null, revision: 1 },
  brief: null, goal: { id: "goal", title: "Finish the launch", state: "working", revision: 1 }, budgets: [],
  strip: { line: "", needsYou: 0, usage: { workMs: 60000, input: 4, output: 6, tokensReported: true, charge: 0.123456, chargeIsLowerBound } },
  sinceYouLeft: { messages: 0, cards: 0, decisions: 0 }, revision: 1,
} as ProjectRead);
const read = (chargeIsLowerBound: boolean): UsageRead => ({ lifecycle: "open", totals: { workMs: 0, input: 0, output: 0, tokensReported: false, charge: 0.123456, chargeIsLowerBound }, byBot: [], notReported: [], budgets: [] });

it("the strip details say at least for a lower-bound charge and keep the exact wording otherwise", () => {
  const partial = renderToStaticMarkup(createElement(ProjectStripDetails, { project: strip(true), groupId: "g", onBoard: vi.fn() }));
  expect(partial).toContain("Reported cost: at least $0.1235");
  const exact = renderToStaticMarkup(createElement(ProjectStripDetails, { project: strip(false), groupId: "g", onBoard: vi.fn() }));
  expect(exact).toContain("Reported cost: $0.1235");
  expect(exact).not.toContain("at least");
});

it("the goal view's budget lines say at least for a lower-bound charge and keep the exact wording otherwise", () => {
  expect(goalBudgetLines(undefined, read(true), [])).toContain("Reported charge: at least $0.1235");
  const exact = goalBudgetLines(undefined, read(false), []);
  expect(exact).toContain("Reported charge: $0.1235");
  expect(exact.join(" ")).not.toContain("at least");
});
