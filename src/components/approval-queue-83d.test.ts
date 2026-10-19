// SPDX-License-Identifier: AGPL-3.0-or-later
// AMEND-13 Rule 83d: after the last answer the composer comes back with its
// draft; non-grantable requests keep their own owner-only controls.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { approvalGrants, type Pending } from "./PendingApproval";
import { ApprovalQueueList, approvalQueueEntries } from "./PendingApprovalQueue";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
function card(requestId: string, tool: string, extra: Record<string, unknown> = {}): Pending {
  const message = { id: `m-${requestId}`, role: "bot", kind: "options", at: 1, card: { title: "Use this computer?", subtitle: "", options: [], tool, requestId, ...extra } } as unknown as Message;
  return { message, requestId, tool, detail: "", allowKey: extra.allowKey as string | undefined };
}

describe("Rule 83d", () => {
  it("the composer is held only while a request waits and its draft is never cleared for one", () => {
    const composer = read("./Composer.tsx");
    expect(composer).toContain("disabled={Boolean(approval) || locked}");
    const queueAt = composer.indexOf("<PendingApprovalQueue");
    const block = composer.slice(queueAt, composer.indexOf("/>", queueAt));
    expect(block).not.toMatch(/setText|setAttachments/);
  });

  it("the queue renders nothing once every request is answered", () => {
    const queue = read("./PendingApprovalQueue.tsx");
    expect(queue).toContain("if (!selected) return null;");
  });

  it("the list only selects: it holds no Allow, Deny or Always allow of its own", () => {
    const list = [card("h1", "local_computer_consent"), card("b1", "Bash", { allowKey: "Bash:git" })];
    const html = renderToStaticMarkup(createElement(ApprovalQueueList, { entries: approvalQueueEntries(list, { whoFor: () => "Ada" }), selectedId: "h1", onSelect: () => {} }));
    expect(html).not.toMatch(/Allow once|Always allow|>Deny</);
  });

  it("a host question keeps its own interaction: no remembered grant is offered through the queue", () => {
    expect(approvalGrants(card("h1", "local_computer_consent", { allowKey: "x" }), { desktop: true, hasBot: true })).toEqual({ always: false, exact: false, forTask: false, forRoutine: false });
  });

  it("each listed card keeps its own controls, decided by that card", () => {
    const queue = read("./PendingApprovalQueue.tsx");
    expect(queue).toMatch(/<PendingApprovalActions\s+pending=\{pending\}/);
  });
});
