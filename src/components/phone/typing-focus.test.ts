// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The phone tabs step aside for the keyboard (Android shrinks the WebView, so
// a fixed bar would ride up over it), and the Door bundle keeps
// viewport-fit=cover so iOS gives real safe-area insets to the bar.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { isTypingTarget, watchTyping } from "./typing-focus";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("phone tabs and the keyboard", () => {
  it("counts text boxes as typing, and buttons, checkboxes and read-only boxes as not", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTypingTarget({ tagName: "INPUT", type: "text", readOnly: true })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("reports typing on focus in, and not typing once focus leaves the box", () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const doc = Object.assign(target, { activeElement: null as unknown });
    const seen: boolean[] = [];
    const stop = watchTyping(doc as never, (typing) => seen.push(typing));
    doc.activeElement = { tagName: "TEXTAREA" };
    doc.dispatchEvent(new Event("focusin"));
    doc.activeElement = { tagName: "BODY" };
    doc.dispatchEvent(new Event("focusout"));
    vi.runAllTimers();
    expect(seen).toEqual([false, true, false]);
    stop();
    doc.dispatchEvent(new Event("focusin"));
    expect(seen).toHaveLength(3);
    vi.useRealTimers();
  });

  it("hides the tab bar while typing", () => {
    const source = read("./PhoneTabs.tsx");
    expect(source).toContain('import { useTypingFocus } from "./typing-focus";');
    expect(source).toMatch(/const typing = useTypingFocus\(\);\s*if \(typing\) return null;/);
  });

  it("keeps viewport-fit=cover in the Door bundle's viewport meta", () => {
    const meta = read("../../../index.html").match(/<meta name="viewport" content="([^"]*)"/);
    expect(meta?.[1]).toContain("viewport-fit=cover");
  });
});
