// SPDX-License-Identifier: AGPL-3.0-or-later
// AMEND-13 Rule 83c: voice announces the count, offers every request, and a yes
// answers only the presented, still-pending one. "Next" grants nothing.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { followingRequest, queueCommand, reachesPastOneRequest } from "@/lib/approval-queue";
import { approvalAnswer } from "@/lib/call-answers";
import { loadPlainApproval } from "@/lib/plain-approval";
import type { Message } from "@/state/store";
import { QUEUE_OFFER, QUEUE_WHICH, spokenQueueList, type Pending } from "./PendingApproval";

beforeAll(() => loadPlainApproval());

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
function card(requestId: string, tool = "WebSearch", subtitle = "web search: weather"): Pending {
  const message = { id: `m-${requestId}`, role: "bot", kind: "options", at: 1, card: { title: "Approval", subtitle, options: [], tool, requestId } } as unknown as Message;
  return { message, requestId, tool, detail: subtitle };
}

describe("Rule 83c: what the owner says about the queue", () => {
  it("hears next, read and a number, none of them an answer", () => {
    for (const said of ["next", "Next one.", "okay, the next one", "what's next"]) expect(queueCommand(said)).toEqual({ kind: "next" });
    for (const said of ["read them", "read them all", "list them", "what are they?", "read me every request"]) expect(queueCommand(said)).toEqual({ kind: "read" });
    expect(queueCommand("the second one")).toEqual({ kind: "select", index: 2 });
    expect(queueCommand("number 3")).toEqual({ kind: "select", index: 3 });
    expect(queueCommand("two")).toEqual({ kind: "select", index: 2 });
    for (const said of ["next", "read them", "the second one"]) expect(approvalAnswer(said)).toBeNull();
  });

  it("never reads a decision as a queue command", () => {
    for (const said of ["yes", "no", "skip it", "allow it", "yes the next one too"]) expect(queueCommand(said)).toBeNull();
  });

  it("flags a yes that reaches past one request", () => {
    for (const said of ["yes to all", "allow both", "approve everything", "yes, all of them"]) expect(reachesPastOneRequest(said)).toBe(true);
    for (const said of ["yes", "allow it", "go ahead"]) expect(reachesPastOneRequest(said)).toBe(false);
  });

  it("next wraps through every request", () => {
    const list = [{ requestId: "a" }, { requestId: "b" }];
    expect(followingRequest(list, "a")).toBe("b");
    expect(followingRequest(list, "b")).toBe("a");
  });

  it("reads every request numbered, asks which, and asks no yes or no", () => {
    const line = spokenQueueList([card("a"), card("b", "Bash", "git status")], () => "Ada");
    expect(line.startsWith("2 requests waiting.")).toBe(true);
    expect(line).toContain("1: Ada would like to");
    expect(line).toContain("2: Ada would like to");
    expect(line.endsWith(QUEUE_WHICH)).toBe(true);
    expect(line).not.toMatch(/yes or no/i);
    expect(QUEUE_OFFER).toMatch(/next/);
    expect(QUEUE_OFFER).toMatch(/read them/);
  });
});

describe("Rule 83c: both calls", () => {
  for (const [file, decide] of [["./CallView.tsx", "const answer = approvalAnswer(said);"], ["./GroupCallView.tsx", "const decided = YES.test(said) || NO.test(said);"]] as const) {
    const source = read(file);
    it(`${file}: queue commands come before any decision and dispatch nothing`, () => {
      const at = source.indexOf("queueCommand(said)");
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(source.indexOf(decide));
      const branch = source.slice(at, source.indexOf(decide));
      expect(branch).not.toContain("decideRequest");
      expect(branch).toContain("presentAnother();");
    });
    it(`${file}: after the list, a yes or no asks which; a yes for all answers nothing`, () => {
      expect(source).toMatch(/choosingRequest\.current && queue\.length > 1\)/);
      expect(source).toContain("QUEUE_ONE_AT_A_TIME");
      expect(source).toMatch(/reachesPastOneRequest\(said\)/);
    });
    it(`${file}: a presented request is asked with the count and the offer when more than one waits`, () => {
      expect(source).toContain("waiting > 1 ? `${requestsWaiting(waiting)}. ` : \"\"");
      expect(source).toContain("${waiting > 1 ? ` ${QUEUE_OFFER}` : \"\"}");
      expect(source).toContain("That request was answered elsewhere.");
    });
  }

  it("the one-to-one call never offers or takes a yes for the rest of the call while several wait", () => {
    const source = read("./CallView.tsx");
    expect(source).toContain("const offerForCall = waiting === 1 && !offeredForCall.current");
    expect(source).toMatch(/queue\.length > 1 && \(answer === "allow-for-call" \|\| reachesPastOneRequest\(said\)\)/);
  });
});

describe("Rule 83b on calls: answers carry the presented card's own identity", () => {
  const call = read("./CallView.tsx");
  const room = read("./GroupCallView.tsx");

  it("a one-to-one call answers the presented request by id and only while it is still pending", () => {
    expect(call).toContain("const pending = queue.find((candidate) => candidate.requestId === open.requestId);");
    expect(call).toContain("if (!queue.some((pending) => pending.requestId === open.requestId)) {");
    expect(call).not.toContain("pendingApprovals(olderOpenCards(bot, messages))[0]");
  });

  it("a group call answers the presented request by id and only while it is still pending", () => {
    expect(room).toContain("if (!queue.some((pending) => pending.requestId === openApproval.requestId)) {");
    expect(room).not.toContain("pendingApprovals(olderOpenCards(group, messages))[0]");
  });
});
