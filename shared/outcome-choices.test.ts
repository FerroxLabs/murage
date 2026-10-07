// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { isSalesBot, outcomeChoices, outcomeWord } from "./outcome-choices.ts";

it("a sales bot is offered Won and Lost first, every other bot Good and Bad", () => {
  expect(outcomeChoices({ name: "Dax", title: "Sales development", description: "" }).map(choice => choice.kind)).toEqual(["won", "lost"]);
  expect(outcomeChoices({ name: "Ember", title: "Chief of Staff", description: "Briefs and follow-ups" }).map(choice => choice.kind)).toEqual(["good", "bad"]);
  expect(outcomeChoices({ name: "Ember" }).map(choice => choice.label)).toEqual(["Mark as good", "Mark as bad"]);
});
it("reads the role from the description too, and not from half a word", () => {
  expect(isSalesBot({ name: "Dax", description: "Works the pipeline and follows up on leads" })).toBe(true);
  expect(isSalesBot({ name: "Wholesome", title: "Resale helper unrelated" })).toBe(false);
});
it("words the outcome plainly", () => { expect(outcomeWord("won")).toBe("Won"); });
