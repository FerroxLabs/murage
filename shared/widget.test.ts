// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// QW Q4 (207, 24, 208): the one widget normaliser. Golden fixtures (shared/testdata/widget-goldens.json: model input and
// the canonical tree it must become), the password refusal, remote images dropped, the open_url scheme filter, the text a
// press becomes, Other in the owner's own words, and a settled widget's answers reopened prefilled.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseWidgetInput, resolveWidgetAction, widgetActions, widgetPrefilled, widgetToText, WIDGET_LIMITS, type WidgetRoot } from "./widget.ts";

const GOLDENS = join(dirname(fileURLToPath(import.meta.url)), "testdata", "widget-goldens.json");
const parsed = (input: unknown): WidgetRoot => {
  const result = parseWidgetInput(input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe("widget goldens", () => {
  const goldens = JSON.parse(readFileSync(GOLDENS, "utf8")) as Array<{ name: string; input: unknown; canonical?: unknown; error?: string; text?: string }>;
  it.each(goldens.map((golden) => [golden.name, golden] as const))("%s", (_name, golden) => {
    const result = parseWidgetInput(golden.input);
    if (golden.error !== undefined) {
      expect(result).toEqual({ ok: false, error: golden.error });
      return;
    }
    expect(result).toEqual({ ok: true, value: golden.canonical });
    if (golden.text !== undefined && result.ok) expect(widgetToText(result.value)).toBe(golden.text);
  });
});

describe("what a widget may hold", () => {
  it("refuses a password field and points to request_credential", () => {
    const result = parseWidgetInput({ type: "Card", children: [{ type: "Input", name: "pw", inputType: "password" }] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("use request_credential for secrets");
  });

  it("drops a remote image at normalise and keeps only data: images and Murage attachments", () => {
    const root = parsed({ type: "Card", children: [
      { type: "Image", src: "https://tracker.example/pixel.png", alt: "Remote" },
      { type: "Image", src: "http://tracker.example/pixel.png" },
      { type: "Image", src: "data:image/png;base64,iVBORw0KGgo=" },
      { type: "Image", src: "/api/attachments/abc123.png" },
      { type: "Image", src: "/api/attachments/../config.json" },
      { type: "Image", src: "data:text/html;base64,PHNjcmlwdD4=" },
    ] });
    const srcs = (root.children ?? []).map((node) => node.src);
    expect(srcs).toEqual([undefined, undefined, "data:image/png;base64,iVBORw0KGgo=", "/api/attachments/abc123.png", undefined, undefined]);
    expect(root.children?.[0]?.alt).toBe("Remote");
  });

  it("takes open_url only for http and https, and never as a press that is sent", () => {
    const open = (url: string) => parseWidgetInput({ type: "Card", children: [{ type: "Button", label: "Open", onClickAction: { type: "open_url", payload: { url } } }] });
    expect(open("https://example.com/plan").ok).toBe(true);
    expect(open("http://example.com/plan").ok).toBe(true);
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ftp://example.com/a", "data:text/html,hi", "murage://x"]) {
      const result = open(url);
      expect(result.ok, url).toBe(false);
      expect(!result.ok && result.error).toContain("open_url needs an http or https url");
    }
    const root = parsed({ type: "Card", children: [{ type: "Button", label: "Open", onClickAction: { type: "open_url", payload: { url: "https://example.com" } } }] });
    expect(widgetActions(root)[0]).toMatchObject({ client: true });
    expect(resolveWidgetAction({ id: "w", root }, root.children![0]!.id, {})).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses a field name that would write to a prototype", () => {
    expect(parseWidgetInput({ type: "Card", children: [{ type: "Input", name: "__proto__" }] }).ok).toBe(false);
    expect(parseWidgetInput({ type: "Card", children: [{ type: "Input", name: "a.constructor" }] }).ok).toBe(false);
  });

  it("refuses input over the limits with the path", () => {
    const many = Array.from({ length: WIDGET_LIMITS.options + 1 }, (_, index) => ({ label: `O${index}`, value: `o${index}` }));
    const result = parseWidgetInput({ type: "Card", children: [{ type: "Select", name: "pick", options: many }] });
    expect(result).toEqual({ ok: false, error: `widget.children[0].options: needs 1 to ${WIDGET_LIMITS.options} items.` });
  });
});

describe("the press", () => {
  const booking = parsed({
    type: "Card", title: "Book a call", confirm: { label: "Book it", action: { type: "book" } }, cancel: { label: "Not now", action: { type: "cancel" } },
    children: [
      { type: "DatePicker", name: "date", label: "Date", min: "2026-01-01" },
      { type: "TimePicker", name: "time", label: "Time" },
      { type: "Select", name: "length", label: "Length", options: [{ label: "30 minutes", value: "30" }, { label: "1 hour", value: "60" }] },
      { type: "Checkbox", name: "remind", label: "Remind me" },
    ],
  });

  it("is \"{label}:\" then one Field: value line per filled field", () => {
    const press = resolveWidgetAction({ id: "w", root: booking }, "confirm", { date: "2026-10-21", time: "9:30", length: "60", remind: true });
    expect(press).toMatchObject({ ok: true, text: "Book it:\nDate: 2026-10-21\nTime: 09:30\nLength: 1 hour\nRemind me: yes", values: { date: "2026-10-21", time: "09:30", length: "60", remind: true } });
    expect(resolveWidgetAction({ id: "w", root: booking }, "cancel", {})).toMatchObject({ ok: true, text: "Not now" });
  });

  it("refuses a value that is not an offered option, and a settled widget", () => {
    expect(resolveWidgetAction({ id: "w", root: booking }, "confirm", { length: "90" })).toMatchObject({ ok: false, status: 400 });
    expect(resolveWidgetAction({ id: "w", root: booking, settled: { ref: "cancel", label: "Not now", values: {}, sendId: "widget-w" } }, "confirm", {})).toMatchObject({ ok: false, status: 409 });
  });

  it("24: a choice answered in the owner's own words sends those words; Other beside a picked option is refused", () => {
    const pick = parsed({ type: "Card", confirm: { label: "Go", action: { type: "go" } }, children: [{ type: "RadioGroup", name: "plan", label: "Plan", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }, { label: "C", value: "c" }] }] });
    expect(resolveWidgetAction({ id: "w", root: pick }, "confirm", { plan: "" }, { plan: "  Something   else  " })).toMatchObject({ ok: true, text: "Go:\nPlan: Something else", other: { plan: "Something else" } });
    expect(resolveWidgetAction({ id: "w", root: pick }, "confirm", { plan: "a" }, { plan: "Mine" })).toMatchObject({ ok: false, status: 400 });
    const closed = parsed({ type: "Card", confirm: { label: "Go", action: { type: "go" } }, children: [{ type: "RadioGroup", name: "plan", allowOther: false, options: [{ label: "A", value: "a" }] }] });
    expect(resolveWidgetAction({ id: "w", root: closed }, "confirm", { plan: "" }, { plan: "Mine" })).toMatchObject({ ok: false, status: 400 });
    expect(resolveWidgetAction({ id: "w", root: pick }, "confirm", { plan: "" }, { plan: "x".repeat(WIDGET_LIMITS.fieldValue + 1) })).toMatchObject({ ok: false, status: 400 });
  });

  it("208: a settled widget's answers reopen prefilled in a copy; an answer that is no longer an option is left empty", () => {
    const copy = widgetPrefilled(booking, { values: { date: "2026-10-21", time: "09:30", length: "60", remind: true } });
    const byName = Object.fromEntries((copy.children ?? []).map((node) => [node.name, node]));
    expect(byName.date.defaultValue).toBe("2026-10-21");
    expect(byName.time.defaultValue).toBe("09:30");
    expect(byName.length.defaultValue).toBe("60");
    expect(byName.remind.defaultChecked).toBe(true);
    expect((booking.children ?? []).every((node) => node.defaultValue === undefined)).toBe(true);
    const stale = widgetPrefilled(booking, { values: { length: "90" } });
    expect((stale.children ?? []).find((node) => node.name === "length")?.defaultValue).toBeUndefined();
    // and the copy presses like the original
    expect(resolveWidgetAction({ id: "w2", root: copy }, "confirm", {})).toMatchObject({ ok: true, text: "Book it:\nDate: 2026-10-21\nTime: 09:30\nLength: 1 hour\nRemind me: yes" });
  });
});
