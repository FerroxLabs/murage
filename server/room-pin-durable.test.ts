// The pin lives with the message and its queue row, not in a side map: there
// is nothing to evict, and a drained send keeps its responder.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { drainChannelMessages, queueChannelMessage } from "./channel-queue.ts";
import { acceptedSendMatch, sendFingerprint } from "./send-idempotency.ts";

describe("durable responder pin", () => {
  it("has no side map and no eviction path", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
    expect(source).not.toContain("pinnedResponders");
    expect(source).not.toContain("pinResponder");
  });

  it("the in-memory queue hands the responder to the drain", () => {
    queueChannelMessage("g-pin", "t-pin", "hello", { sendId: "s".repeat(16), responderBotId: "bot-a" });
    const seen: Array<string | undefined> = [];
    drainChannelMessages(() => false, (item) => { seen.push(item.responderBotId); });
    expect(seen).toEqual(["bot-a"]);
  });

  it("the send fingerprint and the accepted-message match include the responder, or its absence", () => {
    expect(sendFingerprint("t", undefined, "chat", "a")).not.toBe(sendFingerprint("t", undefined, "chat", undefined));
    expect(sendFingerprint("t", undefined, "chat", "a")).not.toBe(sendFingerprint("t", undefined, "chat", "b"));
    const message = { id: "m", at: 1, role: "user" as const, kind: "text" as const, text: "t", sendId: "x".repeat(16), responderBotId: "a" };
    expect(acceptedSendMatch([message], message.sendId, "t", undefined, "chat", "a").kind).toBe("match");
    expect(acceptedSendMatch([message], message.sendId, "t", undefined, "chat", "b").kind).toBe("conflict");
    expect(acceptedSendMatch([message], message.sendId, "t", undefined, "chat", undefined).kind).toBe("conflict");
  });
});
