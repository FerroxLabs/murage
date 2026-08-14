import { describe, expect, it } from "vitest";

import {
  PASTE_CHARS,
  PASTE_LINES,
  byteLength,
  composeMessage,
  isAttachment,
  isLongPaste,
  pasteAttachment,
  pasteSummary,
} from "../src/lib/composer-attachments.ts";

describe("composer paste attachments", () => {
  it("classifies long character and line pastes without changing short text", () => {
    expect(isLongPaste("x".repeat(PASTE_CHARS - 1))).toBe(false);
    expect(isLongPaste("x".repeat(PASTE_CHARS))).toBe(true);
    expect(isLongPaste(Array.from({ length: PASTE_LINES }, () => "x").join("\n"))).toBe(true);
  });

  it("measures UTF-8 once and reports a useful summary", () => {
    const attachment = pasteAttachment("héllo\n世界");
    expect(attachment.size).toBe(byteLength(attachment.text));
    expect(attachment.size).toBeGreaterThan(attachment.text.length);
    expect(attachment.lines).toBe(2);
    expect(pasteSummary(attachment)).toMatch(/^2 lines, /);
  });

  it("composes attachment-only and mixed messages in a stable order", () => {
    const first = pasteAttachment("first");
    const second = pasteAttachment("second");
    expect(composeMessage("", [first])).toBe(
      '<pasted-text index="1">\nfirst\n</pasted-text>',
    );
    expect(composeMessage("  intro  ", [first, second])).toBe(
      'intro\n\n<pasted-text index="1">\nfirst\n</pasted-text>\n\n' +
        '<pasted-text index="2">\nsecond\n</pasted-text>',
    );
  });

  it("rejects malformed persisted attachments", () => {
    expect(isAttachment({ kind: "paste", id: "a", text: "ok", size: 2, lines: 1 })).toBe(true);
    expect(isAttachment({ kind: "paste", id: "a", text: "missing size" })).toBe(false);
    expect(isAttachment({ kind: "file", id: "a", text: "wrong kind", size: 2 })).toBe(false);
  });
});
