// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A Needs you row commits nothing while collapsed (R1-04): the line, the bot,
// how long it has waited, and Open. The card and its verbs show only once open.
// Also: snooze with Undo on the local Undo host, and Today's three oldest rows.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NeedsRow } from "./NeedsRow";
import { offerSnoozeUndo } from "./snooze-undo";
import { createUndoHost } from "@/lib/undo";
import { needsTopRows } from "./NeedsYouPage";
import type { InboxItem } from "../../../shared/inbox";

const verbs = createElement("div", null, createElement("button", null, "Allow once"), createElement("button", null, "Deny"));
const row = (open: boolean) => renderToStaticMarkup(createElement(NeedsRow, { id: "r1", line: "Send the Dana email?", meta: "Max · waiting since 07:12", open, onToggle: () => undefined }, verbs));
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("NeedsRow", () => {
  it("collapsed: the question, the bot and its wait, and only Open", () => {
    const html = row(false);
    expect(html).toContain("Send the Dana email?");
    expect(html).toContain("Max · waiting since 07:12");
    expect(html).toContain(">Open</button>");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Allow once");
    expect(html).not.toContain("Deny");
    expect(html.match(/<button/g)).toHaveLength(1);
  });
  it("open: the same card with its verbs, in place", () => {
    const html = row(true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Allow once");
    expect(html).toContain('id="needs-row-body-r1"');
  });
  it("the door renders owed rows through NeedsRow and snoozes from the open card", () => {
    const inbox = read("../Inbox.tsx");
    expect(inbox).toContain("<NeedsRow");
    expect(inbox).toContain("doorRows && (snoozed");
    expect(read("./NeedsYouPageBody.tsx")).toContain("door\n");
    expect(read("../shell/lane-slots.tsx")).toContain('from "@/components/needs/NeedsYouPage"');
  });
});

describe("the door never answers for the owner", () => {
  it("drops held keys and opens a card onto its question or its body, never onto a verb", () => {
    const inbox = read("../Inbox.tsx");
    expect(inbox).toContain("if (isHeldActivation(event) && !isEditableTarget(event.target as HTMLElement)) { event.preventDefault(); event.stopPropagation(); }");
    expect(inbox).toContain("<div onKeyDownCapture={onDoorKeyCapture} onKeyDown={onDoorKey}>");
    expect(inbox).not.toContain("button:not([disabled]), input, textarea') ?? head)?.focus()");
    expect(inbox).toContain('[role="radiogroup"][tabindex="0"], [role="group"][tabindex="0"]');
  });
  it("a written snooze leaves the hidden set once the server reads it back, and Undo waits for the write", () => {
    const inbox = read("../Inbox.tsx");
    expect(inbox).toContain("snoozeWritten.current.set(item.id, revisionNow.current + 1)");
    expect(inbox).toContain("filter(([, at]) => at <= startedAt)");
    expect(inbox).toContain("(written ?? Promise.resolve()).catch(() => undefined).then(() => saveState(item, { snoozedUntil: null }))");
  });
});

describe("snooze with Undo", () => {
  it("writes the snooze only when the window ends, and never after Undo", () => {
    vi.useFakeTimers();
    try {
      const host = createUndoHost();
      const commit = vi.fn(), onUndo = vi.fn();
      offerSnoozeUndo(host, { id: "a", message: "Snoozed", commit, onUndo });
      expect(commit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(9_000);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(onUndo).not.toHaveBeenCalled();

      const commit2 = vi.fn(), onUndo2 = vi.fn();
      offerSnoozeUndo(host, { id: "b", message: "Snoozed", commit: commit2, onUndo: onUndo2 });
      expect(host.undo()).toBe(true);
      vi.advanceTimersByTime(9_000);
      expect(onUndo2).toHaveBeenCalledWith(false);
      expect(commit2).not.toHaveBeenCalled();

      // Esc hides the toast; the window, and so the write, still waits for its end.
      const commit3 = vi.fn(), onUndo3 = vi.fn();
      offerSnoozeUndo(host, { id: "c", message: "Snoozed", commit: commit3, onUndo: onUndo3 });
      host.dismiss();
      expect(commit3).not.toHaveBeenCalled();
      expect(host.undo()).toBe(true);
      expect(onUndo3).toHaveBeenCalledWith(false);
      vi.advanceTimersByTime(9_000);
      expect(commit3).not.toHaveBeenCalled();

      // A second snooze takes the toast; the first keeps its own window and is not written early.
      const first = vi.fn(), second = vi.fn();
      offerSnoozeUndo(host, { id: "d", message: "Snoozed", commit: first, onUndo: vi.fn() });
      offerSnoozeUndo(host, { id: "e", message: "Snoozed", commit: second, onUndo: vi.fn() });
      expect(first).not.toHaveBeenCalled();
      vi.advanceTimersByTime(7_000);
      expect(first).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2_000);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});

describe("Today's rows", () => {
  const item = (id: string, at: number, decision = true) => ({ id, at, decision, title: `T ${id}`, sourceLabel: "Max · Weekly", botId: "max" }) as unknown as InboxItem;
  it("are the three oldest owed rows, with the bot and the wait", () => {
    const now = new Date(2026, 10, 3, 12).getTime();
    const rows = needsTopRows([item("d", now - 1), item("a", now - 4), item("x", now - 9, false), item("b", now - 3), item("c", now - 2)], now, () => undefined);
    expect(rows.map(row => row.id)).toEqual(["a", "b", "c"]);
    expect(rows[0]!.meta).toMatch(/^Max · waiting since \d\d:\d\d$/);
  });
});
