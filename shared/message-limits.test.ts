import { describe, expect, it } from "vitest";

import {
  MESSAGE_REQUEST_ENVELOPE_BYTES,
  MESSAGE_REQUEST_MAX_BYTES,
  MESSAGE_TEXT_MAX_BYTES,
  MESSAGE_TOO_LARGE_CODE,
  formatMessageSize,
  isMessageSizeRefusal,
  messageIsTooLarge,
  messageSizeLabels,
  messageTextBytes,
  messageTooLargeRefusal,
} from "./message-limits.ts";

describe("messageTextBytes", () => {
  it("counts UTF-8 bytes the way the harness does", () => {
    for (const sample of ["plain", "café", "日本語のテキスト", "emoji 🔥🧪", "lone \ud800 surrogate", "trail \udc00", "end \ud83d", ""]) {
      expect(messageTextBytes(sample), sample).toBe(Buffer.byteLength(sample, "utf8"));
      expect(messageTextBytes(sample), sample).toBe(new TextEncoder().encode(sample).length);
    }
  });
});

describe("messageIsTooLarge", () => {
  it("allows exactly the limit and refuses one byte more", () => {
    expect(messageIsTooLarge("x".repeat(MESSAGE_TEXT_MAX_BYTES))).toBe(false);
    expect(messageIsTooLarge("x".repeat(MESSAGE_TEXT_MAX_BYTES + 1))).toBe(true);
  });

  it("measures bytes, not UTF-16 units", () => {
    // 400,000 three-byte characters are 1.2 MB, though only 400,000 units long.
    const cjk = "語".repeat(400_000);
    expect(cjk.length).toBeLessThan(MESSAGE_TEXT_MAX_BYTES);
    expect(messageIsTooLarge(cjk)).toBe(true);
    expect(messageIsTooLarge("語".repeat(Math.floor(MESSAGE_TEXT_MAX_BYTES / 3)))).toBe(false);
  });

  it("refuses the 4 MB message smoke round 1 typed", () => {
    expect(messageIsTooLarge(`Please summarise this. ${"x".repeat(4 * 1024 * 1024)}`)).toBe(true);
  });
});

describe("sizes in human units", () => {
  it("says what a person would say", () => {
    expect(formatMessageSize(512)).toBe("512 B");
    expect(formatMessageSize(38 * 1024)).toBe("38 KB");
    expect(formatMessageSize(MESSAGE_TEXT_MAX_BYTES)).toBe("1 MB");
    expect(formatMessageSize(4.25 * 1024 * 1024)).toBe("4.3 MB");
  });

  it("never states an over-limit size as equal to the limit", () => {
    expect(messageSizeLabels(MESSAGE_TEXT_MAX_BYTES + 1)).toEqual({ size: "1.1 MB", limit: "1 MB" });
    expect(messageSizeLabels(4 * 1024 * 1024 + 23)).toEqual({ size: "4 MB", limit: "1 MB" });
  });
});

describe("messageTooLargeRefusal", () => {
  it("is null for a message that fits", () => {
    expect(messageTooLargeRefusal("x".repeat(MESSAGE_TEXT_MAX_BYTES))).toBeNull();
  });

  it("states the size and the limit, with a stable code", () => {
    expect(messageTooLargeRefusal("x".repeat(MESSAGE_TEXT_MAX_BYTES + 1))).toEqual({
      error: "This message is 1.1 MB, and one message can be up to 1 MB. Shorten it or split it into smaller messages.",
      code: MESSAGE_TOO_LARGE_CODE,
      sizeBytes: MESSAGE_TEXT_MAX_BYTES + 1,
      limitBytes: MESSAGE_TEXT_MAX_BYTES,
    });
  });
});

describe("the request body bound", () => {
  it("admits a message at the limit however JSON escapes it, with its ids", () => {
    const worst = JSON.stringify({
      text: "\u0001".repeat(MESSAGE_TEXT_MAX_BYTES),
      replyToId: "m".repeat(64),
      threadId: "t".repeat(64),
      sendId: "00000000-0000-4000-8000-000000000000",
      mode: "goal",
    });
    expect(Buffer.byteLength(worst)).toBeLessThanOrEqual(MESSAGE_REQUEST_MAX_BYTES);
    expect(MESSAGE_REQUEST_MAX_BYTES - 6 * MESSAGE_TEXT_MAX_BYTES).toBe(MESSAGE_REQUEST_ENVELOPE_BYTES);
  });

  it("is larger than the old generic bound, which refused a message at the limit", () => {
    const atLimit = JSON.stringify({ text: "x".repeat(MESSAGE_TEXT_MAX_BYTES) });
    expect(Buffer.byteLength(atLimit)).toBeGreaterThan(1_000_000);
  });
});

describe("isMessageSizeRefusal", () => {
  it("recognises a 413 from either the message check or the body bound", () => {
    expect(isMessageSizeRefusal(Object.assign(new Error("body too large"), { status: 413 }))).toBe(true);
    expect(isMessageSizeRefusal(Object.assign(new Error("no such bot"), { status: 404 }))).toBe(false);
    expect(isMessageSizeRefusal(new TypeError("Failed to fetch"))).toBe(false);
    expect(isMessageSizeRefusal(null)).toBe(false);
  });
});
