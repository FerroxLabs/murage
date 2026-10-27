// SPDX-License-Identifier: AGPL-3.0-or-later
// AMEND-13 Rule 83b: a request is chosen and answered by its own id and its own
// thread/bot/member, never an array index or the member that happens to be busy.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { nextSelection, queueStatusWords, selectRequest } from "@/lib/approval-queue";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const r = (...ids: string[]) => ids.map((requestId) => ({ requestId }));

describe("Rule 83b: stable identity", () => {
  it("follows the request id when the list reorders (a paged older card lands ahead)", () => {
    const sel = { id: "b", order: ["a", "b"] };
    expect(nextSelection(sel, r("old", "a", "b")).id).toBe("b");
  });

  it("selecting a request not in the list changes nothing", () => {
    const sel = { id: "a", order: ["a", "b"] };
    expect(selectRequest(sel, r("a", "b"), "gone").id).toBe("a");
    expect(selectRequest(sel, r("a", "b"), "b").id).toBe("b");
  });

  it("a branch or thread change selects within the new list only", () => {
    const sel = { id: "x", order: ["x", "y"] };
    expect(nextSelection(sel, r("p", "q")).id).toBe("p");
  });

  it("a failed answer stays listed with a retry", () => {
    expect(queueStatusWords("failed")).toBe("Not sent. Try again");
    expect(queueStatusWords("sending")).toBe("Sending your answer");
  });
});

describe("Rule 83b: answers carry their own card's identity", () => {
  const composer = read("./Composer.tsx");
  const actions = read("./PendingApproval.tsx");
  const queue = read("./PendingApprovalQueue.tsx");

  it("the composer resolves who asked from the card's own sender, never the busy member", () => {
    const at = composer.indexOf("const approvalBotFor =");
    expect(at).toBeGreaterThan(0);
    const body = composer.slice(at, composer.indexOf(";\n", at));
    expect(body).toContain("pending.message.from?.botId");
    expect(body).not.toContain("busyBotId");
  });

  it("the queue is keyed by thread, so nothing pressed carries into another thread's list", () => {
    expect(composer).toMatch(/<PendingApprovalQueue\s+key=\{threadId\}/);
  });

  it("each card reports its own answer state; a failure (not a cancelled prompt) is kept for retry", () => {
    expect(actions).toContain("onStatus?: (status: QueueStatus) => void;");
    // 1.0.8 #19: the kept failure carries its reason (a still-delivering answer, or the error) instead of `true`
    expect(actions).toMatch(/if \(hooks\.live\(\) && code !== "cancelled"\) setFailed\(code === "delivery_pending" \? "[^"]+" : error \|\| "[^"]+"\);/);
    expect(queue).toContain("onStatus={(status) =>");
  });
});
