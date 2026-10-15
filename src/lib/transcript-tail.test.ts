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

  it("replaces the spoken node for each new message, so a repeat of the same text is still a change (A1, BOTADDED-DESIGN)", () => {
    const render = (id: string, text: string) => renderToStaticMarkup(createElement(TranscriptTail, { scope: "t1", last: { id, text } }));
    // equal text, different messages: different markup, so the region mutates and is announced again
    expect(render("m1", "Done.")).not.toBe(render("m2", "Done."));
    expect(render("m2", "Done.")).toContain('data-tail="m2"');
    // the same message again: identical markup, nothing to announce
    expect(render("m2", "Done.")).toBe(render("m2", "Done."));
    // still one region
    expect(render("m2", "Done.").match(/role="status"/g)).toHaveLength(1);
  });

  it("keeps the transcript log itself out of the live region", () => {
    for (const file of ["ChatView.tsx", "GroupView.tsx"]) {
      const source = readFileSync(fileURLToPath(new URL(`../components/${file}`, import.meta.url)), "utf8");
      expect(source).toMatch(/role="log"\s+aria-live="off"/);
      expect(source).toContain("<TranscriptTail");
    }
  });

  it("sits beside the scrolling transcript, so the newest message is in the transcript once", () => {
    for (const file of ["ChatView.tsx", "GroupView.tsx"]) {
      const source = readFileSync(fileURLToPath(new URL(`../components/${file}`, import.meta.url)), "utf8");
      const tail = source.indexOf("<TranscriptTail");
      const scroll = source.indexOf('data-testid="chat-scroll"');
      expect(tail, file).toBeGreaterThan(-1);
      expect(scroll, file).toBeGreaterThan(-1);
      // Mounted before the scroll element opens, never inside it.
      expect(tail, file).toBeLessThan(scroll);
      expect(source.indexOf("<TranscriptTail", scroll), file).toBe(-1);
    }
  });
});
