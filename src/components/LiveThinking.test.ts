// The live "Thinking" row. Same shape as the other component tests here: a
// node environment, markup through `renderToStaticMarkup`, and the open/fold
// rule as a pure function because a click cannot be rendered without a DOM.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LiveThinking, LiveThinkingText, THINKING_TAIL_CHARS, thinkingFoldAfter, thinkingTail } from "./LiveThinking";

const render = (text: string, answering: boolean, defaultOpen?: boolean) =>
  renderToStaticMarkup(createElement(LiveThinking, { text, answering, defaultOpen }));
const renderText = (text: string) => renderToStaticMarkup(createElement(LiveThinkingText, { text }));

describe("LiveThinking", () => {
  it("appears collapsed while the model is thinking", () => {
    const html = render("Weighing the two options", false);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">Thinking<");
    expect(html).not.toContain("Weighing the two options");
  });

  it("shows the reasoning once opened", () => {
    const html = render("Weighing the two options", false, true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-testid="live-thinking-text"');
    expect(html).toContain("Weighing the two options");
  });

  it("says Thought, collapsed, once the answer is streaming", () => {
    const html = render("Weighing the two options", true);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">Thought<");
    expect(html).not.toContain("Weighing the two options");
  });

  it("offers no copy control: thinking is not message text", () => {
    const html = render("private scratch work", false, true);
    expect(html).toContain("private scratch work");
    expect(html).not.toContain("Copy message");
    expect(html).not.toContain('data-testid="msg-bubble"');
  });
});

describe("thinkingFoldAfter", () => {
  it("opens and closes on a click", () => {
    const closed = { open: false, answering: false };
    const opened = thinkingFoldAfter(closed, { type: "toggle" });
    expect(opened).toEqual({ open: true, answering: false });
    expect(thinkingFoldAfter(opened, { type: "toggle" })).toEqual(closed);
  });

  it("folds an opened row when the answer starts, and lets it be opened again", () => {
    const folded = thinkingFoldAfter({ open: true, answering: false }, { type: "answering", value: true });
    expect(folded).toEqual({ open: false, answering: true });
    expect(thinkingFoldAfter(folded, { type: "toggle" })).toEqual({ open: true, answering: true });
  });

  it("does not fold again while the answer keeps streaming", () => {
    const reopened = { open: true, answering: true };
    expect(thinkingFoldAfter(reopened, { type: "answering", value: true })).toBe(reopened);
  });

  it("leaves the row as it was when answering stops without a fold to make", () => {
    expect(thinkingFoldAfter({ open: false, answering: true }, { type: "answering", value: false }))
      .toEqual({ open: false, answering: false });
  });
});

describe("LiveThinkingText", () => {
  it("keeps the streaming text out of the transcript's live announcements", () => {
    expect(renderText("step one")).toMatch(/aria-live="off"[^>]*data-testid="live-thinking-text"|data-testid="live-thinking-text"[^>]*aria-live="off"/);
  });

  it("mounts only the newest part of a long think", () => {
    const text = `${"old ".repeat(THINKING_TAIL_CHARS)}NEWEST`;
    const tail = thinkingTail(text);
    expect(tail.clipped).toBe(true);
    expect(tail.text.length).toBeLessThanOrEqual(THINKING_TAIL_CHARS);
    expect(tail.text.endsWith("NEWEST")).toBe(true);
    const html = renderText(text);
    expect(html).toContain("…");
    expect(html).toContain("NEWEST");
    expect(html.length).toBeLessThan(THINKING_TAIL_CHARS + 2_000);
  });

  it("leaves a short think whole", () => {
    expect(thinkingTail("short")).toEqual({ text: "short", clipped: false });
  });
});

describe("one Thinking at a time", () => {
  it("carries the elapsed time on the row while the model thinks, and drops it once it has moved on", () => {
    const thinking = renderToStaticMarkup(createElement(LiveThinking, { text: "x", answering: false, since: Date.now() - 4_000 }));
    expect(thinking).toContain(">Thinking<");
    expect(thinking).toContain("tabular-nums");
    const thought = renderToStaticMarkup(createElement(LiveThinking, { text: "x", answering: true, since: Date.now() - 4_000 }));
    expect(thought).toContain(">Thought<");
    expect(thought).not.toContain("tabular-nums");
  });

  it("lets the working line stand silent beside its mascot when the row is saying it", async () => {
    const { TurnPresence } = await import("./TurnPresence");
    const silent = renderToStaticMarkup(createElement(TurnPresence, { avatar: createElement("i", null, "m"), visible: true, label: "", since: Date.now() }));
    expect(silent).toContain("<i>m</i>");
    expect(silent).not.toContain("thinking-shimmer");
    expect(silent).not.toContain("tabular-nums");
    const spoken = renderToStaticMarkup(createElement(TurnPresence, { avatar: createElement("i", null, "m"), visible: true, label: "Answering", since: Date.now() }));
    expect(spoken).toContain(">Answering<");
    expect(spoken).toContain("tabular-nums");
  });
});
