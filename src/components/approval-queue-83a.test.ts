// SPDX-License-Identifier: AGPL-3.0-or-later
// AMEND-13 Rule 83a: every pending card is listed, selectable and answerable,
// not a count beside the first one.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

import { nextSelection, requestsWaiting, type QueueSelection } from "@/lib/approval-queue";
import { loadPlainApproval } from "@/lib/plain-approval";
import type { Message } from "@/state/store";
import { ApprovalQueueList, approvalQueueEntries } from "./PendingApprovalQueue";
import type { Pending } from "./PendingApproval";

beforeAll(() => loadPlainApproval());

function card(requestId: string, over: { tool?: string; subtitle?: string; botId?: string; name?: string; routineId?: string } = {}): Pending {
  const message = {
    id: `m-${requestId}`, role: "bot", kind: "options", at: 1,
    from: over.botId ? { botId: over.botId, name: over.name ?? over.botId } : undefined,
    card: { title: "Approval", subtitle: over.subtitle ?? "web search: weather", options: ["Allow", "Deny"], tool: over.tool ?? "WebSearch", requestId, ...(over.routineId ? { routineId: over.routineId } : {}) },
  } as unknown as Message;
  return { message, requestId, tool: message.card!.tool!, detail: message.card!.subtitle };
}

const ids = (sel: QueueSelection) => sel.id;
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("Rule 83a: the queue's selection", () => {
  it("selects the oldest request first", () => {
    expect(ids(nextSelection({ order: [] }, [card("a"), card("b")]))).toBe("a");
  });

  it("keeps the selection when new cards append", () => {
    const first = { id: "b", order: ["a", "b"] };
    expect(ids(nextSelection(first, [card("a"), card("b"), card("c")]))).toBe("b");
  });

  it("selects the next pending card when the selected one settles elsewhere", () => {
    const sel = { id: "b", order: ["a", "b", "c"] };
    expect(ids(nextSelection(sel, [card("a"), card("c")]))).toBe("c");
  });

  it("falls back to the last one left when nothing came after it", () => {
    const sel = { id: "c", order: ["a", "b", "c"] };
    expect(ids(nextSelection(sel, [card("a"), card("b")]))).toBe("b");
  });

  it("selects nothing once every card is answered", () => {
    expect(ids(nextSelection({ id: "a", order: ["a"] }, []))).toBeUndefined();
  });

  it("says how many are waiting", () => {
    expect(requestsWaiting(1)).toBe("1 request waiting");
    expect(requestsWaiting(3)).toBe("3 requests waiting");
  });
});

describe("Rule 83a: the listed requests", () => {
  const list = [
    card("r1", { botId: "b1", name: "Ada", routineId: "rt1" }),
    card("r2", { botId: "b2", name: "Grace", tool: "Bash", subtitle: "git status" }),
    card("r3", { botId: "b1", name: "Ada" }),
  ];
  const entries = approvalQueueEntries(list, {
    whoFor: (p) => p.message.from?.name ?? "?",
    routineFor: (p) => (p.message.card?.routineId === "rt1" ? "Morning brief" : undefined),
    statusFor: (id) => (id === "r2" ? "sending" : "waiting"),
  });

  it("identifies each request's bot or member, routine, action and status, in order", () => {
    expect(entries.map((e) => e.requestId)).toEqual(["r1", "r2", "r3"]);
    expect(entries[0]).toMatchObject({ who: "Ada", routine: "Morning brief", status: "waiting" });
    expect(entries[1]).toMatchObject({ who: "Grace", status: "sending" });
    expect(entries[1]!.routine).toBeUndefined();
    for (const entry of entries) expect(entry.action.length).toBeGreaterThan(0);
  });

  it("renders N requests waiting and an ordered, selectable list with the selected one marked", () => {
    const html = renderToStaticMarkup(createElement(ApprovalQueueList, { entries, selectedId: "r2", onSelect: () => {} }));
    expect(html).toContain("3 requests waiting");
    expect(html).toContain('role="listbox"');
    expect(html.match(/role="option"/g)?.length).toBe(3);
    expect(html).toMatch(/aria-selected="true"[^>]*data-request-id="r2"/);
    expect(html).toContain("Routine: Morning brief");
    expect(html).toContain("Sending your answer");
    expect(html.indexOf('data-request-id="r1"')).toBeLessThan(html.indexOf('data-request-id="r3"'));
  });

  it("announces the changed count when the selected request settled elsewhere", () => {
    const html = renderToStaticMarkup(createElement(ApprovalQueueList, { entries: entries.slice(1), selectedId: "r2", onSelect: () => {}, notice: "Answered elsewhere." }));
    expect(html).toMatch(/aria-live="polite"[^>]*>Answered elsewhere\. 2 requests waiting/);
  });
});

describe("Rule 83a: the composer and phone panel use the whole queue", () => {
  it("the composer hands every approval to the queue, not approvals[0] with a count", () => {
    const composer = read("./Composer.tsx");
    expect(composer).toContain("<PendingApprovalQueue");
    expect(composer).toMatch(/approvals=\{approvals\}/);
    expect(composer).not.toMatch(/PendingApprovalPanel pending=\{approval\} count=\{approvals\.length\} index=\{0\}/);
  });

  it("the queue mounts answer controls for every card and shows the selected card's panel", () => {
    const queue = read("./PendingApprovalQueue.tsx");
    expect(queue).toMatch(/approvals\.map\(\(pending\) => \(\s*<div key=\{pending\.requestId\} hidden=\{pending\.requestId !== selectedId\}/);
    expect(queue).toContain("<PendingApprovalPanel pending={selected}");
  });
});
