// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { FULL_ACCESS_STEPS_KEPT, extendStepLine, fullAccessStepsLabel, newStepLine } from "./full-access-steps.ts";
import type { Message } from "./store.ts";

const msg = (id: string, patch: Partial<Message>): Message => ({ id, role: "bot", kind: "activity", at: 1, ...patch });
const line = (steps = ["shell: ls"], turnId = "t1") => msg("line", { turnId, tool: newStepLine(steps[0]!) });

describe("Full access approvals collapse into one line per run", () => {
  it("counts up through the tool chips it approved", () => {
    const messages = [line(), msg("chip", { tool: { name: "Bash", ok: true } })];
    const next = extendStepLine(messages, "line", "t1", "shell: npm test")!;
    expect(next).toMatchObject({ name: "Approved 2 steps (Full access)", steps: ["shell: ls", "shell: npm test"], stepCount: 2 });
  });

  it("starts a new line after the bot says something, a card, another turn, or another approval chip", () => {
    expect(extendStepLine([line(), msg("text", { kind: "text", text: "done" })], "line", "t1", "x")).toBeNull();
    expect(extendStepLine([line(), msg("card", { kind: "options" })], "line", "t1", "x")).toBeNull();
    expect(extendStepLine([line()], "line", "t2", "x")).toBeNull();
    expect(extendStepLine([line(), msg("auto", { tool: { name: "auto-approved Bash:git (always allowed): git status", ok: true } })], "line", "t1", "x")).toBeNull();
    expect(extendStepLine([line()], undefined, "t1", "x")).toBeNull();
  });

  it("keeps the newest steps and the full count", () => {
    let messages: Message[] = [line()];
    for (let i = 0; i < FULL_ACCESS_STEPS_KEPT + 5; i += 1) messages = [msg("line", { turnId: "t1", tool: extendStepLine(messages, "line", "t1", `step ${i}`)! })];
    expect(messages[0]!.tool!.steps).toHaveLength(FULL_ACCESS_STEPS_KEPT);
    expect(messages[0]!.tool!.stepCount).toBe(FULL_ACCESS_STEPS_KEPT + 6);
    expect(messages[0]!.tool!.steps!.at(-1)).toBe(`step ${FULL_ACCESS_STEPS_KEPT + 4}`);
  });

  it("names one step and many plainly", () => {
    expect(fullAccessStepsLabel(1)).toBe("Approved 1 step (Full access)");
    expect(fullAccessStepsLabel(12)).toBe("Approved 12 steps (Full access)");
  });
});
