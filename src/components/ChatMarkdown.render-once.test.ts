// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// G27 (upstream 47b66e041, #4171): a finished message drawn again (a conversation switched back to, a row scrolled
// back into view) reuses its first rendering instead of parsing again. A streaming message is parsed each time, and
// anything the rendering reads (its conversation, its question cards, the language) makes a new one.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const parsed = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/markdown-soft-breaks", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/markdown-soft-breaks")>();
  return {
    ...real,
    remarkSoftBreaks(...args: Parameters<typeof real.remarkSoftBreaks>) {
      parsed.count += 1;
      return real.remarkSoftBreaks(...args);
    },
  };
});

import { ChatMarkdown, clearChatMarkdownCache } from "./ChatMarkdown";

type Props = Parameters<typeof ChatMarkdown>[0];
const draw = (props: Props) => renderToStaticMarkup(createElement(ChatMarkdown, props));
const parses = (run: () => void) => {
  parsed.count = 0;
  run();
  return parsed.count;
};

describe("ChatMarkdown draws a finished message from one rendering", () => {
  beforeEach(() => clearChatMarkdownCache());

  it("draws a finished message again from its first rendering, with the same output", () => {
    const text = "## Plan\n\n- one\n- two with `code`";
    let first = "";
    expect(parses(() => { first = draw({ text }); })).toBe(1);
    let again = "";
    expect(parses(() => { again = draw({ text }); draw({ text }); })).toBe(0);
    expect(again).toBe(first);
    expect(parses(() => draw({ text: `${text}\n- three` }))).toBe(1);
  });

  it("parses a streaming message every time and never keeps it", () => {
    const text = "Writing the **plan** now";
    expect(parses(() => { draw({ text, streaming: true }); draw({ text, streaming: true }); })).toBe(2);
    expect(parses(() => draw({ text }))).toBe(1);
  });

  it("renders again when its conversation or question cards change", () => {
    const text = "See [the file](notes/plan.md).\n\n```murage-question\n{}\n```";
    const scope = { botId: "b1", threadId: "t1" };
    expect(parses(() => draw({ text, scope }))).toBe(1);
    expect(parses(() => draw({ text, scope: { botId: "b1", threadId: "t1" } }))).toBe(0);
    expect(parses(() => draw({ text, scope: { botId: "b1", threadId: "t2" } }))).toBe(1);
    // the same conversation as the entry now kept (t2), so only the question cards differ
    expect(parses(() => draw({ text, scope: { botId: "b1", threadId: "t2" }, questionCards: "0" }))).toBe(1);
    expect(parses(() => draw({ text, scope: { botId: "b1", threadId: "t2" }, questionCards: "0" }))).toBe(0);
  });

  it("keeps math spans with their own text", () => {
    const a = draw({ text: "Area $$a^2$$ here" });
    const b = draw({ text: "Area $$b^2$$ here" });
    expect(a).not.toBe(b);
    expect(draw({ text: "Area $$a^2$$ here" })).toBe(a);
  });
});
