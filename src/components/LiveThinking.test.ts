// The live "Thinking" row. Same shape as the other component tests here: a
// node environment, markup through `renderToStaticMarkup`.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LiveThinking, THINKING_TAIL_CHARS, thinkingTail } from "./LiveThinking";

const render = (text: string, answering: boolean) => renderToStaticMarkup(createElement(LiveThinking, { text, answering }));

describe("LiveThinking", () => {
  it("shows the reasoning, open, while the model is only thinking", () => {
    const html = render("Weighing the two options", false);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(">Thinking<");
    expect(html).toContain('data-testid="live-thinking-text"');
    expect(html).toContain("Weighing the two options");
  });

  it("folds away once the answer starts arriving", () => {
    const html = render("Weighing the two options", true);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">Thought<");
    expect(html).not.toContain("Weighing the two options");
  });

  it("keeps the streaming text out of the transcript's live announcements", () => {
    expect(render("step one", false)).toMatch(/aria-live="off"[^>]*data-testid="live-thinking-text"|data-testid="live-thinking-text"[^>]*aria-live="off"/);
  });

  it("offers no copy control: thinking is not message text", () => {
    const html = render("private scratch work", false);
    expect(html).not.toContain("Copy message");
    expect(html).not.toContain('data-testid="msg-bubble"');
  });

  it("mounts only the newest part of a long think", () => {
    const text = `${"old ".repeat(THINKING_TAIL_CHARS)}NEWEST`;
    const tail = thinkingTail(text);
    expect(tail.clipped).toBe(true);
    expect(tail.text.length).toBeLessThanOrEqual(THINKING_TAIL_CHARS);
    expect(tail.text.endsWith("NEWEST")).toBe(true);
    const html = render(text, false);
    expect(html).toContain("…");
    expect(html).toContain("NEWEST");
    expect(html.length).toBeLessThan(THINKING_TAIL_CHARS + 2_000);
  });

  it("leaves a short think whole", () => {
    expect(thinkingTail("short")).toEqual({ text: "short", clipped: false });
  });
});
