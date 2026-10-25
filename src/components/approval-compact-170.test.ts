// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One compact approval card instead of two (1.0.4 item 170): the panel and
// its actions read as one card, the queue keeps one card for any number of
// requests, and the wider remembered grants wait behind "More".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { PendingApprovalPanel, type Pending } from "./PendingApproval";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const pending = (requestId: string): Pending => ({
  requestId,
  tool: "Bash",
  detail: "git status",
  allowKey: "Bash:git",
  message: { id: `m-${requestId}`, role: "bot", kind: "options", at: 1, card: { title: "t", subtitle: "git status", options: [], tool: "Bash", requestId } } as unknown as Message,
});

describe("one compact approval card", () => {
  it("the panel is not its own tinted block with a divider", () => {
    const html = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending: pending("a"), count: 1, index: 0 }));
    expect(html).not.toContain("border-b");
    expect(html).not.toContain("bg-control/40");
  });

  it("a queue of three shows one panel and mounts every card's actions, only the selected one visible", () => {
    const queue = read("./PendingApprovalQueue.tsx");
    expect(queue.match(/<PendingApprovalPanel /g)).toHaveLength(1);
    expect(queue).toMatch(/hidden=\{pending\.requestId !== selectedId\}/);
  });

  it("the wider grants sit behind More, reachable by keyboard as ordinary buttons", () => {
    const source = read("./PendingApproval.tsx");
    const more = source.indexOf("data-approval-more");
    expect(more).toBeGreaterThan(-1);
    const block = source.slice(more, source.indexOf("Allow for this task</ApprovalBusyLabel>", more));
    expect(block).toContain("alwaysAllowLabel(pending)");
    expect(source).toContain("aria-expanded={moreOpen}");
    // the narrow, recommended grant and Allow once stay on the card itself
    expect(source.indexOf("Always allow this exact command here")).toBeGreaterThan(source.indexOf("</div>\n      )}\n      {grants.forRoutine"));
  });
});
