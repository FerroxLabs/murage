// On a phone the Return key is how you start a new line; the arrow button is
// how you send (spec §3.6). Sending on Return meant every attempt at a
// two-line message went out as one line and a stray second message.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { enterSends } from "./composer-enter";

const key = (over: Partial<Parameters<typeof enterSends>[0]> = {}) => ({
  key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false, ...over,
});

describe("what Enter does", () => {
  it("sends with a mouse and keyboard, and Shift+Enter is a newline — unchanged", () => {
    expect(enterSends(key(), false)).toBe(true);
    expect(enterSends(key({ shiftKey: true }), false)).toBe(false);
    expect(enterSends(key({ metaKey: true }), false)).toBe(true);
  });

  it("is a newline on a touch screen", () => {
    expect(enterSends(key(), true)).toBe(false);
    expect(enterSends(key({ shiftKey: true }), true)).toBe(false);
  });

  it("still sends on ⌘/Ctrl+Enter from a keyboard attached to a tablet", () => {
    expect(enterSends(key({ metaKey: true }), true)).toBe(true);
    expect(enterSends(key({ ctrlKey: true }), true)).toBe(true);
  });

  it("never sends mid-composition (Japanese, Chinese, Korean input)", () => {
    expect(enterSends(key({ isComposing: true }), false)).toBe(false);
    expect(enterSends(key({ isComposing: true, metaKey: true }), true)).toBe(false);
  });

  it("ignores every other key", () => {
    expect(enterSends(key({ key: "a" }), false)).toBe(false);
  });
});

it("the composer asks enterSends, and tells the keyboard what Return does", () => {
  const composer = readFileSync(new URL("../components/Composer.tsx", import.meta.url), "utf8");
  expect(composer).toContain("const coarsePointer = useCoarsePointer();");
  expect(composer).toContain("if (enterSends(");
  expect(composer).not.toContain('e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing');
  expect(composer).toContain('enterKeyHint={coarsePointer ? "enter" : "send"}');
});

// D14: editing a sent message is the same keyboard, so the same rule.
it("the message-edit box asks enterSends too, so Return is a newline on touch", () => {
  const chat = readFileSync(new URL("../components/ChatView.tsx", import.meta.url), "utf8");
  const editor = chat.slice(chat.indexOf("function BubbleEditor("), chat.indexOf("function Bubble("));
  expect(editor).toContain("const coarsePointer = useCoarsePointer();");
  expect(editor).toContain("if (enterSends(");
  expect(editor).toContain("}, coarsePointer)) {");
  expect(editor).not.toContain('e.key === "Enter" && !e.shiftKey');
  expect(editor).toContain('enterKeyHint={coarsePointer ? "enter" : "send"}');
});
