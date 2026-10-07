// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { envelopeNotUsedLine, envelopeRefusalLine, parseGoalEnvelopeV2, stripGoalEnvelopes } from "./goal-envelope-v2.ts";

const env = (value: unknown) => `<murage-goal>${typeof value === "string" ? value : JSON.stringify(value)}</murage-goal>`;

describe("goal envelope v2 parse (SPEC-P 9)", () => {
  it("the last complete envelope wins and every envelope leaves the visible text", () => {
    const text = `Here is an example ${env({ v: 2, status: "blocked", detail: "quoted" })} and the plan.\n${env({ v: 2, status: "assign", cards: [] })}`;
    const parsed = parseGoalEnvelopeV2(text);
    expect(parsed.envelope).toEqual({ v: 2, status: "assign", cards: [] });
    expect(parsed.visibleText).toBe("Here is an example  and the plan.");
    expect(parsed.error).toBeUndefined();
  });
  it("reports JSON it cannot read and a v1 envelope, with a plain line", () => {
    expect(parseGoalEnvelopeV2(env("{not json")).error).toBe("it is not valid JSON");
    expect(parseGoalEnvelopeV2(env({ status: "continue", next: "x", instruction: "y" })).error).toMatch(/version 2/);
    expect(parseGoalEnvelopeV2(env([1, 2])).error).toBe("it is not a JSON object");
    expect(envelopeRefusalLine("it is not valid JSON")).toBe("Your plan could not be read: it is not valid JSON");
  });
  // Round 12 (L1): a plan that was read but refused is not "could not be read"
  it("a refused plan reads as not used, on one line", () => {
    expect(envelopeNotUsedLine("Nova", 'seg: Dax already has card 3 "Segments" (card_id "c3") on this goal.\nUse that card.'))
      .toBe('Nova\'s plan was not used: seg: Dax already has card 3 "Segments" (card_id "c3") on this goal. Use that card.');
  });
  it("no envelope, no error; a dangling half is private too", () => {
    expect(parseGoalEnvelopeV2("just prose")).toEqual({ visibleText: "just prose" });
    expect(stripGoalEnvelopes(`Done so far. <murage-goal>{"v":2,"sta`)).toBe("Done so far.");
  });
});
