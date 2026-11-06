// Copyright OpenMausBot contributors
// SPDX-License-Identifier: Apache-2.0
//
// Ported from OpenMausBot src/components/widget/WidgetMessage.test.ts, WidgetFields.test.ts and WidgetChoiceList.test.ts
// (PRs #2820, #3002), adapted by Ferrox Labs for Murage 1.0.4: rendered in node the way Murage's component suite is (no
// DOM), the press rules as pure functions, and the store action a press dispatches (`respondWidget`).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { parseWidgetInput, widgetActions, type WidgetPayload, type WidgetRoot } from "../../../shared/widget";
import { widgetChartGeometry, widgetChartHeight } from "../../../shared/widget-chart";
import { groupTranscript } from "@/lib/activity-runs";
import { WidgetMessageView } from "./WidgetMessage";
import { editChooseOther, editOther, editValue, preparePress } from "./widget-form";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

const parsed = (input: unknown): WidgetRoot => {
  const result = parseWidgetInput(input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const row = (root: WidgetRoot, more: Partial<WidgetPayload> = {}): Message => ({
  id: "w1", role: "bot", kind: "text", at: 1, text: "the readable fallback", widget: { id: "wid1", root, ...more },
});

const draw = (message: Message) => renderToStaticMarkup(createElement(WidgetMessageView, { message, respond: () => {}, reopen: () => {} }));

const form = (extra: Record<string, unknown> = {}): WidgetRoot => parsed({
  type: "Card", title: "Book a slot",
  children: [
    { type: "Input", name: "who", label: "Name", required: true },
    { type: "Select", name: "slot", label: "Slot", options: [{ value: "am", label: "Morning" }, { value: "pm", label: "Afternoon" }], defaultValue: "am" },
    { type: "Checkbox", name: "news", label: "Send me news" },
  ],
  confirm: { label: "Book it", action: { type: "book" } }, cancel: { label: "Never mind", action: { type: "book.cancel" } },
  ...extra,
});

describe("drawing a widget", () => {
  it("draws the header, the fields and the two buttons of a live card", () => {
    const html = draw(row(form()));
    expect(html).toContain('data-widget-state="live"');
    expect(html).toContain("Book a slot");
    expect(html).toContain(">Name<");
    expect(html).toContain("Morning");
    expect(html).toContain("Book it");
    expect(html).toContain("Never mind");
    // a select that may be answered in the person's own words ends in Other
    expect(html).toContain(">Other<");
  });

  it("offers no Other where the bot said allowOther: false", () => {
    const root = parsed({ type: "Card", children: [{ type: "RadioGroup", name: "p", options: [{ value: "a" }, { value: "b" }], allowOther: false }] });
    expect(draw(row(root))).not.toContain("Other");
  });

  it("sizes the card by its root: sm 360, md 440, otherwise 600", () => {
    expect(draw(row(form({ size: "sm" })))).toContain("max-w-[360px]");
    expect(draw(row(form({ size: "md" })))).toContain("max-w-[440px]");
    expect(draw(row(form()))).toContain("max-w-[600px]");
  });

  it("falls back to the row's text when there is no tree to draw", () => {
    const broken = { id: "w2", role: "bot", kind: "text", at: 1, text: "plain words", widget: { id: "x", root: { type: 7 } } } as unknown as Message;
    expect(draw(broken)).toContain("plain words");
  });

  it("draws a list that is a choice as a radio group with Other after the rows", () => {
    const root = parsed({
      type: "ListView", title: "Where to", name: "where", confirm: { label: "Go", action: { type: "go" } },
      children: [{ type: "ListViewItem", children: [{ type: "Text", value: "Home" }] }, { type: "ListViewItem", children: [{ type: "Text", value: "Office" }] }],
    });
    const html = draw(row(root));
    expect(html).toContain('role="radiogroup"');
    expect(html.indexOf("Office")).toBeLessThan(html.indexOf(">Other<"));
  });

  it("folds a list past its limit behind Show all", () => {
    const items = Array.from({ length: 6 }, (_, index) => ({ type: "ListViewItem", children: [{ type: "Text", value: `Item ${index}` }] }));
    const html = draw(row(parsed({ type: "ListView", title: "Many", limit: 3, children: items })));
    expect(html).toContain("Show all (6)");
    expect(html).toContain("Item 2");
    expect(html).not.toContain("Item 3");
  });
});

describe("images", () => {
  const withImage = (src?: string) => parsed({ type: "Card", children: [{ type: "Image", alt: "A diagram", ...(src === undefined ? {} : { src }) }] });

  it("draws an attachment of Murage's own through the reply image component", () => {
    const html = draw(row(withImage("/api/attachments/photo.png")));
    expect(html).toContain('data-widget-image="shown"');
    expect(html).toContain("/api/attachments/photo.png");
  });

  it("draws the alt as a quiet placeholder when there is no src, and fetches nothing", () => {
    const html = draw(row(withImage()));
    expect(html).toContain('data-widget-image="placeholder"');
    expect(html).toContain("A diagram");
    expect(html).not.toContain("<img");
  });

  it("never draws a remote address: the tree drops it, so the placeholder shows", () => {
    const root = withImage("https://example.com/x.png");
    expect(JSON.stringify(root)).not.toContain("example.com");
    const html = draw(row(root));
    expect(html).not.toContain("example.com");
    expect(html).toContain('data-widget-image="placeholder"');
  });
});

describe("a link the bot chose", () => {
  const link = parsed({ type: "Card", children: [{ type: "Button", label: "Read the docs", onClickAction: { type: "open_url", payload: { url: "https://docs.example.com/a" } } }] });

  it("is a plain link that opens outside, never a button the card presses", () => {
    const html = draw(row(link));
    expect(html).toMatch(/<a [^>]*href="https:\/\/docs\.example\.com\/a"/);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).not.toContain("<button");
    expect(widgetActions(link)[0]!.client).toBe(true);
  });

  it("is never a press the card sends: the card's press returns early for a client action", () => {
    expect(read("./WidgetMessage.tsx")).toContain("entry.client");
  });
});

describe("a table and a chart", () => {
  it("draws a table as a plain table with its heading row", () => {
    const root = parsed({
      type: "Card", title: "Scores",
      children: [{
        type: "Table", children: [
          { type: "Table.Row", header: true, children: [{ type: "Text", value: "Who" }, { type: "Text", value: "Points" }] },
          { type: "Table.Row", children: [{ type: "Text", value: "Ada" }, { type: "Text", value: "12" }] },
        ],
      }],
    });
    const html = draw(row(root));
    expect(html).toContain("<table");
    expect(html).toMatch(/<th[^>]*>.*Who/);
    expect(html).toMatch(/<td[^>]*>.*Ada/);
  });

  const chart = parsed({
    type: "Card",
    children: [{
      type: "Chart", data: [{ m: "Jan", a: 3, b: 2 }, { m: "Feb", a: 5, b: null }, { m: "Mar", a: 4, b: 6 }],
      series: [{ type: "bar", dataKey: "a", label: "Sales" }, { type: "line", dataKey: "b", label: "Leads" }], xAxis: { dataKey: "m" },
    }],
  });

  it("lays bars and lines out as SVG geometry, breaks a line where a row has no value, and labels the x axis", () => {
    const shape = widgetChartGeometry(chart.children![0]!, 300)!;
    expect(shape.bars).toHaveLength(3);
    expect(shape.lines).toHaveLength(1);
    // Feb has no Leads value: the line is two runs
    expect(shape.lines[0]!.d.match(/M/g)).toHaveLength(2);
    expect(shape.xLabels.map((label) => label.text)).toEqual(["Jan", "Feb", "Mar"]);
    expect(shape.legend.map((item) => item.label)).toEqual(["Sales", "Leads"]);
    // a bigger value is a taller bar
    expect(shape.bars[1]!.height).toBeGreaterThan(shape.bars[0]!.height);
    expect(widgetChartHeight(chart.children![0]!, 300)).toBeGreaterThan(shape.height - 1);
  });

  it("piles bars that share a stack in one slot, and puts the rest side by side", () => {
    const base = { type: "Chart", data: [{ m: "Jan", a: 3, b: 2 }], xAxis: { dataKey: "m" } };
    const stacked = parsed({ type: "Card", children: [{ ...base, series: [{ type: "bar", dataKey: "a", stack: "s" }, { type: "bar", dataKey: "b", stack: "s" }] }] });
    const apart = parsed({ type: "Card", children: [{ ...base, series: [{ type: "bar", dataKey: "a" }, { type: "bar", dataKey: "b" }] }] });
    const piled = widgetChartGeometry(stacked.children![0]!, 300)!.bars;
    const side = widgetChartGeometry(apart.children![0]!, 300)!.bars;
    expect(piled[0]!.x).toBe(piled[1]!.x);
    expect(side[0]!.x).not.toBe(side[1]!.x);
  });

  it("draws the chart as one labelled SVG", () => {
    const html = draw(row(chart));
    expect(html).toContain("<svg");
    expect(html).toContain('role="img"');
    expect(html).toContain("Chart of Sales, Leads across 3 points");
  });
});

describe("a settled widget", () => {
  const settled = { ref: "confirm", label: "Book it", values: { who: "Ada", slot: "pm", news: true }, sendId: "widget-wid1" };

  it("folds to a tick, the label, Details and Change answer, with no buttons", () => {
    const html = draw(row(form(), { settled }));
    expect(html).toContain('data-widget-state="settled-line"');
    expect(html).toContain("Book it");
    expect(html).toContain(">Details<");
    expect(html).toContain(">Change answer<");
    // the card itself waits behind Details
    expect(html).not.toContain("Never mind");
    expect(html).not.toContain("Morning");
  });

  it("tells a screen reader the card, and keeps Details a real toggle", () => {
    const html = draw(row(form(), { settled }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Book a slot"');
  });

  it("shows the words typed for Other as the settled values say", () => {
    const root = parsed({ type: "Card", children: [{ type: "RadioGroup", name: "p", options: [{ value: "a" }, { value: "b" }] }], confirm: { label: "Send", action: { type: "s" } } });
    const html = draw(row(root, { settled: { ref: "confirm", label: "Send", values: { p: "" }, other: { p: "a third way" }, sendId: "widget-wid1" } }));
    expect(html).toContain("Send");
    expect(html).toContain(">Change answer<");
  });
});

describe("pressing", () => {
  const root = form();
  const confirm = widgetActions(root).find((entry) => entry.ref === "confirm")!;
  const cancel = widgetActions(root).find((entry) => entry.ref === "cancel")!;

  it("sends the edited values with confirm, and the defaults for what was not touched", () => {
    let edits = editValue({ values: {}, other: {} }, "who", "Ada");
    edits = editValue(edits, "news", true);
    const values = { slot: "am", who: "", news: false, ...edits.values };
    expect(preparePress(root, confirm, "confirm", values, edits.other)).toEqual({ ok: true, values: { who: "Ada", slot: "am", news: true } });
  });

  it("stops on a required field that is empty, says which, and sends nothing", () => {
    const stopped = preparePress(root, confirm, "confirm", { who: "  ", slot: "am", news: false }, {});
    expect(stopped.ok).toBe(false);
    if (stopped.ok) throw new Error("unreachable");
    expect(stopped.field).toBe("who");
    expect(stopped.where).toBe("data-widget-field");
    expect(stopped.text).toBe("Name is required.");
  });

  it("sends a cancel with no values, past an empty required field", () => {
    expect(preparePress(root, cancel, "cancel", { who: "", slot: "am", news: false }, {})).toEqual({ ok: true });
  });

  it("answers a select with Other as an empty value and the words apart", () => {
    const edits = editOther(editChooseOther({ values: {}, other: {} }, "slot"), "slot", "late afternoon");
    const values = { who: "Ada", slot: "am", news: false, ...edits.values };
    expect(preparePress(root, confirm, "confirm", values, edits.other)).toEqual({ ok: true, values: { who: "Ada", slot: "", news: false }, other: { slot: "late afternoon" } });
  });

  it("collects only the fields of the pressed form", () => {
    const two = parsed({
      type: "Card",
      children: [
        { type: "Form", onSubmitAction: { type: "a.save" }, children: [{ type: "Input", name: "one", required: true }, { type: "Button", label: "Save a", submit: true }] },
        { type: "Form", onSubmitAction: { type: "b.save" }, children: [{ type: "Input", name: "two", required: true }, { type: "Button", label: "Save b", submit: true }] },
      ],
    });
    const [a, b] = widgetActions(two);
    expect(preparePress(two, a!, a!.ref, { one: "x", two: "" }, {})).toEqual({ ok: true, values: { one: "x" } });
    expect(preparePress(two, b!, b!.ref, { one: "x", two: "" }, {}).ok).toBe(false);
  });
});

describe("the store connection", () => {
  const source = read("./WidgetMessage.tsx");

  it("answers a press with respondWidget on this widget, at its revision, and reopens with reopenWidget", () => {
    expect(source).toContain('type: "respondWidget"');
    expect(source).toContain("widgetId");
    expect(source).toContain("rev: payload.rev ?? 0");
    expect(source).toContain('type: "reopenWidget"');
    expect(source).toContain("onSuccess");
    expect(source).toContain("onError");
  });

  it("shows nothing alarming when the widget was answered elsewhere, and the server's sentence for any other refusal", () => {
    expect(source).toContain('code === "already_settled"');
    expect(source).toContain("setProblem({ text: message");
  });

  it("is drawn by the 1:1 transcript, and a bad tree falls back to the message's words", () => {
    const chat = read("../ChatView.tsx");
    // drawn by the field on a text row (no widget kind: a 1.0.3 install reads the row as its text)
    expect(chat).toContain("if (m.widget) return <MessageBoundary");
    expect(chat).not.toContain('case "widget"');
    expect(chat).toContain("<WidgetMessage threadId={bot.threadId} message={m} />");
    expect(chat).toMatch(/<MessageBoundary fallbackText=\{m\.text \|\| ""\}><WidgetMessage/);
    // rooms do not draw widgets
    expect(read("../GroupView.tsx")).not.toContain("WidgetMessage");
  });

  it("names no colour of its own: every one comes from a token", () => {
    for (const file of ["./WidgetMessage.tsx", "./WidgetControls.tsx", "./WidgetBody.tsx", "./WidgetNodes.tsx", "./WidgetContent.tsx", "./WidgetChart.tsx", "./widget-style.ts"]) {
      expect(read(file).replace(/^\s*\/\/.*$/gm, ""), file).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
  });

  it("a widget row stays in the transcript beside the turn's closing reply: never folded away as narration", () => {
    const widget = { ...row(form()), id: "wrow", turnId: "t1", at: 2 } as Message;
    const said = { id: "said", role: "bot", kind: "text", at: 1, text: "Let me ask.", turnId: "t1" } as Message;
    const closing = { id: "close", role: "bot", kind: "text", at: 3, text: "Pick a slot above.", turnId: "t1", turnTerminal: true } as Message;
    const items = groupTranscript([{ id: "u", role: "user", kind: "text", at: 0, text: "book me" } as Message, said, widget, closing]);
    const shown = items.flatMap((item) => item.kind === "message" ? [item.message.id] : []);
    expect(shown).toContain("wrow");
    const folded = items.flatMap((item) => item.kind === "turn" ? item.messages.map((message) => message.id) : []);
    expect(folded).toEqual(["said"]);
  });
});
