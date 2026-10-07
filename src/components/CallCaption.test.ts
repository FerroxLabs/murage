import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CallCaption } from "./CallCaption";

const render = (over: Partial<Parameters<typeof CallCaption>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(CallCaption, { phase: "listening", heard: "", caption: undefined, pushToTalk: false, ...over }),
  );

describe("CallCaption", () => {
  it("shows the owner's words live while listening, with no You line yet", () => {
    const html = render({ phase: "listening", heard: "what's on today" });
    expect(html).toContain("what&#x27;s on today");
    expect(html).not.toContain("You:");
  });

  it("keeps the owner's last line on screen through One moment (sending)", () => {
    // This is the phone bug: the final transcript and the move to
    // "sending" (One moment) land in the same render, so a listening-only
    // line never painted it. The You line is the fix.
    const html = render({ phase: "sending", heard: "what's on today" });
    expect(html).toContain("You: what&#x27;s on today");
  });

  it("keeps it through the bot's reply (speaking), next to the caption", () => {
    const html = render({ phase: "speaking", heard: "what's on today", caption: "Nothing on your calendar." });
    expect(html).toContain("You: what&#x27;s on today");
    // read along word by word (ReadAlong.tsx): the sentence is there, split into word spans
    expect(html).toContain('data-read-along="current"');
    expect(html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ")).toContain("Nothing on your calendar.");
  });

  it("shows nothing extra once the next turn has cleared it", () => {
    // listen() clears `heard` at the start of the next turn (CallView.tsx).
    const html = render({ phase: "listening", heard: "" });
    expect(html).not.toContain("You:");
  });

  it("never shows a You line while actually listening, even with a stale echo of heard", () => {
    // The primary line already shows `heard` live while listening; a
    // second, muted copy of the same text would be a confusing double-up.
    const html = render({ phase: "listening", heard: "still talking" });
    expect(html).not.toContain("You:");
  });

  it("falls back to the mic hint when nothing has been heard yet", () => {
    const html = render({ phase: "listening", heard: "" });
    expect(html).toContain("Say something…");
  });

  it("offers the push-to-talk hint instead when that is how this call listens", () => {
    const html = render({ phase: "listening", heard: "", pushToTalk: true });
    expect(html).toContain("Release Control + Option to send…");
  });

  it("keeps one fixed height in every phase, so the avatar above it never moves between turns", () => {
    const slot = (html: string) => html.match(/<div[^>]*data-caption-slot[^>]*class="([^"]*)"/)?.[1] ?? html.match(/<div[^>]*class="([^"]*)"[^>]*data-caption-slot/)?.[1] ?? "";
    const listening = render({ phase: "listening", heard: "what's on today" });
    const speaking = render({ phase: "speaking", heard: "what's on today", caption: "Nothing on your calendar." });
    const sending = render({ phase: "sending", heard: "what's on today" });
    for (const html of [listening, speaking, sending]) {
      // the slot is as tall as the read-along's maximum, and the You line
      // above it always takes its row, empty or not
      expect(slot(html)).toContain("h-[9.5rem]");
      expect(slot(html)).not.toContain("min-h-");
      expect(html).toContain("data-caption-you");
    }
    // short text sits at the top of the slot (the inner box is only as tall as its text);
    // only past the slot's height does the inner box cap and keep the newest words
    expect(listening).toContain("max-h-full");
  });

  it("clips both caption slots and bottom-anchors the text, so long words never spill over the controls", () => {
    for (const html of [render({ phase: "listening", heard: "x ".repeat(300) }), render({ phase: "sending", caption: "y ".repeat(300) })]) {
      const slot = html.slice(html.indexOf("data-caption-slot"));
      expect(slot).toContain("overflow-hidden");
      expect(slot).toContain("justify-end");
    }
  });
});
