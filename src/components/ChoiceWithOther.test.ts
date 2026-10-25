// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shared "Other" (QW Q4, item 24), in node the way the rest of the renderer suite is (no DOM): the rules as pure
// functions, the markup both users draw, and the widget's press built from the words typed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { OptionCardData } from "@/state/store";
import { WIDGET_LIMITS, parseWidgetInput, widgetActions, widgetTakesOther, type WidgetRoot } from "../../shared/widget";
import type { QuestionSpec } from "../../shared/questions";
import { OTHER_MAX_LENGTH, OtherField, OtherRow, clipOther, otherBlocksConfirm } from "./ChoiceWithOther";
import { QuestionCardView, draftAnswers, draftsComplete, initialDrafts, setOther, toggleOption } from "./QuestionCard";
import { editChooseOther, editOther, editValue, preparePress } from "./widget/widget-form";

const parsed = (input: unknown): WidgetRoot => {
  const result = parseWidgetInput(input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const choiceCard = (allowOther?: boolean, extra: Record<string, unknown> = {}): WidgetRoot => parsed({
  type: "Card", title: "Pick a plan",
  children: [{ type: "RadioGroup", name: "plan", label: "Plan", options: [{ value: "a", label: "Plan A" }, { value: "b", label: "Plan B" }], ...(allowOther === undefined ? {} : { allowOther }), ...extra }],
  confirm: { label: "Send", action: { type: "plan.send" } },
});

const confirmOf = (root: WidgetRoot) => widgetActions(root).find((entry) => entry.ref === "confirm")!;
const noEdits = { values: {}, other: {} };

describe("the rules", () => {
  it("clips the owner's words to the limit and leaves shorter words alone", () => {
    expect(clipOther("a".repeat(OTHER_MAX_LENGTH + 500)).length).toBe(OTHER_MAX_LENGTH);
    expect(clipOther("x".repeat(50), 10)).toBe("x".repeat(10));
    expect(clipOther("my own words")).toBe("my own words");
    // the question card's limit and a widget field's limit are the same number
    expect(OTHER_MAX_LENGTH).toBe(WIDGET_LIMITS.fieldValue);
  });

  it("blocks confirm while Other is chosen and its words are empty or only spaces", () => {
    expect(otherBlocksConfirm(true, "")).toBe(true);
    expect(otherBlocksConfirm(true, "   \n")).toBe(true);
    expect(otherBlocksConfirm(true, "a third way")).toBe(false);
    // Other not chosen: nothing to wait for
    expect(otherBlocksConfirm(false, "")).toBe(false);
  });
});

describe("the field", () => {
  it("is a text field that takes at most the limit, named for a screen reader, and hides a secret answer", () => {
    const html = renderToStaticMarkup(createElement(OtherField, { value: "hi", onChange: () => {}, ariaLabel: "Your own answer", placeholder: "Type your own answer" }));
    expect(html).toContain('type="text"');
    expect(html).toContain(`maxLength="${OTHER_MAX_LENGTH}"`);
    expect(html).toContain('aria-label="Your own answer"');
    expect(html).toContain('placeholder="Type your own answer"');
    expect(renderToStaticMarkup(createElement(OtherField, { value: "", onChange: () => {}, ariaLabel: "x", placeholder: "x", secret: true }))).toContain('type="password"');
  });

  it("clips what is typed or pasted before it reaches the caller", () => {
    let seen = "";
    const element = OtherField({ value: "", onChange: (text) => { seen = text; }, ariaLabel: "x", placeholder: "x", maxLength: 8 });
    (element.props as { onChange: (event: { target: { value: string } }) => void }).onChange({ target: { value: "0123456789" } });
    expect(seen).toBe("01234567");
  });

  it("draws the stacked row as one radio with its label, and no field of its own", () => {
    const html = renderToStaticMarkup(createElement(OtherRow, {
      layout: "stacked", chosen: true, text: "words", disabled: false, label: "Other", onChoose: () => {}, onText: () => {},
      rowProps: { role: "radio", "aria-checked": true }, rowClassName: "row",
    }));
    expect(html).toContain('role="radio"');
    expect(html).toContain("Other");
    expect(html).not.toContain("<input");
  });
});

describe("a widget field answered with Other", () => {
  it("offers Other by default on a radio group, a select and a named list, and not when the bot said no", () => {
    expect(widgetTakesOther(choiceCard().children![0]!)).toBe(true);
    expect(widgetTakesOther(choiceCard(false).children![0]!)).toBe(false);
    const list = parsed({
      type: "ListView", title: "Where", name: "where", confirm: { label: "Go", action: { type: "go" } },
      children: [{ type: "ListViewItem", children: [{ type: "Text", value: "Home" }] }, { type: "ListViewItem", children: [{ type: "Text", value: "Office" }] }],
    });
    expect(widgetTakesOther(list)).toBe(true);
  });

  it("sends the typed words in `other` and the field itself as empty", () => {
    const root = choiceCard();
    let edits = editChooseOther(noEdits, "plan");
    edits = editOther(edits, "plan", "  a plan of my own ");
    const sent = preparePress(root, confirmOf(root), "confirm", edits.values, edits.other);
    expect(sent).toEqual({ ok: true, values: { plan: "" }, other: { plan: "  a plan of my own " } });
  });

  it("stops the press while Other is chosen with nothing typed, even where the field is not required, and says which field", () => {
    const root = choiceCard();
    const edits = editChooseOther(noEdits, "plan");
    const stopped = preparePress(root, confirmOf(root), "confirm", edits.values, edits.other);
    expect(stopped.ok).toBe(false);
    if (stopped.ok) throw new Error("unreachable");
    expect(stopped.field).toBe("plan");
    expect(stopped.where).toBe("data-widget-other");
    expect(stopped.text).toContain("Plan");
    // spaces alone are still nothing
    const spaces = editOther(edits, "plan", "    ");
    expect(preparePress(root, confirmOf(root), "confirm", spaces.values, spaces.other).ok).toBe(false);
  });

  it("clips long words to the field limit, as typed and as sent", () => {
    const root = choiceCard();
    let edits = editChooseOther(noEdits, "plan");
    edits = editOther(edits, "plan", "w".repeat(WIDGET_LIMITS.fieldValue + 300));
    expect(edits.other.plan!.length).toBe(WIDGET_LIMITS.fieldValue);
    const sent = preparePress(root, confirmOf(root), "confirm", edits.values, { plan: "w".repeat(WIDGET_LIMITS.fieldValue + 300) });
    if (!sent.ok) throw new Error("expected a send");
    expect(sent.other!.plan!.length).toBe(WIDGET_LIMITS.fieldValue);
  });

  it("drops the words when an option is picked after all, and sends that option", () => {
    const root = choiceCard();
    let edits = editOther(editChooseOther(noEdits, "plan"), "plan", "mine");
    edits = editValue(edits, "plan", "b");
    expect(edits.other).toEqual({});
    expect(preparePress(root, confirmOf(root), "confirm", edits.values, edits.other)).toEqual({ ok: true, values: { plan: "b" } });
  });

  it("lets a cancel through with Other empty, sending nothing", () => {
    const root = parsed({
      type: "Card", children: [{ type: "RadioGroup", name: "plan", options: [{ value: "a" }, { value: "b" }] }],
      confirm: { label: "Send", action: { type: "send" } }, cancel: { label: "Never mind", action: { type: "no" } },
    });
    const edits = editChooseOther(noEdits, "plan");
    const cancel = widgetActions(root).find((entry) => entry.ref === "cancel")!;
    expect(preparePress(root, cancel, "cancel", edits.values, edits.other)).toEqual({ ok: true });
  });
});

describe("the question card keeps its answers", () => {
  const plan: QuestionSpec = { id: "q1", question: "Which plan?", options: [{ label: "A" }, { label: "B" }], multiSelect: false, allowOther: true };
  const parts: QuestionSpec = { id: "q2", question: "Which parts?", options: [{ label: "Intro" }, { label: "Outro" }], multiSelect: true, allowOther: true };
  const card: OptionCardData = { title: "Q", subtitle: plan.question, options: ["A", "B"], requestId: "r1", questions: [plan, parts] };

  it("sends the same payload for typed words, with an option chosen, and with nothing", () => {
    const empty = initialDrafts([plan, parts], undefined);
    expect(draftAnswers([plan, parts], setOther(empty, plan, "  my own  "))).toEqual([{ id: "q1", selected: [], other: "my own" }, { id: "q2", selected: [] }]);
    const multi = setOther(toggleOption(empty, parts, "Intro"), parts, "and notes");
    expect(draftAnswers([plan, parts], multi)[1]).toEqual({ id: "q2", selected: ["Intro"], other: "and notes" });
    expect(draftsComplete([plan], setOther(empty, plan, "mine"))).toBe(true);
    // Other chosen and empty does not count as an answer for a single choice
    expect(draftsComplete([plan], { q1: { selected: [], other: "", otherSelected: true } })).toBe(false);
  });

  it("draws its Other as the shared row: the pill, its radio, and a field that takes the limit", () => {
    const html = renderToStaticMarkup(createElement(QuestionCardView, { card, botName: "Sable", onSubmit: () => {}, onSkip: () => {}, onSendAsMessage: () => {} }));
    expect(html).toContain('aria-label="Other"');
    expect(html).toContain(`maxLength="${OTHER_MAX_LENGTH}"`);
    expect(html).toContain('placeholder="Type your own answer"');
    expect(html).toContain('aria-label="Your own answer to: Which plan?"');
    expect(html).toContain('role="radio"');
    expect(html).toContain('role="checkbox"');
  });

  it("is the shared component that draws it", () => {
    const source = readSource("./QuestionCard.tsx");
    expect(source).toContain('from "./ChoiceWithOther"');
    expect(source).toContain("<OtherRow");
    expect(source).not.toContain("function Indicator");
  });
});

function readSource(file: string): string {
  return readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
}
