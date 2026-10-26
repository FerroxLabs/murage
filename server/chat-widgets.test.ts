// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// QW Q4 (207): the widget row's life on a store: shown once from valid input only, updated in place while open (rev
// counts), 409 once settled, 404 for an unknown id; a press names one send id per widget and the revision it was made on.
import { describe, expect, it } from "vitest";
import { findWidget, prepareWidgetPress, reopenWidget, showWidget, updateWidget, widgetSendId, type WidgetStore } from "./chat-widgets.ts";
import type { Message } from "./store.ts";
import { markdownLinesFor } from "./thread-export.ts";

function fakeStore(): WidgetStore & { rows: Message[] } {
  const rows: Message[] = [];
  return {
    rows,
    appendMessage(_threadId, message, stableId) { const row = { ...message, id: stableId ?? `m${rows.length + 1}`, at: rows.length + 1 } as Message; rows.push(row); return row; },
    patchMessage(_threadId, messageId, patch, within) { within?.(); const at = rows.findIndex((row) => row.id === messageId); if (at < 0) return null; rows[at] = { ...rows[at]!, ...patch }; return rows[at]!; },
    messageById(_threadId, messageId) { return rows.find((row) => row.id === messageId); },
  };
}
const FORM = { type: "Card", confirm: { label: "Save", action: { type: "save" } }, cancel: { label: "Skip", action: { type: "skip" } }, children: [{ type: "Input", name: "who", label: "Who" }] };

describe("chat widgets on the store", () => {
  it("writes nothing for input that does not parse", () => {
    const store = fakeStore();
    expect(showWidget(store, "t", { type: "Card", children: [{ type: "Input", name: "pw", inputType: "password" }] })).toMatchObject({ ok: false, status: 400 });
    expect(store.rows).toEqual([]);
  });

  it("shows, updates while open, then 409 once settled and 404 for an unknown id", () => {
    const store = fakeStore();
    const shown = showWidget(store, "t", FORM, "turn-1");
    if (!shown.ok) throw new Error(shown.error);
    // a text row carrying the widget beside its readable words (no widget kind: 1.0.3 reads it as text); the row id is the widget id
    expect(shown.message).toMatchObject({ id: shown.widgetId, role: "bot", kind: "text", turnId: "turn-1", text: "[who]\n[Save] [Skip]" });
    // an ordinary text row of the same thread is never taken for a widget
    store.appendMessage("t", { role: "bot", kind: "text", text: "hello" }, "plain");
    expect(findWidget(store, "t", "plain")).toBeUndefined();
    expect(shown.text).toContain(`Widget id: ${shown.widgetId}`);
    expect(updateWidget(store, "t", "missing", FORM)).toMatchObject({ ok: false, status: 404 });
    expect(updateWidget(store, "t", shown.widgetId, { ...FORM, title: "Who is coming" })).toMatchObject({ ok: true });
    const row = findWidget(store, "t", shown.widgetId)!;
    expect(row.widget?.rev).toBe(1);
    expect(prepareWidgetPress(row.widget!, { ref: "confirm", values: { who: "Ada" } })).toMatchObject({ ok: false, status: 409, code: "widget_changed" });
    const press = prepareWidgetPress(row.widget!, { ref: "confirm", rev: 1, values: { who: "Ada" } });
    expect(press).toEqual({ ok: true, text: "Save:\nWho: Ada", settled: { ref: "confirm", label: "Save", values: { who: "Ada" }, sendId: widgetSendId(shown.widgetId) } });
    if (!press.ok) return;
    store.patchMessage("t", row.id, { widget: { ...row.widget!, settled: press.settled } });
    const settled = findWidget(store, "t", shown.widgetId)!.widget!;
    expect(updateWidget(store, "t", shown.widgetId, FORM)).toMatchObject({ ok: false, status: 409, code: "already_settled" });
    // another ref after the first press: the same one send id was already used
    expect(prepareWidgetPress(settled, { ref: "cancel", rev: 1 })).toMatchObject({ ok: false, status: 409, code: "already_settled" });
    // 208: reopened as a new widget, prefilled, open
    const reopened = reopenWidget(store, "t", shown.widgetId);
    if (!reopened.ok) throw new Error(reopened.error);
    expect(reopened.widgetId).not.toBe(shown.widgetId);
    expect(reopened.message.widget?.settled).toBeUndefined();
    expect(reopened.message.widget?.root.children?.[0]?.defaultValue).toBe("Ada");
    expect(reopenWidget(store, "t", reopened.widgetId)).toMatchObject({ ok: false, status: 409 });
  });

  it("exports as its readable text and the answer it took", () => {
    const store = fakeStore();
    const shown = showWidget(store, "t", FORM);
    if (!shown.ok) throw new Error(shown.error);
    const settled = { ...shown.message, widget: { ...shown.message.widget!, settled: { ref: "confirm", label: "Save", values: { who: "Ada" }, sendId: "widget-x" } } };
    expect(markdownLinesFor(settled, "Nova", () => "")).toEqual(["**Nova:**", "", "[who]\n[Save] [Skip]", "", "> (answered: Save)", ""]);
  });

  it("one send id per widget, whatever is pressed", () => {
    expect(widgetSendId("0f9a")).toBe("widget-0f9a");
  });
});
