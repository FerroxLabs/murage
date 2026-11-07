// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NEEDSYOU-INLINE-APPROVE on Today (1.0.18, Sean: "still needs an Approve button on that card"). A Decide row on
// Today that is a waiting request gets the same one-click Approve / Don't allow (or a two-option question's two
// options) as the Needs you door's row, through the same answer path (InboxQuickAnswer, POST /respond). Today is
// first paint and its Inbox read carries no card text, so the card read and the buttons load on first use, in
// their own chunk. Same shape as TodayView.test.ts: node, no jsdom, markup through renderToStaticMarkup.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { needsLines, withoutAnswered, type NeedsLine, type NeedsLinesInput } from "@/lib/today-needs";
import type { NeedsSummaryRow } from "@/components/shell/shell-contract";
import type { InboxItem } from "../../../shared/inbox";

Object.assign(globalThis, { window: (globalThis as { window?: unknown }).window ?? {} });
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {}, initAnalytics: () => {}, track: () => {} }));
const { NeedsBlock } = await import("./NeedsBlock");
const { needsOwedRows } = await import("../needs/NeedsYouPage");

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const NOW = new Date(2026, 10, 6, 10, 0, 0).getTime();

const item = (id: string, patch: Partial<InboxItem> = {}): InboxItem => ({
  id, version: "v1", kind: "request", segment: "approval", status: "pending", decision: true, toRead: false,
  title: "Approval requested", summary: "", sourceLabel: "Sable · Launch prep", botId: "sable", at: NOW - 60_000,
  read: false, snoozedUntil: null, duplicates: 0, link: { threadId: "sable-task", messageId: `m-${id}` }, ...patch,
});
const row = (id: string, patch: Partial<NeedsSummaryRow> = {}): NeedsSummaryRow => ({
  id, line: `line ${id}`, meta: "Sable · waiting since 09:59", open: () => undefined, segment: "approval", botId: "sable",
  request: { threadId: "sable-task", messageId: `m-${id}`, version: "v1" }, ...patch,
});
const lines = (input: Partial<NeedsLinesInput>) => needsLines({ now: NOW, count: 0, rows: [], restore: [], reconnectApps: [], handoffs: [], routines: [], runs: [], bots: [], botNames: { sable: "Sable" }, ...input });
const verbs = (line: NeedsLine, slot: { labelledBy: string }) => createElement("span", { "data-verbs": line.id, "data-by": slot.labelledBy }, createElement("button", { type: "button" }, "Approve"));
const block = (needs: ReturnType<typeof needsLines>, quickAnswer?: typeof verbs, said?: Record<string, string>) =>
  renderToStaticMarkup(createElement(NeedsBlock, { needs, count: needs.decide + needs.unnamed, expanded: false, onExpand: vi.fn(), onCollapse: vi.fn(), onOpenLine: vi.fn(), onOpenDoor: vi.fn(), quickAnswer, onAnswered: vi.fn(), said, onSaid: vi.fn() }));

describe("Today's rows know which waiting request they are", () => {
  it("an owed pending request carries its thread, message and version; anything else carries none", () => {
    const rows = needsOwedRows([
      item("a"),
      item("b", { kind: "connection", segment: "connection" }),
      item("c", { status: "answered" }),
    ], NOW, () => undefined);
    expect(rows.find((entry) => entry.id === "a")?.request).toEqual({ threadId: "sable-task", messageId: "m-a", version: "v1" });
    expect(rows.find((entry) => entry.id === "b")?.request).toBeUndefined();
    expect(rows.find((entry) => entry.id === "c")?.request).toBeUndefined();
  });
  it("a Decide line keeps the request and names its bot; a Worth a look line never has one", () => {
    const needs = lines({ count: 2, rows: [row("a"), row("b", { segment: "connection" })] });
    const decide = needs.all.find((line) => line.id === "a")!;
    expect(decide.request).toEqual({ threadId: "sable-task", messageId: "m-a", version: "v1", botName: "Sable" });
    expect(needs.all.find((line) => line.id === "b")!.request).toBeUndefined();
  });
});

describe("the Today row draws the one-click answer beside it", () => {
  it("a Decide request row: its answer sits beside the row's button, never inside it, named by the row's line", () => {
    const html = block(lines({ count: 1, rows: [row("a")] }), verbs);
    expect(html).toContain('data-verbs="a"');
    expect(html).toContain('id="today-line-a"');
    expect(html).toContain('data-by="today-line-a"');
    // no button inside a button
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*<button/);
  });
  it("no answer for a row with no request, a Worth a look row, or without the slot", () => {
    expect(block(lines({ count: 1, rows: [row("a", { request: undefined })] }), verbs)).not.toContain("data-verbs");
    expect(block(lines({ count: 1, rows: [row("b", { segment: "connection" })] }), verbs)).not.toContain("data-verbs");
    expect(block(lines({ count: 1, rows: [row("a")] }))).not.toContain("data-verbs");
  });
  it("once its card is read, the row says WHAT it approves instead of a blind 'Approval requested'", () => {
    const needs = lines({ count: 1, rows: [row("a", { line: "Approval requested" })] });
    const html = block(needs, verbs, { a: "Wants to run a command: git push origin main" });
    expect(html).toContain("Wants to run a command: git push origin main");
    expect(html).not.toContain("Approval requested");
    // a row with no answer slot keeps its own line
    expect(block(needs, undefined, { a: "Wants to run a command: git push origin main" })).toContain("Approval requested");
  });
  it("an answered row leaves at once, and the count drops with it", () => {
    const rows = [row("a"), row("b"), row("c")];
    // APPROVALS-SIMPLE-1018: the count comes from the same read as the rows (src/lib/approval-row.test.ts has the swap)
    expect(withoutAnswered(rows, 3, new Set(["a"]), 3)).toEqual({ rows: [rows[1], rows[2]], count: 2 });
    expect(withoutAnswered(rows, 3, new Set())).toEqual({ rows, count: 3 });
    // once the read no longer lists it, the count is the server's again
    expect(withoutAnswered([rows[1]!, rows[2]!], 2, new Set(["a"]), 2)).toEqual({ rows: [rows[1], rows[2]], count: 2 });
    // the badge already dropped but the rows still list it: the read's own count, never taken off twice
    expect(withoutAnswered(rows, 2, new Set(["a"]), 3)).toEqual({ rows: [rows[1], rows[2]], count: 2 });
    expect(withoutAnswered(rows, undefined, new Set(["a"]), 3).count).toBeUndefined();
  });
});

describe("one answer path, after first paint", () => {
  it("the buttons are the door's own InboxQuickAnswer, reached through a lazy chunk", () => {
    const chunk = read("./TodayQuickAnswer.tsx");
    expect(chunk).toContain("<InboxQuickAnswer");
    expect(chunk).toContain("readRequestCard(");
    expect(chunk).toContain("rowLine(found, request.botName, requestSummary)");
    expect(chunk).not.toMatch(/\/api\//);
    const slot = read("./today-quick.tsx");
    expect(slot).toMatch(/retryableLazy\(\(\) => import\("\.\/TodayQuickAnswer"\)/);
    for (const file of ["./NeedsBlock.tsx", "./TodayView.tsx", "./today-quick.tsx"]) {
      expect(read(file), file).not.toMatch(/from ["'](?:@\/components|\.\.)\/InboxRequest["']/);
      expect(read(file), file).not.toMatch(/from ["']\.\/TodayQuickAnswer["']/);
    }
  });
  it("TodayView wires the slot and takes an answered row away", () => {
    const view = read("./TodayView.tsx");
    expect(view).toContain("quickAnswer={todayQuickAnswer}");
    expect(view).toMatch(/onAnswered=\{\(line\) => setAnswered\(/);
    expect(view).toMatch(/said=\{said\} onSaid=\{\(line, text\) => setSaid\(/);
    expect(view).toContain("withoutAnswered(needs.rows ?? [], needs.count, answered, needs.rowsCount)");
  });
  it("the Inbox and Today read a waiting card through ONE helper", () => {
    const request = read("../InboxRequest.tsx");
    expect(request).toContain("export async function readRequestCard(");
    expect(request.match(/\/messages\?around=\$\{/g)).toHaveLength(1);
    const inbox = read("../Inbox.tsx");
    expect(inbox).toContain("readRequestCard(item.link, controller.signal)");
    expect(inbox).not.toContain("/messages?around=");
  });
});
