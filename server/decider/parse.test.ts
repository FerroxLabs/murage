// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Accept/reject vectors ported from OpenMausBot's decider tests (Apache-2.0).
import { describe, expect, it } from "vitest";

import { parseDecideResponse } from "./parse.ts";
import type { DeciderQuestion } from "./types.ts";

const OPTIONS = { maya: "Maya, Product Designer bot.", theo: "Theo, Frontend Engineer bot." };
const CHOICE: Record<string, DeciderQuestion> = { answer: { type: "choice", instructions: "Who?", options: OPTIONS } };
const choiceBody = (choice: string, probabilities: Record<string, number>) => ({
  model: "flux-decide-1", answers: { answer: { type: "choice", choice, confidence: 0.9, probabilities } }, usage: { input_tokens: 612 },
});

describe("parseDecideResponse", () => {
  it("accepts a valid choice with pTop, margin, tokens and model", () => {
    const parsed = parseDecideResponse(choiceBody("theo", { theo: 0.94, maya: 0.06 }), CHOICE);
    expect(parsed).toMatchObject({ ok: true, inputTokens: 612, model: "flux-decide-1" });
    if (!parsed.ok) throw new Error("expected ok");
    expect(parsed.answers.answer).toMatchObject({ type: "choice", choice: "theo", pTop: 0.94 });
    expect((parsed.answers.answer as { margin: number }).margin).toBeCloseTo(0.88);
  });

  it("tolerates a rounded sum within 0.1", () => {
    expect(parseDecideResponse(choiceBody("theo", { theo: 0.93, maya: 0.05 }), CHOICE).ok).toBe(true);
    expect(parseDecideResponse(choiceBody("theo", { theo: 0.7, maya: 0.1 }), CHOICE).ok).toBe(false);
  });

  it.each([
    ["a choice that was never offered", choiceBody("quinn", { quinn: 1 })],
    ["a probability for an option that was never offered", choiceBody("theo", { theo: 0.9, quinn: 0.1 })],
    ["a probability that is not a number", choiceBody("theo", { theo: "0.9" as unknown as number, maya: 0.1 })],
    ["a probability above one", choiceBody("theo", { theo: 1.5, maya: 0 })],
    ["a negative probability, even when the map sums to one", choiceBody("theo", { theo: 1.2, maya: -0.2 })],
    ["a choice that is not the most likely option", choiceBody("maya", { maya: 0.2, theo: 0.8 })],
    ["probabilities that do not add up", choiceBody("theo", { theo: 0.3, maya: 0.2 })],
    ["no answer for the question", { answers: {} }],
    ["an answer of the wrong type", { answers: { answer: { type: "noul", noul: 0.9 } } }],
    ["no answers at all", { model: "x" }],
    ["a body that is not an object", "nope"],
    ["null", null],
  ])("rejects %s", (_name, body) => {
    expect(parseDecideResponse(body, CHOICE)).toEqual({ ok: false });
  });

  it("yes/no must be a probability", () => {
    const question: Record<string, DeciderQuestion> = { answer: { type: "yesno", instructions: "?" } };
    expect(parseDecideResponse({ answers: { answer: { noul: 1.2 } } }, question)).toEqual({ ok: false });
    expect(parseDecideResponse({ answers: { answer: { noul: null } } }, question)).toEqual({ ok: false });
    expect(parseDecideResponse({ answers: { answer: { noul: 0.4 } } }, question)).toMatchObject({ ok: true });
  });

  it("scores: indexes in range, sum near one, level is the argmax", () => {
    const question: Record<string, DeciderQuestion> = { answer: { type: "score", instructions: "?", levels: ["a", "b", "c"] } };
    const ok = parseDecideResponse({ answers: { answer: { type: "score", score: 1.2, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 } } } }, question);
    expect(ok).toMatchObject({ ok: true, answers: { answer: { level: 1 } } });
    expect(parseDecideResponse({ answers: { answer: { type: "score", score: 5, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 } } } }, question)).toEqual({ ok: false });
    expect(parseDecideResponse({ answers: { answer: { type: "score", score: 1, probabilities: { 0: 0.5, 7: 0.5 } } } }, question)).toEqual({ ok: false });
  });

  it("bundles several questions and types each answer", () => {
    const parsed = parseDecideResponse({
      answers: { route: { type: "choice", choice: "maya", probabilities: { maya: 0.9, theo: 0.1 } }, urgent: { type: "noul", noul: 0.2 } },
    }, { route: CHOICE.answer!, urgent: { type: "yesno", instructions: "?" } });
    expect(parsed).toMatchObject({ ok: true, answers: { route: { choice: "maya", pTop: 0.9 }, urgent: { p: 0.2 } } });
  });
});
