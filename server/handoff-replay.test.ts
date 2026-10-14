// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Review round 4 #3: a stored answer replayed in an event run is bound to the request it was written for, and the stored message
// itself is checked again, copy or not.
import { describe, expect, it } from "vitest";
import { storedAnswerText, type StoredAnswerDeps } from "./handoff-replay.ts";
import { RECEIPT_ORIGIN_UNCONFIRMED_LINE } from "./card-result-source.ts";
import { decodeHandoffReceipt } from "./event-limit.ts";
import { words } from "./testing/released.ts";
const answerText = (...args: Parameters<typeof storedAnswerText>) => { const out = storedAnswerText(...args); return out === undefined ? undefined : words(out); };

const who = { fromBotId: "ops", toBotId: "iris", fromThreadId: "ops-thread" };
const row = (id: string, over: Partial<{ toBotId: string | null; rootThreadId: string; returnThreadId: string | null }> = {}) => ({ id, toBotId: "iris", rootThreadId: "ops-thread", returnThreadId: null, ...over });
const deps = (over: Partial<StoredAnswerDeps> = {}): StoredAnswerDeps => ({
  message: (_t, id) => id === "m1" ? { id, text: "The secret figure is 41." } : undefined,
  request: id => id === "r-new" || id === "r-old" ? row(id) : null,
  requestSourceThread: () => "ops-thread",
  copyOriginWithheld: () => false,
  capturedMessageWithheld: () => false,
  messageSourceForgotten: () => false,
  messageMadeWithMemory: () => false,
  partitionAllowed: () => true,
  ownUnsharedWork: () => false,
  authorize: () => ({ ok: true }),
  withheldLine: "[withheld]",
  ...over,
});
const shared = { threadId: "work-thread", messageId: "m1", requestId: "r-old" };

describe("replaying a stored answer in an event run", () => {
  it("an answer bound to its shared request is delivered after the delivery check asks again, using THAT request", () => {
    const asked: string[] = [];
    const text = answerText(deps({ authorize: id => { asked.push(id); return { ok: true as const }; } }), shared, who, false);
    expect(text).toBe("The secret figure is 41.");
    expect(asked).toEqual(["r-old"]);
  });

  it("sharing revoked since: no text, the reason instead", () => {
    const text = answerText(deps({ authorize: () => ({ ok: false, code: "shared_paused", line: "Sharing was turned off for this team." }) }), shared, who, false);
    expect(text).toBe("Sharing was turned off for this team.");
    expect(text).not.toContain("41");
  });

  it("a shared answer with no request named (unbound) is never read back: no text, a plain line", () => {
    let authorized = 0;
    const text = answerText(deps({ authorize: () => { authorized++; return { ok: true }; } }), { threadId: "work-thread", messageId: "m1" }, who, false);
    expect(text).toBe(RECEIPT_ORIGIN_UNCONFIRMED_LINE);
    expect(text).not.toContain("41");
    expect(authorized).toBe(0);
  });

  it("a request that is not this asker's own hand-off to this worker is never trusted", () => {
    for (const other of [row("r-old", { toBotId: "someone-else" }), row("r-old", { rootThreadId: "another-thread" })]) {
      const text = answerText(deps({ request: () => other, requestSourceThread: () => "another-thread" }), shared, who, false);
      expect(text).toBe(RECEIPT_ORIGIN_UNCONFIRMED_LINE);
    }
    expect(answerText(deps({ request: () => null }), shared, who, false)).toBe(RECEIPT_ORIGIN_UNCONFIRMED_LINE);
  });

  it("the older receipt form with the work positively the owner's own unshared conversations still reads back", () => {
    expect(answerText(deps({ ownUnsharedWork: () => true }), { threadId: "chan", messageId: "m1" }, who, false)).toBe("The secret figure is 41.");
    // but never for words nobody proved were the owner's
    expect(answerText(deps({ ownUnsharedWork: () => true }), { threadId: "chan", messageId: "m1" }, who, true)).toBe(RECEIPT_ORIGIN_UNCONFIRMED_LINE);
  });

  it("a direct shared result (no copy link) whose source was since forgotten is withheld, even though the request is still authorized", () => {
    const text = answerText(deps({ messageSourceForgotten: () => true }), shared, who, false);
    expect(text).toBe("[withheld]");
    expect(text).not.toContain("41");
  });

  it("a message flagged withheld from bots, a withheld copy origin and a partition that no longer allows it are all withheld", () => {
    const copy = { threadId: "orig", messageIds: ["o1"] };
    expect(answerText(deps({ message: (_t, id) => ({ id, text: "41", withheldFromBots: "forgotten" }) }), shared, who, false)).toBe("[withheld]");
    expect(answerText(deps({ message: (_t, id) => ({ id, text: "41", copyOf: copy }), copyOriginWithheld: () => true }), shared, who, false)).toBe("[withheld]");
    expect(answerText(deps({ partitionAllowed: () => false }), shared, who, false)).toBe("[withheld]");
  });

  it("an answer that can no longer be read is not replayed", () => {
    expect(answerText(deps({ message: () => undefined }), shared, who, false)).toBeUndefined();
  });
});

describe("one decoder for every hand-off receipt", () => {
  it("reads delegation, timeout and answer receipts (bound or older form) and nothing else", () => {
    expect(decodeHandoffReceipt("delegation:t1")).toEqual({ kind: "queued", taskId: "t1" });
    expect(decodeHandoffReceipt("timeout:t2")).toEqual({ kind: "timeout", taskId: "t2" });
    expect(decodeHandoffReceipt("answer:chan:m1:req")).toEqual({ kind: "answer", threadId: "chan", messageId: "m1", requestId: "req" });
    expect(decodeHandoffReceipt("answer:chan:m1")).toEqual({ kind: "answer", threadId: "chan", messageId: "m1" });
    for (const reason of ["stopped", "failed", "error", "interrupted"]) expect(decodeHandoffReceipt(`ended:${reason}`)).toEqual({ kind: "ended", reason });
    for (const bad of ["ended:other", "ended:", "bot:b1", "answer:chan", "answer:a:b:c:d", "delegation:", ""]) expect(decodeHandoffReceipt(bad)).toBeUndefined();
  });
});
