// Copyright 2026 Ferrox Labs
// Chunk cases follow Hermes tests/gateway/test_whatsapp_formatting.py (TestSendChunking) and OpenClaw
// deliver-reply.ts limits; send-retry rules follow OpenClaw outbound-retry.ts (MIT, both).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { chunkMessage, classifySendError, MAX_CHUNK_CHARS, minimalQuoted, SEND_RETRY_MAX, SEND_TIMEOUT_MESSAGE, sendRetryDelay, sendWithPresence } from "./chunk.ts";

describe("chunkMessage", () => {
  it("returns one piece for a short message and none for empty", () => {
    expect(chunkMessage("short message")).toEqual(["short message"]);
    expect(chunkMessage("")).toEqual([]);
  });
  it("splits a long message and keeps every piece within the limit", () => {
    const long = "a ".repeat(3000);
    const pieces = chunkMessage(long);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.length <= MAX_CHUNK_CHARS)).toBe(true);
    expect(pieces.join("").replace(/\s/g, "")).toBe(long.replace(/\s/g, ""));
  });
  it("prefers paragraph boundaries", () => {
    const a = "a".repeat(60);
    const b = "b".repeat(60);
    expect(chunkMessage(`${a}\n\n${b}`, 100)).toEqual([a, b]);
  });
  it("falls back to line boundaries, then a hard cut", () => {
    const a = "a".repeat(60);
    const b = "b".repeat(60);
    expect(chunkMessage(`${a}\n${b}`, 100)).toEqual([a, b]);
    const hard = chunkMessage("x".repeat(250), 100);
    expect(hard.every((p) => p.length <= 100)).toBe(true);
    expect(hard.join("")).toBe("x".repeat(250));
  });
  it("never splits a surrogate pair", () => {
    const emoji = "😀";
    const pieces = chunkMessage(emoji.repeat(120), 101);
    for (const piece of pieces) {
      expect(piece).not.toMatch(/^[\udc00-\udfff]/);
      expect(piece).not.toMatch(/[\ud800-\udbff]$/);
    }
    expect(pieces.join("")).toBe(emoji.repeat(120));
  });
  it("closes and reopens a code fence across a split", () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i} of code`).join("\n");
    const text = `intro\n\`\`\`python\n${body}\n\`\`\`\noutro`;
    const pieces = chunkMessage(text, 200);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(200);
      expect((piece.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(pieces[1].startsWith("```python\n")).toBe(true);
    expect(pieces[pieces.length - 1].endsWith("outro")).toBe(true);
  });
  it("rejects a limit too small to work", () => {
    expect(() => chunkMessage("x", 5)).toThrow(RangeError);
  });
});

describe("classifySendError", () => {
  it("maps Boom statuses to the ChannelSendError codes", () => {
    expect(classifySendError({ output: { statusCode: 401 }, message: "x" })).toMatchObject({ code: "auth", retryable: false, uncertain: false });
    expect(classifySendError({ output: { statusCode: 403 }, message: "x" })).toMatchObject({ code: "forbidden" });
    expect(classifySendError({ output: { statusCode: 429 }, data: { retryAfter: 12 }, message: "x" })).toMatchObject({ code: "rate-limit", retryAfterSeconds: 12 });
    expect(classifySendError({ output: { statusCode: 428 }, message: "Connection Closed" })).toMatchObject({ code: "offline", retryable: true });
    expect(classifySendError(new Error("socket not open"))).toMatchObject({ code: "offline", retryable: true });
    expect(classifySendError(new Error("kaboom"))).toMatchObject({ code: "unavailable", retryable: false });
  });
  it("marks a timed-out send uncertain and never retries it", () => {
    const timed = classifySendError(new Error(SEND_TIMEOUT_MESSAGE));
    expect(timed).toMatchObject({ code: "timeout", uncertain: true, retryable: false });
    expect(sendRetryDelay(timed, 1)).toBeNull();
  });
});

describe("sendRetryDelay", () => {
  const offline = classifySendError(new Error("Connection Closed"));
  it("retries connection errors up to 3 times, 500 to 1000 ms apart", () => {
    expect(sendRetryDelay(offline, 1, () => 0)).toBe(500);
    expect(sendRetryDelay(offline, 2, () => 0.999999)).toBe(1000);
    expect(sendRetryDelay(offline, SEND_RETRY_MAX, () => 0.5)).toBeGreaterThanOrEqual(500);
    expect(sendRetryDelay(offline, SEND_RETRY_MAX + 1)).toBeNull();
  });
  it("does not retry other errors", () => {
    expect(sendRetryDelay(classifySendError(new Error("kaboom")), 1)).toBeNull();
  });
});

describe("minimalQuoted (OpenClaw af531525c46)", () => {
  it("rebuilds a quoted message from the envelope text, capped at 500", () => {
    expect(minimalQuoted({ remoteJid: "120@g.us", id: "Q", participant: "9@lid", text: "earlier" })).toEqual({ key: { remoteJid: "120@g.us", id: "Q", fromMe: false, participant: "9@lid" }, message: { conversation: "earlier" } });
    expect(minimalQuoted({ remoteJid: "c", id: "Q", text: "y".repeat(900) })?.message.conversation).toHaveLength(500);
  });
  it("sends unquoted on a cache miss instead of a blank bubble", () => {
    expect(minimalQuoted({ remoteJid: "c", id: "Q" })).toBeUndefined();
    expect(minimalQuoted({ remoteJid: "c", id: "Q", text: "   " })).toBeUndefined();
    expect(minimalQuoted(undefined)).toBeUndefined();
  });
});

describe("sendWithPresence (OpenClaw 402bd4af01b)", () => {
  it("shows composing, sends, then pauses", async () => {
    const calls: string[] = [];
    const result = await sendWithPresence((state) => { calls.push(state); }, async () => { calls.push("send"); return "ok"; });
    expect(result).toBe("ok");
    expect(calls).toEqual(["composing", "send", "paused"]);
  });
  it("a presence failure never fails the send", async () => {
    const errors: unknown[] = [];
    const calls: string[] = [];
    const result = await sendWithPresence(async () => { throw new Error("presence rejected"); }, async () => { calls.push("send"); return 7; }, (e) => errors.push(e));
    expect(result).toBe(7);
    expect(calls).toEqual(["send"]);
    expect(errors).toHaveLength(2);
  });
  it("a throwing error logger is contained, and a send failure still pauses and propagates", async () => {
    const calls: string[] = [];
    await expect(sendWithPresence((s) => { calls.push(s); throw new Error("x"); }, async () => { throw new Error("send failed"); }, () => { throw new Error("log failed"); })).rejects.toThrow("send failed");
    expect(calls).toEqual(["composing", "paused"]);
  });
});
