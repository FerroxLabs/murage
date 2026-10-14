import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TranscriptTail } from "@/components/TranscriptTail";
import { nextTailAnnouncement } from "./transcript-tail";

describe("transcript announcements (P2-2)", () => {
  it("says nothing when a conversation opens or older rows mount", () => {
    const opened = nextTailAnnouncement(null, "t1", { id: "m9", text: "newest" });
    expect(opened.say).toBeNull();
    // scrolling up mounts rows above; the tail is the same message
    expect(nextTailAnnouncement(opened.state, "t1", { id: "m9", text: "newest" }).say).toBeNull();
    // another conversation is not news either
    expect(nextTailAnnouncement(opened.state, "t2", { id: "x1", text: "other" }).say).toBeNull();
  });

  it("announces a message that arrives at the tail", () => {
    const opened = nextTailAnnouncement(null, "t1", { id: "m9", text: "newest" });
    expect(nextTailAnnouncement(opened.state, "t1", { id: "m10", text: "  hello  " }).say).toBe("hello");
  });

  it("renders one polite status region", () => {
    const html = renderToStaticMarkup(createElement(TranscriptTail, { scope: "t1", last: { id: "m1", text: "hi" } }));
    expect(html).toContain('aria-live="polite"');
  });

  it("keeps the transcript log itself out of the live region", () => {
    for (const file of ["ChatView.tsx", "GroupView.tsx"]) {
      const source = readFileSync(fileURLToPath(new URL(`../components/${file}`, import.meta.url)), "utf8");
      expect(source).toMatch(/role="log"\s+aria-live="off"/);
      expect(source).toContain("<TranscriptTail");
    }
  });
});
