// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// U2 C7 (upstream 40deb33ce): Hermes with reasoning on re-sends its streamed reply under the same messageId.
import { describe, expect, it } from "vitest";

import { isReasoningReplay } from "./core.ts";
import { hermesAcpSupport } from "./hermes.ts";

describe("U2 C7: a reply re-sent with its reasoning", () => {
  const reasoned = "\u{1F4AD} **Reasoning:**\n```\nSix times seven.\n```\n\nThe answer is 42.";
  it("Hermes is the engine that re-sends it", () => {
    expect(hermesAcpSupport.resendsReasoningReply).toBe(true);
  });
  it("matches the reasoning block, a blank line and the reply streamed so far", () => {
    expect(isReasoningReplay(reasoned, "The answer is 42.")).toBe(true);
    expect(isReasoningReplay(`\n\n${reasoned}`, "The answer is 42.")).toBe(true);
    expect(isReasoningReplay("> \u{1F4AD} **Reasoning:**\n> Six times seven.\n\n    indented", "    indented")).toBe(true);
    expect(isReasoningReplay("-# \u{1F4AD} thinking\n\nok", "ok")).toBe(true);
    expect(isReasoningReplay("\u{1F4AD} **Reasoning:**\r\nSix times seven.\r\n\r\nThe answer is 42.", "The answer is 42.")).toBe(true);
  });
  it("anything else is an ordinary delta", () => {
    expect(isReasoningReplay("ba", "a")).toBe(false);
    expect(isReasoningReplay("Explanation:\n\n42.", "42.")).toBe(false);
    expect(isReasoningReplay("\u{1F4AD} thinking\nThe answer is 42.", "The answer is 42.")).toBe(false); // no blank line
    expect(isReasoningReplay("\u{1F4AD} thinking\r\nThe answer is 42.", "The answer is 42.")).toBe(false); // one CRLF is no blank line
    expect(isReasoningReplay(reasoned, "")).toBe(false);
    expect(isReasoningReplay(reasoned, "Another reply.")).toBe(false);
  });
});
